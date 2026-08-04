import { describe, expect, it } from "vitest";
import { ToolRegistry, allowAllForTests } from "../tools/registry";
import { createSessionManifest, runTurn } from "./agent";
import type {
  ApprovalPolicy,
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  JsonValue,
  Tool,
} from "./contracts";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";

describe("parallel dispatch of read-effect tools", () => {
  it("overlaps a consecutive run of reads while keeping every review serial and ordered", async () => {
    const log: string[] = [];
    const tools = instrumentedTools(log, { "a.md": 30, "b.md": 20, "c.md": 10 });
    const { journal, sessionId } = await sessionFixture(tools);
    const policy: ApprovalPolicy = {
      async review(tool) {
        log.push(`review:${tool.name}`);
        return "allow";
      },
      takeProvenance: allowAllForTests.takeProvenance!,
    };

    await runTurn({
      sessionId,
      content: "Read all three.",
      transport: batchTransport([
        ["read_item", "a.md"],
        ["read_item", "b.md"],
        ["read_item", "c.md"],
      ]),
      tools,
      journal,
      approvalPolicy: policy,
      signal: new AbortController().signal,
    });

    // Every review lands before any execution: a person is asked the same
    // questions in the same order they would have been asked serially.
    expect(log.slice(0, 3)).toEqual(["review:read_item", "review:read_item", "review:read_item"]);
    /*
     * All three are in flight at once: every start lands before any end.
     * Serially this would read start/end/start/end/start/end, so this is the
     * assertion that actually distinguishes overlapped dispatch from sequential
     * dispatch.
     *
     * It deliberately does NOT pin the order within the starts. `executeApproved`
     * awaits a SHA-256 of the arguments against the approval ticket
     * (`tools/registry.ts:159`) before it calls `execute`, and WebCrypto's digest
     * is not a plain microtask — three of them issued back to back can resolve in
     * any order once the machine is busy. This test asserted `a, b, c` and failed
     * as `a, c, b` under `vitest --maxWorkers=4`, while passing 6/6 in isolation.
     *
     * That reordering is not a defect and pinning it would be asserting a promise
     * the product does not make: the batch exists precisely because every call in
     * it declares `effect: "read"`, so none can observe another's outcome and the
     * order they enter in cannot be load-bearing. What IS promised is that the
     * journal reads in call order regardless — which is asserted below, and is
     * the guarantee a reader of the transcript depends on.
     */
    const starts = log.slice(3).filter((entry) => entry.startsWith("start:"));
    const ends = log.slice(3).filter((entry) => entry.startsWith("end:"));
    expect(new Set(starts)).toEqual(new Set(["start:a.md", "start:b.md", "start:c.md"]));
    expect(new Set(ends)).toEqual(new Set(["end:a.md", "end:b.md", "end:c.md"]));
    expect(log.slice(3, 6).every((entry) => entry.startsWith("start:"))).toBe(true);
    expect(log.slice(6).every((entry) => entry.startsWith("end:"))).toBe(true);

    // ...and the journal still reads in call order, not completion order.
    const events = await journal.readEvents(sessionId);
    expect(
      events.filter((event) => event.type === "tool.resulted")
        .map((event) => String((event.payload as Record<string, JsonValue>).content)),
    ).toEqual(["read a.md", "read b.md", "read c.md"]);

    const session = await journal.getSession(sessionId);
    const report = await auditSessionHistory({ session: session!, events });
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("verified");
  });

  it("treats any non-read call as a barrier the surrounding reads cannot cross", async () => {
    const log: string[] = [];
    const tools = instrumentedTools(log, { "a.md": 20, "b.md": 5, "w.md": 5, "c.md": 5 });
    const { journal, sessionId } = await sessionFixture(tools);

    await runTurn({
      sessionId,
      content: "Read, write, read.",
      transport: batchTransport([
        ["read_item", "a.md"],
        ["read_item", "b.md"],
        ["write_item", "w.md"],
        ["read_item", "c.md"],
      ]),
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    /*
     * The leading reads overlap; the write waits for both, and the trailing
     * read waits for the write. A writer never runs beside anything.
     *
     * Stated as positions rather than as one literal sequence for the reason
     * given in the first test: the order *within* the overlapping pair is not a
     * promise the product makes, because `executeApproved` awaits a WebCrypto
     * digest before `execute` and two of those can resolve either way round on
     * a busy machine. The barrier, which is the actual subject here, is exact.
     */
    const at = (entry: string) => log.indexOf(entry);
    expect(log).toHaveLength(8);
    // a and b overlap: both have started before either has finished.
    expect(Math.max(at("start:a.md"), at("start:b.md")))
      .toBeLessThan(Math.min(at("end:a.md"), at("end:b.md")));
    // The write is a barrier on both sides, and runs alone.
    expect(at("start:w.md")).toBeGreaterThan(Math.max(at("end:a.md"), at("end:b.md")));
    expect(at("end:w.md")).toBe(at("start:w.md") + 1);
    expect(at("start:c.md")).toBeGreaterThan(at("end:w.md"));
    expect(at("end:c.md")).toBe(at("start:c.md") + 1);

    const events = await journal.readEvents(sessionId);
    const session = await journal.getSession(sessionId);
    const report = await auditSessionHistory({ session: session!, events });
    expect(report.findings).toEqual([]);
  });

  it("keeps the results that landed when one call in the batch throws", async () => {
    const log: string[] = [];
    const tools = instrumentedTools(log, { "a.md": 5, "c.md": 5 }, "b.md");
    const { journal, sessionId } = await sessionFixture(tools);

    await runTurn({
      sessionId,
      content: "Read all three.",
      transport: batchTransport([
        ["read_item", "a.md"],
        ["read_item", "b.md"],
        ["read_item", "c.md"],
      ]),
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    const events = await journal.readEvents(sessionId);
    // `allSettled`, not `all`: one rejection must not discard the two results
    // that already landed, and each call still answers its own tool message.
    expect(
      events
        .filter((event) => ["tool.resulted", "tool.failed"].includes(event.type))
        .map((event) => `${event.type}:${String((event.payload as Record<string, JsonValue>).content)}`),
    ).toEqual(["tool.resulted:read a.md", "tool.failed:b.md is unreadable", "tool.resulted:read c.md"]);

    const session = await journal.getSession(sessionId);
    const report = await auditSessionHistory({ session: session!, events });
    expect(report.findings).toEqual([]);
  });
});

function instrumentedTools(
  log: string[],
  delays: Readonly<Record<string, number>>,
  failing?: string,
): ToolRegistry {
  const tools = new ToolRegistry();
  const execute: Tool["execute"] = async (argumentsValue) => {
    const path = String((argumentsValue as Record<string, JsonValue>).path);
    if (path === failing) throw new Error(`${path} is unreadable`);
    log.push(`start:${path}`);
    await new Promise((resolve) => setTimeout(resolve, delays[path] ?? 0));
    log.push(`end:${path}`);
    return { content: `read ${path}` };
  };
  for (const [name, effect] of [["read_item", "read"], ["write_item", "write"]] as const) {
    tools.register({
      definition: {
        name,
        description: `${effect} one item.`,
        effect,
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      execute,
    });
  }
  return tools;
}

async function sessionFixture(tools: ToolRegistry) {
  const journal = new EventJournal(new MemoryJournalBackend());
  const manifest = await createSessionManifest({
    systemPrompt: "Read what you need.",
    providerId: "scripted",
    model: "test/model",
    tools: tools.definitions(),
    workspaceId: "memory://parallel",
  });
  const session = await journal.createSession("Parallel", manifest);
  return { journal, sessionId: session.id };
}

/** One step emitting the whole batch, then a final answer. */
function batchTransport(calls: readonly (readonly [string, string])[]): InferenceTransport {
  let step = 0;
  return {
    id: "scripted",
    posture: "local",
    async *stream(_request: InferenceRequest, signal: AbortSignal) {
      if (signal.aborted) throw signal.reason;
      if (step++ > 0) {
        yield { type: "text-delta", text: "Done." } satisfies InferenceEvent;
        yield { type: "completed", finishReason: "stop" } satisfies InferenceEvent;
        return;
      }
      for (const [index, [name, path]] of calls.entries()) {
        yield {
          type: "tool-call",
          call: { id: `call-${index}`, name, arguments: { path } },
        } satisfies InferenceEvent;
      }
      yield { type: "completed", finishReason: "tool-calls" } satisfies InferenceEvent;
    },
  };
}
