import { describe, expect, it, vi } from "vitest";
import { BrowserGitClient } from "../git/client";
import { GIT_LIMITS, gitRemoteConnectOrigins } from "../git/validation";
import { WorkspaceGitAdapter } from "../git/workspace-adapter";
import { MemoryWorkspace } from "../workspace/memory";
import { registerGitTools } from "./git-tools";
import { ToolRegistry } from "./registry";

const context = {
  sessionId: "session",
  turnId: "turn",
  operationId: "operation",
  signal: new AbortController().signal,
} as const;

async function fixture(
  files: Record<string, string> = { "README.md": "seeded\n" },
): Promise<{ registry: ToolRegistry; client: BrowserGitClient; workspace: MemoryWorkspace }> {
  const workspace = new MemoryWorkspace();
  const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
    id: "airship-workspace",
    name: "Airship Workspace",
    worktreePath: "/workspace",
    files,
  }], { now: () => "2026-07-24T10:00:00.000Z" }));
  const registry = new ToolRegistry();
  registerGitTools(registry, client);
  return { registry, client, workspace };
}

function clone(registry: ToolRegistry, origin: string): Promise<unknown> {
  return run(registry, "git_remote", {
    action: "clone",
    repositoryId: "cloned",
    name: "Cloned",
    remoteUrl: `${origin}/owner/repo.git`,
    destination: "/workspace/cloned",
  });
}

async function run(registry: ToolRegistry, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`${name} was not registered.`);
  return JSON.parse((await tool.execute(args as never, context)).content);
}

describe("agent-facing Git tools", () => {
  it("advertises a path bound the runtime actually accepts", async () => {
    // A schema comparison alone would pass against a runtime that refuses the
    // advertised count, so both edges of the advertised bound are exercised
    // through the tool the model actually calls.
    const files = Object.fromEntries(
      Array.from({ length: GIT_LIMITS.maxPathsPerOperation + 1 }, (_, index) => [`tracked/file-${String(index).padStart(4, "0")}.txt`, "seeded\n"]),
    );
    const { registry, client, workspace } = await fixture(files);
    const paths = Object.keys(files);
    const schema = registry.get("git_change")!.definition.inputSchema as {
      properties: { paths: { maxItems: number }; action: { enum: string[] } };
    };
    expect(schema.properties.paths.maxItems).toBe(GIT_LIMITS.maxPathsPerRequest);
    expect(schema.properties.paths.maxItems).toBeGreaterThan(GIT_LIMITS.maxPathsPerOperation);
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(["merge", "stash", "restore", "reset"]));

    for (const path of paths) {
      const absolute = `/workspace/${path}`;
      await workspace.write(absolute, "edited\n", { expectedRevision: (await workspace.read(absolute))!.revision });
    }
    const before = await client.status({ repositoryId: "airship-workspace", worktreeId: "main" }, context.signal);
    // Above the per-adapter-call bound and below the advertised request bound:
    // the runtime must chunk it rather than refuse it.
    const staged = await run(registry, "git_change", {
      action: "stage",
      repositoryId: "airship-workspace",
      worktreeId: "main",
      expectedWorktreeVersion: before.version,
      paths,
    }) as { changedPaths: string[] };
    expect(staged.changedPaths).toHaveLength(paths.length);

    // And the advertised ceiling is the ceiling the runtime enforces.
    const after = await client.status({ repositoryId: "airship-workspace", worktreeId: "main" }, context.signal);
    await expect(run(registry, "git_change", {
      action: "stage",
      repositoryId: "airship-workspace",
      worktreeId: "main",
      expectedWorktreeVersion: after.version,
      paths: Array.from({ length: GIT_LIMITS.maxPathsPerRequest + 1 }, (_, index) => `overflow/file-${index}.txt`),
    })).rejects.toThrow(`Select between 1 and ${GIT_LIMITS.maxPathsPerRequest} paths.`);
  }, 120_000);

  it("reads real history and tags through git_inspect", async () => {
    const { registry, client, workspace } = await fixture();
    await workspace.write("/workspace/README.md", "changed\n", {
      expectedRevision: (await workspace.read("/workspace/README.md"))!.revision,
    });
    const before = await client.status({ repositoryId: "airship-workspace", worktreeId: "main" }, context.signal);
    const staged = await client.stage({
      repositoryId: "airship-workspace",
      worktreeId: "main",
      paths: ["README.md"],
      expectedWorktreeVersion: before.version,
    }, context.signal);
    await client.commit({
      repositoryId: "airship-workspace",
      worktreeId: "main",
      message: "Agent commit",
      author: { name: "Airship Test", email: "airship@example.test" },
      expectedWorktreeVersion: staged.worktree!.version,
    }, context.signal);

    const log = await run(registry, "git_inspect", { action: "log", repositoryId: "airship-workspace", worktreeId: "main", depth: 1 }) as Array<{ message: string }>;
    expect(log).toHaveLength(1);
    expect(log[0]!.message.trim()).toBe("Agent commit");

    const show = await run(registry, "git_inspect", {
      action: "show",
      repositoryId: "airship-workspace",
      worktreeId: "main",
      revision: "main",
    }) as { files: Array<{ path: string; patch: string }> };
    expect(show.files[0]!.patch).toContain("+changed");

    expect(await run(registry, "git_inspect", { action: "tags", repositoryId: "airship-workspace" })).toEqual([]);
    expect(await run(registry, "git_inspect", { action: "stash", repositoryId: "airship-workspace", worktreeId: "main" })).toEqual([]);
  });

  it("discards a worktree edit through git_change and attaches a remote through git_remote", async () => {
    const { registry, client, workspace } = await fixture();
    await workspace.write("/workspace/README.md", "scratch\n", {
      expectedRevision: (await workspace.read("/workspace/README.md"))!.revision,
    });
    const dirty = await client.status({ repositoryId: "airship-workspace", worktreeId: "main" }, context.signal);
    await run(registry, "git_change", {
      action: "restore",
      repositoryId: "airship-workspace",
      worktreeId: "main",
      expectedWorktreeVersion: dirty.version,
      paths: ["README.md"],
    });
    expect((await workspace.read("/workspace/README.md"))?.content).toBe("seeded\n");

    const repository = (await client.listRepositories(context.signal))[0]!;
    const attached = await run(registry, "git_configure", {
      action: "add_remote",
      repositoryId: "airship-workspace",
      name: "origin",
      remoteUrl: "https://git.example.test/repository.git",
      expectedRepositoryVersion: repository.version,
    }) as { repository: { remotes: Array<{ name: string; url: string }> } };
    expect(attached.repository.remotes).toEqual([
      { name: "origin", url: "https://git.example.test/repository.git", transport: "direct-git-http" },
    ]);
    // Attaching a remote sends nothing, so it must not be declared as network.
    expect(registry.get("git_configure")!.definition.effect).toBe("write");
    expect(registry.get("git_remote")!.definition.effect).toBe("network");
  });

  it("tells the model which origins the page policy can reach at all, and refuses the rest", async () => {
    const { registry } = await fixture();
    const capabilities = await run(registry, "git_inspect", { action: "capabilities" }) as {
      remote: { permittedOrigins: string[]; detail: string };
      features: Record<string, { available: boolean; reason?: string }>;
    };
    // `not.toContain` on an empty list passes for free, so the report is pinned
    // to the same function the adapter refuses with, and the refusal itself is
    // exercised: the advertised list and the enforced list cannot drift.
    expect(capabilities.remote.permittedOrigins).toEqual([...gitRemoteConnectOrigins()]);
    expect(capabilities.remote.detail).toContain("Git egress policy");
    expect(registry.get("git_remote")!.definition.description).toContain("permittedOrigins");

    // This host has no document origin, so nothing is reachable. Claiming the
    // capability would be an unmeetable promise: it reports unavailable, and a
    // clone fails on that refusal rather than on a network error.
    expect(capabilities.remote.permittedOrigins).toEqual([]);
    expect(capabilities.features.clone).toMatchObject({ available: false });
    expect(capabilities.features.clone!.reason).toContain("no origin at all");
    await expect(clone(registry, "https://github.com")).rejects.toThrow(/clone is unavailable/u);

    // Given a page origin, the same code reaches the Git policy gate: the page's own
    // origin is permitted, and github.com is refused by name before any request.
    vi.stubGlobal("location", { origin: "https://git.example.test" });
    try {
      const scoped = await fixture();
      const granted = await run(scoped.registry, "git_inspect", { action: "capabilities" }) as {
        remote: { permittedOrigins: string[]; detail: string };
        features: Record<string, { available: boolean; reason?: string }>;
      };
      expect(granted.remote.permittedOrigins).toEqual(["https://git.example.test"]);
      expect(granted.features.clone).toMatchObject({ available: true });
      // The refusal clause names the refused hosts from the allowlist itself.
      expect(granted.features.clone!.reason).toContain("github.com and gitlab.com included");
      expect(granted.remote.detail).toContain("github.com and gitlab.com are not among them");

      await expect(clone(scoped.registry, "https://github.com"))
        .rejects.toThrow(/Git remote policy blocks a direct Git clone to https:\/\/github\.com/u);
      // The permitted origin gets past the policy gate and fails on transport,
      // which is what proves the gate is origin-specific and not a blanket no.
      await expect(clone(scoped.registry, "https://git.example.test"))
        .rejects.not.toThrow(/Git remote policy blocks a direct Git clone/u);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
