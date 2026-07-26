import { isWorkspaceControlPlanePath } from "../../workspace/contracts";
import {
  AIRSHIP_SH_EXCLUDED_SEGMENTS,
  AIRSHIP_SH_MAX_FILES,
  AIRSHIP_SH_MAX_FILE_BYTES,
  AIRSHIP_SH_MAX_WORKSPACE_BYTES,
  AIRSHIP_SH_SCRATCH_ROOT,
} from "./contract";
import { ShellCommandError } from "./errors";

export type ShellFileEntry = Readonly<{ path: string; bytes: Uint8Array; revision: string; updatedAt: string }>;

export type ShellMount = Readonly<{
  /** Absolute workspace path whose subtree is mounted, for example `/workspace/project`. */
  root: string;
  files: readonly ShellFileEntry[];
}>;

export type ShellStat = Readonly<{ kind: "file" | "directory"; size: number; updatedAt: string }>;

type FileNode = { bytes: Uint8Array; updatedAt: string };

const EXCLUDED = new Set<string>(AIRSHIP_SH_EXCLUDED_SEGMENTS);

/**
 * The shell's view of the world.
 *
 * It is a bounded in-memory projection of one selected `WorkspacePort` subtree
 * plus a scratch tree. The live workspace is never mutated while a script runs;
 * adoption happens once, afterwards, through revision CAS — the same
 * transaction model as the WASI and Python tiers.
 *
 * `WorkspacePort` has no directory objects, so directories exist only here.
 * That is why an empty directory a script creates cannot be adopted: there is
 * nothing to write. The reconciler names that boundary rather than inventing a
 * placeholder file.
 */
export class ShellFileSystem {
  private readonly files = new Map<string, FileNode>();
  private readonly directories = new Set<string>();
  private current: string;

  constructor(
    readonly root: string,
    entries: readonly ShellFileEntry[],
    private readonly startedAt: string,
  ) {
    this.directories.add("/");
    this.addDirectoryChain(root);
    this.addDirectoryChain(AIRSHIP_SH_SCRATCH_ROOT);
    for (const entry of entries) {
      this.files.set(entry.path, { bytes: entry.bytes, updatedAt: entry.updatedAt });
      this.addDirectoryChain(parentPath(entry.path));
    }
    this.current = root;
  }

  get cwd(): string {
    return this.current;
  }

  resolve(input: string): string {
    if (input.includes("\0")) throw new ShellCommandError(`invalid path: ${input}`);
    const base = input.startsWith("/") ? input : `${this.current === "/" ? "" : this.current}/${input}`;
    const parts: string[] = [];
    for (const part of base.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        parts.pop();
        continue;
      }
      parts.push(part);
    }
    return `/${parts.join("/")}`;
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.directories.has(path);
  }

  isFile(path: string): boolean {
    return this.files.has(path);
  }

  isDirectory(path: string): boolean {
    return this.directories.has(path);
  }

  stat(path: string): ShellStat {
    const file = this.files.get(path);
    if (file) return Object.freeze({ kind: "file", size: file.bytes.byteLength, updatedAt: file.updatedAt });
    if (this.directories.has(path)) return Object.freeze({ kind: "directory", size: 0, updatedAt: this.startedAt });
    throw noSuchFile(path);
  }

  readFile(path: string): Uint8Array {
    const file = this.files.get(path);
    if (!file) {
      if (this.directories.has(path)) throw new ShellCommandError(`${path}: Is a directory`);
      throw noSuchFile(path);
    }
    return file.bytes;
  }

  writeFile(path: string, bytes: Uint8Array, options: Readonly<{ append?: boolean }> = {}): void {
    this.assertWritablePath(path);
    if (this.directories.has(path)) throw new ShellCommandError(`${path}: Is a directory`);
    const parent = parentPath(path);
    if (!this.directories.has(parent)) throw noSuchFile(path);
    const existing = this.files.get(path);
    const next = options.append === true && existing ? concat(existing.bytes, bytes) : bytes;
    if (next.byteLength > AIRSHIP_SH_MAX_FILE_BYTES) {
      throw new ShellCommandError(`${path}: file exceeds the ${AIRSHIP_SH_MAX_FILE_BYTES}-byte airship-sh limit`);
    }
    if (!existing && this.files.size >= AIRSHIP_SH_MAX_FILES) {
      throw new ShellCommandError(`airship-sh filesystem exceeds ${AIRSHIP_SH_MAX_FILES} files`);
    }
    const projected = this.totalBytes() - (existing?.bytes.byteLength ?? 0) + next.byteLength;
    if (projected > AIRSHIP_SH_MAX_WORKSPACE_BYTES) {
      throw new ShellCommandError(`airship-sh filesystem exceeds ${AIRSHIP_SH_MAX_WORKSPACE_BYTES} bytes`);
    }
    this.files.set(path, { bytes: next, updatedAt: new Date().toISOString() });
  }

  touch(path: string): void {
    this.assertWritablePath(path);
    const existing = this.files.get(path);
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      return;
    }
    this.writeFile(path, new Uint8Array());
  }

  removeFile(path: string): void {
    this.assertWritablePath(path);
    if (!this.files.delete(path)) throw noSuchFile(path);
  }

  makeDirectory(path: string, recursive: boolean): void {
    this.assertWritablePath(path);
    if (this.files.has(path)) throw new ShellCommandError(`${path}: File exists`);
    if (this.directories.has(path)) {
      if (!recursive) throw new ShellCommandError(`${path}: File exists`);
      return;
    }
    if (!recursive && !this.directories.has(parentPath(path))) throw noSuchFile(path);
    this.addDirectoryChain(path);
  }

  removeDirectory(path: string): void {
    this.assertWritablePath(path);
    if (!this.directories.has(path)) throw noSuchFile(path);
    if (path === this.root || path === AIRSHIP_SH_SCRATCH_ROOT) {
      throw new ShellCommandError(`${path}: cannot remove a mount root`);
    }
    if (this.list(path).length > 0) throw new ShellCommandError(`${path}: Directory not empty`);
    this.directories.delete(path);
  }

  /** Recursive removal used by `rm -r`; every removed path is re-checked. */
  removeTree(path: string): void {
    if (this.files.has(path)) {
      this.removeFile(path);
      return;
    }
    if (!this.directories.has(path)) throw noSuchFile(path);
    for (const child of this.list(path)) this.removeTree(joinPath(path, child));
    this.removeDirectory(path);
  }

  list(path: string): readonly string[] {
    if (!this.directories.has(path)) throw new ShellCommandError(`${path}: Not a directory`);
    const names = new Set<string>();
    const prefix = path === "/" ? "/" : `${path}/`;
    for (const candidate of [...this.files.keys(), ...this.directories]) {
      if (candidate === path || !candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return Object.freeze([...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  }

  changeDirectory(path: string): void {
    if (!this.directories.has(path)) {
      if (this.files.has(path)) throw new ShellCommandError(`${path}: Not a directory`);
      throw noSuchFile(path);
    }
    this.current = path;
  }

  /** Files under the mounted root only; scratch is never a writeback candidate. */
  collect(): readonly Readonly<{ path: string; bytes: Uint8Array }>[] {
    const prefix = `${this.root}/`;
    return Object.freeze(
      [...this.files.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, node]) => Object.freeze({ path, bytes: node.bytes })),
    );
  }

  /** Directories a script created that no file lives in; they cannot be adopted. */
  emptyCreatedDirectories(): readonly string[] {
    const prefix = `${this.root}/`;
    return Object.freeze(
      [...this.directories]
        .filter((path) => path.startsWith(prefix))
        .filter((path) => ![...this.files.keys()].some((file) => file.startsWith(`${path}/`)))
        .sort(),
    );
  }

  private totalBytes(): number {
    let total = 0;
    for (const node of this.files.values()) total += node.bytes.byteLength;
    return total;
  }

  private addDirectoryChain(path: string): void {
    let current = path;
    for (;;) {
      if (this.directories.has(current)) break;
      this.directories.add(current);
      if (current === "/") break;
      current = parentPath(current);
    }
  }

  /**
   * The shell may mutate exactly two regions: the mounted root subtree and the
   * scratch tree. Control-plane paths stay unreachable even inside the root, so
   * no script can reach `.git`, `.airship`, or `node_modules` as a write
   * channel — the same exclusion the WASI and Python tiers enforce on egress.
   */
  assertWritablePath(path: string): void {
    if (path === AIRSHIP_SH_SCRATCH_ROOT || path.startsWith(`${AIRSHIP_SH_SCRATCH_ROOT}/`)) return;
    if (path !== this.root && !path.startsWith(`${this.root}/`)) {
      throw new ShellCommandError(`${path}: Read-only file system outside ${this.root} and ${AIRSHIP_SH_SCRATCH_ROOT}`);
    }
    const relative = path === this.root ? [] : path.slice(this.root.length + 1).split("/");
    const excluded = relative.find((segment) => EXCLUDED.has(segment));
    if (excluded) throw new ShellCommandError(`${path}: airship-sh excludes the ${excluded} path segment`);
    if (isWorkspaceControlPlanePath(path)) throw new ShellCommandError(`${path}: airship-sh excludes control-plane paths`);
  }
}

export function parentPath(path: string): string {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

export function baseName(path: string): string {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

export function joinPath(directory: string, name: string): string {
  return directory === "/" ? `/${name}` : `${directory}/${name}`;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function noSuchFile(path: string): ShellCommandError {
  return new ShellCommandError(`${path}: No such file or directory`);
}
