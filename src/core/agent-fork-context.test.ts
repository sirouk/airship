import { describe, expect, it } from "vitest";
import { SessionLibrary } from "../sessions/library";
import { ToolRegistry, allowAllForTests } from "../tools/registry";
import { createSessionManifest, materializeMessages, runTurn } from "./agent";
import type { InferenceEvent, InferenceRequest, InferenceTransport, JsonValue } from "./contracts";
import { FORK_CONTEXT_EVENT_TYPE } from "./fork-context";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";

describe("audited fork context", () => {
  it("carries source conversation context into real fork inference without reusing source events", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    const transport = new CapturingTransport(["Source answer.", "Fork answer."]);
    const manifest = await createSessionManifest({
      systemPrompt: "Preserve the audited conversation context.",
      providerId: transport.id,
      model: "fork-context-test",
      tools: tools.definitions(),
      workspaceId: "memory://fork-context",
      turnContext: "disabled",
    });
    const source = await journal.createSession("Source", manifest);
    await runTurn({
      sessionId: source.id,
      content: "Remember the source fact.",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });
    const sourceSnapshot = (await journal.getSession(source.id))!;
    const sourceEvents = await journal.readEvents(source.id);

    const result = await new SessionLibrary(journal).fork(source.id, {
      expectedSourceHead: {
        sequence: sourceSnapshot.headSequence,
        digest: sourceSnapshot.headDigest,
      },
    });
    await runTurn({
      sessionId: result.session.id,
      content: "What did I ask you to remember?",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    expect(transport.requests[1]?.messages).toEqual([
      { role: "user", content: "Remember the source fact." },
      { role: "assistant", content: "Source answer." },
      { role: "user", content: "What did I ask you to remember?" },
    ]);
    const forkEvents = await journal.readEvents(result.session.id);
    const seed = forkEvents.find((event) => event.type === FORK_CONTEXT_EVENT_TYPE)!;
    expect(seed.turnId).toBeUndefined();
    expect(seed.operationId).toBeUndefined();
    expect((seed.payload as Record<string, unknown>).kind).toBe("fork-context");
    expect(new Set(sourceEvents.map((event) => event.eventId)).has(seed.eventId)).toBe(false);
    const current = (await journal.getSession(result.session.id))!;
    const audit = await auditSessionHistory({ session: current, events: forkEvents });
    expect(audit.status).toBe("verified");
    expect(audit.findings).toEqual([]);
  });

  it("fails closed when a seed is not explicitly scoped to its fork lineage", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const manifest = await createSessionManifest({
      systemPrompt: "Keep scope exact.",
      providerId: "scope-test",
      model: "scope-test",
      tools: [],
      workspaceId: "memory://scope-test",
      turnContext: "disabled",
    });
    const source = await journal.createSession("Source", manifest);
    const sourceSnapshot = (await journal.getSession(source.id))!;
    const result = await new SessionLibrary(journal).fork(source.id, {
      expectedSourceHead: { sequence: sourceSnapshot.headSequence, digest: sourceSnapshot.headDigest },
    });
    const events = await journal.readEvents(result.session.id);

    expect(materializeMessages(events)).toEqual([]);
    expect(materializeMessages(events, {
      forkContextScope: {
        sessionId: "another-session",
        lineage: result.session.manifest.lineage,
      },
    })).toEqual([]);

    const originalReadEvents = journal.readEvents.bind(journal);
    journal.readEvents = async (sessionId, afterSequence = 0, signal) => {
      const read = await originalReadEvents(sessionId, afterSequence, signal);
      if (sessionId !== result.session.id) return read;
      return read.map((event) => event.type === FORK_CONTEXT_EVENT_TYPE
        ? {
            ...event,
            payload: {
              ...(event.payload as Record<string, unknown>),
              contextDigest: `sha256:${"Z".repeat(43)}`,
            } as unknown as JsonValue,
          }
        : event);
    };
    const tools = new ToolRegistry();
    const transport = new CapturingTransport(["must not run"], "scope-test");
    await expect(runTurn({
      sessionId: result.session.id,
      content: "Do not admit changed inherited context.",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow(/fork-context seed.*digest mismatch/iu);
    expect((await originalReadEvents(result.session.id)).some((event) => event.type === "turn.requested")).toBe(false);
  });

  it("marks a lineage-only destination invalid instead of silently materializing an empty fork", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const forkedAt = "2026-07-28T00:00:00.000Z";
    const manifest = await createSessionManifest({
      systemPrompt: "Require the fork seed.",
      providerId: "missing-seed",
      model: "missing-seed",
      tools: [],
      workspaceId: "memory://missing-seed",
      turnContext: "disabled",
      now: forkedAt,
      lineage: {
        version: 1,
        kind: "fork",
        sourceSessionId: "source",
        sourceHeadSequence: 1,
        sourceHeadDigest: `sha256:${"A".repeat(43)}`,
        forkedAt,
      },
    });
    const destination = await journal.createSession("Lineage only", manifest);
    const current = (await journal.getSession(destination.id))!;
    const audit = await auditSessionHistory({ session: current, events: await journal.readEvents(destination.id) });

    expect(audit.status).toBe("invalid");
    expect(audit.findings.map((finding) => finding.code)).toContain("FORK_CONTEXT_SEED_MISSING");
  });
});

class CapturingTransport implements InferenceTransport {
  readonly posture = "local" as const;
  readonly requests: InferenceRequest[] = [];
  private next = 0;

  constructor(
    private readonly responses: readonly string[],
    readonly id = "fork-context-transport",
  ) {}

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    const response = this.responses[this.next++] ?? "Unexpected response.";
    yield { type: "text-delta", text: response };
    yield { type: "completed", finishReason: "stop" };
  }
}
