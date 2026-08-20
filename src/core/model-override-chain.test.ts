import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "./contracts";
import { createSessionManifest, runTurn } from "./agent";
import { EventJournal, JournalConflictError, effectiveSessionModel } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";
import { assessSessionHistory, decideSessionResume, extractSessionPins } from "../sessions/domain";
import { ToolRegistry, allowAllForTests } from "../tools/registry";
import type { JsonValue } from "./contracts";

class CapturingTransport implements InferenceTransport {
  readonly id = "override-test-transport";
  readonly posture = "local" as const;
  readonly requests: InferenceRequest[] = [];

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "text-delta", text: `Reply from ${request.model}.` };
    yield { type: "completed", finishReason: "stop" };
  }
}

class FirstRequestHeldTransport extends CapturingTransport {
  private enteredFirst!: () => void;
  private releaseFirst!: () => void;
  readonly firstEntered = new Promise<void>((resolve) => { this.enteredFirst = resolve; });
  private readonly firstRelease = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  release(): void {
    this.releaseFirst();
  }

  override async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    if (this.requests.length === 1) {
      this.enteredFirst();
      await this.firstRelease;
    }
    yield { type: "text-delta", text: `Reply from ${request.model}.` };
    yield { type: "completed", finishReason: "stop" };
  }
}

class PreAdmissionStallingJournal extends EventJournal {
  private stall = true;
  private entered!: () => void;
  private releaseRead!: () => void;
  readonly preflightReadEntered = new Promise<void>((resolve) => { this.entered = resolve; });
  private readonly resumeRead = new Promise<void>((resolve) => { this.releaseRead = resolve; });

  releasePreflight(): void {
    this.releaseRead();
  }

  override async readEvents(sessionId: string, afterSequence = 0, signal?: AbortSignal) {
    if (this.stall) {
      this.stall = false;
      this.entered();
      await this.resumeRead;
    }
    return super.readEvents(sessionId, afterSequence, signal);
  }
}

describe("a model switch lands on its own thread and mints honest digests through it", () => {
  it("turns before and after the switch stay on the same chain, receipts name their model, and the audit replays both", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const transport = new CapturingTransport();
    const tools = new ToolRegistry();
    const manifest = await createSessionManifest({
      systemPrompt: "test thread",
      providerId: transport.id,
      model: "original/model-a",
      tools: tools.definitions(),
      workspaceId: "memory://override-model",
    });
    const session = await journal.createSession("Thread", manifest);

    await runTurn({
      sessionId: session.id,
      content: "First question",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });
    expect(transport.requests.at(-1)?.model).toBe("original/model-a");

    // The same-thread model switch the person asked for: one durable journal
    // event, in place, no new pinned conversation.
    await journal.setSessionModel(session.id, "different/model-b");

    await runTurn({
      sessionId: session.id,
      content: "Second question",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });
    expect(transport.requests.at(-1)?.model).toBe("different/model-b");

    const record = (await journal.getSession(session.id))!;
    expect(record.manifest.model).toBe("original/model-a");
    expect(record.modelOverride).toBe("different/model-b");
    expect(effectiveSessionModel(record)).toBe("different/model-b");

    const events = await journal.readEvents(session.id);
    const started = events.filter((event) => event.type === "inference.started");
    expect(started.map((event) => (event.payload as JsonValue & { model: string }).model)).toEqual([
      "original/model-a",
      "different/model-b",
    ]);

    // The audit is the replay pass this thread always owed: inference.started,
    // idempotency digests, receipts — all verified against the model each was
    // actually minted for.
    const report = await auditSessionHistory({ session: record, events });
    expect(report.status).toBe("verified");

    const pins = extractSessionPins(record, events);
    expect(pins.model).toBe("different/model-b");

    const acceptance = assessSessionHistory(record, events);
    const runtime = {
      protocolVersion: 2 as const,
      providerId: transport.id,
      model: "different/model-b",
      inferenceBinding: undefined,
      toolManifestDigest: manifest.toolManifestDigest,
      posture: "local" as const,
      profile: undefined,
      workspaceId: "memory://override-model",
    };
    const resumedDecision = decideSessionResume(pins, acceptance, runtime);
    console.log('resume decision:', JSON.stringify(resumedDecision));
    console.log('assessment:', JSON.stringify(acceptance));
    expect(resumedDecision.action).toBe("resume");

    // A stale model in the caller's hand is presented with its own honest
    // verdict rather than silently failing — the conversation destinations
    // stay honest about which model a continuation would call.
    expect(decideSessionResume(pins, acceptance, { ...runtime, model: "original/model-a" }).action).toBe("fork-required");
  });

  it("keeps an admitted turn on model A when model B is selected for the next turn", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const transport = new FirstRequestHeldTransport();
    const tools = new ToolRegistry();
    const manifest = await createSessionManifest({
      systemPrompt: "test thread",
      providerId: transport.id,
      model: "model-a",
      tools: tools.definitions(),
      workspaceId: "memory://mid-turn-model-switch",
    });
    const session = await journal.createSession("Thread", manifest);

    const first = runTurn({
      sessionId: session.id,
      content: "First question",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });
    await transport.firstEntered;
    await journal.setSessionModel(session.id, "model-b");
    transport.release();
    await first;

    await runTurn({
      sessionId: session.id,
      content: "Second question",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    const record = (await journal.getSession(session.id))!;
    const events = await journal.readEvents(session.id);
    expect(transport.requests.map((request) => request.model)).toEqual(["model-a", "model-b"]);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.requested",
      "inference.started",
      "session.model-changed",
      "assistant.completed",
      "turn.completed",
      "turn.requested",
      "inference.started",
      "assistant.completed",
      "turn.completed",
    ]);
    expect(events.filter((event) => event.type === "assistant.completed").map((event) =>
      (event.payload as { receipt: { model: string } }).receipt.model
    )).toEqual(["model-a", "model-b"]);
    expect((await auditSessionHistory({ session: record, events })).status).toBe("verified");
  });

  it("refuses stale preflight instead of rebasing a turn over a model change", async () => {
    const journal = new PreAdmissionStallingJournal(new MemoryJournalBackend());
    const transport = new CapturingTransport();
    const tools = new ToolRegistry();
    const manifest = await createSessionManifest({
      systemPrompt: "test thread",
      providerId: transport.id,
      model: "model-a",
      tools: tools.definitions(),
      workspaceId: "memory://pre-admission-model-switch",
    });
    const session = await journal.createSession("Thread", manifest);

    const staleTurn = runTurn({
      sessionId: session.id,
      content: "Must not start",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });
    await journal.preflightReadEntered;
    await journal.setSessionModel(session.id, "model-b");
    journal.releasePreflight();

    await expect(staleTurn).rejects.toBeInstanceOf(JournalConflictError);
    expect(transport.requests).toEqual([]);
    expect((await journal.readEvents(session.id)).map((event) => event.type)).toEqual([
      "session.created",
      "session.model-changed",
    ]);
  });
});
