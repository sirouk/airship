import { deepFreeze } from "../core/freeze";
import { sha256, stableStringify } from "../core/hash";
import { GitCapabilityError, GitDomainError, GitNotFoundError, GitValidationError, GitVersionConflictError } from "./errors";
import type {
  BrowserGitAdapter,
  GitAdapterCapabilities,
  GitAddRemoteRequest,
  GitAuthor,
  GitCapability,
  GitCommitDetail,
  GitCommitSummary,
  GitCreateTagRequest,
  GitDeleteTagRequest,
  GitLogRequest,
  GitMergeRequest,
  GitRemoveRemoteRequest,
  GitResetRequest,
  GitRestoreRequest,
  GitSetRemoteUrlRequest,
  GitShowRequest,
  GitStashEntry,
  GitStashRequest,
  GitTagSummary,
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
  GitStageRequest,
  GitStatusEntry,
  GitStatusRequest,
  GitWriteWorkingFileRequest,
  GitRemoveWorkingFileRequest,
  GitMoveWorkingFileRequest,
  GitSwitchBranchRequest,
  GitWorktreeSnapshot,
  GitCloneRequest,
  GitSnapshotImportRequest,
} from "./types";
import {
  GIT_LIMITS,
  asciiCompare,
  assertNoCaseFoldCollisions,
  assertNotAborted,
  validateAuthor,
  validateBranchName,
  validateCommitMessage,
  validateFileContent,
  validateGitDestination,
  validateGitIdentifier,
  validateGitPath,
  validatePathList,
  validateRemoteUrl,
  validateRepositoryName,
} from "./validation";

type Tree = Map<string, string>;
type MemoryCommit = {
  oid: string;
  parent?: string;
  tree: Tree;
  message: string;
  author: GitAuthor;
  committedAt: string;
};
type MemoryWorktree = {
  id: string;
  path: string;
  branch: string;
  head: string;
  index: Tree;
  files: Tree;
  revision: number;
};
type MemoryRepository = {
  id: string;
  name: string;
  defaultBranch: string;
  revision: number;
  commits: Map<string, MemoryCommit>;
  branches: Map<string, string>;
  worktrees: Map<string, MemoryWorktree>;
  remotes: Map<string, string>;
};

export type MemoryGitRepositorySeed = Readonly<{
  id: string;
  name: string;
  defaultBranch?: string;
  worktreeId?: string;
  worktreePath?: string;
  files: Readonly<Record<string, string>>;
  /** Complete working tree. Omit to start clean. */
  workingFiles?: Readonly<Record<string, string>>;
  remoteUrl?: string;
}>;

/**
 * This adapter models Git semantics over plain maps; it has no object database,
 * no refs/tags namespace, no reflog and no config file. Anything that can only
 * be answered from real Git storage stays honestly unavailable rather than
 * being simulated into a plausible-looking answer.
 */
const SIMULATED_STATE_REASON = "this reference adapter simulates commit semantics in memory and has no Git object database, ref namespace, reflog, or config to read";

export const MEMORY_GIT_CAPABILITIES: GitAdapterCapabilities = deepFreeze({
  adapterId: "airship-memory-git",
  adapterName: "Airship in-memory Git reference adapter",
  storage: {
    backend: "memory",
    durable: false,
    detail: "Reference and test adapter. Repository state is lost on reload.",
  },
  remote: {
    transport: "none",
    requiresCors: true,
    credentialPersistence: "none",
    permittedOrigins: [],
    detail: "No remote transport is installed. Airship never inserts a hidden Git proxy.",
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
    history: { available: false, reason: SIMULATED_STATE_REASON },
    tag: { available: false, reason: SIMULATED_STATE_REASON },
    stash: { available: false, reason: SIMULATED_STATE_REASON },
    merge: { available: false, reason: SIMULATED_STATE_REASON },
    restore: { available: false, reason: SIMULATED_STATE_REASON },
    "remote-config": { available: false, reason: SIMULATED_STATE_REASON },
  },
});

/** A real local state machine used to prove index/commit/worktree semantics. */
export class MemoryGitAdapter implements BrowserGitAdapter {
  readonly capabilities = MEMORY_GIT_CAPABILITIES;
  private readonly repositories = new Map<string, MemoryRepository>();
  private persistenceBase?: GitPortableCheckpoint["persistenceBase"];

  private constructor(private readonly now: () => string) {}

  static async create(
    seeds: readonly MemoryGitRepositorySeed[],
    options: Readonly<{ now?: () => string }> = {},
  ): Promise<MemoryGitAdapter> {
    const adapter = new MemoryGitAdapter(options.now ?? (() => new Date().toISOString()));
    for (const seed of seeds) await adapter.addSeed(seed);
    return adapter;
  }

  /** Restore only a validated, self-consistent checkpoint. */
  static async restore(
    checkpoint: GitPortableCheckpoint,
    options: Readonly<{ now?: () => string }> = {},
  ): Promise<MemoryGitAdapter> {
    const adapter = new MemoryGitAdapter(options.now ?? (() => new Date().toISOString()));
    await adapter.restoreCheckpoint(checkpoint);
    return adapter;
  }

  /**
   * Export the complete volatile state without granting callers references to
   * the adapter's mutable Maps. Durable adapters content-address the strings
   * before committing this control plane.
   */
  checkpoint(): GitPortableCheckpoint {
    return deepFreeze({
      version: 1,
      ...(this.persistenceBase ? { persistenceBase: { ...this.persistenceBase } } : {}),
      repositories: [...this.repositories.values()].sort((a, b) => asciiCompare(a.id, b.id)).map((repository) => ({
        id: repository.id,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        revision: repository.revision,
        commits: [...repository.commits.values()].sort((a, b) => asciiCompare(a.oid, b.oid)).map((commit) => ({
          oid: commit.oid,
          ...(commit.parent ? { parent: commit.parent } : {}),
          tree: sortedTree(commit.tree),
          message: commit.message,
          author: { ...commit.author },
          committedAt: commit.committedAt,
        })),
        branches: [...repository.branches.entries()].sort(([a], [b]) => asciiCompare(a, b)),
        worktrees: [...repository.worktrees.values()].sort((a, b) => asciiCompare(a.id, b.id)).map((worktree) => ({
          id: worktree.id,
          path: worktree.path,
          branch: worktree.branch,
          head: worktree.head,
          index: sortedTree(worktree.index),
          files: sortedTree(worktree.files),
          revision: worktree.revision,
        })),
        remotes: [...repository.remotes.entries()].sort(([a], [b]) => asciiCompare(a, b)),
      })),
    });
  }

  async exportCheckpoint(context: GitOperationContext): Promise<GitPortableCheckpoint> {
    assertNotAborted(context.signal);
    return this.checkpoint();
  }

  async listRepositories(context: GitOperationContext): Promise<readonly GitRepositorySnapshot[]> {
    assertNotAborted(context.signal);
    return Promise.all([...this.repositories.values()].sort((a, b) => asciiCompare(a.id, b.id)).map((repo) => this.snapshot(repo)));
  }

  async getRepository(repositoryId: string, context: GitOperationContext): Promise<GitRepositorySnapshot | undefined> {
    assertNotAborted(context.signal);
    const repository = this.repositories.get(validateGitIdentifier(repositoryId, "Repository ID"));
    return repository ? this.snapshot(repository) : undefined;
  }

  async status(request: GitStatusRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot> {
    assertNotAborted(context.signal);
    const { repository, worktree } = this.locate(request);
    return this.worktreeSnapshot(repository, worktree);
  }

  async diff(request: GitDiffRequest, context: GitOperationContext): Promise<GitDiff> {
    assertNotAborted(context.signal);
    const { repository, worktree } = this.locate(request);
    const path = validateGitPath(request.path);
    const headTree = this.headTree(repository, worktree);
    const before = request.scope === "staged" ? headTree.get(path) : worktree.index.get(path);
    const after = request.scope === "staged" ? worktree.index.get(path) : worktree.files.get(path);
    const rendered = renderPatch(path, before, after);
    return deepFreeze({
      path,
      scope: request.scope,
      patch: rendered.patch,
      binary: false,
      truncated: rendered.truncated,
      byteLength: new TextEncoder().encode(rendered.patch).byteLength,
    });
  }

  async stage(request: GitStageRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const { repository, worktree } = this.locate(request);
    this.expectWorktreeVersion(worktree, request.expectedWorktreeVersion);
    const paths = validatePathList(request.paths);
    const status = this.statusEntries(repository, worktree);
    const changed = new Map(status.filter((item) => item.worktree).map((item) => [item.path, item]));
    for (const path of paths) if (!changed.has(path)) throw new GitValidationError(`${path} has no unstaged change.`);
    for (const path of paths) copyPath(worktree.files, worktree.index, path);
    this.bump(repository, worktree);
    return this.result(repository, worktree, paths);
  }

  async unstage(request: GitStageRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const { repository, worktree } = this.locate(request);
    this.expectWorktreeVersion(worktree, request.expectedWorktreeVersion);
    const paths = validatePathList(request.paths);
    const headTree = this.headTree(repository, worktree);
    const status = this.statusEntries(repository, worktree);
    const changed = new Map(status.filter((item) => item.index).map((item) => [item.path, item]));
    for (const path of paths) if (!changed.has(path)) throw new GitValidationError(`${path} has no staged change.`);
    for (const path of paths) copyPath(headTree, worktree.index, path);
    this.bump(repository, worktree);
    return this.result(repository, worktree, paths);
  }

  async commit(request: GitCommitRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const { repository, worktree } = this.locate(request);
    this.expectWorktreeVersion(worktree, request.expectedWorktreeVersion);
    const message = validateCommitMessage(request.message);
    const author = validateAuthor(request.author);
    const staged = this.statusEntries(repository, worktree).filter((entry) => entry.index);
    if (staged.length === 0) throw new GitDomainError("nothing-to-commit", "No staged changes are available to commit.");
    const committedAt = this.now();
    const tree = cloneTree(worktree.index);
    const oid = await commitDigest({ parent: worktree.head, tree, message, author, committedAt });
    // Web Crypto yields. Re-check the reviewed generation before the commit point
    // in case another client instance mutated this adapter during hashing.
    this.expectWorktreeVersion(worktree, request.expectedWorktreeVersion);
    repository.commits.set(oid, { oid, parent: worktree.head, tree, message, author, committedAt });
    repository.branches.set(worktree.branch, oid);
    worktree.head = oid;
    this.bump(repository, worktree);
    return this.result(repository, worktree, staged.map((entry) => entry.path), oid);
  }

  async createBranch(request: GitCreateBranchRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const { repository, worktree } = this.locate(request);
    this.expectWorktreeVersion(worktree, request.expectedWorktreeVersion);
    const name = validateBranchName(request.name);
    if (repository.branches.has(name)) throw new GitDomainError("branch-exists", `Branch ${name} already exists.`);
    const start = request.startPoint ? this.resolveRevision(repository, request.startPoint) : worktree.head;
    if (request.checkout) {
      this.requireClean(repository, worktree);
    }
    repository.branches.set(name, start);
    if (request.checkout) {
      worktree.branch = name;
      worktree.head = start;
      worktree.index = cloneTree(repository.commits.get(start)!.tree);
      worktree.files = cloneTree(worktree.index);
    }
    this.bump(repository, worktree);
    return this.result(repository, worktree, []);
  }

  async switchBranch(request: GitSwitchBranchRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const { repository, worktree } = this.locate(request);
    this.expectWorktreeVersion(worktree, request.expectedWorktreeVersion);
    const name = validateBranchName(request.name);
    const target = repository.branches.get(name);
    if (!target) throw new GitNotFoundError(`Branch ${name}`);
    if (name === worktree.branch) return this.result(repository, worktree, []);
    this.requireClean(repository, worktree);
    this.requireBranchAvailable(repository, name, worktree.id);
    const tree = repository.commits.get(target)?.tree;
    if (!tree) throw new GitDomainError("corrupt-ref", `Branch ${name} does not resolve to a known commit.`);
    worktree.branch = name;
    worktree.head = target;
    worktree.index = cloneTree(tree);
    worktree.files = cloneTree(tree);
    this.bump(repository, worktree);
    return this.result(repository, worktree, []);
  }

  async createWorktree(request: GitCreateWorktreeRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const repository = this.requireRepository(request.repositoryId);
    this.expectRepositoryVersion(repository, request.expectedRepositoryVersion);
    const id = validateGitIdentifier(request.worktreeId, "Worktree ID");
    if (repository.worktrees.has(id)) throw new GitDomainError("worktree-exists", `Worktree ${id} already exists.`);
    const branch = validateBranchName(request.branch);
    this.requireBranchAvailable(repository, branch);
    const head = repository.branches.get(branch);
    if (!head) throw new GitNotFoundError(`Branch ${branch}`);
    const tree = repository.commits.get(head)?.tree;
    if (!tree) throw new GitDomainError("corrupt-ref", `Branch ${branch} does not resolve to a known commit.`);
    const worktree: MemoryWorktree = {
      id,
      path: validateGitDestination(request.path),
      branch,
      head,
      index: cloneTree(tree),
      files: cloneTree(tree),
      revision: 1,
    };
    repository.worktrees.set(id, worktree);
    repository.revision += 1;
    return this.result(repository, worktree, []);
  }

  async removeWorktree(request: GitRemoveWorktreeRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const repository = this.requireRepository(request.repositoryId);
    this.expectRepositoryVersion(repository, request.expectedRepositoryVersion);
    const worktree = repository.worktrees.get(request.worktreeId);
    if (!worktree) throw new GitNotFoundError(`Worktree ${request.worktreeId}`);
    if (repository.worktrees.size === 1) throw new GitDomainError("last-worktree", "The final worktree cannot be removed.");
    this.requireClean(repository, worktree);
    repository.worktrees.delete(worktree.id);
    repository.revision += 1;
    return deepFreeze({ repository: await this.snapshot(repository), changedPaths: [] });
  }

  async clone(_request: GitCloneRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.remoteUnavailable("clone");
  }

  async importSnapshot(request: GitSnapshotImportRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const repositoryId = validateGitIdentifier(request.repositoryId, "Repository ID");
    await this.addSeed({
      id: repositoryId,
      name: request.name,
      defaultBranch: request.defaultBranch,
      worktreePath: request.destination,
      files: request.files,
      remoteUrl: request.sourceUrl,
    });
    const repository = this.requireRepository(repositoryId);
    const worktree = repository.worktrees.values().next().value as MemoryWorktree | undefined;
    if (!worktree) throw new GitDomainError("corrupt-worktree", "Imported repository has no worktree.");
    return this.result(repository, worktree, Object.keys(request.files));
  }

  async fetch(_request: GitFetchRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.remoteUnavailable("fetch");
  }

  async push(_request: GitPushRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.remoteUnavailable("push");
  }

  async log(_request: GitLogRequest, _context: GitOperationContext): Promise<readonly GitCommitSummary[]> {
    throw this.unavailable("history");
  }

  async show(_request: GitShowRequest, _context: GitOperationContext): Promise<GitCommitDetail> {
    throw this.unavailable("history");
  }

  async listTags(_repositoryId: string, _context: GitOperationContext): Promise<readonly GitTagSummary[]> {
    throw this.unavailable("tag");
  }

  async createTag(_request: GitCreateTagRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.unavailable("tag");
  }

  async deleteTag(_request: GitDeleteTagRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.unavailable("tag");
  }

  async listStash(_request: GitStatusRequest, _context: GitOperationContext): Promise<readonly GitStashEntry[]> {
    throw this.unavailable("stash");
  }

  async stash(_request: GitStashRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.unavailable("stash");
  }

  async merge(_request: GitMergeRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.unavailable("merge");
  }

  async restore(_request: GitRestoreRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.unavailable("restore");
  }

  async reset(_request: GitResetRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.unavailable("restore");
  }

  async addRemote(_request: GitAddRemoteRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.unavailable("remote-config");
  }

  async setRemoteUrl(_request: GitSetRemoteUrlRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.unavailable("remote-config");
  }

  async removeRemote(_request: GitRemoveRemoteRequest, _context: GitOperationContext): Promise<GitMutationResult> {
    throw this.unavailable("remote-config");
  }

  /** Simulates an authorized OPFS/File System Access worktree edit for tests and demos. */
  async writeWorkingFile(
    request: GitWriteWorkingFileRequest,
    context: GitOperationContext = { signal: new AbortController().signal },
  ): Promise<GitWorktreeSnapshot> {
    assertNotAborted(context.signal);
    const { repository, worktree } = this.locate(request);
    this.expectWorktreeVersion(worktree, request.expectedWorktreeVersion);
    const path = validateGitPath(request.path);
    const next = cloneTree(worktree.files);
    next.set(path, validateFileContent(request.content));
    assertNoCaseFoldCollisions(next.keys());
    worktree.files = next;
    this.bump(repository, worktree);
    return this.worktreeSnapshot(repository, worktree);
  }

  async removeWorkingFile(
    request: GitRemoveWorkingFileRequest,
    context: GitOperationContext = { signal: new AbortController().signal },
  ): Promise<GitWorktreeSnapshot> {
    assertNotAborted(context.signal);
    const { repository, worktree } = this.locate(request);
    this.expectWorktreeVersion(worktree, request.expectedWorktreeVersion);
    worktree.files.delete(validateGitPath(request.path));
    this.bump(repository, worktree);
    return this.worktreeSnapshot(repository, worktree);
  }

  async moveWorkingFile(
    request: GitMoveWorkingFileRequest,
    context: GitOperationContext = { signal: new AbortController().signal },
  ): Promise<GitWorktreeSnapshot> {
    assertNotAborted(context.signal);
    const { repository, worktree } = this.locate(request);
    this.expectWorktreeVersion(worktree, request.expectedWorktreeVersion);
    const source = validateGitPath(request.sourcePath);
    const target = validateGitPath(request.targetPath);
    const content = worktree.files.get(source);
    if (content === undefined) throw new GitNotFoundError(`Working file ${source}`);
    if (worktree.files.has(target)) throw new GitDomainError("path-exists", `Working file ${target} already exists.`);
    const next = cloneTree(worktree.files);
    next.set(target, content);
    next.delete(source);
    assertNoCaseFoldCollisions(next.keys());
    worktree.files = next;
    this.bump(repository, worktree);
    return this.worktreeSnapshot(repository, worktree);
  }

  private async addSeed(seed: MemoryGitRepositorySeed): Promise<void> {
    if (this.repositories.size >= 1_000) throw new GitValidationError("In-memory repository limit exceeded.");
    const id = validateGitIdentifier(seed.id, "Repository ID");
    if (this.repositories.has(id)) throw new GitValidationError(`Duplicate repository ${id}.`);
    const name = validateRepositoryName(seed.name);
    const branch = validateBranchName(seed.defaultBranch ?? "main");
    const files = seedTree(seed.files);
    const working = seed.workingFiles ? seedTree(seed.workingFiles) : cloneTree(files);
    const committedAt = this.now();
    const author = Object.freeze({ name: "Airship", email: "airship@local.invalid" });
    const oid = await commitDigest({ tree: files, message: "Initial snapshot", author, committedAt });
    const worktreeId = validateGitIdentifier(seed.worktreeId ?? "main", "Worktree ID");
    const repository: MemoryRepository = {
      id,
      name,
      defaultBranch: branch,
      revision: 1,
      commits: new Map([[oid, { oid, tree: cloneTree(files), message: "Initial snapshot", author, committedAt }]]),
      branches: new Map([[branch, oid]]),
      worktrees: new Map([[worktreeId, {
        id: worktreeId,
        path: validateVirtualWorktreePath(seed.worktreePath ?? worktreeId),
        branch,
        head: oid,
        index: cloneTree(files),
        files: working,
        revision: 1,
      }]]),
      remotes: new Map(seed.remoteUrl ? [["origin", validateRemoteUrl(seed.remoteUrl)]] : []),
    };
    this.repositories.set(id, repository);
  }

  private async restoreCheckpoint(checkpoint: GitPortableCheckpoint): Promise<void> {
    if (!checkpoint || checkpoint.version !== 1 || !Array.isArray(checkpoint.repositories)) {
      throw new GitValidationError("Unsupported Git checkpoint.");
    }
    if (checkpoint.repositories.length > 1_000) throw new GitValidationError("Git checkpoint repository limit exceeded.");
    if (checkpoint.persistenceBase) {
      const base = checkpoint.persistenceBase;
      if (
        base.adapterId !== "airship-encrypted-workspace-git" ||
        typeof base.headPath !== "string" || !base.headPath.startsWith("/workspace/.airship/git/") ||
        typeof base.headRevision !== "string" || !base.headRevision || base.headRevision.length > 1_024 ||
        !Number.isSafeInteger(base.generation) || base.generation < 1 ||
        !/^sha256:[A-Za-z0-9_-]{43}$/u.test(base.stateDigest)
      ) {
        throw new GitValidationError("Git checkpoint persistence base is invalid.");
      }
      this.persistenceBase = { ...base };
    }
    let commitCount = 0;
    let treeEntryCount = 0;
    for (const saved of checkpoint.repositories) {
      const id = validateGitIdentifier(saved.id, "Repository ID");
      if (this.repositories.has(id)) throw new GitValidationError(`Duplicate repository ${id}.`);
      const name = validateRepositoryName(saved.name);
      const defaultBranch = validateBranchName(saved.defaultBranch);
      const revision = validatePositiveRevision(saved.revision, "Repository revision");
      if (!Array.isArray(saved.commits) || !Array.isArray(saved.branches) || !Array.isArray(saved.worktrees) || !Array.isArray(saved.remotes)) {
        throw new GitValidationError("Git checkpoint repository collections are invalid.");
      }
      commitCount += saved.commits.length;
      if (commitCount > 100_000) throw new GitValidationError("Git checkpoint commit limit exceeded.");
      const commits = new Map<string, MemoryCommit>();
      for (const savedCommit of saved.commits) {
        const tree = restoreTree(savedCommit.tree);
        treeEntryCount += tree.size;
        if (treeEntryCount > 500_000) throw new GitValidationError("Git checkpoint tree-entry limit exceeded.");
        const message = validateCommitMessage(savedCommit.message);
        const author = validateAuthor(savedCommit.author);
        const committedAt = validateIsoTimestamp(savedCommit.committedAt);
        const parent = savedCommit.parent === undefined ? undefined : validateObjectId(savedCommit.parent);
        const oid = validateObjectId(savedCommit.oid);
        if (commits.has(oid)) throw new GitValidationError(`Duplicate commit ${oid}.`);
        const computed = await commitDigest({ ...(parent ? { parent } : {}), tree, message, author, committedAt });
        if (computed !== oid) throw new GitValidationError(`Commit ${oid} does not match its canonical contents.`);
        commits.set(oid, { oid, ...(parent ? { parent } : {}), tree, message, author, committedAt });
      }
      for (const commit of commits.values()) {
        if (commit.parent && !commits.has(commit.parent)) throw new GitValidationError(`Commit ${commit.oid} has an unknown parent.`);
      }
      const branches = new Map<string, string>();
      for (const entry of saved.branches) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new GitValidationError("Git checkpoint branch entry is invalid.");
        const branch = validateBranchName(entry[0]);
        const oid = validateObjectId(entry[1]);
        if (!commits.has(oid)) throw new GitValidationError(`Branch ${branch} does not resolve to a known commit.`);
        if (branches.has(branch)) throw new GitValidationError(`Duplicate branch ${branch}.`);
        branches.set(branch, oid);
      }
      if (!branches.has(defaultBranch)) throw new GitValidationError("Default branch is missing from the Git checkpoint.");
      const worktrees = new Map<string, MemoryWorktree>();
      const checkedOut = new Set<string>();
      for (const savedWorktree of saved.worktrees) {
        const worktreeId = validateGitIdentifier(savedWorktree.id, "Worktree ID");
        const branch = validateBranchName(savedWorktree.branch);
        const head = validateObjectId(savedWorktree.head);
        if (!branches.has(branch) || branches.get(branch) !== head || !commits.has(head)) {
          throw new GitValidationError(`Worktree ${worktreeId} does not match a known branch head.`);
        }
        if (checkedOut.has(branch)) throw new GitValidationError(`Branch ${branch} is checked out more than once.`);
        checkedOut.add(branch);
        if (worktrees.has(worktreeId)) throw new GitValidationError(`Duplicate worktree ${worktreeId}.`);
        const index = restoreTree(savedWorktree.index);
        const files = restoreTree(savedWorktree.files);
        treeEntryCount += index.size + files.size;
        if (treeEntryCount > 500_000) throw new GitValidationError("Git checkpoint tree-entry limit exceeded.");
        worktrees.set(worktreeId, {
          id: worktreeId,
          path: validateVirtualWorktreePath(savedWorktree.path),
          branch,
          head,
          index,
          files,
          revision: validatePositiveRevision(savedWorktree.revision, "Worktree revision"),
        });
      }
      if (worktrees.size === 0) throw new GitValidationError("Git checkpoint repository has no worktree.");
      const remotes = new Map<string, string>();
      for (const entry of saved.remotes) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new GitValidationError("Git checkpoint remote entry is invalid.");
        const remote = validateGitIdentifier(entry[0], "Remote name");
        if (remotes.has(remote)) throw new GitValidationError(`Duplicate remote ${remote}.`);
        remotes.set(remote, validateRemoteUrl(entry[1]));
      }
      this.repositories.set(id, { id, name, defaultBranch, revision, commits, branches, worktrees, remotes });
    }
  }

  private locate(request: GitStatusRequest): { repository: MemoryRepository; worktree: MemoryWorktree } {
    const repository = this.requireRepository(request.repositoryId);
    const worktree = repository.worktrees.get(validateGitIdentifier(request.worktreeId, "Worktree ID"));
    if (!worktree) throw new GitNotFoundError(`Worktree ${request.worktreeId}`);
    return { repository, worktree };
  }

  private requireRepository(repositoryId: string): MemoryRepository {
    const id = validateGitIdentifier(repositoryId, "Repository ID");
    const repository = this.repositories.get(id);
    if (!repository) throw new GitNotFoundError(`Repository ${id}`);
    return repository;
  }

  private expectWorktreeVersion(worktree: MemoryWorktree, expected: string): void {
    const actual = worktreeVersion(worktree);
    if (actual !== expected) throw new GitVersionConflictError(expected, actual);
  }

  private expectRepositoryVersion(repository: MemoryRepository, expected: string): void {
    const actual = repositoryVersion(repository);
    if (actual !== expected) throw new GitVersionConflictError(expected, actual);
  }

  private requireClean(repository: MemoryRepository, worktree: MemoryWorktree): void {
    if (this.statusEntries(repository, worktree).length > 0) {
      throw new GitDomainError("dirty-worktree", "Commit or discard worktree changes before switching this checkout.");
    }
  }

  private requireBranchAvailable(repository: MemoryRepository, branch: string, exceptWorktree?: string): void {
    if (!repository.branches.has(branch)) throw new GitNotFoundError(`Branch ${branch}`);
    for (const worktree of repository.worktrees.values()) {
      if (worktree.id !== exceptWorktree && worktree.branch === branch) {
        throw new GitDomainError("branch-checked-out", `Branch ${branch} is already checked out in worktree ${worktree.id}.`);
      }
    }
  }

  private resolveRevision(repository: MemoryRepository, revision: string): string {
    const branch = repository.branches.get(revision);
    if (branch) return branch;
    if (repository.commits.has(revision)) return revision;
    throw new GitNotFoundError(`Start point ${revision}`);
  }

  private headTree(repository: MemoryRepository, worktree: MemoryWorktree): Tree {
    const commit = repository.commits.get(worktree.head);
    if (!commit) throw new GitDomainError("corrupt-head", "Worktree HEAD does not resolve to a known commit.");
    return commit.tree;
  }

  private statusEntries(repository: MemoryRepository, worktree: MemoryWorktree): GitStatusEntry[] {
    const head = this.headTree(repository, worktree);
    const paths = new Set([...head.keys(), ...worktree.index.keys(), ...worktree.files.keys()]);
    return [...paths].sort(asciiCompare).flatMap((path) => {
      const indexKind = deltaKind(head.get(path), worktree.index.get(path));
      const worktreeKind = deltaKind(worktree.index.get(path), worktree.files.get(path));
      if (!indexKind && !worktreeKind) return [];
      const counts = lineCounts(
        worktreeKind ? worktree.index.get(path) : head.get(path),
        worktreeKind ? worktree.files.get(path) : worktree.index.get(path),
      );
      return [{
        path,
        index: indexKind ? { kind: indexKind } : null,
        worktree: worktreeKind ? { kind: worktreeKind } : null,
        ...counts,
      }];
    });
  }

  private async worktreeSnapshot(repository: MemoryRepository, worktree: MemoryWorktree): Promise<GitWorktreeSnapshot> {
    return deepFreeze({
      id: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
      head: worktree.head,
      version: worktreeVersion(worktree),
      status: this.statusEntries(repository, worktree),
    });
  }

  private async snapshot(repository: MemoryRepository): Promise<GitRepositorySnapshot> {
    const checkedOut = new Map([...repository.worktrees.values()].map((worktree) => [worktree.branch, worktree.id]));
    return deepFreeze({
      id: repository.id,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      version: repositoryVersion(repository),
      storage: this.capabilities.storage,
      remotes: [...repository.remotes.entries()].sort(([a], [b]) => asciiCompare(a, b)).map(([name, url]) => ({ name, url, transport: "direct-git-http" as const })),
      branches: [...repository.branches.entries()].sort(([a], [b]) => asciiCompare(a, b)).map(([name, oid]) => ({ name, oid, current: checkedOut.has(name) })),
      worktrees: await Promise.all([...repository.worktrees.values()].sort((a, b) => asciiCompare(a.id, b.id)).map((worktree) => this.worktreeSnapshot(repository, worktree))),
      capabilities: this.capabilities,
    });
  }

  private async result(repository: MemoryRepository, worktree: MemoryWorktree, changedPaths: readonly string[], commit?: string): Promise<GitMutationResult> {
    return deepFreeze({
      repository: await this.snapshot(repository),
      worktree: await this.worktreeSnapshot(repository, worktree),
      changedPaths: [...changedPaths].sort(asciiCompare),
      ...(commit ? { commit } : {}),
    });
  }

  private bump(repository: MemoryRepository, worktree: MemoryWorktree): void {
    worktree.revision += 1;
    repository.revision += 1;
  }

  private remoteUnavailable(capability: "clone" | "fetch" | "push"): GitCapabilityError {
    return this.unavailable(capability);
  }

  private unavailable(capability: GitCapability): GitCapabilityError {
    return new GitCapabilityError(capability, this.capabilities.features[capability].reason!);
  }
}

function seedTree(files: Readonly<Record<string, string>>): Tree {
  const entries = Object.entries(files);
  if (entries.length > GIT_LIMITS.maxSeedFiles) throw new GitValidationError("In-memory Git seed contains too many files.");
  const tree = new Map<string, string>();
  for (const [path, content] of entries) tree.set(validateGitPath(path), validateFileContent(content));
  assertNoCaseFoldCollisions(tree.keys());
  return tree;
}

function cloneTree(tree: Tree): Tree {
  return new Map(tree);
}

function sortedTree(tree: Tree): readonly (readonly [string, string])[] {
  return [...tree.entries()].sort(([a], [b]) => asciiCompare(a, b));
}

function restoreTree(entries: readonly (readonly [string, string])[]): Tree {
  if (!Array.isArray(entries) || entries.length > GIT_LIMITS.maxSeedFiles) {
    throw new GitValidationError("Git checkpoint tree is invalid or too large.");
  }
  const tree = new Map<string, string>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new GitValidationError("Git checkpoint tree entry is invalid.");
    const path = validateGitPath(entry[0]);
    if (tree.has(path)) throw new GitValidationError(`Duplicate Git checkpoint path ${path}.`);
    tree.set(path, validateFileContent(entry[1]));
  }
  assertNoCaseFoldCollisions(tree.keys());
  return tree;
}

function validatePositiveRevision(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new GitValidationError(`${label} must be a positive safe integer.`);
  return value;
}

function validateObjectId(value: string): string {
  if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(value)) throw new GitValidationError("Git checkpoint object ID is invalid.");
  return value;
}

function validateIsoTimestamp(value: string): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new GitValidationError("Git checkpoint commit time is invalid.");
  }
  return value;
}

function copyPath(source: Tree, destination: Tree, path: string): void {
  const content = source.get(path);
  if (content === undefined) destination.delete(path);
  else destination.set(path, content);
}

function validateVirtualWorktreePath(value: string): string {
  if (value === "/workspace" || value.startsWith("/workspace/")) {
    if (value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value) || value.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))) {
      throw new GitValidationError("Virtual worktree path must be a normalized workspace root.");
    }
    return value;
  }
  return validateGitIdentifier(value, "Virtual worktree path");
}

function deltaKind(before: string | undefined, after: string | undefined): "added" | "modified" | "deleted" | undefined {
  if (before === after) return undefined;
  if (before === undefined) return "added";
  if (after === undefined) return "deleted";
  return "modified";
}

function lineCounts(before = "", after = ""): { additions: number; deletions: number } {
  const left = lines(before);
  const right = lines(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  return { additions: right.length - prefix - suffix, deletions: left.length - prefix - suffix };
}

function renderPatch(path: string, before = "", after = ""): { patch: string; truncated: boolean } {
  if (before === after) return { patch: "", truncated: false };
  const left = lines(before);
  const right = lines(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const leftEnd = Math.min(left.length, left.length - suffix + 3);
  const rightEnd = Math.min(right.length, right.length - suffix + 3);
  const output = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${contextStart + 1},${leftEnd - contextStart} +${contextStart + 1},${rightEnd - contextStart} @@`,
  ];
  for (let index = contextStart; index < prefix; index += 1) output.push(` ${left[index] ?? ""}`);
  for (let index = prefix; index < left.length - suffix; index += 1) output.push(`-${left[index] ?? ""}`);
  for (let index = prefix; index < right.length - suffix; index += 1) output.push(`+${right[index] ?? ""}`);
  for (let index = 0; index < Math.min(3, suffix); index += 1) output.push(` ${right[right.length - suffix + index] ?? ""}`);
  return boundedPatch(output);
}

function boundedPatch(linesToWrite: readonly string[]): { patch: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const selected: string[] = [];
  let bytes = 0;
  for (const line of linesToWrite) {
    const next = encoder.encode(`${line}\n`).byteLength;
    if (bytes + next > GIT_LIMITS.maxDiffBytes - 64) return { patch: `${selected.join("\n")}\n… diff truncated by Airship …\n`, truncated: true };
    selected.push(line);
    bytes += next;
  }
  return { patch: `${selected.join("\n")}\n`, truncated: false };
}

function lines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replaceAll("\r\n", "\n");
  const result = normalized.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

async function commitDigest(input: Readonly<{
  parent?: string;
  tree: Tree;
  message: string;
  author: GitAuthor;
  committedAt: string;
}>): Promise<string> {
  const tree = [...input.tree.entries()].sort(([a], [b]) => asciiCompare(a, b)).map(([path, content]) => ({ path, content }));
  return sha256(stableStringify({
    version: 1,
    parent: input.parent ?? null,
    tree,
    message: input.message,
    author: input.author,
    committedAt: input.committedAt,
  }));
}

function repositoryVersion(repository: MemoryRepository): string {
  return `repo-v${repository.revision}`;
}

function worktreeVersion(worktree: MemoryWorktree): string {
  return `worktree-v${worktree.revision}`;
}
