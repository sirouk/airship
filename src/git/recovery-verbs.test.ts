import { describe, expect, it } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import { BrowserGitClient } from "./client";
import { GIT_LIMITS } from "./validation";
import { WorkspaceGitAdapter } from "./workspace-adapter";

const signal = new AbortController().signal;
const author = { name: "Airship Test", email: "airship@example.test" } as const;
const repositoryId = "airship-workspace";
const worktreeId = "main";

async function seeded(files: Record<string, string>): Promise<{ workspace: MemoryWorkspace; client: BrowserGitClient }> {
  const workspace = new MemoryWorkspace();
  const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
    id: repositoryId,
    name: "Airship Workspace",
    worktreePath: "/workspace",
    files,
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

async function commitAll(client: BrowserGitClient, paths: readonly string[], message: string): Promise<string> {
  const staged = await client.stage({ repositoryId, worktreeId, paths: [...paths], expectedWorktreeVersion: await version(client) }, signal);
  const committed = await client.commit({
    repositoryId,
    worktreeId,
    message,
    author,
    expectedWorktreeVersion: staged.worktree!.version,
  }, signal);
  return committed.commit!;
}

describe("browser Git stash", () => {
  it("parks tracked worktree changes in a real refs/stash entry and restores them", async () => {
    const { client, workspace } = await seeded({ "README.md": "committed\n" });
    await write(client, "README.md", "work in progress\n");
    expect((await client.status({ repositoryId, worktreeId }, signal)).status).toHaveLength(1);

    await client.stash({
      repositoryId,
      worktreeId,
      op: "push",
      message: "wip readme",
      author,
      expectedWorktreeVersion: await version(client),
    }, signal);

    expect((await client.status({ repositoryId, worktreeId }, signal)).status).toEqual([]);
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("committed\n");
    expect(await workspace.read("/workspace/.git/refs/stash")).toBeDefined();

    const entries = await client.listStash({ repositoryId, worktreeId }, signal);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ index: 0 });
    expect(entries[0]!.message).toContain("wip readme");
    expect(entries[0]!.oid).toMatch(/^[0-9a-f]{40}$/u);

    await client.stash({ repositoryId, worktreeId, op: "pop", author, expectedWorktreeVersion: await version(client) }, signal);
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("work in progress\n");
    expect(await client.listStash({ repositoryId, worktreeId }, signal)).toEqual([]);
  });

  it("refuses to stash a clean worktree and refuses an entry that does not exist", async () => {
    const { client } = await seeded({ "README.md": "committed\n" });
    await expect(client.stash({
      repositoryId,
      worktreeId,
      op: "push",
      author,
      expectedWorktreeVersion: await version(client),
    }, signal)).rejects.toMatchObject({ code: "nothing-to-stash" });

    await expect(client.stash({
      repositoryId,
      worktreeId,
      op: "apply",
      index: 3,
      author,
      expectedWorktreeVersion: await version(client),
    }, signal)).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("browser Git merge", () => {
  it("fast-forwards and updates the worktree, not only the ref", async () => {
    const { client, workspace } = await seeded({ "README.md": "base\n" });
    await client.createBranch({ repositoryId, worktreeId, name: "feature", checkout: true, expectedWorktreeVersion: await version(client) }, signal);
    await write(client, "README.md", "feature work\n");
    const featureCommit = await commitAll(client, ["README.md"], "Feature commit");
    await client.switchBranch({ repositoryId, worktreeId, name: "main", expectedWorktreeVersion: await version(client) }, signal);
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("base\n");

    const merged = await client.merge({
      repositoryId,
      worktreeId,
      theirs: "feature",
      author,
      expectedWorktreeVersion: await version(client),
    }, signal);

    expect(merged.worktree!.head).toBe(featureCommit);
    expect(merged.worktree!.status).toEqual([]);
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("feature work\n");
    expect((await workspace.read("/workspace/.git/refs/heads/main"))?.content.trim()).toBe(featureCommit);
  });

  it("creates a real merge commit for divergent branches and materializes both sides", async () => {
    const { client, workspace } = await seeded({ "README.md": "base\n" });
    await client.createBranch({ repositoryId, worktreeId, name: "feature", checkout: true, expectedWorktreeVersion: await version(client) }, signal);
    await write(client, "feature.txt", "feature\n");
    const featureCommit = await commitAll(client, ["feature.txt"], "Feature file");
    await client.switchBranch({ repositoryId, worktreeId, name: "main", expectedWorktreeVersion: await version(client) }, signal);
    await write(client, "trunk.txt", "trunk\n");
    const trunkCommit = await commitAll(client, ["trunk.txt"], "Trunk file");

    const merged = await client.merge({
      repositoryId,
      worktreeId,
      theirs: "feature",
      author,
      expectedWorktreeVersion: await version(client),
    }, signal);

    expect(merged.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(merged.commit).not.toBe(featureCommit);
    expect((await workspace.read("/workspace/feature.txt"))?.content).toBe("feature\n");
    expect((await workspace.read("/workspace/trunk.txt"))?.content).toBe("trunk\n");
    const history = await client.log({ repositoryId, worktreeId }, signal);
    expect(history[0]!.parents).toEqual([trunkCommit, featureCommit]);
    expect(merged.worktree!.status).toEqual([]);
  });

  it("aborts a conflicting merge and leaves the worktree exactly as it was", async () => {
    const { client, workspace } = await seeded({ "README.md": "base\n" });
    await client.createBranch({ repositoryId, worktreeId, name: "feature", checkout: true, expectedWorktreeVersion: await version(client) }, signal);
    await write(client, "README.md", "feature side\n");
    await commitAll(client, ["README.md"], "Feature edit");
    await client.switchBranch({ repositoryId, worktreeId, name: "main", expectedWorktreeVersion: await version(client) }, signal);
    await write(client, "README.md", "trunk side\n");
    const trunkCommit = await commitAll(client, ["README.md"], "Trunk edit");

    await expect(client.merge({
      repositoryId,
      worktreeId,
      theirs: "feature",
      author,
      expectedWorktreeVersion: await version(client),
    }, signal)).rejects.toMatchObject({ code: "merge-conflict" });

    const after = await client.status({ repositoryId, worktreeId }, signal);
    expect(after.head).toBe(trunkCommit);
    expect(after.status).toEqual([]);
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("trunk side\n");
  });

  it("refuses a merge that is not a fast-forward when the request demanded one", async () => {
    const { client } = await seeded({ "README.md": "base\n" });
    await client.createBranch({ repositoryId, worktreeId, name: "feature", checkout: true, expectedWorktreeVersion: await version(client) }, signal);
    await write(client, "feature.txt", "feature\n");
    await commitAll(client, ["feature.txt"], "Feature file");
    await client.switchBranch({ repositoryId, worktreeId, name: "main", expectedWorktreeVersion: await version(client) }, signal);
    await write(client, "trunk.txt", "trunk\n");
    await commitAll(client, ["trunk.txt"], "Trunk file");

    await expect(client.merge({
      repositoryId,
      worktreeId,
      theirs: "feature",
      fastForwardOnly: true,
      author,
      expectedWorktreeVersion: await version(client),
    }, signal)).rejects.toMatchObject({ code: "merge-not-fast-forward" });
  });

  it("refuses to merge into a dirty worktree instead of overwriting it", async () => {
    const { client } = await seeded({ "README.md": "base\n" });
    await client.createBranch({ repositoryId, worktreeId, name: "feature", checkout: true, expectedWorktreeVersion: await version(client) }, signal);
    await write(client, "feature.txt", "feature\n");
    await commitAll(client, ["feature.txt"], "Feature file");
    await client.switchBranch({ repositoryId, worktreeId, name: "main", expectedWorktreeVersion: await version(client) }, signal);
    await write(client, "README.md", "uncommitted\n");

    await expect(client.merge({
      repositoryId,
      worktreeId,
      theirs: "feature",
      author,
      expectedWorktreeVersion: await version(client),
    }, signal)).rejects.toMatchObject({ code: "dirty-worktree" });
  });
});

describe("browser Git restore and reset", () => {
  it("discards a worktree edit back to the staged bytes", async () => {
    const { client, workspace } = await seeded({ "README.md": "committed\n" });
    await write(client, "README.md", "staged\n");
    await client.stage({ repositoryId, worktreeId, paths: ["README.md"], expectedWorktreeVersion: await version(client) }, signal);
    await write(client, "README.md", "unstaged\n");

    const restored = await client.restore({
      repositoryId,
      worktreeId,
      paths: ["README.md"],
      source: "stage",
      expectedWorktreeVersion: await version(client),
    }, signal);

    expect((await workspace.read("/workspace/README.md"))?.content).toBe("staged\n");
    expect(restored.worktree!.status).toEqual([expect.objectContaining({ path: "README.md", index: { kind: "modified" }, worktree: null })]);
  });

  it("discards both index and worktree changes when restoring from HEAD", async () => {
    const { client, workspace } = await seeded({ "README.md": "committed\n" });
    await write(client, "README.md", "staged\n");
    await client.stage({ repositoryId, worktreeId, paths: ["README.md"], expectedWorktreeVersion: await version(client) }, signal);

    const restored = await client.restore({
      repositoryId,
      worktreeId,
      paths: ["README.md"],
      source: "head",
      expectedWorktreeVersion: await version(client),
    }, signal);

    expect((await workspace.read("/workspace/README.md"))?.content).toBe("committed\n");
    expect(restored.worktree!.status).toEqual([]);
  });

  it("refuses to discard an untracked path from either source instead of deleting work Git never took", async () => {
    const { client, workspace } = await seeded({ "README.md": "committed\n" });
    await write(client, "notes.md", "hours of untracked work\n");
    const before = await client.status({ repositoryId, worktreeId }, signal);
    expect(before.status).toEqual([expect.objectContaining({ path: "notes.md", index: null, worktree: { kind: "added" } })]);

    for (const source of ["stage", "head"] as const) {
      await expect(client.restore({
        repositoryId,
        worktreeId,
        paths: ["notes.md"],
        source,
        expectedWorktreeVersion: await version(client),
      }, signal)).rejects.toMatchObject({ code: "path-not-tracked" });
      expect((await workspace.read("/workspace/notes.md"))?.content).toBe("hours of untracked work\n");
    }
  });

  it("refuses to restore a staged-but-uncommitted path from HEAD instead of deleting it", async () => {
    // The index plane alone satisfied the untracked guard, so the request
    // reached checkout — which reads "staged, never committed" as a deletion
    // and unlinks the file. Nothing but the workspace holds this content.
    for (const modified of [false, true]) {
      const { client, workspace } = await seeded({ "README.md": "committed\n" });
      await write(client, "notes/draft.md", "hours of staged work\n");
      await client.stage({ repositoryId, worktreeId, paths: ["notes/draft.md"], expectedWorktreeVersion: await version(client) }, signal);
      if (modified) await write(client, "notes/draft.md", "hours of staged work, then edited\n");

      await expect(client.restore({
        repositoryId,
        worktreeId,
        paths: ["notes/draft.md"],
        source: "head",
        expectedWorktreeVersion: await version(client),
      }, signal)).rejects.toMatchObject({ code: "path-not-tracked" });

      expect((await workspace.read("/workspace/notes/draft.md"))?.content)
        .toBe(modified ? "hours of staged work, then edited\n" : "hours of staged work\n");
      // The index entry has to survive too: checkout drops it along with the file.
      const after = await client.status({ repositoryId, worktreeId }, signal);
      expect(after.status).toEqual([expect.objectContaining({ path: "notes/draft.md", index: { kind: "added" } })]);
    }
  });

  it("refuses the whole request when one named path is untracked, before discarding its siblings", async () => {
    const { client, workspace } = await seeded({ "README.md": "committed\n" });
    await write(client, "README.md", "edited\n");
    await write(client, "notes.md", "untracked\n");
    const before = await client.status({ repositoryId, worktreeId }, signal);

    await expect(client.restore({
      repositoryId,
      worktreeId,
      paths: ["README.md", "notes.md"],
      source: "stage",
      expectedWorktreeVersion: before.version,
    }, signal)).rejects.toMatchObject({ code: "path-not-tracked" });

    expect((await workspace.read("/workspace/README.md"))?.content).toBe("edited\n");
    expect((await workspace.read("/workspace/notes.md"))?.content).toBe("untracked\n");
  });

  it("restores one reviewed request that covers more paths than a single adapter call may carry", async () => {
    const files = Object.fromEntries(
      Array.from({ length: GIT_LIMITS.maxPathsPerOperation + 1 }, (_, index) => [`tracked/file-${String(index).padStart(4, "0")}.txt`, "committed\n"]),
    );
    const { client, workspace } = await seeded(files);
    const paths = Object.keys(files);
    // Edited through the workspace directly: one status read per file would
    // make the fixture quadratic without exercising anything under test.
    for (const path of paths) {
      const absolute = `/workspace/${path}`;
      await workspace.write(absolute, "edited\n", { expectedRevision: (await workspace.read(absolute))!.revision });
    }
    const before = await client.status({ repositoryId, worktreeId }, signal);
    expect(before.status).toHaveLength(paths.length);

    const restored = await client.restore({
      repositoryId,
      worktreeId,
      paths,
      source: "stage",
      expectedWorktreeVersion: before.version,
    }, signal);

    expect(restored.changedPaths).toHaveLength(paths.length);
    expect(restored.worktree!.status).toEqual([]);
    expect((await workspace.read(`/workspace/${paths.at(-1)!}`))?.content).toBe("committed\n");
  }, 120_000);

  it("keeps a first-chunk fence failure classified as a version conflict, not a partial mutation", async () => {
    const files = Object.fromEntries(
      Array.from({ length: GIT_LIMITS.maxPathsPerOperation + 1 }, (_, index) => [`tracked/file-${String(index).padStart(4, "0")}.txt`, "committed\n"]),
    );
    const { client } = await seeded(files);
    await expect(client.stage({
      repositoryId,
      worktreeId,
      paths: Object.keys(files),
      expectedWorktreeVersion: "worktree-v0-stale",
    }, signal)).rejects.toMatchObject({ code: "version-conflict" });
  }, 120_000);

  it("keeps a first-chunk path refusal classified as untracked, not as a durable partial mutation", async () => {
    const files = Object.fromEntries(
      Array.from({ length: GIT_LIMITS.maxPathsPerOperation + 1 }, (_, index) => [`tracked/file-${String(index).padStart(4, "0")}.txt`, "committed\n"]),
    );
    const { client, workspace } = await seeded(files);
    const tracked = Object.keys(files);
    for (const path of tracked) {
      const absolute = `/workspace/${path}`;
      await workspace.write(absolute, "edited\n", { expectedRevision: (await workspace.read(absolute))!.revision });
    }
    // Sorts ahead of every tracked path, so it lands in the very first chunk.
    await write(client, "aaa-untracked.txt", "hours of untracked work\n");
    const before = await client.status({ repositoryId, worktreeId }, signal);

    // 514 paths is two chunks. The refusal happens in the first, before any
    // write, so reporting it as a partial mutation would claim durable damage
    // that never occurred — and would hide the code callers dispatch on.
    await expect(client.restore({
      repositoryId,
      worktreeId,
      paths: ["aaa-untracked.txt", ...tracked],
      source: "stage",
      expectedWorktreeVersion: before.version,
    }, signal)).rejects.toMatchObject({ code: "path-not-tracked" });

    expect((await workspace.read("/workspace/aaa-untracked.txt"))?.content).toBe("hours of untracked work\n");
    expect((await workspace.read(`/workspace/${tracked[0]!}`))?.content).toBe("edited\n");
    expect((await workspace.read(`/workspace/${tracked.at(-1)!}`))?.content).toBe("edited\n");
  }, 120_000);

  it("admits or refuses every staged path before writing any of them", async () => {
    const files = Object.fromEntries(
      Array.from({ length: GIT_LIMITS.maxPathsPerOperation + 1 }, (_, index) => [`tracked/file-${String(index).padStart(4, "0")}.txt`, "committed\n"]),
    );
    const { client, workspace } = await seeded(files);
    const paths = Object.keys(files);
    // Everything except one path in the middle of the first adapter chunk is
    // dirty, so the refusal lands after 511 admissible siblings.
    const unchanged = paths[GIT_LIMITS.maxPathsPerOperation - 1]!;
    for (const path of paths) {
      if (path === unchanged) continue;
      const absolute = `/workspace/${path}`;
      await workspace.write(absolute, "edited\n", { expectedRevision: (await workspace.read(absolute))!.revision });
    }
    const before = await client.status({ repositoryId, worktreeId }, signal);

    await expect(client.stage({
      repositoryId,
      worktreeId,
      paths,
      expectedWorktreeVersion: before.version,
    }, signal)).rejects.toMatchObject({ code: "validation" });

    // The pre-flight scan is what makes the code above honest: not one of the
    // 511 admissible siblings may have reached the index.
    const after = await client.status({ repositoryId, worktreeId }, signal);
    expect(after.status.filter((entry) => entry.index)).toEqual([]);
  }, 120_000);

  it("refuses to discard a path that has no change", async () => {
    const { client } = await seeded({ "README.md": "committed\n" });
    await expect(client.restore({
      repositoryId,
      worktreeId,
      paths: ["README.md"],
      source: "stage",
      expectedWorktreeVersion: await version(client),
    }, signal)).rejects.toThrow(/no change to discard/u);
  });

  it("moves the branch and the worktree for a hard reset", async () => {
    const { client, workspace } = await seeded({ "README.md": "first\n" });
    const first = (await client.log({ repositoryId, worktreeId }, signal))[0]!.oid;
    await write(client, "README.md", "second\n");
    await write(client, "extra.txt", "added later\n");
    await commitAll(client, ["README.md", "extra.txt"], "Second commit");

    const reset = await client.reset({
      repositoryId,
      worktreeId,
      mode: "hard",
      ref: first,
      expectedWorktreeVersion: await version(client),
    }, signal);

    expect(reset.worktree!.head).toBe(first);
    expect(reset.worktree!.status).toEqual([]);
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("first\n");
    expect(await workspace.read("/workspace/extra.txt")).toBeUndefined();
    expect((await workspace.read("/workspace/.git/refs/heads/main"))?.content.trim()).toBe(first);
  });

  it("keeps the worktree and the index for a soft reset, and only the worktree for a mixed reset", async () => {
    const { client, workspace } = await seeded({ "README.md": "first\n" });
    const first = (await client.log({ repositoryId, worktreeId }, signal))[0]!.oid;
    await write(client, "README.md", "second\n");
    await commitAll(client, ["README.md"], "Second commit");

    const soft = await client.reset({
      repositoryId,
      worktreeId,
      mode: "soft",
      ref: first,
      expectedWorktreeVersion: await version(client),
    }, signal);
    expect(soft.worktree!.head).toBe(first);
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("second\n");
    expect(soft.worktree!.status).toEqual([expect.objectContaining({ path: "README.md", index: { kind: "modified" }, worktree: null })]);

    const mixed = await client.reset({
      repositoryId,
      worktreeId,
      mode: "mixed",
      ref: first,
      expectedWorktreeVersion: await version(client),
    }, signal);
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("second\n");
    expect(mixed.worktree!.status).toEqual([expect.objectContaining({ path: "README.md", index: null, worktree: { kind: "modified" } })]);
  });
});
