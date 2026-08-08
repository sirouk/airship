import { afterEach, describe, expect, it } from "vitest";
import { IndexedDbJournalBackend } from "./indexeddb-journal";
import { JournalConflictError, type DurableEvent, type SessionRecord } from "./journal";
import { createSessionManifest } from "./session-manifest";

/*
 * The IndexedDB backend is the one JournalBackend with no page wiring, so its
 * failure paths have never run anywhere. They are exactly the paths that abort
 * a transaction — an ordinary two-tab append conflict, an append of nothing —
 * and an abort nobody is awaiting is a rejected promise the browser reports as
 * an uncaught error for a code path that behaved as designed. The fake below is
 * the smallest IndexedDB that can reach them: enough of open/transaction/store
 * for `createSession` and `append`, with the same timing property that makes
 * the bug possible — the transaction's terminal event lands a task after the
 * call that aborted it has already returned.
 */

describe("IndexedDbJournalBackend", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    delete (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange;
  });

  it("commits an append and carries the head forward", async () => {
    installFakeIndexedDb();
    const backend = new IndexedDbJournalBackend("airship-journal-test");
    const session = await storedSession();
    await backend.createSession(session);

    const updated = await backend.append(
      session.id,
      { sequence: 0, digest: "genesis" },
      [durableEvent(session.id, 1, "genesis")],
    );

    expect(updated.headSequence).toBe(1);
    expect(updated.headDigest).toBe("sha256:event-1");
    expect(await backend.readEvents(session.id, 0)).toHaveLength(1);
    expect((await backend.getSession(session.id))?.headDigest).toBe("sha256:event-1");
  });

  it("leaves no unclaimed rejection behind when an early exit aborts the transaction", async () => {
    installFakeIndexedDb();
    const backend = new IndexedDbJournalBackend("airship-journal-test");
    const session = await storedSession();
    await backend.createSession(session);
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", capture);

    try {
      // The documented "append nothing" case, and the ordinary conflict a
      // second tab loses. Both abort, and both are handled by their caller.
      expect(await backend.append(session.id, { sequence: 0, digest: "genesis" }, []))
        .toMatchObject({ headSequence: 0 });
      await expect(backend.append(
        session.id,
        { sequence: 7, digest: "sha256:someone-else" },
        [durableEvent(session.id, 8, "sha256:someone-else")],
      )).rejects.toBeInstanceOf(JournalConflictError);
      // Node reports an unhandled rejection only once the turn that created it
      // has fully drained, and the abort event itself is a task away.
      for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", capture);
    }

    expect(unhandled).toEqual([]);
  });
});

async function storedSession(): Promise<SessionRecord> {
  return {
    id: "session-1",
    title: "Journal",
    manifest: await createSessionManifest({
      systemPrompt: "indexeddb backend",
      providerId: "scripted",
      model: "test/model",
      tools: [],
      workspaceId: "memory://indexeddb",
    }),
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    headSequence: 0,
    headDigest: "genesis",
  };
}

function durableEvent(sessionId: string, sequence: number, previousDigest: string): DurableEvent {
  return {
    version: 1,
    eventId: `event-${String(sequence)}`,
    sessionId,
    sequence,
    recordedAt: "2020-01-01T00:00:01.000Z",
    previousDigest,
    digest: `sha256:event-${String(sequence)}`,
    type: "turn.requested",
    turnId: "turn-1",
    payload: { content: "hello" },
  };
}

type FakeBound = Readonly<{ lower: [string, number]; upper: [string, number] }>;

function installFakeIndexedDb(): void {
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = new FakeIndexedDb() as unknown as IDBFactory;
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = {
    bound: (lower: [string, number], upper: [string, number]): FakeBound => ({ lower, upper }),
  };
}

class FakeRequest<T> extends EventTarget {
  result: T | undefined;
  error: Error | null = null;

  constructor(compute: () => T) {
    super();
    queueMicrotask(() => {
      try {
        this.result = compute();
        this.dispatchEvent(new Event("success"));
      } catch (cause) {
        this.error = cause as Error;
        this.dispatchEvent(new Event("error"));
      }
    });
  }
}

class FakeIndexedDb {
  private readonly databases = new Map<string, FakeDatabase>();

  open(name: string): FakeRequest<FakeDatabase> {
    const existing = this.databases.get(name);
    const database = existing ?? new FakeDatabase();
    this.databases.set(name, database);
    const request = new FakeRequest(() => database);
    if (!existing) {
      queueMicrotask(() => {
        request.result = database;
        request.dispatchEvent(new Event("upgradeneeded"));
      });
    }
    return request;
  }
}

class FakeDatabase {
  readonly stores = new Map<string, Map<string, Record<string, unknown>>>();
  readonly keyPaths = new Map<string, string>();
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };

  createObjectStore(name: string, options: { keyPath: string }) {
    this.stores.set(name, new Map());
    this.keyPaths.set(name, options.keyPath);
    return { createIndex: () => undefined };
  }

  transaction(_names: string | string[], _mode: string): FakeTransaction {
    return new FakeTransaction(this);
  }

  close(): void {}
}

class FakeTransaction extends EventTarget {
  readonly error: Error | null = null;
  private settled = false;

  constructor(private readonly database: FakeDatabase) {
    super();
    // A real transaction commits once control returns to the event loop with
    // no request outstanding; a task is close enough for this backend's shape.
    setTimeout(() => this.settle("complete"), 0);
  }

  objectStore(name: string): FakeObjectStore {
    return new FakeObjectStore(this.database, name);
  }

  abort(): void {
    this.settle("abort");
  }

  private settle(type: "complete" | "abort"): void {
    if (this.settled) return;
    this.settled = true;
    // Deliberately a task later: the caller that aborted has already returned
    // or thrown by the time this lands, which is the whole shape of the bug.
    setTimeout(() => this.dispatchEvent(new Event(type)), 0);
  }
}

class FakeObjectStore {
  constructor(private readonly database: FakeDatabase, private readonly name: string) {}

  get(key: string): FakeRequest<Record<string, unknown> | undefined> {
    return new FakeRequest(() => this.rows().get(key));
  }

  getAll(): FakeRequest<Record<string, unknown>[]> {
    return new FakeRequest(() => [...this.rows().values()]);
  }

  add(value: Record<string, unknown>): void {
    this.rows().set(String(value[this.keyPath()]), value);
  }

  put(value: Record<string, unknown>): void {
    this.rows().set(String(value[this.keyPath()]), value);
  }

  index(_name: string) {
    return {
      getAll: (range: FakeBound): FakeRequest<Record<string, unknown>[]> =>
        new FakeRequest(() => [...this.rows().values()]
          .filter((row) =>
            row.sessionId === range.lower[0] &&
            Number(row.sequence) >= range.lower[1] &&
            Number(row.sequence) <= range.upper[1])
          .sort((left, right) => Number(left.sequence) - Number(right.sequence))),
    };
  }

  private rows(): Map<string, Record<string, unknown>> {
    const rows = this.database.stores.get(this.name);
    if (!rows) throw new Error(`Unknown object store: ${this.name}`);
    return rows;
  }

  private keyPath(): string {
    return this.database.keyPaths.get(this.name) ?? "id";
  }
}
