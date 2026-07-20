import type { JsonValue } from "../core/contracts";
import { GitValidationError } from "./errors";
import type { GitOperation, GitOperationDescriptor } from "./types";
import {
  validateAuthor,
  validateBranchName,
  validateCommitMessage,
  validateGitIdentifier,
  validateGitPath,
  validatePathList,
  validateRemoteUrl,
  validateRepositoryName,
  validateVersion,
} from "./validation";

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
    case "stage":
    case "unstage":
      return frozen(operation.kind, {
        ...worktreeTarget(operation.request),
        paths: validatePathList(operation.request.paths),
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
        ...(operation.request.startPoint ? { startPoint: validateRevisionish(operation.request.startPoint) } : {}),
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
        path: validateGitIdentifier(operation.request.path, "Virtual worktree path"),
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
        destination: validateGitIdentifier(operation.request.destination, "Virtual destination"),
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
      return descriptor(operation.kind, "write", "change-local", true, `Stage ${operation.request.paths.length} path(s)`, resource(operation.request), false, operation.request);
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
  }
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

function validateRevisionish(value: string): string {
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[A-Za-z0-9_-]{32,})$/u.test(value)) return value;
  return validateBranchName(value);
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

