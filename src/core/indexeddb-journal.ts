import {
  JournalConflictError,
  projectedSessionApprovalMode,
  projectedSessionContextPolicy,
  projectedSessionModel,
  projectedSessionTitle,
  type DurableEvent,
  type JournalBackend,
  type SessionRecord,
} from "./journal";

const DATABASE_NAME = "airship-journal-v1";
const DATABASE_VERSION = 1;
const SESSIONS = "sessions";
const EVENTS = "events";

type StoredEvent = DurableEvent & { key: string };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
      once: true,
    });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), {
      once: true,
    });
  });
  /*
   * Every deliberate `transaction.abort()` below returns or throws without
   * touching this promise, and the abort event then fires a task later, on a
   * promise nobody is holding — so the browser reports an ordinary CAS conflict
   * or a delete of an absent session as `Uncaught (in promise) AbortError`.
   * Claiming the rejection here rather than at each call site also covers the
   * read paths, and costs the commit path nothing: awaiting an already-rejected
   * promise still throws at the `await done` that cares.
   */
  void done.catch(() => undefined);
  return done;
}

export class IndexedDbJournalBackend implements JournalBackend {
  private databasePromise?: Promise<IDBDatabase>;

  constructor(private readonly databaseName = DATABASE_NAME) {}

  async createSession(session: SessionRecord): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(SESSIONS, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(SESSIONS).add(session);
    await done;
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const database = await this.database();
    const transaction = database.transaction(SESSIONS, "readonly");
    const done = transactionDone(transaction);
    const result = await requestResult(transaction.objectStore(SESSIONS).get(sessionId));
    await done;
    return result as SessionRecord | undefined;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const database = await this.database();
    const transaction = database.transaction(SESSIONS, "readonly");
    const done = transactionDone(transaction);
    const result = (await requestResult(transaction.objectStore(SESSIONS).getAll())) as SessionRecord[];
    await done;
    return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readEvents(sessionId: string, afterSequence = 0): Promise<DurableEvent[]> {
    const database = await this.database();
    const transaction = database.transaction(EVENTS, "readonly");
    const done = transactionDone(transaction);
    const index = transaction.objectStore(EVENTS).index("by-session-sequence");
    const range = IDBKeyRange.bound([sessionId, afterSequence + 1], [sessionId, Number.MAX_SAFE_INTEGER]);
    const result = (await requestResult(index.getAll(range))) as StoredEvent[];
    await done;
    return result.map(({ key: _key, ...event }) => event);
  }

  async deleteSession(sessionId: string, expectedHead: { sequence: number; digest: string }): Promise<void> {
    const database = await this.database();
    // One transaction over both stores: a record removed without its events, or
    // events removed without their record, is a corruption this browser would
    // then carry forever. IndexedDB gives atomicity across stores for free as
    // long as both are named here.
    const transaction = database.transaction([SESSIONS, EVENTS], "readwrite");
    const done = transactionDone(transaction);
    const sessions = transaction.objectStore(SESSIONS);
    const stored = (await requestResult(sessions.get(sessionId))) as SessionRecord | undefined;
    if (!stored) {
      transaction.abort();
      return;
    }
    if (stored.headSequence !== expectedHead.sequence || stored.headDigest !== expectedHead.digest) {
      transaction.abort();
      throw new JournalConflictError("The conversation changed since it was read; it was not deleted.");
    }
    // Cursor over the compound index rather than `getAll` then delete-by-key:
    // the events carry a separate primary key, and reading every event of a
    // long conversation into memory to delete it is the one shape that gets
    // slower the more there is to remove.
    const index = transaction.objectStore(EVENTS).index("by-session-sequence");
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = index.openCursor(range);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
    sessions.delete(sessionId);
    await done;
  }

  async append(
    sessionId: string,
    expectedHead: { sequence: number; digest: string },
    events: DurableEvent[],
  ): Promise<SessionRecord> {
    const database = await this.database();
    const transaction = database.transaction([SESSIONS, EVENTS], "readwrite");
    const done = transactionDone(transaction);
    const sessions = transaction.objectStore(SESSIONS);
    const stored = (await requestResult(sessions.get(sessionId))) as SessionRecord | undefined;
    if (!stored) {
      transaction.abort();
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (stored.headSequence !== expectedHead.sequence || stored.headDigest !== expectedHead.digest) {
      transaction.abort();
      throw new JournalConflictError();
    }
    if (!events.length) {
      transaction.abort();
      return stored;
    }

    const first = events[0];
    const last = events.at(-1)!;
    if (first.sequence !== stored.headSequence + 1 || first.previousDigest !== stored.headDigest) {
      transaction.abort();
      throw new JournalConflictError("The append does not extend the current digest chain.");
    }

    const eventStore = transaction.objectStore(EVENTS);
    for (const event of events) {
      eventStore.add({ ...event, key: `${sessionId}:${String(event.sequence).padStart(16, "0")}` });
    }
    const updated: SessionRecord = {
      ...stored,
      title: projectedSessionTitle(events, stored.title),
      ...(projectedSessionApprovalMode(events, stored.approvalModeOverride) !== undefined
        ? { approvalModeOverride: projectedSessionApprovalMode(events, stored.approvalModeOverride) }
        : {}),
      ...(projectedSessionModel(events, stored.modelOverride) !== undefined
        ? { modelOverride: projectedSessionModel(events, stored.modelOverride) }
        : {}),
      ...(projectedSessionContextPolicy(events, stored.contextPolicyOverride) !== undefined
        ? { contextPolicyOverride: projectedSessionContextPolicy(events, stored.contextPolicyOverride) }
        : {}),
      updatedAt: last.recordedAt,
      headSequence: last.sequence,
      headDigest: last.digest,
    };
    sessions.put(updated);
    await done;
    return updated;
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = undefined;
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, DATABASE_VERSION);
      request.addEventListener(
        "upgradeneeded",
        () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(SESSIONS)) {
            database.createObjectStore(SESSIONS, { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains(EVENTS)) {
            const events = database.createObjectStore(EVENTS, { keyPath: "key" });
            events.createIndex("by-session-sequence", ["sessionId", "sequence"], { unique: true });
          }
        },
        { once: true },
      );
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("Unable to open IndexedDB")), {
        once: true,
      });
    });
    return this.databasePromise;
  }
}

