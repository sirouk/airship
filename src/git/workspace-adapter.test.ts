import * as git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import type { WorkspacePort } from "../workspace/contracts";
import { moveWorkspaceFile } from "../workspace/mutations";
import { BrowserGitClient } from "./client";
import { WorkspaceGitAdapter } from "./workspace-adapter";
import { WorkspaceGitFileSystem, decodeWorkspaceBytes } from "./workspace-fs";

const signal = new AbortController().signal;

describe("WorkspaceGitAdapter", () => {
  it("starts a seeded workspace clean when the baseline contains its complete file tree", async () => {
    const workspace = new MemoryWorkspace();
    const files = {
      "README.md": "# Airship\n",
      "docs/architecture.md": "The browser owns orchestration.\n",
      "notes/retrieval.md": "Context follows the task.\n",
    };
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files,
    }]));

    expect((await client.listRepositories())[0]!.worktrees[0]!.status).toEqual([]);
  });

  it("keeps worktree, index, refs and object database in one authoritative workspace", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "working copy\n");
    const adapter = await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "committed copy\n" },
      workingFiles: { "README.md": "working copy\n" },
    }], { now: () => "2026-07-22T12:00:00.000Z" });
    const client = new BrowserGitClient(adapter);

    const files = await workspace.list("/workspace/.git");
    expect(files.some((entry) => entry.path === "/workspace/.git/HEAD")).toBe(true);
    expect(files.some((entry) => entry.path === "/workspace/.git/index")).toBe(true);
    expect(files.some((entry) => entry.path.startsWith("/workspace/.git/objects/"))).toBe(true);
    expect(files.some((entry) => entry.path === "/workspace/.git/refs/heads/main")).toBe(true);

    const repository = (await client.listRepositories(signal))[0]!;
    expect(repository.worktrees[0]!.status).toEqual([expect.objectContaining({
      path: "README.md",
      worktree: { kind: "modified" },
      index: null,
    })]);

    const staged = await client.stage({
      repositoryId: repository.id,
      worktreeId: "main",
      paths: ["README.md"],
      expectedWorktreeVersion: repository.worktrees[0]!.version,
    }, signal);
    expect(staged.worktree!.status[0]!.index).toEqual({ kind: "modified" });
    expect(staged.worktree!.status[0]!.worktree).toBeNull();

    const committed = await client.commit({
      repositoryId: repository.id,
      worktreeId: "main",
      message: "Update README",
      author: { name: "Airship Test", email: "airship@example.test" },
      expectedWorktreeVersion: staged.worktree!.version,
    }, signal);
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(committed.worktree!.status).toEqual([]);

    const fs = new WorkspaceGitFileSystem(workspace).client;
    const log = await git.log({ fs, dir: "/workspace" });
    expect(log[0]!.oid).toBe(committed.commit);
    expect(log[0]!.commit.message.trim()).toBe("Update README");
    expect(decodeWorkspaceBytes((await workspace.read("/workspace/.git/index"))!.content).slice(0, 4))
      .toEqual(Uint8Array.from([0x44, 0x49, 0x52, 0x43]));
  });

  it("creates genuine linked worktrees with isolated indexes and one shared object/ref database", async () => {
    const workspace = new MemoryWorkspace();
    const repositoryRoot = "/workspace/sources/application";
    const linkedRoot = "/workspace/checkouts/proof";
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "application",
      name: "Application",
      worktreePath: repositoryRoot,
      files: { "README.md": "main\n" },
    }], { now: () => "2026-07-22T12:00:00.000Z" }));

    let repository = (await client.listRepositories())[0]!;
    const primaryHead = repository.worktrees[0]!.head;
    const branched = await client.createBranch({
      repositoryId: repository.id,
      worktreeId: repository.worktrees[0]!.id,
      name: "feature/proof",
      expectedWorktreeVersion: repository.worktrees[0]!.version,
    });
    const created = await client.createWorktree({
      repositoryId: repository.id,
      worktreeId: "proof",
      path: linkedRoot,
      branch: "feature/proof",
      expectedRepositoryVersion: branched.repository.version,
    });
    repository = created.repository;

    expect(client.capabilities.features.worktree).toEqual({ available: true });
    expect(repository.worktrees.map(({ id, path, branch }) => ({ id, path, branch }))).toEqual([
      { id: "main", path: repositoryRoot, branch: "main" },
      { id: "proof", path: linkedRoot, branch: "feature/proof" },
    ]);
    const dotgit = (await workspace.read(`${linkedRoot}/.git`))!.content;
    expect(dotgit).toMatch(/^gitdir: \/workspace\/sources\/application\/\.git\/worktrees\/wt-[A-Za-z0-9_-]+\n$/u);
    const adminGitdir = dotgit.slice("gitdir: ".length).trim();
    expect((await workspace.read(`${adminGitdir}/commondir`))?.content).toBe("../..\n");
    expect((await workspace.read(`${adminGitdir}/gitdir`))?.content).toBe(`${linkedRoot}/.git\n`);
    expect(await workspace.read(`${adminGitdir}/index`)).toBeDefined();
    expect((await workspace.list(adminGitdir)).some((entry) => entry.path.startsWith(`${adminGitdir}/objects/`))).toBe(false);
    expect((await workspace.list(`${repositoryRoot}/.git/objects`)).length).toBeGreaterThan(0);

    const main = repository.worktrees.find((worktree) => worktree.id === "main")!;
    await expect(client.switchBranch({
      repositoryId: repository.id,
      worktreeId: main.id,
      name: "feature/proof",
      expectedWorktreeVersion: main.version,
    })).rejects.toMatchObject({ code: "branch-checked-out" });

    let proof = repository.worktrees.find((worktree) => worktree.id === "proof")!;
    proof = await client.writeWorkingFile({
      repositoryId: repository.id,
      worktreeId: proof.id,
      path: "README.md",
      content: "proof\n",
      expectedWorktreeVersion: proof.version,
    });
    const staged = await client.stage({
      repositoryId: repository.id,
      worktreeId: proof.id,
      paths: ["README.md"],
      expectedWorktreeVersion: proof.version,
    });
    const committed = await client.commit({
      repositoryId: repository.id,
      worktreeId: proof.id,
      message: "Prove linked worktree isolation",
      author: { name: "Airship Test", email: "airship@example.test" },
      expectedWorktreeVersion: staged.worktree!.version,
    });
    expect(committed.worktree?.head).toBe(committed.commit);
    expect(committed.repository.worktrees.find((worktree) => worktree.id === "main")?.head).toBe(primaryHead);
    expect((await workspace.read(`${repositoryRoot}/.git/refs/heads/feature/proof`))?.content.trim()).toBe(committed.commit);
    expect((await workspace.list(adminGitdir)).some((entry) => entry.path.startsWith(`${adminGitdir}/objects/`))).toBe(false);

    const reopened = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
    repository = (await reopened.listRepositories())[0]!;
    expect(repository.worktrees.map((worktree) => worktree.id)).toEqual(["main", "proof"]);
    expect(repository.worktrees.find((worktree) => worktree.id === "proof")?.status).toEqual([]);
    const removed = await reopened.removeWorktree({
      repositoryId: repository.id,
      worktreeId: "proof",
      expectedRepositoryVersion: repository.version,
    });
    expect(removed.repository.worktrees.map((worktree) => worktree.id)).toEqual(["main"]);
    expect(await workspace.list(linkedRoot)).toEqual([]);
    expect(await workspace.list(adminGitdir)).toEqual([]);
    expect((await workspace.list(`${repositoryRoot}/.git/objects`)).length).toBeGreaterThan(0);
    expect(removed.repository.branches.map((branch) => branch.name)).toContain("feature/proof");
  });

  it("opens the pre-linked-worktree registry shape as a one-worktree migration", async () => {
    const workspace = new MemoryWorkspace();
    await WorkspaceGitAdapter.open(workspace, [{
      id: "legacy",
      name: "Legacy registry",
      worktreePath: "/workspace/sources/legacy",
      files: { "README.md": "legacy\n" },
    }]);
    const registryPath = "/workspace/.airship/browser-git-repositories.v1.json";
    const current = (await workspace.read(registryPath))!;
    const registry = JSON.parse(current.content) as { repositories: Array<Record<string, unknown>> };
    delete registry.repositories[0]!.linkedWorktrees;
    await workspace.write(registryPath, `${JSON.stringify(registry)}\n`, { expectedRevision: current.revision });

    const reopened = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
    expect((await reopened.listRepositories())[0]!.worktrees.map((worktree) => worktree.id)).toEqual(["main"]);
  });

  it("keeps a linked checkout nested under the root workspace out of the primary worktree status", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "main\n" },
    }]));
    let repository = (await client.listRepositories())[0]!;
    const branched = await client.createBranch({
      repositoryId: repository.id,
      worktreeId: "main",
      name: "feature/nested",
      expectedWorktreeVersion: repository.worktrees[0]!.version,
    });
    repository = (await client.createWorktree({
      repositoryId: repository.id,
      worktreeId: "nested",
      path: "/workspace/worktrees/nested",
      branch: "feature/nested",
      expectedRepositoryVersion: branched.repository.version,
    })).repository;

    expect(repository.worktrees.find((worktree) => worktree.id === "main")?.status).toEqual([]);
    expect((await workspace.read("/workspace/.git/info/exclude"))?.content).toContain("/worktrees/nested/");
  });

  it("permits a nested repository worktree inside its registered workspace container without polluting the container status", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [
      {
        id: "airship-workspace",
        name: "Airship Workspace",
        worktreePath: "/workspace",
        files: { "README.md": "workspace\n" },
      },
      {
        id: "application",
        name: "Application",
        worktreePath: "/workspace/sources/application",
        files: { "README.md": "application\n" },
      },
    ]));
    let application = (await client.listRepositories()).find((repository) => repository.id === "application")!;
    const branched = await client.createBranch({
      repositoryId: application.id,
      worktreeId: "main",
      name: "feature/container-safe",
      expectedWorktreeVersion: application.worktrees[0]!.version,
    });
    application = (await client.createWorktree({
      repositoryId: application.id,
      worktreeId: "container-safe",
      path: "/workspace/worktrees/application-safe",
      branch: "feature/container-safe",
      expectedRepositoryVersion: branched.repository.version,
    })).repository;

    const root = (await client.listRepositories()).find((repository) => repository.id === "airship-workspace")!;
    expect(root.worktrees[0]!.status).toEqual([]);
    expect((await workspace.read("/workspace/.git/info/exclude"))?.content)
      .toContain("# airship linked worktree application/container-safe begin\n/worktrees/application-safe/");

    const reopened = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
    application = (await reopened.listRepositories()).find((repository) => repository.id === "application")!;
    expect(application.worktrees.map(({ id }) => id)).toEqual(["main", "container-safe"]);
    await reopened.removeWorktree({
      repositoryId: application.id,
      worktreeId: "container-safe",
      expectedRepositoryVersion: application.version,
    });
    expect((await workspace.read("/workspace/.git/info/exclude"))?.content).not.toContain("application/container-safe");
  });

  it("imports a public snapshot as the clean local repository baseline", async () => {
    const workspace = new MemoryWorkspace();
    const destination = "/workspace/sources/example";
    await workspace.write(`${destination}/README.md`, "# Example\n");
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
    const imported = await client.importSnapshot({
      repositoryId: "snapshot-example",
      name: "owner/example",
      destination,
      sourceUrl: "https://github.com/owner/example",
      defaultBranch: "main",
      files: { "README.md": "# Example\n" },
    }, signal);

    expect(imported.worktree!.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(imported.worktree!.status).toEqual([]);
    await workspace.write(`${destination}/README.md`, "# Edited locally\n");
    expect((await client.status({ repositoryId: "snapshot-example", worktreeId: "main" })).status).toEqual([
      expect.objectContaining({ path: "README.md", index: null, worktree: { kind: "modified" } }),
    ]);
    const paths = (await workspace.list(`${destination}/.git`)).map((entry) => entry.path);
    expect(paths).toContain(`${destination}/.git/HEAD`);
    expect(paths).toContain(`${destination}/.git/index`);
    expect(paths.some((path) => path.startsWith(`${destination}/.git/objects/`))).toBe(true);

    const reopened = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
    expect((await reopened.listRepositories())[0]!.id).toBe("snapshot-example");
  });

  it("rebases repository admission over one concurrent registry update", async () => {
    const workspace = registryConflictOnce(new MemoryWorkspace());
    const destination = "/workspace/sources/concurrent";
    await workspace.write(`${destination}/README.md`, "# Concurrent\n");
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));

    const imported = await client.importSnapshot({
      repositoryId: "snapshot-concurrent",
      name: "owner/concurrent",
      destination,
      sourceUrl: "https://github.com/owner/concurrent",
      defaultBranch: "main",
      files: { "README.md": "# Concurrent\n" },
    }, signal);

    expect(imported.repository.id).toBe("snapshot-concurrent");
    const reopened = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
    expect((await reopened.listRepositories()).map(({ id }) => id)).toContain("snapshot-concurrent");
    expect(await workspace.read(`${destination}/.git/HEAD`)).toBeDefined();
  });

  it("accepts an Editor-projected move at the reviewed version without weakening unrelated revision checks", async () => {
    const workspace = new MemoryWorkspace();
    const adapter = await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "src/old.ts": "export const value = 1;\n", "README.md": "stable\n" },
    }]);
    const client = new BrowserGitClient(adapter);
    const before = (await client.listRepositories())[0]!.worktrees[0]!;

    await moveWorkspaceFile(workspace, "/workspace/src/old.ts", "/workspace/src/new.ts");
    const moved = await client.moveWorkingFile({
      repositoryId: "airship-workspace",
      worktreeId: "main",
      sourcePath: "src/old.ts",
      targetPath: "src/new.ts",
      expectedWorktreeVersion: before.version,
    });

    expect(await workspace.read("/workspace/src/old.ts")).toBeUndefined();
    expect((await workspace.read("/workspace/src/new.ts"))?.content).toContain("value = 1");
    expect(moved.status).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/new.ts", worktree: { kind: "added" } }),
      expect.objectContaining({ path: "src/old.ts", worktree: { kind: "deleted" } }),
    ]));
  });

  it("sees a same-length rewrite made inside the same wall-clock second", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "a.txt": "tracked1\n", "b.txt": "tracked2\n" },
    }]));
    expect((await client.status({ repositoryId: "airship-workspace", worktreeId: "main" }, signal)).status).toEqual([]);

    // Same byte length, same second: the index stat cache compares only
    // whole-second mtimes, so only a changing inode can expose this.
    const current = (await workspace.read("/workspace/a.txt"))!;
    await workspace.write("/workspace/a.txt", "MUTATED1\n", { expectedRevision: current.revision });
    expect((await client.status({ repositoryId: "airship-workspace", worktreeId: "main" }, signal)).status)
      .toEqual([expect.objectContaining({ path: "a.txt", index: null, worktree: { kind: "modified" } })]);

    // The miss was permanent, not merely sub-second, so it must stay visible.
    await Promise.resolve();
    const stable = await client.status({ repositoryId: "airship-workspace", worktreeId: "main" }, signal);
    expect(stable.status.map((entry) => entry.path)).toEqual(["a.txt"]);

    const written = await client.writeWorkingFile({
      repositoryId: "airship-workspace",
      worktreeId: "main",
      path: "b.txt",
      content: "MUTATED2\n",
      expectedWorktreeVersion: stable.version,
    }, signal);
    expect(written.status.map((entry) => entry.path)).toEqual(["a.txt", "b.txt"]);

    const staged = await client.stage({
      repositoryId: "airship-workspace",
      worktreeId: "main",
      paths: ["a.txt", "b.txt"],
      expectedWorktreeVersion: written.version,
    }, signal);
    expect(staged.changedPaths).toEqual(["a.txt", "b.txt"]);
    expect(staged.worktree!.status.every((entry) => entry.index?.kind === "modified")).toBe(true);
  });

  it("stages one reviewed request that covers more paths than a single adapter call may carry", async () => {
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "seeded\n" },
    }]));
    const paths = Array.from({ length: 520 }, (_, index) => `generated/file-${String(index).padStart(4, "0")}.txt`);
    for (const path of paths) await workspace.write(`/workspace/${path}`, `${path}\n`);

    const before = await client.status({ repositoryId: "airship-workspace", worktreeId: "main" }, signal);
    expect(before.status).toHaveLength(paths.length);
    const staged = await client.stage({
      repositoryId: "airship-workspace",
      worktreeId: "main",
      paths,
      expectedWorktreeVersion: before.version,
    }, signal);

    expect(staged.changedPaths).toHaveLength(paths.length);
    expect(staged.worktree!.status.every((entry) => entry.index?.kind === "added" && entry.worktree === null)).toBe(true);
    const committed = await client.commit({
      repositoryId: "airship-workspace",
      worktreeId: "main",
      message: "Commit an imported tree",
      author: { name: "Airship Test", email: "airship@example.test" },
      expectedWorktreeVersion: staged.worktree!.version,
    }, signal);
    expect(committed.worktree!.status).toEqual([]);
  }, 120_000);

  it("enforces its own Git remote policy for an unapproved host instead of the remote, and never sends the request", async () => {
    const workspace = new MemoryWorkspace();
    // A page origin is what makes clone reachable at all, so the refusal under
    // test is the policy's verdict on the *target* host, not the absence of a
    // document origin.
    vi.stubGlobal("location", { origin: "https://airship.example.test" });
    const clone = vi.spyOn(git, "clone");
    try {
      const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
      expect(client.capabilities.remote.permittedOrigins).not.toContain("https://github.com");
      expect(client.capabilities.remote.detail).toContain("Git egress policy");
      expect(client.capabilities.features.clone.available).toBe(true);
      await expect(client.clone({
        repositoryId: "blocked",
        name: "Blocked",
        remoteUrl: "https://github.com/owner/example.git",
        destination: "/workspace/sources/blocked",
      }, signal)).rejects.toMatchObject({ code: "remote-origin-not-permitted" });
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("reports clone, fetch, and push as available only for the origins the page policy actually permits", async () => {
    const workspace = new MemoryWorkspace();
    const clone = vi.spyOn(git, "clone");
    try {
      // No document origin and an empty Git allowlist permit nothing, so the three remote
      // verbs must not claim availability the runtime never grants.
      const blocked = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
      expect(blocked.capabilities.remote.permittedOrigins).toEqual([]);
      for (const feature of ["clone", "fetch", "push"] as const) {
        expect(blocked.capabilities.features[feature]).toMatchObject({ available: false });
        expect(blocked.capabilities.features[feature].reason).toContain("no document origin");
      }
      await expect(blocked.clone({
        repositoryId: "blocked",
        name: "Blocked",
        remoteUrl: "https://git.example.test/repository.git",
        destination: "/workspace/sources/blocked",
      }, signal)).rejects.toMatchObject({ code: "capability-unavailable" });
      expect(clone).not.toHaveBeenCalled();

      vi.stubGlobal("location", { origin: "https://airship.example.test" });
      const reachable = new BrowserGitClient(await WorkspaceGitAdapter.open(new MemoryWorkspace()));
      for (const feature of ["clone", "fetch", "push"] as const) {
        expect(reachable.capabilities.features[feature]).toMatchObject({ available: true });
        // The claim is scoped, and the record says exactly how far it reaches.
        expect(reachable.capabilities.features[feature].reason).toContain("https://airship.example.test");
        expect(reachable.capabilities.features[feature].reason).toContain("Git egress policy");
      }
    } finally {
      clone.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("fails a policy-permitted remote honestly at the transport without inventing a CORS refusal", async () => {
    vi.stubGlobal("location", { origin: "https://git.example.test" });
    const clone = vi.spyOn(git, "clone").mockRejectedValue(new TypeError("Failed to fetch"));
    try {
      const workspace = new MemoryWorkspace();
      const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
      expect(client.capabilities.remote.permittedOrigins).toEqual(["https://git.example.test"]);
      await expect(client.clone({
        repositoryId: "permitted",
        name: "Permitted",
        remoteUrl: "https://git.example.test/repository.git",
        destination: "/workspace/sources/permitted",
      }, signal)).rejects.toThrow(/this page's own origin, so no CORS grant was required[\s\S]*No Airship proxy was used/u);
    } finally {
      clone.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("pushes through real Smart HTTP with separately injected page-memory credentials", async () => {
    const workspace = new MemoryWorkspace();
    vi.stubGlobal("location", { origin: "https://git.example.test" });
    let brokerCalls = 0;
    let observedAuth: unknown;
    const push = vi.spyOn(git, "push").mockImplementation(async (options) => {
      observedAuth = await options.onAuth?.("https://git.example.test/repository.git", { username: "challenge" });
      return { ok: true, error: null, refs: { "refs/heads/main": { ok: true, error: "" } } };
    });
    try {
      const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
        id: "airship-workspace",
        name: "Airship Workspace",
        worktreePath: "/workspace",
        files: { "README.md": "ready\n" },
        remoteUrl: "https://git.example.test/repository.git",
      }], {
        authenticate: async ({ origin, challengeUsername }) => {
          brokerCalls += 1;
          expect(origin).toBe("https://git.example.test");
          expect(challengeUsername).toBe("challenge");
          return { username: "memory-user", password: "memory-token" };
        },
      }));
      const repository = (await client.listRepositories())[0]!;
      expect(client.capabilities.remote.credentialPersistence).toBe("memory-only");
      expect(client.capabilities.features.push.available).toBe(true);

      const result = await client.push({
        repositoryId: repository.id,
        worktreeId: repository.worktrees[0]!.id,
        remote: "origin",
        branch: "main",
        expectedWorktreeVersion: repository.worktrees[0]!.version,
      });

      expect(result.worktree?.head).toBe(repository.worktrees[0]!.head);
      expect(brokerCalls).toBe(1);
      expect(observedAuth).toEqual({ username: "memory-user", password: "memory-token" });
      expect((await workspace.read("/workspace/.git/config"))?.content).not.toContain("memory-token");
      expect((await workspace.read("/workspace/.airship/browser-git-repositories.v1.json"))?.content).not.toContain("memory-token");
    } finally {
      push.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("marks a disconnected push outcome as unknown instead of claiming rollback", async () => {
    const workspace = new MemoryWorkspace();
    vi.stubGlobal("location", { origin: "https://git.example.test" });
    const push = vi.spyOn(git, "push").mockRejectedValue(new TypeError("stream ended after upload"));
    try {
      const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
        id: "airship-workspace",
        name: "Airship Workspace",
        worktreePath: "/workspace",
        files: { "README.md": "ready\n" },
        remoteUrl: "https://git.example.test/repository.git",
      }]));
      const repository = (await client.listRepositories())[0]!;
      await expect(client.push({
        repositoryId: repository.id,
        worktreeId: repository.worktrees[0]!.id,
        remote: "origin",
        branch: "main",
        expectedWorktreeVersion: repository.worktrees[0]!.version,
      })).rejects.toMatchObject({ code: "push-outcome-unknown" });
    } finally {
      push.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

function registryConflictOnce(inner: MemoryWorkspace): WorkspacePort {
  let pending = true;
  return {
    read: (path) => inner.read(path),
    readBounded: (path, maxBytes) => inner.readBounded(path, maxBytes),
    list: (path) => inner.list(path),
    async write(path, content, options) {
      if (
        pending &&
        path.endsWith("/.airship/browser-git-repositories.v1.json") &&
        typeof options?.expectedRevision === "string"
      ) {
        pending = false;
        const current = await inner.read(path);
        if (current) {
          await inner.write(path, current.content, { expectedRevision: current.revision });
        }
      }
      return inner.write(path, content, options);
    },
    remove: (path, options) => inner.remove(path, options),
  };
}

describe("Airship control-plane fence", () => {
  /*
   * The workspace-rooted repository is the dangerous case: its worktree root is
   * `/workspace`, so a repository-relative path like
   * `.airship/endpoint-evidence/...` resolves straight onto Airship's own
   * records. `.git/info/exclude` keeps those paths out of ordinary status, but
   * exclusion is not authorization — forced staging exists precisely to
   * override it, and `diff` never consulted it at all.
   *
   * The fence lives in the filesystem projection rather than in each verb, so
   * these assert through the real client: read, forced stage, and the tree
   * materialization that checkout, merge, restore and reset all share.
   */
  async function workspaceRepository() {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/.airship/endpoint-evidence/general/receipt.json", '{"quote":"private"}');
    const adapter = await WorkspaceGitAdapter.open(workspace, [{
      id: "airship-workspace",
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "committed\n" },
    }], { now: () => "2026-07-22T12:00:00.000Z" });
    return { workspace, client: new BrowserGitClient(adapter) };
  }

  it("will not read private evidence through a repository-relative diff", async () => {
    const { workspace, client } = await workspaceRepository();
    const repository = (await client.listRepositories(signal))[0]!;
    // Reads answer "absent" rather than "refused" — the same answer the status
    // walk gets, and one that does not confirm what is stored there. What
    // matters is the byte count: this used to render the private record.
    const diff = await client.diff({
      repositoryId: repository.id,
      worktreeId: repository.worktrees[0]!.id,
      path: ".airship/endpoint-evidence/general/receipt.json",
      scope: "worktree",
    }, signal);
    expect(diff.patch).not.toContain("private");
    expect(diff.byteLength).toBe(0);
    expect((await workspace.read("/workspace/.airship/endpoint-evidence/general/receipt.json"))!.content)
      .toContain("private");
  });

  it("will not force-stage a control-plane path into history", async () => {
    const { client } = await workspaceRepository();
    const repository = (await client.listRepositories(signal))[0]!;
    await expect(client.stage({
      repositoryId: repository.id,
      worktreeId: repository.worktrees[0]!.id,
      paths: [".airship/endpoint-evidence/general/receipt.json"],
      force: true,
      expectedWorktreeVersion: repository.worktrees[0]!.version,
    }, signal)).rejects.toThrow();
  });

  it("never offers the reserved namespace to a status walk", async () => {
    const { workspace, client } = await workspaceRepository();
    const repository = (await client.listRepositories(signal))[0]!;
    expect(repository.worktrees[0]!.status.map((entry) => entry.path))
      .not.toContain(".airship/endpoint-evidence/general/receipt.json");
    const fs = new WorkspaceGitFileSystem(workspace).client;
    expect(await fs.promises.readdir("/workspace")).not.toContain(".airship");
    // The record itself is untouched: this fences Git, it does not delete data.
    expect(await workspace.read("/workspace/.airship/endpoint-evidence/general/receipt.json")).toBeDefined();
  });

  it("refuses to materialize a tree over the reserved namespace, and refuses to read it", async () => {
    const workspace = new MemoryWorkspace();
    const fs = new WorkspaceGitFileSystem(workspace);
    await expect(fs.writeText("/workspace/.airship/evidence-acquisition/profiles/general/queue.v1.json", "{}"))
      .rejects.toMatchObject({ code: "EPERM" });
    await workspace.write("/workspace/.airship/queue.v1.json", "{}");
    await expect(fs.client.promises.readFile("/workspace/.airship/queue.v1.json"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.client.promises.unlink("/workspace/.airship/queue.v1.json"))
      .rejects.toMatchObject({ code: "EPERM" });
    expect(await workspace.read("/workspace/.airship/queue.v1.json")).toBeDefined();
  });

  it("leaves a repository's own nested .airship directory writable and committable", async () => {
    // Only the root tree is reserved. A cloned repository that carries its own
    // `.airship` directory is user content, and fencing it would corrupt the
    // repository rather than protect Airship.
    const workspace = new MemoryWorkspace();
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: "application",
      name: "Application",
      worktreePath: "/workspace/sources/application",
      files: { "README.md": "main\n" },
    }], { now: () => "2026-07-22T12:00:00.000Z" }));
    const repository = (await client.listRepositories(signal))[0]!;
    const worktree = repository.worktrees[0]!;

    const written = await client.writeWorkingFile({
      repositoryId: repository.id,
      worktreeId: worktree.id,
      path: ".airship/tasks.json",
      content: '{"tasks":[]}',
      expectedWorktreeVersion: worktree.version,
    }, signal);
    const staged = await client.stage({
      repositoryId: repository.id,
      worktreeId: worktree.id,
      paths: [".airship/tasks.json"],
      expectedWorktreeVersion: written.version,
    }, signal);
    expect(staged.worktree!.status[0]).toMatchObject({ path: ".airship/tasks.json", index: { kind: "added" } });
  });
});
