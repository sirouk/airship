import {
  CONTEXT_ROUTING_MIRROR_PATH,
  normalizeWorkspacePath,
  type ClientEncryptedWorkspacePort,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspacePort,
} from "./contracts";

export const PROFILE_WORKSPACE_ROOT = "/workspace/.airship/profile-workspaces/v1";

/** True for a backing path that belongs to some Profile's namespace. */
export function isProfileWorkspacePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized === PROFILE_WORKSPACE_ROOT || normalized.startsWith(`${PROFILE_WORKSPACE_ROOT}/`);
}

/**
 * The `/workspace`-rooted path a storage path presents as inside its Profile.
 *
 * Storage-level paths are all under the reserved namespace, so asking whether
 * one is control-plane is meaningless without first translating it back into
 * the view a Profile actually sees. Returns undefined for a path that is not
 * inside any Profile namespace.
 */
export function profileFacingWorkspacePath(storagePath: string): string | undefined {
  const normalized = normalizeWorkspacePath(storagePath);
  if (!normalized.startsWith(`${PROFILE_WORKSPACE_ROOT}/`)) return undefined;
  const relative = normalized.slice(PROFILE_WORKSPACE_ROOT.length + 1);
  const separator = relative.indexOf("/");
  // The first segment is the Profile directory itself; anything shorter is the
  // namespace root, which presents as `/workspace`.
  return separator < 0 ? "/workspace" : `/workspace/${relative.slice(separator + 1)}`;
}

/**
 * Present one Profile's storage namespace as an ordinary `/workspace`.
 *
 * The backing Vault/OPFS/S3 authority remains global, while every path visible
 * to files, Git, indexes, tools, memory, Proof acquisition, and terminals is
 * rooted under the active Profile. Consumers never receive the backing port.
 */
export class ProfileWorkspacePort implements WorkspacePort {
  readonly profileId: string;
  readonly backingRoot: string;
  readonly encryptionBoundary?: ClientEncryptedWorkspacePort["encryptionBoundary"];

  constructor(
    private readonly backing: WorkspacePort,
    profileId: string,
  ) {
    this.profileId = normalizeProfileId(profileId);
    this.backingRoot = `${PROFILE_WORKSPACE_ROOT}/p-${encodeURIComponent(this.profileId)}`;
    if ((backing as Partial<ClientEncryptedWorkspacePort>).encryptionBoundary === "airship-client-envelope-v1") {
      this.encryptionBoundary = "airship-client-envelope-v1";
    }
  }

  async read(path: string): Promise<WorkspaceFile | undefined> {
    const file = await this.backing.read(this.toBacking(path));
    return file ? this.fromBackingFile(file) : undefined;
  }

  async readBounded(path: string, maxBytes: number): Promise<WorkspaceFile | undefined> {
    const file = this.backing.readBounded
      ? await this.backing.readBounded(this.toBacking(path), maxBytes)
      : await this.backing.read(this.toBacking(path));
    return file ? this.fromBackingFile(file) : undefined;
  }

  async list(path = "/workspace"): Promise<WorkspaceEntry[]> {
    const entries = await this.backing.list(this.toBacking(path));
    return entries.map((entry) => this.fromBackingEntry(entry)).sort((left, right) => left.path.localeCompare(right.path));
  }

  async write(
    path: string,
    content: string,
    options: { expectedRevision?: string | null } = {},
  ): Promise<WorkspaceFile> {
    const file = await this.backing.write(this.toBacking(path), content, options);
    return this.fromBackingFile(file);
  }

  remove(path: string, options: { expectedRevision?: string } = {}): Promise<void> {
    return this.backing.remove(this.toBacking(path), options);
  }

  private toBacking(path: string): string {
    const normalized = normalizeWorkspacePath(path);
    return normalized === "/workspace"
      ? this.backingRoot
      : `${this.backingRoot}${normalized.slice("/workspace".length)}`;
  }

  private fromBackingEntry(entry: WorkspaceEntry): WorkspaceEntry {
    return Object.freeze({ ...entry, path: this.fromBackingPath(entry.path) });
  }

  private fromBackingFile(file: WorkspaceFile): WorkspaceFile {
    return Object.freeze({ ...file, path: this.fromBackingPath(file.path) });
  }

  private fromBackingPath(path: string): string {
    const normalized = normalizeWorkspacePath(path);
    if (normalized !== this.backingRoot && !normalized.startsWith(`${this.backingRoot}/`)) {
      throw new Error("Profile workspace backing authority returned a path outside the active Profile namespace.");
    }
    return normalized === this.backingRoot
      ? "/workspace"
      : `/workspace${normalized.slice(this.backingRoot.length)}`;
  }
}

/**
 * Records the *global* storage authority owns, which no Profile may adopt.
 *
 * Adoption's only other classifier is "is this path inside a Profile
 * namespace", which cannot tell pre-namespace user content from a control-plane
 * record the global authority is still actively writing. The encrypted-context
 * routing mirror is exactly that: it sat at the storage root, adoption read it
 * as a stray user file, and the first Profile to boot carried it off — leaving
 * a published generation with no pointer, so a reload had nothing to adopt.
 */
function isGlobalAuthorityPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized === CONTEXT_ROUTING_MIRROR_PATH;
}

/**
 * Give a pre-namespace workspace to the Profile that was using it.
 *
 * Before Profiles owned namespaces, all content sat at the storage root. Left
 * there it would simply disappear from the product, because no Profile's view
 * can address it. This moves it once, into whichever Profile is active at the
 * moment of adoption — the Profile whose work it was.
 *
 * Idempotent by construction rather than by a marker: nothing writes to the
 * storage root once namespaces exist, so a second call finds nothing to move.
 * Each path is copied before it is removed, so an interruption leaves the file
 * readable at one end or the other rather than lost in between, and a path the
 * namespace already holds is kept — a retry must not overwrite newer content
 * with the copy a previous attempt was in the middle of adopting.
 */
export async function adoptLegacyRootWorkspace(
  storage: WorkspacePort,
  profileId: string,
): Promise<readonly string[]> {
  const legacy = (await storage.list("/workspace"))
    .filter((entry) => !isProfileWorkspacePath(entry.path))
    .filter((entry) => !isGlobalAuthorityPath(entry.path));
  if (legacy.length === 0) return Object.freeze([]);
  const namespace = new ProfileWorkspacePort(storage, profileId);
  const adopted: string[] = [];
  for (const entry of legacy) {
    const file = await storage.read(entry.path);
    if (!file) continue;
    if (!await namespace.read(file.path)) {
      await namespace.write(file.path, file.content, { expectedRevision: null });
    }
    await storage.remove(entry.path, { expectedRevision: file.revision });
    adopted.push(file.path);
  }
  return Object.freeze(adopted);
}

export function profileWorkspaceIdentity(backingWorkspaceId: string, profileId: string): string {
  const authority = backingWorkspaceId.trim();
  if (!authority || authority.length > 1_536 || /[\u0000-\u001f\u007f]/u.test(authority)) {
    throw new Error("Backing workspace identity is invalid.");
  }
  return `${authority}::airship-profile=${encodeURIComponent(normalizeProfileId(profileId))}`;
}

function normalizeProfileId(value: string): string {
  const profileId = value.trim();
  if (!profileId || profileId.length > 256 || /[\u0000-\u001f\u007f]/u.test(profileId)) {
    throw new Error("Profile workspace identity is invalid.");
  }
  return profileId;
}
