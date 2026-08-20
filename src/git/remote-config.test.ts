import * as git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import type { WorkspacePort } from "../workspace/contracts";
import { BrowserGitClient } from "./client";
import { WorkspaceGitAdapter } from "./workspace-adapter";
import { WorkspaceGitFileSystem } from "./workspace-fs";

const signal = new AbortController().signal;
const repositoryId = "airship-workspace";

async function seeded(): Promise<{ workspace: MemoryWorkspace; client: BrowserGitClient }> {
  const workspace = new MemoryWorkspace();
  const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
    id: repositoryId,
    name: "Airship Workspace",
    worktreePath: "/workspace",
    files: { "README.md": "seeded\n" },
  }], { now: () => "2026-07-24T10:00:00.000Z" }));
  return { workspace, client };
}

describe("browser Git remote management", () => {
  it("attaches, repoints, and removes a remote in both .git/config and the repository registry", async () => {
    const { client, workspace } = await seeded();
    let repository = (await client.listRepositories(signal))[0]!;
    expect(repository.remotes).toEqual([]);

    repository = (await client.addRemote({
      repositoryId,
      name: "origin",
      url: "https://git.example.test/first.git",
      expectedRepositoryVersion: repository.version,
    }, signal)).repository;

    expect(repository.remotes).toEqual([{ name: "origin", url: "https://git.example.test/first.git", transport: "direct-git-http" }]);
    expect((await workspace.read("/workspace/.git/config"))?.content).toContain("https://git.example.test/first.git");

    repository = (await client.setRemoteUrl({
      repositoryId,
      name: "origin",
      url: "https://git.example.test/second.git",
      expectedRepositoryVersion: repository.version,
    }, signal)).repository;

    expect(repository.remotes.map((remote) => remote.url)).toEqual(["https://git.example.test/second.git"]);
    const config = (await workspace.read("/workspace/.git/config"))!.content;
    expect(config).toContain("https://git.example.test/second.git");
    expect(config).not.toContain("first.git");

    // A reopened adapter reads the registry, so the change has to survive there.
    const reopened = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
    expect((await reopened.listRepositories(signal))[0]!.remotes.map((remote) => remote.name)).toEqual(["origin"]);

    repository = (await client.removeRemote({
      repositoryId,
      name: "origin",
      expectedRepositoryVersion: (await client.getRepository(repositoryId, signal))!.version,
    }, signal)).repository;
    expect(repository.remotes).toEqual([]);
    expect((await workspace.read("/workspace/.git/config"))?.content).not.toContain("git.example.test");
  });

  it("fails closed on a duplicate, a missing remote, and a credential-bearing URL", async () => {
    const { client } = await seeded();
    let repository = (await client.listRepositories(signal))[0]!;
    repository = (await client.addRemote({
      repositoryId,
      name: "origin",
      url: "https://git.example.test/first.git",
      expectedRepositoryVersion: repository.version,
    }, signal)).repository;

    await expect(client.addRemote({
      repositoryId,
      name: "origin",
      url: "https://git.example.test/other.git",
      expectedRepositoryVersion: repository.version,
    }, signal)).rejects.toMatchObject({ code: "remote-exists" });

    await expect(client.setRemoteUrl({
      repositoryId,
      name: "upstream",
      url: "https://git.example.test/other.git",
      expectedRepositoryVersion: repository.version,
    }, signal)).rejects.toMatchObject({ code: "not-found" });

    await expect(client.removeRemote({
      repositoryId,
      name: "upstream",
      expectedRepositoryVersion: repository.version,
    }, signal)).rejects.toMatchObject({ code: "not-found" });

    // Request normalization runs before the promise exists, so this rejection
    // is synchronous by construction.
    expect(() => client.addRemote({
      repositoryId,
      name: "upstream",
      url: "https://user:secret@git.example.test/other.git",
      expectedRepositoryVersion: repository.version,
    }, signal)).toThrow(/credential-free HTTPS/u);

    await expect(client.addRemote({
      repositoryId,
      name: "upstream",
      url: "https://git.example.test/other.git",
      expectedRepositoryVersion: "not-the-current-version",
    }, signal)).rejects.toMatchObject({ code: "version-conflict" });
  });

  it("keeps a newly attached remote unusable while the page policy cannot reach it", async () => {
    // Give the page an origin so fetch is a permitted capability at all: the
    // refusal under test is the policy's verdict on github.com specifically.
    vi.stubGlobal("location", { origin: "https://airship.example.test" });
    try {
      const { client } = await seeded();
      const repository = (await client.listRepositories(signal))[0]!;
      const attached = await client.addRemote({
        repositoryId,
        name: "origin",
        url: "https://github.com/owner/example.git",
        expectedRepositoryVersion: repository.version,
      }, signal);

      await expect(client.fetch({
        repositoryId,
        remote: "origin",
        expectedRepositoryVersion: attached.repository.version,
      }, signal)).rejects.toMatchObject({ code: "remote-origin-not-permitted" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("blocks fetch when canonical .git/config authority diverges from the registry", async () => {
    vi.stubGlobal("location", { origin: "https://git.example.test" });
    const fetch = vi.spyOn(git, "fetch");
    try {
      const { client, workspace } = await seeded();
      const initial = (await client.listRepositories(signal))[0]!;
      await client.addRemote({
        repositoryId,
        name: "origin",
        url: "https://git.example.test/first.git",
        expectedRepositoryVersion: initial.version,
      }, signal);
      const fs = new WorkspaceGitFileSystem(workspace).client;
      await git.addRemote({
        fs,
        dir: "/workspace",
        remote: "origin",
        url: "https://git.example.test/unreviewed.git",
        force: true,
      });
      const repository = (await client.getRepository(repositoryId, signal))!;

      await expect(client.fetch({
        repositoryId,
        remote: "origin",
        expectedRepositoryVersion: repository.version,
      }, signal)).rejects.toMatchObject({ code: "remote-config-diverged" });
      expect(fetch).not.toHaveBeenCalled();
      await expect(client.status({ repositoryId, worktreeId: "main" }, signal))
        .rejects.toMatchObject({ code: "repository-quarantined" });

      await git.addRemote({
        fs,
        dir: "/workspace",
        remote: "origin",
        url: "https://git.example.test/first.git",
        force: true,
      });
      await expect(client.status({ repositoryId, worktreeId: "main" }, signal)).resolves.toBeDefined();
    } finally {
      fetch.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("surfaces registry and rollback failures together and quarantines until external reconciliation", async () => {
    const inner = new MemoryWorkspace();
    const workspace = registryConflictOnce(inner);
    const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
      id: repositoryId,
      name: "Airship Workspace",
      worktreePath: "/workspace",
      files: { "README.md": "seeded\n" },
      remoteUrl: "https://git.example.test/first.git",
    }]));
    const repository = (await client.listRepositories(signal))[0]!;
    const originalAddRemote = git.addRemote;
    let addCalls = 0;
    const addRemote = vi.spyOn(git, "addRemote").mockImplementation(async (options) => {
      addCalls += 1;
      if (addCalls === 2) throw new Error("rollback config write failed");
      return originalAddRemote(options);
    });

    let failure: unknown;
    try {
      await client.setRemoteUrl({
        repositoryId,
        name: "origin",
        url: "https://git.example.test/second.git",
        expectedRepositoryVersion: repository.version,
      }, signal);
    } catch (error) {
      failure = error;
    } finally {
      addRemote.mockRestore();
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ code: "repository-quarantined" });
    expect((failure as AggregateError).errors).toHaveLength(2);
    await expect(client.status({ repositoryId, worktreeId: "main" }, signal))
      .rejects.toMatchObject({ code: "repository-quarantined" });

    // Quarantine is derived from the two durable authorities, so reopening the
    // adapter cannot bypass it.
    const reopened = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace));
    await expect(reopened.status({ repositoryId, worktreeId: "main" }, signal))
      .rejects.toMatchObject({ code: "repository-quarantined" });

    const fs = new WorkspaceGitFileSystem(workspace).client;
    await git.addRemote({
      fs,
      dir: "/workspace",
      remote: "origin",
      url: "https://git.example.test/first.git",
      force: true,
    });
    await expect(reopened.status({ repositoryId, worktreeId: "main" }, signal)).resolves.toBeDefined();
  });

  it("names the refused public hosts from the allowlist rather than from a literal", async () => {
    // A deployment that serves Airship from a Git host has that host permitted.
    // A hard-coded "github.com is refused" sentence would then be a false claim
    // sitting inside the capability report the model reads.
    vi.stubGlobal("location", { origin: "https://github.com" });
    try {
      const { client } = await seeded();
      const remote = client.capabilities.remote;
      const clone = client.capabilities.features.clone;
      expect(remote.permittedOrigins).toEqual(["https://github.com"]);
      expect(clone.available).toBe(true);
      expect(clone.reason).toContain("gitlab.com included");
      expect(clone.reason).not.toContain("github.com included");
      expect(remote.detail).toContain("gitlab.com is not among them");
      expect(remote.detail).not.toContain("github.com and gitlab.com are not among them");
      // The importer is only offered while github.com itself is unreachable.
      expect(remote.detail).not.toContain("snapshot importer");
    } finally {
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
        pending
        && path.endsWith("/.airship/browser-git-repositories.v1.json")
        && typeof options?.expectedRevision === "string"
      ) {
        pending = false;
        const current = await inner.read(path);
        if (current) await inner.write(path, current.content, { expectedRevision: current.revision });
      }
      return inner.write(path, content, options);
    },
    remove: (path, options) => inner.remove(path, options),
  };
}
