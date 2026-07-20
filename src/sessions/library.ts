import type { SessionManifest } from "../core/contracts";
import type { EventJournal, SessionRecord } from "../core/journal";
import {
  assessSessionHistory,
  decideSessionResume,
  extractSessionPins,
  materializeSessionMessages,
  querySessionRecords,
  type ActiveSessionRuntime,
  type SessionHistoryAssessment,
  type SessionInspectionLimits,
  type SessionListPage,
  type SessionListQuery,
  type SessionMaterialization,
  type SessionPins,
  type SessionResumeCompatibility,
} from "./domain";
import { assessSessionHistoryAsync } from "./async-assessment";

export type SessionLibraryDetail = Readonly<{
  session: SessionRecord;
  pins: SessionPins;
  history: SessionHistoryAssessment;
  transcript: SessionMaterialization;
  compatibility?: SessionResumeCompatibility;
  snapshotStable: boolean;
}>;

export type ForkSessionRequest = Readonly<{
  title?: string;
  manifest?: SessionManifest;
  expectedSourceHead?: Readonly<{ sequence: number; digest: string }>;
  /** Audited historical turn boundary to commit as the fork ancestor. */
  sourcePoint?: Readonly<{ sequence: number; digest: string }>;
  signal?: AbortSignal;
}>;

export type SessionForkResult = Readonly<{
  sourceSessionId: string;
  sourceHeadSequence: number;
  sourceHeadDigest: string;
  session: SessionRecord;
  historyCopied: false;
  abortRequestedAfterCommit: boolean;
}>;

export type SessionLibraryOptions = Readonly<{
  inspectionLimits?: Partial<SessionInspectionLimits>;
  now?: () => string;
}>;

export class SessionForkConflictError extends Error {
  constructor(message = "The source session changed before the fork could be created.") {
    super(message);
    this.name = "SessionForkConflictError";
  }
}

/**
 * Browser-native read/fork facade over EventJournal. It does not invent a
 * remote sync state and it never accepts or retains provider credentials.
 */
export class SessionLibrary {
  private readonly limits: Partial<SessionInspectionLimits>;
  private readonly now: () => string;

  constructor(
    private readonly journal: EventJournal,
    options: SessionLibraryOptions = {},
  ) {
    this.limits = Object.freeze({ ...(options.inspectionLimits ?? {}) });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async list(query: SessionListQuery = {}, signal?: AbortSignal): Promise<SessionListPage> {
    throwIfAborted(signal);
    const records = await this.journal.listSessions();
    throwIfAborted(signal);
    return querySessionRecords(records, query);
  }

  async inspect(
    sessionId: string,
    runtime?: ActiveSessionRuntime,
    signal?: AbortSignal,
  ): Promise<SessionLibraryDetail> {
    assertSessionId(sessionId);
    throwIfAborted(signal);
    const snapshot = await this.readSnapshot(sessionId, signal);
    const history = await assessSessionHistoryAsync(snapshot.session, snapshot.events, {
      limits: this.limits,
      snapshotStable: snapshot.stable,
      signal,
    });
    const pins = extractSessionPins(snapshot.session, snapshot.events);
    const transcript = materializeSessionMessages(snapshot.events, this.limits, snapshot.session.id);
    return deepFreeze({
      session: structuredClone(snapshot.session),
      pins,
      history,
      transcript,
      ...(runtime ? { compatibility: decideSessionResume(pins, history, runtime) } : {}),
      snapshotStable: snapshot.stable,
    });
  }

  async fork(sourceSessionId: string, request: ForkSessionRequest = {}): Promise<SessionForkResult> {
    assertSessionId(sourceSessionId);
    throwIfAborted(request.signal);
    const source = await this.journal.getSession(sourceSessionId);
    throwIfAborted(request.signal);
    if (!source) throw new Error(`Unknown session: ${sourceSessionId}`);
    if (
      request.expectedSourceHead &&
      (request.expectedSourceHead.sequence !== source.headSequence || request.expectedSourceHead.digest !== source.headDigest)
    ) {
      throw new SessionForkConflictError();
    }
    let ancestor = { sequence: source.headSequence, digest: source.headDigest };
    if (request.sourcePoint) {
      const events = await this.journal.readEvents(source.id);
      throwIfAborted(request.signal);
      const genesis = request.sourcePoint.sequence === 0 && request.sourcePoint.digest === "genesis";
      const point = events.find((event) => event.sequence === request.sourcePoint!.sequence);
      if (!genesis && (!point || point.digest !== request.sourcePoint.digest || !isForkBoundary(point.type))) {
        throw new SessionForkConflictError("The requested historical fork point is not an audited completed-turn boundary.");
      }
      const fresh = await this.journal.getSession(source.id);
      if (!fresh || !sameHead(source, fresh)) throw new SessionForkConflictError();
      ancestor = genesis ? { sequence: 0, digest: "genesis" } : { sequence: point!.sequence, digest: point!.digest };
    }

    const forkedAt = this.now();
    if (!Number.isFinite(Date.parse(forkedAt))) throw new Error("The session library clock returned an invalid timestamp.");
    const title = forkTitle(request.title, source.title);
    const manifest = structuredClone(request.manifest ?? source.manifest);
    manifest.createdAt = forkedAt;
    manifest.lineage = {
      version: 1,
      kind: "fork",
      sourceSessionId: source.id,
      sourceHeadSequence: ancestor.sequence,
      sourceHeadDigest: ancestor.digest,
      forkedAt,
    };
    validateForkManifest(manifest);

    // Fork lineage is a commitment to a specific source head. Recheck as late
    // as possible before the cross-session mutation so an append racing the
    // manifest preparation cannot silently produce stale ancestry.
    if (request.expectedSourceHead) {
      const fresh = await this.journal.getSession(source.id);
      throwIfAborted(request.signal);
      if (
        !fresh ||
        fresh.headSequence !== request.expectedSourceHead.sequence ||
        fresh.headDigest !== request.expectedSourceHead.digest
      ) {
        throw new SessionForkConflictError();
      }
    }

    // No abort check after this mutation boundary: if the journal commits while
    // cancellation races, returning the committed identity avoids an ambiguous retry.
    const created = await this.journal.createSession(title, manifest);
    if (created.id === source.id) throw new Error("The journal reused the source session identity for a fork.");
    return deepFreeze({
      sourceSessionId: source.id,
      sourceHeadSequence: ancestor.sequence,
      sourceHeadDigest: ancestor.digest,
      session: structuredClone(created),
      historyCopied: false,
      abortRequestedAfterCommit: request.signal?.aborted ?? false,
    });
  }

  async rename(sessionId: string, title: string): Promise<SessionRecord> {
    assertSessionId(sessionId);
    return this.journal.renameSession(sessionId, title);
  }

  private async readSnapshot(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ session: SessionRecord; events: Awaited<ReturnType<EventJournal["readEvents"]>>; stable: boolean }>> {
    let lastSession: SessionRecord | undefined;
    let lastEvents: Awaited<ReturnType<EventJournal["readEvents"]>> = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await this.journal.getSession(sessionId);
      throwIfAborted(signal);
      if (!before) throw new Error(`Unknown session: ${sessionId}`);
      const events = await this.journal.readEvents(sessionId);
      throwIfAborted(signal);
      const after = await this.journal.getSession(sessionId);
      throwIfAborted(signal);
      if (!after) throw new Error(`Session disappeared while reading: ${sessionId}`);
      lastSession = after;
      lastEvents = events;
      if (sameHead(before, after)) return { session: after, events, stable: true };
    }
    return { session: lastSession!, events: lastEvents, stable: false };
  }
}

function isForkBoundary(type: string): boolean {
  return type === "turn.completed" || type === "local.command.completed" || type === "local.command.failed";
}

function sameHead(left: SessionRecord, right: SessionRecord): boolean {
  return left.headSequence === right.headSequence && left.headDigest === right.headDigest;
}

function forkTitle(requested: string | undefined, sourceTitle: string): string {
  const title = (requested ?? `${sourceTitle} · fork`).trim();
  if (!title || title.length > 240 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(title)) {
    throw new TypeError("Fork title must be between 1 and 240 printable characters.");
  }
  return title;
}

function validateForkManifest(manifest: SessionManifest): void {
  if (
    manifest.protocolVersion !== 1 ||
    !manifest.providerId ||
    manifest.providerId.length > 256 ||
    !manifest.model ||
    manifest.model.length > 512 ||
    !manifest.workspaceId ||
    manifest.workspaceId.length > 2_048 ||
    !manifest.systemPromptDigest ||
    !manifest.toolManifestDigest ||
    !Array.isArray(manifest.tools)
  ) {
    throw new TypeError("Fork manifest does not satisfy the bounded session protocol-v1 shape.");
  }
}

function assertSessionId(value: string): void {
  if (!value || value.length > 512 || /[\u0000-\u001F\u007F]/u.test(value)) throw new TypeError("Session ID is invalid.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (typeof DOMException !== "undefined") throw new DOMException("The operation was cancelled.", "AbortError");
  const error = new Error("The operation was cancelled.");
  error.name = "AbortError";
  throw error;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
