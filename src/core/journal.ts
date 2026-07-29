import type { JsonValue, SessionManifest } from "./contracts";
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
};

export interface JournalBackend {
  createSession(session: SessionRecord, signal?: AbortSignal): Promise<void>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<SessionRecord | undefined>;
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>;
  readEvents(sessionId: string, afterSequence?: number, signal?: AbortSignal): Promise<DurableEvent[]>;
  append(
    sessionId: string,
    expectedHead: { sequence: number; digest: string },
    events: DurableEvent[],
    signal?: AbortSignal,
  ): Promise<SessionRecord>;
}

export class JournalConflictError extends Error {
  constructor(message = "The session head changed while appending events.") {
    super(message);
    this.name = "JournalConflictError";
  }
}

export class EventJournal {
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

  listSessions() {
    return this.backend.listSessions();
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

  async append(sessionId: string, drafts: EventDraft[], signal?: AbortSignal): Promise<DurableEvent[]> {
    if (!drafts.length) return [];
    signal?.throwIfAborted();
    const session = await this.backend.getSession(sessionId, signal);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);

    let sequence = session.headSequence;
    let previousDigest = session.headDigest;
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

    await this.backend.append(
      sessionId,
      { sequence: session.headSequence, digest: session.headDigest },
      events,
      signal,
    );
    return events;
  }
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
