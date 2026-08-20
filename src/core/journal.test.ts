import { describe, expect, it } from "vitest";
import { createSessionManifest } from "./agent";
import { EventJournal, JournalConflictError, type EventDraft, type JournalBackend } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";

/*
 * A local rename can append `session.renamed` while a turn is still streaming
 * events into the same session. Both writers live in one
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

  it("does not rebase a fenced append onto a head that changed after audit", async () => {
    const { journal, session } = await seed();
    const audited = (await journal.getSession(session.id))!;
    await journal.append(session.id, [{
      type: "message.user",
      payload: { content: "landed after the audit" },
    }]);

    await expect(journal.appendAtHead(
      session.id,
      { sequence: audited.headSequence, digest: audited.headDigest },
      [{ type: "profile.active-conversation.selected", payload: { generation: 1 } }],
    )).rejects.toBeInstanceOf(JournalConflictError);

    expect((await journal.readEvents(session.id)).map((event) => event.type))
      .toEqual(["session.created", "message.user"]);
  });

  it.each(["append", "appendAtHead"] as const)(
    "reads caller draft accessors exactly once for %s",
    async (method) => {
      const { journal, session } = await seed();
      const reads = { type: 0, turnId: 0, operationId: 0, payload: 0 };
      const draft = Object.defineProperties({} as EventDraft, {
        type: {
          enumerable: true,
          get: () => (++reads.type === 1 ? "message.user" : "message.assistant"),
        },
        turnId: {
          enumerable: true,
          get: () => (++reads.turnId === 1 ? "turn-safe" : "turn-mutated"),
        },
        operationId: {
          enumerable: true,
          get: () => (++reads.operationId === 1 ? "operation-safe" : "operation-mutated"),
        },
        payload: {
          enumerable: true,
          get: () => (++reads.payload === 1
            ? { nested: { content: "safe" } }
            : { nested: { content: "mutated" } }),
        },
      });

      const event = method === "append"
        ? (await journal.append(session.id, [draft]))[0]!
        : (await journal.appendAtHead(
          session.id,
          (() => {
            const head = session;
            return { sequence: head.headSequence, digest: head.headDigest };
          })(),
          [draft],
        )).events[0]!;

      expect(reads).toEqual({ type: 1, turnId: 1, operationId: 1, payload: 1 });
      expect(event).toMatchObject({
        type: "message.user",
        turnId: "turn-safe",
        operationId: "operation-safe",
        payload: { nested: { content: "safe" } },
      });
    },
  );

  it.each(["append", "appendAtHead"] as const)(
    "owns nested caller payloads when %s returns its promise",
    async (method) => {
      const { journal, session } = await seed();
      const payload = { nested: { content: "before" } };
      const draft: EventDraft = { type: "message.user", payload };
      const head = (await journal.getSession(session.id))!;
      const pending = method === "append"
        ? journal.append(session.id, [draft]).then((events) => events[0]!)
        : journal.appendAtHead(
          session.id,
          { sequence: head.headSequence, digest: head.headDigest },
          [draft],
        ).then((commit) => commit.events[0]!);

      payload.nested.content = "after";

      await expect(pending).resolves.toMatchObject({
        type: "message.user",
        payload: { nested: { content: "before" } },
      });
    },
  );

  it("owns the manifest before a stalled create backend can retain caller mutation", async () => {
    const inner = new MemoryJournalBackend();
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const backend: JournalBackend = {
      async createSession(record) {
        markEntered();
        await gate;
        return inner.createSession(record);
      },
      getSession: (sessionId) => inner.getSession(sessionId),
      listSessions: () => inner.listSessions(),
      readEvents: (sessionId, afterSequence) => inner.readEvents(sessionId, afterSequence),
      append: (sessionId, expectedHead, events) => inner.append(sessionId, expectedHead, events),
      deleteSession: (sessionId, expectedHead) => inner.deleteSession(sessionId, expectedHead),
    };
    const journal = new EventJournal(backend);
    const manifest = await createSessionManifest({
      systemPrompt: "test",
      providerId: "local",
      model: "safe-model",
      tools: [{
        name: "lookup",
        description: "Lookup",
        effect: "read",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      }],
      workspaceId: "workspace",
    });

    const creating = journal.createSession("Snapshot", manifest);
    await entered;
    manifest.model = "mutated-model";
    const inputSchema = manifest.tools[0]!.inputSchema as {
      properties: { query: { type: string } };
    };
    inputSchema.properties.query.type = "number";
    release();

    const created = await creating;
    const record = (await journal.getSession(created.id))!;
    const createdEvent = (await journal.readEvents(created.id))[0]!;
    const createdManifest = (createdEvent.payload as unknown as { manifest: typeof manifest }).manifest;
    expect(record.manifest.model).toBe("safe-model");
    expect(createdManifest.model).toBe("safe-model");
    expect((record.manifest.tools[0]!.inputSchema as typeof inputSchema).properties.query.type).toBe("string");
    expect((createdManifest.tools[0]!.inputSchema as typeof inputSchema).properties.query.type).toBe("string");
  });

  it("snapshots delete head accessors before the backend queue turn", async () => {
    const { journal, session } = await seed();
    const head = (await journal.getSession(session.id))!;
    let sequence = head.headSequence;
    let digest = head.headDigest;
    let sequenceReads = 0;
    let digestReads = 0;
    const expectedHead = Object.defineProperties({} as { sequence: number; digest: string }, {
      sequence: { enumerable: true, get: () => { sequenceReads += 1; return sequence; } },
      digest: { enumerable: true, get: () => { digestReads += 1; return digest; } },
    });

    const deletion = journal.deleteSession(session.id, expectedHead);
    sequence = 0;
    digest = "genesis";

    await expect(deletion).resolves.toBeUndefined();
    expect({ sequenceReads, digestReads }).toEqual({ sequenceReads: 1, digestReads: 1 });
    expect(await journal.getSession(session.id)).toBeUndefined();
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
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let stallNextAppend = false;
    const backend: JournalBackend = {
      createSession: (session) => inner.createSession(session),
      getSession: (sessionId) => inner.getSession(sessionId),
      listSessions: () => inner.listSessions(),
      readEvents: (sessionId, afterSequence) => inner.readEvents(sessionId, afterSequence),
      deleteSession: (sessionId, expectedHead) => inner.deleteSession(sessionId, expectedHead),
      async append(sessionId, expectedHead, events) {
        if (stallNextAppend) {
          stallNextAppend = false;
          markEntered();
          await gate;
        }
        return inner.append(sessionId, expectedHead, events);
      },
    };
    return { backend, entered, release: () => release(), stall: () => { stallNextAppend = true; } };
  }

  it("keeps a later append tracked when a stale same-journal delete settles", async () => {
    const { backend, entered, release, stall } = stalling();
    const journal = new EventJournal(backend);
    const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
    const session = await journal.createSession("Delete tail", manifest);
    const staleHead = { sequence: session.headSequence, digest: session.headDigest };
    await journal.append(session.id, [{ type: "message.user", payload: { content: "made delete stale" } }]);
    stall();

    const deletion = journal.deleteSession(session.id, staleHead);
    const first = journal.append(session.id, [
      { type: "message.user", payload: { content: "first after delete" } },
    ]);
    await expect(deletion).rejects.toBeInstanceOf(JournalConflictError);
    await entered;

    // This writer arrives after the delete's `finally`, while the append that
    // chained behind that delete is still held inside the backend CAS.
    const second = journal.append(session.id, [
      { type: "message.user", payload: { content: "second after delete" } },
    ]);
    release();

    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await journal.readEvents(session.id)).map((event) => (
      event.payload as { content?: string }
    ).content)).toEqual([
      undefined,
      "made delete stale",
      "first after delete",
      "second after delete",
    ]);
  });

  it("owns a queued append payload before waiting for its predecessor", async () => {
    const { backend, entered, release, stall } = stalling();
    const journal = new EventJournal(backend);
    const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
    const session = await journal.createSession("Queued snapshot", manifest);
    stall();
    const blocked = journal.append(session.id, [
      { type: "message.user", payload: { content: "blocked" } },
    ]);
    await entered;
    const payload = { nested: { content: "before" } };
    const queued = journal.append(session.id, [{ type: "message.user", payload }]);

    payload.nested.content = "after";
    release();

    await blocked;
    await expect(queued).resolves.toMatchObject([
      { payload: { nested: { content: "before" } } },
    ]);
  });

  it("snapshots a fenced head and draft before a conflicting delete queue wait", async () => {
    const inner = new MemoryJournalBackend();
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const backend: JournalBackend = {
      createSession: (session) => inner.createSession(session),
      getSession: (sessionId) => inner.getSession(sessionId),
      listSessions: () => inner.listSessions(),
      readEvents: (sessionId, afterSequence) => inner.readEvents(sessionId, afterSequence),
      append: (sessionId, expectedHead, events) => inner.append(sessionId, expectedHead, events),
      async deleteSession(sessionId, expectedHead) {
        markEntered();
        await gate;
        return inner.deleteSession(sessionId, expectedHead);
      },
    };
    const journal = new EventJournal(backend);
    const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
    const session = await journal.createSession("Fenced snapshot", manifest);
    const audited = (await journal.getSession(session.id))!;
    const deletion = journal.deleteSession(session.id, { sequence: 0, digest: "genesis" });
    await entered;

    let sequence = audited.headSequence;
    let digest = audited.headDigest;
    let sequenceReads = 0;
    let digestReads = 0;
    const expectedHead = Object.defineProperties({} as { sequence: number; digest: string }, {
      sequence: { enumerable: true, get: () => { sequenceReads += 1; return sequence; } },
      digest: { enumerable: true, get: () => { digestReads += 1; return digest; } },
    });
    const payload = { nested: { content: "before" } };
    const fenced = journal.appendAtHead(
      session.id,
      expectedHead,
      [{ type: "message.user", payload }],
    );
    sequence = 999;
    digest = "mutated";
    payload.nested.content = "after";
    release();

    await expect(deletion).rejects.toBeInstanceOf(JournalConflictError);
    await expect(fenced).resolves.toMatchObject({
      events: [{ payload: { nested: { content: "before" } } }],
    });
    expect({ sequenceReads, digestReads }).toEqual({ sequenceReads: 1, digestReads: 1 });
  });

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

  it("cancels a fenced append before it reaches durable admission", async () => {
    const { backend, release, stall } = stalling();
    const journal = new EventJournal(backend);
    const manifest = await createSessionManifest({ systemPrompt: "test", providerId: "local", model: "demo", tools: [], workspaceId: "workspace" });
    const session = await journal.createSession("Stalled fence", manifest);
    const audited = (await journal.getSession(session.id))!;
    stall();
    const blocked = journal.append(session.id, [{
      type: "message.user",
      payload: { content: "in flight" },
    }]);
    const controller = new AbortController();
    const fenced = journal.appendAtHead(
      session.id,
      { sequence: audited.headSequence, digest: audited.headDigest },
      [{ type: "profile.active-conversation.selected", payload: { generation: 1 } }],
      controller.signal,
    );

    controller.abort(new DOMException("Stopped before selection", "AbortError"));
    await expect(fenced).rejects.toMatchObject({ name: "AbortError" });

    release();
    await blocked;
    expect((await journal.readEvents(session.id)).map((event) => event.type))
      .toEqual(["session.created", "message.user"]);
  });
});
