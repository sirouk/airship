export class GitDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitDomainError";
    this.code = code;
  }
}

export class GitValidationError extends GitDomainError {
  constructor(message: string) {
    super("validation", message);
    this.name = "GitValidationError";
  }
}

export class GitNotFoundError extends GitDomainError {
  constructor(resource: string) {
    super("not-found", `${resource} was not found.`);
    this.name = "GitNotFoundError";
  }
}

export class GitCapabilityError extends GitDomainError {
  readonly capability: string;

  constructor(capability: string, reason: string) {
    super("capability-unavailable", `${capability} is unavailable: ${reason}`);
    this.name = "GitCapabilityError";
    this.capability = capability;
  }
}

export class GitConcurrencyError extends GitDomainError {
  constructor(message = "Another Git operation is already mutating this repository scope.") {
    super("concurrent-operation", message);
    this.name = "GitConcurrencyError";
  }
}

export class GitVersionConflictError extends GitDomainError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super("version-conflict", "The worktree changed after this operation was reviewed. Refresh and review it again.");
    this.name = "GitVersionConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * A reviewed request that had to be executed as several adapter calls failed
 * partway through. The completed calls are durable, so the failure must never
 * be reported as a rollback.
 */
export class GitPartialMutationError extends GitDomainError {
  readonly completedPaths: number;
  readonly requestedPaths: number;

  constructor(operation: string, completedPaths: number, requestedPaths: number, cause: unknown) {
    super(
      "partial-mutation",
      `${operation} completed for ${completedPaths} of ${requestedPaths} reviewed paths before failing. Those ${completedPaths} paths are already changed and were not rolled back. ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 1_200),
    );
    this.name = "GitPartialMutationError";
    this.completedPaths = completedPaths;
    this.requestedPaths = requestedPaths;
    this.cause = cause;
  }
}

export class GitAbortError extends GitDomainError {
  constructor() {
    super("aborted", "The Git operation was aborted before its commit point.");
    this.name = "AbortError";
  }
}

export class GitCheckpointConflictError extends GitDomainError {
  constructor() {
    super(
      "checkpoint-conflict",
      "Durable Git state changed in another client before this operation committed. Refresh and review it again.",
    );
    this.name = "GitCheckpointConflictError";
  }
}
