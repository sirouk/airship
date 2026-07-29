import {
  isWorkspaceControlPlanePath,
  type WorkspaceEntry,
  type WorkspacePort,
} from "../workspace/contracts";

export type WorkspaceRefreshAuthority = Readonly<{
  workspace: WorkspacePort;
  workspaceId: string;
  profileId: string;
}>;

/**
 * Serializes Workspace list publication against the complete presentation
 * authority. A slow read from a prior WorkspacePort, workspace identity, or
 * Profile may finish, but it can never publish beneath the new cockpit.
 */
export class WorkspaceRefreshCoordinator {
  private generation = 0;

  invalidate(): void {
    this.generation += 1;
  }

  async refresh(
    expected: WorkspaceRefreshAuthority,
    current: () => WorkspaceRefreshAuthority | undefined,
    publish: (entries: readonly WorkspaceEntry[]) => void,
  ): Promise<boolean> {
    const generation = ++this.generation;
    const entries = (await expected.workspace.list())
      .filter((entry) => !isWorkspaceControlPlanePath(entry.path));
    if (generation !== this.generation || !sameWorkspaceRefreshAuthority(expected, current())) {
      return false;
    }
    publish(Object.freeze(entries.slice()));
    return true;
  }
}

export function sameWorkspaceRefreshAuthority(
  expected: WorkspaceRefreshAuthority,
  current: WorkspaceRefreshAuthority | undefined,
): boolean {
  return Boolean(
    current
    && current.workspace === expected.workspace
    && current.workspaceId === expected.workspaceId
    && current.profileId === expected.profileId,
  );
}
