import { GitCapabilityError, GitConcurrencyError } from "./errors";
import { normalizeGitOperation } from "./operations";
import type {
  BrowserGitAdapter,
  GitCapability,
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
  GitStatusRequest,
  GitWriteWorkingFileRequest,
  GitRemoveWorkingFileRequest,
  GitMoveWorkingFileRequest,
  GitSwitchBranchRequest,
  GitWorktreeSnapshot,
  GitCloneRequest,
  GitSnapshotImportRequest,
} from "./types";
import { GIT_CAPABILITIES } from "./types";
import { assertNotAborted, validateFileContent, validateGitIdentifier, validateGitPath, validateVersion } from "./validation";

const passiveSignal = new AbortController().signal;

/**
 * Validation, immutability, capability, cancellation, and single-writer waist.
 *
 * Adapters own their durable commit point. Cancellation is checked before
 * dispatch; once dispatched, an adapter must return a committed result or a
 * typed unknown-outcome error rather than claiming a rollback it cannot prove.
 */
export class BrowserGitClient {
  readonly capabilities;
  private readonly mutations = new Set<string>();

  constructor(private readonly adapter: BrowserGitAdapter) {
    validateCapabilities(adapter.capabilities);
    this.capabilities = cloneAndFreeze(adapter.capabilities);
  }

  async listRepositories(signal: AbortSignal = passiveSignal): Promise<readonly GitRepositorySnapshot[]> {
    assertNotAborted(signal);
    const repositories = await this.adapter.listRepositories({ signal });
    return cloneAndFreeze(repositories);
  }

  async getRepository(repositoryId: string, signal: AbortSignal = passiveSignal): Promise<GitRepositorySnapshot | undefined> {
    assertNotAborted(signal);
    const result = await this.adapter.getRepository(validateGitIdentifier(repositoryId, "Repository ID"), { signal });
    return result ? cloneAndFreeze(result) : undefined;
  }

  async exportCheckpoint(signal: AbortSignal = passiveSignal): Promise<GitPortableCheckpoint> {
    assertNotAborted(signal);
    return cloneAndFreeze(await this.adapter.exportCheckpoint({ signal }));
  }

  async status(request: GitStatusRequest, signal: AbortSignal = passiveSignal): Promise<GitWorktreeSnapshot> {
    this.require("status");
    const normalized = normalizeGitOperation({ kind: "status", request }).request;
    assertNotAborted(signal);
    return cloneAndFreeze(await this.adapter.status(normalized, { signal }));
  }

  writeWorkingFile(request: GitWriteWorkingFileRequest, signal: AbortSignal = passiveSignal): Promise<GitWorktreeSnapshot> {
    const normalized = {
      repositoryId: validateGitIdentifier(request.repositoryId, "Repository ID"),
      worktreeId: validateGitIdentifier(request.worktreeId, "Worktree ID"),
      path: validateGitPath(request.path),
      content: validateFileContent(request.content),
      expectedWorktreeVersion: validateVersion(request.expectedWorktreeVersion),
    };
    return this.worktreeStateMutation(normalized, signal, (context) => this.adapter.writeWorkingFile(normalized, context));
  }

  removeWorkingFile(request: GitRemoveWorkingFileRequest, signal: AbortSignal = passiveSignal): Promise<GitWorktreeSnapshot> {
    const normalized = {
      repositoryId: validateGitIdentifier(request.repositoryId, "Repository ID"),
      worktreeId: validateGitIdentifier(request.worktreeId, "Worktree ID"),
      path: validateGitPath(request.path),
      expectedWorktreeVersion: validateVersion(request.expectedWorktreeVersion),
    };
    return this.worktreeStateMutation(normalized, signal, (context) => this.adapter.removeWorkingFile(normalized, context));
  }

  moveWorkingFile(request: GitMoveWorkingFileRequest, signal: AbortSignal = passiveSignal): Promise<GitWorktreeSnapshot> {
    const normalized = {
      repositoryId: validateGitIdentifier(request.repositoryId, "Repository ID"),
      worktreeId: validateGitIdentifier(request.worktreeId, "Worktree ID"),
      sourcePath: validateGitPath(request.sourcePath),
      targetPath: validateGitPath(request.targetPath),
      expectedWorktreeVersion: validateVersion(request.expectedWorktreeVersion),
    };
    return this.worktreeStateMutation(normalized, signal, (context) => this.adapter.moveWorkingFile(normalized, context));
  }

  async diff(request: GitDiffRequest, signal: AbortSignal = passiveSignal): Promise<GitDiff> {
    this.require("diff");
    const normalized = normalizeGitOperation({ kind: "diff", request }).request;
    assertNotAborted(signal);
    return cloneAndFreeze(await this.adapter.diff(normalized, { signal }));
  }

  stage(request: GitStageRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "stage", request }).request;
    return this.worktreeMutation("stage", normalized, signal, (context) => this.adapter.stage(normalized, context));
  }

  unstage(request: GitStageRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "unstage", request }).request;
    return this.worktreeMutation("stage", normalized, signal, (context) => this.adapter.unstage(normalized, context));
  }

  commit(request: GitCommitRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "commit", request }).request;
    return this.worktreeMutation("commit", normalized, signal, (context) => this.adapter.commit(normalized, context));
  }

  createBranch(request: GitCreateBranchRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "branch-create", request }).request;
    return this.worktreeMutation("branch", normalized, signal, (context) => this.adapter.createBranch(normalized, context));
  }

  switchBranch(request: GitSwitchBranchRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "branch-switch", request }).request;
    return this.worktreeMutation("branch", normalized, signal, (context) => this.adapter.switchBranch(normalized, context));
  }

  createWorktree(request: GitCreateWorktreeRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "worktree-create", request }).request;
    return this.repositoryMutation("worktree", normalized.repositoryId, signal, (context) => this.adapter.createWorktree(normalized, context));
  }

  removeWorktree(request: GitRemoveWorktreeRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "worktree-remove", request }).request;
    return this.repositoryMutation("worktree", normalized.repositoryId, signal, (context) => this.adapter.removeWorktree(normalized, context));
  }

  clone(request: GitCloneRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "clone", request }).request;
    return this.repositoryMutation("clone", normalized.repositoryId, signal, (context) => this.adapter.clone(normalized, context));
  }

  importSnapshot(request: GitSnapshotImportRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    return this.repositoryMutation("snapshot-import", request.repositoryId, signal, (context) => this.adapter.importSnapshot(request, context));
  }

  fetch(request: GitFetchRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "fetch", request }).request;
    return this.repositoryMutation("fetch", normalized.repositoryId, signal, (context) => this.adapter.fetch(normalized, context));
  }

  push(request: GitPushRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "push", request }).request;
    return this.repositoryMutation("push", normalized.repositoryId, signal, (context) => this.adapter.push(normalized, context));
  }

  private worktreeMutation(
    capability: GitCapability,
    request: Readonly<{ repositoryId: string; worktreeId: string }>,
    signal: AbortSignal,
    execute: (context: GitOperationContext) => Promise<GitMutationResult>,
  ): Promise<GitMutationResult> {
    return this.mutate(capability, `${request.repositoryId}/${request.worktreeId}`, request.repositoryId, signal, execute);
  }

  private worktreeStateMutation<T extends Readonly<{ repositoryId: string; worktreeId: string }>>(
    request: T,
    signal: AbortSignal,
    execute: (context: GitOperationContext) => Promise<GitWorktreeSnapshot>,
  ): Promise<GitWorktreeSnapshot> {
    return this.mutate("status", `${request.repositoryId}/${request.worktreeId}`, request.repositoryId, signal, execute);
  }

  private repositoryMutation(
    capability: GitCapability,
    repositoryId: string,
    signal: AbortSignal,
    execute: (context: GitOperationContext) => Promise<GitMutationResult>,
  ): Promise<GitMutationResult> {
    return this.mutate(capability, repositoryId, repositoryId, signal, execute);
  }

  private async mutate<T>(
    capability: GitCapability,
    scope: string,
    repositoryId: string,
    signal: AbortSignal,
    execute: (context: GitOperationContext) => Promise<T>,
  ): Promise<T> {
    this.require(capability);
    assertNotAborted(signal);
    if (this.conflicts(scope, repositoryId)) throw new GitConcurrencyError();
    this.mutations.add(scope);
    try {
      return cloneAndFreeze(await execute({ signal }));
    } finally {
      this.mutations.delete(scope);
    }
  }

  private conflicts(scope: string, repositoryId: string): boolean {
    if (this.mutations.has(repositoryId)) return true;
    if (scope === repositoryId) {
      for (const active of this.mutations) if (active.startsWith(`${repositoryId}/`)) return true;
    }
    return this.mutations.has(scope);
  }

  private require(capability: GitCapability): void {
    const state = this.capabilities.features[capability];
    if (!state.available) throw new GitCapabilityError(capability, state.reason ?? "the adapter did not provide it");
  }
}

function validateCapabilities(capabilities: BrowserGitAdapter["capabilities"]): void {
  validateGitIdentifier(capabilities.adapterId, "Git adapter ID");
  for (const feature of GIT_CAPABILITIES) {
    const state = capabilities.features[feature];
    if (!state) throw new Error(`Git adapter omitted capability ${feature}.`);
    if (!state.available && !state.reason?.trim()) throw new Error(`Unavailable Git capability ${feature} must explain why.`);
  }
  if (capabilities.remote.transport === "none" && (capabilities.features.clone.available || capabilities.features.fetch.available || capabilities.features.push.available)) {
    throw new Error("A Git adapter cannot advertise remote operations without a remote transport.");
  }
}

export function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
