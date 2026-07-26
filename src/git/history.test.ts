import { describe, expect, it } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import { BrowserGitClient } from "./client";
import { WorkspaceGitAdapter } from "./workspace-adapter";

const signal = new AbortController().signal;
const author = { name: "Airship Test", email: "airship@example.test" } as const;

async function seeded(files: Record<string, string>): Promise<{ workspace: MemoryWorkspace; client: BrowserGitClient }> {
  const workspace = new MemoryWorkspace();
  const client = new BrowserGitClient(await WorkspaceGitAdapter.open(workspace, [{
    id: "airship-workspace",
    name: "Airship Workspace",
    worktreePath: "/workspace",
    files,
  }], { now: () => "2026-07-24T10:00:00.000Z" }));
  return { workspace, client };
}

async function commitFile(client: BrowserGitClient, path: string, content: string, message: string): Promise<string> {
  const before = (await client.listRepositories(signal))[0]!.worktrees[0]!;
  const written = await client.writeWorkingFile({
    repositoryId: "airship-workspace",
    worktreeId: "main",
    path,
    content,
    expectedWorktreeVersion: before.version,
  }, signal);
  const staged = await client.stage({
    repositoryId: "airship-workspace",
    worktreeId: "main",
    paths: [path],
    expectedWorktreeVersion: written.version,
  }, signal);
  const committed = await client.commit({
    repositoryId: "airship-workspace",
    worktreeId: "main",
    message,
    author,
    expectedWorktreeVersion: staged.worktree!.version,
  }, signal);
  return committed.commit!;
}

describe("browser Git history reads", () => {
  it("reads the real commit chain the adapter wrote, newest first and bounded by depth", async () => {
    const { client, workspace } = await seeded({ "README.md": "one\n" });
    const second = await commitFile(client, "README.md", "two\n", "Second commit");
    const third = await commitFile(client, "src/app.ts", "export const value = 1;\n", "Third commit");

    const log = await client.log({ repositoryId: "airship-workspace", worktreeId: "main" }, signal);
    expect(log.map((entry) => entry.message.trim())).toEqual(["Third commit", "Second commit", "Initial browser workspace"]);
    expect(log[0]!.oid).toBe(third);
    expect(log[0]!.parents).toEqual([second]);
    expect(log[0]!.author).toEqual(author);
    expect(log[0]!.committedAt).toBe("2026-07-24T10:00:00.000Z");
    expect(log.at(-1)!.parents).toEqual([]);

    const bounded = await client.log({ repositoryId: "airship-workspace", worktreeId: "main", depth: 1 }, signal);
    expect(bounded).toHaveLength(1);
    expect(bounded[0]!.oid).toBe(third);

    // The oids in the log are the oids in the real loose object database.
    const objects = (await workspace.list("/workspace/.git/objects")).map((entry) => entry.path);
    expect(objects).toContain(`/workspace/.git/objects/${third.slice(0, 2)}/${third.slice(2)}`);
  });

  it("filters history by path and fails closed on an unknown revision", async () => {
    const { client } = await seeded({ "README.md": "one\n" });
    await commitFile(client, "README.md", "two\n", "Touch readme");
    const appCommit = await commitFile(client, "src/app.ts", "export const value = 1;\n", "Add app");

    const scoped = await client.log({ repositoryId: "airship-workspace", worktreeId: "main", path: "src/app.ts" }, signal);
    expect(scoped.map((entry) => entry.oid)).toEqual([appCommit]);

    await expect(client.log({ repositoryId: "airship-workspace", worktreeId: "main", ref: "does-not-exist" }, signal))
      .rejects.toThrow();
    await expect(client.log({ repositoryId: "airship-workspace", worktreeId: "main", depth: 0 }, signal))
      .rejects.toThrow(/between 1 and 512/u);
  });

  it("shows one commit as a patch against its first parent", async () => {
    const { client } = await seeded({ "README.md": "one\n", "keep.txt": "keep\n" });
    const changed = await commitFile(client, "README.md", "two\n", "Rewrite readme");

    const detail = await client.show({ repositoryId: "airship-workspace", worktreeId: "main", revision: changed }, signal);
    expect(detail.commit.oid).toBe(changed);
    expect(detail.commit.message.trim()).toBe("Rewrite readme");
    expect(detail.truncated).toBe(false);
    expect(detail.files.map((file) => ({ path: file.path, kind: file.kind }))).toEqual([
      { path: "README.md", kind: "modified" },
    ]);
    expect(detail.files[0]!.patch).toContain("-one");
    expect(detail.files[0]!.patch).toContain("+two");
  });

  it("shows a root commit against the empty tree and resolves a branch name", async () => {
    const { client } = await seeded({ "README.md": "one\n", "src/app.ts": "export const value = 1;\n" });
    const detail = await client.show({ repositoryId: "airship-workspace", worktreeId: "main", revision: "main" }, signal);
    expect(detail.commit.parents).toEqual([]);
    expect(detail.files.map((file) => `${file.kind} ${file.path}`)).toEqual(["added README.md", "added src/app.ts"]);
  });

  it("bounds the per-commit patch fan-out and reports the truncation", async () => {
    const files = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`file-${index}.txt`, `${index}\n`]));
    const { client } = await seeded(files);
    const detail = await client.show({
      repositoryId: "airship-workspace",
      worktreeId: "main",
      revision: "main",
      maxPaths: 2,
    }, signal);
    expect(detail.files).toHaveLength(2);
    expect(detail.truncated).toBe(true);
  });
});

describe("browser Git tags", () => {
  it("writes real lightweight and annotated tag refs and refuses a duplicate", async () => {
    const { client, workspace } = await seeded({ "README.md": "one\n" });
    let repository = (await client.listRepositories(signal))[0]!;
    expect(await client.listTags(repository.id, signal)).toEqual([]);

    const tagged = await client.createTag({
      repositoryId: repository.id,
      name: "v1.0.0",
      expectedRepositoryVersion: repository.version,
    }, signal);
    repository = tagged.repository;
    const head = repository.worktrees[0]!.head;
    expect((await workspace.read("/workspace/.git/refs/tags/v1.0.0"))?.content.trim()).toBe(head);

    const annotated = await client.createTag({
      repositoryId: repository.id,
      name: "v1.0.1",
      message: "First annotated release\n",
      author,
      expectedRepositoryVersion: repository.version,
    }, signal);
    repository = annotated.repository;

    const tags = await client.listTags(repository.id, signal);
    expect(tags.map((tag) => ({ name: tag.name, annotated: tag.annotated, target: tag.target }))).toEqual([
      { name: "v1.0.0", annotated: false, target: head },
      { name: "v1.0.1", annotated: true, target: head },
    ]);
    expect(tags[1]!.oid).not.toBe(head);
    expect(tags[1]!.message?.trim()).toBe("First annotated release");

    await expect(client.createTag({
      repositoryId: repository.id,
      name: "v1.0.0",
      expectedRepositoryVersion: repository.version,
    }, signal)).rejects.toMatchObject({ code: "tag-exists" });

    const deleted = await client.deleteTag({
      repositoryId: repository.id,
      name: "v1.0.0",
      expectedRepositoryVersion: repository.version,
    }, signal);
    expect((await client.listTags(repository.id, signal)).map((tag) => tag.name)).toEqual(["v1.0.1"]);
    expect(await workspace.read("/workspace/.git/refs/tags/v1.0.0")).toBeUndefined();

    await expect(client.deleteTag({
      repositoryId: repository.id,
      name: "v1.0.0",
      expectedRepositoryVersion: deleted.repository.version,
    }, signal)).rejects.toMatchObject({ code: "not-found" });
  });
});
