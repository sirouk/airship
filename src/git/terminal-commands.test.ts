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

  it("routes push through the identity approval and the same direct Smart HTTP adapter", async () => {
    const workspace = new MemoryWorkspace();
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
    }
  });
});
