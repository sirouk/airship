import { describe, expect, it } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import { BrowserGitClient } from "./client";
import { MemoryGitAdapter } from "./memory-adapter";
import { WorkspaceGitAdapter } from "./workspace-adapter";

const signal = new AbortController().signal;
const repositoryId = "airship-workspace";
const worktreeId = "main";

async function seeded(files: Record<string, string>, workingFiles?: Record<string, string>): Promise<{
  workspace: MemoryWorkspace;
  client: BrowserGitClient;
}> {
  const workspace = new MemoryWorkspace();
  const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
    id: repositoryId,
    name: "Airship Workspace",
    worktreePath: "/workspace",
    files,
    ...(workingFiles ? { workingFiles } : {}),
  }], { now: () => "2026-07-24T10:00:00.000Z" }));
  return { workspace, client };
}

async function version(client: BrowserGitClient): Promise<string> {
  return (await client.status({ repositoryId, worktreeId }, signal)).version;
}

async function write(client: BrowserGitClient, path: string, content: string): Promise<void> {
  await client.writeWorkingFile({
    repositoryId,
    worktreeId,
    path,
    content,
    expectedWorktreeVersion: await version(client),
  }, signal);
}

describe("browser Git ignore rules", () => {
  it("keeps untracked ignored paths out of status while leaving them in the workspace", async () => {
    const { client, workspace } = await seeded({ ".gitignore": "node_modules/\n*.log\n", "src/app.ts": "export const value = 1;\n" });
    await write(client, "debug.log", "noisy\n");
    await write(client, "node_modules/pkg/index.js", "module.exports = 1;\n");
    await write(client, "src/other.ts", "export const other = 2;\n");

    const status = await client.status({ repositoryId, worktreeId }, signal);
    expect(status.status.map((entry) => entry.path)).toEqual(["src/other.ts"]);
    expect((await workspace.read("/workspace/debug.log"))?.content).toBe("noisy\n");
  });

  it("names the ignore rule instead of claiming the file did not change, and honours an explicit force", async () => {
    const { client } = await seeded({ ".gitignore": "*.log\n", "README.md": "seeded\n" });
    await write(client, "debug.log", "noisy\n");

    await expect(client.stage({
      repositoryId,
      worktreeId,
      paths: ["debug.log"],
      expectedWorktreeVersion: await version(client),
    }, signal)).rejects.toMatchObject({ code: "path-ignored" });

    const forced = await client.stage({
      repositoryId,
      worktreeId,
      paths: ["debug.log"],
      force: true,
      expectedWorktreeVersion: await version(client),
    }, signal);
    expect(forced.worktree!.status).toEqual([expect.objectContaining({ path: "debug.log", index: { kind: "added" } })]);
  });

  it("still reports a modification for a file that was tracked before the pattern was added", async () => {
    const { client } = await seeded({ "tracked.log": "first\n" });
    await write(client, ".gitignore", "*.log\n");
    await write(client, "tracked.log", "second\n");

    const status = await client.status({ repositoryId, worktreeId }, signal);
    expect(status.status.map((entry) => entry.path)).toEqual([".gitignore", "tracked.log"]);
    const staged = await client.stage({
      repositoryId,
      worktreeId,
      paths: ["tracked.log"],
      expectedWorktreeVersion: status.version,
    }, signal);
    expect(staged.changedPaths).toEqual(["tracked.log"]);
  });

  it("honours .git/info/exclude, a re-including negation, and Git's rule that an excluded directory cannot be re-entered", async () => {
    const { client, workspace } = await seeded({ ".gitignore": "*.tmp\n!keep.tmp\nbuild/\n!build/keep.txt\n", "README.md": "seeded\n" });
    const exclude = await workspace.read("/workspace/.git/info/exclude");
    await workspace.write("/workspace/.git/info/exclude", `${exclude?.content ?? ""}private/\n`, { expectedRevision: exclude?.revision ?? null });

    await write(client, "private/notes.md", "secret\n");
    await write(client, "scratch.tmp", "scratch\n");
    await write(client, "keep.tmp", "kept\n");
    await write(client, "build/output.js", "generated\n");
    await write(client, "build/keep.txt", "kept\n");

    const status = await client.status({ repositoryId, worktreeId }, signal);
    // keep.tmp is re-included by the negation; nothing under build/ can be,
    // because Git never descends into an excluded directory.
    expect(status.status.map((entry) => entry.path)).toEqual(["keep.tmp"]);
  });

  it("does not silently commit a seed file the seed's own ignore rules exclude", async () => {
    const { client, workspace } = await seeded({ ".gitignore": "dist/\n", "dist/bundle.js": "generated\n", "keep.txt": "kept\n" });

    // The Git surfaces agree with the repository's own rules: the file is in the
    // workspace, but it was never admitted to the index or to HEAD.
    expect((await workspace.read("/workspace/dist/bundle.js"))?.content).toBe("generated\n");
    const detail = await client.show({ repositoryId, worktreeId, revision: "main" }, signal);
    expect(detail.files.map((file) => file.path)).toEqual([".gitignore", "keep.txt"]);
    expect((await client.status({ repositoryId, worktreeId }, signal)).status).toEqual([]);
  });

  it("declares the simulated adapter's ignore contract instead of implying it shares this one", async () => {
    const memory = new BrowserGitClient(await MemoryGitAdapter.create([{
      id: repositoryId,
      name: "Memory",
      worktreePath: "/workspace",
      files: { ".gitignore": "*.log\n" },
      workingFiles: { ".gitignore": "*.log\n", "debug.log": "noisy\n" },
    }]));
    // The reference adapter has no ignore engine at all, so it must not pretend
    // to apply one: the untracked path stays visible and stageable.
    const status = await memory.status({ repositoryId, worktreeId }, signal);
    expect(status.status.map((entry) => entry.path)).toEqual(["debug.log"]);
    const staged = await memory.stage({
      repositoryId,
      worktreeId,
      paths: ["debug.log"],
      expectedWorktreeVersion: status.version,
    }, signal);
    expect(staged.changedPaths).toEqual(["debug.log"]);
  });
});
