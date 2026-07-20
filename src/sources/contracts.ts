export type SourceChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export type SourceChange = {
  path: string;
  status: SourceChangeStatus;
  staged: boolean;
  additions?: number;
  deletions?: number;
};

export type WorktreeSummary = {
  id: string;
  path: string;
  branch: string;
  head: string;
  changes: SourceChange[];
};

export type RepositorySummary = {
  id: string;
  name: string;
  remote?: string;
  defaultBranch: string;
  worktrees: WorktreeSummary[];
  lastSyncedAt?: string;
};

export interface SourceControlPort {
  listRepositories(): Promise<RepositorySummary[]>;
  status(repositoryId: string, worktreeId: string): Promise<SourceChange[]>;
  diff(repositoryId: string, worktreeId: string, path: string, staged: boolean): Promise<string>;
  stage(repositoryId: string, worktreeId: string, paths: string[]): Promise<void>;
  unstage(repositoryId: string, worktreeId: string, paths: string[]): Promise<void>;
  commit(repositoryId: string, worktreeId: string, message: string): Promise<{ commit: string }>;
  createBranch(repositoryId: string, worktreeId: string, name: string, startPoint?: string): Promise<void>;
  fetch(repositoryId: string, signal: AbortSignal): Promise<void>;
  push(repositoryId: string, branch: string, signal: AbortSignal): Promise<void>;
}
