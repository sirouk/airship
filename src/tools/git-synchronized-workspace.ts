import type { BrowserGitClient } from "../git/client";
import { resolveGitWorkspaceBinding } from "../git/workspace-binding";
import { isWorkspaceControlPlanePath, type WorkspaceEntry, type WorkspaceFile, type WorkspacePort } from "../workspace/contracts";

/**
 * Gives agent file tools the same Workspace↔Git mutation contract as the
 * visual workbench. Files outside a known worktree remain ordinary private
 * workspace files. Git failures trigger a version-fenced compensating write.
 */
export class GitSynchronizedWorkspace implements WorkspacePort {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly workspace: WorkspacePort, private readonly git: BrowserGitClient) {}

  read(path: string): Promise<WorkspaceFile | undefined> {
    return this.afterMutations(() => this.workspace.read(path));
  }
  readBounded(path: string, maxBytes: number): Promise<WorkspaceFile | undefined> {
    return this.afterMutations(() =>
      this.workspace.readBounded ? this.workspace.readBounded(path, maxBytes) : this.workspace.read(path),
    );
  }
  list(path?: string): Promise<WorkspaceEntry[]> {
    return this.afterMutations(() => this.workspace.list(path));
  }

  write(path: string, content: string, options?: { expectedRevision?: string | null }): Promise<WorkspaceFile> {
    return this.enqueueMutation(() => this.writeCommitted(path, content, options));
  }

  private async writeCommitted(path: string, content: string, options?: { expectedRevision?: string | null }): Promise<WorkspaceFile> {
    const [previous, repositories] = await Promise.all([this.workspace.read(path), this.git.listRepositories()]);
    const binding = isWorkspaceControlPlanePath(path) ? undefined : resolveGitWorkspaceBinding(path, repositories);
    const written = await this.workspace.write(path, content, options);
    if (!binding) return written;
    try {
      await this.git.writeWorkingFile({
        repositoryId: binding.repository.id,
        worktreeId: binding.worktree.id,
        path: binding.relativePath,
        content,
        expectedWorktreeVersion: binding.worktree.version,
      });
      return written;
    } catch (caught) {
      if (previous) await this.workspace.write(path, previous.content, { expectedRevision: written.revision });
      else await this.workspace.remove(path, { expectedRevision: written.revision });
      throw caught;
    }
  }

  remove(path: string, options?: { expectedRevision?: string }): Promise<void> {
    return this.enqueueMutation(() => this.removeCommitted(path, options));
  }

  private async removeCommitted(path: string, options?: { expectedRevision?: string }): Promise<void> {
    const [previous, repositories] = await Promise.all([this.workspace.read(path), this.git.listRepositories()]);
    if (!previous) return this.workspace.remove(path, options);
    const binding = isWorkspaceControlPlanePath(path) ? undefined : resolveGitWorkspaceBinding(path, repositories);
    await this.workspace.remove(path, options);
    if (!binding) return;
    try {
      await this.git.removeWorkingFile({
        repositoryId: binding.repository.id,
        worktreeId: binding.worktree.id,
        path: binding.relativePath,
        expectedWorktreeVersion: binding.worktree.version,
      });
    } catch (caught) {
      await this.workspace.write(path, previous.content, { expectedRevision: null });
      throw caught;
    }
  }

  private afterMutations<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutationTail.then(operation, operation);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
