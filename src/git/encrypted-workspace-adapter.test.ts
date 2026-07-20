import { describe, expect, it } from "vitest";
import { sha256 } from "../core/hash";
import { MemoryObjectStore } from "../storage/memory-object-store";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { EncryptedObjectWorkspace } from "../vault/encrypted-workspace";
import { BrowserGitClient } from "./client";
import { EncryptedWorkspaceGitAdapter } from "./encrypted-workspace-adapter";
import { GitCheckpointConflictError, GitValidationError, GitVersionConflictError } from "./errors";
import { MemoryGitAdapter } from "./memory-adapter";

const now = () => "2026-07-19T12:00:00.000Z";
const seed = [{
  id: "airship",
  name: "Airship",
  files: { "README.md": "private\n" },
  workingFiles: { "README.md": "private and durable\n", "src/new.ts": "export const edge = true;\n" },
}] as const;

describe("encrypted workspace Git adapter", () => {
  it("migrates an active Ephemeral checkpoint into vault mode and back without flattening Git state", async () => {
    const ephemeral = await MemoryGitAdapter.create(seed, { now });
    const ephemeralClient = new BrowserGitClient(ephemeral);
    const before = (await ephemeralClient.listRepositories())[0]!.worktrees[0]!;
    await ephemeralClient.stage({
      repositoryId: "airship",
      worktreeId: "main",
      paths: ["README.md"],
      expectedWorktreeVersion: before.version,
    });

    const fixture = await encryptedFixture();
    const durableAdapter = await EncryptedWorkspaceGitAdapter.createFromCheckpoint(
      fixture.workspace,
      ephemeral.checkpoint(),
      { now },
    );
    const durable = new BrowserGitClient(durableAdapter);
    expect((await durable.listRepositories())[0]!.worktrees[0]!.status).toEqual([
      expect.objectContaining({ path: "README.md", index: { kind: "modified" }, worktree: null }),
      expect.objectContaining({ path: "src/new.ts", index: null, worktree: { kind: "added" } }),
    ]);

    const returned = new BrowserGitClient(await MemoryGitAdapter.restore(await durable.exportCheckpoint(), { now }));
    const returnedRepository = (await returned.listRepositories())[0]!;
    expect(returnedRepository.storage).toMatchObject({ durable: false, backend: "memory" });
    expect(returnedRepository.worktrees[0]!.status).toEqual((await durable.listRepositories())[0]!.worktrees[0]!.status);

    await returned.stage({
      repositoryId: "airship",
      worktreeId: "main",
      paths: ["src/new.ts"],
      expectedWorktreeVersion: returnedRepository.worktrees[0]!.version,
    });
    const resumedAdapter = await EncryptedWorkspaceGitAdapter.createFromCheckpoint(
      fixture.workspace,
      await returned.exportCheckpoint(),
      { now },
    );
    const resumed = new BrowserGitClient(resumedAdapter);
    expect((await resumed.listRepositories())[0]!.worktrees[0]!.status.every((entry) => entry.index && !entry.worktree)).toBe(true);
  });

  it("refuses to overwrite a vault head changed by another device while Ephemeral mode was active", async () => {
    const fixture = await encryptedFixture();
    const durable = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(fixture.workspace, seed, { now }));
    const offline = new BrowserGitClient(await MemoryGitAdapter.restore(await durable.exportCheckpoint(), { now }));
    const offlineBefore = (await offline.listRepositories())[0]!.worktrees[0]!;
    await offline.stage({
      repositoryId: "airship",
      worktreeId: "main",
      paths: ["README.md"],
      expectedWorktreeVersion: offlineBefore.version,
    });

    const otherWorkspace = new EncryptedObjectWorkspace(fixture.store, fixture.key, fixture.prefix, now);
    const other = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(otherWorkspace, seed, { now }));
    const otherBefore = (await other.listRepositories())[0]!.worktrees[0]!;
    await other.stage({
      repositoryId: "airship",
      worktreeId: "main",
      paths: ["src/new.ts"],
      expectedWorktreeVersion: otherBefore.version,
    });

    await expect(EncryptedWorkspaceGitAdapter.createFromCheckpoint(
      fixture.workspace,
      await offline.exportCheckpoint(),
      { now },
    )).rejects.toBeInstanceOf(GitCheckpointConflictError);
  });

  it("loads the authoritative vault checkpoint during a fresh page bootstrap", async () => {
    const fixture = await encryptedFixture();
    const durable = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(fixture.workspace, seed, { now }));
    const before = (await durable.listRepositories())[0]!.worktrees[0]!;
    await durable.stage({
      repositoryId: "airship",
      worktreeId: "main",
      paths: ["README.md"],
      expectedWorktreeVersion: before.version,
    });

    const freshPage = await MemoryGitAdapter.create([{
      id: "bootstrap",
      name: "Fresh page sample",
      files: { "sample.txt": "must not replace cloud state\n" },
    }], { now });
    const reloadedWorkspace = new EncryptedObjectWorkspace(fixture.store, fixture.key, fixture.prefix, now);
    const adopted = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.createFromCheckpoint(
      reloadedWorkspace,
      freshPage.checkpoint(),
      { now, unbasedExisting: "load" },
    ));

    const repositories = await adopted.listRepositories();
    expect(repositories.map((repository) => repository.id)).toEqual(["airship"]);
    expect(repositories[0]!.worktrees[0]!.status[0]).toMatchObject({
      path: "README.md",
      index: { kind: "modified" },
      worktree: null,
    });
  });

  it("preserves the staged and unstaged planes independently across reload", async () => {
    const fixture = await encryptedFixture();
    const first = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(fixture.workspace, seed, { now }));
    const before = (await first.listRepositories())[0]!.worktrees[0]!;
    await first.stage({
      repositoryId: "airship",
      worktreeId: "main",
      paths: ["README.md"],
      expectedWorktreeVersion: before.version,
    });

    const reloadedWorkspace = new EncryptedObjectWorkspace(fixture.store, fixture.key, fixture.prefix, now);
    const reloaded = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(reloadedWorkspace, seed, { now }));
    const after = (await reloaded.listRepositories())[0]!.worktrees[0]!;
    expect(after.status).toEqual([
      expect.objectContaining({ path: "README.md", index: { kind: "modified" }, worktree: null }),
      expect.objectContaining({ path: "src/new.ts", index: null, worktree: { kind: "added" } }),
    ]);
    expect((await reloaded.diff({
      repositoryId: "airship",
      worktreeId: "main",
      path: "README.md",
      scope: "staged",
    })).patch).toContain("+private and durable");
  });

  it("persists an atomic worktree file move through the encrypted checkpoint", async () => {
    const fixture = await encryptedFixture();
    const first = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(fixture.workspace, seed, { now }));
    const before = (await first.listRepositories())[0]!.worktrees[0]!;
    await first.moveWorkingFile({ repositoryId: "airship", worktreeId: "main", sourcePath: "src/new.ts", targetPath: "src/moved.ts", expectedWorktreeVersion: before.version });

    const reloadedWorkspace = new EncryptedObjectWorkspace(fixture.store, fixture.key, fixture.prefix, now);
    const reloaded = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(reloadedWorkspace, seed, { now }));
    expect((await reloaded.listRepositories())[0]!.worktrees[0]!.status.map((entry) => entry.path)).toEqual(["README.md", "src/moved.ts"]);
  });

  it("restores refs, commits, index, and worktrees after a fresh browser runtime", async () => {
    const fixture = await encryptedFixture();
    const first = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(fixture.workspace, seed, { now }));
    let repository = (await first.listRepositories())[0]!;
    const staged = await first.stage({
      repositoryId: repository.id,
      worktreeId: "main",
      paths: ["README.md", "src/new.ts"],
      expectedWorktreeVersion: repository.worktrees[0]!.version,
    });
    const committed = await first.commit({
      repositoryId: repository.id,
      worktreeId: "main",
      message: "Persist Git at the edge",
      author: { name: "Ada Lovelace", email: "ada@example.com" },
      expectedWorktreeVersion: staged.worktree!.version,
    });
    const branched = await first.createBranch({
      repositoryId: repository.id,
      worktreeId: "main",
      name: "proof/durable",
      expectedWorktreeVersion: committed.worktree!.version,
    });
    await first.createWorktree({
      repositoryId: repository.id,
      worktreeId: "proof",
      path: "proof",
      branch: "proof/durable",
      expectedRepositoryVersion: branched.repository.version,
    });

    // A new workspace and adapter instance models a page reload. Conflicting
    // fallback seeds must not replace the already-committed checkpoint.
    const reloadedWorkspace = new EncryptedObjectWorkspace(fixture.store, fixture.key, fixture.prefix, now);
    const reloaded = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(reloadedWorkspace, [{
      id: "fallback",
      name: "Must not win",
      files: { "lost.txt": "no\n" },
    }], { now }));
    repository = (await reloaded.listRepositories())[0]!;

    expect(repository.id).toBe("airship");
    expect(repository.storage).toMatchObject({ durable: true, backend: "encrypted-workspace" });
    expect(repository.branches.map((branch) => branch.name)).toEqual(["main", "proof/durable"]);
    expect(repository.worktrees.map((worktree) => worktree.id)).toEqual(["main", "proof"]);
    expect(repository.worktrees[0]!.head).toBe(committed.commit);
    expect(repository.worktrees[0]!.status).toEqual([]);
    expect((await reloaded.diff({
      repositoryId: "airship",
      worktreeId: "main",
      path: "README.md",
      scope: "staged",
    })).patch).toBe("");
  });

  it("stores no Git paths, messages, author data, or file content as object-store plaintext", async () => {
    const fixture = await encryptedFixture();
    const client = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(fixture.workspace, seed, { now }));
    const repository = (await client.listRepositories())[0]!;
    const staged = await client.stage({
      repositoryId: "airship",
      worktreeId: "main",
      paths: ["README.md"],
      expectedWorktreeVersion: repository.worktrees[0]!.version,
    });
    await client.commit({
      repositoryId: "airship",
      worktreeId: "main",
      message: "TOP SECRET COMMIT",
      author: { name: "Secret Author", email: "secret@example.com" },
      expectedWorktreeVersion: staged.worktree!.version,
    });

    const records = await fixture.store.list("");
    expect(records.length).toBeGreaterThan(0);
    const serialized = (await Promise.all(records.map(async (record) => {
      const object = await fixture.store.get(record.key);
      return `${record.key}\n${new TextDecoder().decode(object!.bytes)}`;
    }))).join("\n");
    for (const plaintext of ["README.md", "private and durable", "TOP SECRET COMMIT", "Secret Author", "secret@example.com"]) {
      expect(serialized).not.toContain(plaintext);
    }
  });

  it("admits only one concurrent checkpoint writer and leaves the loser retryable", async () => {
    const fixture = await encryptedFixture();
    const left = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(fixture.workspace, seed, { now }));
    const rightWorkspace = new EncryptedObjectWorkspace(fixture.store, fixture.key, fixture.prefix, now);
    const right = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(rightWorkspace, seed, { now }));
    const worktree = (await left.listRepositories())[0]!.worktrees[0]!;
    const request = {
      repositoryId: "airship",
      worktreeId: "main",
      paths: ["README.md"],
      expectedWorktreeVersion: worktree.version,
    };

    const outcomes = await Promise.allSettled([left.stage(request), right.stage(request)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.toSatisfy((error: unknown) =>
        error instanceof GitCheckpointConflictError || error instanceof GitVersionConflictError),
    });

    const verifierWorkspace = new EncryptedObjectWorkspace(fixture.store, fixture.key, fixture.prefix, now);
    const verifier = new BrowserGitClient(await EncryptedWorkspaceGitAdapter.create(verifierWorkspace, seed, { now }));
    expect((await verifier.listRepositories())[0]!.worktrees[0]!.status[0]).toMatchObject({
      path: "README.md",
      index: { kind: "modified" },
      worktree: null,
    });
  });

  it("fails closed when an immutable Git object is replaced through the workspace boundary", async () => {
    const fixture = await encryptedFixture();
    await EncryptedWorkspaceGitAdapter.create(fixture.workspace, seed, { now });
    const digest = await sha256("private\n");
    const objectPath = `/workspace/.airship/git/objects/${digest.slice("sha256:".length)}`;
    const object = await fixture.workspace.read(objectPath);
    expect(object).toBeDefined();
    await fixture.workspace.write(objectPath, "tampered\n", { expectedRevision: object!.revision });

    const reloadedWorkspace = new EncryptedObjectWorkspace(fixture.store, fixture.key, fixture.prefix, now);
    await expect(EncryptedWorkspaceGitAdapter.create(reloadedWorkspace, seed, { now }))
      .rejects.toBeInstanceOf(GitValidationError);
  });
});

async function encryptedFixture(): Promise<{
  store: MemoryObjectStore;
  key: WorkspaceRootKey;
  workspace: EncryptedObjectWorkspace;
  prefix: string;
}> {
  const store = new MemoryObjectStore();
  const key = await WorkspaceRootKey.import(new Uint8Array(32).fill(19));
  const prefix = "tests/encrypted-git";
  return { store, key, prefix, workspace: new EncryptedObjectWorkspace(store, key, prefix, now) };
}
