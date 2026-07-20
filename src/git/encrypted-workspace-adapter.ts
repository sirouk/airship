import type { JsonValue } from "../core/contracts";
import { sha256, stableStringify } from "../core/hash";
import {
  WorkspaceConflictError,
  normalizeWorkspacePath,
  type ClientEncryptedWorkspacePort,
  type WorkspaceFile,
} from "../workspace/contracts";
import { GitCheckpointConflictError, GitValidationError } from "./errors";
import {
  MemoryGitAdapter,
  type MemoryGitRepositorySeed,
} from "./memory-adapter";
import type {
  BrowserGitAdapter,
  GitAdapterCapabilities,
  GitCloneRequest,
  GitCommitRequest,
  GitCreateBranchRequest,
  GitCreateWorktreeRequest,
  GitDiff,
  GitDiffRequest,
  GitFetchRequest,
  GitMutationResult,
  GitOperationContext,
  GitPushRequest,
  GitPortableCheckpoint,
  GitRemoveWorktreeRequest,
  GitRepositorySnapshot,
  GitSnapshotImportRequest,
  GitStageRequest,
  GitStatusRequest,
  GitWriteWorkingFileRequest,
  GitRemoveWorkingFileRequest,
  GitMoveWorkingFileRequest,
  GitSwitchBranchRequest,
  GitWorktreeSnapshot,
} from "./types";
import { GIT_LIMITS, assertNotAborted } from "./validation";

const DEFAULT_HEAD_PATH = "/workspace/.airship/git/head.v1.json";
const MAX_HEAD_BYTES = 12 * 1024 * 1024;
const MAX_REFERENCES = 500_000;
const MAX_CHECKPOINT_OBJECTS = 200_000;
const encoder = new TextEncoder();

type ObjectTree = readonly (readonly [string, string])[];
type DurableGitCheckpoint = Omit<GitPortableCheckpoint, "repositories" | "persistenceBase"> & Readonly<{
  repositories: readonly Readonly<{
    id: string;
    name: string;
    defaultBranch: string;
    revision: number;
    commits: readonly Readonly<{
      oid: string;
      parent?: string;
      tree: ObjectTree;
      message: string;
      author: Readonly<{ name: string; email: string }>;
      committedAt: string;
    }>[];
    branches: readonly (readonly [string, string])[];
    worktrees: readonly Readonly<{
      id: string;
      path: string;
      branch: string;
      head: string;
      index: ObjectTree;
      files: ObjectTree;
      revision: number;
    }>[];
    remotes: readonly (readonly [string, string])[];
  }>[];
}>;

type GitCheckpointHead = Readonly<{
  format: "airship-encrypted-git-checkpoint";
  version: 1;
  generation: number;
  stateDigest: string;
  state: DurableGitCheckpoint;
}>;

export const ENCRYPTED_WORKSPACE_GIT_CAPABILITIES: GitAdapterCapabilities = deepFreeze({
  adapterId: "airship-encrypted-workspace-git",
  adapterName: "Airship encrypted workspace Git adapter",
  storage: {
    backend: "encrypted-workspace",
    durable: true,
    detail: "Immutable content-addressed Git objects and one CAS checkpoint are client-encrypted through the active workspace vault.",
  },
  remote: {
    transport: "none",
    requiresCors: true,
    credentialPersistence: "none",
    detail: "No remote transport or credential is persisted. Approved CORS-safe snapshot import remains available.",
  },
  features: {
    status: { available: true },
    diff: { available: true },
    stage: { available: true },
    commit: { available: true },
    branch: { available: true },
    worktree: { available: true },
    "snapshot-import": { available: true },
    clone: { available: false, reason: "this adapter has no direct CORS-safe Git HTTP or host-provider transport" },
    fetch: { available: false, reason: "this adapter has no direct CORS-safe Git HTTP or host-provider transport" },
    push: { available: false, reason: "this adapter has no direct CORS-safe Git HTTP or host-provider transport" },
  },
});

export type EncryptedWorkspaceGitAdapterOptions = Readonly<{
  headPath?: string;
  now?: () => string;
  /**
   * A freshly booted page has no durable base. During automatic vault adoption
   * an existing encrypted checkpoint is authoritative and must be loaded rather
   * than rejected as an unrelated writer. Checkpoints carrying a persistence
   * base still use exact CAS reconciliation regardless of this setting.
   */
  unbasedExisting?: "conflict" | "load";
}>;

/**
 * Durable browser Git control plane. The adapter never writes a plaintext
 * device database: its only persistence dependency is a workspace that carries
 * Airship's client-encryption marker. Immutable file contents are addressed by
 * digest, then a small versioned head is advanced with compare-and-swap.
 */
export class EncryptedWorkspaceGitAdapter implements BrowserGitAdapter {
  readonly capabilities = ENCRYPTED_WORKSPACE_GIT_CAPABILITIES;
  private readonly headPath: string;
  private readonly objectPrefix: string;
  private readonly now: () => string;
  private headRevision: string;
  private generation: number;

  private constructor(
    private readonly workspace: ClientEncryptedWorkspacePort,
    private delegate: MemoryGitAdapter,
    head: WorkspaceFile,
    generation: number,
    options: EncryptedWorkspaceGitAdapterOptions,
  ) {
    this.headPath = checkpointPath(options.headPath);
    this.objectPrefix = this.headPath.slice(0, this.headPath.lastIndexOf("/")) + "/objects";
    this.now = options.now ?? (() => new Date().toISOString());
    this.headRevision = head.revision;
    this.generation = generation;
  }

  static async create(
    workspace: ClientEncryptedWorkspacePort,
    seeds: readonly MemoryGitRepositorySeed[],
    options: EncryptedWorkspaceGitAdapterOptions = {},
  ): Promise<EncryptedWorkspaceGitAdapter> {
    if (workspace.encryptionBoundary !== "airship-client-envelope-v1") {
      throw new GitValidationError("Durable Git metadata requires an Airship client-encrypted workspace.");
    }
    const headPath = checkpointPath(options.headPath);
    const existing = await workspace.read(headPath);
    if (existing) {
      const loaded = await loadCheckpoint(workspace, headPath, existing, options.now);
      return new EncryptedWorkspaceGitAdapter(workspace, loaded.adapter, existing, loaded.generation, options);
    }

    const initial = await MemoryGitAdapter.create(seeds, { now: options.now });
    try {
      const committed = await commitCheckpoint(workspace, headPath, initial.checkpoint(), 1, null);
      return new EncryptedWorkspaceGitAdapter(workspace, initial, committed, 1, options);
    } catch (cause) {
      if (!(cause instanceof GitCheckpointConflictError)) throw cause;
      const winner = await workspace.read(headPath);
      if (!winner) throw cause;
      const loaded = await loadCheckpoint(workspace, headPath, winner, options.now);
      return new EncryptedWorkspaceGitAdapter(workspace, loaded.adapter, winner, loaded.generation, options);
    }
  }

  /**
   * Adopt a live Ephemeral adapter when vault mode is enabled. Existing cloud
   * state wins; the supplied checkpoint is used only for an uninitialized
   * encrypted workspace.
   */
  static async createFromCheckpoint(
    workspace: ClientEncryptedWorkspacePort,
    checkpoint: GitPortableCheckpoint,
    options: EncryptedWorkspaceGitAdapterOptions = {},
  ): Promise<EncryptedWorkspaceGitAdapter> {
    if (workspace.encryptionBoundary !== "airship-client-envelope-v1") {
      throw new GitValidationError("Durable Git metadata requires an Airship client-encrypted workspace.");
    }
    // Validate and canonicalize before any persistence write.
    const initial = await MemoryGitAdapter.restore(checkpoint, { now: options.now });
    const headPath = checkpointPath(options.headPath);
    const existing = await workspace.read(headPath);
    if (existing) {
      const loaded = await loadCheckpoint(workspace, headPath, existing, options.now);
      const suppliedDigest = await checkpointDigest(initial.checkpoint());
      if (suppliedDigest === loaded.stateDigest) {
        return new EncryptedWorkspaceGitAdapter(workspace, loaded.adapter, existing, loaded.generation, options);
      }
      const base = checkpoint.persistenceBase;
      if (!base && options.unbasedExisting === "load") {
        return new EncryptedWorkspaceGitAdapter(workspace, loaded.adapter, existing, loaded.generation, options);
      }
      if (
        !base || base.adapterId !== "airship-encrypted-workspace-git" || base.headPath !== headPath ||
        base.headRevision !== existing.revision || base.generation !== loaded.generation || base.stateDigest !== loaded.stateDigest
      ) {
        throw new GitCheckpointConflictError();
      }
      const generation = loaded.generation + 1;
      const committed = await commitCheckpoint(workspace, headPath, initial.checkpoint(), generation, existing.revision);
      return new EncryptedWorkspaceGitAdapter(workspace, initial, committed, generation, options);
    }
    try {
      const committed = await commitCheckpoint(workspace, headPath, initial.checkpoint(), 1, null);
      return new EncryptedWorkspaceGitAdapter(workspace, initial, committed, 1, options);
    } catch (cause) {
      if (!(cause instanceof GitCheckpointConflictError)) throw cause;
      const winner = await workspace.read(headPath);
      if (!winner) throw cause;
      const loaded = await loadCheckpoint(workspace, headPath, winner, options.now);
      return new EncryptedWorkspaceGitAdapter(workspace, loaded.adapter, winner, loaded.generation, options);
    }
  }

  /** Export an isolated in-memory checkpoint for an explicit mode transition. */
  async exportCheckpoint(context: GitOperationContext): Promise<GitPortableCheckpoint> {
    await this.refresh(context.signal);
    assertNotAborted(context.signal);
    const checkpoint = this.delegate.checkpoint();
    return deepFreeze({
      ...checkpoint,
      persistenceBase: {
        adapterId: "airship-encrypted-workspace-git",
        headPath: this.headPath,
        headRevision: this.headRevision,
        generation: this.generation,
        stateDigest: await checkpointDigest(checkpoint),
      },
    });
  }

  async listRepositories(context: GitOperationContext): Promise<readonly GitRepositorySnapshot[]> {
    await this.refresh(context.signal);
    return Promise.all((await this.delegate.listRepositories(context)).map((repository) => this.decorateRepository(repository)));
  }

  async getRepository(repositoryId: string, context: GitOperationContext): Promise<GitRepositorySnapshot | undefined> {
    await this.refresh(context.signal);
    const repository = await this.delegate.getRepository(repositoryId, context);
    return repository ? this.decorateRepository(repository) : undefined;
  }

  async status(request: GitStatusRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot> {
    await this.refresh(context.signal);
    return this.delegate.status(request, context);
  }

  writeWorkingFile(request: GitWriteWorkingFileRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot> {
    return this.mutateWorktree(context, (candidate) => candidate.writeWorkingFile(request, context));
  }

  removeWorkingFile(request: GitRemoveWorkingFileRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot> {
    return this.mutateWorktree(context, (candidate) => candidate.removeWorkingFile(request, context));
  }

  moveWorkingFile(request: GitMoveWorkingFileRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot> {
    return this.mutateWorktree(context, (candidate) => candidate.moveWorkingFile(request, context));
  }

  async diff(request: GitDiffRequest, context: GitOperationContext): Promise<GitDiff> {
    await this.refresh(context.signal);
    return this.delegate.diff(request, context);
  }

  stage(request: GitStageRequest, context: GitOperationContext): Promise<GitMutationResult> {
    return this.mutate(context, (candidate) => candidate.stage(request, context));
  }

  unstage(request: GitStageRequest, context: GitOperationContext): Promise<GitMutationResult> {
    return this.mutate(context, (candidate) => candidate.unstage(request, context));
  }

  commit(request: GitCommitRequest, context: GitOperationContext): Promise<GitMutationResult> {
    return this.mutate(context, (candidate) => candidate.commit(request, context));
  }

  createBranch(request: GitCreateBranchRequest, context: GitOperationContext): Promise<GitMutationResult> {
    return this.mutate(context, (candidate) => candidate.createBranch(request, context));
  }

  switchBranch(request: GitSwitchBranchRequest, context: GitOperationContext): Promise<GitMutationResult> {
    return this.mutate(context, (candidate) => candidate.switchBranch(request, context));
  }

  createWorktree(request: GitCreateWorktreeRequest, context: GitOperationContext): Promise<GitMutationResult> {
    return this.mutate(context, (candidate) => candidate.createWorktree(request, context));
  }

  removeWorktree(request: GitRemoveWorktreeRequest, context: GitOperationContext): Promise<GitMutationResult> {
    return this.mutate(context, (candidate) => candidate.removeWorktree(request, context));
  }

  importSnapshot(request: GitSnapshotImportRequest, context: GitOperationContext): Promise<GitMutationResult> {
    return this.mutate(context, (candidate) => candidate.importSnapshot(request, context));
  }

  async clone(request: GitCloneRequest, context: GitOperationContext): Promise<GitMutationResult> {
    await this.refresh(context.signal);
    return this.delegate.clone(request, context);
  }

  async fetch(request: GitFetchRequest, context: GitOperationContext): Promise<GitMutationResult> {
    await this.refresh(context.signal);
    return this.delegate.fetch(request, context);
  }

  async push(request: GitPushRequest, context: GitOperationContext): Promise<GitMutationResult> {
    await this.refresh(context.signal);
    return this.delegate.push(request, context);
  }

  private async mutate(
    context: GitOperationContext,
    operation: (candidate: MemoryGitAdapter) => Promise<GitMutationResult>,
  ): Promise<GitMutationResult> {
    await this.refresh(context.signal);
    assertNotAborted(context.signal);
    const candidate = await MemoryGitAdapter.restore(this.delegate.checkpoint(), { now: this.now });
    const result = await operation(candidate);
    assertNotAborted(context.signal);
    const nextGeneration = this.generation + 1;
    const committed = await commitCheckpoint(
      this.workspace,
      this.headPath,
      candidate.checkpoint(),
      nextGeneration,
      this.headRevision,
    );
    this.delegate = candidate;
    this.generation = nextGeneration;
    this.headRevision = committed.revision;
    return this.decorateResult(result);
  }

  private async mutateWorktree(
    context: GitOperationContext,
    operation: (candidate: MemoryGitAdapter) => Promise<GitWorktreeSnapshot>,
  ): Promise<GitWorktreeSnapshot> {
    await this.refresh(context.signal);
    assertNotAborted(context.signal);
    const candidate = await MemoryGitAdapter.restore(this.delegate.checkpoint(), { now: this.now });
    const result = await operation(candidate);
    assertNotAborted(context.signal);
    const nextGeneration = this.generation + 1;
    const committed = await commitCheckpoint(this.workspace, this.headPath, candidate.checkpoint(), nextGeneration, this.headRevision);
    this.delegate = candidate;
    this.generation = nextGeneration;
    this.headRevision = committed.revision;
    return structuredClone(result);
  }

  private async refresh(signal: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    const head = await this.workspace.read(this.headPath);
    if (!head) throw new GitValidationError("Durable Git checkpoint disappeared from the encrypted workspace.");
    if (head.revision === this.headRevision) return;
    const loaded = await loadCheckpoint(this.workspace, this.headPath, head, this.now);
    assertNotAborted(signal);
    this.delegate = loaded.adapter;
    this.generation = loaded.generation;
    this.headRevision = head.revision;
  }

  private async decorateRepository(repository: GitRepositorySnapshot): Promise<GitRepositorySnapshot> {
    return deepFreeze({ ...repository, storage: this.capabilities.storage, capabilities: this.capabilities });
  }

  private decorateResult(result: GitMutationResult): GitMutationResult {
    return deepFreeze({
      ...result,
      repository: { ...result.repository, storage: this.capabilities.storage, capabilities: this.capabilities },
    });
  }
}

async function commitCheckpoint(
  workspace: ClientEncryptedWorkspacePort,
  headPath: string,
  checkpoint: GitPortableCheckpoint,
  generation: number,
  expectedRevision: string | null,
): Promise<WorkspaceFile> {
  const objectPrefix = headPath.slice(0, headPath.lastIndexOf("/")) + "/objects";
  const encoded = await encodeCheckpoint(checkpoint);
  for (const [digest, content] of encoded.objects) {
    await writeImmutable(workspace, `${objectPrefix}/${digest.slice("sha256:".length)}`, content, digest);
  }
  const stateDigest = await sha256(stableStringify(encoded.state as unknown as JsonValue));
  const head: GitCheckpointHead = {
    format: "airship-encrypted-git-checkpoint",
    version: 1,
    generation,
    stateDigest,
    state: encoded.state,
  };
  const content = stableStringify(head as unknown as JsonValue);
  if (encoder.encode(content).byteLength > MAX_HEAD_BYTES) throw new GitValidationError("Durable Git checkpoint head exceeds its bounded size.");
  return writeHead(workspace, headPath, content, expectedRevision);
}

async function encodeCheckpoint(checkpoint: GitPortableCheckpoint): Promise<{
  state: DurableGitCheckpoint;
  objects: ReadonlyMap<string, string>;
}> {
  const objects = new Map<string, string>();
  let references = 0;
  const convertTree = async (tree: readonly (readonly [string, string])[]): Promise<ObjectTree> => {
    const converted: (readonly [string, string])[] = [];
    for (const [path, content] of tree) {
      references += 1;
      if (references > MAX_REFERENCES) throw new GitValidationError("Durable Git checkpoint reference limit exceeded.");
      const digest = await sha256(content);
      const previous = objects.get(digest);
      if (previous !== undefined && previous !== content) throw new GitValidationError("Git object digest collision detected.");
      objects.set(digest, content);
      if (objects.size > MAX_CHECKPOINT_OBJECTS) throw new GitValidationError("Durable Git checkpoint object limit exceeded.");
      converted.push([path, digest]);
    }
    return converted;
  };
  const repositories = [] as Array<DurableGitCheckpoint["repositories"][number]>;
  for (const repository of checkpoint.repositories) {
    const commits = [] as Array<DurableGitCheckpoint["repositories"][number]["commits"][number]>;
    for (const commit of repository.commits) commits.push({ ...commit, tree: await convertTree(commit.tree) });
    const worktrees = [] as Array<DurableGitCheckpoint["repositories"][number]["worktrees"][number]>;
    for (const worktree of repository.worktrees) {
      worktrees.push({ ...worktree, index: await convertTree(worktree.index), files: await convertTree(worktree.files) });
    }
    repositories.push({ ...repository, commits, worktrees });
  }
  return { state: { version: 1, repositories }, objects };
}

async function checkpointDigest(checkpoint: GitPortableCheckpoint): Promise<string> {
  const encoded = await encodeCheckpoint(checkpoint);
  return sha256(stableStringify(encoded.state as unknown as JsonValue));
}

async function loadCheckpoint(
  workspace: ClientEncryptedWorkspacePort,
  headPath: string,
  file: WorkspaceFile,
  now?: () => string,
): Promise<{ adapter: MemoryGitAdapter; generation: number; stateDigest: string }> {
  if (file.path !== headPath || file.size > MAX_HEAD_BYTES || encoder.encode(file.content).byteLength > MAX_HEAD_BYTES) {
    throw new GitValidationError("Durable Git checkpoint head is invalid or too large.");
  }
  let parsed: GitCheckpointHead;
  try {
    parsed = JSON.parse(file.content) as GitCheckpointHead;
  } catch {
    throw new GitValidationError("Durable Git checkpoint head is not valid JSON.");
  }
  if (
    !parsed || parsed.format !== "airship-encrypted-git-checkpoint" || parsed.version !== 1 ||
    !Number.isSafeInteger(parsed.generation) || parsed.generation < 1 || !parsed.state || parsed.state.version !== 1
  ) {
    throw new GitValidationError("Durable Git checkpoint head schema is invalid.");
  }
  const stateDigest = await sha256(stableStringify(parsed.state as unknown as JsonValue));
  if (stateDigest !== parsed.stateDigest) throw new GitValidationError("Durable Git checkpoint state digest does not match.");
  const objectPrefix = headPath.slice(0, headPath.lastIndexOf("/")) + "/objects";
  const contents = new Map<string, string>();
  let references = 0;
  const restoreTree = async (tree: ObjectTree): Promise<readonly (readonly [string, string])[]> => {
    if (!Array.isArray(tree)) throw new GitValidationError("Durable Git checkpoint tree is invalid.");
    const restored: (readonly [string, string])[] = [];
    for (const entry of tree) {
      references += 1;
      if (references > MAX_REFERENCES || !Array.isArray(entry) || entry.length !== 2) {
        throw new GitValidationError("Durable Git checkpoint reference is invalid or exceeds its limit.");
      }
      const [path, digest] = entry;
      if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(digest)) throw new GitValidationError("Durable Git object digest is invalid.");
      let content = contents.get(digest);
      if (content === undefined) {
        if (contents.size >= MAX_CHECKPOINT_OBJECTS) throw new GitValidationError("Durable Git checkpoint object limit exceeded.");
        const object = await workspace.read(`${objectPrefix}/${digest.slice("sha256:".length)}`);
        if (!object || object.size > GIT_LIMITS.maxFileBytes) throw new GitValidationError(`Durable Git object ${digest} is missing or too large.`);
        if (await sha256(object.content) !== digest) throw new GitValidationError(`Durable Git object ${digest} failed integrity verification.`);
        content = object.content;
        contents.set(digest, content);
      }
      restored.push([path, content]);
    }
    return restored;
  };
  const repositories = [] as Array<GitPortableCheckpoint["repositories"][number]>;
  if (!Array.isArray(parsed.state.repositories)) throw new GitValidationError("Durable Git repository collection is invalid.");
  for (const repository of parsed.state.repositories) {
    const commits = [] as Array<GitPortableCheckpoint["repositories"][number]["commits"][number]>;
    if (!Array.isArray(repository.commits) || !Array.isArray(repository.worktrees)) throw new GitValidationError("Durable Git repository state is invalid.");
    for (const commit of repository.commits) commits.push({ ...commit, tree: await restoreTree(commit.tree) });
    const worktrees = [] as Array<GitPortableCheckpoint["repositories"][number]["worktrees"][number]>;
    for (const worktree of repository.worktrees) {
      worktrees.push({ ...worktree, index: await restoreTree(worktree.index), files: await restoreTree(worktree.files) });
    }
    repositories.push({ ...repository, commits, worktrees });
  }
  const adapter = await MemoryGitAdapter.restore({ version: 1, repositories }, { now });
  return { adapter, generation: parsed.generation, stateDigest: parsed.stateDigest };
}

async function writeImmutable(
  workspace: ClientEncryptedWorkspacePort,
  path: string,
  content: string,
  digest: string,
): Promise<void> {
  const existing = await workspace.read(path);
  if (existing) {
    if (existing.size > GIT_LIMITS.maxFileBytes || await sha256(existing.content) !== digest) {
      throw new GitValidationError(`Durable Git object ${digest} collided with different content.`);
    }
    return;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await workspace.write(path, content, { expectedRevision: null });
      return;
    } catch (cause) {
      if (!(cause instanceof WorkspaceConflictError)) throw cause;
      const winner = await workspace.read(path);
      if (winner) {
        if (winner.size > GIT_LIMITS.maxFileBytes || await sha256(winner.content) !== digest) {
          throw new GitValidationError(`Durable Git object ${digest} collided with different content.`);
        }
        return;
      }
    }
  }
  throw new GitCheckpointConflictError();
}

async function writeHead(
  workspace: ClientEncryptedWorkspacePort,
  path: string,
  content: string,
  expectedRevision: string | null,
): Promise<WorkspaceFile> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await workspace.write(path, content, { expectedRevision });
    } catch (cause) {
      if (!(cause instanceof WorkspaceConflictError)) throw cause;
      const current = await workspace.read(path);
      if ((current?.revision ?? null) !== expectedRevision) throw new GitCheckpointConflictError();
    }
  }
  throw new GitCheckpointConflictError();
}

function checkpointPath(input = DEFAULT_HEAD_PATH): string {
  const path = normalizeWorkspacePath(input);
  if (!path.startsWith("/workspace/.airship/git/") || path.endsWith("/")) {
    throw new GitValidationError("Durable Git checkpoint must stay under /workspace/.airship/git/.");
  }
  return path;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
