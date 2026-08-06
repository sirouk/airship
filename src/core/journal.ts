import type { ApprovalProvenance, JsonValue, SessionManifest } from "./contracts";
import { sha256, stableStringify } from "./hash";
import { randomUuid } from "./id";

export type EventDraft = {
  type: string;
  turnId?: string;
  operationId?: string;
  payload: JsonValue;
};

export type DurableEvent = EventDraft & {
  version: 1;
  eventId: string;
  sessionId: string;
  sequence: number;
  recordedAt: string;
  previousDigest: string;
  digest: string;
};

export type SessionRecord = {
  id: string;
  title: string;
  manifest: SessionManifest;
  createdAt: string;
  updatedAt: string;
  headSequence: number;
  headDigest: string;
  /**
   * The conversation's own approval policy, carried beside the pinned manifest
   * like title is. The manifest names the policy the conversation was created
   * under; this is what the person asked for in-flight, on the same thread,
   * and the very next call is governed by it. Read it with the projection in
   * this file — it is never written anywhere but a session event.
   */
  approvalModeOverride?: ApprovalProvenance["mode"];
};

export type JournalAppendCommit = Readonly<{
  events: DurableEvent[];
  session: SessionRecord;
}>;

export interface JournalBackend {
  createSession(session: SessionRecord, signal?: AbortSignal): Promise<void>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<SessionRecord | undefined>;
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>;
  readEvents(sessionId: string, afterSequence?: number, signal?: AbortSignal): Promise<DurableEvent[]>;
  append(
    sessionId: string,
    expectedHead: { sequence: number; digest: string },
    events: DurableEvent[],
    /**
     * Cancellation is admissible only before the backend enters its atomic
     * compare-and-set. Once that boundary is crossed, an implementation must
     * return the committed result (or the storage failure) instead of
     * relabelling a durable write as an abort.
     */
    signal?: AbortSignal,
  ): Promise<SessionRecord>;
  /**
   * Remove a conversation and its events. Absent for a very long time.
   *
   * The storage contract had no delete verb at any of its three layers, while
   * `docs/PRODUCT_SPEC.md` sells "Export, migrate, delete, or self-host all
   * state without vendor lock-in" and `sessions/library.ts` already shipped the
   * error string "That conversation was removed while it was being read." for a
   * state nothing could produce. For a product whose pitch is that your data
   * stays yours, a person who pasted a password or a client's name into a
   * conversation had exactly one remedy: destroy the entire Vault.
   *
   * Fenced on the head the caller last saw, like every other mutation here. A
   * turn that landed between the confirmation and the delete means the person
   * is discarding something they have not read, so the delete is refused with
   * `JournalConflictError` and they are asked again — the same rule `append`
   * applies for the same reason.
   *
   * Deleting an absent session resolves. Removal is the goal, and a caller who
   * finds it already gone got what they asked for.
   */
  deleteSession(
    sessionId: string,
    expectedHead: { sequence: number; digest: string },
    signal?: AbortSignal,
  ): Promise<void>;
}

export class JournalConflictError extends Error {
  constructor(message = "The session head changed while appending events.") {
    super(message);
    this.name = "JournalConflictError";
  }
}

export class EventJournal {
  /*
   * One append at a time per session, per journal instance.
   *
   * An append is a read-head / hash / compare-and-set sequence with awaits
   * inside it, so two writers in the same page interleave: both read the same
   * head and whichever CAS lands second is refused with a
   * `JournalConflictError`. Refusing the loser is *correct* between clients —
   * it is how a stale tab is stopped from forking a history — but inside one
   * page both writers are ours, and the refusal surfaced to the user as a
   * failed turn when model auto-naming appended `session.renamed` beside the
   * turn still streaming into the same session.
   *
   * Chaining makes the second in-page writer wait for the first head instead
   * of racing it. It deliberately does not touch cross-instance concurrency:
   * two `EventJournal`s over one backend hold separate chains and still settle
   * through the backend's compare-and-set, so a stale writer is still refused.
   *
   * The cost is deliberate and worth naming: an append's latency is now coupled
   * to the one before it on the same session, so a backend that answers slowly
   * holds up everything queued behind it. That coupling *is* the ordering
   * guarantee and cannot be timed out away — a queued writer that gave up
   * waiting and committed anyway would read the same stale head the queue
   * exists to prevent. The one escape is the caller's own signal: see
   * `commitAfter`.
   */
  private readonly appendQueue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly backend: JournalBackend,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = randomUuid,
  ) {}

  async createSession(
    title: string,
    manifest: SessionManifest,
    initialize?: (
      session: Readonly<SessionRecord>,
    ) => readonly EventDraft[] | Promise<readonly EventDraft[]>,
  ): Promise<SessionRecord> {
    const createdAt = this.now();
    const session: SessionRecord = {
      id: this.id(),
      title,
      manifest,
      createdAt,
      updatedAt: createdAt,
      headSequence: 0,
      headDigest: "genesis",
    };
    // Resolve destination-bound initial records before the first backend
    // mutation, then commit creation and initialization in one append batch.
    const initialized = initialize ? [...await initialize(structuredClone(session))] : [];
    if (initialized.some((event) => event.type === "session.created")) {
      throw new TypeError("Session initialization cannot provide a second creation event.");
    }
    await this.backend.createSession(session);
    await this.append(session.id, [
      {
        type: "session.created",
        payload: {
          title,
          manifest: manifest as unknown as JsonValue,
        },
      },
      ...initialized,
    ]);
    return (await this.backend.getSession(session.id)) ?? session;
  }

  getSession(sessionId: string, signal?: AbortSignal) {
    return this.backend.getSession(sessionId, signal);
  }

  /**
   * Remove a conversation, fenced to the head the caller last read.
   *
   * The in-page append lock is taken for the same reason `append` takes it: a
   * turn in flight for this session is a writer that has already read the head
   * this delete is about to invalidate, and letting the two interleave is how
   * a session gets removed out from under an append that then resurrects part
   * of it. Queuing behind the lock makes the two orderable rather than racy.
   */
  async deleteSession(
    sessionId: string,
    expectedHead: { sequence: number; digest: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const previous = this.appendQueue.get(sessionId) ?? Promise.resolve();
    const link = previous
      .catch(() => undefined)
      .then(() => this.backend.deleteSession(sessionId, expectedHead, signal));
    this.appendQueue.set(sessionId, link.catch(() => undefined));
    try {
      await link;
    } finally {
      // The session is gone; its queue slot would otherwise outlive it.
      if (this.appendQueue.get(sessionId) !== undefined) this.appendQueue.delete(sessionId);
    }
  }

  listSessions(signal?: AbortSignal) {
    return this.backend.listSessions(signal);
  }

  readEvents(sessionId: string, afterSequence = 0, signal?: AbortSignal) {
    return this.backend.readEvents(sessionId, afterSequence, signal);
  }

  async renameSession(sessionId: string, title: string, signal?: AbortSignal): Promise<SessionRecord> {
    const normalized = title.trim();
    if (!normalized || normalized.length > 240 || /[\u0000-\u001F\u007F]/u.test(normalized)) throw new TypeError("Session title must be between 1 and 240 printable characters.");
    await this.append(sessionId, [{ type: "session.renamed", payload: { title: normalized } }], signal);
    const session = await this.backend.getSession(sessionId, signal);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  /**
   * Change this conversation's approval policy in flight, on the same thread.
   *
   * Title set the precedent this belongs beside: durable journal facts that
   * are not the pinned manifest. The manifest still carries the approval
   * policy the conversation was created under; this event supersedes it from
   * its sequence onward for THIS conversation, and the very next call is
   * governed by it after the shell refreshes the record. It deliberately is
   * not two neighbors it resembles:
   * (a) the running turn's page-memory controller swap, which is the same
   * decision before the journal catches up; and
   * (b) the Profile's approval default — a preference for future
   * conversations, which this event deliberately does not touch.
   */
  async setSessionApprovalMode(sessionId: string, mode: ApprovalProvenance["mode"], signal?: AbortSignal): Promise<SessionRecord> {
    if (!["ask-first", "auto-approve", "full-access"].includes(mode)) {
      throw new TypeError("Session approval policy must be ask-first, auto-approve, or full-access.");
    }
    await this.append(
      sessionId,
      [{ type: "session.approval-policy-changed", payload: { approvalMode: mode } }],
      signal,
    );
    const session = await this.backend.getSession(sessionId, signal);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  append(sessionId: string, drafts: EventDraft[], signal?: AbortSignal): Promise<DurableEvent[]> {
    if (!drafts.length) return Promise.resolve([]);
    const pending = this.appendQueue.get(sessionId);
    const result = pending
      ? this.commitAfter(pending, sessionId, drafts, signal)
      : this.commit(sessionId, drafts, signal);
    return this.trackAppend(sessionId, pending, result);
  }

  /**
   * Append only while the durable journal still has the exact head the caller
   * audited. Unlike `append`, this never rereads and rebases onto a newer head:
   * the supplied head is both the new events' chain boundary and the backend
   * compare-and-set precondition.
   *
   * Cancellation is checked after queueing and event sealing, then remains live
   * through the backend's remote reads and immutable-segment preparation. The
   * backend owns the exact compare-and-set boundary: after crossing it, the
   * successful commit is returned without a second abort check that could turn
   * a durable write into an ambiguous failure.
   */
  appendAtHead(
    sessionId: string,
    expectedHead: Readonly<{ sequence: number; digest: string }>,
    drafts: EventDraft[],
    signal?: AbortSignal,
  ): Promise<JournalAppendCommit> {
    if (!drafts.length) {
      return Promise.reject(new TypeError("A fenced append requires at least one event."));
    }
    const pending = this.appendQueue.get(sessionId);
    const result = pending
      ? this.commitAtHeadAfter(pending, sessionId, expectedHead, drafts, signal)
      : this.commitAtHead(sessionId, expectedHead, drafts, signal, signal);
    return this.trackAppend(sessionId, pending, result);
  }

  private trackAppend<Result>(
    sessionId: string,
    pending: Promise<unknown> | undefined,
    result: Promise<Result>,
  ): Promise<Result> {
    // The link waits for the predecessor *and then* this append, and swallows
    // failure on both: one refused append must not cascade into everything
    // queued behind it, and a caller that walks away on its own signal must not
    // release the next writer while the predecessor is still mid-commit — that
    // would hand the next writer the very stale head this queue prevents. The
    // link clears itself only while it is still the tail, so a later writer's
    // link is never dropped.
    const link = (pending ?? Promise.resolve()).then(() => result).then(() => undefined, () => undefined);
    this.appendQueue.set(sessionId, link);
    void link.then(() => {
      if (this.appendQueue.get(sessionId) === link) this.appendQueue.delete(sessionId);
    });
    return result;
  }

  /**
   * Wait for this session's previous append before reading the head — but no
   * longer than the caller is still asking for the write.
   *
   * Queuing couples an append's latency to the one ahead of it, so without this
   * a backend that never answers would swallow a Stop the user already pressed:
   * the turn's abort would sit behind a write it can no longer influence. The
   * caller's signal therefore wins the race and rejects with its own reason.
   * Nothing is committed when it does, and `append`'s link still holds the next
   * writer behind the real in-flight commit, so leaving the queue early can
   * never reorder the hash chain.
   */
  private async commitAfter(
    pending: Promise<unknown>,
    sessionId: string,
    drafts: EventDraft[],
    signal?: AbortSignal,
  ): Promise<DurableEvent[]> {
    await (signal ? raceAbort(pending, signal) : pending);
    return this.commit(sessionId, drafts, signal);
  }

  private async commitAtHeadAfter(
    pending: Promise<unknown>,
    sessionId: string,
    expectedHead: Readonly<{ sequence: number; digest: string }>,
    drafts: EventDraft[],
    signal?: AbortSignal,
  ): Promise<JournalAppendCommit> {
    await (signal ? raceAbort(pending, signal) : pending);
    return this.commitAtHead(sessionId, expectedHead, drafts, signal, signal);
  }

  private async commit(sessionId: string, drafts: EventDraft[], signal?: AbortSignal): Promise<DurableEvent[]> {
    signal?.throwIfAborted();
    const session = await this.backend.getSession(sessionId, signal);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);

    return (await this.commitAtHead(
      sessionId,
      { sequence: session.headSequence, digest: session.headDigest },
      drafts,
      undefined,
      signal,
    )).events;
  }

  private async commitAtHead(
    sessionId: string,
    expectedHead: Readonly<{ sequence: number; digest: string }>,
    drafts: EventDraft[],
    preAdmissionSignal?: AbortSignal,
    backendSignal?: AbortSignal,
  ): Promise<JournalAppendCommit> {
    preAdmissionSignal?.throwIfAborted();

    let sequence = expectedHead.sequence;
    let previousDigest = expectedHead.digest;
    const events: DurableEvent[] = [];

    for (const draft of drafts) {
      sequence += 1;
      const eventId = this.id();
      const recordedAt = this.now();
      const digestInput: JsonValue = {
        version: 1,
        eventId,
        sessionId,
        sequence,
        recordedAt,
        previousDigest,
        type: draft.type,
        turnId: draft.turnId ?? null,
        operationId: draft.operationId ?? null,
        payload: draft.payload,
      };
      const digest = await sha256(stableStringify(digestInput));
      events.push({
        ...draft,
        version: 1,
        eventId,
        sessionId,
        sequence,
        recordedAt,
        previousDigest,
        digest,
      });
      previousDigest = digest;
    }

    preAdmissionSignal?.throwIfAborted();
    const session = await this.backend.append(
      sessionId,
      expectedHead,
      events,
      backendSignal,
    );
    return { events, session };
  }
}

/**
 * Settle when `pending` settles, or reject early with the signal's own reason.
 *
 * The abort listener is removed whichever side wins. One signal covers a whole
 * turn and a turn appends many events, so leaving a listener per append behind
 * would pile up a closure per write on a signal that outlives all of them.
 */
function raceAbort(pending: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([pending, aborted]).then(
    () => { signal.removeEventListener("abort", onAbort); },
    (error: unknown) => { signal.removeEventListener("abort", onAbort); throw error; },
  );
}

/**
 * The title a session record carries after an append, given the events in it.
 *
 * `renameSession` only appends `session.renamed`; it never writes the record's
 * title directly. Projecting that event into the record is therefore the
 * backend's job, and it is the *whole* meaning of a rename — a backend that
 * skips it stores a session whose title disagrees with its own history, which
 * the audit reports as `SESSION_TITLE_SNAPSHOT_MISMATCH` and which makes the
 * session refuse to resume.
 *
 * It lives here, once, because it was previously copied into two backends and
 * absent from the third: renames were durable in page memory and on IndexedDB,
 * and silently lost by the encrypted object journal, so adopting a Vault threw
 * away the title and stranded the conversation behind it on the next reload.
 */
export function projectedSessionTitle(events: readonly DurableEvent[], fallback: string): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      event.type === "session.renamed"
      && event.payload
      && !Array.isArray(event.payload)
      && typeof event.payload === "object"
      && typeof event.payload.title === "string"
    ) return event.payload.title;
  }
  return fallback;
}

/**
 * The conversation's durable, same-thread approval policy, projected from the
 * last `session.approval-policy-changed` event. The manifest pin is the
 * conversation's birth certificate for this preferance — this override is the
 * durable, conflict-free way to change it in flight without forking the
 * thread, and every backend's head CAS applies it beside `title` for exactly
 * the reason title lives here: a lost projection was what previously stranded
 * these decisions as page-memory-only.
 */
export function projectedSessionApprovalMode(
  events: readonly DurableEvent[],
  fallback: ApprovalProvenance["mode"] | undefined,
): ApprovalProvenance["mode"] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      event.type === "session.approval-policy-changed"
      && event.payload
      && !Array.isArray(event.payload)
      && typeof event.payload === "object"
      && ["ask-first", "auto-approve", "full-access"].includes(String(event.payload.approvalMode))
    ) return event.payload.approvalMode as ApprovalProvenance["mode"];
  }
  return fallback;
}
