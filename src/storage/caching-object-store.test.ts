import { describe, expect, it } from "vitest";
import { ClientCiphertextCache, MemoryCiphertextPageBackend } from "./client-ciphertext-cache";
import { CiphertextCachingObjectStore, classifyVaultImmutableCiphertext } from "./caching-object-store";
import { MemoryObjectStore } from "./memory-object-store";

describe("ciphertext caching ObjectStore", () => {
  it("serves encrypted workspace and Git-file objects locally after provider commit", async () => {
    const authority = new CountingObjectStore();
    const store = cached(authority);
    const key = "state/workspace/v1/files/opaque-file-object";
    const bytes = Uint8Array.from([33, 102, 8, 199]);
    expect(classifyVaultImmutableCiphertext(key)).toBe("workspace");
    expect(await store.putIfAbsent(key, bytes)).toMatchObject({ created: true });

    expect(await store.get(key)).toMatchObject({ key, bytes });
    expect(authority.getCalls).toBe(0);
  });

  it("caches exact encrypted index ranges without downloading the full object", async () => {
    const authority = new CountingObjectStore();
    const key = "context/segments/opaque-generation-page";
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
    await authority.putIfAbsent(key, bytes);
    const store = cached(authority);

    expect((await store.getRange(key, 8, 20))?.bytes).toEqual(bytes.slice(8, 20));
    expect(authority.rangeCalls).toBe(1);
    expect((await store.getRange(key, 8, 20))?.bytes).toEqual(bytes.slice(8, 20));
    expect(authority.rangeCalls).toBe(1);
  });

  it("always reads mutable heads and performs CAS at provider authority", async () => {
    const authority = new CountingObjectStore();
    const store = cached(authority);
    const key = "state/workspace/v1/heads/opaque-workspace-head";
    const first = Uint8Array.from([1, 2, 3]);
    const second = Uint8Array.from([4, 5, 6]);
    const created = await store.putIfAbsent(key, first);
    if (!created.created) throw new Error("fixture collision");

    expect((await store.get(key))?.bytes).toEqual(first);
    expect((await store.get(key))?.bytes).toEqual(first);
    expect(authority.getCalls).toBe(2);
    expect(await store.compareAndSwap(key, created.etag, second)).toMatchObject({ updated: true });
    expect((await store.get(key))?.bytes).toEqual(second);
    expect(authority.casCalls).toBe(1);
    expect(authority.getCalls).toBe(3);
  });

  it("treats cache failure as a provider miss without weakening conditional writes", async () => {
    const authority = new CountingObjectStore();
    const cache = new ClientCiphertextCache({
      backend: "opfs-sync-worker",
      durability: "origin-private-persistent",
      syncAccessHandle: "active",
      async read() { throw new Error("evicted"); },
      async write() { throw new Error("quota"); },
      async remove() { throw new Error("gone"); },
      close() {},
    });
    const store = new CiphertextCachingObjectStore(authority, cache);
    const key = "state/workspace/v1/files/opaque-file-object";
    const created = await store.putIfAbsent(key, Uint8Array.from([9, 8, 7]));
    expect(created).toMatchObject({ created: true });
    expect(await store.putIfAbsent(key, Uint8Array.from([6]))).toMatchObject({ created: false, reason: "exists" });
    expect((await store.get(key))?.bytes).toEqual(Uint8Array.from([9, 8, 7]));
    expect(authority.getCalls).toBe(1);
  });
});

class CountingObjectStore extends MemoryObjectStore {
  getCalls = 0;
  rangeCalls = 0;
  casCalls = 0;

  override async get(key: string, signal?: AbortSignal) {
    this.getCalls += 1;
    signal?.throwIfAborted();
    return super.get(key);
  }

  override async getRange(key: string, start: number, endExclusive: number, signal?: AbortSignal) {
    this.rangeCalls += 1;
    signal?.throwIfAborted();
    return super.getRange(key, start, endExclusive);
  }

  override async compareAndSwap(key: string, expectedEtag: string, bytes: Uint8Array, signal?: AbortSignal) {
    this.casCalls += 1;
    signal?.throwIfAborted();
    return super.compareAndSwap(key, expectedEtag, bytes);
  }
}

function cached(authority: CountingObjectStore): CiphertextCachingObjectStore {
  return new CiphertextCachingObjectStore(
    authority,
    new ClientCiphertextCache(new MemoryCiphertextPageBackend()),
  );
}
