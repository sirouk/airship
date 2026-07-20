const pagePins = new Set<string>();

/** Page-lifetime preference store: survives route remounts and never claims durable sync. */
export function pagePinnedSessionIds(): ReadonlySet<string> {
  return new Set(pagePins);
}

export function setPageSessionPinned(sessionId: string, pinned: boolean): ReadonlySet<string> {
  if (pinned) pagePins.add(sessionId);
  else pagePins.delete(sessionId);
  return pagePinnedSessionIds();
}

export function groupPinnedSessions<T extends Readonly<{ id: string }>>(items: readonly T[], pinned: ReadonlySet<string>): Readonly<{ pinned: readonly T[]; other: readonly T[] }> {
  return Object.freeze({ pinned: items.filter((item) => pinned.has(item.id)), other: items.filter((item) => !pinned.has(item.id)) });
}

export function clearPageSessionPinsForTest(): void { pagePins.clear(); }
