import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createSessionManifest } from "../core/agent";
import { TERMINAL_ACTIVITY_EVENT_TYPE, type SessionManifest, type ToolDefinition } from "../core/contracts";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { auditSessionHistory } from "../core/session-audit";
import { MemoryWorkspace } from "../workspace/memory";
import { subscribeTerminalAuditRecords, terminalActivityEvent } from "./audit-sink";
import { BrowserTerminalManager } from "./manager";
import type { FileSystemTree, WebContainer } from "@webcontainer/api";

/*
 * TRM-06 / PRF-07: shell work in the journal Proof actually audits.
 *
 * `BrowserTerminalManager` kept a complete, bounded lineage of every command,
 * process epoch and reconciliation — inside a 64-record ring buffer, read by
 * one `<summary>` popover, and by nothing else. So a `jsh` command that
 * rewrote the workspace produced no journal event at all: the product's one
 * timeline (intent → effect → workspace head → receipt) was true of the tool
 * path and simply absent for the shell.
 *
 * These assertions cover the whole seam rather than either end of it, because
 * either end alone is what the previous attempt shipped: a publisher nobody
 * subscribes to, or an event type the audit calls unknown — which would have
 * made *recording* shell work degrade the completeness of the journal it was
 * recorded in.
 */
const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read one workspace file",
  effect: "read",
  inputSchema: { type: "object" },
};

describe("terminal lineage in the session journal", () => {
  it("journals start, input and reconciliation against the terminal's own thread, and the audit accepts them", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/README.md", "mounted\n", { expectedRevision: null });
    const journal = new EventJournal(new MemoryJournalBackend());
    const conversation = await journal.createSession("Shell work", await manifest());

    const { manager, host } = await liveManager(workspace);
    const unsubscribe = installSink(journal);
    try {
      const tab = manager.create({ threadId: conversation.id, cwd: "/workspace", name: "Build" });
      await manager.start(tab.id);
      await manager.write(tab.id, "npm test\r");
      // A file written straight into the mount is a change only reconciliation
      // can see, which is what makes the reconcile record's `changedPaths`
      // meaningful rather than an empty array.
      host.writeMounted("changed.txt", "from the shell\n");
      await manager.syncWorkspace(tab.id);
      await settle();

      const events = await journal.readEvents(conversation.id);
      const terminalEvents = events.filter((event) => event.type === TERMINAL_ACTIVITY_EVENT_TYPE);
      const payloads = terminalEvents.map((event) => event.payload as Record<string, unknown>);
      expect(payloads.map((payload) => payload.kind)).toEqual([
        "process-start",
        "interactive-input",
        "workspace-reconcile",
      ]);
      // The binding an auditor traverses: which terminal, which page-unique
      // writer, which process epoch.
      for (const payload of payloads) {
        expect(payload).toMatchObject({
          version: 1,
          terminalSessionId: tab.id,
          processEpoch: 1,
          origin: "conversation",
        });
        expect(typeof payload.writerId).toBe("string");
        expect(payload.sequence).toBeGreaterThan(0);
      }
      expect(payloads[1]).toMatchObject({ command: "npm test", outcome: "submitted" });
      expect(payloads[2]?.changedPaths).toEqual(["/workspace/changed.txt"]);
      // A shell command is not a turn step; a terminal record wearing a turn
      // identity would make this session's turn accounting describe work no
      // model did.
      for (const event of terminalEvents) {
        expect(event.turnId).toBeUndefined();
        expect(event.operationId).toBeUndefined();
      }
      // The retained PTY tail has passed no redaction and the journal is the
      // artifact that gets exported.
      expect(JSON.stringify(payloads)).not.toContain("outputTail");

      const report = await auditSessionHistory({
        session: (await journal.getSession(conversation.id))!,
        events,
      });
      expect(report.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
      expect(report.status).toBe("verified");
      expect(report.counts.unknownEvents).toBe(0);
      // Counted under its own name so Proof can state it. Folding shell work
      // into `events` would have left a reader unable to tell a session where
      // no shell ran from one whose shell work was never recorded.
      expect(report.counts.shellRecords).toBe(3);
    } finally {
      unsubscribe();
      await manager.quiesce("test cleanup");
    }
  });

  it("writes nothing when the terminal has no conversation and nothing when no sink is installed", async () => {
    const workspace = new MemoryWorkspace();
    const journal = new EventJournal(new MemoryJournalBackend());
    const conversation = await journal.createSession("Untouched", await manifest());
    const before = (await journal.readEvents(conversation.id)).length;

    const { manager } = await liveManager(workspace);
    try {
      // No subscriber at all: the manager must behave exactly as it did before
      // the seam existed.
      const orphan = manager.create({ cwd: "/workspace", name: "Terminal route" });
      await manager.start(orphan.id);
      await settle();
      expect((await journal.readEvents(conversation.id)).length).toBe(before);

      // Subscribed, but the terminal names no thread. Borrowing the reader's
      // current conversation would put one terminal's commands in another
      // conversation's proof, which is worse than the gap it would close.
      const unsubscribe = installSink(journal);
      try {
        await manager.write(orphan.id, "whoami\r");
        await settle();
        expect((await journal.readEvents(conversation.id)).length).toBe(before);
        expect(manager.list().find(({ id }) => id === orphan.id)?.audit
          .some((record) => record.kind === "interactive-input")).toBe(true);
      } finally {
        unsubscribe();
      }
    } finally {
      await manager.quiesce("test cleanup");
    }
  });

  it("refuses a replayed record and a payload carrying retained process output", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const conversation = await journal.createSession("Malformed lineage", await manifest());
    const base = {
      version: 1,
      terminalSessionId: "terminal-1",
      recordId: "terminal-1:writer-1:1",
      sequence: 1,
      kind: "interactive-input",
      outcome: "submitted",
      recordedAt: "2026-07-29T10:00:00.000Z",
      processEpoch: 1,
      origin: "conversation",
      cwd: "/workspace",
      summary: "Captured a line submitted to the interactive jsh PTY.",
      writerId: "writer-1",
      command: "npm test",
    } as const;
    await journal.append(conversation.id, [
      { type: TERMINAL_ACTIVITY_EVENT_TYPE, payload: { ...base } },
      { type: TERMINAL_ACTIVITY_EVENT_TYPE, payload: { ...base } },
      { type: TERMINAL_ACTIVITY_EVENT_TYPE, payload: { ...base, sequence: 2, recordId: "terminal-1:writer-1:2", outputTail: "$ npm test\r\nsecret\r\n" } },
      // A turn identity on a shell record is not a smaller version of the same
      // event; it is a claim about a turn that never happened.
      { type: TERMINAL_ACTIVITY_EVENT_TYPE, turnId: "turn-1", payload: { ...base, sequence: 3, recordId: "terminal-1:writer-1:3" } },
    ]);

    const report = await auditSessionHistory({
      session: (await journal.getSession(conversation.id))!,
      events: await journal.readEvents(conversation.id),
    });
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "TERMINAL_RECORD_DUPLICATE",
      "TERMINAL_RECORD_INVALID",
      "TERMINAL_RECORD_INVALID",
    ]);
    expect(report.counts.unknownEvents).toBe(0);
  });

  /*
   * The shell is the only place that can bind the journal, and it must do it
   * with the terminal's own thread. Read as source because the subscription is
   * installed by a Preact effect in a 9,000-line component that no unit test
   * mounts; what is checkable here is that the wiring exists and reads the
   * field it must read.
   */
  it("is installed by the shell against the terminal's own thread id", async () => {
    const app = await readFile(new URL("../ui/app.tsx", import.meta.url), "utf8");
    expect(app).toContain('import { subscribeTerminalAuditRecords, terminalActivityEvent } from "../terminal/audit-sink";');
    expect(app).toContain("useEffect(() => subscribeTerminalAuditRecords((record, terminalSession) => {");
    expect(app).toContain("const threadId = terminalSession.threadId;");
    expect(app).toContain("if (!threadId || !active) return;");
    expect(app).toContain("terminalAuditTail.current = terminalAuditTail.current");
    // And the count reaches the one surface that claims to audit this journal.
    const proof = await readFile(new URL("../ui/proof-view.tsx", import.meta.url), "utf8");
    expect(proof).toContain("<dt>Shell records</dt><dd>{audit.counts.shellRecords}</dd>");
  });
});

async function manifest(): Promise<SessionManifest> {
  return createSessionManifest({
    systemPrompt: "Keep the session exact.",
    providerId: "demo",
    model: "model-a",
    tools: [readTool],
    workspaceId: "memory://terminal-lineage",
    capabilityTier: "web-baseline",
    now: "2026-07-29T09:00:00.000Z",
  });
}

/** The exact subscription `app.tsx` installs, minus its status reporting. */
function installSink(journal: EventJournal): () => void {
  let tail: Promise<unknown> = Promise.resolve();
  return subscribeTerminalAuditRecords((record, terminalSession) => {
    const threadId = terminalSession.threadId;
    if (!threadId) return;
    const draft = terminalActivityEvent(record, terminalSession);
    tail = tail.then(() => journal.append(threadId, [{ type: draft.type, payload: draft.payload }]));
    pending.push(tail);
  });
}

const pending: Promise<unknown>[] = [];

/** Lets the chained appends the sink queued reach the journal. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.allSettled([...pending]);
    await Promise.resolve();
  }
}

/**
 * A manager over a fake WebContainer whose process stays alive, so input and
 * reconciliation are reachable rather than racing an immediate exit.
 */
async function liveManager(workspace: MemoryWorkspace): Promise<Readonly<{
  manager: BrowserTerminalManager;
  host: Readonly<{ writeMounted(path: string, content: string): void }>;
}>> {
  let mounted: FileSystemTree = {};
  const process = {
    exit: new Promise<number>(() => undefined),
    input: new WritableStream<string>(),
    output: new ReadableStream<string>({ start(controller) { controller.enqueue("Airship jsh ready\r\n"); } }),
    kill() { /* The exit promise intentionally never settles in this fixture. */ },
    resize() { /* Dimensions are not under test here. */ },
  };
  const container = {
    fs: {
      async mkdir() { return undefined; },
      async rm() { mounted = {}; },
    },
    async mount(tree: FileSystemTree) { mounted = structuredClone(tree); },
    async export() { return structuredClone(mounted); },
    async spawn() { return process; },
  } as unknown as WebContainer;
  const manager = new BrowserTerminalManager(workspace, { activateHost: async () => container });
  await manager.ready;
  return Object.freeze({
    manager,
    host: Object.freeze({
      writeMounted(path: string, content: string) {
        (mounted as Record<string, unknown>)[path] = { file: { contents: content } };
      },
    }),
  });
}

// The fixture above keeps a process alive for the whole file; real timers are
// what the persistence debounce runs on and nothing here asserts on them.
vi.useRealTimers();
