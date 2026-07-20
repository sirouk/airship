import { describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../storage/memory-object-store";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { WorkspaceConflictError } from "../workspace/contracts";
import { EncryptedObjectWorkspace } from "./encrypted-workspace";

const timestamp = "2026-07-18T12:00:00.000Z";

describe("EncryptedObjectWorkspace", () => {
  it("keeps empty reads side-effect free", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const workspace = makeWorkspace(store, key, () => "unused");

    await expect(workspace.read("missing.txt")).resolves.toBeUndefined();
    await expect(workspace.list()).resolves.toEqual([]);
    await expect(workspace.remove("missing.txt")).resolves.toBeUndefined();
    expect(await store.list("vault/")).toEqual([]);
  });

  it("round-trips a cloud-authoritative file while object bytes hide its path and content", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const workspace = makeWorkspace(store, key, () => "revision-1");

    const written = await workspace.write("secrets/report.md", "private material", { expectedRevision: null });
    expect(await workspace.read("secrets/report.md")).toEqual(written);
    expect(await workspace.list("secrets")).toEqual([expect.objectContaining({
      path: "/workspace/secrets/report.md",
      revision: "revision-1",
      size: 16,
    })]);

    const objects = await store.list("vault/");
    const serialized = await Promise.all(objects.map(async ({ key: objectKey }) =>
      new TextDecoder().decode((await store.get(objectKey))!.bytes),
    ));
    expect(serialized.join("\n")).not.toContain("private material");
    expect(serialized.join("\n")).not.toContain("secrets/report.md");
  });

  it("orders manifest paths deterministically instead of using locale collation", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    let id = 0;
    const workspace = makeWorkspace(store, key, () => `revision-${++id}`);

    await workspace.write("alpha.txt", "lowercase", { expectedRevision: null });
    await workspace.write("Bravo.txt", "uppercase", { expectedRevision: null });

    await expect(workspace.list()).resolves.toEqual([
      expect.objectContaining({ path: "/workspace/Bravo.txt" }),
      expect.objectContaining({ path: "/workspace/alpha.txt" }),
    ]);
    await expect(workspace.read("alpha.txt")).resolves.toMatchObject({ content: "lowercase" });
  });

  it("serializes concurrent writers with one manifest CAS winner", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const seed = makeWorkspace(store, key, () => "seed");
    const initial = await seed.write("shared.txt", "initial", { expectedRevision: null });
    const left = makeWorkspace(store, key, () => "left");
    const right = makeWorkspace(store, key, () => "right");

    const results = await Promise.allSettled([
      left.write("shared.txt", "from left", { expectedRevision: initial.revision }),
      right.write("shared.txt", "from right", { expectedRevision: initial.revision }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(WorkspaceConflictError);
    expect(["from left", "from right"]).toContain((await seed.read("shared.txt"))?.content);
  });

  it("enforces create/update revisions and retains removed ciphertext as an explicit orphan", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    let id = 0;
    const workspace = makeWorkspace(store, key, () => `revision-${++id}`);
    const written = await workspace.write("file.txt", "one", { expectedRevision: null });

    await expect(workspace.write("file.txt", "two", { expectedRevision: null })).rejects.toBeInstanceOf(WorkspaceConflictError);
    await expect(workspace.write("file.txt", "two", { expectedRevision: "wrong" })).rejects.toBeInstanceOf(WorkspaceConflictError);
    await workspace.remove("file.txt", { expectedRevision: written.revision });

    expect(await workspace.read("file.txt")).toBeUndefined();
    expect(await workspace.list()).toEqual([]);
    expect((await store.list("vault/files/")).length).toBe(1);
  });

  it("detects mutation of an immutable ciphertext object's ETag before decryption", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const workspace = makeWorkspace(store, key, () => "revision-1");
    await workspace.write("file.txt", "original", { expectedRevision: null });
    const file = (await store.list("vault/files/"))[0]!;
    await store.compareAndSwap(file.key, file.etag, new Uint8Array([1, 2, 3]));

    await expect(workspace.read("file.txt")).rejects.toThrow("ETag changed");
  });

  it("does not download an oversized encrypted file for a bounded preview", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const workspace = makeWorkspace(store, key, () => "revision-1");
    await workspace.write("large.txt", "private material", { expectedRevision: null });
    const file = (await store.list("vault/files/"))[0]!;
    await store.compareAndSwap(file.key, file.etag, new Uint8Array([1, 2, 3]));

    await expect(workspace.readBounded("large.txt", 4)).resolves.toMatchObject({
      content: "",
      size: 16,
      revision: "revision-1",
    });
    await expect(workspace.readBounded("large.txt", 32)).rejects.toThrow("ETag changed");
  });

  it("rejects oversized plaintext before publishing any immutable object", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const workspace = makeWorkspace(store, key, () => "revision-1");
    const oversized = "x".repeat(16 * 1024 * 1024 + 1);

    await expect(workspace.write("large.txt", oversized)).rejects.toThrow("file exceeds");
    expect(await store.list("vault/")).toEqual([]);
  });
});

function makeWorkspace(
  store: MemoryObjectStore,
  key: WorkspaceRootKey,
  id: () => string,
): EncryptedObjectWorkspace {
  return new EncryptedObjectWorkspace(store, key, "vault", () => timestamp, id);
}
