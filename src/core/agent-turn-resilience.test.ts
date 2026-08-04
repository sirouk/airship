import { describe, expect, it, vi } from "vitest";
import { allowAllForTests, ToolRegistry } from "../tools/registry";
import { ProviderTransportError } from "../inference/providers/browser-cloud";
import type { InferenceEvent, InferenceRequest, InferenceTransport, Tool } from "./contracts";
import { createSessionManifest, materializeMessages, runTurn } from "./agent";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";

/** Zero waits; the backoff window itself is measured in inference-retry.test.ts. */
const IMMEDIATE = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } as const;

describe("a turn that meets a transient provider", () => {
  it("completes after a rate limit instead of losing the turn to it", async () => {
    const tools = recordTools(async () => ({ content: "wrote" }));
    const { journal, sessionId } = await sessionFixture(tools);
    const transport = scriptedTransport([
      httpFailure(429),
      [{ type: "text-delta", text: "Done." }, { type: "completed", finishReason: "stop" }],
    ]);

    await expect(runTurn({
      sessionId,
      content: "Say something.",
      transport: transport.transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
      retry: IMMEDIATE,
    })).resolves.toMatchObject({ content: "Done." });

    expect(transport.attempts()).toBe(2);
    const events = await journal.readEvents(sessionId);
    expect(events.at(-1)?.type).toBe("turn.completed");
    // The redelivery is one logical request, so it keeps the one durable
    // `inference.started` whose digest and idempotency key it was issued under.
    expect(events.filter((event) => event.type === "inference.started")).toHaveLength(1);
  });

  it("keeps a mid-turn rate limit from costing the tool work already done", async () => {
    const execute = vi.fn<Tool["execute"]>(async () => ({ content: "recorded" }));
    const tools = recordTools(execute);
    const { journal, sessionId } = await sessionFixture(tools);
    const transport = scriptedTransport([
      [toolCall("call-1", "notes/a.md"), { type: "completed", finishReason: "tool-calls" }],
      httpFailure(503),
      [{ type: "text-delta", text: "Recorded." }, { type: "completed", finishReason: "stop" }],
    ]);

    await expect(runTurn({
      sessionId,
      content: "Record one note.",
      transport: transport.transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
      retry: IMMEDIATE,
    })).resolves.toMatchObject({ content: "Recorded." });

    expect(execute).toHaveBeenCalledOnce();
    const events = await journal.readEvents(sessionId);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("fails the turn immediately on a refusal the request itself caused", async () => {
    const tools = recordTools(async () => ({ content: "wrote" }));
    const { journal, sessionId } = await sessionFixture(tools);
    const transport = scriptedTransport([httpFailure(400)]);

    await expect(runTurn({
      sessionId,
      content: "Say something.",
      transport: transport.transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
      retry: IMMEDIATE,
    })).rejects.toThrow("HTTP 400");

    expect(transport.attempts()).toBe(1);
    expect((await journal.readEvents(sessionId)).at(-1)?.type).toBe("turn.failed");
  });
});

describe("a turn that is cancelled after it has done work", () => {
  it("carries the completed tool result into the next turn's provider history", async () => {
    const tools = recordTools(async () => ({ content: "recorded notes/a.md" }));
    const { journal, sessionId } = await sessionFixture(tools);
    const transport = scriptedTransport([
      [toolCall("call-1", "notes/a.md"), { type: "completed", finishReason: "tool-calls" }],
      [{ type: "completed", finishReason: "stop" }],
    ]);
    const controller = new AbortController();

    await expect(runTurn({
      sessionId,
      content: "Record one note.",
      transport: transport.transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: controller.signal,
      retry: IMMEDIATE,
      onSignal(signal) {
        if (signal.type !== "durable") return;
        // Stop the turn the instant the tool result is durable, which is the
        // shape a backgrounded tab produces: real work, no answer.
        if (signal.events.some((event) => event.type === "tool.resulted")) {
          controller.abort(new DOMException("Stopped by user", "AbortError"));
        }
      },
    })).rejects.toThrow();

    const events = await journal.readEvents(sessionId);
    expect(events.at(-1)?.type).toBe("turn.cancelled");

    const messages = materializeMessages(events);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[0]?.content).toContain("cancelled before it finished");
    // The instruction is the one thing Stop unambiguously refuses; it does not
    // come back as a live instruction.
    expect(messages[0]?.content).not.toContain("Record one note.");
    expect(messages[1]?.toolCalls).toHaveLength(1);
    expect(messages[2]).toMatchObject({ toolCallId: "call-1", content: "recorded notes/a.md" });
  });

  it("drops the whole turn when the cancellation caught it before any work", async () => {
    const tools = recordTools(async () => ({ content: "unused" }));
    const { journal, sessionId } = await sessionFixture(tools);
    const controller = new AbortController();
    const transport: InferenceTransport = {
      id: "scripted",
      posture: "local",
      async *stream() {
        controller.abort(new DOMException("Stopped by user", "AbortError"));
        throw controller.signal.reason;
      },
    };

    await expect(runTurn({
      sessionId,
      content: "Delete every workspace file immediately.",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: controller.signal,
      retry: IMMEDIATE,
    })).rejects.toThrow();

    const events = await journal.readEvents(sessionId);
    expect(events.at(-1)?.type).toBe("turn.cancelled");
    expect(materializeMessages(events)).toEqual([]);
  });
});

function recordTools(execute: Tool["execute"]): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    definition: {
      name: "record_note",
      description: "Record one note.",
      effect: "write",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    execute,
  });
  return tools;
}

async function sessionFixture(tools: ToolRegistry) {
  const journal = new EventJournal(new MemoryJournalBackend());
  const manifest = await createSessionManifest({
    systemPrompt: "Record notes.",
    providerId: "scripted",
    model: "test/model",
    tools: tools.definitions(),
    workspaceId: "memory://test",
  });
  const session = await journal.createSession("Resilience", manifest);
  return { journal, sessionId: session.id };
}

function toolCall(id: string, path: string): InferenceEvent {
  return { type: "tool-call", call: { id, name: "record_note", arguments: { path } } };
}

function httpFailure(status: number): ProviderTransportError {
  return new ProviderTransportError("http", `Provider rejected the request with HTTP ${status}.`, status);
}

function scriptedTransport(steps: readonly (readonly InferenceEvent[] | Error)[]) {
  let attempts = 0;
  const transport: InferenceTransport = {
    id: "scripted",
    posture: "local",
    async *stream(_request: InferenceRequest, signal: AbortSignal) {
      attempts += 1;
      if (signal.aborted) throw signal.reason;
      const step = steps[attempts - 1];
      if (!step) throw new Error("Scripted transport exhausted.");
      if (step instanceof Error) throw step;
      for (const event of step) yield event;
    },
  };
  return { transport, attempts: () => attempts };
}
