import { describe, expect, it, vi } from "vitest";
import {
  ClientCiphertextCache,
  MemoryCiphertextPageBackend,
  OpfsWorkerCiphertextPageBackend,
  createClientCiphertextCache,
  type CiphertextCacheBackend,
  type CiphertextPageBackend,
} from "./client-ciphertext-cache";

const RECORD_MAGIC = new TextEncoder().encode("AIRCC01\0");

describe("client ciphertext acceleration cache", () => {
  it("selects the opt-in extension cache first, then OPFS, IndexedDB, and page memory", async () => {
    const extension = new InspectableBackend("extension-indexeddb");
    const accelerated = await createClientCiphertextCache({
      partition: "provider/workspace",
      openExtension: vi.fn(async () => extension),
      openOpfs: vi.fn(async () => new InspectableBackend("opfs-sync-worker")),
      openIndexedDb: vi.fn(async () => new InspectableBackend("indexeddb")),
    });
    expect(accelerated.capability).toMatchObject({
      backend: "extension-indexeddb",
      persistenceBoundary: "ciphertext-only",
      authority: "vault-provider-remains-authoritative",
    });

    const sync = new InspectableBackend("opfs-sync-worker");
    const preferred = await createClientCiphertextCache({
      partition: "provider/workspace",
      openExtension: vi.fn(async () => { throw new Error("disabled"); }),
      openOpfs: vi.fn(async () => sync),
      openIndexedDb: vi.fn(async () => new InspectableBackend("indexeddb")),
    });
    expect(preferred.capability).toMatchObject({
      backend: "opfs-sync-worker",
      durability: "origin-private-persistent",
      syncAccessHandle: "active",
      persistenceBoundary: "ciphertext-only",
      authority: "vault-provider-remains-authoritative",
    });

    const indexed = await createClientCiphertextCache({
      partition: "provider/workspace",
      openExtension: vi.fn(async () => { throw new Error("disabled"); }),
      openOpfs: vi.fn(async () => { throw new Error("unsupported"); }),
      openIndexedDb: vi.fn(async () => new InspectableBackend("indexeddb")),
    });
    expect(indexed.capability.backend).toBe("indexeddb");

    const memory = await createClientCiphertextCache({
      partition: "provider/workspace",
      openExtension: vi.fn(async () => { throw new Error("disabled"); }),
      openOpfs: vi.fn(async () => { throw new Error("unsupported"); }),
      openIndexedDb: vi.fn(async () => { throw new Error("blocked"); }),
    });
    expect(memory.capability).toMatchObject({ backend: "memory", durability: "page-memory" });
  });

  it("stores no logical object key and rejects corrupted persistent bytes as a cache miss", async () => {
    const pages = new InspectableBackend("indexeddb");
    const cache = new ClientCiphertextCache(pages);
    const address = {
      objectKey: "state/workspace/v1/files/opaque-provider-id",
      kind: "workspace" as const,
    };
    const ciphertext = Uint8Array.from([149, 42, 222, 71, 8, 211]);
    await cache.put(address, { bytes: ciphertext, etag: "opaque-etag" });

    // The LRU index shares this backend, so select the record by its marker.
    const [storageKey, persisted] = [...pages.pages].find(([, page]) => RECORD_MAGIC.every((byte, index) => page[index] === byte))!;
    expect(new TextDecoder().decode(persisted)).not.toContain(address.objectKey);
    expect(await cache.get(address)).toMatchObject({ bytes: ciphertext, etag: "opaque-etag" });

    persisted[persisted.byteLength - 1] ^= 0xff;
    expect(await cache.get(address)).toBeUndefined();
    expect(pages.pages.has(storageKey)).toBe(false);
  });

  it("binds exact range pages to their offsets and total ciphertext size", async () => {
    const cache = new ClientCiphertextCache(new MemoryCiphertextPageBackend());
    const address = {
      objectKey: "context/segments/opaque-index-object",
      kind: "index-page" as const,
      range: { start: 128, endExclusive: 132 },
    };
    await cache.put(address, { bytes: Uint8Array.from([1, 2, 3, 4]), etag: "range-etag", totalSize: 512 });
    expect(await cache.get(address)).toMatchObject({
      bytes: Uint8Array.from([1, 2, 3, 4]),
      etag: "range-etag",
      totalSize: 512,
    });
    expect(await cache.get({ ...address, range: { start: 132, endExclusive: 136 } })).toBeUndefined();
  });

  it("bounds total residency by evicting least-recently-used pages", async () => {
    const pages = new InspectableBackend("indexeddb");
    let clock = 1_700_000_000_000;
    const cache = new ClientCiphertextCache(pages, {
      maxBytes: 1024 * 1024,
      maxEntries: 3,
      now: () => (clock += 1_000),
      estimateStorage: async () => ({}),
    });
    const address = (index: number) => ({ objectKey: `context/segments/object-${index}`, kind: "index-page" as const });
    for (let index = 0; index < 3; index += 1) {
      await cache.put(address(index), { bytes: Uint8Array.from([index, index, index]), etag: `etag-${index}` });
    }
    // Re-reading object 0 makes object 1 the least recently used.
    expect(await cache.get(address(0))).toMatchObject({ etag: "etag-0" });
    await cache.put(address(3), { bytes: Uint8Array.from([3, 3, 3]), etag: "etag-3" });

    expect(await cache.get(address(1))).toBeUndefined();
    expect(await cache.get(address(0))).toMatchObject({ etag: "etag-0" });
    expect(await cache.get(address(2))).toMatchObject({ etag: "etag-2" });
    expect(await cache.get(address(3))).toMatchObject({ etag: "etag-3" });
    // Three pages plus the reserved LRU index record, and never more.
    expect(pages.pages.size).toBe(4);
  });

  it("evicts by byte budget and refuses records larger than the whole budget", async () => {
    const pages = new InspectableBackend("indexeddb");
    let clock = 1_700_000_000_000;
    const cache = new ClientCiphertextCache(pages, {
      maxBytes: 512,
      maxEntries: 1_000,
      now: () => (clock += 1_000),
      estimateStorage: async () => ({}),
    });
    for (let index = 0; index < 6; index += 1) {
      await cache.put(
        { objectKey: `context/segments/block-${index}`, kind: "index-page" },
        { bytes: new Uint8Array(120).fill(index + 1), etag: `etag-${index}` },
      );
    }
    const resident = [...pages.pages.values()].filter((page) => RECORD_MAGIC.every((byte, at) => page[at] === byte));
    expect(resident.reduce((total, page) => total + page.byteLength, 0)).toBeLessThanOrEqual(512);
    expect(await cache.get({ objectKey: "context/segments/block-0", kind: "index-page" })).toBeUndefined();
    expect(await cache.get({ objectKey: "context/segments/block-5", kind: "index-page" })).toMatchObject({ etag: "etag-5" });

    await cache.put(
      { objectKey: "context/segments/oversized", kind: "index-page" },
      { bytes: new Uint8Array(4_096), etag: "too-large" },
    );
    expect(await cache.get({ objectKey: "context/segments/oversized", kind: "index-page" })).toBeUndefined();
  });

  it("reconciles orphaned pages left by a lost index and clamps the budget to the origin quota", async () => {
    const pages = new InspectableBackend("indexeddb");
    const orphan = "C".repeat(43);
    // A page whose index row never landed: only a listing can find it again.
    await pages.write(orphan, new Uint8Array(400).fill(7));

    const cache = new ClientCiphertextCache(pages, {
      maxBytes: 64 * 1024 * 1024,
      maxEntries: 32,
      // 25% of this quota is 250 bytes, below the orphan, so it must be reclaimed.
      estimateStorage: async () => ({ quota: 1_000 }),
    });
    await cache.put(
      { objectKey: "context/segments/fresh", kind: "index-page" },
      { bytes: new Uint8Array(64).fill(1), etag: "fresh" },
    );
    expect(pages.pages.has(orphan)).toBe(false);
  });

  it("merges a second tab's persisted index rows instead of clobbering them", async () => {
    // One partition, one shared directory, two independently opened caches.
    const pages = new InspectableBackend("opfs-sync-worker");
    let clock = 1_700_000_000_000;
    const budget = {
      maxBytes: 1024 * 1024,
      maxEntries: 16,
      now: () => (clock += 1_000),
      estimateStorage: async () => ({}),
    };
    const address = (name: string) => ({ objectKey: `context/segments/${name}`, kind: "index-page" as const });
    const firstTab = new ClientCiphertextCache(pages, budget);
    const secondTab = new ClientCiphertextCache(pages, budget);

    await firstTab.put(address("first-tab-page"), { bytes: new Uint8Array(32).fill(1), etag: "first" });
    // The second tab opens after the first and writes a page the first tab's
    // in-memory view will never contain.
    await secondTab.put(address("second-tab-page"), { bytes: new Uint8Array(32).fill(2), etag: "second" });
    // The first tab now flushes on top of the second tab's persisted index.
    await firstTab.put(address("first-tab-later-page"), { bytes: new Uint8Array(32).fill(3), etag: "later" });

    const [indexKey, indexBytes] = [...pages.pages].find(([, page]) => !RECORD_MAGIC.every((byte, at) => page[at] === byte))!;
    const rows = (JSON.parse(new TextDecoder().decode(indexBytes)) as { entries: [string, number, number][] }).entries;
    const resident = [...pages.pages.keys()].filter((key) => key !== indexKey).sort();
    // The flushed index must account for every resident page, including the one
    // this tab never wrote; otherwise the ceiling under-counts real residency.
    expect(resident).toHaveLength(3);
    expect(rows.map(([storageKey]) => storageKey).sort()).toEqual(resident);
    expect(await secondTab.get(address("second-tab-page"))).toMatchObject({ etag: "second" });

    // The reverse hazard: a page this tab provably removed must not be revived
    // by merging its own now-stale persisted row back in.
    await firstTab.remove(address("first-tab-page"));
    const [laterKey, laterBytes] = [...pages.pages].find(([, page]) => !RECORD_MAGIC.every((byte, at) => page[at] === byte))!;
    const laterRows = (JSON.parse(new TextDecoder().decode(laterBytes)) as { entries: [string, number, number][] }).entries;
    const stillResident = [...pages.pages.keys()].filter((key) => key !== laterKey).sort();
    expect(stillResident).toHaveLength(2);
    expect(laterRows.map(([storageKey]) => storageKey).sort()).toEqual(stillResident);
  });

  it("never lets an index failure grow the cache without a ceiling", async () => {
    const pages = new InspectableBackend("indexeddb");
    const cache = new ClientCiphertextCache(pages, { estimateStorage: async () => ({}) });
    pages.listFailure = new Error("directory unreadable");
    const address = { objectKey: "context/segments/unbounded", kind: "index-page" as const };
    await cache.put(address, { bytes: Uint8Array.from([1, 2, 3]), etag: "etag" });
    expect(pages.pages.size).toBe(0);
    expect(await cache.get(address)).toBeUndefined();
  });

  it("retires a closed OPFS worker idempotently and rejects later operations without posting", async () => {
    const worker = new InspectableWorker();
    const pages = new OpfsWorkerCiphertextPageBackend(worker as unknown as Worker, "opfs-sync-worker");
    const storageKey = "A".repeat(43);

    const inFlight = pages.read(storageKey);
    expect(worker.messages).toHaveLength(1);
    pages.close();

    await expect(inFlight).rejects.toThrow("OPFS ciphertext cache worker stopped");
    await expect(pages.read(storageKey)).rejects.toThrow("OPFS ciphertext cache worker stopped");
    await expect(pages.remove(storageKey)).rejects.toThrow("OPFS ciphertext cache worker stopped");
    expect(worker.messages).toHaveLength(1);
    expect(worker.terminateCalls).toBe(1);

    pages.close();
    expect(worker.terminateCalls).toBe(1);
  });

  it("retires the OPFS backend when the Worker reports an unrecoverable error", async () => {
    const worker = new InspectableWorker();
    const pages = new OpfsWorkerCiphertextPageBackend(worker as unknown as Worker, "opfs-async-worker");
    const storageKey = "B".repeat(43);
    const inFlight = pages.read(storageKey);

    worker.dispatchEvent(new Event("error"));

    await expect(inFlight).rejects.toThrow("OPFS ciphertext cache worker stopped");
    await expect(pages.read(storageKey)).rejects.toThrow("OPFS ciphertext cache worker stopped");
    expect(worker.terminateCalls).toBe(1);
  });
});

class InspectableWorker extends EventTarget {
  readonly messages: unknown[] = [];
  terminateCalls = 0;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminateCalls += 1;
  }
}

class InspectableBackend implements CiphertextPageBackend {
  readonly pages = new Map<string, Uint8Array>();
  readonly durability;
  readonly syncAccessHandle;
  listFailure?: Error;

  constructor(readonly backend: CiphertextCacheBackend) {
    this.durability = backend === "memory"
      ? "page-memory" as const
      : backend === "extension-indexeddb"
        ? "extension-origin-persistent" as const
        : "origin-private-persistent" as const;
    this.syncAccessHandle = backend === "opfs-sync-worker" ? "active" as const : "unavailable" as const;
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    // Deliberately return the live fixture so the test can emulate disk damage.
    return this.pages.get(key);
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    this.pages.set(key, bytes.slice());
  }

  async remove(key: string): Promise<void> {
    this.pages.delete(key);
  }

  async list(): Promise<readonly Readonly<{ storageKey: string; bytes: number }>[]> {
    if (this.listFailure) throw this.listFailure;
    return [...this.pages].map(([storageKey, bytes]) => ({ storageKey, bytes: bytes.byteLength }));
  }

  close(): void {
    this.pages.clear();
  }
}
