import { describe, expect, it, vi } from "vitest";
import { BrowserGitClient } from "../git";
import { MemoryGitAdapter } from "../git/memory-adapter";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { MemoryWorkspace } from "../workspace/memory";
import { createAirshipToolRegistry } from "./airship-tools";
import { allowAllForTests } from "./registry";

describe("Airship browser capability registry", () => {
  it("advertises only backed capabilities and keeps their approval effects explicit", async () => {
    const { registry } = await harness();
    const definitions = registry.definitions();
    const byName = new Map(definitions.map((definition) => [definition.name, definition]));

    for (const name of [
      "list_files", "read_file", "write_file", "stat_path", "search_text", "replace_text", "move_file", "remove_file", "text_editor",
      "list_tasks", "update_tasks", "search_context", "fetch_url", "import_github_repository", "git_inspect", "git_change", "git_remote",
    ]) expect(byName.has(name), name).toBe(true);

    expect(byName.get("search_context")?.effect).toBe("read");
    expect(byName.get("git_inspect")?.effect).toBe("read");
    expect(byName.get("update_tasks")?.effect).toBe("write");
    expect(byName.get("git_change")?.effect).toBe("write");
    expect(byName.get("git_remote")?.effect).toBe("network");
    expect(byName.get("fetch_url")?.effect).toBe("network");
    expect(byName.get("import_github_repository")?.effect).toBe("network");
    expect(byName.has("terminal")).toBe(false);
  });

  it("persists a validated work plan in the virtual workspace", async () => {
    const { registry, workspace } = await harness();
    const tasks = {
      tasks: [
        { id: "inspect", content: "Inspect the relevant workspace", status: "completed" },
        { id: "implement", content: "Implement the requested change", status: "in_progress" },
      ],
    };
    const update = await runTool(registry, "update_tasks", tasks, "tasks-update");
    expect(update.content).toContain("2 tasks");
    expect((await workspace.read(".airship/tasks.json"))?.content).toContain("in_progress");

    const list = await runTool(registry, "list_tasks", {}, "tasks-list");
    expect(JSON.parse(list.content).active.id).toBe("implement");

    await expect(runTool(registry, "update_tasks", {
      tasks: [
        { id: "one", content: "One", status: "in_progress" },
        { id: "two", content: "Two", status: "in_progress" },
      ],
    }, "tasks-invalid")).rejects.toThrow("at most one in-progress");
  });

  it("materializes and searches a revision-pinned client context index", async () => {
    const { registry, workspace } = await harness();
    await workspace.write("docs/engine.md", "The brass turbine routes private context through deterministic local experts.");
    const result = await runTool(registry, "search_context", { query: "private context turbine", limit: 4 }, "context-search");
    const parsed = JSON.parse(result.content);
    expect(parsed.hits[0].path).toBe("/workspace/docs/engine.md");
    expect(parsed.generationDigest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
    expect(result.metadata).toMatchObject({ indexedDocuments: 2 });
  });

  it("uses the browser fetch implementation with bounded textual output", async () => {
    const fetch = async () => new Response("direct from the edge", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    const { registry } = await harness(fetch as typeof globalThis.fetch);
    const result = await runTool(registry, "fetch_url", { url: "https://example.test/readme" }, "fetch-text");
    expect(JSON.parse(result.content)).toMatchObject({ status: 200, text: "direct from the edge", truncated: false });
  });

  it("exposes real browser-owned Git state to the model", async () => {
    const { registry } = await harness();
    const repositories = await runTool(registry, "git_inspect", { action: "repositories" }, "git-repos");
    expect(JSON.parse(repositories.content)[0]).toMatchObject({ id: "workspace", defaultBranch: "main" });
    const status = await runTool(registry, "git_inspect", {
      action: "status",
      repositoryId: "workspace",
      worktreeId: "main",
    }, "git-status");
    expect(JSON.parse(status.content).status[0]).toMatchObject({ path: "README.md" });
  });

  it("routes agent remote work through the authoritative browser Git client", async () => {
    const { registry, git } = await harness();
    const clone = vi.spyOn(git, "clone").mockResolvedValue({
      repository: { id: "cloned" },
      changedPaths: [],
    } as unknown as Awaited<ReturnType<typeof git.clone>>);

    const result = await runTool(registry, "git_remote", {
      action: "clone",
      repositoryId: "cloned",
      name: "owner/repo",
      remoteUrl: "https://github.com/owner/repo.git",
      destination: "/workspace/sources/repo",
    }, "git-clone");

    expect(clone).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: "cloned",
      remoteName: "origin",
      destination: "/workspace/sources/repo",
    }), expect.any(AbortSignal));
    expect(JSON.parse(result.content).repository.id).toBe("cloned");
  });

  it("makes an agent-imported GitHub snapshot visible in workspace and Sources atomically", async () => {
    const fetch = githubSnapshotFetch();
    const { registry, workspace, git } = await harness(fetch);
    const result = await runTool(registry, "import_github_repository", {
      repository: "owner/repo",
      destination: "/workspace/sources/agent-import",
    }, "agent-import");
    const receipt = JSON.parse(result.content);

    expect(receipt.sources).toMatchObject({ admitted: true, state: "unstaged" });
    expect((await workspace.list("/workspace/sources/agent-import")).map((entry) => entry.path)).toEqual([
      "/workspace/sources/agent-import/.airship-import.json",
      "/workspace/sources/agent-import/README.md",
      "/workspace/sources/agent-import/src/index.ts",
    ]);
    const imported = (await git.listRepositories()).find((repository) => repository.id === receipt.sources.repositoryId);
    expect(imported).toMatchObject({ name: "owner/repo" });
    expect(imported?.worktrees[0]?.status.map((entry) => entry.path)).toEqual([
      ".airship-import.json",
      "README.md",
      "src/index.ts",
    ]);
  });
});

async function harness(fetch?: typeof globalThis.fetch) {
  const workspace = new MemoryWorkspace();
  await workspace.write("README.md", "working copy");
  const adapter = await MemoryGitAdapter.create([{
    id: "workspace",
    name: "Workspace",
    files: { "README.md": "initial" },
    workingFiles: { "README.md": "working copy" },
  }]);
  const git = new BrowserGitClient(adapter);
  const registry = await createAirshipToolRegistry({
    workspace,
    journal: new EventJournal(new MemoryJournalBackend()),
    git,
    ...(fetch ? { fetch } : {}),
  });
  return { registry, workspace, git };
}

function githubSnapshotFetch(): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/repos/owner/repo")) return Response.json({ default_branch: "main" });
    if (url.includes("/commits/main")) return Response.json({ sha: "0123456789abcdef0123456789abcdef01234567" });
    if (url.includes("/git/trees/0123456789abcdef0123456789abcdef01234567")) {
      return Response.json({
        truncated: false,
        tree: [
          { type: "blob", path: "README.md", size: 10 },
          { type: "blob", path: "src/index.ts", size: 26 },
        ],
      });
    }
    if (url.endsWith("/README.md")) return new Response("# Imported");
    if (url.endsWith("/src/index.ts")) return new Response("export const edge = true;\n");
    return new Response("missing", { status: 404 });
  }) as typeof globalThis.fetch;
}

async function runTool(
  registry: Awaited<ReturnType<typeof createAirshipToolRegistry>>,
  name: string,
  argumentsValue: Parameters<typeof registry.review>[1],
  operationId: string,
) {
  const context = {
    sessionId: "session",
    turnId: operationId,
    operationId,
    signal: new AbortController().signal,
  };
  expect(await registry.review(name, argumentsValue, context, allowAllForTests)).toBe("allow");
  return registry.executeApproved(name, argumentsValue, context);
}
