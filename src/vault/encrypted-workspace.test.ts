import { describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../storage/memory-object-store.test-support";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { CiphertextCachingObjectStore } from "../storage/caching-object-store";
import { ClientCiphertextCache, MemoryCiphertextPageBackend } from "../storage/client-ciphertext-cache";
import { encodeWorkspaceBytes } from "../workspace/content-codec";
import { WorkspaceConflictError } from "../workspace/contracts";
import { EncryptedObjectWorkspace } from "./encrypted-workspace";

const timestamp = "2026-07-18T12:00:00.000Z";
const CACHE_RECORD_MAGIC = new TextEncoder().encode("AIRCC01\0");

/** Counts cached ciphertext records, excluding the cache's own LRU index page. */
async function cachedPageCount(pages: MemoryCiphertextPageBackend): Promise<number> {
  const listed = await pages.list();
  const records = await Promise.all(listed.map(async ({ storageKey }) => await pages.read(storageKey)));
  return records.filter((bytes) => bytes && CACHE_RECORD_MAGIC.every((byte, index) => bytes[index] === byte)).length;
}

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

  it("commits a binary file's own byte length beside the sealed object size", async () => {
    // `size` proves the sealed plaintext and bounds the download, so it stays
    // the base64 envelope; the decoded length rides alongside it so a bounded
    // preview — which decrypts nothing — can still be honest about the file.
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const workspace = makeWorkspace(store, key, () => "revision-1");
    const envelope = encodeWorkspaceBytes(Uint8Array.from([0, 255, 1, 2]));

    const written = await workspace.write("assets/raw.bin", envelope, { expectedRevision: null });
    expect(written).toMatchObject({ size: envelope.length, contentByteLength: 4 });
    expect(await workspace.read("assets/raw.bin")).toEqual(written);
    expect(await workspace.list("assets")).toEqual([expect.objectContaining({ contentByteLength: 4 })]);
    await expect(workspace.readBounded("assets/raw.bin", 8)).resolves.toMatchObject({
      content: "",
      size: envelope.length,
      contentByteLength: 4,
    });
  });

  it("releases superseded and lost-race revisions from the acceleration cache without touching provider authority", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const authority = new MemoryObjectStore();
    const pages = new MemoryCiphertextPageBackend();
    const cached = new CiphertextCachingObjectStore(authority, new ClientCiphertextCache(pages));
    let id = 0;
    // The immutable classifier only recognizes the canonical workspace prefix.
    const workspace = new EncryptedObjectWorkspace(cached, key, "state/workspace/v1", () => timestamp, () => `revision-${++id}`);

    const first = await workspace.write("notes.md", "one", { expectedRevision: null });
    const firstKey = (await authority.list("state/workspace/v1/files/"))[0]!.key;
    expect(await cachedPageCount(pages)).toBe(1);

    await workspace.write("notes.md", "two", { expectedRevision: first.revision });
    // The superseded ciphertext is still provider-authoritative for a reader
    // holding the older manifest; only its cache page is released.
    expect((await authority.list("state/workspace/v1/files/")).map((entry) => entry.key)).toContain(firstKey);
    expect(await cachedPageCount(pages)).toBe(1);

    // A lost manifest CAS makes the just-minted revision the orphan instead, so
    // exactly one page survives the race even though both sides uploaded.
    const base = (await workspace.list())[0]!.revision;
    const left = new EncryptedObjectWorkspace(cached, key, "state/workspace/v1", () => timestamp, () => "revision-left");
    const right = new EncryptedObjectWorkspace(cached, key, "state/workspace/v1", () => timestamp, () => "revision-right");
    const results = await Promise.allSettled([
      left.write("notes.md", "from left", { expectedRevision: base }),
      right.write("notes.md", "from right", { expectedRevision: base }),
    ]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await authority.list("state/workspace/v1/files/")).length).toBe(4);
    expect(await cachedPageCount(pages)).toBe(1);
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
