import { describe, expect, it } from "vitest";
import { createSessionManifest, materializeMessages, runTurn } from "./agent";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "./contracts";
import {
  canonicalContextSummary,
  createInferenceTransportContextSummarizer,
  createSessionContextPolicy,
  materializeContextSummary,
  planContextCompression,
  resolveContextCompressionOptions,
  sessionContextPoliciesMatch,
  verifyContextSummary,
} from "./context-compressor";
import { sha256 } from "./hash";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { allowAllForTests, ToolRegistry } from "../tools/registry";
import { auditSessionHistory } from "./session-audit";

describe("iterative context compressor", () => {
  it("constrains the configurable trigger to 80-85 percent", () => {
    expect(resolveContextCompressionOptions({ threshold: 0.8 }).threshold).toBe(0.8);
    expect(resolveContextCompressionOptions({ threshold: 0.85 }).threshold).toBe(0.85);
    expect(() => resolveContextCompressionOptions({ threshold: 0.79 })).toThrow("between 0.80 and 0.85");
    expect(() => resolveContextCompressionOptions({ threshold: 0.86 })).toThrow("between 0.80 and 0.85");
  });

  it("stores digest-linked deltas and projects references instead of replaying covered turns", async () => {
    const fixture = await historyFixture(5, "brass requirement ".repeat(180));
    const messages = materializeMessages(fixture.events, { injectLatestContext: false });
    const first = await planContextCompression({
      events: fixture.events,
      messages,
      projectedUserContent: "new task",
      systemPrompt: fixture.session.manifest.systemPrompt,
      tools: [],
      options: { contextWindowTokens: 2_048, threshold: 0.8, preserveRecentTurns: 2 },
    });
    expect(first).toBeDefined();
    const appended = await fixture.journal.append(fixture.session.id, [{
      type: "context.summary.updated",
      payload: first as never,
    }]);
    const events = [...fixture.events, ...appended];
    const canonical = canonicalContextSummary(appended[0]?.payload);
    expect(canonical).toBeDefined();
    expect(await verifyContextSummary(canonical!, events)).toBe(true);

    const projection = materializeContextSummary(events);
    expect(projection?.chainLength).toBe(1);
    expect(projection?.message.content).toContain(`Reference ${first?.summaryDigest}`);
    const projected = materializeMessages(events);
    expect(projected[0]?.content).toContain("iterative conversation summary");
    expect(JSON.stringify(projected.slice(1))).not.toContain("turn-0 brass requirement");
    expect(JSON.stringify(projected)).toContain("turn-4 brass requirement");
    expect(JSON.stringify(projected).length / JSON.stringify(messages).length).toBeLessThan(0.65);
  });

  it("keeps the newest delta and exact omission anchors when the prompt projection reaches its bound", () => {
    const summaries = Array.from({ length: 6 }, (_, index) => {
      const digest = `sha256:${String(index).padStart(43, "a")}`;
      const previous = index === 0 ? undefined : `sha256:${String(index - 1).padStart(43, "a")}`;
      return fakeSummaryEvent(index + 1, digest, previous, `${index}-newest-marker ${"detail ".repeat(2_000)}`);
    });
    const projection = materializeContextSummary(summaries);
    expect(projection).toBeDefined();
    expect(projection!.bytes).toBeLessThanOrEqual(48 * 1024);
    expect(projection!.message.content).toContain("5-newest-marker");
    expect(projection!.message.content).toContain("omitted from the active projection");
    expect(projection!.message.content).not.toContain("0-newest-marker");
    expect(projection!.latestSummaryDigest).toBe(`sha256:${String(5).padStart(43, "a")}`);
  });

  it("supports a bounded non-recursive summarizer port with exact source lineage", async () => {
    const fixture = await historyFixture(5, "durable decision ".repeat(180));
    const requests: unknown[] = [];
    const summary = await planContextCompression({
      events: fixture.events,
      messages: materializeMessages(fixture.events, { injectLatestContext: false }),
      projectedUserContent: "continue",
      systemPrompt: fixture.session.manifest.systemPrompt,
      tools: [],
      options: { contextWindowTokens: 2_048, threshold: 0.8, preserveRecentTurns: 2 },
      summarizer: {
        id: "test/local-summary-v1",
        async summarize(request) {
          requests.push(request);
          // The port returns a structured output: a bare string cannot carry
          // provenance, and provenance is not optional for a compacted tier.
          return { text: "The user established a durable decision and requested that it remain available by reference." };
        },
      },
    });
    expect(summary?.summaryMethod).toBe("summarizer-port-v1");
    expect(summary?.summarizerId).toBe("test/local-summary-v1");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sourceStartSequence: 1,
      sourceEndSequence: expect.any(Number),
      maximumOutputBytes: 12 * 1024,
    });
    expect((requests[0] as { source: unknown[] }).source.length).toBeGreaterThan(0);
  });

  it("fails closed when a summarizer exceeds its output bound", async () => {
    const fixture = await historyFixture(5, "bounded context ".repeat(180));
    await expect(planContextCompression({
      events: fixture.events,
      messages: materializeMessages(fixture.events, { injectLatestContext: false }),
      projectedUserContent: "continue",
      systemPrompt: fixture.session.manifest.systemPrompt,
      tools: [],
      options: { contextWindowTokens: 2_048, threshold: 0.8, preserveRecentTurns: 2, maxSummaryDeltaBytes: 512 },
      summarizer: {
        id: "test/oversized",
        async summarize() { return { text: "x".repeat(513) }; },
      },
    })).rejects.toThrow("full history was retained");
  });

  it("uses the selected inference transport directly with a tool-free bounded request", async () => {
    const transport = new SummaryCaptureTransport();
    const summarizer = createInferenceTransportContextSummarizer({
      transport,
      model: "provider/summary-model",
      sessionId: "session-summary-direct",
    });
    const output = await summarizer.summarize({
      source: [{
        role: "user",
        content: "Preserve the workspace decision.",
        eventSequence: 2,
        eventDigest: await sha256("event-2"),
      }],
      sourceStartSequence: 1,
      sourceEndSequence: 3,
      maximumOutputBytes: 512,
    });

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      sessionId: "session-summary-direct",
      model: "provider/summary-model",
      tools: [],
      messages: [{ role: "user" }],
    });
    expect(transport.requests[0]!.systemPrompt).toContain("bounded context compressor");
    expect(output).toMatchObject({
      text: "Pinned decision retained.",
      provenance: {
        kind: "inference-transport-v1",
        adapterId: "airship/inference-transport-summary-v1",
        providerId: transport.id,
        model: "provider/summary-model",
        posture: "encrypted-unattested",
      },
    });
    if (typeof output === "string" || !output.provenance) throw new Error("Expected provenance-bearing output.");
    expect(output.provenance.responseDigest).toBe(await sha256(output.text));
  });

  it("rejects tool calls from the direct summarizer transport without entering the agent loop", async () => {
    const transport: InferenceTransport = {
      id: "malicious-summary-transport",
      posture: "local",
      async *stream() {
        yield { type: "tool-call", call: { id: "call-1", name: "read_file", arguments: { path: "secret" } } };
        yield { type: "completed", finishReason: "tool-calls" };
      },
    };
    const summarizer = createInferenceTransportContextSummarizer({
      transport,
      model: "test",
      sessionId: "session-no-recursion",
    });
    await expect(summarizer.summarize({
      source: [],
      sourceStartSequence: 1,
      sourceEndSequence: 1,
      maximumOutputBytes: 512,
    })).rejects.toThrow("attempted a tool call");
  });

  it("falls back explicitly on malformed provenance and preserves that failure through canonicalization", async () => {
    const fixture = await historyFixture(5, "malformed provenance decision ".repeat(180));
    const summary = await planContextCompression({
      events: fixture.events,
      messages: materializeMessages(fixture.events, { injectLatestContext: false }),
      projectedUserContent: "continue",
      systemPrompt: fixture.session.manifest.systemPrompt,
      tools: [],
      options: { contextWindowTokens: 2_048, threshold: 0.8, preserveRecentTurns: 2 },
      summarizerFailure: "extractive-fallback",
      summarizer: {
        id: "airship/inference-transport-summary-v1",
        async summarize() {
          return {
            text: "The prior decision remains active.",
            provenance: {
              kind: "inference-transport-v1",
              adapterId: "airship/inference-transport-summary-v1",
              providerId: "test",
              model: "test",
              posture: "local",
              requestDigest: await sha256("request"),
              responseDigest: await sha256("different-response"),
            },
          };
        },
      },
    });

    expect(summary).toMatchObject({
      summaryMethod: "extractive-fallback-v1",
      summarizerAttempt: {
        summarizerId: "airship/inference-transport-summary-v1",
        outcome: "failed-fallback",
        failure: "invalid-output",
      },
    });
    const canonical = canonicalContextSummary(summary);
    expect(canonical?.summarizerAttempt).toEqual(summary?.summarizerAttempt);
    expect(await verifyContextSummary(canonical!, fixture.events)).toBe(true);

    const malformedAttempt = structuredClone(summary!);
    (malformedAttempt.summarizerAttempt as { failure: string }).failure = "unclassified";
    expect(canonicalContextSummary(malformedAttempt)).toBeUndefined();
  });

  it("canonicalizes pinned summarizer policy before comparing session semantics", () => {
    const policy = createSessionContextPolicy({
      contextWindowTokens: 32_768,
      source: { kind: "provider-catalog", field: "contextTokens" },
      summarizer: {
        mode: "inference-transport",
        adapterId: "airship/inference-transport-summary-v1",
        onFailure: "retain-history",
      },
    });
    const withIgnoredInputFields = structuredClone(policy) as typeof policy & { ignored?: boolean };
    withIgnoredInputFields.ignored = true;
    expect(sessionContextPoliciesMatch(policy, withIgnoredInputFields)).toBe(true);

    const malformed = structuredClone(policy) as unknown as {
      compression: { summarizer: { onFailure: string } };
    };
    malformed.compression.summarizer.onFailure = "silently-drop-history";
    expect(sessionContextPoliciesMatch(policy, malformed as never)).toBe(false);
  });

  it("integrates compression into turns and remains replay-auditable", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    const transport = new CaptureTransport();
    const manifest = await createSessionManifest({
      systemPrompt: "Keep exact requirements.", providerId: transport.id, model: "test",
      tools: tools.definitions(), workspaceId: "memory://compressor-test",
      contextPolicy: createSessionContextPolicy({
        contextWindowTokens: 2_048,
        source: { kind: "runtime-config", label: "context compressor fixture" },
        compression: { threshold: 0.82, preserveRecentTurns: 1 },
      }),
    });
    const session = await journal.createSession("Compression", manifest);
    for (let index = 0; index < 5; index += 1) {
      await runTurn({
        sessionId: session.id,
        content: `turn-${index} ${"important constraint ".repeat(160)}`,
        transport,
        tools,
        journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      });
    }
    const events = await journal.readEvents(session.id);
    const summaries = events.filter((event) => event.type === "context.summary.updated");
    expect(summaries.length).toBeGreaterThan(0);
    expect(transport.requests.at(-1)?.messages[0]?.content).toContain("digest-linked prior context");
    const current = await journal.getSession(session.id);
    const audit = await auditSessionHistory({ session: current!, events });
    expect(audit.findings).toEqual([]);
    expect(audit.status).toBe("verified");
  });

  it("rejects mutable per-turn limits that differ from the session pin", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    const transport = new CaptureTransport();
    const manifest = await createSessionManifest({
      systemPrompt: "Pinned semantics.", providerId: transport.id, model: "test",
      tools: [], workspaceId: "memory://pinned",
      contextPolicy: createSessionContextPolicy({
        contextWindowTokens: 2_048,
        source: { kind: "provider-catalog", field: "contextTokens" },
      }),
    });
    const session = await journal.createSession("Pinned", manifest);
    await expect(runTurn({
      sessionId: session.id,
      content: "hello",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
      contextCompression: { contextWindowTokens: 4_096 },
    })).rejects.toThrow("exactly match the policy pinned");
    const events = await journal.readEvents(session.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.requested",
      "turn.failed",
    ]);
    expect(events.filter((event) => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type))).toHaveLength(1);
  });
});

async function historyFixture(turns: number, body: string) {
  const journal = new EventJournal(new MemoryJournalBackend(), () => "2026-07-22T00:00:00.000Z");
  const manifest = await createSessionManifest({
    systemPrompt: "Summarize.", providerId: "test", model: "test", tools: [], workspaceId: "memory://test",
    now: "2026-07-22T00:00:00.000Z",
  });
  const session = await journal.createSession("History", manifest);
  for (let index = 0; index < turns; index += 1) {
    const turnId = `turn-${index}`;
    await journal.append(session.id, [
      { type: "turn.requested", turnId, payload: { content: `${turnId} ${body}` } },
      { type: "turn.completed", turnId, payload: { responseDigest: `response-${index}`, receiptId: null } },
    ]);
  }
  return { journal, session, events: await journal.readEvents(session.id) };
}

class CaptureTransport implements InferenceTransport {
  readonly id = "compression-capture";
  readonly posture = "local" as const;
  readonly requests: InferenceRequest[] = [];
  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "text-delta", text: "Acknowledged." };
    yield { type: "completed", finishReason: "stop" };
  }
}

class SummaryCaptureTransport implements InferenceTransport {
  readonly id = "summary-capture";
  readonly posture = "encrypted-unattested" as const;
  readonly requests: InferenceRequest[] = [];
  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "progress", phase: "reasoning" };
    yield { type: "text-delta", text: "Pinned decision " };
    yield { type: "text-delta", text: "retained." };
    yield { type: "completed", finishReason: "stop" };
  }
}

function fakeSummaryEvent(
  index: number,
  summaryDigest: string,
  previousSummaryDigest: string | undefined,
  summaryDelta: string,
) {
  const sourceStartSequence = index === 1 ? 1 : (index - 1) * 10 + 1;
  const sourceEndSequence = index * 10;
  return {
    version: 1 as const,
    eventId: `summary-${index}`,
    sessionId: "summary-projection-fixture",
    sequence: 1_000 + index,
    recordedAt: "2026-07-22T00:00:00.000Z",
    previousDigest: "genesis",
    digest: `sha256:${String(index + 10).padStart(43, "b")}`,
    type: "context.summary.updated",
    payload: {
      version: 1,
      algorithm: "airship-reference-delta-v1",
      contextWindowTokens: 32_768,
      thresholdBasisPoints: 8_200,
      targetRatioBasisPoints: 6_200,
      sourceStartSequence,
      sourceEndSequence,
      sourceStartPreviousDigest: sourceStartSequence === 1 ? "genesis" : `sha256:${String(index).padStart(43, "c")}`,
      sourceEndDigest: `sha256:${String(index + 1).padStart(43, "c")}`,
      ...(previousSummaryDigest ? { previousSummaryDigest } : {}),
      summaryDelta,
      summaryMethod: "extractive-fallback-v1",
      summaryDeltaDigest: `sha256:${String(index + 20).padStart(43, "d")}`,
      estimatedTokensBefore: 10_000,
      estimatedTokensAfter: 6_000,
      summaryDigest,
    },
  };
}
