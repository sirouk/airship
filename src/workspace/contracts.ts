export type WorkspaceFile = {
  path: string;
  content: string;
  revision: string;
  updatedAt: string;
  size: number;
};

export type WorkspaceEntry = Omit<WorkspaceFile, "content">;

export interface WorkspacePort {
  read(path: string): Promise<WorkspaceFile | undefined>;
  /** Optional bounded display read. Returned `size` remains the full object size. */
  readBounded?(path: string, maxBytes: number): Promise<WorkspaceFile | undefined>;
  list(path?: string): Promise<WorkspaceEntry[]>;
  write(
    path: string,
    content: string,
    options?: { expectedRevision?: string | null },
  ): Promise<WorkspaceFile>;
  remove(path: string, options?: { expectedRevision?: string }): Promise<void>;
}

/**
 * A workspace whose implementation encrypts bytes on the client before they
 * cross its persistence boundary. Consumers that store private control-plane
 * state can require this marker instead of silently trusting an arbitrary
 * WorkspacePort (for example IndexedDB or a host filesystem adapter).
 */
export interface ClientEncryptedWorkspacePort extends WorkspacePort {
  readonly encryptionBoundary: "airship-client-envelope-v1";
}

export class WorkspaceConflictError extends Error {
  constructor(message = "The workspace file changed before this operation completed.") {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

export function normalizeWorkspacePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\\") || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error("Workspace paths must be non-empty UTF-8 paths without control characters or backslashes.");
  }
  const rooted = trimmed.startsWith("/") ? trimmed : `/workspace/${trimmed}`;
  const parts = rooted.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new Error("Workspace paths cannot contain . or ..");
  const normalized = `/${parts.join("/")}`;
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) {
    throw new Error("Workspace paths must stay inside /workspace.");
  }
  return normalized;
}

/** Private implementation records that must never enter model retrieval. */
export function isWorkspaceControlPlanePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return isGitWorkspaceControlPlanePath(normalized)
    || isBrowserGitControlPlanePath(normalized)
    || normalized === "/workspace/.airship/memory.json"
    || normalized === "/workspace/.airship/context" || normalized.startsWith("/workspace/.airship/context/")
    || normalized === "/workspace/.airship/terminal" || normalized.startsWith("/workspace/.airship/terminal/");
}

export function isGitWorkspaceControlPlanePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return isLegacyGitCheckpointPath(normalized)
    || normalized.split("/").some((segment) => segment === ".git");
}

/** Old parallel Git checkpoint path; unlike real repository `.git`, do not migrate it as workspace state. */
export function isLegacyGitCheckpointPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized === "/workspace/.airship/git" || normalized.startsWith("/workspace/.airship/git/");
}

/**
 * Real browser Git metadata is part of the authoritative virtual filesystem,
 * but must never enter the editor tree, terminal snapshots, or model context.
 *
 * Keep the browser-native predicate explicit even though
 * `isGitWorkspaceControlPlanePath` is the broader retrieval/UI filter. Storage
 * migration skips only `isLegacyGitCheckpointPath`; genuine worktree `.git`
 * directories and the repository catalog migrate with the workspace so
 * Editor, Terminal, and Source Control continue to observe one repository
 * after a Vault transition.
 */
export function isBrowserGitControlPlanePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized === "/workspace/.airship/browser-git-repositories.v1.json"
    || normalized.includes("/.git/")
    || normalized.endsWith("/.git");
}
