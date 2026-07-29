const VIEWPORT_PREFIX = "airship.chat-viewport.v1";
const MAX_SCROLL_TOP = 100_000_000;

export type ThreadViewportState = Readonly<{
  scrollTop: number;
  pinnedToLatest: boolean;
}>;

/** Resolve browser storage behind a privacy-policy fence; even the getter may throw. */
export function browserThreadViewportStorage(
  access: () => Storage = () => globalThis.sessionStorage,
): Storage | undefined {
  try {
    return access();
  } catch {
    return undefined;
  }
}

/**
 * A collision-free browser-session key for one Profile-owned conversation.
 *
 * Session ids are globally opaque in the current journal, but Profile is part
 * of the key deliberately: the presentation boundary remains explicit even if
 * a future imported journal contains an id that another Profile also uses.
 */
export function threadViewportStorageKey(profileId: string, sessionId: string): string {
  return `${VIEWPORT_PREFIX}.${identitySegment(profileId, "Profile ID")}.${identitySegment(sessionId, "Session ID")}`;
}

export function readThreadViewport(
  profileId: string,
  sessionId: string,
  storage: Pick<Storage, "getItem"> | undefined,
): ThreadViewportState | undefined {
  if (!storage) return undefined;
  try {
    const value = JSON.parse(storage.getItem(threadViewportStorageKey(profileId, sessionId)) ?? "null") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.scrollTop !== "number" || !Number.isFinite(record.scrollTop)) return undefined;
    if (typeof record.pinnedToLatest !== "boolean") return undefined;
    return Object.freeze({
      scrollTop: boundedScrollTop(record.scrollTop),
      pinnedToLatest: record.pinnedToLatest,
    });
  } catch {
    return undefined;
  }
}

export function writeThreadViewport(
  profileId: string,
  sessionId: string,
  state: ThreadViewportState,
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(threadViewportStorageKey(profileId, sessionId), JSON.stringify({
      scrollTop: boundedScrollTop(state.scrollTop),
      pinnedToLatest: state.pinnedToLatest,
    }));
  } catch {
    // Optional browser-session presentation state never changes journal truth.
  }
}

function boundedScrollTop(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_SCROLL_TOP, Math.max(0, Math.round(value)))
    : 0;
}

function identitySegment(value: string, label: string): string {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid for transcript viewport state.`);
  }
  const points = [...value];
  return `${String(points.length)}-${points.map((point) => point.codePointAt(0)!.toString(16)).join("-")}`;
}
