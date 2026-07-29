import type { PromiseFsClient } from "isomorphic-git";
import { isAirshipReservedPath, normalizeWorkspacePath, type WorkspacePort } from "../workspace/contracts";
import { decodeWorkspaceBytes, encodeWorkspaceBytes } from "../workspace/content-codec";
import { GIT_LIMITS, asciiCompare } from "./validation";

export { decodeWorkspaceBytes, encodeWorkspaceBytes } from "../workspace/content-codec";
const encoder = new TextEncoder();

/**
 * Node-compatible filesystem projection over Airship's authoritative
 * WorkspacePort. Both worktree content and conventional `.git` files live in
 * that one workspace. Opaque bytes use a reversible envelope because the
 * provider-neutral WorkspacePort deliberately has a string-valued boundary.
 *
 * Directories are reconstructed from file prefixes plus an in-page set for
 * transient empty directories. Symlinks are rejected rather than simulated.
 */
export class WorkspaceGitFileSystem {
  readonly client: PromiseFsClient;
  private readonly directories = new Set<string>(["/", "/workspace"]);
  private readonly storagePath: (path: string) => string;

  constructor(private readonly workspace: WorkspacePort, projection?: PathProjection) {
    this.storagePath = projection?.storage ?? identityPath;
    this.client = {
      promises: {
        readFile: this.readFile.bind(this),
        writeFile: this.writeFile.bind(this),
        unlink: this.unlink.bind(this),
        readdir: this.readdir.bind(this),
        mkdir: this.mkdir.bind(this),
        rmdir: this.rmdir.bind(this),
        stat: this.stat.bind(this),
        lstat: this.stat.bind(this),
        readlink: this.readlink.bind(this),
        symlink: this.symlink.bind(this),
        chmod: async () => undefined,
      },
    };
  }

  /**
   * Project a conventional linked-worktree Git directory over the common
   * repository directory. isomorphic-git follows the worktree's `.git` file,
   * but does not itself interpret the resulting `commondir` file. This narrow
   * filesystem view supplies exactly that missing Git layout rule: HEAD,
   * index, in-progress state, and logs/HEAD stay in the linked administration
   * directory while objects, refs, config, and the other common namespaces are
   * resolved from the primary `.git` directory.
   */
  clientForLinkedWorktree(commonGitdir: string, worktreeGitdir: string): PromiseFsClient {
    return new WorkspaceGitFileSystem(this.workspace, linkedProjection(commonGitdir, worktreeGitdir)).client;
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.writeFile(path, content);
  }

  async readText(path: string): Promise<string | undefined> {
    try {
      return await this.readFile(path, "utf8") as string;
    } catch (error) {
      if ((error as NodeLikeError).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async removeFile(path: string): Promise<void> {
    try {
      await this.unlink(path);
    } catch (error) {
      if ((error as NodeLikeError).code !== "ENOENT") throw error;
    }
  }

  async removeGitDirectory(root: string): Promise<void> {
    await this.removeTree(`${root}/.git`);
  }

  async removeTree(root: string): Promise<void> {
    const normalized = fsPath(root);
    const entries = await this.workspace.list(this.mutable(normalized));
    for (const entry of [...entries].reverse()) {
      await this.workspace.remove(entry.path, { expectedRevision: entry.revision });
    }
    for (const directory of [...this.directories]) {
      if (directory === normalized || directory.startsWith(`${normalized}/`)) this.directories.delete(directory);
    }
  }

  /**
   * The Git-facing half of the control-plane fence.
   *
   * Every browser-Git read, write, status walk and remote-tree materialization
   * reaches storage through this one filesystem, so this is the only place the
   * fence is complete by construction: `diff`, forced `stage`, `commit`,
   * `checkout`, `merge`, `restore` and `reset` cannot each be trusted to
   * re-derive it, and a method added later would not have to remember to.
   *
   * Reads report ENOENT rather than a refusal because that is the truth Git
   * needs: the control plane is not part of any worktree, so a status walk
   * should traverse as though it were absent instead of failing. Writes refuse
   * loudly — a checkout that would lay a remote tree over
   * `/workspace/.airship` must stop rather than half-apply, and silently
   * skipping the path would leave a worktree that disagrees with its own HEAD.
   */
  private readable(normalized: string): string {
    const stored = this.storagePath(normalized);
    if (isAirshipReservedPath(normalized) || isAirshipReservedPath(stored)) {
      throw fsError("ENOENT", `No such file: ${normalized}`);
    }
    return stored;
  }

  private mutable(normalized: string): string {
    const stored = this.storagePath(normalized);
    if (isAirshipReservedPath(normalized) || isAirshipReservedPath(stored)) {
      throw fsError("EPERM", `${normalized} is Airship's private control plane, not a worktree file.`);
    }
    return stored;
  }

  private async readFile(path: string, options?: unknown): Promise<Uint8Array | string> {
    const normalized = fsPath(path);
    const file = await this.workspace.read(this.readable(normalized));
    if (!file) throw fsError("ENOENT", `No such file: ${normalized}`);
    const bytes = decodeWorkspaceBytes(file.content);
    const encoding = requestedEncoding(options);
    if (!encoding) return bytes;
    if (encoding !== "utf8" && encoding !== "utf-8") throw fsError("EINVAL", `Unsupported text encoding ${encoding}.`);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  private async writeFile(path: string, value: unknown, options?: unknown): Promise<void> {
    const normalized = fsPath(path);
    if (normalized === "/workspace") throw fsError("EISDIR", "Cannot write the workspace root.");
    const bytes = bytesFrom(value, options);
    if (bytes.byteLength > GIT_LIMITS.maxFileBytes && !isGitMetadataPath(normalized)) {
      throw fsError("EFBIG", `Worktree file exceeds ${GIT_LIMITS.maxFileBytes} bytes.`);
    }
    const content = encodeWorkspaceBytes(bytes);
    const stored = this.mutable(normalized);
    this.rememberParents(normalized);
    const current = await this.workspace.read(stored);
    if (current?.content === content) return;
    try {
      await this.workspace.write(stored, content, { expectedRevision: current?.revision ?? null });
    } catch (error) {
      // Idempotent convergence is safe; any divergent CAS winner remains a
      // real conflict for the Git client to surface.
      const winner = await this.workspace.read(stored);
      if (winner?.content === content) return;
      throw error;
    }
  }

  private async unlink(path: string): Promise<void> {
    const normalized = fsPath(path);
    const stored = this.mutable(normalized);
    const current = await this.workspace.read(stored);
    if (!current) throw fsError("ENOENT", `No such file: ${normalized}`);
    await this.workspace.remove(stored, { expectedRevision: current.revision });
  }

  private async readdir(path: string): Promise<string[]> {
    const normalized = fsPath(path);
    const stored = this.readable(normalized);
    const exact = await this.workspace.read(stored);
    if (exact) throw fsError("ENOTDIR", `Not a directory: ${normalized}`);
    const entries = await this.workspace.list(stored);
    const children = new Set<string>();
    for (const entry of entries) {
      const alias = stored === normalized ? entry.path : `${normalized}${entry.path.slice(stored.length)}`;
      if (alias === normalized || !alias.startsWith(`${normalized}/`)) continue;
      // Listing `.airship` here would put it in front of every status walk and
      // `git add .`, which would then fail on a path they should never have
      // been offered. Omitting it is the same answer `readable` gives.
      if (isAirshipReservedPath(alias)) continue;
      const child = alias.slice(normalized.length + 1).split("/", 1)[0];
      if (child) children.add(child);
      this.rememberParents(alias);
    }
    for (const directory of this.directories) {
      if (!directory.startsWith(`${normalized}/`) || isAirshipReservedPath(directory)) continue;
      const child = directory.slice(normalized.length + 1).split("/", 1)[0];
      if (child) children.add(child);
    }
    if (!children.size && !this.directories.has(normalized)) throw fsError("ENOENT", `No such directory: ${normalized}`);
    return [...children].sort(asciiCompare);
  }

  private async mkdir(path: string): Promise<void> {
    const normalized = fsPath(path);
    if (await this.workspace.read(this.mutable(normalized))) throw fsError("EEXIST", `A file exists at ${normalized}.`);
    if (this.directories.has(normalized)) throw fsError("EEXIST", `Directory exists: ${normalized}.`);
    const parent = parentPath(normalized);
    if (!this.directories.has(parent) && !(await this.hasDirectory(parent))) {
      throw fsError("ENOENT", `Parent directory does not exist: ${parent}.`);
    }
    this.directories.add(normalized);
  }

  private async rmdir(path: string): Promise<void> {
    const normalized = fsPath(path);
    this.mutable(normalized);
    if ((await this.readdir(normalized)).length) throw fsError("ENOTEMPTY", `Directory is not empty: ${normalized}.`);
    if (!this.directories.delete(normalized)) throw fsError("ENOENT", `No such directory: ${normalized}.`);
  }

  private async stat(path: string): Promise<WorkspaceFsStat> {
    const normalized = fsPath(path);
    const file = await this.workspace.read(this.readable(normalized));
    if (file) {
      return new WorkspaceFsStat("file", decodeWorkspaceBytes(file.content).byteLength, Date.parse(file.updatedAt), revisionInode(file.revision));
    }
    if (this.directories.has(normalized) || await this.hasDirectory(normalized)) return new WorkspaceFsStat("directory", 0, 0);
    throw fsError("ENOENT", `No such path: ${normalized}.`);
  }

  private async readlink(path: string): Promise<never> {
    throw fsError("EINVAL", `Not a symbolic link: ${fsPath(path)}.`);
  }

  private async symlink(): Promise<never> {
    throw fsError("ENOTSUP", "Symbolic links are not admitted into Airship's portable browser workspace.");
  }

  private async hasDirectory(path: string): Promise<boolean> {
    if (isAirshipReservedPath(path)) return false;
    if (this.directories.has(path)) return true;
    const stored = this.storagePath(path);
    if (isAirshipReservedPath(stored)) return false;
    const entries = await this.workspace.list(stored);
    if (!entries.some((entry) => entry.path.startsWith(`${stored}/`))) return false;
    this.directories.add(path);
    return true;
  }

  private rememberParents(path: string): void {
    let current = parentPath(path);
    while (current.startsWith("/workspace")) {
      this.directories.add(current);
      if (current === "/workspace") break;
      current = parentPath(current);
    }
  }
}

type PathProjection = Readonly<{
  storage: (path: string) => string;
}>;

/** One physical common namespace, exposed at the linked Git-directory alias. */
function linkedProjection(commonInput: string, worktreeInput: string): PathProjection {
  const common = normalizeWorkspacePath(commonInput);
  const worktree = normalizeWorkspacePath(worktreeInput);
  if (common === worktree) throw fsError("EINVAL", "Linked and common Git directories must differ.");
  const shared = (path: string, prefix: string): boolean => path.startsWith(`${prefix}/`)
    && isCommonGitRelativePath(path.slice(prefix.length + 1));
  return {
    storage: (path) => shared(path, worktree) ? `${common}${path.slice(worktree.length)}` : path,
  };
}

function identityPath(path: string): string { return path; }

/** Paths defined by gitrepository-layout as shared between all worktrees. */
function isCommonGitRelativePath(relative: string): boolean {
  if (!relative) return false;
  const [first, second] = relative.split("/", 2);
  if (first === "refs" && (second === "bisect" || second === "worktree")) return false;
  if (first === "logs" && second !== "refs") return false;
  return "branches config description hooks info logs modules objects packed-refs refs remotes rr-cache shallow svn worktrees".split(" ").includes(first!);
}

class WorkspaceFsStat {
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly mtime: Date;
  readonly ctime: Date;
  readonly uid = 0;
  readonly gid = 0;
  readonly dev = 0;
  readonly ino: number;

  constructor(private readonly kind: "file" | "directory", size: number, modified: number, ino = 0) {
    const time = Number.isFinite(modified) ? modified : 0;
    this.ino = ino;
    this.mode = kind === "file" ? 0o100644 : 0o040755;
    this.size = size;
    this.mtimeMs = time;
    this.ctimeMs = time;
    this.mtime = new Date(time);
    this.ctime = new Date(time);
  }

  isFile(): boolean { return this.kind === "file"; }
  isDirectory(): boolean { return this.kind === "directory"; }
  isSymbolicLink(): boolean { return false; }
}

function fsPath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/workspace")) {
    throw fsError("EINVAL", "Git filesystem paths must stay inside /workspace.");
  }
  const rawParts = path.slice(1).split("/");
  if (rawParts.some((part) => part === "..")) throw fsError("EINVAL", "Git filesystem paths cannot traverse above /workspace.");
  // isomorphic-git legitimately probes paths with `.` and trailing slashes;
  // canonicalize those Node-style spellings at this narrow filesystem waist.
  const parts = rawParts.filter((part) => part && part !== ".");
  if (parts[0] !== "workspace") throw fsError("EINVAL", "Git filesystem paths must stay inside /workspace.");
  try {
    return normalizeWorkspacePath(`/${parts.join("/")}`);
  } catch (error) {
    throw fsError("EINVAL", error instanceof Error ? error.message : "Invalid workspace path.");
  }
}

/**
 * isomorphic-git's index cache declares a file unchanged when mode, size, uid,
 * gid, ino and *whole-second* mtime all match, so a same-length rewrite inside
 * one wall-clock second would otherwise be invisible to status, stage, diff and
 * commit. Every WorkspacePort implementation mints a fresh revision on every
 * write, so projecting the revision into the inode makes the cache miss exactly
 * when the bytes may have changed. The value must stay inside a uint32 because
 * the binary DIRC index writes `ino` with writeUInt32BE.
 */
function revisionInode(revision: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < revision.length; index += 1) {
    hash ^= revision.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function isGitMetadataPath(path: string): boolean {
  return path.includes("/.git/") || path.endsWith("/.git");
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function requestedEncoding(options: unknown): string | undefined {
  if (typeof options === "string") return options;
  if (options && typeof options === "object" && "encoding" in options) return String((options as { encoding?: unknown }).encoding);
  return undefined;
}

function bytesFrom(value: unknown, options: unknown): Uint8Array {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw fsError("EINVAL", `Unsupported filesystem write value (${String(options)}).`);
}

type NodeLikeError = Error & { code?: string };
function fsError(code: string, message: string): NodeLikeError {
  return Object.assign(new Error(message), { code });
}
