import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "./contracts";
import { createSessionManifest, runTurn } from "./agent";
import { EventJournal, effectiveSessionModel } from "./journal";
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
});
