import { describe, expect, it } from "vitest";
import { createSessionManifest, materializeMessages, runTurn } from "./agent";
import type {
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  JsonValue,
  Tool,
} from "./contracts";
import {
  calibrateBytesPerToken,
  canonicalContextSummary,
  createSessionContextPolicy,
  materializeContextSummary,
  planContextCompression,
  summaryBodiesWithinPolicy,
  summaryProjectionBudgetBytes,
  verifyContextSummary,
  type CanonicalContextSummary,
  type ContextSummarizer,
} from "./context-compressor";
import { INFERENCE_CONTEXT_SUMMARIZER_ID } from "./context-policy";
import { sha256, stableStringify } from "./hash";
import { EventJournal, type DurableEvent } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";
import { allowAllForTests, ToolRegistry } from "../tools/registry";

const OPTIONS = {
  contextWindowTokens: 2_048,
  threshold: 0.8,
  preserveRecentTurns: 1,
  maxSummaryDeltaBytes: 12 * 1024,
} as const;

describe("hierarchical summary compaction", () => {
  it("re-compacts the oldest deltas instead of dropping them once the projection fills", async () => {
    const session = await compactedSessionFixture(7);
    const events = session.events;
    const compacting = events
      .map((event) => canonicalContextSummary(event.payload))
      .filter((summary) => summary?.compaction);
    expect(compacting.length).toBeGreaterThan(0);

    const projection = materializeContextSummary(events);
    expect(projection).toBeDefined();
    expect(projection!.chainLength).toBeGreaterThan(4);
    expect(projection!.compactionLevel).toBe(1);
    expect(projection!.bytes).toBeLessThanOrEqual(summaryProjectionBudgetBytes(OPTIONS.contextWindowTokens));
    // The whole point: nothing is silently dropped any more.
    expect(projection!.omittedDeltaCount).toBe(0);
    expect(projection!.message.content).toContain("Compacted tier 1 summary sha256:");
    expect(projection!.message.content).toContain("ROUND0-MARKER");

    // Control: the identical chain without its compacted tier drops the oldest
    // deltas, which is exactly the behaviour this tier exists to remove.
    const withoutTier = events.map((event) => event.type === "context.summary.updated"
      ? { ...event, payload: stripCompaction(event.payload) }
      : event);
    const degraded = materializeContextSummary(withoutTier);
    expect(degraded!.omittedDeltaCount).toBeGreaterThan(0);
    expect(degraded!.message.content).toContain("omitted from the active projection");
    expect(degraded!.message.content).not.toContain("ROUND0-MARKER");
  });

  it("folds an earlier tier into a higher one rather than leaving it behind", async () => {
    // Eight rounds, not seven: the level-2 tier only exists once the chain has
    // refilled the projection budget AFTER the level-1 tier was committed, and a
    // seven-round session stops one round short. Asserting the observed level
    // SEQUENCE is the point — `toBeGreaterThanOrEqual(1)` passes forever without
    // the recursive path ever running once.
    const session = await compactedSessionFixture(8);
    const committed = committedCompactions(session.events);
    expect(committed.map((entry) => entry.compaction.level)).toEqual([1, 2]);

    const first = committed[0]!.compaction;
    const second = committed[1]!.compaction;
    // The higher tier absorbs the commitment that carried the lower tier, so no
    // earlier tier is left outside the run it claims to replace.
    expect(second.subsumedSummaryDigests).toContain(committed[0]!.summary.summaryDigest);
    expect(second.subsumedSummaryDigests.length).toBeGreaterThan(first.subsumedSummaryDigests.length);
    expect(second.coveredStartSequence).toBe(first.coveredStartSequence);
    expect(second.coveredEndSequence).toBeGreaterThan(first.coveredEndSequence);
    // Its input was the previous tier's BODY plus the deltas added since, never a
    // re-read of the whole history: the level-1 marker is quoted inside it.
    expect(second.body).toContain("MERGED L2:");
    expect(second.body).toContain("MERGED L1:");
    expect(second.body).toContain("ROUND0-MARKER");

    const projection = materializeContextSummary(session.events)!;
    expect(projection.compactionLevel).toBe(2);
    expect(projection.omittedDeltaCount).toBe(0);
    expect(projection.message.content).toContain("Compacted tier 2 summary sha256:");
    expect(projection.message.content).toContain("ROUND0-MARKER");
    expect(projection.bytes).toBeLessThanOrEqual(summaryProjectionBudgetBytes(OPTIONS.contextWindowTokens));

    // Replay accepts the recursion, and only at exactly one level above the
    // highest tier the run contains.
    const events = session.events.slice(0, committed[1]!.index + 1);
    expect(await verifyContextSummary(committed[1]!.summary, events)).toBe(true);
    for (const level of [1, 3]) {
      const relabelled = await reseal({
        ...committed[1]!.summary,
        compaction: { ...second, level },
      });
      expect(await verifyContextSummary(relabelled, events)).toBe(false);
    }
  });

  it("verifies a compacted tier against the exact contiguous run it claims", async () => {
    const session = await compactedSessionFixture(6);
    const index = session.events.findIndex((event) => canonicalContextSummary(event.payload)?.compaction);
    expect(index).toBeGreaterThan(-1);
    const summary = canonicalContextSummary(session.events[index]!.payload)!;
    expect(await verifyContextSummary(summary, session.events.slice(0, index + 1))).toBe(true);

    // A run that skips the oldest summary no longer describes what it replaces.
    const shifted = canonicalContextSummary({
      ...summary,
      compaction: {
        ...summary.compaction!,
        subsumedSummaryDigests: summary.compaction!.subsumedSummaryDigests.slice(1),
      },
    });
    expect(shifted).toBeDefined();
    expect(await verifyContextSummary(shifted!, session.events.slice(0, index + 1))).toBe(false);

    // A tier body that does not match its digest is never trusted. This edit
    // also breaks the whole-commitment digest, so it proves the outer check
    // rather than the dedicated body check; the next test isolates that one.
    const forged = canonicalContextSummary({
      ...summary,
      compaction: { ...summary.compaction!, body: `${summary.compaction!.body} forged` },
    });
    expect(await verifyContextSummary(forged!, session.events.slice(0, index + 1))).toBe(false);
  });

  it("rejects a tier body that no longer matches its bodyDigest even after the commitment is resealed", async () => {
    const session = await compactedSessionFixture(6);
    const committed = committedCompactions(session.events);
    const entry = committed[0]!;
    const events = session.events.slice(0, entry.index + 1);
    // Control: resealing on its own must still verify. Without this the negative
    // below could be passing because `reseal` produces something malformed.
    expect(await verifyContextSummary(await reseal({ ...entry.summary }), events)).toBe(true);

    // bodyDigest and its provenance are left untouched, so the record still
    // canonicalizes and the resealed whole-commitment digest still matches:
    // the dedicated sha256(body) === bodyDigest check is the only thing left
    // that can reject this.
    const forged = await reseal({
      ...entry.summary,
      compaction: { ...entry.compaction, body: `${entry.compaction.body} forged` },
    });
    expect(forged.compaction!.bodyDigest).toBe(entry.compaction.bodyDigest);
    expect(await sha256(forged.compaction!.body)).not.toBe(forged.compaction!.bodyDigest);
    expect(await verifyContextSummary(forged, events)).toBe(false);
  });

  it("binds the tier's method to provenance committing to that exact body", async () => {
    const session = await compactedSessionFixture(6);
    const entry = committedCompactions(session.events)[0]!;
    const tier = entry.compaction;
    expect(tier.method).toBe("summarizer-port-v1");
    expect(tier.provenance?.responseDigest).toBe(tier.bodyDigest);
    expect(tier.provenance?.adapterId).toBe(INFERENCE_CONTEXT_SUMMARIZER_ID);

    // Keeping the label and dropping the evidence is exactly what made `method`
    // a bare self-assertion sitting next to verified facts.
    expect(canonicalContextSummary({
      ...entry.summary,
      compaction: { ...tier, provenance: undefined },
    })).toBeUndefined();
    // Keeping the evidence and flipping the label is equally unacceptable.
    expect(canonicalContextSummary({
      ...entry.summary,
      compaction: { ...tier, method: "extractive-fallback-v1" },
    })).toBeUndefined();
    // Provenance that commits to some other body is not evidence for this one.
    expect(canonicalContextSummary({
      ...entry.summary,
      compaction: {
        ...tier,
        provenance: { ...tier.provenance!, responseDigest: await sha256("a different body") },
      },
    })).toBeUndefined();
  });

  it("exposes the pinned delta budget as a bound on the tier body, not just the delta", async () => {
    const session = await compactedSessionFixture(6);
    const entry = committedCompactions(session.events)[0]!;
    const events = session.events.slice(0, entry.index + 1);
    expect(summaryBodiesWithinPolicy(entry.summary, OPTIONS.maxSummaryDeltaBytes)).toBe(true);

    // A tier body more than three times the pinned budget still canonicalizes
    // and still verifies against the journal, because the only structural limit
    // on it is the 64 KiB hard cap. The pinned bound is a policy fact, so it has
    // to be applied explicitly wherever the manifest is in hand.
    const body = `oversized tier ${"x".repeat(40 * 1024)}`;
    const { provenance, ...tier } = entry.compaction;
    void provenance;
    const inflated = await reseal({
      ...entry.summary,
      compaction: { ...tier, method: "extractive-fallback-v1", body, bodyDigest: await sha256(body) },
    });
    expect(await verifyContextSummary(inflated, events)).toBe(true);
    expect(summaryBodiesWithinPolicy(inflated, OPTIONS.maxSummaryDeltaBytes)).toBe(false);
    expect(summaryBodiesWithinPolicy(inflated, 64 * 1024)).toBe(true);
  });

  it("rejects a tier that claims material newer than its own delta", async () => {
    const session = await compactedSessionFixture(6);
    const summary = session.events
      .map((event) => canonicalContextSummary(event.payload))
      .find((candidate) => candidate?.compaction)!;
    expect(canonicalContextSummary({
      ...summary,
      compaction: { ...summary.compaction!, coveredEndSequence: summary.sourceStartSequence },
    })).toBeUndefined();
    expect(canonicalContextSummary({
      ...summary,
      compaction: { ...summary.compaction!, level: 0 },
    })).toBeUndefined();
    expect(canonicalContextSummary({
      ...summary,
      compaction: { ...summary.compaction!, subsumedSummaryDigests: [] },
    })).toBeUndefined();
  });

  it("scales the projection budget with the pinned window instead of a fixed 48 KB", () => {
    expect(summaryProjectionBudgetBytes(32_768)).toBe(48 * 1024);
    expect(summaryProjectionBudgetBytes(200_000)).toBe(86_400);
    expect(summaryProjectionBudgetBytes(4_194_304)).toBe(512 * 1024);
    expect(summaryProjectionBudgetBytes(Number.NaN)).toBe(48 * 1024);
  });
});

describe("byte-per-token calibration", () => {
  it("derives the ratio from provider-reported prompt tokens already in the journal", async () => {
    const journal = new EventJournal(new MemoryJournalBackend(), () => "2026-07-22T00:00:00.000Z");
    const manifest = await createSessionManifest({
      systemPrompt: "Calibrate.", providerId: "test", model: "test", tools: [],
      workspaceId: "memory://calibration", now: "2026-07-22T00:00:00.000Z",
    });
    const session = await journal.createSession("Calibration", manifest);
    const materialize = (events: readonly DurableEvent[]) => materializeMessages([...events]);
    expect(calibrateBytesPerToken(await journal.readEvents(session.id), {
      systemPrompt: manifest.systemPrompt, tools: [], materialize,
    })).toBeUndefined();

    await journal.append(session.id, [
      { type: "turn.requested", turnId: "turn-0", payload: { content: "dense 密度 ".repeat(200) } },
    ]);
    const before = await journal.readEvents(session.id);
    await journal.append(session.id, [
      { type: "inference.started", turnId: "turn-0", operationId: "op-0", payload: { step: 0 } },
      { type: "inference.usage", turnId: "turn-0", operationId: "op-0", payload: { inputTokens: 700 } },
      { type: "assistant.completed", turnId: "turn-0", operationId: "op-0", payload: { message: { role: "assistant", content: "ok" }, finishReason: "stop" } },
      { type: "turn.completed", turnId: "turn-0", payload: { responseDigest: "d", receiptId: null } },
    ]);
    const events = await journal.readEvents(session.id);
    const bytes = new TextEncoder().encode(JSON.stringify({
      messages: materialize(before), systemPrompt: manifest.systemPrompt, tools: [],
    })).byteLength;
    const calibrated = calibrateBytesPerToken(events, {
      systemPrompt: manifest.systemPrompt, tools: [], materialize,
    })!;
    expect(calibrated).toBeGreaterThan(2);
    expect(calibrated).toBeLessThan(6);
    expect(Math.abs(calibrated - bytes / 700)).toBeLessThan(0.15);
  });

  it("clamps an implausible provider-reported ratio before it can steer compression", async () => {
    const journal = new EventJournal(new MemoryJournalBackend(), () => "2026-07-22T00:00:00.000Z");
    const manifest = await createSessionManifest({
      systemPrompt: "Clamp.", providerId: "test", model: "test", tools: [],
      workspaceId: "memory://clamp", now: "2026-07-22T00:00:00.000Z",
    });
    const session = await journal.createSession("Clamp", manifest);
    await journal.append(session.id, [
      { type: "turn.requested", turnId: "turn-0", payload: { content: "x".repeat(4_000) } },
      { type: "inference.started", turnId: "turn-0", operationId: "op-0", payload: { step: 0 } },
      // A hostile provider reporting one token would otherwise suppress compression forever.
      { type: "inference.usage", turnId: "turn-0", operationId: "op-0", payload: { inputTokens: 1 } },
    ]);
    const events = await journal.readEvents(session.id);
    expect(calibrateBytesPerToken(events, {
      systemPrompt: manifest.systemPrompt,
      tools: [],
      materialize: (input) => materializeMessages([...input]),
    })).toBe(6);
  });
});

describe("in-loop context budget", () => {
  it("truncates a tool result with an explicit marker instead of losing the turn", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    tools.register(bulkTool(64 * 1024));
    const transport = new ToolThenAnswerTransport("");
    const manifest = await createSessionManifest({
      systemPrompt: "Bounded loop.", providerId: transport.id, model: "test",
      tools: tools.definitions(), workspaceId: "memory://in-loop",
      contextPolicy: createSessionContextPolicy({
        contextWindowTokens: 2_048,
        source: { kind: "runtime-config", label: "in-loop budget fixture" },
      }),
    });
    const session = await journal.createSession("In-loop", manifest);
    const result = await runTurn({
      sessionId: session.id, content: "run the bulk tool", transport, tools, journal,
      approvalPolicy: allowAllForTests, signal: new AbortController().signal,
    });
    expect(result.content).toBe("done");

    const events = await journal.readEvents(session.id);
    const resulted = events.find((event) => event.type === "tool.resulted")!;
    const payload = resulted.payload as Record<string, JsonValue>;
    expect(String(payload.content)).toContain("[Airship truncated this tool result");
    expect(new TextEncoder().encode(String(payload.content)).byteLength).toBeLessThan(64 * 1024);
    expect(payload.metadata).toMatchObject({ contextBudgetTruncated: true, originalContentBytes: 64 * 1024 });
    const audit = await auditSessionHistory({ session: (await journal.getSession(session.id))!, events });
    expect(audit.findings).toEqual([]);
  });

  it("still keeps a bounded tool result when the opening request is already over the estimate", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    tools.register(bulkTool(4 * 1024));
    const transport = new ToolThenAnswerTransport("");
    const manifest = await createSessionManifest({
      systemPrompt: "Bounded loop.", providerId: transport.id, model: "test",
      tools: tools.definitions(), workspaceId: "memory://in-loop-over-open",
      contextPolicy: createSessionContextPolicy({
        contextWindowTokens: 2_048,
        source: { kind: "runtime-config", label: "over-opening fixture" },
      }),
    });
    const session = await journal.createSession("Over-opening", manifest);
    // ~12 KB of user content is already about 3,300 estimated tokens against a
    // 2,048-token window before the loop has added anything. Measuring the
    // ceiling from the pinned window alone gave this step 0 bytes, stored the
    // tool result as nothing but its truncation marker, and then failed the turn
    // for the marker's own 113 bytes of in-loop growth — the estimate-based
    // refusal the step-0 check exists to avoid, one step later and lossier.
    const result = await runTurn({
      sessionId: session.id, content: `open wide ${"context ".repeat(1_500)}`,
      transport, tools, journal,
      approvalPolicy: allowAllForTests, signal: new AbortController().signal,
    });
    expect(result.content).toBe("done");

    const events = await journal.readEvents(session.id);
    const payload = events.find((event) => event.type === "tool.resulted")!.payload as Record<string, JsonValue>;
    const retained = new TextEncoder().encode(String(payload.content)).byteLength;
    expect(String(payload.content)).toContain("[Airship truncated this tool result");
    expect(payload.metadata).toMatchObject({ contextBudgetTruncated: true, originalContentBytes: 4 * 1024 });
    // Bounded above by the tool's own output and below by far more than the bare
    // marker, so the allowance is real and still capped.
    expect(retained).toBeGreaterThan(2 * 1024);
    expect(retained).toBeLessThan(4 * 1024);
  });

  it("fails the turn deterministically when in-loop growth passes the pinned window", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    tools.register(bulkTool(64));
    const transport = new ToolThenAnswerTransport("overflow ".repeat(20_000));
    const manifest = await createSessionManifest({
      systemPrompt: "Bounded loop.", providerId: transport.id, model: "test",
      tools: tools.definitions(), workspaceId: "memory://in-loop-overflow",
      contextPolicy: createSessionContextPolicy({
        contextWindowTokens: 2_048,
        source: { kind: "runtime-config", label: "in-loop overflow fixture" },
      }),
    });
    const session = await journal.createSession("Overflow", manifest);
    await expect(runTurn({
      sessionId: session.id, content: "run the bulk tool", transport, tools, journal,
      approvalPolicy: allowAllForTests, signal: new AbortController().signal,
    })).rejects.toThrow("no longer fits the session's pinned 2048-token context window");
    const events = await journal.readEvents(session.id);
    expect(events.at(-1)?.type).toBe("turn.failed");
  });
});

/**
 * Every committed compacted tier, oldest first, with the journal index of the
 * commitment that carries it. Instrumenting the fixture this way is what turns
 * "a tier happened" into "these tiers happened, in this order".
 */
function committedCompactions(events: readonly DurableEvent[]): readonly Readonly<{
  index: number;
  summary: CanonicalContextSummary;
  compaction: NonNullable<CanonicalContextSummary["compaction"]>;
}>[] {
  return events.flatMap((event, index) => {
    const summary = canonicalContextSummary(event.payload);
    return summary?.compaction
      ? [Object.freeze({ index, summary, compaction: summary.compaction })]
      : [];
  });
}

/**
 * Re-derive the whole-commitment digest after a tamper so the outer check at the
 * top of verifyContextSummary passes and the specific check under test is the
 * one that has to fire.
 */
async function reseal(summary: Record<string, unknown>): Promise<CanonicalContextSummary> {
  const { summaryDigest, ...commitment } = summary;
  void summaryDigest;
  const canonical = canonicalContextSummary({
    ...commitment,
    summaryDigest: await sha256(stableStringify(commitment as JsonValue)),
  });
  if (!canonical) throw new Error("Resealed commitment no longer canonicalizes.");
  return canonical;
}

/** Drives real compressions until the projection budget forces a compacted tier. */
async function compactedSessionFixture(rounds: number) {
  const journal = new EventJournal(new MemoryJournalBackend(), () => "2026-07-22T00:00:00.000Z");
  const manifest = await createSessionManifest({
    systemPrompt: "Compact.", providerId: "test", model: "test", tools: [],
    workspaceId: "memory://compaction", now: "2026-07-22T00:00:00.000Z",
    contextPolicy: createSessionContextPolicy({
      contextWindowTokens: OPTIONS.contextWindowTokens,
      source: { kind: "runtime-config", label: "compaction fixture" },
      compression: {
        threshold: OPTIONS.threshold,
        preserveRecentTurns: OPTIONS.preserveRecentTurns,
        maxSummaryDeltaBytes: OPTIONS.maxSummaryDeltaBytes,
      },
      summarizer: {
        mode: "inference-transport",
        adapterId: INFERENCE_CONTEXT_SUMMARIZER_ID,
        onFailure: "extractive-fallback",
      },
    }),
  });
  const session = await journal.createSession("Compaction", manifest);
  const summarizer = bulkSummarizer(manifest.providerId, manifest.model);
  for (let round = 0; round < rounds; round += 1) {
    for (let turn = 0; turn < 2; turn += 1) {
      const turnId = `round-${round}-turn-${turn}`;
      await journal.append(session.id, [
        { type: "turn.requested", turnId, payload: { content: `${turnId} ${"payload ".repeat(4_000)}` } },
        { type: "turn.completed", turnId, payload: { responseDigest: `response-${turnId}`, receiptId: null } },
      ]);
    }
    const events = await journal.readEvents(session.id);
    const summary = await planContextCompression({
      events,
      messages: materializeMessages(events, { injectLatestContext: false }),
      projectedUserContent: `round ${round} continues ${"payload ".repeat(4_000)}`,
      systemPrompt: manifest.systemPrompt,
      tools: [],
      options: OPTIONS,
      summarizer,
      summarizerFailure: "extractive-fallback",
    });
    if (summary) {
      await journal.append(session.id, [{ type: "context.summary.updated", payload: summary as never }]);
    }
  }
  const events = await journal.readEvents(session.id);
  // A compacted tier is folded into the existing commitment shape, so replay
  // must still accept it without a protocol amendment. The fixture's turns are
  // deliberately shape-minimal, so only summary findings are asserted here.
  const audit = await auditSessionHistory({ session: (await journal.getSession(session.id))!, events });
  expect(audit.findings.map((finding) => finding.code)).not.toContain("CONTEXT_SUMMARY_INVALID");
  return { journal, session, events };
}

/**
 * Emits deltas large enough to exhaust the projection budget, and echoes the
 * head of every subsumed body so the test can prove the oldest material survived
 * compaction rather than being paraphrased away by a stub.
 */
function bulkSummarizer(providerId: string, model: string): ContextSummarizer {
  let round = 0;
  return {
    id: INFERENCE_CONTEXT_SUMMARIZER_ID,
    async summarize(request) {
      const text = (request.compaction
        ? `MERGED L${request.compaction.level}: ${request.compaction.subsumed
          .map((entry) => entry.text.slice(0, 96))
          .join(" || ")}`.slice(0, request.maximumOutputBytes)
        : `ROUND${round++}-MARKER events ${request.sourceStartSequence}-${request.sourceEndSequence} ${"detail ".repeat(1_500)}`).trim();
      return {
        text,
        provenance: {
          kind: "inference-transport-v1",
          adapterId: INFERENCE_CONTEXT_SUMMARIZER_ID,
          providerId,
          model,
          posture: "local",
          requestDigest: await sha256(`request-${request.sourceStartSequence}-${request.sourceEndSequence}`),
          responseDigest: await sha256(text),
        },
      };
    },
  };
}

function stripCompaction(payload: unknown): JsonValue {
  const { compaction, ...rest } = payload as Record<string, JsonValue>;
  void compaction;
  return rest as JsonValue;
}

function bulkTool(bytes: number): Tool {
  return {
    definition: {
      name: "bulk_output",
      description: "Return a fixed-size payload.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute() {
      return { content: "z".repeat(bytes), metadata: { source: "fixture" } };
    },
  };
}

class ToolThenAnswerTransport implements InferenceTransport {
  readonly id = "in-loop-capture";
  readonly posture = "local" as const;
  private calls = 0;
  constructor(private readonly assistantText: string) {}
  async *stream(_request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      if (this.assistantText) yield { type: "text-delta", text: this.assistantText };
      yield { type: "tool-call", call: { id: "call-1", name: "bulk_output", arguments: {} } };
      yield { type: "completed", finishReason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: "done" };
    yield { type: "completed", finishReason: "stop" };
  }
}
