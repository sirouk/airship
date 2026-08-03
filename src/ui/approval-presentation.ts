import type { JsonValue } from "../core/contracts";

/**
 * What an approval is actually approving, derived from the tool that asked.
 *
 * This used to be a schema-blind key-name heuristic: it looked for `path` and
 * `content`, and it read the *absence* of the optional `expectedRevision`
 * concurrency token as proof that a file was being created. So `remove_file`
 * — the one tool in the registry that destroys a file — rendered as "Create",
 * an unchecked `write_file` over an existing file rendered as "Create", and
 * every write tool whose arguments do not happen to use those key names
 * (`move_file`, `text_editor`, `git_change`, both execution tools) produced no
 * panel at all. Disposition is a property of the tool's declared semantics, so
 * it is read from the tool's name, and a tool with no mapping says so out loud
 * rather than being silently omitted.
 */
export type WriteApprovalFacts = Readonly<{
  /** What this call does to the workspace, in the tool's own terms. */
  disposition: string;
  /** The paths or scopes the arguments name, in call order. */
  targets: readonly string[];
  /** A resulting size, only where the arguments actually declare one. */
  byteLength?: number;
  byteDelta?: number;
  before?: string;
  after?: string;
  /**
   * False when no mapping exists for this tool. The dock renders an explicit
   * "read the raw arguments" row for it: an unrecognised write tool must be
   * visible as unrecognised, never as a missing section.
   */
  derived: boolean;
}>;

const MAX_PREVIEW = 1_024;

const NOT_DERIVABLE = "Consequence not derivable — read the raw arguments below";

export function writeApprovalFacts(toolName: string, value: JsonValue): WriteApprovalFacts {
  const record = value && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, JsonValue>
    : {};
  switch (toolName) {
    case "write_file": {
      // An `expectedRevision` is an optimistic lock, not a statement of intent:
      // its absence means "do not check", which is precisely the case where
      // this panel may not promise that nothing is being overwritten.
      const revision = record.expectedRevision;
      const content = text(record.content);
      return facts({
        disposition: typeof revision === "string" ? `Replace revision ${revision}` : "Create or overwrite",
        targets: paths(record.path),
        ...(content === undefined ? {} : { byteLength: utf8Length(content), after: bounded(content) }),
      });
    }
    case "replace_text": {
      const oldText = text(record.oldText);
      const newText = text(record.newText);
      const every = record.replaceAll === true;
      return facts({
        disposition: every ? "Replace every occurrence in an existing file" : "Replace one occurrence in an existing file",
        targets: paths(record.path),
        // With `replaceAll` the file changes by this delta once per occurrence,
        // and the occurrence count is not knowable from the arguments. One
        // number that is right is worth more than one that is usually wrong.
        ...(every || oldText === undefined || newText === undefined
          ? {}
          : { byteDelta: utf8Length(newText) - utf8Length(oldText) }),
        ...(oldText === undefined ? {} : { before: bounded(oldText) }),
        ...(newText === undefined ? {} : { after: bounded(newText) }),
      });
    }
    case "move_file": {
      // One target, stated as a direction: source and destination listed as two
      // peers would not say which of the two stops existing.
      const source = text(record.sourcePath);
      const destination = text(record.destinationPath);
      return facts({
        disposition: "Move — the source path stops existing",
        targets: source && destination ? [`${source} → ${destination}`] : [...paths(source), ...paths(destination)],
      });
    }
    case "remove_file":
      return facts({ disposition: "Delete", targets: paths(record.path) });
    case "text_editor": {
      const edits = Array.isArray(record.edits) ? record.edits : [];
      const entries = edits.map((edit) => edit && !Array.isArray(edit) && typeof edit === "object"
        ? edit as Record<string, JsonValue>
        : {});
      const creates = entries.filter((edit) => edit.oldText === null).length;
      return facts({
        // Every possible mutation is declared in this one call, so the panel
        // enumerates every one of them rather than summarising a batch.
        disposition: `${entries.length} declared edit${entries.length === 1 ? "" : "s"}: ${creates} create, ${entries.length - creates} replace`,
        targets: entries.flatMap((edit) => paths(edit.path)),
      });
    }
    case "update_memory":
      return facts({
        disposition: record.action === "forget" ? "Delete one profile memory" : "Add one profile memory",
        targets: ["This profile's memory"],
      });
    case "update_tasks": {
      const tasks = Array.isArray(record.tasks) ? record.tasks.length : 0;
      return facts({
        disposition: `Replace the session work plan with ${tasks} task${tasks === 1 ? "" : "s"}`,
        targets: ["This session's work plan"],
      });
    }
    case "execute_shell":
      return facts({
        // The script itself is bounded and sandboxed; the only thing this
        // approval decides is whether its result is adopted into the workspace.
        disposition: record.writeBack === true
          ? "Run a script and write its result back into the workspace, if it exits 0"
          : "Run a script only — no workspace write-back",
        targets: paths(record.workspaceRoot),
      });
    case "execute_workspace_program": {
      const calls = Array.isArray(record.calls) ? record.calls : [];
      const tools = calls.map((call) => call && !Array.isArray(call) && typeof call === "object"
        ? text((call as Record<string, JsonValue>).tool)
        : undefined);
      return facts({
        disposition: `Run bounded JavaScript limited to ${calls.length} predeclared workspace call${calls.length === 1 ? "" : "s"}`,
        targets: tools.filter((tool): tool is string => tool !== undefined),
      });
    }
    case "git_change":
      return facts({
        disposition: `Git ${text(record.action) ?? "change"} in the browser-owned worktree`,
        // Files first, worktree last and as one string. Listed as three peers
        // the row read "airship-workspace, main, README.md", where the two ids
        // are indistinguishable from the path — and the path is the only part
        // of it a person is actually deciding about.
        targets: [
          ...(Array.isArray(record.paths) ? record.paths.flatMap((entry) => paths(entry)) : []),
          ...worktreeScope(record.repositoryId, record.worktreeId),
        ],
      });
    case "git_configure":
      return facts({
        disposition: `Git ${text(record.action) ?? "configure"} — writes .git/config and refs locally`,
        targets: [...paths(record.repositoryId), ...paths(record.name)],
      });
    default:
      return Object.freeze({ disposition: NOT_DERIVABLE, targets: Object.freeze([]), derived: false });
  }
}

export function remainingApprovalTime(expiresAt: string, now = Date.now()): string {
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  const seconds = Math.ceil(remaining / 1_000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function facts(value: Omit<WriteApprovalFacts, "derived">): WriteApprovalFacts {
  return Object.freeze({ ...value, targets: Object.freeze([...value.targets]), derived: true });
}

/** One argument that should name a path or an id, kept only when it does. */
function paths(value: JsonValue | undefined): readonly string[] {
  return typeof value === "string" && value ? [value] : [];
}

/** Repository and worktree as the one place a Git write lands, never as two targets. */
function worktreeScope(repositoryId: JsonValue | undefined, worktreeId: JsonValue | undefined): readonly string[] {
  const repository = text(repositoryId);
  const worktree = text(worktreeId);
  if (repository && worktree) return [`${repository}/${worktree}`];
  return [...paths(repository), ...paths(worktree)];
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bounded(value: string): string {
  return value.length <= MAX_PREVIEW ? value : `${value.slice(0, MAX_PREVIEW)}\n… bounded preview`;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
