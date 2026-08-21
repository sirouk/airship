import { describe, expect, it } from "vitest";
import { BrowserGitClient } from "./client";
import { GitAbortError, GitCapabilityError, GitConcurrencyError, GitDomainError, GitVersionConflictError } from "./errors";
import { MemoryGitAdapter } from "./memory-adapter.test-support";

const now = () => "2026-07-18T12:00:00.000Z";

describe("in-memory browser Git adapter", () => {
  it("computes two-plane status and genuinely stages, diffs, and commits a local tree", async () => {
    const adapter = await fixture({
      "README.md": "Airship\nprivate\n",
      "src/old.ts": "old\n",
    }, {
      "README.md": "Airship\nprivate by design\n",
      "src/new.ts": "export const ready = true;\n",
    });
    const client = new BrowserGitClient(adapter);
    const [repository] = await client.listRepositories();
    const before = repository!.worktrees[0]!;

    expect(before.status).toEqual([
      expect.objectContaining({ path: "README.md", index: null, worktree: { kind: "modified" } }),
      expect.objectContaining({ path: "src/new.ts", index: null, worktree: { kind: "added" } }),
      expect.objectContaining({ path: "src/old.ts", index: null, worktree: { kind: "deleted" } }),
    ]);
    const diff = await client.diff({ repositoryId: "airship", worktreeId: "main", path: "README.md", scope: "worktree" });
    expect(diff.patch).toContain("-private");
    expect(diff.patch).toContain("+private by design");

    const staged = await client.stage({
      repositoryId: "airship",
      worktreeId: "main",
      paths: before.status.map((item) => item.path),
      expectedWorktreeVersion: before.version,
    });
    expect(staged.worktree!.status.every((entry) => entry.index && !entry.worktree)).toBe(true);
    const stagedDiff = await client.diff({ repositoryId: "airship", worktreeId: "main", path: "src/new.ts", scope: "staged" });
    expect(stagedDiff.patch).toContain("+export const ready = true;");

    const committed = await client.commit({
      repositoryId: "airship",
      worktreeId: "main",
      message: "Build the browser Git foundation",
      author: { name: "Ada Lovelace", email: "ada@example.com" },
      expectedWorktreeVersion: staged.worktree!.version,
    });
    expect(committed.commit).toMatch(/^sha256:/u);
    expect(committed.worktree!.head).toBe(committed.commit);
    expect(committed.worktree!.status).toEqual([]);
    expect(Object.isFrozen(committed.repository)).toBe(true);
    expect(Object.isFrozen(committed.repository.worktrees)).toBe(true);
    expect(() => (committed.changedPaths as string[]).push("escape")).toThrow();
  });

  it("preserves staged work when the working tree changes again, then unstages safely", async () => {
    const adapter = await fixture({ "notes.md": "one\n" }, { "notes.md": "two\n" });
    const client = new BrowserGitClient(adapter);
    let worktree = (await client.listRepositories())[0]!.worktrees[0]!;
    const staged = await client.stage({
      repositoryId: "airship", worktreeId: "main", paths: ["notes.md"], expectedWorktreeVersion: worktree.version,
    });
    worktree = await adapter.writeWorkingFile({
      repositoryId: "airship", worktreeId: "main", path: "notes.md", content: "three\n", expectedWorktreeVersion: staged.worktree!.version,
    });
    expect(worktree.status[0]).toMatchObject({ index: { kind: "modified" }, worktree: { kind: "modified" } });

    const unstaged = await client.unstage({
      repositoryId: "airship", worktreeId: "main", paths: ["notes.md"], expectedWorktreeVersion: worktree.version,
    });
    expect(unstaged.worktree!.status[0]).toMatchObject({ index: null, worktree: { kind: "modified" } });
  });

  it("moves a working file atomically under one reviewed worktree version", async () => {
    const client = new BrowserGitClient(await fixture({ "src/a.ts": "one\n" }));
    const before = (await client.listRepositories())[0]!.worktrees[0]!;
    const moved = await client.moveWorkingFile({ repositoryId: "airship", worktreeId: "main", sourcePath: "src/a.ts", targetPath: "lib/a.ts", expectedWorktreeVersion: before.version });
    expect(moved.status.map((entry) => [entry.path, entry.worktree?.kind])).toEqual([["lib/a.ts", "added"], ["src/a.ts", "deleted"]]);
    await expect(client.moveWorkingFile({ repositoryId: "airship", worktreeId: "main", sourcePath: "lib/a.ts", targetPath: "src/a.ts", expectedWorktreeVersion: before.version })).rejects.toBeInstanceOf(GitVersionConflictError);
  });

  it("uses compare-before-mutate versions, fail-fast cancellation, and a single-writer client lock", async () => {
    const adapter = await fixture({ "a.txt": "a\n" }, { "a.txt": "b\n" });
    const client = new BrowserGitClient(adapter);
    const worktree = (await client.listRepositories())[0]!.worktrees[0]!;
    const request = { repositoryId: "airship", worktreeId: "main", paths: ["a.txt"], expectedWorktreeVersion: worktree.version };

    const first = client.stage(request);
    await expect(client.stage(request)).rejects.toBeInstanceOf(GitConcurrencyError);
    await first;
    await expect(client.unstage(request)).rejects.toBeInstanceOf(GitVersionConflictError);

    const controller = new AbortController();
    controller.abort();
    await expect(client.status({ repositoryId: "airship", worktreeId: "main" }, controller.signal)).rejects.toBeInstanceOf(GitAbortError);
  });

  it("supports branch/worktree isolation while refusing dirty or multiply checked-out branches", async () => {
    const adapter = await fixture({ "a.txt": "a\n" });
    const client = new BrowserGitClient(adapter);
    let repository = (await client.listRepositories())[0]!;
    let main = repository.worktrees[0]!;
    const created = await client.createBranch({
      repositoryId: repository.id,
      worktreeId: main.id,
      name: "feature/proof",
      expectedWorktreeVersion: main.version,
    });
    repository = created.repository;
    main = created.worktree!;
    expect(repository.branches.map((branch) => branch.name)).toContain("feature/proof");

    const added = await client.createWorktree({
      repositoryId: repository.id,
      worktreeId: "proof",
      path: "proof",
      branch: "feature/proof",
      expectedRepositoryVersion: repository.version,
    });
    expect(added.repository.worktrees).toHaveLength(2);
    await expect(client.switchBranch({
      repositoryId: repository.id,
      worktreeId: main.id,
      name: "feature/proof",
      expectedWorktreeVersion: main.version,
    })).rejects.toMatchObject({ code: "branch-checked-out" });
  });

  it("reports remote operations as unavailable instead of pretending a proxy exists", async () => {
    const adapter = await fixture({ "a.txt": "a\n" });
    const client = new BrowserGitClient(adapter);
    const repository = (await client.listRepositories())[0]!;
    expect(client.capabilities.remote.transport).toBe("none");
    expect(client.capabilities.remote.detail).toContain("never inserts a hidden Git proxy");
    await expect(client.fetch({
      repositoryId: repository.id,
      remote: "origin",
      expectedRepositoryVersion: repository.version,
    })).rejects.toBeInstanceOf(GitCapabilityError);
    await expect(client.push({
      repositoryId: repository.id,
      worktreeId: "main",
      remote: "origin",
      branch: "main",
      expectedWorktreeVersion: repository.worktrees[0]!.version,
    })).rejects.toBeInstanceOf(GitCapabilityError);
  });

  it("admits a pinned workspace snapshot as the clean local repository baseline", async () => {
    const adapter = await fixture({ "existing.txt": "kept\n" });
    const client = new BrowserGitClient(adapter);
    const imported = await client.importSnapshot({
      repositoryId: "snapshot-owner-repo-0123456789ab",
      name: "owner/repo",
      destination: "/workspace/sources/repo",
      sourceUrl: "https://github.com/owner/repo",
      defaultBranch: "main",
      files: {
        "README.md": "# Imported\n",
        ".airship-import.json": "{\"commit\":\"0123456789abcdef\"}\n",
      },
    });

    expect((await client.listRepositories()).map((repository) => repository.id)).toEqual([
      "airship",
      "snapshot-owner-repo-0123456789ab",
    ]);
    expect(imported.worktree?.status).toEqual([]);
    expect(imported.repository.remotes[0]?.url).toBe("https://github.com/owner/repo");
    await expect(client.importSnapshot({
      repositoryId: "snapshot-owner-repo-0123456789ab",
      name: "duplicate",
      destination: "/workspace/sources/other",
      sourceUrl: "https://github.com/owner/repo",
      defaultBranch: "main",
      files: { "other.txt": "no\n" },
    })).rejects.toThrow("Duplicate repository");
    expect(await client.getRepository("airship")).toBeDefined();
  });

  it("rejects empty commits and unsafe case-folding changes", async () => {
    const adapter = await fixture({ "a.txt": "a\n" });
    const client = new BrowserGitClient(adapter);
    const worktree = (await client.listRepositories())[0]!.worktrees[0]!;
    await expect(client.commit({
      repositoryId: "airship", worktreeId: "main", message: "nothing", author: { name: "A", email: "a@example.com" }, expectedWorktreeVersion: worktree.version,
    })).rejects.toBeInstanceOf(GitDomainError);
    await expect(adapter.writeWorkingFile({
      repositoryId: "airship", worktreeId: "main", path: "A.txt", content: "collision", expectedWorktreeVersion: worktree.version,
    })).rejects.toThrow("collide");
    const after = await client.status({ repositoryId: "airship", worktreeId: "main" });
    expect(after.version).toBe(worktree.version);
    expect(after.status).toEqual([]);
  });

  it("does not leave a branch behind when checkout validation fails", async () => {
    const adapter = await fixture({ "a.txt": "a\n" }, { "a.txt": "dirty\n" });
    const client = new BrowserGitClient(adapter);
    const before = (await client.listRepositories())[0]!;
    await expect(client.createBranch({
      repositoryId: "airship",
      worktreeId: "main",
      name: "feature/atomic",
      checkout: true,
      expectedWorktreeVersion: before.worktrees[0]!.version,
    })).rejects.toMatchObject({ code: "dirty-worktree" });
    const after = await client.getRepository("airship");
    expect(after!.version).toBe(before.version);
    expect(after!.branches.map((branch) => branch.name)).not.toContain("feature/atomic");
  });

  it("rechecks the worktree generation after asynchronous commit hashing", async () => {
    const adapter = await fixture({ "a.txt": "a\n" }, { "a.txt": "b\n" });
    const setup = new BrowserGitClient(adapter);
    const before = (await setup.listRepositories())[0]!.worktrees[0]!;
    const staged = await setup.stage({
      repositoryId: "airship", worktreeId: "main", paths: ["a.txt"], expectedWorktreeVersion: before.version,
    });
    const request = {
      repositoryId: "airship",
      worktreeId: "main",
      author: { name: "A", email: "a@example.com" },
      expectedWorktreeVersion: staged.worktree!.version,
    };
    const left = new BrowserGitClient(adapter).commit({ ...request, message: "left" });
    const right = new BrowserGitClient(adapter).commit({ ...request, message: "right" });
    const results = await Promise.allSettled([left, right]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(GitVersionConflictError) });
  });
});

async function fixture(
  files: Readonly<Record<string, string>>,
  workingFiles?: Readonly<Record<string, string>>,
): Promise<MemoryGitAdapter> {
  return MemoryGitAdapter.create([{ id: "airship", name: "Airship", files, workingFiles }], { now });
}
