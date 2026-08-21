import type { ApprovalProvenance, JsonValue, SessionContextPolicy, SessionManifest } from "./contracts";
import { canonicalSessionContextPolicy } from "./context-policy";
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
   * Opaque storage incarnation fence. It is authority metadata, not portable
   * conversation content, and must be carried back on fenced mutations.
   */
  headIncarnation?: string;
  /**
   * When this device took the conversation in from a bundle file.
   *
   * Set by the import, never by the file: `REFUSED_BUNDLE_PINS` in
   * `src/sessions/work-bundle.ts` rejects a bundle that states it, so a file
   * can neither claim to be native nor forge a date. It is what separates a
   * conversation this browser composed from one whose whole manifest —
   * including the `systemPrompt` sent to the provider on every turn — was
   * written somewhere else. Such a conversation is readable in full and
   * continues by Fork, which is the same rule a Vault adoption already states.
   */
  importedAt?: string;
  /**
   * The conversation's own approval policy, carried beside the pinned manifest
   * like title is. The manifest names the policy the conversation was created
   * under; this is what the person asked for in-flight, on the same thread,
   * and the very next call is governed by it. Read it with the projection in
   * this file — it is never written anywhere but a session event.
   */
  approvalModeOverride?: ApprovalProvenance["mode"];
  /**
   * The conversation's own model selection, carried beside the pinned manifest
   * exactly like the approval policy is. The manifest names the model the
   * thread was created under; this is what the person asked for in-flight on
   * the same thread, and the next turn is routed to it. Never written anywhere
   * but a `session.model-changed` event.
   */
  modelOverride?: string;
  /**
   * The compressed-context policy the person asked the new model to carry,
   * projected beside the model selection that provoked it. Compression must
   * know the window it writes to, and that window changes with the model —
   * pinning only the model leaves the summarizer working for the old one.
   */
  contextPolicyOverride?: SessionContextPolicy | null;
};

export type JournalHead = Readonly<{
  sequence: number;
  digest: string;
  /**
   * Optional for legacy/non-reusable backends. A backend that can restore an
   * exact deleted ID must return and require an opaque incarnation fence so a
   * repeated sequence/digest cannot become an ABA mutation capability.
   */
  incarnation?: string;
}>;

export type JournalAppendCommit = Readonly<{
  events: DurableEvent[];
  session: SessionRecord;
}>;

/**
 * How an append relates to the record it lands on.
 *
 * `replay` says these events are a copy of a history that was already
 * projected somewhere else, so the record they land under is the one
 * `createSession` received rather than one re-derived from the events. It
 * exists because a device-granted pin is projected out of a session event
 * (`projectedSessionPins`), and replaying a history therefore *re-grants*
 * every pin in it. That is right for a Vault move, where the record copied in
 * already carries those pins verbatim, and wrong for a bundle file, whose
 * record may carry none of them: measured, a file whose record declared no
 * pins landed a conversation in `full-access` with a model override, because
 * `session.approval-policy-changed` and `session.model-changed` rode in as
 * events and the projection believed them. A file is not authority, so a
 * replay projects the conversation's own facts — its title and its recency —
 * and grants nothing.
 */
export type JournalAppendOptions = Readonly<{ replay?: boolean }>;

export interface JournalBackend {
  createSession(session: SessionRecord, signal?: AbortSignal): Promise<void>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<SessionRecord | undefined>;
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>;
  readEvents(sessionId: string, afterSequence?: number, signal?: AbortSignal): Promise<DurableEvent[]>;
  append(
    sessionId: string,
    expectedHead: JournalHead,
    events: DurableEvent[],
    /**
     * Cancellation is admissible only before the backend enters its atomic
     * compare-and-set. Once that boundary is crossed, an implementation must
     * return the committed result (or the storage failure) instead of
     * relabelling a durable write as an abort.
     */
    signal?: AbortSignal,
    options?: JournalAppendOptions,
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
    expectedHead: JournalHead,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * The read side of a journal, as a migration needs it.
 *
 * `migrateJournalState` only ever reads three things from its source, and
 * typing the parameter as the whole `EventJournal` class made that class the
 * only possible source — its private fields make it nominal. A bundle read
 * from a file is a legitimate source of exactly these three reads and of
 * nothing else, so the contract is named for what it is. Types only: nothing
 * is added to any chunk.
 */
export type JournalStateSource = Pick<EventJournal, "listSessions" | "readEvents" | "getSession">;

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
   * failed turn when an in-page rename appended `session.renamed` beside a
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
    // Own the caller's manifest before the first await. The backend record and
    // `session.created` must describe one snapshot even if the caller mutates
    // its manifest while creation is in flight.
    const manifestSnapshot = structuredClone(manifest);
    const createdAt = this.now();
    const session: SessionRecord = {
      id: this.id(),
      title,
      manifest: manifestSnapshot,
      createdAt,
      updatedAt: createdAt,
      headSequence: 0,
      headDigest: "genesis",
    };
    // Resolve destination-bound initial records before the first backend
    // mutation, then commit creation and initialization in one append batch.
    const initialized = initialize
      ? snapshotEventDrafts(await initialize(structuredClone(session)))
      : [];
    if (initialized.some((event) => event.type === "session.created")) {
      throw new TypeError("Session initialization cannot provide a second creation event.");
    }
    // A backend is an asynchronous port. Give it its own copy so it cannot
    // mutate the journal-owned manifest later used by session.created.
    await this.backend.createSession(structuredClone(session));
    await this.append(session.id, [
      {
        type: "session.created",
        payload: {
          title,
          manifest: manifestSnapshot as unknown as JsonValue,
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
   * The backend this journal commits through.
   *
   * A migration writes events that are already sealed — same ids, sequences,
   * `recordedAt` stamps and digests — so it cannot go through `append`, which
   * mints new ones. `migrateJournalState` therefore takes a `JournalBackend`,
   * and this is how a caller holding only the journal names the same one. It
   * is not a general escape hatch: every ordinary write must keep using the
   * append queue above, which is what makes two in-page writers orderable.
   */
  get storage(): JournalBackend {
    return this.backend;
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
    expectedHead: JournalHead,
    signal?: AbortSignal,
  ): Promise<void> {
    const head = snapshotJournalHead(expectedHead);
    const previous = this.appendQueue.get(sessionId) ?? Promise.resolve();
    const link = previous
      .catch(() => undefined)
      .then(() => this.backend.deleteSession(sessionId, head, signal));
    const tail = link.catch(() => undefined);
    this.appendQueue.set(sessionId, tail);
    try {
      await link;
    } finally {
      // An append can chain behind this delete while its promise is settling.
      // Clear only this exact tail or that later append becomes untracked and a
      // following writer can enter the backend beside it on the same stale head.
      if (this.appendQueue.get(sessionId) === tail) this.appendQueue.delete(sessionId);
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

  /**
   * Change this conversation's routed model in flight, on the same thread.
   *
   * Model used to be a create-another-pinned-conversation verb on this
   * control; the same-thread event the approval policy already owns makes the
   * same move possible here: the manifest's pinned model stays the birth
   * certificate the audit trail vouches for, and the override applies from
   * the next turn forward — which is the only honest edge, since digests
   * minted inside a running turn already name the model they were minted
   * with. The connection (provider, credential, respiratory authority) does
   * not move; only which model each next request is addressed to does.
   */
  async setSessionModel(
    sessionId: string,
    model: string,
    options: { contextPolicy?: SessionContextPolicy | null; signal?: AbortSignal } = {},
  ): Promise<SessionRecord> {
    if (!validSessionModelId(model)) throw new TypeError("Session model override is invalid.");
    const payloadPartial: Record<string, JsonValue | null> = {};
    if ("contextPolicy" in options) {
      if (options.contextPolicy === null) {
        payloadPartial.contextPolicy = null;
      } else {
        const canonical = canonicalSessionContextPolicy(options.contextPolicy);
        if (!canonical) throw new TypeError("Session model context-policy override is invalid.");
        payloadPartial.contextPolicy = canonical as unknown as JsonValue;
      }
    }
    await this.append(
      sessionId,
      [{ type: "session.model-changed", payload: { model, ...payloadPartial } as JsonValue }],
      options.signal,
    );
    const session = await this.backend.getSession(sessionId, options.signal);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  append(sessionId: string, drafts: EventDraft[], signal?: AbortSignal): Promise<DurableEvent[]> {
    if (!drafts.length) return Promise.resolve([]);
    // Snapshot before even looking at the queue. A queued write can wait across
    // arbitrary caller work, so retaining its drafts would let later mutation
    // change what is hashed and committed after `append` has already returned.
    const snapshots = snapshotEventDrafts(drafts);
    const pending = this.appendQueue.get(sessionId);
    const result = pending
      ? this.commitAfter(pending, sessionId, snapshots, signal)
      : this.commit(sessionId, snapshots, signal);
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
    expectedHead: JournalHead,
    drafts: EventDraft[],
    signal?: AbortSignal,
  ): Promise<JournalAppendCommit> {
    if (!drafts.length) {
      return Promise.reject(new TypeError("A fenced append requires at least one event."));
    }
    // Own both caller-controlled inputs before a predecessor can make this
    // operation wait. In particular, the head used to seal the digest must be
    // the same head later handed to the backend compare-and-set.
    const head = snapshotJournalHead(expectedHead);
    const snapshots = snapshotEventDrafts(drafts);
    const pending = this.appendQueue.get(sessionId);
    const result = pending
      ? this.commitAtHeadAfter(pending, sessionId, head, snapshots, signal)
      : this.commitAtHead(sessionId, head, snapshots, signal, signal);
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
    expectedHead: JournalHead,
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
      {
        sequence: session.headSequence,
        digest: session.headDigest,
        ...(session.headIncarnation ? { incarnation: session.headIncarnation } : {}),
      },
      drafts,
      undefined,
      signal,
    )).events;
  }

  private async commitAtHead(
    sessionId: string,
    expectedHead: JournalHead,
    drafts: EventDraft[],
    preAdmissionSignal?: AbortSignal,
    backendSignal?: AbortSignal,
  ): Promise<JournalAppendCommit> {
    preAdmissionSignal?.throwIfAborted();

    const head = snapshotJournalHead(expectedHead);
    let sequence = head.sequence;
    let previousDigest = head.digest;
    const events: DurableEvent[] = [];

    for (const draft of drafts) {
      // These are plain, journal-owned snapshots. Keep the exact same values in
      // the digest preimage and the durable event instead of spreading and
      // rereading a caller object after SHA-256 yields.
      const type = draft.type;
      const turnId = draft.turnId;
      const operationId = draft.operationId;
      const payload = draft.payload;
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
        type,
        turnId: turnId ?? null,
        operationId: operationId ?? null,
        payload,
      };
      const digest = await sha256(stableStringify(digestInput));
      events.push({
        type,
        ...(turnId !== undefined ? { turnId } : {}),
        ...(operationId !== undefined ? { operationId } : {}),
        payload,
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
      head,
      events,
      backendSignal,
    );
    return { events, session };
  }
}

/** Capture a compare-and-set boundary without retaining caller accessors. */
function snapshotJournalHead(
  head: JournalHead,
): JournalHead {
  const sequence = head.sequence;
  const digest = head.digest;
  const incarnation = head.incarnation;
  return { sequence, digest, ...(incarnation ? { incarnation } : {}) };
}

/**
 * Turn caller-owned drafts into plain journal-owned values synchronously.
 *
 * Each top-level field is read exactly once. `structuredClone` owns the whole
 * payload graph at that instant, and the JSON check keeps values that cannot be
 * represented by the digest format (cycles, undefined, bigint, non-finite
 * numbers, and non-JSON containers) out of the durable chain.
 */
function snapshotEventDrafts(drafts: readonly EventDraft[]): EventDraft[] {
  return drafts.map((draft) => {
    const type = draft.type;
    const turnId = draft.turnId;
    const operationId = draft.operationId;
    const callerPayload: unknown = draft.payload;
    let payload: unknown;
    try {
      payload = structuredClone(callerPayload);
    } catch {
      throw new TypeError("Journal event payload must be a valid JSON value.");
    }
    if (!isJsonValue(payload)) {
      throw new TypeError("Journal event payload must be a valid JSON value.");
    }
    return {
      type,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(operationId !== undefined ? { operationId } : {}),
      payload,
    };
  });
}

function isJsonValue(value: unknown): value is JsonValue {
  type Visit = Readonly<{ value: unknown; exit?: object }>;
  const pending: Visit[] = [{ value }];
  const ancestors = new WeakSet<object>();
  while (pending.length > 0) {
    const visit = pending.pop()!;
    if (visit.exit) {
      ancestors.delete(visit.exit);
      continue;
    }
    const candidate = visit.value;
    if (
      candidate === null
      || typeof candidate === "string"
      || typeof candidate === "boolean"
    ) continue;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) return false;
      continue;
    }
    if (!candidate || typeof candidate !== "object" || ancestors.has(candidate)) return false;
    const prototype = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) return false;
    ancestors.add(candidate);
    pending.push({ value: null, exit: candidate });
    const children: unknown[] = Array.isArray(candidate)
      ? [...candidate]
      : Object.values(candidate);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: children[index] });
    }
  }
  return true;
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
/**
 * Records journaled *about* a conversation's place in the interface rather
 * than about the conversation.
 *
 * Both of these are written into a session's own stream because that is where
 * the digest chain that makes them tamper-evident lives — but neither is
 * something the conversation did. Selecting a thread is a statement about
 * which thread is open; reordering a favorite is a statement about a list.
 *
 * Two consequences, and they are the whole reason this set exists. They do not
 * advance `updatedAt`, so merely clicking into a conversation stops floating it
 * to the top of "recently active" above threads that were genuinely worked in
 * — reading a thread is not working in it. And they do not become transcript
 * markers, so switching between two conversations stops writing "Selected as
 * this profile's active conversation." into the middle of the one you are
 * reading, three times in a row, directly above the composer.
 *
 * They remain fully journaled, digest-chained and auditable: the head still
 * advances, `session-audit.ts` still names the type, and local session inspection still
 * lists every one of them. This changes where they are read, never whether
 * they were recorded.
 */
export const SESSION_BOOKKEEPING_EVENT_TYPES: ReadonlySet<string> = new Set([
  "profile.active-conversation.selected",
  "profile.favorite-order.moved",
  // Starring a conversation is a statement about a list too. `library.ts` had
  // always excluded it from its own recency derivation while the journals
  // advanced `updatedAt` for it anyway — two answers to one question, which is
  // how the selection pointer slipped through: fixing the journals left the
  // library re-deriving the timestamp from the very record they had stopped
  // counting.
  "session.favorite.changed",
]);

/**
 * The last event that represents the conversation itself changing, which is
 * what `updatedAt` has always meant to a reader scanning a list by recency.
 * Undefined when an append carried nothing but bookkeeping, in which case the
 * caller keeps the timestamp it already had.
 */
export function lastRecencyAdvancingEvent(events: readonly DurableEvent[]): DurableEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!SESSION_BOOKKEEPING_EVENT_TYPES.has(event.type)) return event;
  }
  return undefined;
}

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
 * The conversation's durable, same-thread model selection, projected from the
 * last `session.model-changed` event. Turning model switching into a
 * fork-the-thread operation was what used to strand people behind a new
 * pinned conversation every time they changed what the thread calls; a
 * durable override beside it is exactly how it stops doing that, and every
 * backend's head CAS applies it beside `title` for exactly the reason title
 * lives here.
 */
export function projectedSessionModel(
  events: readonly DurableEvent[],
  fallback: string | undefined,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "session.model-changed") {
      const model = event.payload && !Array.isArray(event.payload) && typeof event.payload === "object"
        ? event.payload.model
        : undefined;
      if (validSessionModelId(model)) return model;
    }
  }
  return fallback;
}

/**
 * The model the record routes to now: the durable in-flight choice when it
 * exists, else the manifest the thread was created with. Producers of
 * receipts, request digests, and any other model-pinning form answer with
 * this and nothing else — the manifest's `model` is the thread's birth
 * certificate, this is its current address.
 */
export function effectiveSessionModel(session: SessionRecord): string {
  return session.modelOverride ?? session.manifest.model;
}

/**
 * The compressed-context rules this record is writing to now: the override
 * when the person chose one, the manifest when they never did. `null` means
 * they explicitly went without — no policy at all — never silently
 * resurrecting the manifest pin because a field happened to be absent.
 */
export function effectiveSessionContextPolicy(session: SessionRecord): SessionContextPolicy | undefined {
  const override = session.contextPolicyOverride;
  if (override === undefined) return session.manifest.contextPolicy;
  return override ?? undefined;
}

function validSessionModelId(model: unknown): model is string {
  return (
    typeof model === "string" &&
    model.trim().length > 0 &&
    model.length <= 256 &&
    /^[\x20-\x7E]+$/u.test(model)
  );
}

/**
 * The compressed-context policy this conversation currently writes to,
 * projected from the same event family as its model selection: the last
 * `session.model-changed` that honestly named one. Compression lives or dies
 * by its window; "the person switched models" is exactly when the window
 * moves, so the policy rides the same durable override and every backend's
 * head CAS applies it along the same channels as the model itself.
 */
export function projectedSessionContextPolicy(
  events: readonly DurableEvent[],
  fallback: SessionContextPolicy | null | undefined,
): SessionContextPolicy | null | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "session.model-changed") continue;
    const policy = event.payload && !Array.isArray(event.payload) && typeof event.payload === "object"
      ? event.payload.contextPolicy
      : undefined;
    if (policy === null) return null;
    if (policy !== undefined) {
      const canonical = canonicalSessionContextPolicy(policy);
      if (canonical) return canonical;
    }
    // An event that names no policy leaves the pool's policy untouched and the
    // walk keeps looking backwards — switching the model is an address
    // change, not a silent flush of the flight plan that was already drawn.
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
/**
 * Every device-granted pin an append projects, in one place.
 *
 * Both backends used to inline the same three "compute it, test it, compute it
 * again" spreads. Naming the set is what lets a replay decline all of them at
 * once (`JournalAppendOptions`) instead of each backend remembering which
 * fields are grants and which are the conversation's own facts.
 */
export function projectedSessionPins(
  events: readonly DurableEvent[],
  current: Readonly<Pick<SessionRecord, "approvalModeOverride" | "modelOverride" | "contextPolicyOverride">>,
): Partial<SessionRecord> {
  const approvalModeOverride = projectedSessionApprovalMode(events, current.approvalModeOverride);
  const modelOverride = projectedSessionModel(events, current.modelOverride);
  const contextPolicyOverride = projectedSessionContextPolicy(events, current.contextPolicyOverride);
  return {
    // stableStringify cannot carry an explicit undefined key, so an override is
    // never minted absent — the pinned manifest is what an absent override means.
    ...(approvalModeOverride !== undefined ? { approvalModeOverride } : {}),
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    ...(contextPolicyOverride !== undefined ? { contextPolicyOverride } : {}),
  };
}

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
