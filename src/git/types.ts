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
  | Readonly<{ kind: "push"; request: GitPushRequest }>;

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
  stage(request: GitStageRequest, context: GitOperationContext): Promise<GitMutationResult>;
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
}
