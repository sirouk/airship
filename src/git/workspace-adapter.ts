import { deepFreeze } from "../core/freeze";
import * as git from "isomorphic-git";
import { Buffer as BrowserBuffer } from "buffer";
import { sha256, stableStringify } from "../core/hash";
import { AIRSHIP_WORKSPACE_ROOT, TERMINAL_SHELL_ROOT } from "../workspace/addressing";
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
  GitAddRemoteRequest,
  GitAuthor,
  GitCapabilityState,
  GitCloneRequest,
  GitCommitDetail,
  GitCommitFilePatch,
  GitCommitRequest,
  GitCommitSummary,
  GitCreateBranchRequest,
  GitCreateTagRequest,
  GitCreateWorktreeRequest,
  GitDeleteTagRequest,
  GitDiff,
  GitDiffRequest,
  GitFetchRequest,
  GitLogRequest,
  GitMergeRequest,
  GitMutationResult,
  GitRemoveRemoteRequest,
  GitResetRequest,
  GitRestoreRequest,
  GitSetRemoteUrlRequest,
  GitShowRequest,
  GitStashEntry,
  GitStashRequest,
  GitTagSummary,
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
  assertRemoteOriginPermitted,
  gitRemoteConnectOrigins,
  pageOrigin,
  validateAuthor,
  validateBoundedCount,
  validateBranchName,
  validateCommitMessage,
  validateEntryIndex,
  validateFileContent,
  validateGitDestination,
  validateGitIdentifier,
  validateGitPath,
  validatePathList,
  validateRemoteUrl,
  validateRepositoryName,
  validateRevision,
  validateTagMessage,
  validateTagName,
} from "./validation";
import { WorkspaceGitFileSystem } from "./workspace-fs";
import { createReviewedGitHttp } from "./reviewed-http";

/**
 * Content for the disposable repository created with the browser Git runtime.
 * It travels with that already-deferred runtime instead of inflating the
 * document bootstrap with a workspace payload that cannot be used before Git
 * has loaded.
 */
export const AIRSHIP_BOOTSTRAP_FILES = Object.freeze({
  readme: `# Airship workspace

This private virtual workspace is rooted at \`${AIRSHIP_WORKSPACE_ROOT}\` for Explorer, the Editor, Source Control and every tool; the in-page terminal mounts the same directory at \`${TERMINAL_SHELL_ROOT}\`, which is what \`pwd\` prints there. Its live durability follows the selected Vault: Local Device, Google Drive, S3-compatible object storage, or Ephemeral page memory. Inference uses the selected authenticated provider or local runtime.

The agent can:

- Read, search, patch, move, and remove revision-checked files.
- Build a revision-bound local hybrid context index and maintain \`.airship/tasks.json\`.
- Operate real browser-owned Git state: status, diff, stage, commit, branch, and direct CORS-permitted remotes.
- Fetch bounded HTTPS text, import pinned public GitHub snapshots, and use only the coding runtimes reported live.

There is no ambient host shell or unrestricted filesystem. Inspect the live tool manifest, verify effects, and name the exact browser or service boundary when blocked.
`,
  architecture: "The browser owns orchestration; the selected provider owns inference; the selected Vault owns durable state.",
  retrieval: "Context experts are selected by directory, Git, profile, and task focus.",
});

const REGISTRY_PATH = "/workspace/.airship/browser-git-repositories.v1.json";
const REGISTRY_FORMAT = "airship-browser-git-registry";
const MAX_REPOSITORIES = 1_000;
const MAX_LINKED_WORKTREES = 256;
const MAX_ISSUED_VERSIONS = 128;
const MAX_REMOTES = 32;
const MAX_LISTED_TAGS = 1_000;
/** History reads are display surfaces; keep one commit message bounded. */
const MAX_LOG_MESSAGE_CHARS = 4_096;
/** Fallback identity for adapter-authored objects, matching the seed commit. */
const AIRSHIP_IDENTITY: GitAuthor = Object.freeze({ name: "Airship", email: "airship@local.invalid" });
/**
 * Hosts an operator is most likely to type into a remote URL. They are named in
 * capability text only while the Git egress policy refuses them. This list is
 * a phrasing aid, never a decision input:
 * `assertRemoteOriginPermitted` refuses every origin outside the allowlist
 * whether or not it appears here.
 */
const COMMONLY_ATTEMPTED_GIT_ORIGINS: readonly string[] = Object.freeze(["https://github.com", "https://gitlab.com"]);
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

type GitTarget = Readonly<{
  fs: git.PromiseFsClient;
  dir: string;
  gitdir: string;
}>;

type WorktreeTarget = GitTarget & Readonly<{
  repository: RepositoryRecord;
  worktree: WorktreeRecord;
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
  /**
   * A failed registry write followed by a failed .git/config rollback leaves
   * neither authority trustworthy. Block that repository until an external
   * repair makes the affected remote agree with the current registry again.
   */
  private readonly quarantinedRemotes = new Map<string, string>();

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
    const content = await contentPlanes(target, path);
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
    const force = request.force === true;
    const status = new Map((await statusEntries(target)).map((entry) => [entry.path, entry]));
    // statusMatrix drops untracked-and-ignored rows, so an ignored path arrives
    // here indistinguishable from an unchanged one. Read the index only when a
    // path actually looks unchanged, so the common case pays nothing.
    let tracked: Promise<string[]> | undefined;
    // Admit or refuse every path before writing any of them. `BrowserGitClient`
    // may execute one reviewed request as several stage() calls and reports a
    // pre-flight refusal verbatim rather than as a durable partial mutation, so
    // a rejection raised after a sibling was already added would make that
    // report a lie. Only the presence flag is retained: git.add re-reads the
    // file itself, so the scan never holds `maxPathsPerOperation` bodies at once.
    const plan: Readonly<{ path: string; present: boolean }>[] = [];
    for (const path of paths) {
      const file = await this.workspace.read(normalizeWorkspacePath(`${target.dir}/${path}`));
      if (!status.get(path)?.worktree) {
        tracked ??= git.listFiles(gitOptions(target));
        const ignored = !(await tracked).includes(path) && await this.isIgnoredPath(target, path);
        if (!ignored) throw new GitValidationError(`${path} has no unstaged change.`);
        if (!force || !file) {
          throw new GitDomainError(
            "path-ignored",
            `${path} is excluded by this repository's .gitignore or .git/info/exclude rules${file ? ". Stage it with force if you intend to track it." : ", and it is not present in the worktree."}`,
          );
        }
      }
      plan.push({ path, present: Boolean(file) });
    }
    for (const { path, present } of plan) {
      if (present) await git.add({ ...gitOptions(target), filepath: path, force });
      else await git.remove({ ...gitOptions(target), filepath: path });
    }
    assertNotAborted(context.signal);
    return this.result(target.repository, paths, context.signal, undefined, target.worktree.id);
  }

  async unstage(request: GitStageRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const paths = validatePathList(request.paths);
    const status = new Map((await statusEntries(target)).map((entry) => [entry.path, entry]));
    // Refuse the whole set before touching the index, for the same reason
    // stage() does: a chunked request's first-chunk refusal must be provably
    // pre-write. See GIT_PRE_WRITE_FAILURE_CODES.
    for (const path of paths) {
      if (!status.get(path)?.index) throw new GitValidationError(`${path} has no staged change.`);
    }
    for (const path of paths) {
      await git.resetIndex({ ...gitOptions(target), filepath: path });
    }
    assertNotAborted(context.signal);
    return this.result(target.repository, paths, context.signal, undefined, target.worktree.id);
  }

  async commit(request: GitCommitRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const message = validateCommitMessage(request.message);
    const author = validateAuthor(request.author);
    const changed = (await statusEntries(target)).filter((entry) => entry.index).map((entry) => entry.path);
    if (!changed.length) throw new GitDomainError("nothing-to-commit", "No staged changes are available to commit.");
    const identity = gitIdentity(author, this.now());
    const oid = await git.commit({ ...gitOptions(target), message, author: identity, committer: identity });
    assertNotAborted(context.signal);
    return this.result(target.repository, changed, context.signal, oid, target.worktree.id);
  }

  async createBranch(request: GitCreateBranchRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const name = validateBranchName(request.name);
    if (request.checkout === true) await this.requireBranchAvailable(target.repository, name, target.worktree.id);
    await git.branch({
      ...gitOptions(target),
      ref: name,
      ...(request.startPoint ? { object: request.startPoint } : {}),
      checkout: request.checkout === true,
    });
    return this.result(target.repository, [], context.signal, undefined, target.worktree.id);
  }

  async switchBranch(request: GitSwitchBranchRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    if ((await statusEntries(target)).length) {
      throw new GitDomainError("dirty-worktree", "Commit or discard worktree changes before switching this checkout.");
    }
    const branch = validateBranchName(request.name);
    await this.requireBranchAvailable(target.repository, branch, target.worktree.id);
    await git.checkout({ ...gitOptions(target), ref: branch, nonBlocking: true });
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
    const branches = await git.listBranches(repositoryOptions(this.fs.client, repository));
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
    if ((await statusEntries(target)).length) {
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
      await this.initializeSnapshotRepository(record, files);
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
    assertRemoteOriginPermitted(remoteUrl, "clone");
    const remoteName = validateGitIdentifier(request.remoteName ?? "origin", "Remote name");
    const reviewedHttp = createReviewedGitHttp({
      remoteUrl,
      // isomorphic-git writes this prospective registry authority to config
      // before its first clone request. Re-read it at the actual HTTP boundary.
      reviewAuthority: () => this.reviewRemoteAuthority(
        { fs: this.fs.client, dir: root, gitdir: `${root}/.git` },
        remoteName,
        remoteUrl,
        "clone",
      ),
    });
    try {
      await git.clone({
        fs: this.fs.client,
        http: reviewedHttp,
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
    const reviewedHttp = await this.reviewedRemoteHttp(repository, remote.name, remote.url, "fetch");
    try {
      await git.fetch({ fs: this.fs.client, http: reviewedHttp, dir: repository.root, remote: remote.name, prune: request.prune === true, singleBranch: false });
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
    await git.resolveRef({ ...gitOptions(target), ref: `refs/heads/${branch}` });
    const reviewedHttp = await this.reviewedRemoteHttp(repository, remote.name, remote.url, "push");

    let pushResult: Awaited<ReturnType<typeof git.push>>;
    try {
      pushResult = await git.push({
        ...gitOptions(target),
        http: reviewedHttp,
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

  async log(request: GitLogRequest, context: GitOperationContext): Promise<readonly GitCommitSummary[]> {
    assertNotAborted(context.signal);
    const target = await this.requireTarget(request);
    const depth = validateBoundedCount(request.depth, "Log depth", GIT_LIMITS.maxLogDepth, GIT_LIMITS.maxLogDepth);
    const entries = await git.log({
      ...gitOptions(target),
      ref: request.ref ? validateRevision(request.ref) : "HEAD",
      depth,
      ...(request.path ? { filepath: validateGitPath(request.path), follow: request.follow === true, force: true } : {}),
    });
    assertNotAborted(context.signal);
    return deepFreeze(entries.map(commitSummary));
  }

  async show(request: GitShowRequest, context: GitOperationContext): Promise<GitCommitDetail> {
    assertNotAborted(context.signal);
    const target = await this.requireTarget(request);
    const oid = await this.resolveRevision(target, validateRevision(request.revision));
    const read = await git.readCommit({ ...gitOptions(target), oid });
    const maxPaths = validateBoundedCount(request.maxPaths, "Patch path count", GIT_LIMITS.maxCommitPatchPaths, GIT_LIMITS.maxCommitPatchPaths);
    const parent = read.commit.parent[0];
    const changes = await commitChanges(target, oid, parent);
    assertNotAborted(context.signal);
    const files = await Promise.all(changes.slice(0, maxPaths).map(async (change) => {
      const before = change.before ? (await git.readBlob({ ...gitOptions(target), oid: change.before })).blob : undefined;
      const after = change.after ? (await git.readBlob({ ...gitOptions(target), oid: change.after })).blob : undefined;
      const rendered = renderPatch(change.path, before, after);
      return deepFreeze({
        path: change.path,
        kind: deltaFromPresence(change.before ? 1 : 0, change.after ? 1 : 0),
        patch: rendered.patch,
        binary: rendered.binary,
        truncated: rendered.truncated,
      } satisfies GitCommitFilePatch);
    }));
    return deepFreeze({ commit: commitSummary(read), files, truncated: changes.length > files.length });
  }

  async listTags(repositoryId: string, context: GitOperationContext): Promise<readonly GitTagSummary[]> {
    assertNotAborted(context.signal);
    const repository = await this.requireRepository(repositoryId);
    const gitdir = commonGitdir(repository);
    const names = await git.listTags({ fs: this.fs.client, dir: repository.root, gitdir });
    if (names.length > MAX_LISTED_TAGS) {
      throw new GitDomainError("tag-list-too-large", `This repository has ${names.length} tags; the browser adapter lists at most ${MAX_LISTED_TAGS}.`);
    }
    const tags = await Promise.all([...names].sort(asciiCompare).map(async (name) => {
      const oid = await git.resolveRef({ fs: this.fs.client, dir: repository.root, gitdir, ref: `refs/tags/${name}` });
      // A lightweight tag names its commit directly, so reading it as a tag
      // object is the type error that distinguishes the two kinds.
      const annotated = await git.readTag({ fs: this.fs.client, dir: repository.root, gitdir, oid }).catch((error: unknown) => {
        if ((error as { code?: string }).code === "ObjectTypeError") return undefined;
        throw error;
      });
      if (!annotated) return deepFreeze({ name, oid, annotated: false, target: oid });
      return deepFreeze({ name, oid, annotated: true, target: annotated.tag.object, message: boundedMessage(annotated.tag.message) });
    }));
    return deepFreeze(tags);
  }

  async createTag(request: GitCreateTagRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const repository = await this.requireRepository(request.repositoryId);
    await this.expectRepositoryVersion(repository, request.expectedRepositoryVersion, context.signal);
    const gitdir = commonGitdir(repository);
    const name = validateTagName(request.name);
    const existing = await git.listTags({ fs: this.fs.client, dir: repository.root, gitdir });
    if (existing.includes(name) && request.force !== true) throw new GitDomainError("tag-exists", `Tag ${name} already exists.`);
    if (existing.length >= MAX_LISTED_TAGS) throw new GitValidationError(`This repository already holds the ${MAX_LISTED_TAGS}-tag browser limit.`);
    const target = this.target(repository, { id: repository.worktreeId, path: repository.root });
    const object = await this.resolveRevision(target, request.ref ? validateRevision(request.ref) : "HEAD");
    if (request.message === undefined) {
      await git.tag({ fs: this.fs.client, dir: repository.root, gitdir, ref: name, object, force: request.force === true });
    } else {
      const identity = gitIdentity(validateAuthor(request.author ?? AIRSHIP_IDENTITY), this.now());
      await git.annotatedTag({
        fs: this.fs.client,
        dir: repository.root,
        gitdir,
        ref: name,
        message: validateTagMessage(request.message),
        object,
        tagger: identity,
        force: request.force === true,
      });
    }
    return this.result(repository, [], context.signal);
  }

  async deleteTag(request: GitDeleteTagRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const repository = await this.requireRepository(request.repositoryId);
    await this.expectRepositoryVersion(repository, request.expectedRepositoryVersion, context.signal);
    const gitdir = commonGitdir(repository);
    const name = validateTagName(request.name);
    const existing = await git.listTags({ fs: this.fs.client, dir: repository.root, gitdir });
    if (!existing.includes(name)) throw new GitNotFoundError(`Tag ${name}`);
    await git.deleteTag({ fs: this.fs.client, dir: repository.root, gitdir, ref: name });
    return this.result(repository, [], context.signal);
  }

  async listStash(request: GitStatusRequest, context: GitOperationContext): Promise<readonly GitStashEntry[]> {
    assertNotAborted(context.signal);
    const target = await this.requireTarget(request);
    return this.stashEntries(target);
  }

  async stash(request: GitStashRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const author = validateAuthor(request.author);
    const index = validateEntryIndex(request.index, "Stash entry index", GIT_LIMITS.maxStashEntries);
    if (request.op !== "push" && request.op !== "clear") {
      const entries = await this.stashEntries(target);
      if (index >= entries.length) throw new GitNotFoundError(`Stash entry ${index}`);
    }
    // A stash is a real commit, so isomorphic-git resolves its identity the way
    // Git does: from `user.name`/`user.email` in the repository config. Publish
    // the reviewed identity there first so the stash commit is authored by it.
    await this.publishIdentity(target, author);
    const before = new Set((await this.stashEntries(target)).map((entry) => entry.oid));
    try {
      await git.stash({
        ...gitOptions(target),
        op: request.op,
        ...(request.message === undefined ? {} : { message: validateCommitMessage(request.message) }),
        refIdx: index,
      });
    } catch (error) {
      throw stashFailure(request.op, error);
    }
    if (request.op === "push" && (await this.stashEntries(target)).every((entry) => before.has(entry.oid))) {
      throw new GitDomainError("nothing-to-stash", "No tracked worktree or index change was available to stash.");
    }
    return this.result(target.repository, [], context.signal, undefined, target.worktree.id);
  }

  async merge(request: GitMergeRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const ours = await git.currentBranch({ ...gitOptions(target), test: true });
    if (!ours) throw new GitDomainError("detached-head", "This checkout has no current branch to merge into.");
    // git.merge writes refs and objects but never the worktree, so a dirty tree
    // would be silently overwritten by the checkout that has to follow it.
    if ((await statusEntries(target)).length) {
      throw new GitDomainError("dirty-worktree", "Commit, stash, or discard worktree changes before merging into this checkout.");
    }
    const theirs = validateRevision(request.theirs);
    const identity = gitIdentity(validateAuthor(request.author), this.now());
    let merged: Awaited<ReturnType<typeof git.merge>>;
    try {
      merged = await git.merge({
        ...gitOptions(target),
        ours,
        theirs,
        fastForward: true,
        fastForwardOnly: request.fastForwardOnly === true,
        abortOnConflict: true,
        author: identity,
        committer: identity,
        ...(request.message === undefined ? {} : { message: validateCommitMessage(request.message) }),
      });
    } catch (error) {
      throw mergeFailure(theirs, error);
    }
    // isomorphic-git's own pull does exactly this: merge moves the ref, and only
    // a checkout makes the worktree and index agree with the new HEAD.
    await git.checkout({ ...gitOptions(target), ref: ours, force: true, nonBlocking: true });
    return this.result(target.repository, [], context.signal, merged.oid, target.worktree.id);
  }

  async restore(request: GitRestoreRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const paths = validatePathList(request.paths);
    const status = new Map((await statusEntries(target)).map((entry) => [entry.path, entry]));
    for (const path of paths) {
      if (!status.get(path)) throw new GitValidationError(`${path} has no change to discard.`);
    }
    // Read every plane before writing anything: a request that names a path Git
    // has no recorded version of must be refused whole, not after its siblings
    // have already been discarded.
    const planes = await contentPlanesFor(target, new Set(paths));
    for (const path of paths) {
      const plane = planes.get(path) ?? {};
      // An untracked path has neither an index nor a HEAD plane, so there is
      // nothing to discard back to. Both sources would otherwise delete it —
      // checkout prunes it, and the stage branch reads its absent index entry
      // as "this file should not exist" — destroying work Git never took
      // responsibility for. Git itself refuses with "pathspec did not match any
      // file known to git".
      if (!plane.stage && !plane.head) {
        throw new GitDomainError(
          "path-not-tracked",
          `${path} is not tracked by this repository, so there is no staged or committed version to discard back to. Delete it from the workspace yourself if that is what you meant.`,
        );
      }
      // A staged-but-never-committed path has an index plane and no HEAD plane,
      // so the check above admits it — but `--source=HEAD` has nothing to give
      // it back. checkout reads that shape (stage present, commit absent) as a
      // deletion and unlinks the file while dropping its index entry, destroying
      // content no commit ever recorded. Git refuses the same request with
      // "path ... does not exist in 'HEAD'".
      if (request.source === "head" && !plane.head) {
        throw new GitDomainError(
          "path-not-tracked",
          `${path} is staged but has never been committed, so HEAD holds no version to restore it from. Unstage it first, or delete it from the workspace yourself if that is what you meant.`,
        );
      }
    }
    if (request.source === "head") {
      const branch = await git.currentBranch({ ...gitOptions(target), test: true });
      if (!branch) throw new GitDomainError("detached-head", "This checkout has no current branch to restore from.");
      await git.checkout({
        ...gitOptions(target),
        ref: branch,
        filepaths: [...paths],
        force: true,
        nonBlocking: true,
      });
    } else {
      for (const path of paths) {
        const plane = planes.get(path) ?? {};
        const absolute = normalizeWorkspacePath(`${target.dir}/${path}`);
        if (plane.stage) await target.fs.promises.writeFile(absolute, plane.stage);
        else {
          const current = await this.workspace.read(absolute);
          if (current) await this.workspace.remove(absolute, { expectedRevision: current.revision });
        }
      }
    }
    assertNotAborted(context.signal);
    return this.result(target.repository, paths, context.signal, undefined, target.worktree.id);
  }

  async reset(request: GitResetRequest, context: GitOperationContext): Promise<GitMutationResult> {
    const target = await this.requireTarget(request);
    await this.expectExactVersion(target.repository, request.worktreeId, request.expectedWorktreeVersion, context.signal);
    const branch = await git.currentBranch({ ...gitOptions(target), test: true });
    if (!branch) throw new GitDomainError("detached-head", "This checkout has no current branch to reset.");
    const oid = await this.resolveRevision(target, validateRevision(request.ref));
    // Prove the target is a commit before moving a branch onto it.
    await git.readCommit({ ...gitOptions(target), oid });
    if (request.mode === "mixed") {
      const paths = await resetIndexPaths(target, oid);
      for (const path of paths) {
        await git.resetIndex({ ...gitOptions(target), filepath: path, ref: oid });
      }
    }
    await git.writeRef({ ...gitOptions(target), ref: `refs/heads/${branch}`, value: oid, force: true });
    if (request.mode === "hard") {
      await git.checkout({ ...gitOptions(target), ref: branch, force: true, nonBlocking: true });
    }
    assertNotAborted(context.signal);
    return this.result(target.repository, [], context.signal, oid, target.worktree.id);
  }

  async addRemote(request: GitAddRemoteRequest, context: GitOperationContext): Promise<GitMutationResult> {
    return this.writeRemote(request, "add", context);
  }

  async setRemoteUrl(request: GitSetRemoteUrlRequest, context: GitOperationContext): Promise<GitMutationResult> {
    return this.writeRemote(request, "set-url", context);
  }

  async removeRemote(request: GitRemoveRemoteRequest, context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const repository = await this.requireRepository(request.repositoryId);
    await this.expectRepositoryVersion(repository, request.expectedRepositoryVersion, context.signal);
    const reviewedRegistryRevision = this.registryRevision;
    const name = validateGitIdentifier(request.name, "Remote name");
    const existing = repository.remotes.find((candidate) => candidate.name === name);
    if (!existing) throw new GitNotFoundError(`Remote ${name}`);
    await git.deleteRemote({ ...repositoryOptions(this.fs.client, repository), remote: name });
    const updated = deepFreeze({ ...repository, remotes: repository.remotes.filter((candidate) => candidate.name !== name) });
    try {
      await this.replaceRepositoryRecord(updated, reviewedRegistryRevision);
    } catch (error) {
      // .git/config is not the published truth; the registry is. Put the config
      // back so the two cannot disagree about which remotes exist.
      try {
        await git.addRemote({ ...repositoryOptions(this.fs.client, repository), remote: name, url: existing.url, force: true });
      } catch (rollbackError) {
        this.quarantinedRemotes.set(repository.id, name);
        throw remoteConfigRollbackFailure(repository.id, name, error, rollbackError);
      }
      throw error;
    }
    return this.result(updated, [], context.signal);
  }

  /**
   * Both add and set-url are one `addRemote({ force })` call. The registry write
   * is mandatory: snapshot() projects remotes from the registry record, not from
   * .git/config, so a config-only write would be invisible everywhere.
   */
  private async writeRemote(request: GitAddRemoteRequest, mode: "add" | "set-url", context: GitOperationContext): Promise<GitMutationResult> {
    assertNotAborted(context.signal);
    const repository = await this.requireRepository(request.repositoryId);
    await this.expectRepositoryVersion(repository, request.expectedRepositoryVersion, context.signal);
    const reviewedRegistryRevision = this.registryRevision;
    const name = validateGitIdentifier(request.name, "Remote name");
    const url = validateRemoteUrl(request.url);
    const existing = repository.remotes.find((candidate) => candidate.name === name);
    if (mode === "add" && existing) throw new GitDomainError("remote-exists", `Remote ${name} already exists. Point it somewhere else with set-url.`);
    if (mode === "set-url" && !existing) throw new GitNotFoundError(`Remote ${name}`);
    if (!existing && repository.remotes.length >= MAX_REMOTES) throw new GitValidationError(`A browser repository holds at most ${MAX_REMOTES} remotes.`);
    await git.addRemote({ ...repositoryOptions(this.fs.client, repository), remote: name, url, force: true });
    const updated = deepFreeze({
      ...repository,
      remotes: [...repository.remotes.filter((candidate) => candidate.name !== name), { name, url }].sort((left, right) => asciiCompare(left.name, right.name)),
    });
    try {
      await this.replaceRepositoryRecord(updated, reviewedRegistryRevision);
    } catch (error) {
      try {
        if (existing) {
          await git.addRemote({ ...repositoryOptions(this.fs.client, repository), remote: name, url: existing.url, force: true });
        } else {
          await git.deleteRemote({ ...repositoryOptions(this.fs.client, repository), remote: name });
        }
      } catch (rollbackError) {
        this.quarantinedRemotes.set(repository.id, name);
        throw remoteConfigRollbackFailure(repository.id, name, error, rollbackError);
      }
      throw error;
    }
    return this.result(updated, [], context.signal);
  }

  private async reviewedRemoteHttp(
    repository: RepositoryRecord,
    remoteName: string,
    registryUrl: string,
    operation: "fetch" | "push",
  ): Promise<git.HttpClient> {
    const canonicalRegistryUrl = validateRemoteUrl(registryUrl);
    assertRemoteOriginPermitted(canonicalRegistryUrl, operation);
    const target = repositoryOptions(this.fs.client, repository);
    // Fail before handing control to isomorphic-git. The transport repeats the
    // same review at every actual fetch boundary to close config/read races.
    await this.reviewRemoteAuthority(target, remoteName, canonicalRegistryUrl, operation, repository.id);
    return createReviewedGitHttp({
      remoteUrl: canonicalRegistryUrl,
      reviewAuthority: () => this.reviewRemoteAuthority(
        target,
        remoteName,
        canonicalRegistryUrl,
        operation,
        repository.id,
      ),
    });
  }

  private async reviewRemoteAuthority(
    target: Readonly<{ fs: git.PromiseFsClient; dir: string; gitdir: string }>,
    remoteName: string,
    registryUrl: string,
    operation: "clone" | "fetch" | "push",
    repositoryId?: string,
  ): Promise<void> {
    const configured = await git.getConfig({
      ...gitOptions(target),
      path: `remote.${remoteName}.url`,
    });
    if (typeof configured !== "string") {
      if (repositoryId) this.quarantinedRemotes.set(repositoryId, remoteName);
      throw remoteAuthorityDiverged(remoteName, "its .git/config URL is missing or is not a single string");
    }
    let actualUrl: string;
    try { actualUrl = validateRemoteUrl(configured); }
    catch (error) {
      if (repositoryId) this.quarantinedRemotes.set(repositoryId, remoteName);
      throw error;
    }
    const diverged = actualUrl !== registryUrl;
    if (diverged && repositoryId) this.quarantinedRemotes.set(repositoryId, remoteName);
    // The policy is intentionally rerun against the authority read from the
    // conventional config, rather than trusting the registry's earlier check.
    assertRemoteOriginPermitted(actualUrl, operation);
    if (diverged) {
      throw remoteAuthorityDiverged(remoteName, "its canonical .git/config URL differs from the repository registry");
    }
  }

  private async isIgnoredPath(target: WorktreeTarget, path: string): Promise<boolean> {
    return git.isIgnored({ ...gitOptions(target), filepath: path });
  }

  private async resolveRevision(target: WorktreeTarget, revision: string): Promise<string> {
    if (/^[0-9a-f]{40}$/u.test(revision)) return revision;
    return git.resolveRef({ ...gitOptions(target), ref: revision });
  }

  private async publishIdentity(target: WorktreeTarget, author: GitAuthor): Promise<void> {
    await git.setConfig({ ...gitOptions(target), path: "user.name", value: author.name });
    await git.setConfig({ ...gitOptions(target), path: "user.email", value: author.email });
  }

  /**
   * The stash reflog is the authoritative list. isomorphic-git's `op: "list"`
   * returns rendered strings only, so read the same conventional file it wrote
   * and keep the object id beside each entry.
   */
  private async stashEntries(target: WorktreeTarget): Promise<readonly GitStashEntry[]> {
    const raw = await target.fs.promises.readFile(`${target.gitdir}/logs/refs/stash`, "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      }) as string;
    const lines = raw.split("\n").filter(Boolean).reverse().slice(0, GIT_LIMITS.maxStashEntries);
    return deepFreeze(lines.map((line, index) => {
      const [fields, message] = line.split("\t", 2);
      return { index, oid: fields?.split(" ")[1] ?? "", message: boundedMessage(message ?? "") };
    }));
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
    // A seeded .gitignore legitimately excludes seeded files, and git.add
    // silently skips them. The files stay in the workspace and remain visible to
    // Editor and Terminal, but they will never appear in a Git surface, so the
    // omission is announced instead of being inferred from an empty status.
    for (const path of baseline.keys()) await git.add({ fs: this.fs.client, dir: root, filepath: path });
    const staged = new Set(await git.listFiles({ fs: this.fs.client, dir: root }));
    const ignored = [...baseline.keys()].filter((path) => !staged.has(path));
    if (ignored.length) {
      console.warn(
        `Airship Git seed for ${id}: ${ignored.length} file(s) matched this repository's own ignore rules and were not committed. They remain in the workspace, untracked: ${ignored.slice(0, 20).join(", ")}${ignored.length > 20 ? ", …" : ""}`,
      );
    }
    const identity = gitIdentity(AIRSHIP_IDENTITY, this.now());
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

  /**
   * A snapshot is the initial local repository state, not a pile of new files.
   * The imported bytes already passed the admission check above, so make them
   * the first commit and leave HEAD, index, and worktree aligned. This keeps a
   * public snapshot's lack of upstream history honest without manufacturing a
   * first-use diff for every file.
   */
  private async initializeSnapshotRepository(
    repository: RepositoryRecord,
    files: ReadonlyMap<string, string>,
  ): Promise<void> {
    await git.init({ fs: this.fs.client, dir: repository.root, defaultBranch: repository.defaultBranch });
    if (files.size === 0) {
      const indexBootstrapPath = ".airship-git-index-bootstrap";
      await this.fs.writeText(`${repository.root}/${indexBootstrapPath}`, "");
      await git.add({ fs: this.fs.client, dir: repository.root, filepath: indexBootstrapPath, force: true });
      await git.resetIndex({ fs: this.fs.client, dir: repository.root, filepath: indexBootstrapPath });
      await this.fs.removeFile(`${repository.root}/${indexBootstrapPath}`);
    } else {
      for (const path of files.keys()) {
        await git.add({ fs: this.fs.client, dir: repository.root, filepath: path, force: true });
      }
    }
    const identity = gitIdentity(AIRSHIP_IDENTITY, this.now());
    if (files.size === 0) {
      const tree = await git.writeTree({ fs: this.fs.client, dir: repository.root, tree: [] });
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
    } else {
      await git.commit({
        fs: this.fs.client,
        dir: repository.root,
        ref: `refs/heads/${repository.defaultBranch}`,
        message: "Admit pinned browser snapshot",
        author: identity,
        committer: identity,
      });
    }
  }

  private async snapshot(repository: RepositoryRecord, signal: AbortSignal): Promise<GitRepositorySnapshot> {
    assertNotAborted(signal);
    const worktrees = await Promise.all(allWorktrees(repository).map((worktree) => this.worktreeSnapshot(this.target(repository, worktree), signal)));
    const branchNames = await git.listBranches(repositoryOptions(this.fs.client, repository));
    const checkedOut = new Set(worktrees.map((worktree) => worktree.branch));
    const branches = await Promise.all(branchNames.sort(asciiCompare).map(async (name) => ({
      name,
      oid: await git.resolveRef({ ...repositoryOptions(this.fs.client, repository), ref: name }),
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
    const branch = await git.currentBranch({ ...gitOptions(target), test: true }) || target.repository.defaultBranch;
    const head = await git.resolveRef({ ...gitOptions(target), ref: "HEAD" });
    const [version, status] = await Promise.all([
      this.issueVersion(target.repository, target.worktree.id),
      statusEntries(target),
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
    await this.assertRepositoryReconciled(repository);
    return repository;
  }

  private async assertRepositoryReconciled(repository: RepositoryRecord): Promise<void> {
    const quarantinedRemote = this.quarantinedRemotes.get(repository.id);
    if (!quarantinedRemote) return;
    const divergence = await this.remoteConfigDivergence(repository);
    if (!divergence) {
      this.quarantinedRemotes.delete(repository.id);
      return;
    }
    throw new GitDomainError(
      "repository-quarantined",
      `Repository ${repository.id} is blocked because remote ${quarantinedRemote} could not be reconciled after an authority failure. Reconcile .git/config with the repository registry before using it again.`,
    );
  }

  private async remoteConfigDivergence(repository: RepositoryRecord): Promise<string | undefined> {
    let configured: Array<{ remote: string; url: string }>;
    try {
      configured = await git.listRemotes({
        ...repositoryOptions(this.fs.client, repository),
      });
    } catch {
      return "configuration";
    }
    const registry = new Map(repository.remotes.map((remote) => [remote.name, remote.url]));
    const seen = new Set<string>();
    for (const candidate of configured) {
      let name: string;
      let url: string;
      try {
        name = validateGitIdentifier(candidate.remote, "Remote name");
        url = validateRemoteUrl(candidate.url);
      } catch {
        return "configuration";
      }
      if (seen.has(name) || registry.get(name) !== url) return name;
      seen.add(name);
    }
    for (const name of registry.keys()) if (!seen.has(name)) return name;
    return undefined;
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
      return { id: worktree.id, branch: await git.currentBranch({ ...gitOptions(target), test: true }) };
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
      await git.resolveRef({ ...repositoryOptions(this.fs.client, repository), ref: "HEAD" });
      const divergentRemote = await this.remoteConfigDivergence(repository);
      if (divergentRemote) this.quarantinedRemotes.set(repository.id, divergentRemote);
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
        await git.resolveRef({ ...gitOptions(target), ref: "HEAD" });
      }
    }
  }
}

function gitOptions(target: GitTarget): GitTarget {
  return { fs: target.fs, dir: target.dir, gitdir: target.gitdir };
}

function repositoryOptions(fs: git.PromiseFsClient, repository: RepositoryRecord): GitTarget {
  return { fs, dir: repository.root, gitdir: commonGitdir(repository) };
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

async function statusEntries(target: GitTarget): Promise<readonly GitStatusEntry[]> {
  const matrix = await git.statusMatrix({ ...gitOptions(target), refresh: false });
  const changed = matrix.filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
  if (!changed.length) return deepFreeze([]);
  // One walk for every changed path. Walking once per path is O(paths x files)
  // against a workspace whose every read is a port round trip.
  const planes = await contentPlanesFor(target, new Set(changed.map(([path]) => path)));
  const entries = changed.map(([path, head, workdir, stage]) => {
    const index = head === stage ? null : { kind: deltaFromPresence(head, stage) } as const;
    const worktree = workdir === stage ? null : { kind: deltaFromPresence(stage, workdir) } as const;
    const plane = planes.get(path) ?? {};
    const counts = lineCounts(worktree ? plane.stage : plane.head, worktree ? plane.workdir : plane.stage);
    return deepFreeze({ path, index, worktree, ...counts });
  });
  return deepFreeze(entries.sort((left, right) => asciiCompare(left.path, right.path)));
}

type ContentPlanes = { head?: Uint8Array; stage?: Uint8Array; workdir?: Uint8Array };

async function contentPlanes(target: GitTarget, path: string): Promise<ContentPlanes> {
  return (await contentPlanesFor(target, new Set([path]))).get(path) ?? {};
}

async function contentPlanesFor(target: GitTarget, paths: ReadonlySet<string>): Promise<ReadonlyMap<string, ContentPlanes>> {
  type PlaneEntry = git.WalkerEntry | null;
  // Directories on the way to a requested path must be descended into; every
  // other subtree is pruned so the walk never reads an irrelevant blob.
  const ancestors = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) ancestors.add(segments.slice(0, length).join("/"));
  }
  const options = gitOptions(target);
  const found = await git.walk({
    ...options,
    trees: [git.TREE({ ref: "HEAD" }), git.WORKDIR({ refresh: false }), git.STAGE()],
    map: async (filepath, entries: PlaneEntry[]) => {
      if (!paths.has(filepath)) return filepath === "." || ancestors.has(filepath) ? undefined : null;
      const [head, workdir, stage] = entries;
      const headContent = await head?.content();
      const workdirContent = await workdir?.content();
      const stageOid = await stage?.oid();
      const stageContent = stageOid ? (await git.readBlob({ ...options, oid: stageOid })).blob : undefined;
      return { path: filepath, head: headContent, workdir: workdirContent, stage: stageContent };
    },
  }) as Array<ContentPlanes & { path: string }>;
  return new Map(found.filter(Boolean).map((entry) => [entry.path, entry]));
}

type CommitChange = Readonly<{ path: string; before?: string; after?: string }>;

/** Blob-level difference between a commit and its first parent (or the empty tree). */
async function commitChanges(target: WorktreeTarget, oid: string, parent?: string): Promise<readonly CommitChange[]> {
  const trees = parent ? [git.TREE({ ref: parent }), git.TREE({ ref: oid })] : [git.TREE({ ref: oid })];
  const found = await git.walk({
    ...gitOptions(target),
    trees,
    map: async (filepath, entries) => {
      if (filepath === ".") return undefined;
      const [before, after] = parent ? entries : [null, entries[0]];
      const beforeType = before ? await before.type() : undefined;
      const afterType = after ? await after.type() : undefined;
      if (beforeType === "tree" || afterType === "tree") return undefined;
      if (beforeType && beforeType !== "blob") return null;
      if (afterType && afterType !== "blob") return null;
      const beforeOid = before ? await before.oid() : undefined;
      const afterOid = after ? await after.oid() : undefined;
      if (beforeOid === afterOid) return null;
      return { path: filepath, ...(beforeOid ? { before: beforeOid } : {}), ...(afterOid ? { after: afterOid } : {}) };
    },
  }) as CommitChange[];
  return deepFreeze(found.filter(Boolean).sort((left, right) => asciiCompare(left.path, right.path)));
}

/** Index entries a mixed reset must rewrite: everything the index or the target tree names. */
async function resetIndexPaths(target: WorktreeTarget, oid: string): Promise<readonly string[]> {
  const [indexed, committed] = await Promise.all([
    git.listFiles(gitOptions(target)),
    git.listFiles({ ...gitOptions(target), ref: oid }),
  ]);
  const paths = [...new Set([...indexed, ...committed])].sort(asciiCompare);
  if (paths.length > GIT_LIMITS.maxPathsPerRequest) {
    throw new GitDomainError(
      "reset-too-large",
      `A mixed reset would rewrite ${paths.length} index entries, past the ${GIT_LIMITS.maxPathsPerRequest}-path bound. Use a hard or soft reset.`,
    );
  }
  return deepFreeze(paths);
}

function commitSummary(entry: git.ReadCommitResult): GitCommitSummary {
  return deepFreeze({
    oid: entry.oid,
    parents: [...entry.commit.parent],
    message: boundedMessage(entry.commit.message),
    author: { name: entry.commit.author.name, email: entry.commit.author.email },
    committedAt: new Date(entry.commit.committer.timestamp * 1_000).toISOString(),
  });
}

function boundedMessage(message: string): string {
  return message.length > MAX_LOG_MESSAGE_CHARS ? `${message.slice(0, MAX_LOG_MESSAGE_CHARS)}\n… message truncated …` : message;
}

function mergeFailure(theirs: string, error: unknown): Error {
  const conflicts = (error as { data?: { filepaths?: unknown } }).data?.filepaths;
  if ((error as { code?: string }).code === "MergeConflictError" && Array.isArray(conflicts)) {
    return new GitDomainError(
      "merge-conflict",
      `Merging ${theirs} conflicts in ${conflicts.length} path(s) and was aborted, so this worktree is unchanged: ${conflicts.slice(0, 20).join(", ")}${conflicts.length > 20 ? ", …" : ""}. This browser adapter performs only conflict-free merges; resolve these paths on a branch that merges cleanly.`.slice(0, 1_200),
    );
  }
  if ((error as { code?: string }).code === "FastForwardError") {
    return new GitDomainError("merge-not-fast-forward", `Merging ${theirs} needs a merge commit, but the request demanded a fast-forward only.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function stashFailure(op: GitStashRequest["op"], error: unknown): Error {
  if ((error as { code?: string }).code === "NotFoundError" && op === "push") {
    return new GitDomainError("nothing-to-stash", "No tracked worktree or index change was available to stash.");
  }
  return error instanceof Error ? error : new Error(String(error));
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

/**
 * Remote verbs use real Smart HTTP. The dedicated Git egress policy decides
 * which origins they may contact; capability text names that exact scope.
 */
function remoteFeature(capability: "clone" | "fetch" | "push", permittedOrigins: readonly string[]): GitCapabilityState {
  if (!permittedOrigins.length) {
    return {
      available: false,
      reason: `this host has no document origin and the Git allowlist permits no origin at all, so every ${capability} fails before a request is sent`,
    };
  }
  const refused = refusedCommonOrigins(permittedOrigins);
  return {
    available: true,
    reason: `${capability} can reach only ${permittedOrigins.join(", ")} — the origins this build's Git egress policy permits for Smart HTTP. Every other remote${refused.length ? `, ${hostList(refused)} included,` : ""} is refused before a request is sent.`,
  };
}

/**
 * The commonly attempted hosts this build's own allowlist does *not* cover. The
 * capability text names them from this, never from a literal, so adding a host
 * to the Git allowlist cannot leave the adapter asserting it is still refused.
 */
function refusedCommonOrigins(permittedOrigins: readonly string[]): readonly string[] {
  return COMMONLY_ATTEMPTED_GIT_ORIGINS.filter((origin) => !permittedOrigins.includes(origin));
}

/**
 * The refusal clause, or nothing when the policy already covers every commonly
 * attempted host. The importer is only offered as the alternative while
 * github.com itself is the host being refused.
 */
function refusedDetail(permittedOrigins: readonly string[]): string {
  const refused = refusedCommonOrigins(permittedOrigins);
  if (!refused.length) return "";
  const importer = refused.includes("https://github.com") ? "; use the GitHub snapshot importer instead" : "";
  return ` ${hostList(refused)} ${refused.length > 1 ? "are" : "is"} not among them, so clone, fetch, and push against ${refused.length > 1 ? "them" : "it"} fail before any request is sent${importer}.`;
}

function hostList(origins: readonly string[]): string {
  const hosts = origins.map((origin) => new URL(origin).host);
  return hosts.length > 1 ? `${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}` : hosts.join("");
}

function capabilities(durable: boolean, memoryAuth: boolean): GitAdapterCapabilities {
  const permittedOrigins = gitRemoteConnectOrigins();
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
      permittedOrigins,
      detail: `isomorphic-git speaks Smart HTTP directly and Airship never inserts a proxy. The separate Git egress policy permits: ${permittedOrigins.length ? permittedOrigins.join(", ") : "none — this host has no document origin and the Git allowlist is empty"}.${refusedDetail(permittedOrigins)} A permitted remote must still grant this browser origin CORS unless it shares the origin. ${memoryAuth ? "A caller-supplied credential broker is held in page memory only." : "No credential broker is installed, so authenticated remotes reject while anonymous-capable remotes can proceed."}`,
    },
    features: {
      status: { available: true }, diff: { available: true }, stage: { available: true }, commit: { available: true }, branch: { available: true },
      worktree: { available: true },
      "snapshot-import": { available: true },
      clone: remoteFeature("clone", permittedOrigins), fetch: remoteFeature("fetch", permittedOrigins),
      push: remoteFeature("push", permittedOrigins),
      history: { available: true },
      tag: { available: true },
      stash: { available: true },
      merge: { available: true },
      restore: { available: true },
      "remote-config": { available: true },
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

function remoteAuthorityDiverged(remoteName: string, detail: string): GitDomainError {
  return new GitDomainError(
    "remote-config-diverged",
    `Remote ${remoteName} is blocked because ${detail}. Reconcile .git/config with the reviewed repository registry before retrying.`,
  );
}

function remoteConfigRollbackFailure(
  repositoryId: string,
  remoteName: string,
  registryError: unknown,
  rollbackError: unknown,
): AggregateError & { readonly code: "repository-quarantined" } {
  const aggregate = new AggregateError(
    [registryError, rollbackError],
    `Remote ${remoteName} in repository ${repositoryId} could not commit its registry change or roll .git/config back. The repository is quarantined until both authorities are reconciled.`,
  ) as AggregateError & { readonly code: "repository-quarantined" };
  Object.defineProperty(aggregate, "code", { value: "repository-quarantined", enumerable: true });
  aggregate.cause = registryError;
  return aggregate;
}

/**
 * Reached only after the Git egress policy allows this origin, so the failure
 * is remote-side or transport-side. Same-origin remotes need no CORS grant.
 */
function directHttpError(operation: "clone" | "fetch" | "push", url: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const origin = new URL(url).origin;
  const cause = origin === pageOrigin()
    ? "That is this page's own origin, so no CORS grant was required; the remote or the network refused the request."
    : "The Git egress policy permits that origin, so the remote must also grant this Airship browser origin CORS for Git Smart HTTP.";
  return new GitDomainError(
    "direct-git-http-failed",
    `Direct Git ${operation} failed for ${origin}. ${cause} No Airship proxy was used; no proxy or backend handled this request. It may also require a memory-only credential this adapter does not have. ${message}`.slice(0, 1_200),
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
