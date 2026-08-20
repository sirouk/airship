import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import { sha256 } from "../core/hash";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { searchFederatedMemory } from "../tools/federated-memory";
import { MEMORY_PATH, registerMemoryTools } from "../tools/memory-tools";
import { allowAllForTests, ToolRegistry } from "../tools/registry";
import { MemoryWorkspace } from "../workspace/memory";
import { ClientContextRuntime } from "./client-context-runtime";
import { FederatedTurnContextProvider } from "./federated-turn-context";
import { rankProfileMemories } from "./memory-ranking";

const RECORDS = [
  memory("m-1", "The turbine pressure limit is 42 bar.", "turn:pressure-review", 1),
  memory("m-2", "Prefer metric units in every generated report.", "turn:units", 2),
  memory("m-3", "The deployment key rotates every 90 days.", "turn:ops", 3),
];

const LONG_QUESTION = "Before I write up the maintenance plan for next quarter, can you remind me what we agreed on for the turbine, because I want the numbers in the document to be right and I do not want to guess at it?";
/**
 * Deliberately matches TWO records with different evidence, so the cross-path
 * comparison below is a real ordering assertion. A query that returns a single
 * record makes `toEqual` a one-element comparison that no reordering can fail.
 */
const TWO_RECORD_QUESTION = "Remind me of the turbine pressure limit in bar before I file the maintenance plan, and whether the deployment schedule changed.";

describe("profile memory ranking", () => {
  it("recalls a distinctive term from a long question, not just from a one-word query", () => {
    const short = rankProfileMemories(RECORDS, "turbine");
    expect(short[0]?.record.id).toBe("m-1");

    // The old ranker divided overlap by the number of query tokens, so this
    // multi-sentence question scored 0.75 * (1/33) and recalled nothing.
    const long = rankProfileMemories(RECORDS, LONG_QUESTION);
    expect(long.map((candidate) => candidate.record.id)).toContain("m-1");
  });

  it("returns nothing for a long question that shares no discriminating term", () => {
    const unrelated = rankProfileMemories(
      RECORDS,
      "I am planning a holiday next month and wondered whether you had any thoughts about coastal walking routes, ideally somewhere quiet with reasonable weather in early spring.",
    );
    expect(unrelated).toEqual([]);
  });

  it("never lets the recency prior alone reach past the gate", () => {
    // The newest record carries the maximum recency prior, which lands it exactly
    // ON the default gate (0.25 * 1.0) rather than below it; it is excluded only
    // because the gate is exclusive. Asserting the exact value, not `<= 0.25`,
    // is what would catch a recency weight raised above the gate.
    const scored = rankProfileMemories(RECORDS, "zzzz", { minimumScore: -1 });
    expect(scored.map((candidate) => candidate.record.id)).toEqual(["m-3", "m-2", "m-1"]);
    expect(scored[0]!.score).toBeCloseTo(0.25, 12);
    expect(scored[1]!.score).toBeCloseTo(0.25 * (2 / 3), 12);
    expect(rankProfileMemories(RECORDS, "zzzz")).toEqual([]);
  });

  it("prefers the record whose distinctive term is rarer in the corpus", () => {
    const corpus = [
      memory("common-1", "The report format is markdown.", "turn:a"),
      memory("common-2", "The report cadence is weekly.", "turn:b"),
      memory("rare", "The report signing key lives in the vault.", "turn:c"),
    ];
    expect(rankProfileMemories(corpus, "signing key report")[0]?.record.id).toBe("rare");
  });

  it("bounds the corpus, the query and each document", () => {
    const oversized = Array.from({ length: 600 }, (_, index) =>
      memory(`bulk-${index}`, `bulk turbine record ${index}`, "turn:bulk"));
    const ranked = rankProfileMemories(oversized, "turbine", { limit: 5 });
    expect(ranked.length).toBeLessThanOrEqual(5);
    expect(ranked.every((candidate) => candidate.index < 512)).toBe(true);
  });
});

describe("one ranker across every memory path", () => {
  it("returns the same ordered records from turn injection, search_memory and recall_memory", async () => {
    const fixture = await harness();
    const selection = await fixture.provider.selectForTurn(TWO_RECORD_QUESTION, {
      sessionId: fixture.sessionId,
      maxHits: 8,
      maxBytes: 8_192,
    });
    const injected = selection.hits
      .filter((hit) => hit.corpus === "profile-memory")
      .map((hit) => hit.sourceId);
    // Pinned, not derived: the ordering is the thing under test, so a shared
    // reordering across all three paths must fail here rather than agree.
    expect(injected).toEqual(["m-1", "m-3"]);

    const federated = await searchFederatedMemory({
      query: TWO_RECORD_QUESTION,
      limit: 3,
      context: fixture.context,
      workspace: fixture.workspace,
      journal: fixture.journal,
      runtime: fixture.runtime,
    });
    const searched = federated.groups[1].hits.map((hit) => hit.id);

    const recalled = JSON.parse((await fixture.recall({ query: TWO_RECORD_QUESTION, limit: 3 })).content)
      .map((record: { id: string }) => record.id);

    expect(searched).toEqual(injected);
    expect(recalled).toEqual(injected);
    // m-1 is the OLDEST record and still ranks first, so no path can be
    // producing this order by browsing reverse-chronologically.
    expect(injected[0]).toBe("m-1");
  });

  it("still browses the newest records reverse-chronologically without a query", async () => {
    const fixture = await harness();
    const recalled = JSON.parse((await fixture.recall({})).content)
      .map((record: { id: string }) => record.id);
    expect(recalled).toEqual(["m-3", "m-2", "m-1"]);
  });
});

function memory(id: string, content: string, source: string, day = 1) {
  return Object.freeze({
    id,
    content,
    source,
    createdAt: `2026-07-2${day}T00:00:00.000Z`,
  });
}

async function harness() {
  const workspace = new MemoryWorkspace();
  await workspace.write("docs/turbine.md", "Unrelated workspace note about governors.");
  const journal = new EventJournal(new MemoryJournalBackend());
  const digest = await sha256("engineer-profile");
  const manifest = await createSessionManifest({
    systemPrompt: "Recall carefully.", providerId: "test", model: "test", tools: [],
    workspaceId: "memory://memory-ranking",
    profile: {
      version: 2, profileId: "engineer", profileRevision: digest, themeId: "plain", themeDigest: digest,
      resolvedSkills: [], skillSetDigest: digest, resolutionDigest: digest,
      workspaceBinding: { kind: "active-workspace" }, memoryScope: "profile",
      approvalMode: "ask-first",
    },
  });
  const session = await journal.createSession("Engineer", manifest);
  await workspace.write(MEMORY_PATH, `${JSON.stringify({
    version: 2,
    records: RECORDS.map((record) => ({
      ...record,
      scope: {
        kind: "profile", profileId: "engineer", profileRevision: digest, createdInSessionId: session.id,
      },
    })),
  })}\n`);
  const runtime = new ClientContextRuntime(workspace, { dimensions: 64 });
  const registry = new ToolRegistry();
  registerMemoryTools(registry, workspace, journal);
  const context = {
    sessionId: session.id,
    turnId: "turn",
    operationId: "operation-recall",
    signal: new AbortController().signal,
  };
  return {
    workspace,
    journal,
    runtime,
    context,
    sessionId: session.id,
    provider: new FederatedTurnContextProvider(runtime, workspace, journal),
    recall: async (args: Record<string, unknown>) => {
      const callContext = { ...context, operationId: `recall-${JSON.stringify(args)}` };
      expect(await registry.review("recall_memory", args as never, callContext, allowAllForTests)).toBe("allow");
      return registry.executeApproved("recall_memory", args as never, callContext);
    },
  };
}
