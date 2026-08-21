import { isLocalFolderMountPath, normalizeWorkspacePath } from "../workspace/contracts";
import type { GitRepositorySnapshot, GitWorktreeSnapshot } from "./types";

export type GitWorkspaceBinding = Readonly<{
  repository: GitRepositorySnapshot;
  worktree: GitWorktreeSnapshot;
  root: string;
  relativePath: string;
}>;

export function resolveGitWorkspaceBinding(path: string, repositories: readonly GitRepositorySnapshot[]): GitWorkspaceBinding | undefined {
  const normalized = normalizeWorkspacePath(path);
  /*
   * A folder the person attached from their own device is inside no Airship
   * worktree, even though it is inside `/workspace`.
   *
   * The root repository's worktree is `/workspace` itself, so without this every
   * write into an attached folder would also be written into Airship's Git
   * object database — the same bytes, copied into the Vault, from a tier whose
   * whole promise is that the folder is never copied anywhere. Their Git is
   * their own; Airship's browser Git manages the workspace it created.
   */
  if (isLocalFolderMountPath(normalized)) return undefined;
  const candidates = repositories
    .flatMap((repository) => repository.worktrees.map((worktree) => ({ repository, worktree, root: gitWorktreeWorkspaceRoot(repository, worktree) })))
    .filter(({ root }) => normalized === root || normalized.startsWith(`${root}/`))
    .sort((left, right) => right.root.length - left.root.length);
  const candidate = candidates[0];
  if (!candidate || normalized === candidate.root) return undefined;
  return Object.freeze({ ...candidate, relativePath: normalized.slice(candidate.root.length + 1) });
}

export function gitWorktreeWorkspaceRoot(repository: GitRepositorySnapshot, worktree: GitWorktreeSnapshot): string {
  if (worktree.path === "/workspace" || worktree.path.startsWith("/workspace/")) return worktree.path;
  return repository.id === "airship-workspace" ? "/workspace" : `/workspace/sources/${repository.name.split("/").at(-1) ?? repository.id}`;
}
