import type { JsonValue } from "../core/contracts";
import type { DurableEvent, EventJournal, SessionRecord } from "../core/journal";

export const PROFILE_FAVORITE_ORDER_MOVED_EVENT_TYPE = "profile.favorite-order.moved";

export type SessionFavorite = Readonly<{
  sessionId: string;
  pinnedAt: string;
  /** The current `true` membership event. Old move events cannot cross a re-pin. */
  membershipEventId: string;
}>;

export type ProfileFavoriteMove = Readonly<{
  version: 1;
  profileId: string;
  sessionId: string;
  favoriteEventId: string;
  generation: number;
  previousEventId?: string;
  beforeSessionId?: string;
  beforeFavoriteEventId?: string;
  eventId: string;
  recordedAt: string;
  hostSessionId: string;
}>;

export type ProfileFavoriteOrderResolution = Readonly<{
  profileId: string;
  favorites: readonly SessionFavorite[];
  latestMove?: ProfileFavoriteMove;
}>;

/**
 * Project one profile's favorite list from append-only membership and move
 * facts. Every move is bound to the moved favorite's current membership event
 * (and, when present, the anchor's), so removing and later re-adding a favorite
 * cannot resurrect an obsolete position.
 *
 * Move generations are Lamport counters. Equal-generation concurrent moves
 * are replayed by persisted timestamp, event ID, and host session ID. Distinct
 * concurrent moves therefore both survive; concurrent moves of the same item
 * have one deterministic last writer. Every reader converges without mutating
 * or replacing a prior journal record.
 */
export async function resolveProfileFavoriteOrder(
  journal: EventJournal,
  profileId: string,
  signal?: AbortSignal,
): Promise<ProfileFavoriteOrderResolution> {
  assertIdentifier(profileId, "Profile ID");
  signal?.throwIfAborted();
  const sessions = (await journal.listSessions()).filter((session) =>
    session.manifest.profile?.profileId === profileId,
  );
  signal?.throwIfAborted();
  const histories = await Promise.all(sessions.map(async (session) => Object.freeze({
    session,
    events: await journal.readEvents(session.id, 0, signal),
  })));
  signal?.throwIfAborted();

  const memberships = new Map<string, SessionFavorite>();
  const moves: ProfileFavoriteMove[] = [];
  for (const history of histories) {
    const membership = currentMembership(history.session, history.events);
    if (membership) memberships.set(history.session.id, membership);
    for (const event of history.events) {
      const move = profileFavoriteMove(event, history.session, profileId);
      if (move) moves.push(move);
    }
  }

  const ordered = [...memberships.values()].sort(compareMemberships);
  moves.sort(compareMovesOldestFirst);
  for (const move of moves) {
    const membership = memberships.get(move.sessionId);
    if (!membership || membership.membershipEventId !== move.favoriteEventId) continue;
    let insertion = ordered.length;
    if (move.beforeSessionId && move.beforeFavoriteEventId) {
      const anchor = memberships.get(move.beforeSessionId);
      if (!anchor || anchor.membershipEventId !== move.beforeFavoriteEventId) continue;
      insertion = ordered.findIndex((favorite) => favorite.sessionId === move.beforeSessionId);
      if (insertion < 0) continue;
    }
    const current = ordered.findIndex((favorite) => favorite.sessionId === move.sessionId);
    if (current < 0) continue;
    const [moved] = ordered.splice(current, 1);
    if (!moved) continue;
    if (current < insertion) insertion -= 1;
    ordered.splice(Math.max(0, Math.min(insertion, ordered.length)), 0, moved);
  }

  return deepFreeze({
    profileId,
    favorites: ordered,
    ...(moves.length ? { latestMove: moves.at(-1) } : {}),
  });
}

/** Strict parser shared by projection, audit-oriented tests, and diagnostics. */
export function profileFavoriteMove(
  event: DurableEvent,
  host: Pick<SessionRecord, "id" | "manifest">,
  expectedProfileId?: string,
): ProfileFavoriteMove | undefined {
  if (event.type !== PROFILE_FAVORITE_ORDER_MOVED_EVENT_TYPE || event.turnId || event.operationId) return undefined;
  const payload = plainRecord(event.payload);
  if (
    !payload
    || payload.version !== 1
    || !boundedIdentifier(payload.profileId)
    || !boundedIdentifier(payload.sessionId)
    || !boundedIdentifier(payload.favoriteEventId)
    || !Number.isSafeInteger(payload.generation)
    || (payload.generation as number) < 1
    || (payload.previousEventId !== undefined && !boundedIdentifier(payload.previousEventId))
    || (payload.beforeSessionId !== undefined && !boundedIdentifier(payload.beforeSessionId))
    || (payload.beforeFavoriteEventId !== undefined && !boundedIdentifier(payload.beforeFavoriteEventId))
    || (payload.beforeSessionId === undefined) !== (payload.beforeFavoriteEventId === undefined)
    || payload.sessionId !== host.id
    || payload.profileId !== host.manifest.profile?.profileId
    || (expectedProfileId !== undefined && payload.profileId !== expectedProfileId)
    || (payload.beforeSessionId !== undefined && payload.beforeSessionId === payload.sessionId)
  ) return undefined;
  return Object.freeze({
    version: 1,
    profileId: payload.profileId as string,
    sessionId: payload.sessionId as string,
    favoriteEventId: payload.favoriteEventId as string,
    generation: payload.generation as number,
    ...(typeof payload.previousEventId === "string" ? { previousEventId: payload.previousEventId } : {}),
    ...(typeof payload.beforeSessionId === "string" ? {
      beforeSessionId: payload.beforeSessionId,
      beforeFavoriteEventId: payload.beforeFavoriteEventId as string,
    } : {}),
    eventId: event.eventId,
    recordedAt: event.recordedAt,
    hostSessionId: event.sessionId,
  });
}

/** Build the next immutable move payload from an authoritative resolution. */
export function nextFavoriteMovePayload(
  resolution: ProfileFavoriteOrderResolution,
  sessionId: string,
  beforeSessionId?: string,
): JsonValue {
  const moved = resolution.favorites.find((favorite) => favorite.sessionId === sessionId);
  if (!moved) throw new Error("Only a current favorite can be reordered.");
  const anchor = beforeSessionId === undefined
    ? undefined
    : resolution.favorites.find((favorite) => favorite.sessionId === beforeSessionId);
  if (beforeSessionId !== undefined && !anchor) {
    throw new Error("The favorite-order anchor is not in the active profile.");
  }
  if (anchor?.sessionId === moved.sessionId) {
    throw new Error("A favorite cannot be ordered before itself.");
  }
  const generation = (resolution.latestMove?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("The favorite-order generation is exhausted.");
  }
  return {
    version: 1,
    profileId: resolution.profileId,
    sessionId,
    favoriteEventId: moved.membershipEventId,
    generation,
    ...(resolution.latestMove ? { previousEventId: resolution.latestMove.eventId } : {}),
    ...(anchor ? {
      beforeSessionId: anchor.sessionId,
      beforeFavoriteEventId: anchor.membershipEventId,
    } : {}),
  };
}

function currentMembership(
  session: SessionRecord,
  events: readonly DurableEvent[],
): SessionFavorite | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "session.favorite.changed" || event.turnId || event.operationId) continue;
    const payload = plainRecord(event.payload);
    if (!payload || typeof payload.favorite !== "boolean") continue;
    return payload.favorite
      ? Object.freeze({
        sessionId: session.id,
        pinnedAt: event.recordedAt,
        membershipEventId: event.eventId,
      })
      : undefined;
  }
  return undefined;
}

function compareMemberships(left: SessionFavorite, right: SessionFavorite): number {
  return left.pinnedAt.localeCompare(right.pinnedAt)
    || left.membershipEventId.localeCompare(right.membershipEventId)
    || left.sessionId.localeCompare(right.sessionId);
}

function compareMovesOldestFirst(left: ProfileFavoriteMove, right: ProfileFavoriteMove): number {
  return left.generation - right.generation
    || left.recordedAt.localeCompare(right.recordedAt)
    || left.eventId.localeCompare(right.eventId)
    || left.hostSessionId.localeCompare(right.hostSessionId);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function assertIdentifier(value: string, label: string): void {
  if (!boundedIdentifier(value)) throw new TypeError(`${label} is invalid.`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
