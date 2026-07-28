import { describe, expect, it, vi } from "vitest";
import { WorkspaceRootKey } from "./encrypted-envelope";
import type { GoogleDriveWorkspace } from "./google-drive-workspace";
import {
  MemoryWorkspaceKeyHandleStore,
  adoptCachedWorkspaceKey,
  equivalentWorkspaceKeys,
  googleDriveKeyPartition,
  openWorkspaceKeyHandleStore,
  rememberWorkspaceKey,
  type WorkspaceKeyLocation,
} from "./workspace-key-handle-store";

const workspace: GoogleDriveWorkspace = Object.freeze({
  workspaceFolderId: "drive_workspace_123",
  workspaceName: "Airship Workspace",
  rootFolderId: "drive_root_123",
  segmentsFolderId: "drive_segments_123",
  namespaceId: "opaque-drive-namespace-abcdef",
});

const location: WorkspaceKeyLocation = Object.freeze({
  provider: "google-drive",
  workspace,
  accountLabel: "pilot@example.test",
});

describe("browser-profile workspace key handles", () => {
  it("derives a lookup partition from the account subject alone", () => {
    expect(googleDriveKeyPartition("109876543210987654321")).toBe("google-drive:109876543210987654321");
    expect(() => googleDriveKeyPartition("bad subject")).toThrow("Google account subject is invalid.");
    expect(() => googleDriveKeyPartition("short")).toThrow("Google account subject is invalid.");
  });

  it("caches only a non-extractable handle and lists it before any authorization", async () => {
    const store = new MemoryWorkspaceKeyHandleStore();
    const partition = googleDriveKeyPartition("109876543210987654321");
    const { key } = await WorkspaceRootKey.generate();

    expect(await rememberWorkspaceKey({ partition, key, location, store })).toEqual({ created: true });
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.location).toMatchObject({ accountLabel: "pilot@example.test", workspace: { workspaceFolderId: "drive_workspace_123" } });
    expect(listed[0]?.handle.extractable).toBe(false);
    expect(listed[0]?.handle.algorithm.name).toBe("HKDF");
    // Custody, not serialization shape, is the property that matters: the agent
    // holds a live handle whose bytes the platform itself refuses to release.
    await expect(crypto.subtle.exportKey("raw", listed[0]!.handle)).rejects.toThrow();
  });

  it("accepts a repeat cache of the same key and refuses a different one for the same account", async () => {
    const store = new MemoryWorkspaceKeyHandleStore();
    const partition = googleDriveKeyPartition("109876543210987654321");
    const { key } = await WorkspaceRootKey.generate();
    const other = (await WorkspaceRootKey.generate()).key;
    await rememberWorkspaceKey({ partition, key, location, store });

    expect(await rememberWorkspaceKey({ partition, key, location, store })).toEqual({ created: false });
    await expect(rememberWorkspaceKey({ partition, key: other, location, store }))
      .rejects.toThrow("A different workspace key is already cached");
    expect(await equivalentWorkspaceKeys(key, other, partition)).toBe(false);
  });

  it("adopts a cached key only when a live rediscovery returns the same hierarchy", async () => {
    const store = new MemoryWorkspaceKeyHandleStore();
    const partition = googleDriveKeyPartition("109876543210987654321");
    const { key } = await WorkspaceRootKey.generate();
    await rememberWorkspaceKey({ partition, key, location, store });

    const adopted = await adoptCachedWorkspaceKey({
      partition,
      store,
      rediscover: async () => workspace,
    });
    expect(adopted?.workspace).toEqual(workspace);
    expect(await equivalentWorkspaceKeys(adopted!.key, key, partition)).toBe(true);

    // A hierarchy that no longer matches the cached descriptor must fail closed
    // rather than adopting a second authority under the same key.
    await expect(adoptCachedWorkspaceKey({
      partition,
      store,
      rediscover: async () => ({ ...workspace, workspaceFolderId: "drive_workspace_other" }),
    })).rejects.toThrow("no longer matches this account's Airship folder");

    // A live lookup that finds nothing propagates instead of silently creating.
    await expect(adoptCachedWorkspaceKey({
      partition,
      store,
      rediscover: async () => { throw new Error("GoogleDriveWorkspaceNotFoundError"); },
    })).rejects.toThrow("GoogleDriveWorkspaceNotFoundError");
  });

  it("reports no cached vault rather than inventing one", async () => {
    const store = new MemoryWorkspaceKeyHandleStore();
    await expect(adoptCachedWorkspaceKey({
      partition: googleDriveKeyPartition("109876543210987654321"),
      store,
      rediscover: async () => { throw new Error("must not be called"); },
    })).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("rejects a malformed or non-HTTPS descriptor instead of storing it", async () => {
    const store = new MemoryWorkspaceKeyHandleStore();
    const partition = googleDriveKeyPartition("109876543210987654321");
    const { key } = await WorkspaceRootKey.generate();

    for (const broken of [
      { ...location, workspace: { ...workspace, workspaceFolderId: "has spaces" } },
      { ...location, workspace: { ...workspace, namespaceId: "tooshort" } },
      { ...location, workspace: { ...workspace, webViewLink: "http://drive.example.test/open" } },
      { ...location, accountLabel: "" },
      { ...location, provider: "dropbox" },
    ] as unknown as WorkspaceKeyLocation[]) {
      await expect(rememberWorkspaceKey({ partition, key, location: broken, store })).rejects.toThrow();
    }
    expect(await store.list()).toEqual([]);
  });
});

describe("origin-private key handle persistence", () => {
  const partition = googleDriveKeyPartition("109876543210987654321");

  it("round-trips a structured-cloned handle and re-validates it on the way back", async () => {
    const database = new FakeIndexedDb();
    vi.stubGlobal("indexedDB", database);
    try {
      const store = await openWorkspaceKeyHandleStore();
      const { key } = await WorkspaceRootKey.generate();
      expect(await rememberWorkspaceKey({ partition, key, location, store })).toEqual({ created: true });

      // The stored row survived structured cloning as a CryptoKey rather than
      // as key material, and the read-back validator accepts it.
      const persisted = database.rows("workspace-key-handles").get(partition) as { handle: CryptoKey };
      expect(persisted.handle).toBeInstanceOf(CryptoKey);
      expect(persisted.handle.extractable).toBe(false);
      const loaded = await store.load(partition);
      expect(loaded?.location).toMatchObject({ accountLabel: "pilot@example.test" });
      expect(await equivalentWorkspaceKeys(WorkspaceRootKey.fromPersistedHandle(loaded!.handle), key, partition)).toBe(true);

      // A second remember of the same key must read the existing row back
      // through the same validator instead of overwriting it.
      expect(await rememberWorkspaceKey({ partition, key, location, store })).toEqual({ created: false });
      await store.remove(partition);
      expect(await store.load(partition)).toBeUndefined();
      store.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a persisted row that does not still describe this partition's non-extractable key", async () => {
    const database = new FakeIndexedDb();
    vi.stubGlobal("indexedDB", database);
    try {
      const store = await openWorkspaceKeyHandleStore();
      const { key } = await WorkspaceRootKey.generate();
      await rememberWorkspaceKey({ partition, key, location, store });
      const rows = database.rows("workspace-key-handles");
      const sound = rows.get(partition) as Record<string, unknown>;

      for (const tampered of [
        { ...sound, version: 2 },
        // A row moved under another account's key would redirect a live handle.
        { ...sound, partition: "google-drive:999999999999999999999" },
        // Raw key material is exactly what this store must never accept back.
        { ...sound, handle: new Uint8Array(32) },
        // A forgery that duck-types every property WorkspaceRootKey inspects —
        // HKDF, non-extractable, secret, deriveKey — and survives structured
        // cloning as a plain object. Only the `instanceof CryptoKey` class check
        // separates it from a "handle" the agent would then try to derive with,
        // so without that check this row loads and the store hands back a live
        // authority made of JSON.
        { ...sound, handle: { algorithm: { name: "HKDF" }, extractable: false, type: "secret", usages: ["deriveKey"] } },
        { ...sound, createdAt: "not-a-time" },
        { ...sound, location: { ...location, workspace: { ...workspace, namespaceId: "short" } } },
      ]) {
        rows.set(partition, tampered);
        await expect(store.load(partition)).rejects.toThrow();
      }

      // One unreadable row must not hide a sound one from the reconnect list.
      rows.set("google-drive:109876543210987654322", { ...sound, partition: "google-drive:109876543210987654322" });
      expect(await store.list()).toHaveLength(1);
      expect((await store.list())[0]?.partition).toBe("google-drive:109876543210987654322");
      store.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * A deliberately small IndexedDB substitute. Node ships no IndexedDB, so
 * without it `IndexedDbWorkspaceKeyHandleStore` and its read-back validator
 * would never execute in this suite at all. It models only what this module
 * uses — a `keyPath` store, `get`/`getAll`/`count`/`add`/`delete`, structured
 * cloning of stored values, and a transaction that completes once no request is
 * outstanding — and is evidence about this module's logic, never about any real
 * browser's IndexedDB or its CryptoKey persistence.
 */
class FakeIndexedDb {
  readonly #stores = new Map<string, Map<string, unknown>>();
  readonly #keyPaths = new Map<string, string>();

  rows(name: string): Map<string, unknown> {
    const store = this.#stores.get(name);
    if (!store) throw new Error(`Fake object store ${name} does not exist.`);
    return store;
  }

  open(): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>();
    request.result = new FakeDatabase(this.#stores, this.#keyPaths);
    setTimeout(() => {
      request.dispatchEvent(new Event("upgradeneeded"));
      request.dispatchEvent(new Event("success"));
    }, 0);
    return request;
  }
}

class FakeRequest<T> extends EventTarget {
  result!: T;
  error?: Error;
}

class FakeDatabase extends EventTarget {
  readonly objectStoreNames: Readonly<{ contains(name: string): boolean }>;

  constructor(
    private readonly stores: Map<string, Map<string, unknown>>,
    private readonly keyPaths: Map<string, string>,
  ) {
    super();
    this.objectStoreNames = Object.freeze({ contains: (name: string) => this.stores.has(name) });
  }

  createObjectStore(name: string, options: Readonly<{ keyPath: string }>): void {
    this.stores.set(name, new Map());
    this.keyPaths.set(name, options.keyPath);
  }

  transaction(name: string): FakeTransaction {
    const rows = this.stores.get(name);
    if (!rows) throw new Error(`Fake object store ${name} does not exist.`);
    return new FakeTransaction(rows, this.keyPaths.get(name) ?? "");
  }

  close(): void {}
}

class FakeTransaction extends EventTarget {
  #pending = 0;
  #settled = false;

  constructor(private readonly rows: Map<string, unknown>, private readonly keyPath: string) {
    super();
  }

  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this.rows, this.keyPath, this);
  }

  run<T>(operation: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.#pending += 1;
    setTimeout(() => {
      try {
        request.result = operation();
        request.dispatchEvent(new Event("success"));
      } catch (error) {
        request.error = error instanceof Error ? error : new Error("fake request failed");
        request.dispatchEvent(new Event("error"));
      }
      this.#pending -= 1;
      // A real transaction commits once control returns to the event loop with
      // nothing outstanding, so the check is a task later: an awaited request
      // gets its microtask turn to issue the next one first.
      setTimeout(() => {
        if (this.#settled || this.#pending > 0) return;
        this.#settled = true;
        this.dispatchEvent(new Event("complete"));
      }, 0);
    }, 0);
    return request;
  }
}

class FakeObjectStore {
  constructor(
    private readonly rows: Map<string, unknown>,
    private readonly keyPath: string,
    private readonly transaction: FakeTransaction,
  ) {}

  get(key: string): FakeRequest<unknown> {
    return this.transaction.run(() => {
      const value = this.rows.get(key);
      return value === undefined ? undefined : structuredClone(value);
    });
  }

  getAll(_query: undefined, count: number): FakeRequest<unknown[]> {
    return this.transaction.run(() => [...this.rows.values()].slice(0, count).map((value) => structuredClone(value)));
  }

  count(): FakeRequest<number> {
    return this.transaction.run(() => this.rows.size);
  }

  add(value: Record<string, unknown>): FakeRequest<void> {
    return this.transaction.run(() => {
      const key = value[this.keyPath];
      if (typeof key !== "string") throw new Error("fake key path is not a string");
      if (this.rows.has(key)) throw new Error("fake constraint error");
      this.rows.set(key, structuredClone(value));
    });
  }

  delete(key: string): FakeRequest<void> {
    return this.transaction.run(() => { this.rows.delete(key); });
  }
}
