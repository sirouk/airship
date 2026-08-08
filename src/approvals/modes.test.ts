import { describe, expect, it, vi } from "vitest";
import type { JsonValue, ToolContext, ToolDefinition } from "../core/contracts";
import { ApprovalBroker } from "./broker";
import { approvalProvenance, createApprovalModePolicy, type SafetyReviewResult } from "./modes";

const writeTool: ToolDefinition = {
  name: "write_file",
  description: "Write a bounded workspace file.",
  effect: "write",
  inputSchema: { type: "object" },
};

function context(operationId = "operation"): ToolContext {
  return {
    sessionId: "session",
    turnId: "turn",
    operationId,
    signal: new AbortController().signal,
  };
}

describe("approval modes", () => {
  it("Ask First automatically permits reads and prompts for every stronger effect", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "ask-first", broker });
    const readContext = context("read");
    await expect(policy.review({ ...writeTool, effect: "read" }, {}, readContext)).resolves.toBe("allow");
    expect(approvalProvenance(policy, readContext)).toMatchObject({ mode: "ask-first", source: "automatic-read" });

    const writeContext = context("write");
    const decision = policy.review(writeTool, { path: "notes/a.md" }, writeContext);
    await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));
    broker.decide(broker.snapshot().pending[0]!.id, "allow");
    await expect(decision).resolves.toBe("allow");
    expect(approvalProvenance(policy, writeContext)).toMatchObject({ source: "human" });
  });

  it("Full Access permits every existing effect without consulting the broker", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "full-access", broker });
    for (const effect of ["write", "network", "execute", "identity"] as const) {
      const toolContext = context(effect);
      await expect(policy.review({ ...writeTool, effect }, {}, toolContext)).resolves.toBe("allow");
      expect(approvalProvenance(policy, toolContext)).toMatchObject({
        mode: "full-access",
        source: "bounded-browser-sandbox",
      });
    }
    expect(broker.snapshot().pending).toHaveLength(0);
  });

  it("Full Access records the confinement each effect actually had, not one borrowed sentence", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({ mode: "full-access", broker });
    const reasonFor = async (effect: ToolDefinition["effect"]): Promise<string> => {
      const toolContext = context(`full-${effect}`);
      await policy.review({ ...writeTool, effect }, {}, toolContext);
      return approvalProvenance(policy, toolContext)?.reason ?? "";
    };

    const write = await reasonFor("write");
    const network = await reasonFor("network");

    // The journaled reason is the durable record of why an effect ran without a
    // prompt. A network allow is confined to HTTPS and to the origin's CORS
    // policy; nothing path-confines it, so it must not say so.
    expect(network).not.toBe(write);
    expect(network).not.toContain("path boundaries");
    expect(network).toContain("not path-confined");
    expect(network).toContain("remote origin");
    expect(write).toContain("path confinement");
  });

  it("Auto Approve allows only a structured safe verdict and denies an unsafe verdict", async () => {
    const broker = new ApprovalBroker();
    const safetyReview = vi.fn(async (_tool: ToolDefinition, _args: JsonValue): Promise<SafetyReviewResult> => ({
      verdict: "safe" as const,
      reason: "The write stays inside the revision-bound workspace.",
      requestId: "review-safe",
      model: "review-model",
    }));
    const policy = createApprovalModePolicy({ mode: "auto-approve", broker, safetyReview });
    const safeContext = context("safe");
    await expect(policy.review(writeTool, { path: "notes/a.md" }, safeContext)).resolves.toBe("allow");
    expect(approvalProvenance(policy, safeContext)).toEqual({
      mode: "auto-approve",
      source: "model-review",
      reason: "The write stays inside the revision-bound workspace.",
      reviewRequestId: "review-safe",
      reviewModel: "review-model",
    });

    safetyReview.mockResolvedValueOnce({ verdict: "unsafe", reason: "Unexpected destructive scope" });
    const unsafeContext = context("unsafe");
    await expect(policy.review(writeTool, {}, unsafeContext)).resolves.toBe("deny");
    expect(broker.snapshot().pending).toHaveLength(0);
    expect(approvalProvenance(policy, unsafeContext)).toMatchObject({ source: "model-review" });
  });

  it("Auto Approve fails closed to a human prompt when review is unavailable or malformed", async () => {
    const broker = new ApprovalBroker();
    const policy = createApprovalModePolicy({
      mode: "auto-approve",
      broker,
      safetyReview: async () => ({ verdict: "indeterminate", reason: "Malformed structured output." }),
    });
    const toolContext = context();
    const decision = policy.review(writeTool, {}, toolContext);
    await vi.waitFor(() => expect(broker.snapshot().pending).toHaveLength(1));
    broker.decide(broker.snapshot().pending[0]!.id, "deny");
    await expect(decision).resolves.toBe("deny");
    expect(approvalProvenance(policy, toolContext)).toMatchObject({
      mode: "auto-approve",
      source: "human-fallback",
    });
    expect(approvalProvenance(policy, toolContext)).toBeUndefined();
  });

  /*
   * The gate and the record answer different questions. An unanswered request
   * must not run, so it resolves `deny` — but the journal is the evidence
   * chain, and a person who walked away from the screen refused nothing. The
   * broker has kept that distinction all along in `takeOutcome`; until now
   * nothing read it, so every expiry was written down as "Denied or expired"
   * and left its reader to guess.
   */
  it("records an unanswered Ask First request as an expiry, not as a refusal", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ApprovalBroker({ decisionTimeoutMs: 10 });
      const policy = createApprovalModePolicy({ mode: "ask-first", broker });
      const writeContext = context("expired");
      const decision = policy.review(writeTool, {}, writeContext);
      await vi.advanceTimersByTimeAsync(11);
      // The gate still fails closed; only the record tells the two apart.
      await expect(decision).resolves.toBe("deny");
      const reason = approvalProvenance(policy, writeContext)?.reason ?? "";
      expect(reason).not.toMatch(/denied/iu);
      expect(reason).toMatch(/expired/iu);
    } finally {
      vi.useRealTimers();
    }
  });
});
