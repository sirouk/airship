import * as git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import { BrowserGitClient } from "./client";
import { runTerminalGitCommand } from "./terminal-commands";
import type { GitOperation } from "./types";
import { WorkspaceGitAdapter } from "./workspace-adapter";

describe("terminal Git command bridge", () => {
  it("reads and mutates the exact repository used by browser source control", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "changed\n");
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "original\n" },
      workingFiles: { "README.md": "changed\n" },
    }]));
    const review = async () => "allow" as const;

    const status = await runTerminalGitCommand({ command: "git status", cwd: "/workspace", client, review });
    expect(status.output).toContain(" M README.md");

    expect((await runTerminalGitCommand({ command: "git add -A", cwd: "/workspace", client, review })).changed).toBe(true);
    const staged = (await client.listRepositories())[0]!.worktrees[0]!;
    expect(staged.status[0]).toEqual(expect.objectContaining({ index: { kind: "modified" }, worktree: null }));

    const committed = await runTerminalGitCommand({ command: "git commit -m 'shared state'", cwd: "/workspace", client, review });
    expect(committed.output).toMatch(/\[[^ ]+ [0-9a-f]{12}\] shared state/u);
    expect((await client.listRepositories())[0]!.worktrees[0]!.status).toEqual([]);
  });

  it("applies the active approval policy before every mutating command", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "changed\n");
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      files: { "README.md": "original\n" },
      workingFiles: { "README.md": "changed\n" },
    }]));

    await expect(runTerminalGitCommand({
      command: "git add README.md",
      cwd: "/workspace",
      client,
      review: async () => "deny",
    })).rejects.toThrow("denied");
    expect((await client.listRepositories())[0]!.worktrees[0]!.status[0]!.index).toBeNull();
  });

  it("refuses ambiguous git -C traversal instead of selecting a different worktree", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "ready\n" },
    }]));

    await expect(runTerminalGitCommand({
      command: "git -C sources/../outside status",
      cwd: "/workspace",
      client,
    })).rejects.toThrow("Workspace paths cannot contain . or ..");
  });

  it("reads real history through log and show", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "changed\n");
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "original\n" },
      workingFiles: { "README.md": "changed\n" },
    }]));
    const review = async () => "allow" as const;
    await runTerminalGitCommand({ command: "git add -A", cwd: "/workspace", client, review });
    await runTerminalGitCommand({ command: "git commit -m 'second commit'", cwd: "/workspace", client, review });

    const log = await runTerminalGitCommand({ command: "git log --oneline", cwd: "/workspace", client, review });
    expect(log.changed).toBe(false);
    expect(log.output).toMatch(/^[0-9a-f]{7} second commit\n[0-9a-f]{7} Initial browser workspace\n$/u);
    expect((await runTerminalGitCommand({ command: "git log -n 1", cwd: "/workspace", client, review })).output)
      .toMatch(/commit [0-9a-f]{40}\nAuthor: .+\nDate:   .+\n\n {4}second commit/u);

    const show = await runTerminalGitCommand({ command: "git show", cwd: "/workspace", client, review });
    expect(show.output).toContain("-original");
    expect(show.output).toContain("+changed");
  });

  it("lists, adds, and removes linked worktrees instead of claiming the feature is unavailable", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "application",
      name: "Application",
      worktreePath: "/workspace/sources/application",
      files: { "README.md": "ready\n" },
    }]));
    const review = async () => "allow" as const;
    const cwd = "/workspace/sources/application";

    const listed = await runTerminalGitCommand({ command: "git worktree list", cwd, client, review });
    expect(listed.output).toMatch(/^\/workspace\/sources\/application {2}[0-9a-f]{7} \[main\] {2}\(primary\)\n$/u);

    await runTerminalGitCommand({ command: "git branch feature/proof", cwd, client, review });
    const added = await runTerminalGitCommand({
      command: "git worktree add /workspace/checkouts/proof feature/proof",
      cwd,
      client,
      review,
    });
    expect(added.changed).toBe(true);
    expect((await workspace.read("/workspace/checkouts/proof/.git"))?.content).toMatch(/^gitdir: /u);
    expect((await runTerminalGitCommand({ command: "git worktree list", cwd, client, review })).output)
      .toContain("/workspace/checkouts/proof");

    const removed = await runTerminalGitCommand({
      command: "git worktree remove /workspace/checkouts/proof",
      cwd,
      client,
      review,
    });
    expect(removed.output).toContain("Removed worktree");
    expect(await workspace.list("/workspace/checkouts/proof")).toEqual([]);
    await expect(runTerminalGitCommand({ command: "git worktree add /workspace/checkouts/other -b new", cwd, client, review }))
      .rejects.toThrow(/existing branch only/u);
  });

  it("tags, stashes, merges, restores, and attaches remotes through the same approval broker", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "base\n" },
    }]));
    const reviewed: string[] = [];
    const review = async (_operation: unknown, descriptor: { operation: string }) => {
      reviewed.push(descriptor.operation);
      return "allow" as const;
    };
    const run = (command: string) => runTerminalGitCommand({ command, cwd: "/workspace", client, review });

    expect((await run("git tag")).output).toBe("No tags.\n");
    await run("git tag -a v1.0.0 -m 'first release'");
    expect((await run("git tag")).output).toContain("v1.0.0\t(annotated)");

    await workspace.write("/workspace/README.md", "work in progress\n", {
      expectedRevision: (await workspace.read("/workspace/README.md"))!.revision,
    });
    await run("git stash push -m 'wip'");
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("base\n");
    expect((await run("git stash list")).output).toContain("stash@{0}");
    await run("git stash pop");
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("work in progress\n");

    await run("git restore README.md");
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("base\n");

    await run("git switch -c feature");
    await workspace.write("/workspace/feature.txt", "feature\n");
    await run("git add -A");
    await run("git commit -m 'feature commit'");
    await run("git switch main");
    const merged = await run("git merge feature");
    expect(merged.output).toContain("Merged feature into main");
    expect((await workspace.read("/workspace/feature.txt"))?.content).toBe("feature\n");

    const added = await run("git remote add origin https://git.example.test/repository.git");
    expect(added.output).toContain("Content-Security-Policy cannot reach that origin");
    expect((await run("git remote -v")).output).toContain("https://git.example.test/repository.git (fetch)");
    await run("git remote remove origin");
    expect((await run("git remote")).output).toBe("No remotes configured.\n");

    expect(reviewed).toEqual([
      "tag-create", "stash", "stash", "restore", "branch-create", "stage", "commit",
      "branch-switch", "merge", "remote-add", "remote-remove",
    ]);
  });

  it("reads `git restore --worktree` as a destination, so staged content survives the discard", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "f.txt": "committed\n" },
    }]));
    const operations: GitOperation[] = [];
    const review = async (operation: GitOperation) => {
      operations.push(operation);
      return "allow" as const;
    };
    const run = (command: string) => runTerminalGitCommand({ command, cwd: "/workspace", client, review });
    const overwrite = async (content: string) => {
      await workspace.write("/workspace/f.txt", content, {
        expectedRevision: (await workspace.read("/workspace/f.txt"))!.revision,
      });
    };

    await overwrite("staged\n");
    await run("git add f.txt");
    await overwrite("working\n");

    await run("git restore --worktree f.txt");
    expect(operations.at(-1)).toMatchObject({ kind: "restore", request: { source: "stage", paths: ["f.txt"] } });
    // `--worktree` picks the destination Git writes to; it must not reach past
    // the index and take the staged content with it.
    expect((await workspace.read("/workspace/f.txt"))?.content).toBe("staged\n");

    await overwrite("working again\n");
    await run("git restore f.txt");
    expect(operations.at(-1)).toMatchObject({ kind: "restore", request: { source: "stage" } });
    expect((await workspace.read("/workspace/f.txt"))?.content).toBe("staged\n");

    await run("git restore --source=HEAD f.txt");
    expect(operations.at(-1)).toMatchObject({ kind: "restore", request: { source: "head" } });
    expect((await workspace.read("/workspace/f.txt"))?.content).toBe("committed\n");

    await expect(run("git restore --worktree --staged f.txt")).rejects.toThrow(/Unsupported `git restore` flag: --staged/u);
    await expect(run("git restore --staged --worktree f.txt")).rejects.toThrow(/Unsupported `git restore --staged` flag: --worktree/u);
  });

  it("reads every word after `--` as a path, so a file named like a flag is still restorable", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "--odd.txt": "committed\n" },
    }]));
    const operations: GitOperation[] = [];
    const review = async (operation: GitOperation) => {
      operations.push(operation);
      return "allow" as const;
    };
    const run = (command: string) => runTerminalGitCommand({ command, cwd: "/workspace", client, review });
    const overwrite = async (content: string) => {
      await workspace.write("/workspace/--odd.txt", content, {
        expectedRevision: (await workspace.read("/workspace/--odd.txt"))!.revision,
      });
    };

    await overwrite("working\n");
    // Git stops reading options at the separator. Rejecting these as unknown
    // flags would leave a legitimately named file with no way to be discarded
    // or unstaged from the bridge at all.
    await run("git restore -- --odd.txt");
    expect(operations.at(-1)).toMatchObject({ kind: "restore", request: { paths: ["--odd.txt"] } });

    await overwrite("staged again\n");
    await run("git add -- --odd.txt");
    await run("git restore --staged -- --odd.txt");
    expect(operations.at(-1)).toMatchObject({ kind: "unstage", request: { paths: ["--odd.txt"] } });

    // A word named `--worktree` after the separator is a path, not the
    // destination selector, so it must not be silently consumed as a flag: the
    // failure names the missing path rather than the bridge's usage line.
    await expect(run("git restore -- --worktree")).rejects.toThrow("--worktree has no change to discard.");

    // The bare separator starts with `--` but is not a mode flag. Routing on it
    // sent `git reset -- <paths…>` to the reset-mode handler, whose refusal
    // advised running `git reset [paths…]` — the command just typed.
    await overwrite("staged once more\n");
    await run("git add -- --odd.txt");
    await run("git reset -- --odd.txt");
    expect(operations.at(-1)).toMatchObject({ kind: "unstage", request: { paths: ["--odd.txt"] } });
  });

  it("stages an ignored path through the `-f` the ignore refusal tells the user to reach for", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { ".gitignore": "build/\n" },
    }]));
    const operations: GitOperation[] = [];
    const review = async (operation: GitOperation) => {
      operations.push(operation);
      return "allow" as const;
    };
    const run = (command: string) => runTerminalGitCommand({ command, cwd: "/workspace", client, review });
    await client.writeWorkingFile({
      repositoryId: "airship-workspace",
      worktreeId: "main",
      path: "build/out.js",
      content: "generated\n",
      expectedWorktreeVersion: (await client.status({ repositoryId: "airship-workspace", worktreeId: "main" })).version,
    });

    await expect(run("git add build/out.js")).rejects.toThrow(/excluded by this repository's \.gitignore/u);
    // Before the bridge consumed the flag, `-f` fell through as a pathspec and
    // the remedy the ignore refusal names answered "-f has no unstaged change."
    await run("git add -f build/out.js");
    expect(operations.at(-1)).toMatchObject({ kind: "stage", request: { paths: ["build/out.js"], force: true } });
    const staged = (await client.listRepositories())[0]!.worktrees[0]!;
    expect(staged.status).toEqual([expect.objectContaining({ path: "build/out.js", index: { kind: "added" } })]);
  });

  it("refuses a clone its own page policy cannot reach before asking for approval", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "ready\n" },
    }]));
    let reviewCalls = 0;
    await expect(runTerminalGitCommand({
      command: "git clone https://github.com/owner/example.git",
      cwd: "/workspace",
      client,
      review: async () => { reviewCalls += 1; return "allow"; },
    })).rejects.toThrow(/Content-Security-Policy blocks a direct Git clone/u);
    expect(reviewCalls).toBe(0);
  });

  it("routes push through the identity approval and the same direct Smart HTTP adapter", async () => {
    const workspace = new MemoryWorkspace();
    // The shipped connect-src reaches Git Smart HTTP only through 'self', so a
    // pushable remote is one served beside Airship.
    vi.stubGlobal("location", { origin: "https://git.example.test" });
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      files: { "README.md": "ready\n" },
      remoteUrl: "https://git.example.test/repository.git",
    }]));
    const push = vi.spyOn(git, "push").mockResolvedValue({
      ok: true,
      error: null,
      refs: { "refs/heads/main": { ok: true, error: "" } },
    });
    const reviewed: string[] = [];
    try {
      const result = await runTerminalGitCommand({
        command: "git push origin main",
        cwd: "/workspace",
        client,
        review: async (_operation, descriptor) => {
          reviewed.push(`${descriptor.brokerEffect}:${descriptor.risk}`);
          return "allow";
        },
      });
      expect(result).toMatchObject({ changed: true });
      expect(result.output).toContain("Pushed main to origin directly");
      expect(reviewed).toEqual(["identity:change-remote"]);
    } finally {
      push.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
