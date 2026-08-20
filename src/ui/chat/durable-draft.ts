import { type WorkspacePort } from "../../workspace/contracts";

/**
 * The unsent draft, kept in the same store as the transcript it belongs to.
 *
 * Measured in the Journey Atlas with the encrypted Local Device Vault active:
 * `textarea.value` before reload was "and one more thing I still need to check
 * before Friday"; after reload `""`; after a full browser restart `""`. Same
 * URL, same conversation restored, no notice. The person had paid for
 * durability and the one thing they had not finished saying was the one thing
 * Airship threw away.
 *
 * `thread-draft.ts` keeps the fast copy in `sessionStorage`, which is the right
 * home for a page-memory session — tab-scoped text under a posture whose own
 * claim is "Ephemeral · this page only". It is the wrong home for a session
 * whose journal is durable and encrypted, and `localStorage` would be worse
 * still: plaintext on disk under a chip that reads "Encrypted · this device"
 * is a weaker durability boundary than the screen claims. So the durable copy goes
 * through the adopted Vault's own workspace port, encrypted by the same
 * envelope as everything else it holds, under the reserved `.airship` tree that
 * `isWorkspaceControlPlanePath` already keeps out of retrieval, Git and the
 * file view.
 *
 * The caller passes the *Profile's* workspace port rather than the storage
 * authority: profiles are real silos, and a draft is as profile-local as the
 * conversation it belongs to. It is also the port whose identity holds still —
 * measured, `runtime.storage` was the profile-scoped port on the frame that
 * wrote and the authority-level port on the boot that read, so the draft was
 * written to one path and looked for at another.
 */

/** Reserved, control-plane, and therefore invisible to model context and Git. */
export const DURABLE_DRAFT_ROOT = "/workspace/.airship/composer-drafts/v1";

/**
 * The same ceiling `thread-draft.ts` applies to the tab-scoped copy. It is
 * restated rather than imported because the two modules are owned by different
 * passes; if they are ever merged, this is the constant to delete.
 */
const MAX_DRAFT_CHARS = 100_000;

export function durableDraftPath(sessionId: string): string {
  // Conversation identities are opaque UUIDs, but encoding keeps a future
  // identity scheme from writing a path separator into the reserved tree.
  return `${DURABLE_DRAFT_ROOT}/${encodeURIComponent(sessionId)}.json`;
}

export async function readDurableDraft(
  port: WorkspacePort,
  sessionId: string,
): Promise<string> {
  try {
    const file = await port.read(durableDraftPath(sessionId));
    if (!file) return "";
    const parsed: unknown = JSON.parse(file.content);
    if (typeof parsed !== "object" || parsed === null) return "";
    const prompt = (parsed as Record<string, unknown>).prompt;
    return typeof prompt === "string" ? prompt.slice(0, MAX_DRAFT_CHARS) : "";
  } catch {
    // A draft that cannot be read is a draft that was not there. Never a reason
    // to fail the composer the person is typing into.
    return "";
  }
}

export async function writeDurableDraft(
  port: WorkspacePort,
  sessionId: string,
  prompt: string,
): Promise<void> {
  const path = durableDraftPath(sessionId);
  try {
    if (!prompt) {
      await port.remove(path);
      return;
    }
    await port.write(path, JSON.stringify({ prompt: prompt.slice(0, MAX_DRAFT_CHARS) }));
  } catch {
    // Removing a draft that was never written throws, and so does a quota
    // refusal. Neither changes what is on screen, which remains authoritative.
  }
}
