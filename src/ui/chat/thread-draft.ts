const DRAFT_PREFIX = "airship.chat-draft.v1.";
const MAX_DRAFT_CHARS = 100_000;

export function readThreadDraft(sessionId: string, storage: Pick<Storage, "getItem">): string {
  try {
    const value = storage.getItem(threadDraftKey(sessionId));
    if (!value) return "";
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.prompt === "string" ? parsed.prompt.slice(0, MAX_DRAFT_CHARS) : "";
  } catch {
    return "";
  }
}

export function writeThreadDraft(
  sessionId: string,
  prompt: string,
  storage: Pick<Storage, "setItem" | "removeItem">,
): void {
  const key = threadDraftKey(sessionId);
  if (!prompt) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify({ prompt: prompt.slice(0, MAX_DRAFT_CHARS) }));
}

export function threadDraftKey(sessionId: string): string {
  // Session identities are already opaque. Keeping the complete encoded value
  // avoids the cross-conversation collision risk of a shortened client hash.
  return `${DRAFT_PREFIX}${encodeURIComponent(sessionId)}`;
}
