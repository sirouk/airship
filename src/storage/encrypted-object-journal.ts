import type { JsonValue, SessionManifest } from "../core/contracts";
import { canonicalSessionContextPolicy } from "../core/context-policy";
import {
  JournalConflictError,
  type DurableEvent,
  type JournalBackend,
  type SessionRecord,
} from "../core/journal";
import { sha256, stableStringify } from "../core/hash";
import {
  WorkspaceRootKey,
  decodeEnvelope,
  encodeEnvelope,
  openEnvelope,
  sealEnvelope,
} from "./encrypted-envelope";
import type { ObjectRecord, ObjectStore } from "./object-store";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ROOT_NAMESPACE = "airship/session-head/v1";
const SEGMENT_NAMESPACE = "airship/session-events/v1";
const MAX_SESSIONS = 10_000;
const MAX_SEGMENTS_PER_SESSION = 100_000;
const MAX_EVENTS_PER_SEGMENT = 4_096;

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
};

type EventSegment = {
  version: 1;
  sessionId: string;
  events: DurableEvent[];
};

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
    const cloudKey = await this.headCloudKey(session.id);
    const bytes = await this.sealHead({ version: 1, session: structuredClone(session), segments: [] });
    const result = await this.store.putIfAbsent(cloudKey, bytes);
    if (!result.created) throw new Error(`Session already exists: ${session.id}`);
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<SessionRecord | undefined> {
    const loaded = await this.loadHead(sessionId, signal);
    return loaded ? structuredClone(loaded.head.session) : undefined;
  }

  async listSessions(signal?: AbortSignal): Promise<SessionRecord[]> {
    const records = await this.store.list(`${this.prefix}/session-heads/`, signal);
    if (records.length > MAX_SESSIONS) throw new Error("Encrypted journal exceeds the client session limit.");
    const sessions = await Promise.all(
      records.map(async (summary) => {
        const record = await this.store.get(summary.key, signal);
        if (!record) throw new Error("An encrypted session head disappeared during listing.");
        const head = await this.openHeadRecord(record);
        return structuredClone(head.session);
      }),
    );
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readEvents(sessionId: string, afterSequence = 0, signal?: AbortSignal): Promise<DurableEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("Event cursor is invalid.");
    const loaded = await this.loadHead(sessionId, signal);
    if (!loaded) return [];
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
    expectedHead: { sequence: number; digest: string },
    events: DurableEvent[],
    signal?: AbortSignal,
  ): Promise<SessionRecord> {
    if (events.length === 0) {
      const session = await this.getSession(sessionId, signal);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      return session;
    }
    if (events.length > MAX_EVENTS_PER_SEGMENT) throw new Error("Encrypted journal append exceeds the segment event limit.");
    const loaded = await this.loadHead(sessionId, signal);
    if (!loaded) throw new Error(`Unknown session: ${sessionId}`);
    const current = loaded.head.session;
    if (current.headSequence !== expectedHead.sequence || current.headDigest !== expectedHead.digest) {
      throw new JournalConflictError();
    }
    validateAppend(sessionId, expectedHead, events);
    await verifyEventDigests(events);

    const first = events[0]!;
    const last = events.at(-1)!;
    const segmentLogicalId = `session:${sessionId}:events:${first.sequence}-${last.sequence}:${last.digest}`;
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
    const created = await this.store.putIfAbsent(segmentCloudKey, segmentBytes, signal);
    let segmentEtag: string;
    if (!created.created) {
      const existing = await this.store.get(segmentCloudKey, signal);
      if (!existing) throw new Error("Encrypted event segment conflicted and then disappeared.");
      segmentEtag = existing.etag;
      const existingSegment = await this.openSegmentRecord(existing, segmentLogicalId);
      await verifyEventDigests(existingSegment.events);
      if (stableStringify(existingSegment as unknown as JsonValue) !== stableStringify(segment as unknown as JsonValue)) {
        throw new Error("Encrypted event segment key collided with different content.");
      }
    } else {
      segmentEtag = created.etag;
    }

    const updated: SessionRecord = {
      ...current,
      updatedAt: last.recordedAt,
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
    };
    if (nextHead.segments.length > MAX_SEGMENTS_PER_SESSION) {
      throw new Error("Encrypted journal requires segment compaction before another append.");
    }
    const rootBytes = await this.sealHead(nextHead);
    const swapped = await this.store.compareAndSwap(loaded.record.key, loaded.record.etag, rootBytes, signal);
    if (!swapped.updated) throw new JournalConflictError();
    return structuredClone(updated);
  }

  private async loadHead(sessionId: string, signal?: AbortSignal): Promise<{ record: ObjectRecord; head: SessionHead } | undefined> {
    const record = await this.store.get(await this.headCloudKey(sessionId), signal);
    if (!record) return undefined;
    const head = await this.openHeadRecord(record, sessionId);
    return { record, head };
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
      revision: `${head.session.headSequence}:${head.session.headDigest}`,
      contentType: "application/vnd.airship.session-head+json",
      plaintext: encodeJson(head),
    });
    return encodeEnvelope(envelope);
  }

  private async openHeadRecord(record: ObjectRecord, expectedSessionId?: string): Promise<SessionHead> {
    const envelope = decodeEnvelope(record.bytes);
    const plaintext = await openEnvelope({
      key: this.key,
      envelope,
      expectedNamespace: ROOT_NAMESPACE,
      expectedLogicalId: expectedSessionId ? headLogicalId(expectedSessionId) : undefined,
      maxPlaintextBytes: 32 * 1024 * 1024,
    });
    const head = parseHead(plaintext);
    if (expectedSessionId && head.session.id !== expectedSessionId) throw new Error("Encrypted session head ID does not match its key.");
    if (record.key !== (await this.headCloudKey(head.session.id))) throw new Error("Encrypted session head is stored under the wrong opaque key.");
    if (
      envelope.revision !== `${head.session.headSequence}:${head.session.headDigest}` ||
      envelope.aad.contentType !== "application/vnd.airship.session-head+json"
    ) {
      throw new Error("Encrypted session head metadata does not match its contents.");
    }
    return head;
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
  return { version: 1, session: structuredClone(value.session), segments };
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
    "remote-confidential",
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
    if (
      binding.version !== 1 ||
      modelId !== value.model ||
      !["oauth-pkce", "api-key", "local-none"].includes(String(binding.authMethod)) ||
      !["e2ee-attestable", "provider-tls", "loopback-local"].includes(String(binding.transportBoundary)) ||
      !Number.isFinite(Date.parse(String(binding.boundAt)))
    ) throw new Error("Encrypted session inference binding is invalid.");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
