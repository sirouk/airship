import { isRecord } from "../core/records";
import type { JsonValue, SessionManifest } from "../core/contracts";
import { canonicalSessionContextPolicy } from "../core/context-policy";
import { assertValidSessionInferenceBinding } from "../core/inference-binding";
import {
  JournalConflictError,
  projectedSessionPins,
  projectedSessionTitle,
  type DurableEvent,
  type JournalAppendOptions,
  type JournalBackend,
  type JournalHead,
  type SessionRecord,
  lastRecencyAdvancingEvent,
} from "../core/journal";
import { sha256, stableStringify } from "../core/hash";
import { randomUuid } from "../core/id";
import {
  WorkspaceRootKey,
  decodeEnvelope,
  encodeEnvelope,
  openEnvelope,
  sealEnvelope,
} from "./encrypted-envelope";
import {
  isReclaimableObjectStore,
  type ObjectReclamationReceipt,
  type ObjectRecord,
  type ObjectStore,
} from "./object-store";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ROOT_NAMESPACE = "airship/session-head/v1";
const SEGMENT_NAMESPACE = "airship/session-events/v1";
const HEAD_CONTENT_TYPE = "application/vnd.airship.session-head+json";
const DELETION_CONTENT_TYPE = "application/vnd.airship.session-deletion+json";
const MAX_SESSIONS = 10_000;
const MAX_SEGMENTS_PER_SESSION = 100_000;
const MAX_EVENTS_PER_SEGMENT = 4_096;
/**
 * The width of a post-commit segment sweep, matching the batch
 * `vault/reclamation.ts` already offers providers. A conversation may hold up
 * to `MAX_SEGMENTS_PER_SESSION` of them while Google Drive rejects any `trash`
 * call naming more than a thousand keys outright, so an unbatched sweep of a
 * long conversation would leave every one of its bodies indexed and orphaned.
 */
const MAX_SEGMENT_TRASH_BATCH = 500;

type SegmentReference = {
  cloudKey: string;
  logicalId: string;
  startSequence: number;
  endSequence: number;
  previousDigest: string;
  headDigest: string;
  etag: string;
};

type SessionHead = {
  version: 1;
  session: SessionRecord;
  segments: SegmentReference[];
  incarnationId: string;
  /** Missing incarnation tokens remain compatible only before exact-ID reuse. */
  incarnationFenceRequired: boolean;
};

type SessionDeletionMarker = {
  version: 1;
  sessionId: string;
  headSequence: number;
  headDigest: string;
  headIncarnation: string;
  /** Unique authority for one deleted incarnation of a reusable session ID. */
  deletionId: string;
  /** True only after every segment received a confirmed reclamation receipt. */
  cleanupComplete: boolean;
  segmentKeys: string[];
};

type OpenedHead =
  | { status: "active"; head: SessionHead }
  | { status: "deleted"; marker: SessionDeletionMarker };

type LoadedHead = OpenedHead & { record: ObjectRecord };

type EventSegment = {
  version: 1;
  sessionId: string;
  events: DurableEvent[];
};

/**
 * The deletion tombstone committed, but one or more encrypted objects still
 * need provider-confirmed reclamation. The tombstone remains addressable so a
 * later idempotent delete can retry the cleanup.
 */
export class EncryptedJournalCleanupNeededError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EncryptedJournalCleanupNeededError";
  }
}

/**
 * Cloud-authoritative encrypted journal over a CAS-capable ObjectStore.
 * Immutable event segments are committed before one small encrypted session
 * head is atomically advanced. A failed CAS leaves only a safe orphan segment.
 */
export class EncryptedObjectJournalBackend implements JournalBackend {
  private readonly prefix: string;

  constructor(
    private readonly store: ObjectStore,
    private readonly key: WorkspaceRootKey,
    prefix = "airship/v1",
  ) {
    this.prefix = normalizePrefix(prefix);
  }

  async createSession(session: SessionRecord): Promise<void> {
    validateSession(session);
    if (session.headSequence !== 0 || session.headDigest !== "genesis") {
      throw new Error("A new encrypted session must start at the genesis head.");
    }
    // Own caller data before opaque-key derivation yields. Direct backend users
    // deserve the same snapshot boundary EventJournal provides.
    const storedSession = structuredClone(session);
    delete storedSession.headIncarnation;
    const cloudKey = await this.headCloudKey(storedSession.id);
    const initialHead: SessionHead = {
      version: 1,
      session: storedSession,
      segments: [],
      incarnationId: randomUuid(),
      incarnationFenceRequired: false,
    };
    const bytes = await this.sealHead(initialHead);
    const restoredBytes = await this.sealHead({
      ...initialHead,
      incarnationId: randomUuid(),
      incarnationFenceRequired: true,
    });
    const initial = await this.store.putIfAbsent(cloudKey, bytes);
    if (initial.created) return;

    /*
     * Migration and restore preserve exact durable IDs. A completed deletion
     * therefore acts as a reusable, authenticated empty slot rather than making
     * the ID unavailable forever. Pending cleanup is finished first so replacing
     * its only retry record cannot strand old ciphertext. Both the retirement
     * and this restoration are CAS operations on the marker ETag: a delayed
     * cleanup from the prior incarnation can never act on the replacement head.
     */
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const record = await this.store.get(cloudKey);
      if (!record) {
        // The ID was observed occupied earlier in this call. Even if a legacy
        // cleanup removed its marker meanwhile, reinstalling is still reuse and
        // must not regain first-incarnation compatibility with tokenless heads.
        const retried = await this.store.putIfAbsent(cloudKey, restoredBytes);
        if (retried.created) return;
        continue;
      }
      const opened = await this.openHeadRecord(record, session.id);
      if (opened.status === "active") throw new Error(`Session already exists: ${session.id}`);
      if (!opened.marker.cleanupComplete) {
        await this.finishDeletion(record, opened.marker);
        continue;
      }
      const restored = await this.store.compareAndSwap(cloudKey, record.etag, restoredBytes);
      if (restored.updated) return;
    }
    throw new JournalConflictError(`Session ${session.id} changed while its deleted ID was being restored.`);
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<SessionRecord | undefined> {
    const loaded = await this.loadHead(sessionId, signal);
    return loaded?.status === "active" ? publicSession(loaded.head) : undefined;
  }

  async listSessions(signal?: AbortSignal): Promise<SessionRecord[]> {
    const records = await this.store.list(`${this.prefix}/session-heads/`, signal);
    if (records.length > MAX_SESSIONS) throw new Error("Encrypted journal exceeds the client session limit.");
    const candidates = await Promise.all(
      records.map(async (summary) => {
        const record = await this.store.get(summary.key, signal);
        if (!record) return undefined; // A concurrent confirmed deletion won after list().
        const opened = await this.openHeadRecord(record);
        return opened.status === "active" ? publicSession(opened.head) : undefined;
      }),
    );
    const sessions = candidates.filter((candidate): candidate is SessionRecord => candidate !== undefined);
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readEvents(sessionId: string, afterSequence = 0, signal?: AbortSignal): Promise<DurableEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("Event cursor is invalid.");
    const loaded = await this.loadHead(sessionId, signal);
    if (!loaded || loaded.status === "deleted") return [];
    const relevant = loaded.head.segments.filter((segment) => segment.endSequence > afterSequence);
    const chunks: DurableEvent[][] = [];
    for (let offset = 0; offset < relevant.length; offset += 8) {
      chunks.push(
        ...(await Promise.all(
          relevant.slice(offset, offset + 8).map((reference) => this.loadSegment(sessionId, reference, signal)),
        )),
      );
    }
    return chunks.flat().filter((event) => event.sequence > afterSequence).map((event) => structuredClone(event));
  }

  async append(
    sessionId: string,
    expectedHead: JournalHead,
    events: DurableEvent[],
    signal?: AbortSignal,
    options?: JournalAppendOptions,
  ): Promise<SessionRecord> {
    if (events.length === 0) {
      const session = await this.getSession(sessionId, signal);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      return session;
    }
    if (events.length > MAX_EVENTS_PER_SEGMENT) throw new Error("Encrypted journal append exceeds the segment event limit.");
    const loaded = await this.loadHead(sessionId, signal);
    if (!loaded || loaded.status === "deleted") throw new Error(`Unknown session: ${sessionId}`);
    const current = loaded.head.session;
    if (
      current.headSequence !== expectedHead.sequence ||
      current.headDigest !== expectedHead.digest ||
      !matchesIncarnationFence(loaded.head, expectedHead)
    ) {
      throw new JournalConflictError();
    }
    validateAppend(sessionId, expectedHead, events);
    await verifyEventDigests(events);

    const first = events[0]!;
    const last = events.at(-1)!;
    // Each attempt owns its immutable object. Without an attempt nonce, two
    // identical concurrent appends can share a segment key and the losing
    // writer cannot reclaim "its" orphan without racing the winner's publish.
    const segmentLogicalId = `session:${sessionId}:events:${first.sequence}-${last.sequence}:${last.digest}:${randomUuid()}`;
    const segmentCloudKey = `${this.prefix}/session-segments/${await this.key.opaqueObjectId(segmentLogicalId)}`;
    const segment: EventSegment = { version: 1, sessionId, events: structuredClone(events) };
    const sealedSegment = await sealEnvelope({
      key: this.key,
      namespace: SEGMENT_NAMESPACE,
      logicalId: segmentLogicalId,
      revision: last.digest,
      contentType: "application/vnd.airship.events+json",
      plaintext: encodeJson(segment),
    });
    const segmentBytes = encodeEnvelope(sealedSegment);
    let published = false;
    let putAttempted = false;
    // Until putIfAbsent answers otherwise, a thrown response may still have
    // stored this attempt-owned immutable object at the provider.
    let mayOwnSegment = true;
    try {
      signal?.throwIfAborted();
      putAttempted = true;
      const created = await this.store.putIfAbsent(segmentCloudKey, segmentBytes, signal);
      mayOwnSegment = created.created;
      let segmentEtag: string;
      if (!created.created) {
        signal?.throwIfAborted();
        const existing = await this.store.get(segmentCloudKey, signal);
        if (!existing) throw new Error("Encrypted event segment conflicted and then disappeared.");
        const existingSegment = await this.openSegmentRecord(existing, segmentLogicalId);
        await verifyEventDigests(existingSegment.events);
        if (stableStringify(existingSegment as unknown as JsonValue) !== stableStringify(segment as unknown as JsonValue)) {
          throw new Error("Encrypted event segment key collided with different content.");
        }
        // Attempt IDs are single-owner. Never publish an object another append
        // created, or its failed writer could safely classify it as an orphan
        // just before this writer advances the head to reference it.
        throw new Error("Encrypted event segment attempt ID already exists.");
      } else {
        segmentEtag = created.etag;
      }

      const updated: SessionRecord = {
        ...current,
        title: projectedSessionTitle(events, current.title),
        // A replay grants nothing; see `JournalAppendOptions`.
        ...(options?.replay ? {} : projectedSessionPins(events, current)),
        /* Bookkeeping does not make a conversation recent; see
           `SESSION_BOOKKEEPING_EVENT_TYPES`. This backend is the Vault lane and
           was missed when the page-memory and IndexedDB lanes were fixed, so
           clicking a thread still re-sorted the list for anyone on a Vault. */
        updatedAt: lastRecencyAdvancingEvent(events)?.recordedAt ?? current.updatedAt,
        headSequence: last.sequence,
        headDigest: last.digest,
      };
      const reference: SegmentReference = {
        cloudKey: segmentCloudKey,
        logicalId: segmentLogicalId,
        startSequence: first.sequence,
        endSequence: last.sequence,
        previousDigest: first.previousDigest,
        headDigest: last.digest,
        etag: segmentEtag,
      };
      const nextHead: SessionHead = {
        version: 1,
        session: updated,
        segments: [...loaded.head.segments, reference],
        incarnationId: loaded.head.incarnationId,
        incarnationFenceRequired: loaded.head.incarnationFenceRequired,
      };
      if (nextHead.segments.length > MAX_SEGMENTS_PER_SESSION) {
        throw new Error("Encrypted journal requires segment compaction before another append.");
      }
      const rootBytes = await this.sealHead(nextHead);
      /*
       * This call is the append's linearization boundary. Cancellation remains
       * live through every remote read and immutable-segment write above, then is
       * sampled one final time before the atomic head CAS is admitted. Do not
       * carry the signal into the CAS: a request aborted after the provider
       * committed could otherwise reject as "cancelled" and make a safe retry
       * append the same human choice twice.
       */
      signal?.throwIfAborted();
      const swapped = await this.store.compareAndSwap(loaded.record.key, loaded.record.etag, rootBytes);
      if (!swapped.updated) throw new JournalConflictError();
      // No cleanup is admissible after the head has published the reference.
      published = true;
      return publicSession(nextHead);
    } catch (error) {
      /*
       * A successful immutable put followed by a final abort, head-seal error,
       * or failed CAS must not strand decryptable ciphertext. Reclamation stays
       * best effort so it never hides the append's real result. The fresh-head
       * check inside `reclaimUncommittedSegment` protects a CAS that committed
       * before its provider response failed.
       */
      if (putAttempted && mayOwnSegment && !published) {
        await this.reclaimUncommittedSegment(sessionId, segmentCloudKey, segmentBytes);
      }
      throw error;
    }
  }

  /**
   * Remove a conversation through an authenticated CAS tombstone.
   *
   * A plain read-then-trash is not a conditional delete: another tab can CAS a
   * newer head after the read and the stale trash then destroys that committed
   * append. The tombstone CAS is the deletion's linearization point. If append
   * won, it conflicts. If deletion won, every writer holding the old ETag
   * conflicts and new readers treat the marker as absent.
   *
   * The marker keeps the segment keys so a retry can finish cleanup if the page
   * closes after the CAS. After the segment sweep it is CAS-retired to a compact
   * authenticated empty-slot authority. The reusable head key is never passed
   * to unconditional provider `trash`, because a delayed call could otherwise
   * remove a restored session with the same ID. A store with no reclamation
   * capability is refused before the marker is written.
   */
  async deleteSession(
    sessionId: string,
    expectedHead: JournalHead,
    signal?: AbortSignal,
  ): Promise<void> {
    const loaded = await this.loadHead(sessionId, signal);
    if (!loaded) return;
    if (!isReclaimableObjectStore(this.store)) {
      throw new Error("This Vault cannot delete objects, so the conversation was not removed.");
    }
    if (loaded.status === "deleted") {
      await this.finishDeletion(loaded.record, loaded.marker);
      return;
    }

    const { session, segments } = loaded.head;
    if (
      session.headSequence !== expectedHead.sequence ||
      session.headDigest !== expectedHead.digest ||
      !matchesIncarnationFence(loaded.head, expectedHead)
    ) {
      throw new JournalConflictError("The conversation changed since it was read; it was not deleted.");
    }
    const marker: SessionDeletionMarker = {
      version: 1,
      sessionId,
      headSequence: session.headSequence,
      headDigest: session.headDigest,
      headIncarnation: loaded.head.incarnationId,
      deletionId: randomUuid(),
      cleanupComplete: false,
      segmentKeys: segments.map((segment) => segment.cloudKey),
    };
    const markerBytes = await this.sealDeletionMarker(marker);
    signal?.throwIfAborted();
    // Do not pass the signal across the CAS. A late abort must not turn a
    // committed deletion into an ambiguous failure that a caller repeats.
    const swapped = await this.store.compareAndSwap(loaded.record.key, loaded.record.etag, markerBytes);
    if (!swapped.updated) {
      throw new JournalConflictError("The conversation changed since it was read; it was not deleted.");
    }
    await this.finishDeletion({ ...loaded.record, etag: swapped.etag, bytes: markerBytes }, marker);
  }

  private async finishDeletion(record: ObjectRecord, marker: SessionDeletionMarker): Promise<void> {
    if (marker.cleanupComplete) return;
    if (!isReclaimableObjectStore(this.store)) {
      throw new EncryptedJournalCleanupNeededError(
        "The conversation deletion committed, but this Vault cannot finish its cleanup.",
      );
    }

    /*
     * Keep the authenticated marker addressable until every ciphertext body has
     * a provider-confirmed reclamation receipt. A thrown or partial batch can
     * have removed an arbitrary prefix, so a retry deliberately submits the
     * whole authenticated key list again; reclamation is idempotent.
     */
    for (let offset = 0; offset < marker.segmentKeys.length; offset += MAX_SEGMENT_TRASH_BATCH) {
      const batch = marker.segmentKeys.slice(offset, offset + MAX_SEGMENT_TRASH_BATCH);
      let receipt: ObjectReclamationReceipt;
      try {
        receipt = await this.store.trash(batch);
      } catch (error) {
        throw new EncryptedJournalCleanupNeededError(
          "The conversation deletion committed, but encrypted segment cleanup is incomplete; retry deletion to finish cleanup.",
          { cause: error },
        );
      }
      if (!hasConfirmedReclamation(receipt, batch)) {
        throw new EncryptedJournalCleanupNeededError(
          "The conversation deletion committed, but the Vault retained encrypted segments; retry deletion to finish cleanup.",
        );
      }
    }

    /*
     * Retire the retry record last, but never issue an unconditional trash for
     * the reusable head key. The compact completed marker is durable authority
     * for the empty slot. Its CAS is bound to this deletion's marker ETag and
     * deletionId. If an exact-ID restore (or a later incarnation) already won,
     * the stale cleanup simply loses this CAS and cannot damage the new head.
     */
    const completed: SessionDeletionMarker = {
      ...marker,
      cleanupComplete: true,
      segmentKeys: [],
    };
    const completedBytes = await this.sealDeletionMarker(completed);
    let retired = false;
    try {
      retired = (await this.store.compareAndSwap(record.key, record.etag, completedBytes)).updated;
    } catch (error) {
      throw new EncryptedJournalCleanupNeededError(
        "The conversation ciphertext was reclaimed, but its deletion marker still needs cleanup; retry deletion.",
        { cause: error },
      );
    }
    if (retired) return;

    // A concurrent retry can retire the same marker, and an exact-ID restore can
    // replace it immediately afterwards. Authenticate whatever won before
    // classifying this stale retirement attempt as harmless.
    const current = await this.store.get(record.key);
    if (!current) return;
    const opened = await this.openHeadRecord(current, marker.sessionId);
    if (opened.status === "active") return;
    if (opened.marker.deletionId === marker.deletionId && opened.marker.cleanupComplete) return;
    // A different marker belongs to a later incarnation. Its own delete owns
    // its segment list; this stale cleanup has no authority over it.
  }

  private async reclaimUncommittedSegment(
    sessionId: string,
    segmentKey: string,
    expectedBytes: Uint8Array,
  ): Promise<void> {
    if (!isReclaimableObjectStore(this.store)) return;
    try {
      const current = await this.loadHead(sessionId);
      if (current?.status === "active" && current.head.segments.some((segment) => segment.cloudKey === segmentKey)) {
        return;
      }
      // A put response can fail after the provider stored the bytes. Verify the
      // attempt-owned ciphertext before issuing the otherwise-unconditional
      // reclamation verb, so even an impossible opaque-key collision is safe.
      const candidate = await this.store.get(segmentKey);
      if (!candidate || !equalBytes(candidate.bytes, expectedBytes)) return;
      await this.store.trash([segmentKey]);
    } catch {
      // A provider sweep handles the same safe orphan class if immediate
      // best-effort reclamation is unavailable.
    }
  }

  private async loadHead(sessionId: string, signal?: AbortSignal): Promise<LoadedHead | undefined> {
    const record = await this.store.get(await this.headCloudKey(sessionId), signal);
    if (!record) return undefined;
    return { record, ...(await this.openHeadRecord(record, sessionId)) };
  }

  private async headCloudKey(sessionId: string): Promise<string> {
    const logicalId = headLogicalId(sessionId);
    return `${this.prefix}/session-heads/${await this.key.opaqueObjectId(logicalId)}`;
  }

  private async sealHead(head: SessionHead): Promise<Uint8Array> {
    const envelope = await sealEnvelope({
      key: this.key,
      namespace: ROOT_NAMESPACE,
      logicalId: headLogicalId(head.session.id),
      revision: `${head.session.headSequence}:${head.session.headDigest}:${head.incarnationId}`,
      contentType: HEAD_CONTENT_TYPE,
      plaintext: encodeJson(head),
    });
    return encodeEnvelope(envelope);
  }

  private async sealDeletionMarker(marker: SessionDeletionMarker): Promise<Uint8Array> {
    const envelope = await sealEnvelope({
      key: this.key,
      namespace: ROOT_NAMESPACE,
      logicalId: headLogicalId(marker.sessionId),
      revision: deletionMarkerRevision(marker),
      contentType: DELETION_CONTENT_TYPE,
      plaintext: encodeJson(marker),
    });
    return encodeEnvelope(envelope);
  }

  private async openHeadRecord(record: ObjectRecord, expectedSessionId?: string): Promise<OpenedHead> {
    const envelope = decodeEnvelope(record.bytes);
    if (envelope.aad.contentType !== HEAD_CONTENT_TYPE && envelope.aad.contentType !== DELETION_CONTENT_TYPE) {
      throw new Error("Encrypted session head content type is invalid.");
    }
    const plaintext = await openEnvelope({
      key: this.key,
      envelope,
      expectedNamespace: ROOT_NAMESPACE,
      expectedLogicalId: expectedSessionId ? headLogicalId(expectedSessionId) : undefined,
      maxPlaintextBytes: 32 * 1024 * 1024,
    });
    if (envelope.aad.contentType === HEAD_CONTENT_TYPE) {
      const head = parseHead(plaintext);
      if (expectedSessionId && head.session.id !== expectedSessionId) throw new Error("Encrypted session head ID does not match its key.");
      if (record.key !== (await this.headCloudKey(head.session.id))) throw new Error("Encrypted session head is stored under the wrong opaque key.");
      if (
        envelope.revision !== `${head.session.headSequence}:${head.session.headDigest}:${head.incarnationId}` &&
        envelope.revision !== `${head.session.headSequence}:${head.session.headDigest}`
      ) {
        throw new Error("Encrypted session head metadata does not match its contents.");
      }
      return { status: "active", head };
    }

    const marker = parseDeletionMarker(plaintext, this.prefix);
    if (expectedSessionId && marker.sessionId !== expectedSessionId) throw new Error("Encrypted session deletion ID does not match its key.");
    if (record.key !== (await this.headCloudKey(marker.sessionId))) throw new Error("Encrypted session deletion is stored under the wrong opaque key.");
    if (
      envelope.revision !== deletionMarkerRevision(marker) &&
      envelope.revision !== `deleted:${marker.headSequence}:${marker.headDigest}`
    ) {
      throw new Error("Encrypted session deletion metadata does not match its contents.");
    }
    return { status: "deleted", marker };
  }

  private async loadSegment(sessionId: string, reference: SegmentReference, signal?: AbortSignal): Promise<DurableEvent[]> {
    const record = await this.store.get(reference.cloudKey, signal);
    if (!record) throw new Error("Encrypted journal segment is missing.");
    if (record.etag !== reference.etag) throw new Error("Encrypted journal segment ETag changed after publication.");
    const segment = await this.openSegmentRecord(record, reference.logicalId);
    if (segment.sessionId !== sessionId) throw new Error("Encrypted journal segment belongs to another session.");
    validateAppend(
      sessionId,
      { sequence: reference.startSequence - 1, digest: reference.previousDigest },
      segment.events,
    );
    await verifyEventDigests(segment.events);
    const last = segment.events.at(-1)!;
    if (
      segment.events[0]!.sequence !== reference.startSequence ||
      last.sequence !== reference.endSequence ||
      last.digest !== reference.headDigest
    ) {
      throw new Error("Encrypted journal segment does not match its committed reference.");
    }
    return segment.events;
  }

  private async openSegmentRecord(record: ObjectRecord, logicalId: string): Promise<EventSegment> {
    const envelope = decodeEnvelope(record.bytes);
    const plaintext = await openEnvelope({
      key: this.key,
      envelope,
      expectedNamespace: SEGMENT_NAMESPACE,
      expectedLogicalId: logicalId,
      maxPlaintextBytes: 64 * 1024 * 1024,
    });
    const segment = parseSegment(plaintext);
    const last = segment.events.at(-1)!;
    if (
      envelope.revision !== last.digest ||
      envelope.aad.contentType !== "application/vnd.airship.events+json"
    ) {
      throw new Error("Encrypted event segment metadata does not match its contents.");
    }
    return segment;
  }
}

function validateAppend(
  sessionId: string,
  expected: { sequence: number; digest: string },
  events: DurableEvent[],
): void {
  const first = events[0];
  if (!first || first.sessionId !== sessionId || first.sequence !== expected.sequence + 1 || first.previousDigest !== expected.digest) {
    throw new JournalConflictError("The append does not extend the encrypted session head.");
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    validateEvent(event);
    if (event.sessionId !== sessionId) throw new Error("Encrypted append mixes session IDs.");
    if (index > 0) {
      const prior = events[index - 1]!;
      if (event.sequence !== prior.sequence + 1 || event.previousDigest !== prior.digest) {
        throw new Error("Encrypted append contains a broken digest chain.");
      }
    }
  }
}

async function verifyEventDigests(events: DurableEvent[]): Promise<void> {
  for (const event of events) {
    const digestInput: JsonValue = {
      version: 1,
      eventId: event.eventId,
      sessionId: event.sessionId,
      sequence: event.sequence,
      recordedAt: event.recordedAt,
      previousDigest: event.previousDigest,
      type: event.type,
      turnId: event.turnId ?? null,
      operationId: event.operationId ?? null,
      payload: event.payload,
    };
    if ((await sha256(stableStringify(digestInput))) !== event.digest) {
      throw new Error("Encrypted journal event digest is invalid.");
    }
  }
}

function parseHead(bytes: Uint8Array): SessionHead {
  const value = parseJson(bytes, "encrypted session head");
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.segments)) throw new Error("Encrypted session head is invalid.");
  validateSession(value.session);
  if (value.segments.length > MAX_SEGMENTS_PER_SESSION) throw new Error("Encrypted session head has too many segments.");
  const segments = value.segments.map(parseSegmentReference);
  let sequence = 0;
  let digest = "genesis";
  for (const segment of segments) {
    if (segment.startSequence !== sequence + 1 || segment.previousDigest !== digest || segment.endSequence < segment.startSequence) {
      throw new Error("Encrypted session head contains a broken segment chain.");
    }
    sequence = segment.endSequence;
    digest = segment.headDigest;
  }
  if (value.session.headSequence !== sequence || value.session.headDigest !== digest) {
    throw new Error("Encrypted session head does not match its segment chain.");
  }
  const incarnationId = value.incarnationId === undefined
    ? "legacy"
    : requiredString(value.incarnationId, "session head incarnation ID");
  const incarnationFenceRequired = value.incarnationFenceRequired === undefined
    ? false
    : value.incarnationFenceRequired;
  if (typeof incarnationFenceRequired !== "boolean") {
    throw new Error("Encrypted session head incarnation fence is invalid.");
  }
  const session = structuredClone(value.session);
  delete session.headIncarnation;
  return { version: 1, session, segments, incarnationId, incarnationFenceRequired };
}

function parseDeletionMarker(bytes: Uint8Array, prefix: string): SessionDeletionMarker {
  const value = parseJson(bytes, "encrypted session deletion");
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.segmentKeys)) {
    throw new Error("Encrypted session deletion marker is invalid.");
  }
  if (value.segmentKeys.length > MAX_SEGMENTS_PER_SESSION) {
    throw new Error("Encrypted session deletion marker has too many segments.");
  }
  const expectedPrefix = `${prefix}/session-segments/`;
  const segmentKeys = value.segmentKeys.map((key) => requiredString(key, "deleted segment key"));
  if (segmentKeys.some((key) => !key.startsWith(expectedPrefix)) || new Set(segmentKeys).size !== segmentKeys.length) {
    throw new Error("Encrypted session deletion marker contains an invalid segment key.");
  }
  const headSequence = requiredInteger(value.headSequence, "deleted session head sequence", true);
  const headDigest = requiredString(value.headDigest, "deleted session head digest");
  const headIncarnation = value.headIncarnation === undefined
    ? "legacy"
    : requiredString(value.headIncarnation, "deleted session head incarnation ID");
  const deletionId = value.deletionId === undefined
    ? `legacy:${headSequence}:${headDigest}`
    : requiredString(value.deletionId, "session deletion incarnation ID");
  const cleanupComplete = value.cleanupComplete === undefined ? false : value.cleanupComplete;
  if (typeof cleanupComplete !== "boolean" || (cleanupComplete && segmentKeys.length !== 0)) {
    throw new Error("Encrypted session deletion cleanup state is invalid.");
  }
  return {
    version: 1,
    sessionId: requiredString(value.sessionId, "deleted session ID"),
    headSequence,
    headDigest,
    headIncarnation,
    deletionId,
    cleanupComplete,
    segmentKeys,
  };
}

function parseSegment(bytes: Uint8Array): EventSegment {
  const value = parseJson(bytes, "encrypted event segment");
  if (!isRecord(value) || value.version !== 1 || typeof value.sessionId !== "string" || !Array.isArray(value.events)) {
    throw new Error("Encrypted event segment is invalid.");
  }
  if (value.events.length === 0 || value.events.length > MAX_EVENTS_PER_SEGMENT) throw new Error("Encrypted event segment size is invalid.");
  value.events.forEach(validateEvent);
  return { version: 1, sessionId: value.sessionId, events: structuredClone(value.events) };
}

function parseSegmentReference(value: unknown): SegmentReference {
  if (!isRecord(value)) throw new Error("Encrypted segment reference is invalid.");
  const result: SegmentReference = {
    cloudKey: requiredString(value.cloudKey, "segment cloud key"),
    logicalId: requiredString(value.logicalId, "segment logical ID"),
    startSequence: requiredInteger(value.startSequence, "segment start"),
    endSequence: requiredInteger(value.endSequence, "segment end"),
    previousDigest: requiredString(value.previousDigest, "segment previous digest"),
    headDigest: requiredString(value.headDigest, "segment head digest"),
    etag: requiredString(value.etag, "segment ETag"),
  };
  return result;
}

function validateSession(value: unknown): asserts value is SessionRecord {
  if (!isRecord(value) || !isRecord(value.manifest)) throw new Error("Encrypted session record is invalid.");
  requiredString(value.id, "session ID");
  requiredString(value.title, "session title");
  requiredString(value.createdAt, "session creation time");
  requiredString(value.updatedAt, "session update time");
  requiredInteger(value.headSequence, "session head sequence", true);
  requiredString(value.headDigest, "session head digest");
  validateManifest(value.manifest);
}

function validateManifest(value: Record<string, unknown>): asserts value is SessionManifest {
  if (
    (value.protocolVersion !== 1 && value.protocolVersion !== 2) ||
    !Array.isArray(value.tools) ||
    (value.protocolVersion === 1 && value.turnContext !== undefined) ||
    (value.protocolVersion === 2 && value.turnContext !== "required" && value.turnContext !== "disabled")
  ) throw new Error("Encrypted session manifest is invalid.");
  for (const field of ["systemPrompt", "systemPromptDigest", "providerId", "model", "toolManifestDigest", "workspaceId", "createdAt"] as const) {
    requiredString(value[field], `manifest ${field}`);
  }
  if (![
    "web-baseline",
    "web-enhanced",
    "native",
    "remote-heavy",
  ].includes(String(value.capabilityTier))) throw new Error("Encrypted session capability tier is invalid.");
  if (value.contextPolicy !== undefined && !canonicalSessionContextPolicy(value.contextPolicy)) {
    throw new Error("Encrypted session context policy is invalid.");
  }
  if (value.inferenceBinding !== undefined) {
    if (!isRecord(value.inferenceBinding)) throw new Error("Encrypted session inference binding is invalid.");
    const binding = value.inferenceBinding;
    requiredString(binding.connectionId, "manifest inference connection ID");
    requiredInteger(binding.connectionGeneration, "manifest inference connection generation");
    requiredString(binding.providerId, "manifest inference provider ID");
    requiredString(binding.providerLabel, "manifest inference provider label");
    requiredInteger(binding.providerRevision, "manifest inference provider revision");
    requiredString(binding.authMethod, "manifest inference auth method");
    requiredString(binding.transportBoundary, "manifest inference transport boundary");
    const modelId = requiredString(binding.modelId, "manifest inference model ID");
    requiredString(binding.boundAt, "manifest inference binding time");
    if (binding.version === 2) {
      requiredString(binding.transportId, "manifest inference transport ID");
    }
    if (
      (binding.version !== 1 && binding.version !== 2) ||
      (binding.version === 2 && (
        !["openai-responses", "openai-chat-completions", "anthropic-messages", "openai-compatible"]
          .includes(String(binding.protocol)) ||
        binding.providerId !== value.providerId
      )) ||
      modelId !== value.model ||
      !["oauth-pkce", "api-key", "local-none"].includes(String(binding.authMethod)) ||
      !(binding.version === 1
        ? ["e2ee-attestable", "provider-tls", "loopback-local"]
        : ["provider-tls", "loopback-local"]
      ).includes(String(binding.transportBoundary)) ||
      !Number.isFinite(Date.parse(String(binding.boundAt)))
    ) throw new Error("Encrypted session inference binding is invalid.");
    assertValidSessionInferenceBinding(value as Pick<SessionManifest, "providerId" | "model" | "inferenceBinding">);
  }
}

function validateEvent(value: unknown): asserts value is DurableEvent {
  if (!isRecord(value) || value.version !== 1) throw new Error("Encrypted journal event is invalid.");
  for (const field of ["eventId", "sessionId", "recordedAt", "previousDigest", "digest", "type"] as const) {
    requiredString(value[field], `event ${field}`);
  }
  requiredInteger(value.sequence, "event sequence");
  if (!("payload" in value)) throw new Error("Encrypted journal event payload is missing.");
}

function hasConfirmedReclamation(
  receipt: ObjectReclamationReceipt,
  expectedKeys: readonly string[],
): boolean {
  if (
    receipt.requested !== expectedKeys.length ||
    receipt.reclaimed.length !== expectedKeys.length ||
    receipt.retained.length !== 0 ||
    receipt.outcomes.length !== expectedKeys.length
  ) return false;
  const reclaimed = new Set(receipt.reclaimed);
  const outcomes = new Map(receipt.outcomes.map((outcome) => [outcome.key, outcome] as const));
  return (
    reclaimed.size === expectedKeys.length &&
    outcomes.size === expectedKeys.length &&
    expectedKeys.every((key) => reclaimed.has(key) && outcomes.get(key)?.reclaimed === true)
  );
}

function publicSession(head: SessionHead): SessionRecord {
  return {
    ...structuredClone(head.session),
    headIncarnation: head.incarnationId,
  };
}

function matchesIncarnationFence(head: SessionHead, expected: JournalHead): boolean {
  if (expected.incarnation !== undefined) return expected.incarnation === head.incarnationId;
  return !head.incarnationFenceRequired;
}

function deletionMarkerRevision(marker: SessionDeletionMarker): string {
  return `deleted:${marker.headSequence}:${marker.headDigest}:${marker.headIncarnation}:${marker.deletionId}:${marker.cleanupComplete ? "complete" : "pending"}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(stableStringify(value as JsonValue));
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (error) {
    throw new Error(`Could not decode ${label}.`, { cause: error });
  }
}

function headLogicalId(sessionId: string): string {
  return `session:${sessionId}:head`;
}

function normalizePrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/gu, "");
  if (!normalized || /\0/u.test(normalized)) throw new Error("Encrypted journal prefix is invalid.");
  return normalized;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 * 1024) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredInteger(value: unknown, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) throw new Error(`${label} is invalid.`);
  return Number(value);
}

