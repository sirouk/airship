import { describe, expect, it, vi } from "vitest";
import {
  ClientCiphertextCache,
  MemoryCiphertextPageBackend,
  OpfsWorkerCiphertextPageBackend,
  createClientCiphertextCache,
  type CiphertextCacheBackend,
  type CiphertextPageBackend,
} from "./client-ciphertext-cache";

describe("client ciphertext acceleration cache", () => {
  it("selects OPFS first, then IndexedDB, then a page-memory ciphertext fallback", async () => {
    const sync = new InspectableBackend("opfs-sync-worker");
    const preferred = await createClientCiphertextCache({
      partition: "provider/workspace",
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
      openOpfs: vi.fn(async () => { throw new Error("unsupported"); }),
      openIndexedDb: vi.fn(async () => new InspectableBackend("indexeddb")),
    });
    expect(indexed.capability.backend).toBe("indexeddb");

    const memory = await createClientCiphertextCache({
      partition: "provider/workspace",
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

    const persisted = [...pages.pages.values()][0]!;
    expect(new TextDecoder().decode(persisted)).not.toContain(address.objectKey);
    expect(await cache.get(address)).toMatchObject({ bytes: ciphertext, etag: "opaque-etag" });

    persisted[persisted.byteLength - 1] ^= 0xff;
    expect(await cache.get(address)).toBeUndefined();
    expect(pages.pages.size).toBe(0);
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

  constructor(readonly backend: CiphertextCacheBackend) {
    this.durability = backend === "memory" ? "page-memory" as const : "origin-private-persistent" as const;
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

  close(): void {
    this.pages.clear();
  }
}
