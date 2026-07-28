import type { JsonValue, ToolDefinition } from "../core/contracts";

export const GIT_CAPABILITIES = [
  "status",
  "diff",
  "stage",
  "commit",
  "branch",
  "worktree",
  "snapshot-import",
  "clone",
  "fetch",
  "push",
  "history",
  "tag",
  "stash",
  "merge",
  "restore",
  "remote-config",
] as const;

export type GitCapability = (typeof GIT_CAPABILITIES)[number];
export type GitObjectId = string;
export type GitStorageBackend = "memory" | "indexeddb" | "opfs" | "file-system-access" | "encrypted-workspace" | "host-managed";
export type GitRemoteTransport = "none" | "direct-git-http" | "host-provider-api";
export type GitDeltaKind = "added" | "modified" | "deleted" | "renamed" | "conflicted";
export type GitDiffScope = "staged" | "worktree";

export type GitCapabilityState = Readonly<{
  available: boolean;
  /** Human-readable, capability-specific truth. Required when unavailable. */
  reason?: string;
}>;

export type GitAdapterCapabilities = Readonly<{
  adapterId: string;
  adapterName: string;
  storage: Readonly<{
    backend: GitStorageBackend;
    durable: boolean;
    detail: string;
  }>;
  remote: Readonly<{
    transport: GitRemoteTransport;
    requiresCors: boolean;
    credentialPersistence: "none" | "memory-only" | "host-managed";
    /**
     * Exact origins this build's own Content-Security-Policy lets Git Smart
     * HTTP reach. Empty means no remote can be contacted from this page at all,
     * whatever the remote's CORS policy says.
     */
    permittedOrigins: readonly string[];
    detail: string;
  }>;
  features: Readonly<Record<GitCapability, GitCapabilityState>>;
}>;

export type GitDelta = Readonly<{
  kind: GitDeltaKind;
  fromPath?: string;
}>;

/** A path can have both a staged delta and a later, unstaged delta. */
export type GitStatusEntry = Readonly<{
  path: string;
  index: GitDelta | null;
  worktree: GitDelta | null;
  additions?: number;
  deletions?: number;
}>;

export type GitBranchSummary = Readonly<{
  name: string;
  oid: GitObjectId;
  current: boolean;
}>;

export type GitWorktreeSnapshot = Readonly<{
  id: string;
  /** Adapter-owned display path; never interpreted as an unrestricted host path. */
  path: string;
  branch: string;
  head: GitObjectId;
  version: string;
  status: readonly GitStatusEntry[];
}>;

export type GitRemoteSummary = Readonly<{
  name: string;
  url: string;
  transport: Exclude<GitRemoteTransport, "none">;
}>;

export type GitRepositorySnapshot = Readonly<{
  id: string;
  name: string;
  defaultBranch: string;
  version: string;
  storage: GitAdapterCapabilities["storage"];
  remotes: readonly GitRemoteSummary[];
  branches: readonly GitBranchSummary[];
  worktrees: readonly GitWorktreeSnapshot[];
  capabilities: GitAdapterCapabilities;
  lastRemoteSyncAt?: string;
}>;

export type GitDiff = Readonly<{
  path: string;
  scope: GitDiffScope;
  patch: string;
  binary: boolean;
  truncated: boolean;
  byteLength: number;
}>;

export type GitAuthor = Readonly<{
  name: string;
  email: string;
}>;

/** Library-neutral, in-memory transfer form used only for explicit adapter changes. */
export type GitPortableCheckpoint = Readonly<{
  version: 1;
  /** Optional fenced origin carried through Ephemeral mode for a safe return to the same vault. */
  persistenceBase?: Readonly<{
    adapterId: "airship-encrypted-workspace-git";
    headPath: string;
    headRevision: string;
    generation: number;
    stateDigest: string;
  }>;
  repositories: readonly Readonly<{
    id: string;
    name: string;
    defaultBranch: string;
    revision: number;
    commits: readonly Readonly<{
      oid: string;
      parent?: string;
      tree: readonly (readonly [string, string])[];
      message: string;
      author: GitAuthor;
      committedAt: string;
    }>[];
    branches: readonly (readonly [string, string])[];
    worktrees: readonly Readonly<{
      id: string;
      path: string;
      branch: string;
      head: string;
      index: readonly (readonly [string, string])[];
      files: readonly (readonly [string, string])[];
      revision: number;
    }>[];
    remotes: readonly (readonly [string, string])[];
  }>[];
}>;

export type GitStatusRequest = Readonly<{
  repositoryId: string;
  worktreeId: string;
}>;

/** Version-fenced browser worktree edit used by the Workspace workbench. */
export type GitWriteWorkingFileRequest = GitStatusRequest & Readonly<{
  path: string;
  content: string;
  expectedWorktreeVersion: string;
}>;

/** Version-fenced browser worktree removal used by the Workspace workbench. */
export type GitRemoveWorkingFileRequest = GitStatusRequest & Readonly<{
  path: string;
  expectedWorktreeVersion: string;
}>;

export type GitMoveWorkingFileRequest = GitStatusRequest & Readonly<{
  sourcePath: string;
  targetPath: string;
  expectedWorktreeVersion: string;
}>;

export type GitDiffRequest = GitStatusRequest & Readonly<{
  path: string;
  scope: GitDiffScope;
}>;

export type GitStageRequest = GitStatusRequest & Readonly<{
  paths: readonly string[];
  expectedWorktreeVersion: string;
  /** Stage a path the repository's own ignore rules exclude. Ignored by unstage. */
  force?: boolean;
}>;

export type GitCommitRequest = GitStatusRequest & Readonly<{
  message: string;
  author: GitAuthor;
  expectedWorktreeVersion: string;
}>;

export type GitCreateBranchRequest = GitStatusRequest & Readonly<{
  name: string;
  startPoint?: string;
  checkout?: boolean;
  expectedWorktreeVersion: string;
}>;

export type GitSwitchBranchRequest = GitStatusRequest & Readonly<{
  name: string;
  expectedWorktreeVersion: string;
}>;

export type GitCreateWorktreeRequest = Readonly<{
  repositoryId: string;
  worktreeId: string;
  path: string;
  branch: string;
  expectedRepositoryVersion: string;
}>;

export type GitRemoveWorktreeRequest = Readonly<{
  repositoryId: string;
  worktreeId: string;
  expectedRepositoryVersion: string;
}>;

export type GitCloneRequest = Readonly<{
  repositoryId: string;
  name: string;
  remoteUrl: string;
  remoteName?: string;
  defaultBranch?: string;
  /** Adapter-owned virtual path or a previously authorized file-system handle label. */
  destination: string;
}>;

/** Admit an already-verified text snapshot into an adapter-owned repository. */
export type GitSnapshotImportRequest = Readonly<{
  repositoryId: string;
  name: string;
  destination: string;
  sourceUrl: string;
  defaultBranch: string;
  files: Readonly<Record<string, string>>;
}>;

export type GitFetchRequest = Readonly<{
  repositoryId: string;
  remote: string;
  expectedRepositoryVersion: string;
  prune?: boolean;
}>;

export type GitPushRequest = GitStatusRequest & Readonly<{
  remote: string;
  branch: string;
  expectedWorktreeVersion: string;
  force?: boolean;
}>;

export type GitCommitSummary = Readonly<{
  oid: GitObjectId;
  parents: readonly GitObjectId[];
  message: string;
  author: GitAuthor;
  committedAt: string;
}>;

/** Bounded history read. `path` follows one file; revision expressions are not parsed. */
export type GitLogRequest = GitStatusRequest & Readonly<{
  ref?: string;
  depth?: number;
  path?: string;
  follow?: boolean;
}>;

export type GitCommitFilePatch = Readonly<{
  path: string;
  kind: Exclude<GitDeltaKind, "renamed" | "conflicted">;
  patch: string;
  binary: boolean;
  truncated: boolean;
}>;

export type GitCommitDetail = Readonly<{
  commit: GitCommitSummary;
  /** Patch against the first parent. A root commit is diffed against the empty tree. */
  files: readonly GitCommitFilePatch[];
  /** True when the commit touched more paths than the per-commit patch bound. */
  truncated: boolean;
}>;

/** `revision` is a 40-hex object id, a branch, or a tag — never a revision expression. */
export type GitShowRequest = GitStatusRequest & Readonly<{
  revision: string;
  maxPaths?: number;
}>;

export type GitTagSummary = Readonly<{
  name: string;
  /** The tag object for an annotated tag, otherwise the commit it names. */
  oid: GitObjectId;
  annotated: boolean;
  target: GitObjectId;
  message?: string;
}>;

export type GitCreateTagRequest = Readonly<{
  repositoryId: string;
  name: string;
  ref?: string;
  /** Present for an annotated tag object; absent creates a lightweight ref. */
  message?: string;
  author?: GitAuthor;
  force?: boolean;
  expectedRepositoryVersion: string;
}>;

export type GitDeleteTagRequest = Readonly<{
  repositoryId: string;
  name: string;
  expectedRepositoryVersion: string;
}>;

export type GitStashOp = "push" | "apply" | "pop" | "drop" | "clear";

export type GitStashEntry = Readonly<{
  index: number;
  oid: GitObjectId;
  message: string;
}>;

export type GitStashRequest = GitStatusRequest & Readonly<{
  op: GitStashOp;
  message?: string;
  index?: number;
  /** Git records a stash commit, so it needs an identity exactly like commit does. */
  author: GitAuthor;
  expectedWorktreeVersion: string;
}>;

export type GitMergeRequest = GitStatusRequest & Readonly<{
  /** The branch or commit merged into the worktree's current branch. */
  theirs: string;
  fastForwardOnly?: boolean;
  message?: string;
  author: GitAuthor;
  expectedWorktreeVersion: string;
}>;

/** Discard worktree edits for named paths, from the index or from HEAD. */
export type GitRestoreRequest = GitStatusRequest & Readonly<{
  paths: readonly string[];
  source: "stage" | "head";
  expectedWorktreeVersion: string;
}>;

export type GitResetMode = "soft" | "mixed" | "hard";

export type GitResetRequest = GitStatusRequest & Readonly<{
  mode: GitResetMode;
  ref: string;
  expectedWorktreeVersion: string;
}>;

export type GitAddRemoteRequest = Readonly<{
  repositoryId: string;
  name: string;
  url: string;
  expectedRepositoryVersion: string;
}>;

export type GitRemoveRemoteRequest = Readonly<{
  repositoryId: string;
  name: string;
  expectedRepositoryVersion: string;
}>;

export type GitSetRemoteUrlRequest = GitAddRemoteRequest;

export type GitMutationResult = Readonly<{
  repository: GitRepositorySnapshot;
  worktree?: GitWorktreeSnapshot;
  changedPaths: readonly string[];
  commit?: GitObjectId;
}>;

export type GitOperation =
  | Readonly<{ kind: "status"; request: GitStatusRequest }>
  | Readonly<{ kind: "diff"; request: GitDiffRequest }>
  | Readonly<{ kind: "stage"; request: GitStageRequest }>
  | Readonly<{ kind: "unstage"; request: GitStageRequest }>
  | Readonly<{ kind: "commit"; request: GitCommitRequest }>
  | Readonly<{ kind: "branch-create"; request: GitCreateBranchRequest }>
  | Readonly<{ kind: "branch-switch"; request: GitSwitchBranchRequest }>
  | Readonly<{ kind: "worktree-create"; request: GitCreateWorktreeRequest }>
  | Readonly<{ kind: "worktree-remove"; request: GitRemoveWorktreeRequest }>
  | Readonly<{ kind: "clone"; request: GitCloneRequest }>
  | Readonly<{ kind: "fetch"; request: GitFetchRequest }>
  | Readonly<{ kind: "push"; request: GitPushRequest }>
  | Readonly<{ kind: "log"; request: GitLogRequest }>
  | Readonly<{ kind: "show"; request: GitShowRequest }>
  | Readonly<{ kind: "tag-create"; request: GitCreateTagRequest }>
  | Readonly<{ kind: "tag-delete"; request: GitDeleteTagRequest }>
  | Readonly<{ kind: "stash"; request: GitStashRequest }>
  | Readonly<{ kind: "merge"; request: GitMergeRequest }>
  | Readonly<{ kind: "restore"; request: GitRestoreRequest }>
  | Readonly<{ kind: "reset"; request: GitResetRequest }>
  | Readonly<{ kind: "remote-add"; request: GitAddRemoteRequest }>
  | Readonly<{ kind: "remote-set-url"; request: GitSetRemoteUrlRequest }>
  | Readonly<{ kind: "remote-remove"; request: GitRemoveRemoteRequest }>;

export type GitOperationRisk = "observe" | "change-local" | "communicate" | "change-remote";

/** Exact, redaction-safe material suitable for the approval broker's display arguments. */
export type GitOperationDescriptor = Readonly<{
  operation: GitOperation["kind"];
  brokerEffect: ToolDefinition["effect"];
  risk: GitOperationRisk;
  approvalRequired: boolean;
  summary: string;
  resource: string;
  destination?: string;
  dataLeavesDevice: boolean;
  arguments: JsonValue;
}>;

export type GitOperationContext = Readonly<{
  signal: AbortSignal;
  operationId?: string;
}>;

/**
 * Domain codes an adapter may raise only from the pre-flight of a chunkable
 * path operation — `stage`, `unstage`, `restore` — which `BrowserGitClient`
 * may have to execute as several calls. Those three must admit or refuse every
 * requested path *before* their first write, so a rejection carrying one of
 * these codes provably changed nothing and the client can surface it verbatim
 * instead of reporting a durable partial mutation that never happened. Any
 * other code, raised at any point, keeps the conservative partial framing.
 */
export const GIT_PRE_WRITE_FAILURE_CODES: readonly string[] = Object.freeze([
  "not-found",
  "version-conflict",
  "validation",
  "path-ignored",
  "path-not-tracked",
  "detached-head",
]);

export interface BrowserGitAdapter {
  readonly capabilities: GitAdapterCapabilities;
  /** Export a detached checkpoint for a user-selected durability-mode transition. */
  exportCheckpoint(context: GitOperationContext): Promise<GitPortableCheckpoint>;
  listRepositories(context: GitOperationContext): Promise<readonly GitRepositorySnapshot[]>;
  getRepository(repositoryId: string, context: GitOperationContext): Promise<GitRepositorySnapshot | undefined>;
  status(request: GitStatusRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot>;
  writeWorkingFile(request: GitWriteWorkingFileRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot>;
  removeWorkingFile(request: GitRemoveWorkingFileRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot>;
  moveWorkingFile(request: GitMoveWorkingFileRequest, context: GitOperationContext): Promise<GitWorktreeSnapshot>;
  diff(request: GitDiffRequest, context: GitOperationContext): Promise<GitDiff>;
  /** Must admit or refuse every path before its first write. See `GIT_PRE_WRITE_FAILURE_CODES`. */
  stage(request: GitStageRequest, context: GitOperationContext): Promise<GitMutationResult>;
  /** Must admit or refuse every path before its first write. See `GIT_PRE_WRITE_FAILURE_CODES`. */
  unstage(request: GitStageRequest, context: GitOperationContext): Promise<GitMutationResult>;
  commit(request: GitCommitRequest, context: GitOperationContext): Promise<GitMutationResult>;
  createBranch(request: GitCreateBranchRequest, context: GitOperationContext): Promise<GitMutationResult>;
  switchBranch(request: GitSwitchBranchRequest, context: GitOperationContext): Promise<GitMutationResult>;
  createWorktree(request: GitCreateWorktreeRequest, context: GitOperationContext): Promise<GitMutationResult>;
  removeWorktree(request: GitRemoveWorktreeRequest, context: GitOperationContext): Promise<GitMutationResult>;
  importSnapshot(request: GitSnapshotImportRequest, context: GitOperationContext): Promise<GitMutationResult>;
  clone(request: GitCloneRequest, context: GitOperationContext): Promise<GitMutationResult>;
  fetch(request: GitFetchRequest, context: GitOperationContext): Promise<GitMutationResult>;
  push(request: GitPushRequest, context: GitOperationContext): Promise<GitMutationResult>;
  log(request: GitLogRequest, context: GitOperationContext): Promise<readonly GitCommitSummary[]>;
  show(request: GitShowRequest, context: GitOperationContext): Promise<GitCommitDetail>;
  listTags(repositoryId: string, context: GitOperationContext): Promise<readonly GitTagSummary[]>;
  createTag(request: GitCreateTagRequest, context: GitOperationContext): Promise<GitMutationResult>;
  deleteTag(request: GitDeleteTagRequest, context: GitOperationContext): Promise<GitMutationResult>;
  listStash(request: GitStatusRequest, context: GitOperationContext): Promise<readonly GitStashEntry[]>;
  stash(request: GitStashRequest, context: GitOperationContext): Promise<GitMutationResult>;
  merge(request: GitMergeRequest, context: GitOperationContext): Promise<GitMutationResult>;
  /** Must admit or refuse every path before its first write. See `GIT_PRE_WRITE_FAILURE_CODES`. */
  restore(request: GitRestoreRequest, context: GitOperationContext): Promise<GitMutationResult>;
  reset(request: GitResetRequest, context: GitOperationContext): Promise<GitMutationResult>;
  addRemote(request: GitAddRemoteRequest, context: GitOperationContext): Promise<GitMutationResult>;
  setRemoteUrl(request: GitSetRemoteUrlRequest, context: GitOperationContext): Promise<GitMutationResult>;
  removeRemote(request: GitRemoveRemoteRequest, context: GitOperationContext): Promise<GitMutationResult>;
}
