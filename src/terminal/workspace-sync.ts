import type { FileSystemTree } from "@webcontainer/api";
import {
  isLocalFolderMountPath,
  isWorkspaceControlPlanePath,
  normalizeWorkspacePath,
  WorkspaceConflictError,
  type WorkspacePort,
} from "../workspace/contracts";
import { decodeWorkspaceBytes, encodeWorkspaceBytes, workspaceContentByteLength } from "../workspace/content-codec";
import { TERMINAL_WORKSPACE_MOUNT } from "./contracts";

const MAX_FILES = 2_048;
const MAX_FILE_BYTES = 2 * 1_024 * 1_024;
const MAX_TOTAL_BYTES = 16 * 1_024 * 1_024;
const MAX_CHANGES = 512;
const MAX_CHANGED_BYTES = 8 * 1_024 * 1_024;
const EXCLUDED = new Set([".git", ".airship", "node_modules"]);
/**
 * The Terminal never carries an attached folder, in either direction.
 *
 * A mount is a *copy*: every listed file is read out of the workspace port and
 * written into the WebContainer, and every changed file is written back
 * afterwards through `workspace.write`. For `/workspace` that is a copy of a
 * browser-managed store into a sandbox and back. For a path under the reserved
 * mount it is a person's own directory copied into a Node runtime, and then
 * shell output written onto their real files — with no approval request
 * anywhere on that path, because `syncTerminalWorkspace` writes through the
 * port rather than through the tool broker. So the folder is not mounted, and
 * output addressed to it is refused rather than written.
 */
export const ATTACHED_FOLDER_REFUSAL =
  "The Terminal does not carry the folder you attached from this device: it copies files into a sandbox and writes"
  + " them back with no approval request, and that folder is written in place. Work on it in the Workspace or the"
  + " editor, where every write to it is reviewed. Nothing on your device was changed.";

type Host = Readonly<{
  fs: Readonly<{
    mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
    rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  }>;
  mount(tree: FileSystemTree, options: { mountPoint: string }): Promise<void>;
  export(path: string, options: { format: "json"; excludes: string[] }): Promise<FileSystemTree>;
}>;
type BaselineFile = Readonly<{ content: string; revision: string }>;

export type TerminalWorkspaceSnapshot = Readonly<{
  root: string;
  files: ReadonlyMap<string, BaselineFile>;
}>;

export async function mountTerminalWorkspace(host: Host, workspace: WorkspacePort, root = "/workspace"): Promise<TerminalWorkspaceSnapshot> {
  const normalizedRoot = normalizeWorkspacePath(root);
  const entries = (await workspace.list(normalizedRoot))
    .filter((entry) => entry.path === normalizedRoot || entry.path.startsWith(`${normalizedRoot}/`))
    .filter((entry) => !isWorkspaceControlPlanePath(entry.path) && !isLocalFolderMountPath(entry.path))
    .filter((entry) => !relative(entry.path, normalizedRoot).split("/").some((part) => EXCLUDED.has(part)));
  if (entries.length > MAX_FILES) throw new Error(`Terminal workspace exceeds ${MAX_FILES} files.`);
  const tree: FileSystemTree = Object.create(null) as FileSystemTree;
  const files = new Map<string, BaselineFile>();
  let total = 0;
  for (const entry of entries) {
    const path = relative(entry.path, normalizedRoot);
    if (!path) continue;
    const file = await (workspace.readBounded?.(entry.path, MAX_FILE_BYTES + 1) ?? workspace.read(entry.path));
    if (!file || file.revision !== entry.revision) throw new WorkspaceConflictError(`Workspace changed while opening Terminal: ${entry.path}`);
    const bytes = workspaceContentByteLength(file.content);
    if (bytes > MAX_FILE_BYTES) throw new Error(`Terminal workspace file exceeds 2 MiB: ${entry.path}`);
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error("Terminal workspace exceeds the 16 MiB mount limit.");
    insert(tree, path.split("/"), decodeWorkspaceBytes(file.content));
    files.set(path, Object.freeze({ content: file.content, revision: file.revision }));
  }
  await host.fs.mkdir(TERMINAL_WORKSPACE_MOUNT, { recursive: true });
  await host.mount(tree, { mountPoint: TERMINAL_WORKSPACE_MOUNT });
  return Object.freeze({ root: normalizedRoot, files });
}

export async function syncTerminalWorkspace(
  host: Host,
  workspace: WorkspacePort,
  baseline: TerminalWorkspaceSnapshot,
): Promise<Readonly<{ snapshot: TerminalWorkspaceSnapshot; changedPaths: readonly string[] }>> {
  const tree = await host.export(TERMINAL_WORKSPACE_MOUNT, {
    format: "json",
    excludes: ["node_modules", "**/node_modules/**", ".git", "**/.git/**", ".airship", "**/.airship/**"],
  });
  const exported = new Map<string, string>();
  flatten(tree, [], exported);
  if (exported.size > MAX_FILES) throw new Error(`Terminal output exceeds ${MAX_FILES} workspace files.`);
  for (const path of exported.keys()) {
    // Nothing under the mount was ever mounted, so this can only be output the
    // shell addressed *into* the attached folder. It never reaches the port.
    if (isLocalFolderMountPath(`${baseline.root}/${path}`)) {
      throw new Error(`${ATTACHED_FOLDER_REFUSAL} Refused: ${baseline.root}/${path}`);
    }
  }
  const changes: Array<Readonly<{ path: string; relative: string; content?: string; expected?: string; kind: "create" | "modify" | "delete" }>> = [];
  let bytes = 0;
  for (const [path, content] of exported) {
    const original = baseline.files.get(path);
    if (original?.content === content) continue;
    const size = workspaceContentByteLength(content);
    if (size > MAX_FILE_BYTES) throw new Error(`Terminal output file exceeds 2 MiB: ${path}`);
    bytes += size;
    changes.push(Object.freeze({
      path: normalizeWorkspacePath(`${baseline.root}/${path}`),
      relative: path,
      content,
      ...(original ? { expected: original.revision, kind: "modify" as const } : { kind: "create" as const }),
    }));
  }
  for (const [path, original] of baseline.files) {
    if (!exported.has(path)) changes.push(Object.freeze({
      path: normalizeWorkspacePath(`${baseline.root}/${path}`),
      relative: path,
      expected: original.revision,
      kind: "delete" as const,
    }));
  }
  if (changes.length > MAX_CHANGES) throw new Error(`Terminal sync exceeds ${MAX_CHANGES} changes.`);
  if (bytes > MAX_CHANGED_BYTES) throw new Error("Terminal sync exceeds the 8 MiB changed-byte limit.");

  const applied: typeof changes = [];
  for (const change of changes) {
    const current = await workspace.read(change.path);
    // A deletion whose target is already gone is agreement, not a conflict:
    // both sides removed the same file. Failing the batch over an outcome that
    // already holds would strand every other change the terminal made with it.
    if (change.kind === "delete" && !current) continue;
    if (change.kind === "create" ? Boolean(current) : !current || current.revision !== change.expected) {
      throw new WorkspaceConflictError(`Terminal output conflicts with the current workspace revision: ${change.path}`);
    }
    applied.push(change);
  }
  for (const change of applied) {
    if (change.kind === "delete") await workspace.remove(change.path, { expectedRevision: change.expected });
    else await workspace.write(change.path, change.content!, { expectedRevision: change.expected ?? null });
  }
  const nextFiles = new Map<string, BaselineFile>();
  for (const [path, content] of exported) {
    const original = baseline.files.get(path);
    const committed = await workspace.read(normalizeWorkspacePath(`${baseline.root}/${path}`));
    const terminalChanged = original?.content !== content;
    if (terminalChanged && (!committed || committed.content !== content)) {
      throw new WorkspaceConflictError(`Terminal sync could not confirm: ${path}`);
    }
    // The baseline `content` is what the *mount* holds, because that is what
    // the next export is diffed against, and this function never rebuilds the
    // mount. Adopting a newer Editor body here would make the untouched mount
    // copy look like a terminal edit and write it back over that Editor
    // revision; keeping an Editor-deleted file in the baseline (at its last
    // known revision) likewise stops the mount copy being republished as a
    // create. The committed `revision` is still adopted so a later terminal
    // edit fences against the revision the workspace actually holds. Callers
    // that do remount — `reconcileTerminalWorkspace` — discard this snapshot
    // for one taken from the fresh mount.
    const revision = committed?.revision ?? original?.revision;
    if (revision !== undefined) nextFiles.set(path, Object.freeze({ content, revision }));
  }
  return Object.freeze({
    snapshot: Object.freeze({ root: baseline.root, files: nextFiles }),
    changedPaths: Object.freeze(applied.map((change) => change.path).sort()),
  });
}

/**
 * Reconcile both directions at one revision fence. Terminal deltas are first
 * adopted into the authoritative workspace; only then is the terminal mount
 * rebuilt from that resulting workspace so Editor changes also become visible.
 */
export async function reconcileTerminalWorkspace(
  host: Host,
  workspace: WorkspacePort,
  baseline: TerminalWorkspaceSnapshot,
): Promise<Readonly<{ snapshot: TerminalWorkspaceSnapshot; changedPaths: readonly string[] }>> {
  const outgoing = await syncTerminalWorkspace(host, workspace, baseline);
  await host.fs.rm(TERMINAL_WORKSPACE_MOUNT, { recursive: true, force: true });
  const snapshot = await mountTerminalWorkspace(host, workspace, baseline.root);
  return Object.freeze({ snapshot, changedPaths: outgoing.changedPaths });
}

function relative(path: string, root: string): string {
  return path === root ? "" : path.slice(root.length + 1);
}

function insert(tree: FileSystemTree, segments: readonly string[], content: Uint8Array): void {
  let cursor = tree;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const current = cursor[segment];
    if (current && !("directory" in current)) throw new Error(`Terminal mount path collides with a file: ${segments.join("/")}`);
    if (!current) cursor[segment] = { directory: Object.create(null) as FileSystemTree };
    cursor = (cursor[segment] as { directory: FileSystemTree }).directory;
  }
  cursor[segments.at(-1)!] = { file: { contents: content } };
}

function flatten(tree: FileSystemTree, prefix: readonly string[], result: Map<string, string>): void {
  for (const [name, node] of Object.entries(tree)) {
    const path = [...prefix, name];
    if ("directory" in node) flatten(node.directory, path, result);
    else if ("contents" in node.file) result.set(path.join("/"), encodeWorkspaceBytes(
      typeof node.file.contents === "string" ? new TextEncoder().encode(node.file.contents) : node.file.contents,
    ));
    else throw new Error(`Terminal output contains an unsupported symlink: ${path.join("/")}`);
  }
}
