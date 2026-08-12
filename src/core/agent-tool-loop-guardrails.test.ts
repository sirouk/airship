import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, allowAllForTests } from "../tools/registry";
import { createSessionManifest, runTurn } from "./agent";
import type { InferenceEvent, InferenceRequest, InferenceTransport, JsonValue, Tool } from "./contracts";
import { EventJournal, type DurableEvent } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";

describe("tool-loop repeat guardrails", () => {
  it("warns in the model's own channel and stops the turn on the fifth identical failure", async () => {
    const execute = vi.fn<Tool["execute"]>(async () => {
      throw new Error("record store is offline");
    });
    const tools = registryWith(execute);
    const { journal, sessionId } = await sessionFixture(tools);

    await expect(runTurn({
      sessionId,
      content: "Read the record.",
      transport: repeatingTransport(8, () => ({ path: "notes/a.md" })),
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
      maxSteps: 32,
    })).rejects.toThrow("read_record failed 5 times in this turn with identical arguments");

    // The sixth step is never requested: the point of the stop is the steps it
    // does not spend.
    expect(execute).toHaveBeenCalledTimes(5);
    const events = await journal.readEvents(sessionId);
    const contents = toolContents(events, "tool.failed");
    expect(contents).toHaveLength(5);
    expect(contents[0]).toBe("record store is offline");
    expect(contents[1]).toContain("read_record has now failed 2 times");
    expect(contents[1]).toContain("Change the arguments, use a different tool");
    expect(contents[3]).toContain("has now failed 4 times");
    // The fifth failure carries no warning; it carries the stop.
    expect(contents[4]).toBe("record store is offline");
    expect(events.at(-1)?.type).toBe("turn.failed");
  });

  it("counts a result flagged isError, not only a thrown one", async () => {
    const tools = registryWith(async () => ({ content: "the path does not exist", isError: true }));
    const { journal, sessionId } = await sessionFixture(tools);

    await expect(runTurn({
      sessionId,
      content: "Read the record.",
      transport: repeatingTransport(8, () => ({ path: "notes/a.md" })),
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
      maxSteps: 32,
    })).rejects.toThrow("failed 5 times in this turn");

    const events = await journal.readEvents(sessionId);
    const contents = toolContents(events, "tool.resulted");
    expect(contents).toHaveLength(5);
    expect(contents[0]).toBe("the path does not exist");
    expect(contents[1]).toContain("Airship guardrail");
    expect(contents[1]?.startsWith("the path does not exist")).toBe(true);
  });

  it("counts a denial, because re-asking interrupts a person who already answered", async () => {
    const execute = vi.fn<Tool["execute"]>(async () => ({ content: "read" }));
    const tools = registryWith(execute);
    const { journal, sessionId } = await sessionFixture(tools);

    await expect(runTurn({
      sessionId,
      content: "Read the record.",
      transport: repeatingTransport(8, () => ({ path: "notes/a.md" })),
      tools,
      journal,
      approvalPolicy: { async review() { return "deny"; } },
      signal: new AbortController().signal,
      maxSteps: 32,
    })).rejects.toThrow("failed 5 times in this turn");

    expect(execute).not.toHaveBeenCalled();
    const events = await journal.readEvents(sessionId);
    const contents = toolContents(events, "tool.denied");
    expect(contents).toHaveLength(5);
    expect(contents[0]).toBe("Permission denied for read_record.");
    expect(contents[1]).toContain("Airship guardrail");
  });

  it("does not accumulate across different arguments, and leaves the journal verifiable", async () => {
    const tools = registryWith(async () => {
      throw new Error("record store is offline");
    });
    const { journal, sessionId } = await sessionFixture(tools);
    // Four failures, but only two of each call: the loop this guards against is
    // repetition, not failure.
    const paths = ["notes/a.md", "notes/b.md", "notes/a.md", "notes/b.md"];

    await expect(runTurn({
      sessionId,
      content: "Read both records.",
      transport: repeatingTransport(paths.length, (step) => ({ path: paths[step]! }), true),
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
      maxSteps: 32,
    })).resolves.toMatchObject({ content: "I could not read either record." });

    const events = await journal.readEvents(sessionId);
    const contents = toolContents(events, "tool.failed");
    expect(contents.filter((content) => content.includes("Airship guardrail"))).toHaveLength(2);
    expect(contents.every((content) => !content.includes("has now failed 3 times"))).toBe(true);
    const session = await journal.getSession(sessionId);
    const report = await auditSessionHistory({ session: session!, events });
    expect(report.findings).toEqual([]);
  });
});

describe("a call the registry refuses before it decides anything", () => {
  it("journals arguments that miss the schema as the decision it is, leaving the conversation auditable", async () => {
    // The review throws inside `validate` before producing any decision. It
    // used to be journaled as a bare tool.failed, which the audit reads as a
    // terminal without an approval — and one mistyped argument then marked the
    // whole conversation, and every later turn in it, permanently invalid.
    const execute = vi.fn<Tool["execute"]>(async () => ({ content: "read" }));
    const tools = registryWith(execute);
    const { journal, sessionId } = await sessionFixture(tools);

    await expect(runTurn({
      sessionId,
      content: "Read the record.",
      transport: repeatingTransport(1, () => ({ pat: "notes/a.md" }), true),
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ content: "I could not read either record." });

    expect(execute).not.toHaveBeenCalled();
    const events = await journal.readEvents(sessionId);
    const session = await journal.getSession(sessionId);
    const report = await auditSessionHistory({ session: session!, events });
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("verified");
    expect(events.some((event) => event.type === "tool.failed")).toBe(false);
    expect(toolContents(events, "tool.denied")).toEqual(["Tool arguments /path are required."]);
  });

  it("tells the model a hallucinated tool does not exist rather than that it was denied permission", async () => {
    const execute = vi.fn<Tool["execute"]>(async () => ({ content: "read" }));
    const tools = registryWith(execute);
    const { journal, sessionId } = await sessionFixture(tools);

    await expect(runTurn({
      sessionId,
      content: "Read the record.",
      transport: namedCallTransport("search_the_web", { query: "airship" }),
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ content: "There is no such tool." });

    expect(execute).not.toHaveBeenCalled();
    const events = await journal.readEvents(sessionId);
    // "Permission denied" invites the model to ask for access to a tool that
    // was never registered; the registry's own sentence for this fact does not.
    expect(toolContents(events, "tool.denied")).toEqual(["Unknown tool: search_the_web."]);

    const session = await journal.getSession(sessionId);
    const report = await auditSessionHistory({ session: session!, events });
    expect(report.findings).toEqual([]);
  });
});

/** One call to `name`, then a plain answer on the following step. */
function namedCallTransport(name: string, argumentsValue: JsonValue): InferenceTransport {
  let step = 0;
  return {
    id: "scripted",
    posture: "local",
    async *stream(_request: InferenceRequest, signal: AbortSignal) {
      if (signal.aborted) throw signal.reason;
      if (step++ === 0) {
        yield { type: "tool-call", call: { id: "call-0", name, arguments: argumentsValue } } satisfies InferenceEvent;
        yield { type: "completed", finishReason: "tool-calls" } satisfies InferenceEvent;
        return;
      }
      yield { type: "text-delta", text: "There is no such tool." } satisfies InferenceEvent;
      yield { type: "completed", finishReason: "stop" } satisfies InferenceEvent;
    },
  };
}

function toolContents(events: readonly DurableEvent[], type: string): string[] {
  return events
    .filter((event) => event.type === type)
    .map((event) => String((event.payload as Record<string, JsonValue>).content));
}

function registryWith(execute: Tool["execute"]): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    definition: {
      name: "read_record",
      description: "Read one record.",
      effect: "read",
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
    systemPrompt: "Stop repeating a call that does not work.",
    providerId: "scripted",
    model: "test/model",
    tools: tools.definitions(),
    workspaceId: "memory://guardrails",
  });
  const session = await journal.createSession("Guardrails", manifest);
  return { journal, sessionId: session.id };
}

/** Emits the same tool call `steps` times, then optionally a final answer. */
function repeatingTransport(
  steps: number,
  argumentsFor: (step: number) => JsonValue,
  finishAfter = false,
): InferenceTransport {
  let step = 0;
  return {
    id: "scripted",
    posture: "local",
    async *stream(_request: InferenceRequest, signal: AbortSignal) {
      if (signal.aborted) throw signal.reason;
      const current = step++;
      if (current >= steps) {
        if (!finishAfter) throw new Error("Scripted transport exhausted.");
        yield { type: "text-delta", text: "I could not read either record." } satisfies InferenceEvent;
        yield { type: "completed", finishReason: "stop" } satisfies InferenceEvent;
        return;
      }
      yield {
        type: "tool-call",
        call: { id: `call-${current}`, name: "read_record", arguments: argumentsFor(current) },
      } satisfies InferenceEvent;
      yield { type: "completed", finishReason: "tool-calls" } satisfies InferenceEvent;
    },
  };
}
