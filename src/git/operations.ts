import type { JsonValue } from "../core/contracts";
import { GitValidationError } from "./errors";
import type { GitOperation, GitOperationDescriptor, GitStashRequest } from "./types";
import {
  GIT_LIMITS,
  validateAuthor,
  validateBoundedCount,
  validateBranchName,
  validateCommitMessage,
  validateEntryIndex,
  validateGitIdentifier,
  validateGitDestination,
  validateGitPath,
  validatePathList,
  validateRemoteUrl,
  validateRepositoryName,
  validateRevision,
  validateTagMessage,
  validateTagName,
  validateVersion,
} from "./validation";

/** Depth of a `log` request that does not name one. Bounded by GIT_LIMITS.maxLogDepth. */
const DEFAULT_LOG_DEPTH = 50;
const STASH_OPS = ["push", "apply", "pop", "drop", "clear"] as const;
const RESET_MODES = ["soft", "mixed", "hard"] as const;

/** The generic facade preserves the exact request member at call sites. */
export function normalizeGitOperation<T extends GitOperation>(operation: T): T;
export function normalizeGitOperation(operation: GitOperation): GitOperation {
  switch (operation.kind) {
    case "status":
      return frozen(operation.kind, worktreeTarget(operation.request));
    case "diff":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        path: validateGitPath(operation.request.path),
        scope: operation.request.scope === "staged" || operation.request.scope === "worktree"
          ? operation.request.scope
          : invalid("Diff scope is invalid."),
      });
    // One reviewed stage request may legitimately cover a freshly imported
    // repository. The client fans it out over per-adapter-call chunks that stay
    // inside GIT_LIMITS.maxPathsPerOperation.
    case "stage":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        paths: validatePathList(operation.request.paths, GIT_LIMITS.maxPathsPerRequest),
        expectedWorktreeVersion: validateVersion(operation.request.expectedWorktreeVersion),
        force: operation.request.force === true,
      });
    case "unstage":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        paths: validatePathList(operation.request.paths, GIT_LIMITS.maxPathsPerRequest),
        expectedWorktreeVersion: validateVersion(operation.request.expectedWorktreeVersion),
      });
    case "commit":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        message: validateCommitMessage(operation.request.message),
        author: validateAuthor(operation.request.author),
        expectedWorktreeVersion: validateVersion(operation.request.expectedWorktreeVersion),
      });
    case "branch-create":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        name: validateBranchName(operation.request.name),
        ...(operation.request.startPoint ? { startPoint: validateRevision(operation.request.startPoint) } : {}),
        checkout: operation.request.checkout === true,
        expectedWorktreeVersion: validateVersion(operation.request.expectedWorktreeVersion),
      });
    case "branch-switch":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        name: validateBranchName(operation.request.name),
        expectedWorktreeVersion: validateVersion(operation.request.expectedWorktreeVersion),
      });
    case "worktree-create":
      return frozen(operation.kind, {
        repositoryId: validateGitIdentifier(operation.request.repositoryId, "Repository ID"),
        worktreeId: validateGitIdentifier(operation.request.worktreeId, "Worktree ID"),
        path: validateGitDestination(operation.request.path),
        branch: validateBranchName(operation.request.branch),
        expectedRepositoryVersion: validateVersion(operation.request.expectedRepositoryVersion),
      });
    case "worktree-remove":
      return frozen(operation.kind, {
        repositoryId: validateGitIdentifier(operation.request.repositoryId, "Repository ID"),
        worktreeId: validateGitIdentifier(operation.request.worktreeId, "Worktree ID"),
        expectedRepositoryVersion: validateVersion(operation.request.expectedRepositoryVersion),
      });
    case "clone":
      return frozen(operation.kind, {
        repositoryId: validateGitIdentifier(operation.request.repositoryId, "Repository ID"),
        name: validateRepositoryName(operation.request.name),
        remoteUrl: validateRemoteUrl(operation.request.remoteUrl),
        remoteName: validateGitIdentifier(operation.request.remoteName ?? "origin", "Remote name"),
        ...(operation.request.defaultBranch ? { defaultBranch: validateBranchName(operation.request.defaultBranch) } : {}),
        destination: validateGitDestination(operation.request.destination),
      });
    case "fetch":
      return frozen(operation.kind, {
        repositoryId: validateGitIdentifier(operation.request.repositoryId, "Repository ID"),
        remote: validateGitIdentifier(operation.request.remote, "Remote name"),
        expectedRepositoryVersion: validateVersion(operation.request.expectedRepositoryVersion),
        prune: operation.request.prune === true,
      });
    case "push":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        remote: validateGitIdentifier(operation.request.remote, "Remote name"),
        branch: validateBranchName(operation.request.branch),
        expectedWorktreeVersion: validateVersion(operation.request.expectedWorktreeVersion),
        force: operation.request.force === true,
      });
    case "log":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        ...(operation.request.ref ? { ref: validateRevision(operation.request.ref) } : {}),
        depth: validateBoundedCount(operation.request.depth, "Log depth", GIT_LIMITS.maxLogDepth, DEFAULT_LOG_DEPTH),
        ...(operation.request.path ? { path: validateGitPath(operation.request.path) } : {}),
        follow: operation.request.follow === true,
      });
    case "show":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        revision: validateRevision(operation.request.revision),
        maxPaths: validateBoundedCount(operation.request.maxPaths, "Patch path count", GIT_LIMITS.maxCommitPatchPaths, GIT_LIMITS.maxCommitPatchPaths),
      });
    case "tag-create":
      return frozen(operation.kind, {
        repositoryId: validateGitIdentifier(operation.request.repositoryId, "Repository ID"),
        name: validateTagName(operation.request.name),
        ...(operation.request.ref ? { ref: validateRevision(operation.request.ref) } : {}),
        ...(operation.request.message === undefined ? {} : { message: validateTagMessage(operation.request.message) }),
        ...(operation.request.author ? { author: validateAuthor(operation.request.author) } : {}),
        force: operation.request.force === true,
        expectedRepositoryVersion: validateVersion(operation.request.expectedRepositoryVersion),
      });
    case "tag-delete":
      return frozen(operation.kind, {
        repositoryId: validateGitIdentifier(operation.request.repositoryId, "Repository ID"),
        name: validateTagName(operation.request.name),
        expectedRepositoryVersion: validateVersion(operation.request.expectedRepositoryVersion),
      });
    case "stash":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        op: STASH_OPS.includes(operation.request.op) ? operation.request.op : invalid("Stash operation is invalid."),
        ...(operation.request.message === undefined ? {} : { message: validateCommitMessage(operation.request.message) }),
        index: validateEntryIndex(operation.request.index, "Stash entry index", GIT_LIMITS.maxStashEntries),
        author: validateAuthor(operation.request.author),
        expectedWorktreeVersion: validateVersion(operation.request.expectedWorktreeVersion),
      });
    case "merge":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        theirs: validateRevision(operation.request.theirs),
        fastForwardOnly: operation.request.fastForwardOnly === true,
        ...(operation.request.message === undefined ? {} : { message: validateCommitMessage(operation.request.message) }),
        author: validateAuthor(operation.request.author),
        expectedWorktreeVersion: validateVersion(operation.request.expectedWorktreeVersion),
      });
    case "restore":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        paths: validatePathList(operation.request.paths, GIT_LIMITS.maxPathsPerRequest),
        source: operation.request.source === "head" || operation.request.source === "stage"
          ? operation.request.source
          : invalid("Restore source must be stage or head."),
        expectedWorktreeVersion: validateVersion(operation.request.expectedWorktreeVersion),
      });
    case "reset":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        mode: RESET_MODES.includes(operation.request.mode) ? operation.request.mode : invalid("Reset mode must be soft, mixed, or hard."),
        ref: validateRevision(operation.request.ref),
        expectedWorktreeVersion: validateVersion(operation.request.expectedWorktreeVersion),
      });
    case "remote-add":
    case "remote-set-url":
      return frozen(operation.kind, {
        repositoryId: validateGitIdentifier(operation.request.repositoryId, "Repository ID"),
        name: validateGitIdentifier(operation.request.name, "Remote name"),
        url: validateRemoteUrl(operation.request.url),
        expectedRepositoryVersion: validateVersion(operation.request.expectedRepositoryVersion),
      });
    case "remote-remove":
      return frozen(operation.kind, {
        repositoryId: validateGitIdentifier(operation.request.repositoryId, "Repository ID"),
        name: validateGitIdentifier(operation.request.name, "Remote name"),
        expectedRepositoryVersion: validateVersion(operation.request.expectedRepositoryVersion),
      });
  }
}

export function describeGitOperation(input: GitOperation): GitOperationDescriptor {
  const operation = normalizeGitOperation(input);
  switch (operation.kind) {
    case "status":
      return descriptor(operation.kind, "read", "observe", false, "Inspect worktree status", resource(operation.request), false, operation.request);
    case "diff":
      return descriptor(operation.kind, "read", "observe", false, `Inspect ${operation.request.scope} diff for ${operation.request.path}`, resource(operation.request), false, operation.request);
    case "stage":
      return descriptor(operation.kind, "write", "change-local", true, `Stage ${operation.request.paths.length} path(s)${operation.request.force ? ", forcing ignored paths" : ""}`, resource(operation.request), false, operation.request);
    case "unstage":
      return descriptor(operation.kind, "write", "change-local", true, `Unstage ${operation.request.paths.length} path(s)`, resource(operation.request), false, operation.request);
    case "commit":
      return descriptor(operation.kind, "write", "change-local", true, `Commit staged changes as ${operation.request.author.name}`, resource(operation.request), false, operation.request);
    case "branch-create":
      return descriptor(operation.kind, "write", "change-local", true, `Create branch ${operation.request.name}`, resource(operation.request), false, operation.request);
    case "branch-switch":
      return descriptor(operation.kind, "write", "change-local", true, `Switch to branch ${operation.request.name}`, resource(operation.request), false, operation.request);
    case "worktree-create":
      return descriptor(operation.kind, "write", "change-local", true, `Create worktree ${operation.request.worktreeId}`, resource(operation.request), false, operation.request);
    case "worktree-remove":
      return descriptor(operation.kind, "write", "change-local", true, `Remove worktree ${operation.request.worktreeId}`, resource(operation.request), false, operation.request);
    case "clone":
      return descriptor(operation.kind, "network", "communicate", true, `Clone ${operation.request.remoteUrl}`, resource(operation.request), true, operation.request, operation.request.remoteUrl);
    case "fetch":
      return descriptor(operation.kind, "network", "communicate", true, `Fetch from ${operation.request.remote}`, resource(operation.request), true, operation.request, `remote:${operation.request.remote}`);
    case "push":
      return descriptor(operation.kind, "identity", "change-remote", true, `${operation.request.force ? "Force-push" : "Push"} ${operation.request.branch} to ${operation.request.remote}`, resource(operation.request), true, operation.request, `remote:${operation.request.remote}`);
    case "log":
      return descriptor(operation.kind, "read", "observe", false, `Read up to ${operation.request.depth} commits${operation.request.path ? ` touching ${operation.request.path}` : ""}`, resource(operation.request), false, operation.request);
    case "show":
      return descriptor(operation.kind, "read", "observe", false, `Read commit ${operation.request.revision}`, resource(operation.request), false, operation.request);
    case "tag-create":
      return descriptor(operation.kind, "write", "change-local", true, `${operation.request.message === undefined ? "Tag" : "Annotate"} ${operation.request.ref ?? "HEAD"} as ${operation.request.name}`, resource(operation.request), false, operation.request);
    case "tag-delete":
      return descriptor(operation.kind, "write", "change-local", true, `Delete tag ${operation.request.name}`, resource(operation.request), false, operation.request);
    case "stash":
      return descriptor(operation.kind, "write", "change-local", true, stashSummary(operation.request.op, operation.request.index ?? 0), resource(operation.request), false, operation.request);
    case "merge":
      return descriptor(operation.kind, "write", "change-local", true, `Merge ${operation.request.theirs}${operation.request.fastForwardOnly ? " (fast-forward only)" : ""}`, resource(operation.request), false, operation.request);
    case "restore":
      return descriptor(operation.kind, "write", "change-local", true, `Discard worktree changes in ${operation.request.paths.length} path(s) from ${operation.request.source === "head" ? "HEAD" : "the index"}`, resource(operation.request), false, operation.request);
    case "reset":
      return descriptor(operation.kind, "write", "change-local", true, `Reset --${operation.request.mode} to ${operation.request.ref}${operation.request.mode === "hard" ? " and discard worktree changes" : ""}`, resource(operation.request), false, operation.request);
    // Remote configuration writes .git/config and the repository registry. No
    // bytes leave the device, so this is a local change, not a communication.
    case "remote-add":
      return descriptor(operation.kind, "write", "change-local", true, `Add remote ${operation.request.name} -> ${operation.request.url}`, resource(operation.request), false, operation.request);
    case "remote-set-url":
      return descriptor(operation.kind, "write", "change-local", true, `Point remote ${operation.request.name} at ${operation.request.url}`, resource(operation.request), false, operation.request);
    case "remote-remove":
      return descriptor(operation.kind, "write", "change-local", true, `Remove remote ${operation.request.name}`, resource(operation.request), false, operation.request);
  }
}

function stashSummary(op: GitStashRequest["op"], index: number): string {
  if (op === "push") return "Stash worktree and index changes";
  if (op === "clear") return "Drop every stash entry";
  return `${op === "apply" ? "Apply" : op === "pop" ? "Pop" : "Drop"} stash entry ${index}`;
}

function worktreeTarget(request: Readonly<{ repositoryId: string; worktreeId: string }>) {
  return {
    repositoryId: validateGitIdentifier(request.repositoryId, "Repository ID"),
    worktreeId: validateGitIdentifier(request.worktreeId, "Worktree ID"),
  };
}

function resource(request: Readonly<{ repositoryId: string; worktreeId?: string }>): string {
  return `repository:${request.repositoryId}${request.worktreeId ? `/worktree:${request.worktreeId}` : ""}`;
}

function frozen(kind: GitOperation["kind"], request: object): GitOperation {
  return deepFreeze({ kind, request }) as GitOperation;
}

function descriptor(
  operation: GitOperation["kind"],
  brokerEffect: GitOperationDescriptor["brokerEffect"],
  risk: GitOperationDescriptor["risk"],
  approvalRequired: boolean,
  summary: string,
  resourceName: string,
  dataLeavesDevice: boolean,
  args: object,
  destination?: string,
): GitOperationDescriptor {
  return Object.freeze({
    operation,
    brokerEffect,
    risk,
    approvalRequired,
    summary,
    resource: resourceName,
    ...(destination ? { destination } : {}),
    dataLeavesDevice,
    arguments: deepFreeze(structuredClone(args)) as JsonValue,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(message: string): never {
  throw new GitValidationError(message);
}
