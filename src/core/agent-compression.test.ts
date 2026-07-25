import { describe, expect, it } from "vitest";
import { ToolRegistry, allowAllForTests } from "../tools/registry";
import { createSessionManifest, runTurn } from "./agent";
import { createSessionContextPolicy } from "./context-compressor";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "./contracts";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";

describe("agent context compression integration", () => {
  it("journals a verified summary before inference and sends the compact projection", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    const transport = new LongResponseTransport();
    const manifest = await createSessionManifest({
      systemPrompt: "Preserve decisions while keeping context bounded.",
      providerId: transport.id,
      model: "compression-test",
      tools: tools.definitions(),
      workspaceId: "memory://compression",
      contextPolicy: createSessionContextPolicy({
        contextWindowTokens: 2_048,
        source: { kind: "runtime-config", label: "compression integration fixture" },
        compression: { threshold: 0.82, preserveRecentTurns: 2 },
        summarizer: {
          mode: "inference-transport",
          adapterId: "airship/inference-transport-summary-v1",
          onFailure: "extractive-fallback",
        },
      }),
    });
    const session = await journal.createSession("Compression", manifest);

    for (let index = 1; index <= 5; index += 1) {
      await runTurn({
        sessionId: session.id,
        content: `Request ${index}: ${"important constraint ".repeat(240)}`,
        transport,
        tools,
        journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      });
    }

    const events = await journal.readEvents(session.id);
    const summaries = events.filter((event) => event.type === "context.summary.updated");
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries[0]?.payload).toMatchObject({
      summaryMethod: "summarizer-port-v1",
      summarizerId: "airship/inference-transport-summary-v1",
      summarizerProvenance: {
        kind: "inference-transport-v1",
        providerId: transport.id,
        model: "compression-test",
        posture: "local",
      },
    });
    const compressedRequest = transport.requests.find((request) =>
      request.messages[0]?.content.includes("Airship iterative conversation summary"),
    );
    expect(compressedRequest).toBeDefined();
    expect(compressedRequest!.messages.length).toBeLessThan(10);

    const current = await journal.getSession(session.id);
    const audit = await auditSessionHistory({ session: current!, events });
    expect(audit.findings).toEqual([]);
    expect(audit.status).toBe("verified");
  });

  it("records an explicit fallback when intelligent summarization is unavailable", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    const transport = new FailingSummaryTransport();
    const manifest = await createSessionManifest({
      systemPrompt: "Keep the session available under provider degradation.",
      providerId: transport.id,
      model: "fallback-test",
      tools: [],
      workspaceId: "memory://compression-fallback",
      contextPolicy: createSessionContextPolicy({
        contextWindowTokens: 2_048,
        source: { kind: "runtime-config", label: "fallback integration fixture" },
        compression: { threshold: 0.82, preserveRecentTurns: 1 },
        summarizer: {
          mode: "inference-transport",
          adapterId: "airship/inference-transport-summary-v1",
          onFailure: "extractive-fallback",
        },
      }),
    });
    const session = await journal.createSession("Fallback", manifest);
    for (let index = 0; index < 5; index += 1) {
      await runTurn({
        sessionId: session.id,
        content: `Constraint ${index}: ${"retain this exact requirement ".repeat(180)}`,
        transport,
        tools,
        journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      });
    }
    const events = await journal.readEvents(session.id);
    expect(events.find((event) => event.type === "context.summary.updated")?.payload).toMatchObject({
      summaryMethod: "extractive-fallback-v1",
      summarizerAttempt: {
        summarizerId: "airship/inference-transport-summary-v1",
        outcome: "failed-fallback",
        failure: "adapter-error",
      },
    });
    const current = await journal.getSession(session.id);
    const audit = await auditSessionHistory({ session: current!, events });
    expect(audit.findings).toEqual([]);
  });

  it("journals exactly one failed terminal when strict summarization rejects", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    const transport = new ToggleSummaryTransport();
    const manifest = await createSessionManifest({
      systemPrompt: "Retain history unless a verified summary can be produced.",
      providerId: transport.id,
      model: "strict-summary-test",
      tools: tools.definitions(),
      workspaceId: "memory://strict-summary",
      contextPolicy: createSessionContextPolicy({
        contextWindowTokens: 2_048,
        source: { kind: "runtime-config", label: "strict summarizer lifecycle fixture" },
        compression: { threshold: 0.82, preserveRecentTurns: 1 },
        summarizer: {
          mode: "inference-transport",
          adapterId: "airship/inference-transport-summary-v1",
          onFailure: "retain-history",
        },
      }),
    });
    const session = await journal.createSession("Strict summary", manifest);
    for (let index = 0; index < 5; index += 1) {
      await runTurn({
        sessionId: session.id,
        content: `Seed ${index}: ${"preserve this architecture decision ".repeat(180)}`,
        transport,
        tools,
        journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      });
    }

    transport.failSummaries = true;
    let rejected: unknown;
    for (let index = 5; index < 12 && !rejected; index += 1) {
      try {
        await runTurn({
          sessionId: session.id,
          content: `Trigger ${index}: ${"force bounded context compression ".repeat(180)}`,
          transport,
          tools,
          journal,
          approvalPolicy: allowAllForTests,
          signal: new AbortController().signal,
        });
      } catch (error) {
        rejected = error;
      }
    }
    expect(rejected).toMatchObject({ message: "Summarization deliberately failed." });

    const events = await journal.readEvents(session.id);
    const failed = [...events].reverse().find((event) => event.type === "turn.failed");
    expect(failed?.turnId).toBeDefined();
    const failedTurn = events.filter((event) => event.turnId === failed?.turnId);
    expect(failedTurn.map((event) => event.type)).toEqual(["turn.requested", "turn.failed"]);
    expect(failedTurn.some((event) => event.type === "inference.started")).toBe(false);
    expect(failedTurn.filter((event) => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type))).toHaveLength(1);

    const current = await journal.getSession(session.id);
    const audit = await auditSessionHistory({ session: current!, events });
    expect(audit.findings).toEqual([]);
    expect(audit.status).toBe("verified");
  });
});

class LongResponseTransport implements InferenceTransport {
  readonly id = "compression-transport";
  readonly posture = "local" as const;
  readonly requests: InferenceRequest[] = [];

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "text-delta", text: `Decision: ${"verified result ".repeat(240)}` };
    yield { type: "completed", finishReason: "stop" };
  }
}

class FailingSummaryTransport implements InferenceTransport {
  readonly id = "failing-summary-transport";
  readonly posture = "local" as const;

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    if (request.systemPrompt.includes("bounded context compressor")) {
      throw new Error("Summarization is temporarily unavailable.");
    }
    yield { type: "text-delta", text: "The main turn remains available." };
    yield { type: "completed", finishReason: "stop" };
  }
}

class ToggleSummaryTransport implements InferenceTransport {
  readonly id = "toggle-summary-transport";
  readonly posture = "local" as const;
  failSummaries = false;

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    if (request.systemPrompt.includes("bounded context compressor")) {
      if (this.failSummaries) throw new Error("Summarization deliberately failed.");
      yield { type: "text-delta", text: "Architecture decisions and validation outcomes remain pinned." };
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    yield { type: "text-delta", text: `Decision retained: ${"verified outcome ".repeat(220)}` };
    yield { type: "completed", finishReason: "stop" };
  }
}
