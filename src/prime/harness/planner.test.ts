import { describe, expect, it } from "vitest";
import {
  MAX_AUTO_REFINE_REVIEW_OUTPUT_TOKENS,
  MAX_REFINEMENT_OUTPUT_TOKENS,
  overviewForPrompt,
  parseHarnessProposal,
  planRefinement,
  reviewAutoRefine,
  type HarnessCompletionClient,
  type HarnessCompletionRequest,
} from "./planner";
import {
  AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
  REFINEMENT_SCOPE_INSTRUCTION_GLOBAL,
  REFINEMENT_SCOPE_INSTRUCTION_LOCAL,
  REFINEMENT_SYSTEM_PROMPT,
  TRUNCATED_JSON_ERROR,
} from "./prompt";
import type { HarnessEntry } from "./types";

/** Records requests and serves scripted replies; mirrors upstream's completeSimple stubbing. */
class StubClient implements HarnessCompletionClient {
  readonly requests: HarnessCompletionRequest[] = [];

  constructor(private readonly replies: Array<Partial<{ stopReason: "stop" | "length" | "error"; text: string; errorMessage: string }>>) {}

  complete(request: HarnessCompletionRequest): Promise<Awaited<ReturnType<HarnessCompletionClient["complete"]>>> {
    this.requests.push(request);
    const reply = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)];
    return Promise.resolve({
      stopReason: reply.stopReason ?? "stop",
      text: reply.text ?? "{}",
      errorMessage: reply.errorMessage,
    });
  }
}

const skillEntry: HarnessEntry = {
  id: "web_lookup",
  kind: "skill",
  title: "Web lookup",
  content: "Search the web for current facts.",
  path: "tools",
  scope: "local",
  reference: { type: "python", import: "websearch", callable: "run" },
  arguments: { query: { type: "string", required: true } },
  source: "agent",
  createdAt: 1,
  updatedAt: 1,
  version: 1,
};

describe("parseHarnessProposal acceptance ladder", () => {
  it("parses a bare JSON object and defaults missing summary fields (upstream parity)", () => {
    const proposal = parseHarnessProposal('{"edits": []}');
    expect(proposal.summary).toBe("Refined continual harness state");
    expect(proposal.rationale).toBe("");
    expect(proposal.edits).toEqual([]);
  });

  it("parses fenced JSON and JSON wrapped in prose", () => {
    const fenced = parseHarnessProposal('sure!\n```json\n{"summary": "fenced", "edits": []}\n```');
    expect(fenced.summary).toBe("fenced");
    const prose = parseHarnessProposal('prefix {"summary": "prose", "edits": []} suffix');
    expect(prose.summary).toBe("prose");
  });

  it("filters non-object edits instead of rejecting the whole reply", () => {
    const proposal = parseHarnessProposal('{"edits": [null, 42, {"action": "delete", "kind": "memory", "id": "x"}]}');
    expect(proposal.edits).toEqual([{ action: "delete", kind: "memory", id: "x" }]);
  });

  it("diagnoses budget truncation distinctly from malformed JSON", () => {
    expect(() => parseHarnessProposal('{"summary": "ran out mid-str')).toThrow(TRUNCATED_JSON_ERROR);
    expect(() => parseHarnessProposal('{"summary": 12, }')).toThrow(/did not return valid JSON/);
    expect(() => parseHarnessProposal('"just a string"')).toThrow(/must be an object|did not return a JSON object/);
  });
});

describe("planRefinement", () => {
  const proposalJson = JSON.stringify({
    summary: "record the failing command",
    rationale: "twice observed",
    expectedOutcome: "no third failure",
    edits: [{ action: "create", kind: "memory", title: "failing cmd", content: "npx tsc needs --project build" }],
  });

  it("sends the verbatim system prompt and tagged user prompt, and returns proposal + baseline", async () => {
    const client = new StubClient([{ text: proposalJson }]);
    const plan = await planRefinement({
      scope: "local",
      trajectorySlice: "user asked for a build; tsc failed twice",
      entries: [skillEntry],
      refinements: [],
      instructions: "only memories please",
      client,
      modelMaxOutputTokens: 128_000,
      now: 1_700_000_000_000,
    });
    expect(plan.proposal.summary).toBe("record the failing command");
    expect(plan.proposal.edits[0]).toMatchObject({ action: "create", kind: "memory" });
    expect(plan.baseline).toEqual([skillEntry]);
    expect(plan.id.startsWith("refine_")).toBe(true);

    expect(client.requests).toHaveLength(1);
    const request = client.requests[0];
    expect(request?.systemPrompt).toBe(REFINEMENT_SYSTEM_PROMPT);
    expect(request?.maxOutputTokens).toBe(MAX_REFINEMENT_OUTPUT_TOKENS); // min(model, ceiling)
    const user = request?.userPrompt ?? "";
    for (const tag of [
      "<current_harness_state>",
      "<refinement_history>",
      "<conversation>",
      "<scope_policy>",
      "<user_refine_instructions>",
    ]) {
      expect(user).toContain(tag);
    }
    expect(user).toContain(REFINEMENT_SCOPE_INSTRUCTION_LOCAL);
    expect(user).toContain("only memories please");
    expect(user).toContain("[local:web_lookup] Web lookup (tools, v1)");
    expect(user).toContain("No prior refinement history.");
  });

  it("emits the global scope paragraph for global refinement", async () => {
    const client = new StubClient([{ text: proposalJson }]);
    await planRefinement({
      scope: "global",
      trajectorySlice: "t",
      entries: [],
      refinements: [],
      client,
      modelMaxOutputTokens: 1000,
    });
    expect(client.requests[0]?.userPrompt).toContain(REFINEMENT_SCOPE_INSTRUCTION_GLOBAL);
    expect(client.requests[0]?.maxOutputTokens).toBe(1000); // small model: model budget wins
  });

  it("slices the trajectory to the upstream 80k cap", async () => {
    const client = new StubClient([{ text: proposalJson }]);
    const longTrajectory = "x".repeat(100_000) + "TAIL";
    await planRefinement({
      scope: "local",
      trajectorySlice: longTrajectory,
      entries: [],
      refinements: [],
      client,
      modelMaxOutputTokens: 128_000,
    });
    const user = client.requests[0]?.userPrompt ?? "";
    expect(user).toContain("TAIL");
    expect(user.length).toBeLessThan(100_000);
  });

  it("fails closed with named errors on error and length stop reasons", async () => {
    const errored = new StubClient([{ stopReason: "error", errorMessage: "provider down" }]);
    await expect(
      planRefinement({ scope: "local", trajectorySlice: "t", entries: [], refinements: [], client: errored, modelMaxOutputTokens: 1 }),
    ).rejects.toThrow("Refinement failed: provider down");
    const truncated = new StubClient([{ stopReason: "length", text: "" }]);
    await expect(
      planRefinement({ scope: "local", trajectorySlice: "t", entries: [], refinements: [], client: truncated, modelMaxOutputTokens: 1 }),
    ).rejects.toThrow(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
  });
});

describe("reviewAutoRefine gate", () => {
  it("returns shouldRefine=false for one-off noise (the skip path), worded by the gate rationale", async () => {
    const client = new StubClient([{ text: '{"shouldRefine": false, "rationale": "transient tool output"}' }]);
    const review = await reviewAutoRefine({
      trajectorySlice: "tool printed a huge log",
      entries: [skillEntry],
      refinements: [],
      context: { reason: "turn_interval", turnsSinceLastReview: 25 },
      client,
      modelMaxOutputTokens: 128_000,
    });
    expect(review.shouldRefine).toBe(false);
    expect(review.rationale).toBe("transient tool output");
    expect(review.instructions).toBeUndefined();

    const request = client.requests[0];
    expect(request?.systemPrompt).toBe(AUTO_REFINE_REVIEW_SYSTEM_PROMPT);
    expect(request?.maxOutputTokens).toBe(MAX_AUTO_REFINE_REVIEW_OUTPUT_TOKENS);
    expect(request?.userPrompt).toContain("turn_interval; 25 assistant turns since last auto-refine review");
  });

  it("passes instructions through on approve and treats a string true as STRICTLY false", async () => {
    const approve = new StubClient([{ text: '{"shouldRefine": true, "rationale": "durable", "instructions": "memorize the fix"}' }]);
    const approvedReview = await reviewAutoRefine({
      trajectorySlice: "t",
      entries: [],
      refinements: [],
      context: { reason: "compact", turnsSinceLastReview: 3 },
      client: approve,
      modelMaxOutputTokens: 128_000,
    });
    expect(approvedReview).toMatchObject({ shouldRefine: true, instructions: "memorize the fix" });

    const stringTrue = new StubClient([{ text: '{"shouldRefine": "true"}' }]);
    const strict = await reviewAutoRefine({
      trajectorySlice: "t",
      entries: [],
      refinements: [],
      context: { reason: "compact", turnsSinceLastReview: 3 },
      client: stringTrue,
      modelMaxOutputTokens: 128_000,
    });
    expect(strict.shouldRefine).toBe(false);
    expect(strict.rationale).toBe("No rationale provided.");
  });

  it("fails closed on gate errors and truncation", async () => {
    const errored = new StubClient([{ stopReason: "error", errorMessage: "boom" }]);
    await expect(
      reviewAutoRefine({
        trajectorySlice: "t",
        entries: [],
        refinements: [],
        context: { reason: "compact", turnsSinceLastReview: 1 },
        client: errored,
        modelMaxOutputTokens: 1,
      }),
    ).rejects.toThrow("Auto-refine review failed: boom");
  });
});

describe("overviewForPrompt", () => {
  it("renders skill refs/args and caps at 40 per kind with upstream wording", () => {
    const text = overviewForPrompt([skillEntry]);
    expect(text).toContain("skill: 1");
    // Canonical stored order (type, import, callable) is what the projection prints.
    expect(text).toContain('ref={"type":"python","import":"websearch","callable":"run"}');
    expect(text).toContain('args={"query":{"type":"string","required":true}}');
    const many: HarnessEntry[] = Array.from({ length: 45 }, (_, i) => ({
      id: `m${i}`,
      kind: "memory",
      title: `m${i}`,
      content: "c",
      scope: "local",
      source: "agent",
      createdAt: 1,
      updatedAt: 1,
      version: 1,
    }));
    expect(overviewForPrompt(many)).toContain("- +5 more memory entries");
  });
});
