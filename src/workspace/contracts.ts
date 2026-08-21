export type WorkspaceFile = {
  path: string;
  content: string;
  revision: string;
  updatedAt: string;
  /**
   * Bytes the storage authority holds for this object: the UTF-8 length of
   * `content` exactly as written. For a binary file that is the base64
   * `airship-git-binary-v1:` envelope, so it is a storage/quota bound and an
   * integrity witness — never the number to show a person.
   */
  size: number;
  /**
   * The file's own byte length, with the binary envelope decoded — what the
   * agent tools already report and what the Explorer and editor must show.
   *
   * Optional only because manifests and IndexedDB records written before this
   * field existed cannot supply it; read it through `workspaceEntryByteLength`
   * rather than directly so the legacy fallback stays in one place.
   */
  contentByteLength?: number;
};

export type WorkspaceEntry = Omit<WorkspaceFile, "content">;

/**
 * The size to show a person, in the file's own bytes.
 *
 * Binaries cross the string-valued WorkspacePort inside a base64 envelope that
 * is ~4/3 of the file, so rendering `size` made every image and archive read a
 * third larger than `read_file`/`stat_path` reported for the same path. Entries
 * predating `contentByteLength` still fall back to `size`: that is exactly as
 * wrong as before for those, and correct for text, which is the majority.
 */
export function workspaceEntryByteLength(entry: Pick<WorkspaceEntry, "size" | "contentByteLength">): number {
  return entry.contentByteLength ?? entry.size;
}

export interface WorkspacePort {
  read(path: string): Promise<WorkspaceFile | undefined>;
  /** Optional bounded display read. Returned `size` remains the full object size. */
  readBounded?(path: string, maxBytes: number): Promise<WorkspaceFile | undefined>;
  list(path?: string): Promise<WorkspaceEntry[]>;
  write(
    path: string,
    content: string,
    options?: { expectedRevision?: string | null },
  ): Promise<WorkspaceFile>;
  remove(path: string, options?: { expectedRevision?: string }): Promise<void>;
}

/**
 * A workspace whose implementation encrypts bytes on the client before they
 * cross its persistence boundary. Consumers that store private control-plane
 * state can require this marker instead of silently trusting an arbitrary
 * WorkspacePort (for example IndexedDB or a host filesystem adapter).
 */
export interface ClientEncryptedWorkspacePort extends WorkspacePort {
  readonly encryptionBoundary: "airship-client-envelope-v1";
}

/**
 * A workspace that can also seal bytes the caller owns, under the same key it
 * already encrypts its own objects with — without handing that key out.
 *
 * This exists so a person can take a *sealed* work bundle off this device. The
 * alternative was to give a route the Vault's `WorkspaceRootKey`, and the key
 * custody rule in this product is that the key stays inside the object that
 * holds it. The caller supplies a namespace so two unrelated sealed artifacts
 * can never be opened as one another, and receives ordinary bytes back.
 *
 * Only a Vault-backed workspace implements it. Page memory has no key, so the
 * sealed choice is simply unavailable there, and the surface says so rather
 * than implying an encryption that is not happening.
 */
export interface PortableSealPort {
  sealPortable(namespace: string, plaintext: Uint8Array): Promise<Uint8Array>;
  openPortable(namespace: string, sealed: Uint8Array): Promise<Uint8Array>;
}


export class WorkspaceConflictError extends Error {
  constructor(message = "The workspace file changed before this operation completed.") {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

export function normalizeWorkspacePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\\") || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error("Workspace paths must be non-empty UTF-8 paths without control characters or backslashes.");
  }
  const rooted = trimmed.startsWith("/") ? trimmed : `/workspace/${trimmed}`;
  const parts = rooted.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new Error("Workspace paths cannot contain . or ..");
  const normalized = `/${parts.join("/")}`;
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) {
    throw new Error("Workspace paths must stay inside /workspace.");
  }
  return normalized;
}

/**
 * The encrypted-context routing mirror: a pointer, owned by the storage
 * authority that published the generation it names.
 *
 * Declared here rather than beside the fabric so the workspace layer can name
 * it without importing the retrieval/vault graph, and so there is exactly one
 * spelling of the path that both the writer and the adoption fence agree on.
 */
export const CONTEXT_ROUTING_MIRROR_PATH = "/workspace/.airship/context/routing-mirror.v2.json";

/**
 * Airship's own reserved namespace: the *root* `.airship` tree and nothing else.
 *
 * This is deliberately narrower than `isWorkspaceControlPlanePath`, which also
 * covers every `.git` segment. Browser Git legitimately owns `.git` and has to
 * read and write it, so a Git-facing fence needs the Airship half on its own.
 *
 * Only the root tree is reserved. A repository that carries its own nested
 * `.airship` directory is user content: refusing to check it out or commit it
 * would corrupt the repository rather than protect Airship.
 */
export function isAirshipReservedPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized === "/workspace/.airship" || normalized.startsWith("/workspace/.airship/");
}

/**
 * Where an attached local folder appears inside `/workspace`.
 *
 * One reserved directory, declared beside the other workspace path rules
 * rather than inside the lazily fetched implementation, because two eager
 * consumers have to recognise it without pulling the File System Access code
 * into first paint: the Git worktree binding, which must never mirror a
 * person's own folder into Airship's object database, and the shell's decision
 * about whether to fetch that code at all.
 */
export const LOCAL_FOLDER_MOUNT_ROOT = "/workspace/local";

/**
 * The durable marker that says a folder was attached in this browser profile.
 *
 * The handle itself lives in IndexedDB, because a `FileSystemDirectoryHandle`
 * is structured-cloneable and nothing else can hold one. This key holds no
 * handle and grants no access; it exists so a boot that has never attached a
 * folder can decide not to fetch the local-folder pack at all.
 */
export const LOCAL_FOLDER_ATTACHMENT_KEY = "airship.workspace.local-folder.v1";

/**
 * The marker, per Profile.
 *
 * Every other storage tier is siloed by Profile — the workspace subtree, the
 * Git object database, the memory scope, the terminal metadata — and this one
 * was not: one `localStorage` key and one IndexedDB record meant a folder
 * opened while reading under one Profile was mounted into `/workspace/local`
 * for every other Profile in the browser, including ones created afterwards.
 * The Profile is part of the key so that crossing cannot be expressed.
 */
export function localFolderAttachmentKey(profileId: string): string {
  return `${LOCAL_FOLDER_ATTACHMENT_KEY}.${profileId}`;
}

/** True for the reserved mount root itself and for anything inside it. */
export function isLocalFolderMountPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized === LOCAL_FOLDER_MOUNT_ROOT || normalized.startsWith(`${LOCAL_FOLDER_MOUNT_ROOT}/`);
}

/** Private implementation records that must never enter model retrieval. */
export function isWorkspaceControlPlanePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return isGitWorkspaceControlPlanePath(normalized)
    || isBrowserGitControlPlanePath(normalized)
    // `.airship` is a reserved implementation namespace. Keep the predicate
    // closed over the whole namespace so a newly added checkpoint cannot
    // accidentally become model-readable before every consumer is updated.
    || isAirshipReservedPath(normalized);
}

export function isGitWorkspaceControlPlanePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return isLegacyGitCheckpointPath(normalized)
    || normalized.split("/").some((segment) => segment === ".git");
}

/** Old parallel Git checkpoint path; unlike real repository `.git`, do not migrate it as workspace state. */
export function isLegacyGitCheckpointPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized === "/workspace/.airship/git" || normalized.startsWith("/workspace/.airship/git/");
}

/**
 * Real browser Git metadata is part of the authoritative virtual filesystem,
 * but must never enter the editor tree, terminal snapshots, or model context.
 *
 * Keep the browser-native predicate explicit even though
 * `isGitWorkspaceControlPlanePath` is the broader retrieval/UI filter. Storage
 * migration skips only `isLegacyGitCheckpointPath`; genuine worktree `.git`
 * directories and the repository catalog migrate with the workspace so
 * Editor, Terminal, and Source Control continue to observe one repository
 * after a Vault transition.
 */
export function isBrowserGitControlPlanePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized === "/workspace/.airship/browser-git-repositories.v1.json"
    || normalized.includes("/.git/")
    || normalized.endsWith("/.git");
}
