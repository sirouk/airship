import { decodeWorkspaceBytes, encodeWorkspaceBytes, workspaceContentByteLength } from "./content-codec";
import {
  isLocalFolderMountPath,
  localFolderAttachmentKey,
  LOCAL_FOLDER_MOUNT_ROOT,
  normalizeWorkspacePath,
  WorkspaceConflictError,
  type ClientEncryptedWorkspacePort,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspacePort,
} from "./contracts";

/**
 * How many files Airship will list from an attached folder.
 *
 * `list()` is the Explorer's whole tree and the agent's whole file inventory,
 * and the File System Access API can only report a file's size and timestamp
 * by opening it — one `getFile()` per entry, every refresh. A bound is
 * therefore not a nicety; without one, attaching a folder that contains
 * `node_modules` would freeze the route.
 *
 * The bound fails closed and says so (`too-large`). A truncated tree is the one
 * outcome this must never produce: a person who is told "5,000 files, open a
 * subfolder" can act, while a person shown 5,000 of 60,000 files with no notice
 * will conclude the other 55,000 do not exist — and so will the agent.
 */
export const LOCAL_FOLDER_MAX_ENTRIES = 5_000;

/**
 * The largest single file `read()` will materialise from the folder.
 *
 * A whole-file read crosses `WorkspacePort` as one string, so it is bounded for
 * the same reason `repository-import` bounds a blob. `readBounded()` has no
 * such limit: it slices the file on disk and never holds more than the window
 * the caller asked for, which is what the Explorer and the editor use.
 */
export const LOCAL_FOLDER_MAX_FILE_BYTES = 32 * 1_024 * 1_024;

/** Airship's own Git never manages an attached folder, and never walks its objects. */
const SKIPPED_DIRECTORY_NAMES: readonly string[] = Object.freeze([".git"]);

export type LocalFolderPermissionMode = "read" | "readwrite";
export type LocalFolderPermissionState = "granted" | "denied" | "prompt";

/**
 * The parts of `FileSystemFileHandle` this port uses.
 *
 * Declared structurally rather than taken from `lib.dom`, because
 * `queryPermission`/`requestPermission` are Chromium extensions that no
 * TypeScript DOM library describes, and because a structural type is what lets
 * the unit tests drive the real code with a fake handle tree instead of a mock
 * of the port itself.
 */
export type LocalFileHandleLike = Readonly<{
  kind: "file";
  name: string;
  getFile(): Promise<LocalFileLike>;
  createWritable(options?: Readonly<{ keepExistingData?: boolean }>): Promise<LocalWritableLike>;
}>;

export type LocalFileLike = Readonly<{
  lastModified: number;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start: number, end: number): Readonly<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}>;

export type LocalWritableLike = Readonly<{
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}>;

export type LocalDirectoryHandleLike = Readonly<{
  kind: "directory";
  name: string;
  queryPermission?(descriptor: Readonly<{ mode: LocalFolderPermissionMode }>): Promise<LocalFolderPermissionState>;
  requestPermission?(descriptor: Readonly<{ mode: LocalFolderPermissionMode }>): Promise<LocalFolderPermissionState>;
  entries(): AsyncIterableIterator<readonly [string, LocalFileHandleLike | LocalDirectoryHandleLike]>;
  getDirectoryHandle(name: string, options?: Readonly<{ create?: boolean }>): Promise<LocalDirectoryHandleLike>;
  getFileHandle(name: string, options?: Readonly<{ create?: boolean }>): Promise<LocalFileHandleLike>;
  removeEntry(name: string, options?: Readonly<{ recursive?: boolean }>): Promise<void>;
}>;

export type LocalFolderFailure =
  | "unsupported"
  | "cancelled"
  | "permission-required"
  | "permission-denied"
  | "missing"
  | "too-large"
  | "unreadable";

/**
 * Every refusal this tier can produce, each carrying the sentence a person can
 * act on.
 *
 * A revoked or lost grant is the normal case, not the exceptional one: the
 * browser drops a directory permission when the tab is closed, and the folder
 * itself can be renamed or unmounted between sessions. So no path here returns
 * an empty listing — every one of them throws, with the folder's own name in
 * the sentence and the control that fixes it named after it.
 */
export class LocalFolderAccessError extends Error {
  constructor(readonly code: LocalFolderFailure, message: string) {
    super(message);
    this.name = "LocalFolderAccessError";
  }
}

export function localFolderPickerAvailable(scope: unknown = globalThis): boolean {
  return typeof (scope as { showDirectoryPicker?: unknown } | undefined)?.showDirectoryPicker === "function";
}

export const LOCAL_FOLDER_UNSUPPORTED_NOTICE =
  "Opening a folder on this device needs the File System Access API, which only Chromium browsers (Chrome, Edge, Brave, Arc) have today. "
  + "Everything else in Airship works in this browser: import a public GitHub repository, or work in the browser workspace.";

/**
 * The permission this tier asks for, in one place.
 *
 * `readwrite` is asked for once, at the moment the folder is opened, because
 * the agent's edits and the editor's saves both need it and a second prompt
 * mid-turn would arrive with no user gesture behind it and be refused.
 */
const GRANT: Readonly<{ mode: LocalFolderPermissionMode }> = Object.freeze({ mode: "readwrite" });

export async function localFolderPermission(handle: LocalDirectoryHandleLike): Promise<LocalFolderPermissionState> {
  // A handle with no permission methods is not a File System Access handle
  // Airship can reason about. Treating that as "granted" would be the silent
  // path this tier must not have.
  if (typeof handle.queryPermission !== "function") return "prompt";
  return handle.queryPermission(GRANT);
}

export async function requestLocalFolderPermission(handle: LocalDirectoryHandleLike): Promise<LocalFolderPermissionState> {
  if (typeof handle.requestPermission !== "function") return "prompt";
  return handle.requestPermission(GRANT);
}

/** The refusal for a grant that is not `granted`, named for the folder it is about. */
export function localFolderPermissionRefusal(
  name: string,
  state: LocalFolderPermissionState,
): LocalFolderAccessError {
  return state === "denied"
    ? new LocalFolderAccessError(
      "permission-denied",
      `Permission to “${name}” was refused, so Airship cannot read or write it. `
      + "Choose Reconnect folder to ask again, or Forget folder to remove it from this browser.",
    )
    : new LocalFolderAccessError(
      "permission-required",
      `Airship needs your permission again to read and write “${name}”. `
      + "Choose Reconnect folder; your browser will ask you to confirm.",
    );
}

/**
 * One `WorkspacePort` over one directory handle.
 *
 * It is a peer of `ProfileWorkspacePort`, not a variant of it: both present a
 * subtree as ordinary `/workspace`-rooted paths, and neither one's consumers
 * ever receive the authority underneath. The difference is only where the bytes
 * are — a browser-managed encrypted store there, the person's own directory
 * here, in place, never copied.
 */
export class LocalFolderWorkspacePort implements WorkspacePort {
  readonly mountPath: string;
  readonly folderName: string;

  constructor(private readonly root: LocalDirectoryHandleLike, mountPath: string) {
    const normalized = normalizeWorkspacePath(mountPath);
    if (!isLocalFolderMountPath(normalized) || normalized === LOCAL_FOLDER_MOUNT_ROOT) {
      throw new Error(`An attached folder mounts below ${LOCAL_FOLDER_MOUNT_ROOT}, not at ${normalized}.`);
    }
    this.mountPath = normalized;
    this.folderName = root.name;
  }

  async read(path: string): Promise<WorkspaceFile | undefined> {
    const located = await this.locate(path);
    if (!located) return undefined;
    const file = await this.openFile(located.handle);
    if (file.size > LOCAL_FOLDER_MAX_FILE_BYTES) {
      throw new LocalFolderAccessError(
        "too-large",
        `${path} is ${file.size} bytes. Airship reads at most ${LOCAL_FOLDER_MAX_FILE_BYTES} bytes of a folder file in one piece; open it in the editor, which reads a bounded window.`,
      );
    }
    return this.describe(located.path, encodeWorkspaceBytes(new Uint8Array(await file.arrayBuffer())), file);
  }

  async readBounded(path: string, maxBytes: number): Promise<WorkspaceFile | undefined> {
    const located = await this.locate(path);
    if (!located) return undefined;
    const file = await this.openFile(located.handle);
    const window = Math.max(0, Math.min(maxBytes, file.size));
    const bytes = new Uint8Array(await file.slice(0, window).arrayBuffer());
    const content = encodeWorkspaceBytes(window < file.size ? trimPartialUtf8(bytes) : bytes);
    // `size` stays the whole object, exactly as the contract requires, so a
    // bounded read can never be mistaken for the file's real length.
    return Object.freeze({
      ...this.describe(located.path, content, file),
      size: file.size,
      contentByteLength: file.size,
    });
  }

  async list(path: string = this.mountPath): Promise<WorkspaceEntry[]> {
    const normalized = normalizeWorkspacePath(path);
    const scope = normalized === "/workspace" ? this.mountPath : normalized;
    if (!isLocalFolderMountPath(scope)) return [];
    const segments = this.segments(scope, "list");
    const directory = await this.directory(segments, false);
    if (!directory) return [];
    const entries: WorkspaceEntry[] = [];
    await this.walk(directory, scope, entries);
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async write(
    path: string,
    content: string,
    options: Readonly<{ expectedRevision?: string | null }> = {},
  ): Promise<WorkspaceFile> {
    const segments = this.segments(path, "write");
    const name = segments[segments.length - 1];
    if (!name) throw new Error(`${LOCAL_FOLDER_MOUNT_ROOT} is a directory; name a file inside the attached folder.`);
    const existing = await this.locate(path);
    const current = existing ? this.revision(await this.openFile(existing.handle)) : undefined;
    assertExpectedRevision(options.expectedRevision, current);
    const directory = await this.directory(segments.slice(0, -1), true);
    if (!directory) throw new LocalFolderAccessError("missing", `The folder that would hold ${path} could not be created.`);
    const handle = await this.guard(() => directory.getFileHandle(name, { create: true }), path);
    const writable = await this.guard(() => handle.createWritable(), path);
    await writable.write(decodeWorkspaceBytes(content));
    await writable.close();
    return this.describe(this.present(segments), content, await this.openFile(handle));
  }

  async remove(path: string, options: Readonly<{ expectedRevision?: string }> = {}): Promise<void> {
    const segments = this.segments(path, "remove");
    const name = segments[segments.length - 1];
    if (!name) throw new Error(`${LOCAL_FOLDER_MOUNT_ROOT} is a directory; name a file inside the attached folder.`);
    const located = await this.locate(path);
    if (!located) return;
    if (options.expectedRevision !== undefined) {
      assertExpectedRevision(options.expectedRevision, this.revision(await this.openFile(located.handle)));
    }
    const directory = await this.directory(segments.slice(0, -1), false);
    if (!directory) return;
    await this.guard(() => directory.removeEntry(name), path);
  }

  /** The grant this port is holding right now, asked of the browser rather than remembered. */
  permission(): Promise<LocalFolderPermissionState> {
    return localFolderPermission(this.root);
  }

  private async walk(directory: LocalDirectoryHandleLike, prefix: string, entries: WorkspaceEntry[]): Promise<void> {
    for await (const [name, handle] of directory.entries()) {
      if (entries.length >= LOCAL_FOLDER_MAX_ENTRIES) {
        throw new LocalFolderAccessError(
          "too-large",
          `“${this.folderName}” holds more than ${LOCAL_FOLDER_MAX_ENTRIES} files. `
          + "Airship refuses to list a folder that large rather than show you part of it. Open a subfolder instead.",
        );
      }
      if (name === "" || name.includes("/") || name.includes("\\")) continue;
      const path = `${prefix}/${name}`;
      if (handle.kind === "directory") {
        if (SKIPPED_DIRECTORY_NAMES.includes(name)) continue;
        await this.walk(handle, path, entries);
        continue;
      }
      const file = await this.openFile(handle);
      entries.push(Object.freeze({
        path,
        revision: this.revision(file),
        updatedAt: new Date(file.lastModified).toISOString(),
        size: file.size,
        contentByteLength: file.size,
      }));
    }
  }

  private async locate(path: string): Promise<Readonly<{ path: string; handle: LocalFileHandleLike }> | undefined> {
    const segments = this.segments(path, "read");
    const name = segments[segments.length - 1];
    if (!name) return undefined;
    const directory = await this.directory(segments.slice(0, -1), false);
    if (!directory) return undefined;
    try {
      const handle = await directory.getFileHandle(name);
      return Object.freeze({ path: this.present(segments), handle });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw this.translate(error, path);
    }
  }

  private async directory(
    segments: readonly string[],
    create: boolean,
  ): Promise<LocalDirectoryHandleLike | undefined> {
    let directory = this.root;
    for (const segment of segments) {
      try {
        directory = await directory.getDirectoryHandle(segment, { create });
      } catch (error) {
        if (!create && isNotFound(error)) return undefined;
        throw this.translate(error, `${this.mountPath}/${segments.join("/")}`);
      }
    }
    return directory;
  }

  private segments(path: string, operation: string): string[] {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === this.mountPath) return [];
    if (!normalized.startsWith(`${this.mountPath}/`)) {
      throw new Error(`Cannot ${operation} ${normalized}: it is not inside the folder attached at ${this.mountPath}.`);
    }
    return normalized.slice(this.mountPath.length + 1).split("/");
  }

  private present(segments: readonly string[]): string {
    return segments.length ? `${this.mountPath}/${segments.join("/")}` : this.mountPath;
  }

  private revision(file: LocalFileLike): string {
    // The pair the filesystem itself owns. It is a compare-and-set token, not a
    // digest: it changes whenever the file is rewritten, which is exactly what
    // an optimistic write has to detect, and it costs no second read.
    return `${file.lastModified}:${file.size}`;
  }

  private describe(path: string, content: string, file: LocalFileLike): WorkspaceFile {
    return Object.freeze({
      path,
      content,
      revision: this.revision(file),
      updatedAt: new Date(file.lastModified).toISOString(),
      size: content.length,
      contentByteLength: workspaceContentByteLength(content),
    });
  }

  private async openFile(handle: LocalFileHandleLike): Promise<LocalFileLike> {
    return this.guard(() => handle.getFile(), `${this.mountPath}/${handle.name}`);
  }

  private async guard<T>(operation: () => Promise<T>, path: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.translate(error, path);
    }
  }

  private translate(error: unknown, path: string): Error {
    if (error instanceof LocalFolderAccessError) return error;
    const name = (error as { name?: string } | undefined)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      return localFolderPermissionRefusal(this.folderName, "prompt");
    }
    if (isNotFound(error)) {
      return new LocalFolderAccessError(
        "missing",
        `${path} is no longer in “${this.folderName}” on this device. It may have been moved, renamed or deleted outside Airship.`,
      );
    }
    return new LocalFolderAccessError(
      "unreadable",
      `Airship could not reach ${path} in “${this.folderName}”: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The backing workspace, with one attached folder inside it.
 *
 * This is the same decorator shape `ProfileWorkspacePort` and
 * `GitSynchronizedWorkspace` already use, and it is the only place the two
 * tiers meet: a path under the reserved mount goes to the folder, every other
 * path goes to the workspace that was already there. Nothing is copied in
 * either direction.
 */
export class MountedLocalFolderWorkspace implements WorkspacePort {
  /**
   * Forwarded from the backing authority on purpose.
   *
   * This marker answers "is the record Airship itself writes — memory, drafts,
   * session state — encrypted before it is persisted", and every one of those
   * records is written through the backing port. It is not a claim about the
   * attached folder, which holds nothing but the person's own files, in the
   * place they already are; the Workspace panel states that in the tier's own
   * words at the moment the folder is opened.
   */
  readonly encryptionBoundary?: ClientEncryptedWorkspacePort["encryptionBoundary"];

  constructor(
    /** The Profile workspace this folder was composed onto, so the shell can recompose. */
    readonly backing: WorkspacePort,
    readonly folder: LocalFolderWorkspacePort,
  ) {
    if ((backing as Partial<ClientEncryptedWorkspacePort>).encryptionBoundary === "airship-client-envelope-v1") {
      this.encryptionBoundary = "airship-client-envelope-v1";
    }
  }

  read(path: string): Promise<WorkspaceFile | undefined> {
    return this.route(path).read(path);
  }

  readBounded(path: string, maxBytes: number): Promise<WorkspaceFile | undefined> {
    const port = this.route(path);
    return port.readBounded ? port.readBounded(path, maxBytes) : port.read(path);
  }

  async list(path = "/workspace"): Promise<WorkspaceEntry[]> {
    const normalized = normalizeWorkspacePath(path);
    if (isLocalFolderMountPath(normalized)) return this.folder.list(normalized);
    const [backing, mounted] = await Promise.all([
      this.backing.list(normalized),
      normalized === "/workspace" ? this.folder.list() : Promise.resolve([] as WorkspaceEntry[]),
    ]);
    return [...backing, ...mounted].sort((left, right) => left.path.localeCompare(right.path));
  }

  write(
    path: string,
    content: string,
    options?: Readonly<{ expectedRevision?: string | null }>,
  ): Promise<WorkspaceFile> {
    return this.route(path).write(path, content, options);
  }

  remove(path: string, options?: Readonly<{ expectedRevision?: string }>): Promise<void> {
    return this.route(path).remove(path, options);
  }

  private route(path: string): WorkspacePort {
    return isLocalFolderMountPath(path) ? this.folder : this.backing;
  }
}

/**
 * The folder this browser profile has attached, if any.
 *
 * IndexedDB is the only store a `FileSystemDirectoryHandle` can survive in — it
 * is structured-cloneable and nothing else accepts it — and the handle is a
 * capability, not a path: it names a directory the person chose, and it carries
 * no access on its own. The grant is asked of the browser every time.
 */
export type LocalFolderRecord = Readonly<{
  handle: LocalDirectoryHandleLike;
  name: string;
  mountPath: string;
  attachedAt: string;
  /**
   * The Profile that opened it.
   *
   * Stored beside the handle, and compared on the way back out, so a record
   * written under one Profile cannot be mounted under another even if the key
   * it was filed under were ever reached by the wrong reader.
   */
  profileId: string;
}>;

const HANDLE_DATABASE = "airship-local-folder";
const HANDLE_STORE = "attachments";

/**
 * One attachment per Profile, under a key that names it.
 *
 * The store held a single `attached-folder-v1` record, so the second Profile
 * to boot recalled the first one's directory handle and composed it into its
 * own `/workspace`. An attachment made before this key existed is not adopted
 * by whichever Profile happens to open next: it names no Profile, so no
 * Profile may claim it, and the Workspace panel asks for the folder again.
 */
function handleKey(profileId: string): string {
  return `attached-folder-v2:${profileId}`;
}

export async function rememberLocalFolder(record: LocalFolderRecord, factory = indexedDbFactory()): Promise<void> {
  await withHandleStore(factory, "readwrite", (store) => store.put(record, handleKey(record.profileId)));
  markAttached(record.profileId, true);
}

export async function recallLocalFolder(
  profileId: string,
  factory = indexedDbFactory(),
): Promise<LocalFolderRecord | undefined> {
  const record = await withHandleStore(factory, "readonly", (store) => store.get(handleKey(profileId)));
  return isLocalFolderRecord(record) && record.profileId === profileId ? record : undefined;
}

export async function forgetLocalFolder(profileId: string, factory = indexedDbFactory()): Promise<void> {
  markAttached(profileId, false);
  await withHandleStore(factory, "readwrite", (store) => store.delete(handleKey(profileId)));
}

/**
 * Whether this browser profile has a folder to restore.
 *
 * Read from `localStorage` rather than IndexedDB because the shell asks it
 * synchronously, on every boot, to decide whether to fetch this pack at all. It
 * is a hint, never an authority: a `true` that IndexedDB cannot honour ends in
 * the same stated refusal as a revoked grant.
 */
export function localFolderAttachmentRecorded(profileId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(localFolderAttachmentKey(profileId)) === "attached";
  } catch {
    return false;
  }
}

function markAttached(profileId: string, attached: boolean): void {
  const key = localFolderAttachmentKey(profileId);
  try {
    if (attached) globalThis.localStorage?.setItem(key, "attached");
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // A browser that refuses storage still attaches for this page's lifetime.
  }
}

/**
 * Ask the person for a folder, and hold on to it.
 *
 * The picker is the grant: Chromium gives `readwrite` on the directory the
 * person chose and on nothing else. Cancelling is a decision, not a failure,
 * and it is reported as one.
 */
export async function openLocalFolder(options: Readonly<{
  /** The Profile that will hold this attachment, and the only one that may. */
  profileId: string;
  scope?: { showDirectoryPicker?: (init?: unknown) => Promise<LocalDirectoryHandleLike> };
  indexedDB?: IDBFactory;
}>): Promise<LocalFolderWorkspacePort> {
  const scope = options.scope ?? (globalThis as { showDirectoryPicker?: (init?: unknown) => Promise<LocalDirectoryHandleLike> });
  if (typeof scope.showDirectoryPicker !== "function") {
    throw new LocalFolderAccessError("unsupported", LOCAL_FOLDER_UNSUPPORTED_NOTICE);
  }
  let handle: LocalDirectoryHandleLike;
  try {
    handle = await scope.showDirectoryPicker({ id: "airship-workspace", mode: "readwrite" });
  } catch (error) {
    if ((error as { name?: string } | undefined)?.name === "AbortError") {
      throw new LocalFolderAccessError("cancelled", "No folder was opened, and nothing on this device changed.");
    }
    throw new LocalFolderAccessError(
      "unreadable",
      `The folder picker did not return a folder: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const granted = await localFolderPermission(handle) === "granted"
    ? "granted"
    : await requestLocalFolderPermission(handle);
  if (granted !== "granted") throw localFolderPermissionRefusal(handle.name, granted);
  const mountPath = localFolderMountPath(handle.name);
  const record: LocalFolderRecord = Object.freeze({
    handle,
    name: handle.name,
    mountPath,
    attachedAt: new Date().toISOString(),
    profileId: options.profileId,
  });
  await rememberLocalFolder(record, options.indexedDB ?? indexedDbFactory());
  return new LocalFolderWorkspacePort(handle, mountPath);
}

/**
 * Reopen the remembered folder, without ever prompting.
 *
 * A boot has no user gesture, so `requestPermission` here would be refused by
 * the browser and would teach a person that Airship "lost" their folder. This
 * only reports what the grant already is; the panel turns a `prompt` into one
 * button the person presses.
 */
export async function restoreLocalFolder(profileId: string, factory = indexedDbFactory()): Promise<
  | Readonly<{ state: "attached"; port: LocalFolderWorkspacePort; record: LocalFolderRecord }>
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "blocked"; record: LocalFolderRecord; reason: LocalFolderAccessError }>
> {
  const record = await recallLocalFolder(profileId, factory);
  if (!record) {
    markAttached(profileId, false);
    return Object.freeze({ state: "absent" as const });
  }
  const permission = await localFolderPermission(record.handle);
  if (permission !== "granted") {
    return Object.freeze({
      state: "blocked" as const,
      record,
      reason: localFolderPermissionRefusal(record.name, permission),
    });
  }
  return Object.freeze({
    state: "attached" as const,
    record,
    port: new LocalFolderWorkspacePort(record.handle, record.mountPath),
  });
}

/**
 * Take a grant a person has already refused once, from inside their click.
 *
 * Chromium only shows the permission prompt during a user gesture, so this is
 * called by the Reconnect control and by nothing else.
 */
export async function reconnectLocalFolder(record: LocalFolderRecord): Promise<LocalFolderWorkspacePort> {
  const state = await localFolderPermission(record.handle) === "granted"
    ? "granted"
    : await requestLocalFolderPermission(record.handle);
  if (state !== "granted") throw localFolderPermissionRefusal(record.name, state);
  return new LocalFolderWorkspacePort(record.handle, record.mountPath);
}

/**
 * Where a folder called `name` appears.
 *
 * The folder's own name is kept because it is what a person and an agent both
 * say out loud — "edit src/main.ts in airship" — and a mount called `local`
 * would make every path in the conversation ambiguous. Anything that is not a
 * safe single path segment becomes `folder`, so the reserved root can never be
 * escaped by a directory name.
 */
export function localFolderMountPath(name: string): string {
  const trimmed = name.trim();
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(trimmed) && trimmed !== "." && trimmed !== ".."
    ? trimmed
    : "folder";
  return `${LOCAL_FOLDER_MOUNT_ROOT}/${safe}`;
}

function assertExpectedRevision(expected: string | null | undefined, current: string | undefined): void {
  if (expected === undefined) return;
  if (expected === null) {
    if (current !== undefined) {
      throw new WorkspaceConflictError("That file already exists in the attached folder; Airship did not overwrite it.");
    }
    return;
  }
  if (current !== expected) {
    throw new WorkspaceConflictError(
      "That file changed on this device since Airship last read it, so the write was refused. Reopen the file and try again.",
    );
  }
}

/**
 * Drop a trailing byte sequence that a byte-window cut in half.
 *
 * Without this a bounded read of a UTF-8 file could end mid-character, fail to
 * decode, and be handed to the caller inside the binary envelope — so an
 * ordinary source file would render as base64 in the editor exactly when it was
 * large enough to need a window.
 */
export function trimPartialUtf8(bytes: Uint8Array): Uint8Array {
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const byte = bytes[bytes.length - back] ?? 0;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue;
    const expected = (byte & 0b1000_0000) === 0 ? 1
      : (byte & 0b1110_0000) === 0b1100_0000 ? 2
        : (byte & 0b1111_0000) === 0b1110_0000 ? 3
          : (byte & 0b1111_1000) === 0b1111_0000 ? 4 : 1;
    return expected === back ? bytes : bytes.subarray(0, bytes.length - back);
  }
  return bytes;
}

function isNotFound(error: unknown): boolean {
  return (error as { name?: string } | undefined)?.name === "NotFoundError";
}

function isLocalFolderRecord(value: unknown): value is LocalFolderRecord {
  const record = value as Partial<LocalFolderRecord> | undefined;
  return Boolean(record
    && typeof record.name === "string"
    && typeof record.mountPath === "string"
    && typeof record.profileId === "string"
    && record.handle
    && (record.handle as LocalDirectoryHandleLike).kind === "directory");
}

function indexedDbFactory(): IDBFactory {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) {
    throw new LocalFolderAccessError(
      "unsupported",
      "This browser has no IndexedDB, so Airship cannot remember a folder between reloads.",
    );
  }
  return factory;
}

function withHandleStore<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const open = factory.open(HANDLE_DATABASE, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(HANDLE_STORE)) open.result.createObjectStore(HANDLE_STORE);
    };
    open.onerror = () => reject(handleStoreFailure(open.error));
    open.onsuccess = () => {
      const database = open.result;
      let request: IDBRequest<T>;
      try {
        request = operation(database.transaction(HANDLE_STORE, mode).objectStore(HANDLE_STORE));
      } catch (error) {
        database.close();
        reject(handleStoreFailure(error));
        return;
      }
      request.onerror = () => { database.close(); reject(handleStoreFailure(request.error)); };
      request.onsuccess = () => { database.close(); resolve(request.result); };
    };
  });
}

function handleStoreFailure(error: unknown): LocalFolderAccessError {
  return new LocalFolderAccessError(
    "unreadable",
    "This browser refused the storage Airship remembers an attached folder in, so the folder cannot survive a reload here. "
    + `Open it again after reloading. (${error instanceof Error ? error.message : String(error)})`,
  );
}
