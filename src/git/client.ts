import { GitCapabilityError, GitConcurrencyError, GitDomainError, GitPartialMutationError } from "./errors";
import { normalizeGitOperation } from "./operations";
import type {
  BrowserGitAdapter,
  GitAddRemoteRequest,
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
  GitStatusRequest,
  GitWriteWorkingFileRequest,
  GitRemoveWorkingFileRequest,
  GitMoveWorkingFileRequest,
  GitSwitchBranchRequest,
  GitWorktreeSnapshot,
  GitCloneRequest,
  GitSnapshotImportRequest,
} from "./types";
import { GIT_CAPABILITIES, GIT_PRE_WRITE_FAILURE_CODES } from "./types";
import { GIT_LIMITS, asciiCompare, assertNotAborted, validateFileContent, validateGitIdentifier, validateGitPath, validateVersion } from "./validation";

const passiveSignal = new AbortController().signal;

/** The shape chunkedPathMutation needs: a bounded path set behind one optimistic fence. */
type ChunkablePathRequest = Readonly<{ paths: readonly string[]; expectedWorktreeVersion: string }>;

/**
 * Codes a chunkable adapter operation can only raise from its pre-flight —
 * resolving the target, checking the optimistic fence, and admitting every
 * requested path — all of which `BrowserGitAdapter` requires stage, unstage,
 * and restore to complete before their first write. Any other failure may have
 * left part of a chunk applied, so it stays wrapped.
 */
const PRE_WRITE_FAILURE_CODES: ReadonlySet<string> = new Set(GIT_PRE_WRITE_FAILURE_CODES);

function isPreWriteFailure(error: unknown): boolean {
  return error instanceof GitDomainError && PRE_WRITE_FAILURE_CODES.has(error.code);
}

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
    return this.worktreeMutation("stage", normalized, signal, (context) =>
      this.chunkedPathMutation("Stage", normalized, context, (chunk, inner) => this.adapter.stage(chunk, inner)));
  }

  unstage(request: GitStageRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "unstage", request }).request;
    return this.worktreeMutation("stage", normalized, signal, (context) =>
      this.chunkedPathMutation("Unstage", normalized, context, (chunk, inner) => this.adapter.unstage(chunk, inner)));
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

  async log(request: GitLogRequest, signal: AbortSignal = passiveSignal): Promise<readonly GitCommitSummary[]> {
    this.require("history");
    const normalized = normalizeGitOperation({ kind: "log", request }).request;
    assertNotAborted(signal);
    return cloneAndFreeze(await this.adapter.log(normalized, { signal }));
  }

  async show(request: GitShowRequest, signal: AbortSignal = passiveSignal): Promise<GitCommitDetail> {
    this.require("history");
    const normalized = normalizeGitOperation({ kind: "show", request }).request;
    assertNotAborted(signal);
    return cloneAndFreeze(await this.adapter.show(normalized, { signal }));
  }

  async listTags(repositoryId: string, signal: AbortSignal = passiveSignal): Promise<readonly GitTagSummary[]> {
    this.require("tag");
    assertNotAborted(signal);
    return cloneAndFreeze(await this.adapter.listTags(validateGitIdentifier(repositoryId, "Repository ID"), { signal }));
  }

  createTag(request: GitCreateTagRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "tag-create", request }).request;
    return this.repositoryMutation("tag", normalized.repositoryId, signal, (context) => this.adapter.createTag(normalized, context));
  }

  deleteTag(request: GitDeleteTagRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "tag-delete", request }).request;
    return this.repositoryMutation("tag", normalized.repositoryId, signal, (context) => this.adapter.deleteTag(normalized, context));
  }

  async listStash(request: GitStatusRequest, signal: AbortSignal = passiveSignal): Promise<readonly GitStashEntry[]> {
    this.require("stash");
    const normalized = normalizeGitOperation({ kind: "status", request }).request;
    assertNotAborted(signal);
    return cloneAndFreeze(await this.adapter.listStash(normalized, { signal }));
  }

  stash(request: GitStashRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "stash", request }).request;
    return this.worktreeMutation("stash", normalized, signal, (context) => this.adapter.stash(normalized, context));
  }

  merge(request: GitMergeRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "merge", request }).request;
    return this.worktreeMutation("merge", normalized, signal, (context) => this.adapter.merge(normalized, context));
  }

  restore(request: GitRestoreRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "restore", request }).request;
    return this.worktreeMutation("restore", normalized, signal, (context) =>
      this.chunkedPathMutation("Restore", normalized, context, (chunk, inner) => this.adapter.restore(chunk, inner)));
  }

  reset(request: GitResetRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "reset", request }).request;
    return this.worktreeMutation("restore", normalized, signal, (context) => this.adapter.reset(normalized, context));
  }

  addRemote(request: GitAddRemoteRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "remote-add", request }).request;
    return this.repositoryMutation("remote-config", normalized.repositoryId, signal, (context) => this.adapter.addRemote(normalized, context));
  }

  setRemoteUrl(request: GitSetRemoteUrlRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "remote-set-url", request }).request;
    return this.repositoryMutation("remote-config", normalized.repositoryId, signal, (context) => this.adapter.setRemoteUrl(normalized, context));
  }

  removeRemote(request: GitRemoveRemoteRequest, signal: AbortSignal = passiveSignal): Promise<GitMutationResult> {
    const normalized = normalizeGitOperation({ kind: "remote-remove", request }).request;
    return this.repositoryMutation("remote-config", normalized.repositoryId, signal, (context) => this.adapter.removeRemote(normalized, context));
  }

  /**
   * A reviewed stage/unstage/restore request may cover more paths than one
   * adapter call is allowed to carry. Execute it as sequential bounded chunks
   * inside the one mutation scope, chaining each chunk's issued worktree version
   * so a foreign write between chunks still fails the fence instead of silently
   * interleaving.
   */
  private async chunkedPathMutation<T extends ChunkablePathRequest>(
    label: string,
    request: T,
    context: GitOperationContext,
    execute: (chunk: T, context: GitOperationContext) => Promise<GitMutationResult>,
  ): Promise<GitMutationResult> {
    if (request.paths.length <= GIT_LIMITS.maxPathsPerOperation) return execute(request, context);
    const changedPaths: string[] = [];
    let expectedWorktreeVersion = request.expectedWorktreeVersion;
    let last: GitMutationResult | undefined;
    for (let offset = 0; offset < request.paths.length; offset += GIT_LIMITS.maxPathsPerOperation) {
      const paths = request.paths.slice(offset, offset + GIT_LIMITS.maxPathsPerOperation);
      try {
        last = await execute({ ...request, paths, expectedWorktreeVersion }, context);
      } catch (error) {
        // Nothing has been written yet and the adapter raised this from its
        // pre-flight, so calling it a partial mutation would both invent a
        // half-applied change and hide the code callers dispatch on: a failed
        // fence must stay 'version-conflict', a refused path 'path-not-tracked'.
        if (!changedPaths.length && isPreWriteFailure(error)) throw error;
        throw new GitPartialMutationError(label, changedPaths.length, request.paths.length, error);
      }
      changedPaths.push(...last.changedPaths);
      if (!last.worktree?.version) {
        throw new GitDomainError(
          "chunked-mutation-unfenced",
          `${label} completed ${changedPaths.length} of ${request.paths.length} paths, but the adapter returned no worktree version to fence the next chunk with.`,
        );
      }
      expectedWorktreeVersion = last.worktree.version;
    }
    return { ...last!, changedPaths: [...new Set(changedPaths)].sort(asciiCompare) };
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
