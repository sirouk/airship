export type FavoriteMoveIntent = Readonly<{
  changed: boolean;
  /** Omitted means append after every current favorite. */
  beforeSessionId?: string;
}>;

/** Split an already-authoritative favorite order without owning persistence. */
export function groupPinnedSessions<T extends Readonly<{ id: string }>>(
  items: readonly T[],
  favoriteOrder: readonly string[] | ReadonlySet<string>,
): Readonly<{ pinned: readonly T[]; other: readonly T[] }> {
  const order = Array.isArray(favoriteOrder) ? favoriteOrder : [...favoriteOrder];
  const position = new Map(order.map((id, index) => [id, index] as const));
  return Object.freeze({
    pinned: items
      .filter((item) => position.has(item.id))
      .sort((left, right) => position.get(left.id)! - position.get(right.id)!),
    other: items.filter((item) => !position.has(item.id)),
  });
}

/** Translate an accessible one-step move into the journal's before-anchor. */
export function favoriteDirectionalMove(
  orderedIds: readonly string[],
  sessionId: string,
  direction: -1 | 1,
): FavoriteMoveIntent {
  const source = orderedIds.indexOf(sessionId);
  const target = source + direction;
  if (source < 0 || target < 0 || target >= orderedIds.length) return Object.freeze({ changed: false });
  return favoriteDropMove(orderedIds, sessionId, orderedIds[target]!);
}

/** Place the source at the target row's current position. */
export function favoriteDropMove(
  orderedIds: readonly string[],
  sourceSessionId: string,
  targetSessionId: string,
): FavoriteMoveIntent {
  const source = orderedIds.indexOf(sourceSessionId);
  const target = orderedIds.indexOf(targetSessionId);
  if (source < 0 || target < 0 || source === target) return Object.freeze({ changed: false });
  const beforeSessionId = source < target ? orderedIds[target + 1] : targetSessionId;
  return Object.freeze({ changed: true, ...(beforeSessionId ? { beforeSessionId } : {}) });
}
