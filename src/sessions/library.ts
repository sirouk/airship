import type { SessionManifest } from "../core/contracts";
import { JournalConflictError, type EventJournal, type SessionRecord } from "../core/journal";
import {
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
import {
  resolveProfileActiveConversation,
  selectProfileActiveConversation,
  type ProfileActiveConversationResolution,
  type SelectProfileActiveConversationResult,
} from "./profile-cockpit";
import {
  nextFavoriteMovePayload,
  PROFILE_FAVORITE_ORDER_MOVED_EVENT_TYPE,
  resolveProfileFavoriteOrder,
  type SessionFavorite,
} from "./favorite-order";

export type { SessionFavorite } from "./favorite-order";

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
  /** Audited quiescent boundary: a terminal turn or a between-turn session-scoped record. */
  sourcePoint?: Readonly<{ sequence: number; digest: string }>;
  signal?: AbortSignal;
}>;

export type SessionForkResult = Readonly<{
  sourceSessionId: string;
  /** Source journal snapshot observed and rechecked before destination creation. */
  sourceHeadSequence: number;
  sourceHeadDigest: string;
  /** Audited source prefix represented by the fresh destination context seed. */
  sourceBoundarySequence: number;
  sourceBoundaryDigest: string;
  session: SessionRecord;
  historyCopied: false;
  contextSeeded: true;
  contextMessageCount: number;
  omittedContextMessages: number;
  omittedContextImages: number;
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
    // Preference writes advance the immutable journal head, but starring or
    // reordering a thread is not conversation activity. Present a derived
    // activity time to recency surfaces so those operations never reshuffle
    // the Recent group. `inspect()` still returns the exact record timestamp.
    const activityRecords = await Promise.all(records.map(async (record) => {
      const events = await this.journal.readEvents(record.id, 0, signal);
      throwIfAborted(signal);
      const activity = [...events].reverse().find((event) =>
        event.type !== "session.favorite.changed"
        && event.type !== PROFILE_FAVORITE_ORDER_MOVED_EVENT_TYPE,
      );
      return activity && activity.recordedAt !== record.updatedAt
        ? { ...record, updatedAt: activity.recordedAt }
        : record;
    }));
    return querySessionRecords(activityRecords, query);
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
    const { forkSession } = await import("./session-fork");
    return forkSession(this.journal, this.limits, this.now, sourceSessionId, request);
  }

  async rename(sessionId: string, title: string): Promise<SessionRecord> {
    assertSessionId(sessionId);
    return this.journal.renameSession(sessionId, title);
  }

  /**
   * Favorites travel with the journal authority instead of a global browser
   * preference. Page-memory favorites therefore remain page-memory, while an
   * adopted encrypted journal makes the same preference durable.
   */
  async favorites(profileId: string, signal?: AbortSignal): Promise<readonly SessionFavorite[]> {
    return (await resolveProfileFavoriteOrder(this.journal, profileId, signal)).favorites;
  }

  async setFavorite(
    sessionId: string,
    profileId: string,
    favorite: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    assertSessionId(sessionId);
    throwIfAborted(signal);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await this.journal.getSession(sessionId, signal);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      if (session.manifest.profile?.profileId !== profileId) {
        throw new Error("A conversation can only be favorited from its active profile.");
      }
      const resolution = await resolveProfileFavoriteOrder(this.journal, profileId, signal);
      if (resolution.favorites.some((entry) => entry.sessionId === sessionId) === favorite) return;
      try {
        await this.journal.append(sessionId, [{ type: "session.favorite.changed", payload: { favorite } }], signal);
        return;
      } catch (error) {
        if (!(error instanceof JournalConflictError) || attempt === 2) throw error;
      }
    }
  }

  /**
   * Append a profile-local positional operation. `beforeSessionId` omitted
   * means move to the end. The result is the converged authoritative order,
   * including any same-generation move committed by another writer.
   */
  async moveFavoriteBefore(
    sessionId: string,
    profileId: string,
    beforeSessionId?: string,
    signal?: AbortSignal,
  ): Promise<readonly SessionFavorite[]> {
    assertSessionId(sessionId);
    if (beforeSessionId !== undefined) assertSessionId(beforeSessionId);
    throwIfAborted(signal);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resolution = await resolveProfileFavoriteOrder(this.journal, profileId, signal);
      const ids = resolution.favorites.map((favorite) => favorite.sessionId);
      const sourceIndex = ids.indexOf(sessionId);
      if (sourceIndex < 0) throw new Error("Only a current favorite can be reordered.");
      if (beforeSessionId === sessionId) return resolution.favorites;
      const desired = [...ids];
      desired.splice(sourceIndex, 1);
      const insertion = beforeSessionId === undefined ? desired.length : desired.indexOf(beforeSessionId);
      if (insertion < 0) throw new Error("The favorite-order anchor is not in the active profile.");
      desired.splice(insertion, 0, sessionId);
      if (desired.every((id, index) => id === ids[index])) return resolution.favorites;
      try {
        await this.journal.append(sessionId, [{
          type: PROFILE_FAVORITE_ORDER_MOVED_EVENT_TYPE,
          payload: nextFavoriteMovePayload(resolution, sessionId, beforeSessionId),
        }], signal);
        return (await resolveProfileFavoriteOrder(this.journal, profileId, signal)).favorites;
      } catch (error) {
        if (!(error instanceof JournalConflictError) || attempt === 2) throw error;
      }
    }
    return (await resolveProfileFavoriteOrder(this.journal, profileId, signal)).favorites;
  }

  /** Resolve the append-only pointer carried by this journal authority. */
  activeConversation(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<ProfileActiveConversationResolution> {
    return resolveProfileActiveConversation(this.journal, profileId, signal);
  }

  /** Commit one profile-local pointer selection, fenced to an audited head when supplied. */
  selectActiveConversation(
    profileId: string,
    sessionId: string,
    options: Readonly<{
      expectedTargetHead?: Readonly<{ sequence: number; digest: string }>;
      signal?: AbortSignal;
    }> = {},
  ): Promise<SelectProfileActiveConversationResult> {
    return selectProfileActiveConversation(this.journal, profileId, sessionId, options);
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

function sameHead(left: SessionRecord, right: SessionRecord): boolean {
  return left.headSequence === right.headSequence && left.headDigest === right.headDigest;
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
