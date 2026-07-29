import { describe, expect, it } from "vitest";
import { createSessionManifest } from "./agent";
import { EventJournal, JournalConflictError, type JournalBackend } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";

/*
 * Model auto-naming appends `session.renamed` while the turn that provoked it
 * is still streaming events into the same session. Both writers live in one
 * page, and an append is a read-head / hash / compare-and-set sequence, so
 * before the per-session queue the second CAS lost and the *turn* failed with a
 * conflict the user had no way to understand or avoid.
 */
describe("EventJournal concurrent in-page writers", () => {
  async function seed(title = "Before") {
    const journal = new EventJournal(new MemoryJournalBackend());
    const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
    const session = await journal.createSession(title, manifest);
    return { journal, session };
  }

  it("settles an append raced against a rename without refusing either", async () => {
    const { journal, session } = await seed();
    const headBefore = (await journal.getSession(session.id))!.headSequence;

    const results = await Promise.allSettled([
      journal.append(session.id, [{ type: "message.user", payload: { content: "streaming turn" } }]),
      journal.renameSession(session.id, "t"),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await journal.getSession(session.id))!.headSequence).toBe(headBefore + 2);
    const events = await journal.readEvents(session.id);
    expect(events.map((event) => event.type)).toContain("session.renamed");
    // The hash chain has to stay linked: a queued append must read the head the
    // writer ahead of it wrote, not the head both of them started from.
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.previousDigest).toBe(events[index - 1]!.digest);
    }
  });

  it("keeps the renamed title once the raced append has landed", async () => {
    const { journal, session } = await seed();

    await Promise.all([
      journal.append(session.id, [{ type: "message.user", payload: { content: "streaming turn" } }]),
      journal.renameSession(session.id, "t"),
    ]);

    expect((await journal.getSession(session.id))!.title).toBe("t");
  });

  it("does not let a refused append cascade into the writers queued behind it", async () => {
    const { journal, session } = await seed();

    const results = await Promise.allSettled([
      journal.append("missing-session", [{ type: "message.user", payload: {} }]),
      journal.append(session.id, [{ type: "message.user", payload: { content: "unaffected" } }]),
      journal.append(session.id, [{ type: "message.user", payload: { content: "also unaffected" } }]),
    ]);

    expect(results[0]!.status).toBe("rejected");
    expect(results[1]!.status).toBe("fulfilled");
    expect(results[2]!.status).toBe("fulfilled");
    expect((await journal.readEvents(session.id))).toHaveLength(3);
  });

  it("still refuses a second journal instance racing the same backend", async () => {
    const backend = new MemoryJournalBackend();
    const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
    const left = new EventJournal(backend);
    const right = new EventJournal(backend);
    const session = await left.createSession("Race", manifest);

    const results = await Promise.allSettled([
      left.append(session.id, [{ type: "message.user", payload: { writer: "left" } }]),
      right.append(session.id, [{ type: "message.user", payload: { writer: "right" } }]),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(JournalConflictError);
  });
});

/*
 * Serialising appends couples their latency: a queued writer now waits on the
 * one ahead of it. That is the ordering guarantee and cannot be timed out away,
 * but it must not turn a slow backend into a Stop the user cannot get. A queued
 * caller's own signal still ends its wait, and the writer behind it still waits
 * for the real in-flight commit rather than being released early onto a stale
 * head.
 */
describe("EventJournal append queue under a stalled backend", () => {
  function stalling() {
    const inner = new MemoryJournalBackend();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let stallNextAppend = false;
    const backend: JournalBackend = {
      createSession: (session) => inner.createSession(session),
      getSession: (sessionId) => inner.getSession(sessionId),
      listSessions: () => inner.listSessions(),
      readEvents: (sessionId, afterSequence) => inner.readEvents(sessionId, afterSequence),
      async append(sessionId, expectedHead, events) {
        if (stallNextAppend) {
          stallNextAppend = false;
          await gate;
        }
        return inner.append(sessionId, expectedHead, events);
      },
    };
    return { backend, release: () => release(), stall: () => { stallNextAppend = true; } };
  }

  it("lets a queued append honour its own abort instead of waiting out the stall", async () => {
    const { backend, release, stall } = stalling();
    const journal = new EventJournal(backend);
    const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
    const session = await journal.createSession("Stalled", manifest);
    stall();
    const blocked = journal.append(session.id, [{ type: "message.user", payload: { content: "in flight" } }]);
    const controller = new AbortController();
    const queued = journal.append(session.id, [{ type: "message.user", payload: { content: "queued" } }], controller.signal);

    controller.abort(new DOMException("Stopped by user", "AbortError"));

    // Resolves while the append ahead of it is still inside the backend.
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    // Queued *before* the stall lifts: leaving the queue early must not release
    // this writer onto the head the stalled append has not written yet.
    const after = journal.append(session.id, [{ type: "message.user", payload: { content: "after" } }]);
    release();
    await blocked;
    await after;
    const events = await journal.readEvents(session.id);
    expect(events.map((event) => (event.payload as { content?: string }).content))
      .toEqual([undefined, "in flight", "after"]);
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.previousDigest).toBe(events[index - 1]!.digest);
    }
  });
});
