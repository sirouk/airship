import { describe, expect, it } from "vitest";
import { LOCAL_FOLDER_MOUNT_ROOT } from "../workspace/contracts";
import type { GitRepositorySnapshot } from "./types";
import { resolveGitWorkspaceBinding } from "./workspace-binding";

const repositories: readonly GitRepositorySnapshot[] = Object.freeze([
  Object.freeze({
    id: "airship-workspace",
    name: "Airship Workspace",
    worktrees: Object.freeze([
      Object.freeze({ id: "main", path: "/workspace", branch: "main", head: "abc", version: 1 }),
    ]),
  }),
] as unknown as readonly GitRepositorySnapshot[]);

describe("resolveGitWorkspaceBinding", () => {
  it("binds an ordinary workspace file to the root worktree", () => {
    expect(resolveGitWorkspaceBinding("/workspace/README.md", repositories)?.relativePath).toBe("README.md");
  });

  /*
   * The whole promise of the attached-folder tier: a write into the person's
   * own directory is never mirrored into Airship's Git object database, which
   * lives in the Vault. Without this the root worktree — `/workspace` — would
   * claim every mounted path.
   */
  it("binds nothing inside an attached local folder", () => {
    expect(resolveGitWorkspaceBinding(`${LOCAL_FOLDER_MOUNT_ROOT}/airship/src/main.ts`, repositories)).toBeUndefined();
    expect(resolveGitWorkspaceBinding(LOCAL_FOLDER_MOUNT_ROOT, repositories)).toBeUndefined();
  });
});
