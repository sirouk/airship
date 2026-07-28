/**
 * The workbench's pure decisions, kept out of the view so each one can fail a
 * test on its own.
 *
 * Everything here answers a question the shipped workbench answered wrongly by
 * accident: which route am I, what does this tab say when it does not fit, how
 * wide may the rail get, and when does a progress message stop being true.
 */

export type WorkbenchRoute = "workspace" | "editor";

export type WorkbenchPane = "navigation" | "editor";

export type WorkbenchIdentity = Readonly<{
  route: WorkbenchRoute;
  /** `<RouteHeader routeId>`: the hash without its `#`, so the ⓘ memory is per destination. */
  routeId: string;
  title: string;
  eyebrow: string;
  description: string;
  /** Which pane a fresh arrival at this destination lands in. */
  opensPane: WorkbenchPane;
}>;

/**
 * The sentence the route header used to burn 45px of Georgia on. It is passed
 * verbatim to `<RouteHeader description>`, which at `tool` density makes it the
 * ⓘ panel's body — one gesture, keyboard-reachable, never deleted.
 */
export const WORKBENCH_DESCRIPTION =
  "Files, version-fenced editing, and browser-native source control share one workspace.";

/**
 * Stated on both destinations because it is the fact the shipped UI hid: the
 * sidebar's "Workspace" and "Editor" rows are two doors into one surface, and
 * for three names on one screen that was the honest thing nobody said.
 */
export const WORKBENCH_SHARED_SURFACE_NOTE =
  "Workspace and Editor are two doors into this one surface. Workspace opens the file tree; Editor opens the file you last had open. Files, tabs and drafts are the same in both.";

/**
 * Which destination is being rendered, from the location hash.
 *
 * `app.tsx` renders one component for `#workspace` and `#editor` and passes no
 * discriminator, so the hash is the only honest source of the answer available
 * here. An unknown hash resolves to `workspace`, never to a third name.
 */
export function workbenchIdentity(hash: string): WorkbenchIdentity {
  const route: WorkbenchRoute = hash.replace(/^#/u, "").split("?")[0] === "editor" ? "editor" : "workspace";
  return Object.freeze({
    route,
    routeId: route,
    title: route === "editor" ? "Editor" : "Workspace",
    eyebrow: "Device-executed · page workspace",
    description: WORKBENCH_DESCRIPTION,
    opensPane: route === "editor" ? "editor" : "navigation",
  });
}

/**
 * The parent directory each open tab needs in order to be distinguishable.
 *
 * Two tabs both reading `index.ts` are the same word twice; the qualifier is
 * empty for every basename that is already unique, so nothing gains decoration
 * it does not need.
 */
export function workbenchTabQualifiers(paths: readonly string[]): Readonly<Record<string, string>> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const qualifiers: Record<string, string> = {};
  for (const path of paths) {
    const lastSlash = path.lastIndexOf("/");
    const base = path.slice(lastSlash + 1);
    if ((counts.get(base) ?? 0) < 2) { qualifiers[path] = ""; continue; }
    const parent = path.slice(0, lastSlash);
    qualifiers[path] = parent.slice(parent.lastIndexOf("/") + 1);
  }
  return Object.freeze(qualifiers);
}

/** The rail's share of the workbench, as a percentage of the shell's width. */
export const WORKBENCH_RAIL_DEFAULT_PERCENT = 26;
export const WORKBENCH_RAIL_MIN_PERCENT = 12;
export const WORKBENCH_RAIL_MAX_PERCENT = 55;
/** One arrow-key press, in percentage points — about 16px on a 1440px shell. */
export const WORKBENCH_RAIL_STEP_PERCENT = 1.2;

/**
 * A rail width that can never starve the code column.
 *
 * The measured defect was a rail taking 357px of a 693px iPad workbench, so the
 * file list outranked the file. The CSS clamps the result again in `rem`; this
 * clamp is the one that survives a keyboard user holding ArrowRight.
 */
export function workbenchRailPercent(percent: number): number {
  if (!Number.isFinite(percent)) return WORKBENCH_RAIL_DEFAULT_PERCENT;
  return Math.round(Math.min(WORKBENCH_RAIL_MAX_PERCENT, Math.max(WORKBENCH_RAIL_MIN_PERCENT, percent)) * 10) / 10;
}

/**
 * The file a new folder is created holding.
 *
 * `WorkspacePort` stores files. A folder exists exactly while a path names it,
 * so "create an empty folder" is not a thing this storage can represent. Rather
 * than refuse the action or pretend directories are objects, Airship creates the
 * folder the only way it can and says so — the same `.gitkeep` idiom Git itself
 * uses for the identical reason.
 */
export const WORKSPACE_FOLDER_PLACEHOLDER = ".gitkeep";

/** Printed in the New folder dialog, at rest, before anything is written. */
export const WORKSPACE_FOLDER_PLACEHOLDER_NOTE =
  "A folder here is the path of the files inside it, so this creates the folder holding one empty .gitkeep file. Delete that file and the folder goes with it.";

/** Printed on every folder rename and delete: these are not atomic operations. */
export const WORKSPACE_FOLDER_NOT_ATOMIC_NOTE =
  "Folders are not stored objects, so this runs one compare-and-swapped file operation per file. If one fails the rest are left alone and the count that finished is reported.";

/**
 * Why a proposed single-segment name cannot be used, or `undefined`.
 *
 * Returned as a sentence rather than a boolean so the dialog can show the
 * reason beside the field instead of silently disabling its own primary button,
 * which is the shipped failure mode the review called a dead end.
 */
export function workspaceNameError(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a name.";
  if (trimmed.includes("/")) return "A folder name is one segment — it cannot contain “/”.";
  if (trimmed === "." || trimmed === "..") return "“.” and “..” are not names this workspace can address.";
  return undefined;
}

/**
 * Whether the editor soft-wraps by default at this pane width.
 *
 * Off is right where a line of code fits; at phone widths `white-space: pre`
 * made a markdown paragraph reachable only by horizontal scrolling, one line at
 * a time. The default follows the width; the toggle then belongs to the user
 * and is persisted with the open tabs.
 */
export const WORKBENCH_WRAP_DEFAULT_MAX_WIDTH = 760;

export function defaultEditorWrap(width: number | undefined): boolean {
  return typeof width === "number" && Number.isFinite(width) && width <= WORKBENCH_WRAP_DEFAULT_MAX_WIDTH;
}

/**
 * What the file strip says about the editing surface itself.
 *
 * The gutter and the wrap mode are one decision: numbers down the side of a
 * soft-wrapped buffer label visual rows, not file lines, so a wrapped editor
 * shows no gutter — and then has to say that rather than letting the numbers
 * disappear silently, which is what the ≤760px stylesheet used to do.
 */
export function editorSurfaceNote(input: Readonly<{ wrap: boolean; binary: boolean }>): string {
  if (input.binary) return "Binary · read-only · client-side";
  return input.wrap
    ? "UTF-8 · LF · client-side · wrapped, no line numbers"
    : "UTF-8 · LF · client-side";
}

export type WorkbenchDialogKind =
  | "create"
  | "create-folder"
  | "rename"
  | "rename-folder"
  | "move"
  | "delete"
  | "delete-folder"
  | "discard";

export type WorkbenchDialogCopy = Readonly<{
  /**
   * The visible H2, which is also the dialog's accessible name via
   * `aria-labelledby`. Kept as one string on purpose: a separate `aria-label`
   * is a second name that can drift from the one on screen, and the shipped
   * drift was total — `aria-label={`${dialog.kind} workspace file`}` announced
   * "discard workspace file" while the heading said something else entirely.
   * The full path stays on the heading's `title` and in the dialog body.
   */
  title: string;
  /** The primary button. Destructive kinds state the size of what they remove. */
  confirm: string;
  destructive: boolean;
}>;

/**
 * The one place a workbench modal's words are decided.
 *
 * Every title names its subject rather than its enum, and every folder
 * confirmation states the file count it is about to act on, because a folder
 * row hides how much a single "Delete" is really removing.
 */
export function workbenchDialogCopy(
  kind: WorkbenchDialogKind,
  path: string,
  affectedFiles = 0,
): WorkbenchDialogCopy {
  const name = path === "/workspace" ? "workspace" : path.slice(path.lastIndexOf("/") + 1);
  const files = `${String(affectedFiles)} ${affectedFiles === 1 ? "file" : "files"}`;
  const copy = (title: string, confirm: string, destructive = false): WorkbenchDialogCopy =>
    Object.freeze({ title, confirm, destructive });
  switch (kind) {
    case "create": return copy("New file", "Create");
    case "create-folder": return copy("New folder", "Create folder");
    case "rename": return copy(`Rename ${name}`, "Rename");
    case "rename-folder": return copy(`Rename ${name}`, `Rename ${files}`);
    case "move": return copy(`Move ${name}`, "Move here");
    case "delete": return copy(`Delete ${name}`, "Delete", true);
    case "delete-folder": return copy(`Delete ${name}`, `Delete ${files}`, true);
    case "discard": return copy("Unsaved changes", "Discard and close", true);
  }
}

/**
 * What a multi-file folder operation actually did, in one sentence.
 *
 * A folder rename is N moves. When step 9 of 14 fails, "Renaming folder failed
 * safely" is a lie: nine files moved. This reports the split every time,
 * including the whole-success case, so the message never has to be trusted to
 * mean more than it says.
 */
export function folderOperationReport(input: Readonly<{
  verb: "Renamed" | "Deleted";
  done: number;
  total: number;
  target: string;
  failure?: string;
}>): string {
  if (!input.failure) return `${input.verb} ${String(input.total)} ${input.total === 1 ? "file" : "files"} in ${input.target}.`;
  return `${input.verb} ${String(input.done)} of ${String(input.total)} files in ${input.target}, then stopped: ${input.failure} The remaining files were not touched.`;
}

export type WorkbenchNoticeKind = "progress" | "done" | "error";

export type WorkbenchNotice = Readonly<{
  kind: WorkbenchNoticeKind;
  message: string;
}>;

export function workbenchNotice(kind: WorkbenchNoticeKind, message: string): WorkbenchNotice {
  return Object.freeze({ kind, message });
}

/**
 * What a notice becomes once the work it describes has stopped.
 *
 * The shipped bug was that nothing ever cleared `Creating file…`, so a verb in
 * the present tense stayed on screen for minutes as a claim about work that had
 * already finished. A progress line is only true while it is in flight;
 * outcomes — the completion sentence, the error — are the caller's to keep.
 */
export function settledWorkbenchNotice(current: WorkbenchNotice | undefined): WorkbenchNotice | undefined {
  return current?.kind === "progress" ? undefined : current;
}

/** How long a completion sentence stays before the editor takes its space back. */
export const WORKBENCH_DONE_NOTICE_MS = 6_000;

/**
 * The seal state a notice tone maps to, in the one status vocabulary.
 *
 * Errors never auto-dismiss and never render as a toast, so this is only ever
 * asked about a notice that is currently on screen.
 */
export function workbenchNoticeState(kind: WorkbenchNoticeKind): "checking" | "verified" | "failed" {
  return kind === "progress" ? "checking" : kind === "done" ? "verified" : "failed";
}

export type WorkbenchBufferState = Readonly<{
  /** The word the file strip shows, and the seal's accessible name. */
  word: string;
  /** The sentence behind that word. Rendered as visible text, never `title`-only. */
  detail: string;
  state: "none" | "attention";
}>;

/**
 * The file strip's verdict for the active buffer.
 *
 * `Modified` and `Saved` are the shipped words and stay the shipped words. What
 * changes is that they are now readable without scrolling, and that the binary
 * and bounded cases stop borrowing the editable vocabulary.
 *
 * No state here is `verified`: a compare-and-swapped page-memory write is a
 * write, not cryptographic verification, and the one status family must not be
 * used to imply otherwise.
 */
export function workbenchBufferState(input: Readonly<{
  binary: boolean;
  truncated: boolean;
  dirty: boolean;
}>): WorkbenchBufferState {
  if (input.binary) {
    return Object.freeze({
      word: "Protected bytes",
      detail: "Binary · read-only",
      state: "none",
    });
  }
  if (input.truncated) {
    return Object.freeze({
      word: "Bounded preview",
      detail: "Read-only above the editor byte limit",
      state: "none",
    });
  }
  if (input.dirty) {
    return Object.freeze({
      word: "Modified",
      detail: "Unsaved draft in this page. ⌘S or Ctrl+S saves it.",
      state: "attention",
    });
  }
  return Object.freeze({
    word: "Saved",
    detail: "This draft matches the durable revision below.",
    state: "none",
  });
}

/**
 * Which files the empty editor pane offers, largest first.
 *
 * Metadata only, from the `files` array the route already holds — opening the
 * pane must not fetch a byte, because "Nothing is downloaded until you select
 * it" is printed 30px above these rows.
 */
export function workbenchSuggestedFiles<Entry extends Readonly<{ path: string; size: number }>>(
  files: readonly Entry[],
  limit = 3,
): readonly Entry[] {
  return Object.freeze([...files].sort((left, right) => right.size - left.size || left.path.localeCompare(right.path)).slice(0, limit));
}

/**
 * The filtered file list, and the counts that make the filtered state
 * impossible to mistake for an empty workspace.
 */
export function workbenchFilterMatches<Entry extends Readonly<{ path: string }>>(
  files: readonly Entry[],
  query: string,
): Readonly<{ matches: readonly Entry[]; shown: number; total: number }> {
  const needle = query.trim().toLowerCase();
  const matches = needle.length === 0
    ? files
    : files.filter((entry) => entry.path.toLowerCase().includes(needle));
  return Object.freeze({ matches: Object.freeze([...matches]), shown: matches.length, total: files.length });
}
