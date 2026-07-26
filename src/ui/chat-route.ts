const CHAT_ROUTE_PREFIX = "#chat/";
const MAX_SESSION_ID_LENGTH = 512;

/**
 * An addressable conversation route. The journal session ID is already an
 * opaque, random identifier; the URL only names it and never carries message
 * content, credentials, or a storage location.
 */
export function chatHash(sessionId?: string): string {
  if (!sessionId) return "#chat";
  const normalized = validSessionId(sessionId);
  if (!normalized) throw new TypeError("The conversation ID is not URL-safe.");
  return `${CHAT_ROUTE_PREFIX}${encodeURIComponent(normalized)}`;
}

/** Returns the opaque conversation ID from a chat hash, or undefined. */
export function chatSessionIdFromHash(hash: string): string | undefined {
  const route = hash.split("?", 1)[0] ?? "";
  if (!route.startsWith(CHAT_ROUTE_PREFIX)) return undefined;
  const encoded = route.slice(CHAT_ROUTE_PREFIX.length);
  if (!encoded) return undefined;
  try {
    return validSessionId(decodeURIComponent(encoded));
  } catch {
    return undefined;
  }
}

export function isAddressedChatHash(hash: string): boolean {
  return chatSessionIdFromHash(hash) !== undefined;
}

function validSessionId(value: string): string | undefined {
  if (
    value.length < 1
    || value.length > MAX_SESSION_ID_LENGTH
    || /[\u0000-\u001f\u007f/?#]/u.test(value)
    || value.trim() !== value
  ) return undefined;
  return value;
}
