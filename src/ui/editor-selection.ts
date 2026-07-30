import type { WorkspaceFile } from "../workspace/contracts";

/**
 * The document the editor holds, and the profile that is allowed to see it.
 *
 * A workspace file is profile-owned material, so the selection carries the
 * owner rather than trusting whatever profile happens to be active at paint.
 */
export type EditorSelection = Readonly<{
  profileId: string;
  file: WorkspaceFile;
}>;

/**
 * What the editor should be holding after an open request resolves.
 *
 * The rule that matters is the failure case. A path that no longer resolves
 * used to blank the selection unconditionally, which meant a click on a stale
 * Memory source — or a tree entry for a file deleted underneath the page —
 * closed whatever unrelated document you were reading, while the caller
 * announced "No document was opened". Something *was* closed; the sentence was
 * false, and the state it destroyed was not the failing request's to destroy.
 *
 * So a failed open closes exactly one thing: itself. If the path that failed is
 * the path on screen, the document is dropped, because it no longer has a file
 * behind it — leaving it up would render deleted content as live and let a save
 * silently recreate the file. Any other path leaves the selection alone.
 *
 * A selection owned by a different profile is left alone in both directions: it
 * is already invisible to the active profile, and a failed open is not a reason
 * to discard the document that profile will return to.
 */
export function nextEditorSelection(
  current: EditorSelection | undefined,
  request: Readonly<{ path: string; ownerProfileId: string; file: WorkspaceFile | undefined }>,
): EditorSelection | undefined {
  if (request.file) return Object.freeze({ profileId: request.ownerProfileId, file: request.file });
  if (current?.profileId !== request.ownerProfileId) return current;
  return current.file.path === request.path ? undefined : current;
}
