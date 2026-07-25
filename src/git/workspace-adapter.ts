import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Buffer as BrowserBuffer } from "buffer";
import { sha256, stableStringify } from "../core/hash";
import {
  isBrowserGitControlPlanePath,
  normalizeWorkspacePath,
  WorkspaceConflictError,
  type WorkspacePort,
} from "../workspace/contracts";
import { GitDomainError, GitNotFoundError, GitValidationError, GitVersionConflictError } from "./errors";
import type {
  BrowserGitAdapter,
  GitAdapterCapabilities,
  GitAuthor,
  GitCloneRequest,
  GitCommitRequest,
  GitCreateBranchRequest,
  GitCreateWorktreeRequest,
  GitDiff,
  GitDiffRequest,
  GitFetchRequest,
  GitMutationResult,
  GitOperationContext,
  GitPortableCheckpoint,
  GitPushRequest,
  GitRemoveWorktreeRequest,
  GitRepositorySnapshot,
  GitSnapshotImportRequest,
  GitStageRequest,
  GitStatusEntry,
  GitStatusRequest,
  GitSwitchBranchRequest,
  GitWorktreeSnapshot,
  GitWriteWorkingFileRequest,
  GitRemoveWorkingFileRequest,
  GitMoveWorkingFileRequest,
} from "./types";
import {
  GIT_LIMITS,
  asciiCompare,
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
import { WorkspaceGitFileSystem } from "./workspace-fs";

const REGISTRY_PATH = "/workspace/.airship/browser-git-repositories.v1.json";
const REGISTRY_FORMAT = "airship-browser-git-registry";
const MAX_REPOSITORIES = 1_000;
const MAX_LINKED_WORKTREES = 256;
const MAX_ISSUED_VERSIONS = 128;
const encoder = new TextEncoder();

// isomorphic-git's index and packfile code still calls the Node Buffer API in
// browsers. Install the reviewed browser implementation inside this lazy Git
// pack; the baseline shell never downloads it.
const gitGlobal = globalThis as typeof globalThis & { Buffer?: typeof BrowserBuffer };
if (!gitGlobal.Buffer) Object.defineProperty(gitGlobal, "Buffer", { value: BrowserBuffer, configurable: true });

type RepositoryRecord = Readonly<{
  id: string;
  name: string;
  root: string;
  defaultBranch: string;
  worktreeId: string;
  linkedWorktrees: readonly LinkedWorktreeRecord[];
  remotes: readonly Readonly<{ name: string; url: string }>[];
  lastRemoteSyncAt?: string;
}>;

type LinkedWorktreeRecord = Readonly<{
  id: string;
  path: string;
  /** Safe conventional `.git/worktrees/<adminId>` directory name. */
  adminId: string;
}>;

type WorktreeRecord = Readonly<{
  id: string;
  path: string;
  adminId?: string;
}>;

type WorktreeTarget = Readonly<{
  repository: RepositoryRecord;
  worktree: WorktreeRecord;
  fs: git.PromiseFsClient;
  dir: string;
  gitdir: string;
}>;

type RegistryDocument = Readonly<{
  format: typeof REGISTRY_FORMAT;
  version: 1;
  repositories: readonly RepositoryRecord[];
}>;

type IssuedVersion = Readonly<{
  repositoryId: string;
  worktreeId?: string;
  revisions: ReadonlyMap<string, string>;
}>;

export type WorkspaceGitRepositorySeed = Readonly<{
  id: string;
  name: string;
  defaultBranch?: string;
  worktreeId?: string;
  /** Preferred spelling for the repository root in the shared workspace. */
  worktreePath?: string;
  /** Compatibility spelling used by clone/import request surfaces. */
  destination?: string;
  files: Readonly<Record<string, string>>;
  workingFiles?: Readonly<Record<string, string>>;
  remoteUrl?: string;
}>;

export type WorkspaceGitRemoteCredential = Readonly<{
  username: string;
  password?: string;
}>;

/**
 * Page-memory-only credential callback for direct Git Smart HTTP. The adapter
 * never serializes the callback or returned credential into Workspace, Git
 * config, approval material, terminal history, or a Vault checkpoint.
 */
export type WorkspaceGitRemoteCredentialBroker = (request: Readonly<{
  operation: "push";
  origin: string;
  remote: string;
  challengeUsername?: string;
}>) => Promise<WorkspaceGitRemoteCredential | undefined>;

export type WorkspaceGitAdapterOptions = Readonly<{
  now?: () => string;
  authenticate?: WorkspaceGitRemoteCredentialBroker;
}>;

/**
 * Genuine Git state backed by the same WorkspacePort used by Editor and
 * Terminal. isomorphic-git reads and writes a conventional `.git` namespace:
 * loose objects, refs, HEAD, config, and the binary index all live beside the
 * worktree in the browser-owned virtual filesystem.
 */
export class WorkspaceGitAdapter implements BrowserGitAdapter {
  readonly capabilities: GitAdapterCapabilities;
  private registryRevision?: string;
  private repositories: RepositoryRecord[] = [];
  private readonly issuedVersions = new Map<string, IssuedVersion>();

  private constructor(
    private readonly workspace: WorkspacePort,
    private readonly fs: WorkspaceGitFileSystem,
    private readonly now: () => string,
    private readonly authenticate?: WorkspaceGitRemoteCredentialBroker,
  ) {
    const durable = "encryptionBoundary" in workspace
      && (workspace as { encryptionBoundary?: string }).encryptionBoundary === "airship-client-envelope-v1";
    this.capabilities = capabilities(durable, Boolean(authenticate));
  }

  static async create(
    workspace: WorkspacePort,
    seeds: readonly WorkspaceGitRepositorySeed[],
    options: WorkspaceGitAdapterOptions = {},
  ): Promise<WorkspaceGitAdapter> {
    const adapter = new WorkspaceGitAdapter(
      workspace,
      new WorkspaceGitFileSystem(workspace),
      options.now ?? (() => new Date().toISOString()),
      options.authenticate,
    );
    const existing = await workspace.read(REGISTRY_PATH);
    if (existing) {
      adapter.repositories = parseRegistry(existing.content);
      adapter.registryRevision = existing.revision;
      await adapter.verifyRegisteredRepositories();
      return adapter;
    }
    if (seeds.length > MAX_REPOSITORIES) throw new GitValidationError("Browser Git repository limit exceeded.");
    for (const seed of seeds) await adapter.initializeSeed(seed);
    await adapter.persistRegistry(null);
    return adapter;
  }

  /**
   * Open existing real Git state, or lazily obtain seeds only when this
   * workspace has never had the standards-compatible repository registry.
   */
  static async open(
    workspace: WorkspacePort,
    seeds: readonly WorkspaceGitRepositorySeed[] | (() => Promise<readonly WorkspaceGitRepositorySeed[]>) = [],
    options: WorkspaceGitAdapterOptions = {},
  ): Promise<WorkspaceGitAdapter> {
    const existing = await workspace.read(REGISTRY_PATH);
    const candidates = existing ? [] : typeof seeds === "function" ? await seeds() : seeds;
    return this.create(workspace, candidates, options);
  }

  /**
   * The real `.git` namespace migrates with the WorkspacePort. A detached v1
   * semantic checkpoint cannot faithfully represent packfiles, reflogs, tags,
   * and index extensions, so this adapter refuses lossy export.
   */
  async exportCheckpoint(_context: GitOperationContext): Promise<GitPortableCheckpoint> {
    throw new GitDomainError(
      "workspace-git-is-authoritative",
      "This repository already lives in the authoritative workspace. Move the workspace, including its hidden .git files, instead of exporting a lossy semantic checkpoint.",
    );
  }

  async listRepositories(context: GitOperationContext): Promise<readonly GitRepositorySnapshot[]> {
    assertNotAborted(context.signal);
    await this.refreshRegistry();
    return Promise.all(this.repositories.map((repository) => this.snapshot(repository, context.signal)));
  }

  async getRepository(repositoryId: string, context: GitOperationContext): Promise<GitRepositorySnapshot | undefined> {
    assertNotAborted(context.signal);
    await this.refreshRegistry();
    const repository = this.repositories.find((candidate) => candidate.id === validateGitIdentifier(repositoryId, "Repository ID"));
    return repository ? this.snapshot(repository, context.signal) : undefined;
  }

  async status(request: GitStatusRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot> {
    assertNotAborted(context.signal);
    const target = await this.requireTarget(request);
    return this.worktreeSnapshot(target, context.signal);
  }

  async diff(request: GitDiffRequest, context: GitOperationContext): Promise<GitDiff> {
    assertNotAborted(context.signal);
    const target = await this.requireTarget(request);
    const path = validateGitPath(request.path);
    const content = await contentPlanes(target.fs, target.dir, target.gitdir, path);
    assertNotAborted(context.signal);
    const before = request.scope === "staged" ? content.head : content.stage;
    const after = request.scope === "staged" ? content.stage : content.workdir;
    const rendered = renderPatch(path, before, after);
    return deepFreeze({
      path,
      scope: request.scope,
      patch: rendered.patch,
      binary: rendered.binary,
      truncated: rendered.truncated,
      byteLength: encoder.encode(rendered.patch).byteLength,
    });
  }

  async writeWorkingFile(request: GitWriteWorkingFileRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot> {
    const target = await this.requireTarget(request);
    const path = validateGitPath(request.path);
    const content = validateFileContent(request.content);
    await this.acceptWorkspaceProjection(target, request.expectedWorktreeVersion, [path], context.signal);
    const absolute = normalizeWorkspacePath(`${target.dir}/${path}`);
    const current = await this.workspace.read(absolute);
    if (current?.content !== content) await this.workspace.write(absolute, content, { expectedRevision: current?.revision ?? null });
    return this.worktreeSnapshot(target, context.signal);
  }

  async removeWorkingFile(request: GitRemoveWorkingFileRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot> {
    const target = await this.requireTarget(request);
    const path = validateGitPath(request.path);
    await this.acceptWorkspaceProjection(target, request.expectedWorktreeVersion, [path], context.signal);
    const absolute = normalizeWorkspacePath(`${target.dir}/${path}`);
    const current = await this.workspace.read(absolute);
    if (current) await this.workspace.remove(absolute, { expectedRevision: current.revision });
    return this.worktreeSnapshot(target, context.signal);
  }

  async moveWorkingFile(request: GitMoveWorkingFileRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot> {
    const target = await this.requireTarget(request);
    const source = validateGitPath(request.sourcePath);
    const destination = validateGitPath(request.targetPath);
    await this.acceptWorkspaceProjection(target, request.expectedWorktreeVersion, [source, destination], context.signal);
    const sourcePath = normalizeWorkspacePath(`${target.dir}/${source}`);
    const targetPath = normalizeWorkspacePath(`${target.dir}/${destination}`);
    const [current, targetFile] = await Promise.all([this.workspace.read(sourcePath), this.workspace.read(targetPath)]);
    if (current && !targetFile) {
      const written = await this.workspace.write(targetPath, current.content, { expectedRevision: null });
      try { await this.workspace.remove(sourcePath, { expectedRevision: current.revision }); }
      catch (error) {
        await this.workspace.remove(targetPath, { expectedRevision: written.revision });
        throw error;
      }
    }
    return this.worktreeSnapshot(target, context.signal);
  }

  async stage(request: GitStageRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const paths = validatePathList(request.paths);
    const status = new Map((await statusEntries(target.fs, target.dir, target.gitdir)).map((entry) => [entry.path, entry]));
    for (const path of paths) {
      if (!status.get(path)?.worktree) throw new GitValidationError(`${path} has no unstaged change.`);
      const file = await this.workspace.read(normalizeWorkspacePath(`${target.dir}/${path}`));
      if (file) await git.add({ fs: target.fs, dir: target.dir, gitdir: target.gitdir, filepath: path });
      else await git.remove({ fs: target.fs, dir: target.dir, gitdir: target.gitdir, filepath: path });
    }
    assertNotAborted(context.signal);
    return this.result(target.repository, paths, context.signal, undefined, target.worktree.id);
  }

  async unstage(request: GitStageRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const paths = validatePathList(request.paths);
    const status = new Map((await statusEntries(target.fs, target.dir, target.gitdir)).map((entry) => [entry.path, entry]));
    for (const path of paths) {
      if (!status.get(path)?.index) throw new GitValidationError(`${path} has no staged change.`);
      await git.resetIndex({ fs: target.fs, dir: target.dir, gitdir: target.gitdir, filepath: path });
    }
    assertNotAborted(context.signal);
    return this.result(target.repository, paths, context.signal, undefined, target.worktree.id);
  }

  async commit(request: GitCommitRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const message = validateCommitMessage(request.message);
    const author = validateAuthor(request.author);
    const changed = (await statusEntries(target.fs, target.dir, target.gitdir)).filter((entry) => entry.index).map((entry) => entry.path);
    if (!changed.length) throw new GitDomainError("nothing-to-commit", "No staged changes are available to commit.");
    const identity = gitIdentity(author, this.now());
    const oid = await git.commit({ fs: target.fs, dir: target.dir, gitdir: target.gitdir, message, author: identity, committer: identity });
    assertNotAborted(context.signal);
    return this.result(target.repository, changed, context.signal, oid, target.worktree.id);
  }

  async createBranch(request: GitCreateBranchRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const name = validateBranchName(request.name);
    if (request.checkout === true) await this.requireBranchAvailable(target.repository, name, target.worktree.id);
    await git.branch({
      fs: target.fs,
      dir: target.dir,
      gitdir: target.gitdir,
      ref: name,
      ...(request.startPoint ? { object: request.startPoint } : {}),
      checkout: request.checkout === true,
    });
    return this.result(target.repository, [], context.signal, undefined, target.worktree.id);
  }

  async switchBranch(request: GitSwitchBranchRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    if ((await statusEntries(target.fs, target.dir, target.gitdir)).length) {
      throw new GitDomainError("dirty-worktree", "Commit or discard worktree changes before switching this checkout.");
    }
    const branch = validateBranchName(request.name);
    await this.requireBranchAvailable(target.repository, branch, target.worktree.id);
    await git.checkout({ fs: target.fs, dir: target.dir, gitdir: target.gitdir, ref: branch, nonBlocking: true });
    return this.result(target.repository, [], context.signal, undefined, target.worktree.id);
  }

  async createWorktree(request: GitCreateWorktreeRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const repository = await this.requireRepository(request.repositoryId);
    await this.expectRepositoryVersion(repository, request.expectedRepositoryVersion, context.signal);
    const id = validateGitIdentifier(request.worktreeId, "Worktree ID");
    if (repository.linkedWorktrees.length >= MAX_LINKED_WORKTREES) throw new GitValidationError("Linked worktree limit exceeded.");
    if (allWorktrees(repository).some((candidate) => candidate.id === id)) {
      throw new GitDomainError("worktree-exists", `Worktree ${id} already exists.`);
    }
    const path = validateGitDestination(request.path);
    const branch = validateBranchName(request.branch);
    const reviewedRegistryRevision = this.registryRevision;
    await this.assertWorktreeDestinationAvailable(repository, path);
    await this.requireBranchAvailable(repository, branch);
    const branches = await git.listBranches({ fs: this.fs.client, dir: repository.root, gitdir: commonGitdir(repository) });
    if (!branches.includes(branch)) throw new GitNotFoundError(`Branch ${branch}`);

    const adminId = await this.worktreeAdminId(repository, id);
    const linked = deepFreeze({ id, path, adminId });
    const gitdir = linkedGitdir(repository, linked);
    const dotgit = `${path}/.git`;
    let excludesAdded = false;
    try {
      await this.fs.writeText(dotgit, `gitdir: ${gitdir}\n`);
      await this.fs.writeText(`${gitdir}/gitdir`, `${dotgit}\n`);
      await this.fs.writeText(`${gitdir}/commondir`, "../..\n");
      await this.fs.writeText(`${gitdir}/HEAD`, `ref: refs/heads/${branch}\n`);
      const linkedFs = this.fs.clientForLinkedWorktree(commonGitdir(repository), gitdir);
      await git.checkout({
        fs: linkedFs,
        dir: path,
        gitdir,
        ref: branch,
        force: true,
        nonBlocking: true,
      });
      assertNotAborted(context.signal);
      excludesAdded = await this.updateContainingRepositoryExcludes(repository, linked, true);
      const updated = deepFreeze({
        ...repository,
        linkedWorktrees: [...repository.linkedWorktrees, linked].sort((left, right) => asciiCompare(left.id, right.id)),
      });
      await this.replaceRepositoryRecord(updated, reviewedRegistryRevision);
    } catch (error) {
      await this.fs.removeTree(path).catch(() => undefined);
      await this.fs.removeTree(gitdir).catch(() => undefined);
      if (excludesAdded) await this.updateContainingRepositoryExcludes(repository, linked, false).catch(() => undefined);
      throw error;
    }
    // Registry publication is the local commit point. A late UI cancellation
    // cannot turn a successfully registered checkout into a claimed rollback.
    const committed = this.repositories.find((candidate) => candidate.id === repository.id)!;
    return this.result(committed, [], new AbortController().signal, undefined, id);
  }

  async removeWorktree(request: GitRemoveWorktreeRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const repository = await this.requireRepository(request.repositoryId);
    await this.expectRepositoryVersion(repository, request.expectedRepositoryVersion, context.signal);
    const reviewedRegistryRevision = this.registryRevision;
    const id = validateGitIdentifier(request.worktreeId, "Worktree ID");
    if (id === repository.worktreeId) {
      throw new GitDomainError("primary-worktree", "The primary worktree cannot be removed through linked-worktree management.");
    }
    const linked = repository.linkedWorktrees.find((candidate) => candidate.id === id);
    if (!linked) throw new GitNotFoundError(`Worktree ${id}`);
    const target = this.target(repository, linked);
    if ((await statusEntries(target.fs, target.dir, target.gitdir)).length) {
      throw new GitDomainError("dirty-worktree", "Commit or discard worktree changes before removing this checkout.");
    }
    const updated = deepFreeze({
      ...repository,
      linkedWorktrees: repository.linkedWorktrees.filter((candidate) => candidate.id !== id),
    });
    await this.replaceRepositoryRecord(updated, reviewedRegistryRevision);
    try {
      await this.fs.removeTree(linked.path);
      await this.fs.removeTree(linkedGitdir(repository, linked));
      await this.updateContainingRepositoryExcludes(repository, linked, false);
    } catch (error) {
      throw new GitDomainError(
        "worktree-removal-partial",
        `Worktree ${id} was unregistered, but concurrent workspace changes prevented complete cleanup. Its files were preserved where cleanup could not prove ownership. ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_200),
      );
    }
    return deepFreeze({ repository: await this.snapshot(updated, new AbortController().signal), changedPaths: [] });
  }

  async importSnapshot(request: GitSnapshotImportRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    await this.refreshRegistry();
    const id = validateGitIdentifier(request.repositoryId, "Repository ID");
    if (this.repositories.some((candidate) => candidate.id === id)) throw new GitValidationError(`Duplicate repository ${id}.`);
    const root = validateGitDestination(request.destination);
    const files = validatedFiles(request.files);
    for (const [path, content] of files) {
      const admitted = await this.workspace.read(normalizeWorkspacePath(`${root}/${path}`));
      if (!admitted || admitted.content !== content) {
        throw new GitValidationError(`Workspace file ${path} does not match the reviewed repository snapshot.`);
      }
    }
    const record: RepositoryRecord = deepFreeze({
      id,
      name: validateRepositoryName(request.name),
      root,
      defaultBranch: validateBranchName(request.defaultBranch),
      worktreeId: "main",
      linkedWorktrees: [],
      remotes: [{ name: "origin", url: validateRemoteUrl(request.sourceUrl) }],
    });
    try {
      await this.initializeEmptyRepository(record, files.keys().next().value);
      await git.addRemote({ fs: this.fs.client, dir: root, remote: "origin", url: record.remotes[0]!.url });
      await this.addRepositoryRecord(record);
      const result = await this.result(record, [...files.keys()], context.signal);
      return result;
    } catch (error) {
      await this.fs.removeGitDirectory(root).catch(() => undefined);
      throw error;
    }
  }

  async clone(request: GitCloneRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    await this.refreshRegistry();
    const id = validateGitIdentifier(request.repositoryId, "Repository ID");
    if (this.repositories.some((candidate) => candidate.id === id)) throw new GitValidationError(`Duplicate repository ${id}.`);
    const root = validateGitDestination(request.destination);
    if ((await this.workspace.list(root)).length) throw new GitValidationError(`Clone destination is not empty: ${root}.`);
    const remoteUrl = validateRemoteUrl(request.remoteUrl);
    const remoteName = validateGitIdentifier(request.remoteName ?? "origin", "Remote name");
    try {
      await git.clone({
        fs: this.fs.client,
        http,
        dir: root,
        url: remoteUrl,
        remote: remoteName,
        ...(request.defaultBranch ? { ref: validateBranchName(request.defaultBranch) } : {}),
        singleBranch: false,
        nonBlocking: true,
      });
    } catch (error) {
      await this.fs.removeTree(root).catch(() => undefined);
      throw directHttpError("clone", remoteUrl, error);
    }
    const branch = await git.currentBranch({ fs: this.fs.client, dir: root, test: true });
    const record: RepositoryRecord = deepFreeze({
      id,
      name: validateRepositoryName(request.name),
      root,
      defaultBranch: validateBranchName(branch || request.defaultBranch || "main"),
      worktreeId: "main",
      linkedWorktrees: [],
      remotes: [{ name: remoteName, url: remoteUrl }],
      lastRemoteSyncAt: this.now(),
    });
    await this.addRepositoryRecord(record);
    return this.result(record, (await this.workspace.list(root)).filter((entry) => !isBrowserGitControlPlanePath(entry.path)).map((entry) => relativePath(root, entry.path)), context.signal);
  }

  async fetch(request: GitFetchRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const repository = await this.requireRepository(request.repositoryId);
    await this.expectRepositoryVersion(repository, request.expectedRepositoryVersion, context.signal);
    const remote = repository.remotes.find((candidate) => candidate.name === request.remote);
    if (!remote) throw new GitNotFoundError(`Remote ${request.remote}`);
    try {
      await git.fetch({ fs: this.fs.client, http, dir: repository.root, remote: remote.name, prune: request.prune === true, singleBranch: false });
    } catch (error) {
      throw directHttpError("fetch", remote.url, error);
    }
    const updated = deepFreeze({ ...repository, lastRemoteSyncAt: this.now() });
    await this.replaceRepositoryRecord(updated);
    return this.result(updated, [], context.signal);
  }

  async push(request: GitPushRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    const repository = target.repository;
    await this.expectExactVersion(repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const remoteName = validateGitIdentifier(request.remote, "Remote name");
    const branch = validateBranchName(request.branch);
    const remote = repository.remotes.find((candidate) => candidate.name === remoteName);
    if (!remote) throw new GitNotFoundError(`Remote ${remoteName}`);
    await git.resolveRef({ fs: target.fs, dir: target.dir, gitdir: target.gitdir, ref: `refs/heads/${branch}` });

    let pushResult: Awaited<ReturnType<typeof git.push>>;
    try {
      pushResult = await git.push({
        fs: target.fs,
        http,
        dir: target.dir,
        gitdir: target.gitdir,
        remote: remoteName,
        ref: branch,
        remoteRef: branch,
        force: request.force === true,
        ...(this.authenticate ? {
          onAuth: async (url, challenge) => {
            const challenged = new URL(url);
            const configured = new URL(remote.url);
            if (challenged.origin !== configured.origin) {
              throw new GitDomainError("credential-origin-mismatch", "Git refused to forward a memory-only credential to a different origin.");
            }
            const credential = await this.authenticate!({
              operation: "push",
              origin: challenged.origin,
              remote: remoteName,
              ...(challenge.username ? { challengeUsername: challenge.username } : {}),
            });
            return credential ? validateRemoteCredential(credential) : { cancel: true };
          },
        } : {}),
      });
    } catch (error) {
      throw pushOutcomeUnknown(remote.url, error);
    }

    const rejected = Object.entries(pushResult.refs).filter(([, state]) => !state.ok);
    if (!pushResult.ok || pushResult.error || rejected.length) {
      const detail = pushResult.error ?? rejected.map(([ref, state]) => `${ref}: ${state.error}`).join("; ");
      throw new GitDomainError("push-rejected", `Remote ${remoteName} rejected the reviewed push. ${detail}`.slice(0, 1_200));
    }
    // Once the server has accepted the update, a late UI cancellation cannot
    // rewrite the remote fact as an aborted operation. Snapshot with a passive
    // signal and return the committed outcome.
    return this.result(repository, [], new AbortController().signal, undefined, target.worktree.id);
  }

  private async initializeSeed(seed: WorkspaceGitRepositorySeed): Promise<void> {
    const id = validateGitIdentifier(seed.id, "Repository ID");
    if (this.repositories.some((candidate) => candidate.id === id)) throw new GitValidationError(`Duplicate repository ${id}.`);
    if (seed.worktreePath && seed.destination && seed.worktreePath !== seed.destination) {
      throw new GitValidationError("Git seed worktreePath and destination must identify the same workspace root.");
    }
    const root = validateGitDestination(seed.worktreePath ?? seed.destination ?? (id === "airship-workspace" ? "/workspace" : `/workspace/sources/${id}`));
    const branch = validateBranchName(seed.defaultBranch ?? "main");
    const record: RepositoryRecord = deepFreeze({
      id,
      name: validateRepositoryName(seed.name),
      root,
      defaultBranch: branch,
      worktreeId: validateGitIdentifier(seed.worktreeId ?? "main", "Worktree ID"),
      linkedWorktrees: [],
      remotes: seed.remoteUrl ? [{ name: "origin", url: validateRemoteUrl(seed.remoteUrl) }] : [],
    });
    await git.init({ fs: this.fs.client, dir: root, defaultBranch: branch });
    const baseline = validatedFiles(seed.files);
    for (const [path, content] of baseline) await this.fs.writeText(`${root}/${path}`, content);
    for (const path of baseline.keys()) await git.add({ fs: this.fs.client, dir: root, filepath: path });
    const identity = gitIdentity({ name: "Airship", email: "airship@local.invalid" }, this.now());
    await git.commit({ fs: this.fs.client, dir: root, message: "Initial browser workspace", author: identity, committer: identity });
    if (root === "/workspace") await this.fs.writeText(`${root}/.git/info/exclude`, "sources/\n.airship/\n");
    if (seed.remoteUrl) await git.addRemote({ fs: this.fs.client, dir: root, remote: "origin", url: validateRemoteUrl(seed.remoteUrl) });
    if (seed.workingFiles) {
      const working = validatedFiles(seed.workingFiles);
      for (const path of baseline.keys()) if (!working.has(path)) await this.fs.removeFile(`${root}/${path}`);
      for (const [path, content] of working) await this.fs.writeText(`${root}/${path}`, content);
    }
    this.repositories.push(record);
  }

  private async initializeEmptyRepository(repository: RepositoryRecord, firstWorkingPath?: string): Promise<void> {
    await git.init({ fs: this.fs.client, dir: repository.root, defaultBranch: repository.defaultBranch });
    const tree = await git.writeTree({ fs: this.fs.client, dir: repository.root, tree: [] });
    const identity = gitIdentity({ name: "Airship", email: "airship@local.invalid" }, this.now());
    await git.commit({
      fs: this.fs.client,
      dir: repository.root,
      ref: `refs/heads/${repository.defaultBranch}`,
      parent: [],
      tree,
      message: "Admit pinned browser snapshot",
      author: identity,
      committer: identity,
    });
    // isomorphic-git does not write an index for an empty tree until the first
    // index operation. Create and reset one entry so import leaves a genuine
    // empty index while all admitted snapshot files remain visibly untracked.
    const indexBootstrapPath = firstWorkingPath ?? ".airship-git-index-bootstrap";
    if (!firstWorkingPath) await this.fs.writeText(`${repository.root}/${indexBootstrapPath}`, "");
    await git.add({ fs: this.fs.client, dir: repository.root, filepath: indexBootstrapPath });
    await git.resetIndex({ fs: this.fs.client, dir: repository.root, filepath: indexBootstrapPath });
    if (!firstWorkingPath) await this.fs.removeFile(`${repository.root}/${indexBootstrapPath}`);
  }

  private async snapshot(repository: RepositoryRecord, signal: AbortSignal): Promise<GitRepositorySnapshot> {
    assertNotAborted(signal);
    const worktrees = await Promise.all(allWorktrees(repository).map((worktree) => this.worktreeSnapshot(this.target(repository, worktree), signal)));
    const branchNames = await git.listBranches({ fs: this.fs.client, dir: repository.root, gitdir: commonGitdir(repository) });
    const checkedOut = new Set(worktrees.map((worktree) => worktree.branch));
    const branches = await Promise.all(branchNames.sort(asciiCompare).map(async (name) => ({
      name,
      oid: await git.resolveRef({ fs: this.fs.client, dir: repository.root, gitdir: commonGitdir(repository), ref: name }),
      current: checkedOut.has(name),
    })));
    const version = await this.issueVersion(repository, undefined);
    return deepFreeze({
      id: repository.id,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      version,
      storage: this.capabilities.storage,
      remotes: repository.remotes.map((remote) => ({ ...remote, transport: "direct-git-http" as const })),
      branches,
      worktrees,
      capabilities: this.capabilities,
      ...(repository.lastRemoteSyncAt ? { lastRemoteSyncAt: repository.lastRemoteSyncAt } : {}),
    });
  }

  private async worktreeSnapshot(target: WorktreeTarget, signal: AbortSignal): Promise<GitWorktreeSnapshot> {
    assertNotAborted(signal);
    const branch = await git.currentBranch({ fs: target.fs, dir: target.dir, gitdir: target.gitdir, test: true }) || target.repository.defaultBranch;
    const head = await git.resolveRef({ fs: target.fs, dir: target.dir, gitdir: target.gitdir, ref: "HEAD" });
    const [version, status] = await Promise.all([
      this.issueVersion(target.repository, target.worktree.id),
      statusEntries(target.fs, target.dir, target.gitdir),
    ]);
    return deepFreeze({ id: target.worktree.id, path: target.worktree.path, branch, head, version, status });
  }

  private async result(
    repository: RepositoryRecord,
    changedPaths: readonly string[],
    signal: AbortSignal,
    commit?: string,
    worktreeId = repository.worktreeId,
  ): Promise<GitMutationResult> {
    const snapshot = await this.snapshot(repository, signal);
    return deepFreeze({
      repository: snapshot,
      worktree: snapshot.worktrees.find((worktree) => worktree.id === worktreeId),
      changedPaths: [...changedPaths].sort(asciiCompare),
      ...(commit ? { commit } : {}),
    });
  }

  private async requireTarget(request: GitStatusRequest): Promise<WorktreeTarget> {
    const repository = await this.requireRepository(request.repositoryId);
    const id = validateGitIdentifier(request.worktreeId, "Worktree ID");
    const worktree = allWorktrees(repository).find((candidate) => candidate.id === id);
    if (!worktree) throw new GitNotFoundError(`Worktree ${id}`);
    return this.target(repository, worktree);
  }

  private target(repository: RepositoryRecord, worktree: WorktreeRecord): WorktreeTarget {
    const gitdir = worktree.adminId ? linkedGitdir(repository, worktree as LinkedWorktreeRecord) : commonGitdir(repository);
    return deepFreeze({
      repository,
      worktree,
      fs: worktree.adminId ? this.fs.clientForLinkedWorktree(commonGitdir(repository), gitdir) : this.fs.client,
      dir: worktree.path,
      gitdir,
    });
  }

  private async requireRepository(repositoryId: string): Promise<RepositoryRecord> {
    await this.refreshRegistry();
    const id = validateGitIdentifier(repositoryId, "Repository ID");
    const repository = this.repositories.find((candidate) => candidate.id === id);
    if (!repository) throw new GitNotFoundError(`Repository ${id}`);
    return repository;
  }

  private async expectExactVersion(repository: RepositoryRecord, worktreeId: string, expected: string, signal: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    const actual = await this.issueVersion(repository, worktreeId);
    if (actual !== expected) throw new GitVersionConflictError(expected, actual);
  }

  private async expectRepositoryVersion(repository: RepositoryRecord, expected: string, signal: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    const actual = await this.issueVersion(repository, undefined);
    if (actual !== expected) throw new GitVersionConflictError(expected, actual);
  }

  private async acceptWorkspaceProjection(
    target: WorktreeTarget,
    expected: string,
    projectedPaths: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal);
    const issued = this.issuedVersions.get(expected);
    if (!issued || issued.repositoryId !== target.repository.id || issued.worktreeId !== target.worktree.id) {
      const actual = await this.issueVersion(target.repository, target.worktree.id);
      if (actual !== expected) throw new GitVersionConflictError(expected, actual);
      return;
    }
    const current = await this.repositoryRevisions(target.repository);
    const projected = new Set(projectedPaths.map((path) => normalizeWorkspacePath(`${target.dir}/${path}`)));
    const paths = new Set([...issued.revisions.keys(), ...current.keys()]);
    for (const path of paths) {
      if (projected.has(path)) continue;
      if (issued.revisions.get(path) !== current.get(path)) {
        const actual = await this.issueVersion(target.repository, target.worktree.id);
        throw new GitVersionConflictError(expected, actual);
      }
    }
  }

  private async issueVersion(repository: RepositoryRecord, worktreeId: string | undefined): Promise<string> {
    const revisions = await this.repositoryRevisions(repository);
    // Repository and worktree projections can contain the same revisions, but
    // they authorize different mutation scopes. Domain-separate their opaque
    // versions so issuing the repository snapshot cannot overwrite the
    // worktree's reviewed projection record in `issuedVersions`.
    const version = await sha256(stableStringify({
      scope: worktreeId ? `worktree:${worktreeId}` : "repository",
      revisions: [...revisions].map(([path, revision]) => [path, revision]),
    } as never));
    this.issuedVersions.set(version, deepFreeze({ repositoryId: repository.id, ...(worktreeId ? { worktreeId } : {}), revisions }));
    while (this.issuedVersions.size > MAX_ISSUED_VERSIONS) this.issuedVersions.delete(this.issuedVersions.keys().next().value!);
    return version;
  }

  private async repositoryRevisions(repository: RepositoryRecord): Promise<ReadonlyMap<string, string>> {
    const entries = (await Promise.all(allWorktrees(repository).map((worktree) => this.workspace.list(worktree.path)))).flat();
    const commonEntries = await this.workspace.list(commonGitdir(repository));
    const nestedRoots = this.repositories
      .filter((candidate) => candidate.id !== repository.id && candidate.root.startsWith(`${repository.root}/`))
      .flatMap((candidate) => allWorktrees(candidate).map((worktree) => worktree.path));
    return new Map([...entries, ...commonEntries]
      .filter((entry) => !nestedRoots.some((root) => entry.path === root || entry.path.startsWith(`${root}/`)))
      .map((entry) => [entry.path, entry.revision] as const)
      .sort(([left], [right]) => asciiCompare(left, right)));
  }

  private async requireBranchAvailable(repository: RepositoryRecord, branch: string, exceptWorktreeId?: string): Promise<void> {
    const snapshots = await Promise.all(allWorktrees(repository).map(async (worktree) => {
      const target = this.target(repository, worktree);
      return { id: worktree.id, branch: await git.currentBranch({ fs: target.fs, dir: target.dir, gitdir: target.gitdir, test: true }) };
    }));
    const occupied = snapshots.find((candidate) => candidate.id !== exceptWorktreeId && candidate.branch === branch);
    if (occupied) throw new GitDomainError("branch-checked-out", `Branch ${branch} is already checked out by worktree ${occupied.id}.`);
  }

  private async assertWorktreeDestinationAvailable(repository: RepositoryRecord, path: string): Promise<void> {
    if (path === "/workspace/.airship" || path.startsWith("/workspace/.airship/")) {
      throw new GitValidationError("Linked worktrees cannot occupy Airship's private control-plane namespace.");
    }
    for (const candidateRepository of this.repositories) {
      for (const candidate of allWorktrees(candidateRepository)) {
        const nestedInsideOwnPrimary = candidateRepository.id === repository.id
          && candidate.id === repository.worktreeId
          && path.startsWith(`${repository.root}/`);
        const nestedRepositoryContainer = candidate.id === candidateRepository.worktreeId
          && repository.root.startsWith(`${candidateRepository.root}/`)
          && path.startsWith(`${candidateRepository.root}/`);
        if (nestedInsideOwnPrimary || nestedRepositoryContainer) continue;
        if (pathsOverlap(path, candidate.path)) {
          throw new GitValidationError(`Linked worktree path overlaps registered worktree ${candidateRepository.id}/${candidate.id}.`);
        }
      }
    }
    const parts = path.split("/").filter(Boolean);
    for (let length = 2; length < parts.length; length += 1) {
      const ancestor = `/${parts.slice(0, length).join("/")}`;
      if (await this.workspace.read(ancestor)) throw new GitValidationError(`Linked worktree path descends through workspace file ${ancestor}.`);
    }
    if (await this.workspace.read(path) || (await this.workspace.list(path)).length) {
      throw new GitValidationError(`Linked worktree destination is not empty: ${path}.`);
    }
  }

  private async worktreeAdminId(repository: RepositoryRecord, id: string): Promise<string> {
    const digest = await sha256(`airship-linked-worktree\0${repository.id}\0${id}`);
    const adminId = `wt-${digest.slice("sha256:".length)}`;
    if (repository.linkedWorktrees.some((candidate) => candidate.adminId === adminId)) {
      throw new GitDomainError("worktree-admin-collision", "Linked worktree administration identifier collision.");
    }
    return adminId;
  }

  private async updateContainingRepositoryExcludes(
    repository: RepositoryRecord,
    linked: LinkedWorktreeRecord,
    add: boolean,
  ): Promise<boolean> {
    const changed: RepositoryRecord[] = [];
    try {
      for (const candidate of this.repositories) {
        const ownsWorktree = candidate.id === repository.id;
        const containsRepository = repository.root.startsWith(`${candidate.root}/`);
        if ((!ownsWorktree && !containsRepository) || !linked.path.startsWith(`${candidate.root}/`)) continue;
        if (await this.updateRepositoryWorktreeExclude(candidate, repository.id, linked, add)) changed.push(candidate);
      }
      return changed.length > 0;
    } catch (error) {
      for (const candidate of changed.reverse()) {
        await this.updateRepositoryWorktreeExclude(candidate, repository.id, linked, !add).catch(() => undefined);
      }
      throw error;
    }
  }

  private async updateRepositoryWorktreeExclude(
    repository: RepositoryRecord,
    ownerRepositoryId: string,
    linked: LinkedWorktreeRecord,
    add: boolean,
  ): Promise<boolean> {
    if (!linked.path.startsWith(`${repository.root}/`)) return false;
    const relative = linked.path.slice(repository.root.length + 1);
    const label = repository.id === ownerRepositoryId ? linked.id : `${ownerRepositoryId}/${linked.id}`;
    const begin = `# airship linked worktree ${label} begin`;
    const end = `# airship linked worktree ${label} end`;
    const block = `${begin}\n/${relative}/\n${end}\n`;
    const path = `${commonGitdir(repository)}/info/exclude`;
    const current = await this.fs.readText(path) ?? "";
    const without = current.replace(`${begin}\n/${relative}/\n${end}\n`, "");
    const next = add ? `${without}${without && !without.endsWith("\n") ? "\n" : ""}${block}` : without;
    if (next === current) return false;
    await this.fs.writeText(path, next);
    return true;
  }

  private async refreshRegistry(): Promise<void> {
    const current = await this.workspace.read(REGISTRY_PATH);
    if (!current) throw new GitValidationError("Browser Git repository registry disappeared from the workspace.");
    if (current.revision === this.registryRevision) return;
    this.repositories = parseRegistry(current.content);
    this.registryRevision = current.revision;
  }

  private async persistRegistry(expectedRevision: string | null): Promise<void> {
    const document: RegistryDocument = deepFreeze({
      format: REGISTRY_FORMAT,
      version: 1,
      repositories: [...this.repositories].sort((left, right) => asciiCompare(left.id, right.id)),
    });
    const written = await this.workspace.write(REGISTRY_PATH, `${stableStringify(document as never)}\n`, { expectedRevision });
    this.registryRevision = written.revision;
  }

  private async addRepositoryRecord(repository: RepositoryRecord): Promise<void> {
    // Repository material can take seconds to clone/import. Another tab may
    // legitimately add an unrelated repository before this final registry
    // commit. Rebase this one record over one fresh head instead of leaving a
    // complete `.git` tree invisible to Editor and Source Control.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.refreshRegistry();
      if (this.repositories.length >= MAX_REPOSITORIES) throw new GitValidationError("Browser Git repository limit exceeded.");
      if (this.repositories.some((candidate) => candidate.id === repository.id || candidate.root === repository.root)) {
        throw new GitValidationError("Repository ID or worktree root is already registered.");
      }
      const previous = this.repositories;
      this.repositories = [...previous, repository];
      try {
        await this.persistRegistry(this.registryRevision ?? null);
        return;
      } catch (error) {
        this.repositories = previous;
        if (!(error instanceof WorkspaceConflictError) || attempt === 1) throw error;
      }
    }
  }

  private async replaceRepositoryRecord(repository: RepositoryRecord, expectedRegistryRevision = this.registryRevision): Promise<void> {
    if (!expectedRegistryRevision) throw new GitValidationError("Browser Git repository registry has no reviewed revision.");
    const previous = this.repositories;
    this.repositories = previous.map((candidate) => candidate.id === repository.id ? repository : candidate);
    try { await this.persistRegistry(expectedRegistryRevision); }
    catch (error) { this.repositories = previous; throw error; }
  }

  private async verifyRegisteredRepositories(): Promise<void> {
    for (const repository of this.repositories) {
      const [head, index] = await Promise.all([
        this.workspace.read(`${repository.root}/.git/HEAD`),
        this.workspace.read(`${repository.root}/.git/index`),
      ]);
      if (!head || !index) throw new GitValidationError(`Repository ${repository.id} is missing its real .git HEAD or index.`);
      await git.resolveRef({ fs: this.fs.client, dir: repository.root, gitdir: commonGitdir(repository), ref: "HEAD" });
      for (const linked of repository.linkedWorktrees) {
        const target = this.target(repository, linked);
        const [dotgit, linkedHead, linkedIndex, commondir, backPointer] = await Promise.all([
          this.workspace.read(`${linked.path}/.git`),
          this.workspace.read(`${target.gitdir}/HEAD`),
          this.workspace.read(`${target.gitdir}/index`),
          this.workspace.read(`${target.gitdir}/commondir`),
          this.workspace.read(`${target.gitdir}/gitdir`),
        ]);
        if (
          dotgit?.content !== `gitdir: ${target.gitdir}\n`
          || commondir?.content !== "../..\n"
          || backPointer?.content !== `${linked.path}/.git\n`
          || !linkedHead
          || !linkedIndex
        ) {
          throw new GitValidationError(`Linked worktree ${repository.id}/${linked.id} has incomplete or mismatched conventional Git metadata.`);
        }
        await git.resolveRef({ fs: target.fs, dir: target.dir, gitdir: target.gitdir, ref: "HEAD" });
      }
    }
  }
}

function commonGitdir(repository: RepositoryRecord): string {
  return `${repository.root}/.git`;
}

function linkedGitdir(repository: RepositoryRecord, worktree: LinkedWorktreeRecord): string {
  return `${commonGitdir(repository)}/worktrees/${worktree.adminId}`;
}

function allWorktrees(repository: RepositoryRecord): readonly WorktreeRecord[] {
  return deepFreeze([
    { id: repository.worktreeId, path: repository.root },
    ...repository.linkedWorktrees,
  ]);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

async function statusEntries(fs: git.PromiseFsClient, root: string, gitdir = `${root}/.git`): Promise<readonly GitStatusEntry[]> {
  const matrix = await git.statusMatrix({ fs, dir: root, gitdir, refresh: false });
  const changed = matrix.filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
  const entries = await Promise.all(changed.map(async ([path, head, workdir, stage]) => {
    const index = head === stage ? null : { kind: deltaFromPresence(head, stage) } as const;
    const worktree = workdir === stage ? null : { kind: deltaFromPresence(stage, workdir) } as const;
    const planes = await contentPlanes(fs, root, gitdir, path);
    const counts = lineCounts(worktree ? planes.stage : planes.head, worktree ? planes.workdir : planes.stage);
    return deepFreeze({ path, index, worktree, ...counts });
  }));
  return deepFreeze(entries.sort((left, right) => asciiCompare(left.path, right.path)));
}

async function contentPlanes(fs: git.PromiseFsClient, root: string, gitdir: string, path: string): Promise<{ head?: Uint8Array; stage?: Uint8Array; workdir?: Uint8Array }> {
  type PlaneEntry = git.WalkerEntry | null;
  const found = await git.walk({
    fs,
    dir: root,
    gitdir,
    trees: [git.TREE({ ref: "HEAD" }), git.WORKDIR({ refresh: false }), git.STAGE()],
    map: async (filepath, entries: PlaneEntry[]) => {
      if (filepath !== path) return filepath === "." || path.startsWith(`${filepath}/`) ? undefined : null;
      const [head, workdir, stage] = entries;
      const headContent = await head?.content();
      const workdirContent = await workdir?.content();
      const stageOid = await stage?.oid();
      const stageContent = stageOid ? (await git.readBlob({ fs, dir: root, gitdir, oid: stageOid })).blob : undefined;
      return { head: headContent, workdir: workdirContent, stage: stageContent };
    },
  }) as Array<{ head?: Uint8Array; stage?: Uint8Array; workdir?: Uint8Array }>;
  return found.find(Boolean) ?? {};
}

function deltaFromPresence(before: number, after: number): "added" | "modified" | "deleted" {
  if (before === 0) return "added";
  if (after === 0) return "deleted";
  return "modified";
}

function renderPatch(path: string, beforeBytes?: Uint8Array, afterBytes?: Uint8Array): { patch: string; binary: boolean; truncated: boolean } {
  if (containsNul(beforeBytes) || containsNul(afterBytes)) return { patch: "Binary files differ.\n", binary: true, truncated: false };
  const before = beforeBytes ? new TextDecoder("utf-8", { fatal: false }).decode(beforeBytes) : "";
  const after = afterBytes ? new TextDecoder("utf-8", { fatal: false }).decode(afterBytes) : "";
  if (before === after) return { patch: "", binary: false, truncated: false };
  const left = lines(before);
  const right = lines(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left.at(-1 - suffix) === right.at(-1 - suffix)) suffix += 1;
  const body = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${prefix + 1},${left.length - prefix - suffix} +${prefix + 1},${right.length - prefix - suffix} @@`,
    ...left.slice(prefix, left.length - suffix).map((line) => `-${line}`),
    ...right.slice(prefix, right.length - suffix).map((line) => `+${line}`),
  ].join("\n");
  const bytes = encoder.encode(body);
  if (bytes.byteLength <= GIT_LIMITS.maxDiffBytes) return { patch: `${body}\n`, binary: false, truncated: false };
  return { patch: `${new TextDecoder().decode(bytes.slice(0, GIT_LIMITS.maxDiffBytes))}\n… diff truncated …\n`, binary: false, truncated: true };
}

function lineCounts(beforeBytes?: Uint8Array, afterBytes?: Uint8Array): { additions: number; deletions: number } {
  if (containsNul(beforeBytes) || containsNul(afterBytes)) return { additions: 0, deletions: 0 };
  const before = beforeBytes ? new TextDecoder().decode(beforeBytes) : "";
  const after = afterBytes ? new TextDecoder().decode(afterBytes) : "";
  const left = lines(before); const right = lines(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left.at(-1 - suffix) === right.at(-1 - suffix)) suffix += 1;
  return { additions: right.length - prefix - suffix, deletions: left.length - prefix - suffix };
}

function lines(value: string): string[] { return value ? value.replace(/\n$/u, "").split("\n") : []; }
function containsNul(value?: Uint8Array): boolean { return Boolean(value?.includes(0)); }

function capabilities(durable: boolean, memoryAuth: boolean): GitAdapterCapabilities {
  return deepFreeze({
    adapterId: "airship-workspace-isomorphic-git",
    adapterName: "Workspace-backed isomorphic-git",
    storage: {
      backend: durable ? "encrypted-workspace" : "memory",
      durable,
      detail: durable
        ? "A genuine .git object database, refs, config, and binary index are client-encrypted through the active Workspace Vault."
        : "A genuine .git object database, refs, config, and binary index live in this page's workspace and are lost with Ephemeral state.",
    },
    remote: {
      transport: "direct-git-http",
      requiresCors: true,
      credentialPersistence: memoryAuth ? "memory-only" : "none",
      detail: `isomorphic-git speaks Smart HTTP directly. The remote must grant this browser origin CORS; Airship never inserts a proxy. ${memoryAuth ? "A caller-supplied credential broker is held in page memory only." : "No credential broker is installed, so authenticated remotes reject while anonymous-capable remotes can proceed."}`,
    },
    features: {
      status: { available: true }, diff: { available: true }, stage: { available: true }, commit: { available: true }, branch: { available: true },
      worktree: { available: true },
      "snapshot-import": { available: true }, clone: { available: true }, fetch: { available: true },
      push: { available: true },
    },
  });
}

function parseRegistry(content: string): RepositoryRecord[] {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new GitValidationError("Browser Git repository registry is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitValidationError("Browser Git repository registry is invalid.");
  const raw = value as Record<string, unknown>;
  if (raw.format !== REGISTRY_FORMAT || raw.version !== 1 || !Array.isArray(raw.repositories) || raw.repositories.length > MAX_REPOSITORIES) {
    throw new GitValidationError("Browser Git repository registry schema is invalid.");
  }
  const ids = new Set<string>(); const roots = new Set<string>();
  return raw.repositories.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new GitValidationError("Browser Git repository record is invalid.");
    const record = candidate as Record<string, unknown>;
    const id = validateGitIdentifier(String(record.id), "Repository ID");
    const root = validateGitDestination(String(record.root));
    if (ids.has(id) || roots.has(root)) throw new GitValidationError("Browser Git registry contains a duplicate repository ID or root.");
    ids.add(id); roots.add(root);
    const worktreeId = validateGitIdentifier(String(record.worktreeId), "Worktree ID");
    const linkedIds = new Set<string>([worktreeId]);
    const adminIds = new Set<string>();
    const linkedWorktrees = record.linkedWorktrees === undefined ? [] : Array.isArray(record.linkedWorktrees) && record.linkedWorktrees.length <= MAX_LINKED_WORKTREES
      ? record.linkedWorktrees.map((worktree) => {
        if (!worktree || typeof worktree !== "object" || Array.isArray(worktree)) throw new GitValidationError("Browser Git linked worktree is invalid.");
        const item = worktree as Record<string, unknown>;
        if (typeof item.id !== "string" || typeof item.path !== "string" || typeof item.adminId !== "string") {
          throw new GitValidationError("Browser Git linked worktree fields are invalid.");
        }
        const linkedId = validateGitIdentifier(String(item.id), "Worktree ID");
        const path = validateGitDestination(String(item.path));
        const adminId = validateGitIdentifier(String(item.adminId), "Worktree administration ID");
        if (linkedIds.has(linkedId) || adminIds.has(adminId) || roots.has(path)) {
          throw new GitValidationError("Browser Git registry contains duplicate worktree metadata.");
        }
        linkedIds.add(linkedId); adminIds.add(adminId); roots.add(path);
        return deepFreeze({ id: linkedId, path, adminId });
      })
      : invalidRegistry("Browser Git linked worktrees must be an array.");
    const remotes = Array.isArray(record.remotes) ? record.remotes.map((remote) => {
      if (!remote || typeof remote !== "object" || Array.isArray(remote)) throw new GitValidationError("Browser Git remote is invalid.");
      const item = remote as Record<string, unknown>;
      return deepFreeze({ name: validateGitIdentifier(String(item.name), "Remote name"), url: validateRemoteUrl(String(item.url)) });
    }) : [];
    return deepFreeze({
      id,
      name: validateRepositoryName(String(record.name)),
      root,
      defaultBranch: validateBranchName(String(record.defaultBranch)),
      worktreeId,
      linkedWorktrees,
      remotes,
      ...(typeof record.lastRemoteSyncAt === "string" && Number.isFinite(Date.parse(record.lastRemoteSyncAt)) ? { lastRemoteSyncAt: record.lastRemoteSyncAt } : {}),
    });
  });
}

function invalidRegistry(message: string): never {
  throw new GitValidationError(message);
}

function validatedFiles(files: Readonly<Record<string, string>>): Map<string, string> {
  const entries = Object.entries(files);
  if (entries.length > GIT_LIMITS.maxSeedFiles) throw new GitValidationError("Browser Git seed contains too many files.");
  return new Map(entries
    .map(([path, content]) => [validateGitPath(path), validateFileContent(content)] as const)
    .sort(([left], [right]) => asciiCompare(left, right)));
}

function gitIdentity(author: GitAuthor, isoTime: string) {
  const date = new Date(isoTime);
  if (!Number.isFinite(date.getTime())) throw new GitValidationError("Git commit time is invalid.");
  return { ...author, timestamp: Math.floor(date.getTime() / 1_000), timezoneOffset: date.getTimezoneOffset() };
}

function directHttpError(operation: "clone" | "fetch" | "push", url: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new GitDomainError(
    "direct-git-http-failed",
    `Direct Git ${operation} failed for ${new URL(url).origin}. The remote must grant this Airship browser origin CORS for Git Smart HTTP. No Airship proxy was used; no proxy or backend handled this request. It may also require a memory-only credential this adapter does not have. ${message}`.slice(0, 1_200),
  );
}

function pushOutcomeUnknown(url: string, error: unknown): GitDomainError {
  const message = error instanceof Error ? error.message : String(error);
  return new GitDomainError(
    "push-outcome-unknown",
    `Direct Git push did not produce a verified terminal response from ${new URL(url).origin}. The remote may or may not have accepted the update; fetch before retrying. No Airship proxy handled the request. ${message}`.slice(0, 1_200),
  );
}

function validateRemoteCredential(value: WorkspaceGitRemoteCredential): WorkspaceGitRemoteCredential {
  const validate = (candidate: string | undefined, label: string, required: boolean): string | undefined => {
    if (candidate === undefined && !required) return undefined;
    if (!candidate || candidate.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
      throw new GitValidationError(`${label} is invalid.`);
    }
    return candidate;
  };
  const username = validate(value.username, "Git credential username", true)!;
  const password = validate(value.password, "Git credential password", false);
  return Object.freeze({ username, ...(password ? { password } : {}) });
}

function relativePath(root: string, path: string): string { return path === root ? "" : path.slice(root.length + 1); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
