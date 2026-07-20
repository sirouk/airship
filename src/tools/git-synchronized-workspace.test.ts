import { describe, expect, it } from "vitest";
import { BrowserGitClient } from "../git/client";
import { MemoryGitAdapter } from "../git/memory-adapter";
import { MemoryWorkspace } from "../workspace/memory";
import { GitSynchronizedWorkspace } from "./git-synchronized-workspace";

async function fixture() {
  const base = new MemoryWorkspace();
  const initial = await base.write("/workspace/sources/repo/README.md", "before\n", { expectedRevision: null });
  const git = new BrowserGitClient(await MemoryGitAdapter.create([{
    id: "repo",
    name: "owner/repo",
    worktreePath: "/workspace/sources/repo",
    files: { "README.md": "before\n" },
  }]));
  return { base, initial, git, workspace: new GitSynchronizedWorkspace(base, git) };
}

describe("agent Workspace↔Git synchronization", () => {
  it("surfaces an agent write immediately as the exact unstaged Git diff", async () => {
    const { git, initial, workspace } = await fixture();
    await workspace.write("/workspace/sources/repo/README.md", "after\n", { expectedRevision: initial.revision });
    const [repository] = await git.listRepositories();
    const worktree = repository!.worktrees[0]!;

    expect(worktree.status).toEqual([expect.objectContaining({ path: "README.md", worktree: { kind: "modified" } })]);
    await expect(git.diff({ repositoryId: repository!.id, worktreeId: worktree.id, path: "README.md", scope: "worktree" }))
      .resolves.toMatchObject({ patch: expect.stringContaining("+after") });
  });

  it("surfaces an agent removal in Git while leaving private non-repository files alone", async () => {
    const { base, git, initial, workspace } = await fixture();
    const note = await workspace.write("/workspace/notes/private.md", "private\n", { expectedRevision: null });
    await workspace.remove("/workspace/sources/repo/README.md", { expectedRevision: initial.revision });
    const [repository] = await git.listRepositories();

    expect(repository!.worktrees[0]!.status).toEqual([expect.objectContaining({ path: "README.md", worktree: { kind: "deleted" } })]);
    expect(await base.read(note.path)).toMatchObject({ content: "private\n" });
  });

  it("serializes concurrent writes so the workspace and Git worktree cannot diverge", async () => {
    const { base, git, workspace } = await fixture();

    await Promise.all([
      workspace.write("/workspace/sources/repo/README.md", "first\n"),
      workspace.write("/workspace/sources/repo/README.md", "second\n"),
    ]);

    const [repository] = await git.listRepositories();
    const worktree = repository!.worktrees[0]!;
    await expect(base.read("/workspace/sources/repo/README.md")).resolves.toMatchObject({ content: "second\n" });
    await expect(git.diff({ repositoryId: repository!.id, worktreeId: worktree.id, path: "README.md", scope: "worktree" }))
      .resolves.toMatchObject({ patch: expect.stringContaining("+second") });
  });
});
