import * as git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import { BrowserGitClient } from "./client";
import { runTerminalGitCommand } from "./terminal-commands";
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
