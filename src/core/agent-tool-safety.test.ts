import { describe, expect, it, vi } from "vitest";
import { allowAllForTests, ToolRegistry } from "../tools/registry";
import { ApprovalBroker } from "../approvals/broker";
import { createApprovalModePolicy } from "../approvals/modes";
import type {
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  Tool,
} from "./contracts";
import { createSessionManifest, runTurn } from "./agent";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";

describe("agent tool operation safety", () => {
  it("rejects an entire provider batch with duplicate tool-call IDs before any side effect", async () => {
    const execute = vi.fn<Tool["execute"]>(async () => ({ content: "wrote" }));
    const tools = writeTools(execute);
    const { journal, sessionId } = await sessionFixture(tools);
    const transport = scriptedTransport([
      [
        toolCall("duplicate", "first"),
        toolCall("duplicate", "second"),
        { type: "completed", finishReason: "tool-calls" },
      ],
    ]);

    await expect(runTurn({
      sessionId,
      content: "Write both records.",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow("duplicate or reused tool-call operation ID");

    expect(execute).not.toHaveBeenCalled();
    const events = await journal.readEvents(sessionId);
    expect(events.filter((event) => event.type === "tool.requested")).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("turn.failed");
  });

  it("rejects a provider operation ID reused from an earlier turn before a second review", async () => {
    const execute = vi.fn<Tool["execute"]>(async () => ({ content: "wrote" }));
    const review = vi.fn(async () => "allow" as const);
    const tools = writeTools(execute);
    const { journal, sessionId } = await sessionFixture(tools);
    const transport = scriptedTransport([
      [toolCall("shared-operation", "first"), { type: "completed", finishReason: "tool-calls" }],
      [{ type: "text-delta", text: "Done." }, { type: "completed", finishReason: "stop" }],
      [toolCall("shared-operation", "second"), { type: "completed", finishReason: "tool-calls" }],
    ]);

    await expect(runTurn({
      sessionId,
      content: "Write the first record.",
      transport,
      tools,
      journal,
      approvalPolicy: { review },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ content: "Done." });
    await expect(runTurn({
      sessionId,
      content: "Try the reused operation.",
      transport,
      tools,
      journal,
      approvalPolicy: { review },
      signal: new AbortController().signal,
    })).rejects.toThrow("duplicate or reused tool-call operation ID");

    expect(review).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    const events = await journal.readEvents(sessionId);
    expect(events.filter((event) => event.type === "tool.requested")).toHaveLength(1);
  });

  it("journals the exact approval mode and decision provenance with the tool decision", async () => {
    const tools = writeTools(async () => ({ content: "wrote" }));
    const { journal, sessionId } = await sessionFixture(tools);
    const transport = scriptedTransport([
      [toolCall("bounded-write", "notes/a.md"), { type: "completed", finishReason: "tool-calls" }],
      [{ type: "text-delta", text: "Done." }, { type: "completed", finishReason: "stop" }],
    ]);

    await runTurn({
      sessionId,
      content: "Write one record.",
      transport,
      tools,
      journal,
      approvalPolicy: createApprovalModePolicy({ mode: "full-access", broker: new ApprovalBroker() }),
      signal: new AbortController().signal,
    });

    const approved = (await journal.readEvents(sessionId)).find((event) => event.type === "tool.approved");
    expect(approved?.payload).toMatchObject({
      callId: "bounded-write",
      name: "write_record",
      approval: {
        mode: "full-access",
        source: "bounded-browser-sandbox",
      },
    });
  });

  it("terminates a runaway provider response at the core turn boundary", async () => {
    const tools = writeTools(async () => ({ content: "unused" }));
    const { journal, sessionId } = await sessionFixture(tools);
    const transport = scriptedTransport([[
      { type: "text-delta", text: "x".repeat(4 * 1024 * 1024 + 1) },
      { type: "completed", finishReason: "stop" },
    ]]);

    await expect(runTurn({
      sessionId,
      content: "Return a bounded response.",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow("4194304-byte turn limit");

    const events = await journal.readEvents(sessionId);
    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.some((event) => event.type === "assistant.completed")).toBe(false);
  });
});

function writeTools(execute: Tool["execute"]): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    definition: {
      name: "write_record",
      description: "Write one record.",
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
    systemPrompt: "Use tools safely.",
    providerId: "scripted",
    model: "test/model",
    tools: tools.definitions(),
    workspaceId: "memory://test",
  });
  const session = await journal.createSession("Safety", manifest);
  return { journal, sessionId: session.id };
}

function toolCall(id: string, path: string): InferenceEvent {
  return {
    type: "tool-call",
    call: { id, name: "write_record", arguments: { path } },
  };
}

function scriptedTransport(steps: readonly (readonly InferenceEvent[])[]): InferenceTransport {
  let next = 0;
  return {
    id: "scripted",
    posture: "local",
    async *stream(_request: InferenceRequest, signal: AbortSignal) {
      if (signal.aborted) throw signal.reason;
      const events = steps[next++];
      if (!events) throw new Error("Scripted transport exhausted.");
      for (const event of events) yield event;
    },
  };
}
