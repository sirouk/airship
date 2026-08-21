import { describe, expect, it } from "vitest";
import { ClientCiphertextCache, MemoryCiphertextPageBackend } from "./client-ciphertext-cache";
import { CiphertextCachingObjectStore, classifyVaultImmutableCiphertext } from "./caching-object-store";
import { MemoryObjectStore } from "./memory-object-store.test-support";
import { isReclaimableObjectStore, type ObjectReclamationReceipt, type ObjectStore, type ReclaimableObjectStore } from "./object-store";

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
    const attemptedWrites: string[] = [];
    const cache = new ClientCiphertextCache({
      backend: "opfs-sync-worker",
      durability: "origin-private-persistent",
      syncAccessHandle: "active",
      async read() { throw new Error("evicted"); },
      async write(storageKey: string) { attemptedWrites.push(storageKey); throw new Error("quota"); },
      async remove() { throw new Error("gone"); },
      // A healthy but empty listing on purpose: the index must open, otherwise
      // `put` would refuse at the no-ceiling guard and never reach the failing
      // page write this test is about.
      async list(): Promise<readonly Readonly<{ storageKey: string; bytes: number }>[]> { return []; },
      close() {},
    });
    const store = new CiphertextCachingObjectStore(authority, cache);
    const key = "state/workspace/v1/files/opaque-file-object";
    const created = await store.putIfAbsent(key, Uint8Array.from([9, 8, 7]));
    expect(created).toMatchObject({ created: true });
    expect(await store.putIfAbsent(key, Uint8Array.from([6]))).toMatchObject({ created: false, reason: "exists" });
    expect((await store.get(key))?.bytes).toEqual(Uint8Array.from([9, 8, 7]));
    expect(authority.getCalls).toBe(1);
    // The reserved index record and the page record are distinct storage keys,
    // so more than one attempted key proves the quota failure was raised by a
    // real page write rather than only by the index rewrite.
    expect(new Set(attemptedWrites).size).toBeGreaterThan(1);
  });
});

describe("reclamation forwarding", () => {
  it("reports no reclamation capability when the authority has none", async () => {
    /*
     * A store that genuinely lacks the verb. `MemoryObjectStore` gained a real
     * `trash` when page memory stopped being the one durability that could not
     * delete a conversation, so every double inheriting from it is reclaimable
     * now — and this case, whose whole subject is an authority WITHOUT
     * reclamation, had silently stopped testing anything.
     */
    const bare = Object.create(new CountingObjectStore(), { trash: { value: undefined } }) as ObjectStore;
    expect(isReclaimableObjectStore(bare)).toBe(false);
    const store = new CiphertextCachingObjectStore(bare, new ClientCiphertextCache(new MemoryCiphertextPageBackend()));
    expect(isReclaimableObjectStore(store)).toBe(false);
    expect((store as Partial<ReclaimableObjectStore>).trash).toBeUndefined();
  });

  it("forwards reclamation and drops the cached page for every requested key", async () => {
    const authority = new ReclaimableCountingObjectStore();
    const pages = new MemoryCiphertextPageBackend();
    const store = new CiphertextCachingObjectStore(authority, new ClientCiphertextCache(pages));
    const key = "state/workspace/v1/files/opaque-file-object";
    await store.putIfAbsent(key, Uint8Array.from([5, 6, 7]));
    expect(await store.get(key)).toMatchObject({ key });
    expect(authority.getCalls).toBe(0);

    expect(isReclaimableObjectStore(store)).toBe(true);
    const receipt = await store.trash!([key]);
    expect(receipt).toMatchObject({ requested: 1, reclaimed: [key], retained: [] });
    // The page must be gone, otherwise an unindexed object would still be
    // served from cache as though it were live.
    expect(await store.get(key)).toBeUndefined();
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

class ReclaimableCountingObjectStore extends CountingObjectStore implements ReclaimableObjectStore {
  private readonly trashed = new Set<string>();

  override async get(key: string, signal?: AbortSignal) {
    const record = await super.get(key, signal);
    return this.trashed.has(key) ? undefined : record;
  }

  async trash(keys: readonly string[]): Promise<ObjectReclamationReceipt> {
    for (const key of keys) this.trashed.add(key);
    return Object.freeze({
      requested: keys.length,
      reclaimed: Object.freeze([...keys]),
      retained: Object.freeze([]),
      outcomes: Object.freeze(keys.map((key) => Object.freeze({ key, reclaimed: true as const }))),
    });
  }
}
