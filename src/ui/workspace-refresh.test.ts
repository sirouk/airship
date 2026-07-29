import { describe, expect, it } from "vitest";
import type { WorkspaceEntry, WorkspaceFile, WorkspacePort } from "../workspace/contracts";
import { WorkspaceRefreshCoordinator } from "./workspace-refresh";

class DeferredListWorkspace implements WorkspacePort {
  private resolveList?: (entries: WorkspaceEntry[]) => void;

  list(): Promise<WorkspaceEntry[]> {
    return new Promise((resolve) => { this.resolveList = resolve; });
  }

  resolve(entries: WorkspaceEntry[]): void {
    this.resolveList?.(entries);
  }

  async read(): Promise<WorkspaceFile | undefined> { return undefined; }
  async write(): Promise<WorkspaceFile> { throw new Error("not used"); }
  async remove(): Promise<void> { throw new Error("not used"); }
}

const entry = (path: string): WorkspaceEntry => ({
  path,
  revision: `revision:${path}`,
  updatedAt: "2026-07-28T00:00:00.000Z",
  size: 1,
});

describe("WorkspaceRefreshCoordinator", () => {
  it("discards a slow prior WorkspacePort after a newer authority publishes", async () => {
    const coordinator = new WorkspaceRefreshCoordinator();
    const oldWorkspace = new DeferredListWorkspace();
    const nextWorkspace = new DeferredListWorkspace();
    const oldAuthority = { workspace: oldWorkspace, workspaceId: "workspace-a", profileId: "general" };
    const nextAuthority = { workspace: nextWorkspace, workspaceId: "workspace-b", profileId: "research" };
    let current = oldAuthority;
    let visible: readonly WorkspaceEntry[] = [];

    const oldRefresh = coordinator.refresh(oldAuthority, () => current, (entries) => { visible = entries; });
    current = nextAuthority;
    const nextRefresh = coordinator.refresh(nextAuthority, () => current, (entries) => { visible = entries; });
    nextWorkspace.resolve([entry("/workspace/research.txt")]);
    await expect(nextRefresh).resolves.toBe(true);
    oldWorkspace.resolve([entry("/workspace/general.txt")]);
    await expect(oldRefresh).resolves.toBe(false);
    expect(visible.map((item) => item.path)).toEqual(["/workspace/research.txt"]);
  });

  it("requires the exact profile and workspace identity even without a newer read", async () => {
    const coordinator = new WorkspaceRefreshCoordinator();
    const workspace = new DeferredListWorkspace();
    const expected = { workspace, workspaceId: "workspace-a", profileId: "general" };
    let current = { ...expected, profileId: "research" };
    let published = false;

    const refresh = coordinator.refresh(expected, () => current, () => { published = true; });
    workspace.resolve([entry("/workspace/private.txt")]);
    await expect(refresh).resolves.toBe(false);
    expect(published).toBe(false);

    current = { ...expected, workspaceId: "workspace-b" };
    const second = coordinator.refresh(expected, () => current, () => { published = true; });
    workspace.resolve([entry("/workspace/private.txt")]);
    await expect(second).resolves.toBe(false);
    expect(published).toBe(false);
  });

  it("filters control-plane entries and explicit invalidation prevents publication", async () => {
    const coordinator = new WorkspaceRefreshCoordinator();
    const workspace = new DeferredListWorkspace();
    const authority = { workspace, workspaceId: "workspace-a", profileId: "general" };
    let visible: readonly WorkspaceEntry[] = [];
    const refresh = coordinator.refresh(authority, () => authority, (entries) => { visible = entries; });
    coordinator.invalidate();
    workspace.resolve([
      entry("/workspace/README.md"),
      entry("/workspace/.airship/private-checkpoint.json"),
    ]);
    await expect(refresh).resolves.toBe(false);
    expect(visible).toEqual([]);
  });
});
