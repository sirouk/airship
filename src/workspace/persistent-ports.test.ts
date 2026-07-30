import { describe, expect, it, vi } from "vitest";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store";
import { EncryptedObjectWorkspace } from "../vault/encrypted-workspace";
import { encodeWorkspaceBytes } from "./content-codec";
import { workspaceEntryByteLength, type WorkspacePort } from "./contracts";
import { IndexedDbWorkspace } from "./indexeddb";
import { MemoryWorkspace } from "./memory";

const timestamp = "2026-07-18T12:00:00.000Z";
/** 96 KiB that is not valid UTF-8, so the codec has to envelope it. */
const BINARY = Uint8Array.from({ length: 96 * 1024 }, (_value, index) => (index % 2 === 0 ? 0x00 : 0xff));

/**
 * Every port a person's files can be mounted on, agreeing on one number.
 *
 * Binaries cross the string-valued WorkspacePort inside a base64 envelope, so a
 * port that records only the stored length tells the Explorer and the editor
 * strip that an image is a third larger than `read_file`/`stat_path` reports
 * for the same path. The defect is per-port, and its worst form is disagreement
 * between ports: the same workspace would size the same file differently
 * depending on whether it is held in memory, in IndexedDB, or in the cloud
 * vault. So the property is asserted against all three, by running them.
 */
describe("workspace ports report a file's own byte length", () => {
  const ports: ReadonlyArray<Readonly<{ name: string; open: () => Promise<WorkspacePort> }>> = [
    { name: "MemoryWorkspace", open: async () => new MemoryWorkspace() },
    {
      name: "IndexedDbWorkspace",
      open: async () => {
        vi.stubGlobal("indexedDB", new FakeIndexedDb());
        return new IndexedDbWorkspace();
      },
    },
    {
      name: "EncryptedObjectWorkspace",
      open: async () => new EncryptedObjectWorkspace(
        new MemoryObjectStore(),
        (await WorkspaceRootKey.generate()).key,
        "vault",
        () => timestamp,
        () => "revision-1",
      ),
    },
  ];

  for (const { name, open } of ports) {
    it(`records the decoded length on write and hands it back from list in ${name}`, async () => {
      try {
        const workspace = await open();
        const envelope = encodeWorkspaceBytes(BINARY);

        const written = await workspace.write("/workspace/image.png", envelope);
        // `list()` drops content, so an entry that did not carry the decoded
        // length would leave the Explorer with nothing but the envelope.
        const [entry] = await workspace.list("/workspace");

        expect(written.size).toBe(envelope.length);
        expect(written.size).toBeGreaterThan(BINARY.byteLength);
        expect(workspaceEntryByteLength(written)).toBe(BINARY.byteLength);
        expect(entry).toBeDefined();
        expect(workspaceEntryByteLength(entry!)).toBe(BINARY.byteLength);
        // The stored length stays exactly what storage holds: it bounds the
        // download and, in the vault, proves the sealed plaintext.
        expect(entry!.size).toBe(envelope.length);

        // Text — most of any workspace — must be untouched by the second
        // length: storage and display are the same bytes and must agree.
        const text = await workspace.write("/workspace/notes.md", "héllo");
        expect(text.size).toBe(6);
        expect(workspaceEntryByteLength(text)).toBe(6);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }
});

describe("IndexedDbWorkspace", () => {
  it("round-trips a file through the object store and removes it under its revision", async () => {
    // The port had no behavioural coverage at all: Node ships no IndexedDB, so
    // the whole module was previously asserted only as source text.
    vi.stubGlobal("indexedDB", new FakeIndexedDb());
    try {
      const workspace = new IndexedDbWorkspace();

      const written = await workspace.write("/workspace/notes.md", "first");
      expect(await workspace.read("/workspace/notes.md")).toEqual(written);
      await expect(workspace.write("/workspace/notes.md", "second", { expectedRevision: "stale" }))
        .rejects.toThrow();
      expect((await workspace.read("/workspace/notes.md"))?.content).toBe("first");

      const replaced = await workspace.write("/workspace/notes.md", "second", { expectedRevision: written.revision });
      expect(replaced.content).toBe("second");
      expect(await workspace.list("/workspace")).toHaveLength(1);

      await workspace.remove("/workspace/notes.md", { expectedRevision: replaced.revision });
      expect(await workspace.list("/workspace")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * A deliberately small IndexedDB substitute, sized to `IndexedDbWorkspace`.
 *
 * Node ships no IndexedDB, so this port's only previous guard read its own
 * source file and asserted a literal string appeared in it — which a comment
 * satisfies and which says nothing about what the store hands back. Running the
 * port against a double is the only way this suite can witness the write, the
 * structured-clone round trip, and the `list()` projection that strips content.
 *
 * It models only what the port uses: a `keyPath` store with upsert `put`,
 * unfiltered `getAll`, `get`, `delete`, and a transaction that completes one
 * task after its last request settles. `workspace-key-handle-store.test.ts`
 * carries a sibling double with add-once semantics and a bounded `getAll`;
 * neither is evidence about any real browser's IndexedDB.
 */
class FakeIndexedDb {
  readonly #stores = new Map<string, Map<string, unknown>>();
  readonly #keyPaths = new Map<string, string>();

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

  getAll(): FakeRequest<unknown[]> {
    return this.transaction.run(() => [...this.rows.values()].map((value) => structuredClone(value)));
  }

  put(value: Record<string, unknown>): FakeRequest<void> {
    return this.transaction.run(() => {
      const key = value[this.keyPath];
      if (typeof key !== "string") throw new Error("fake key path is not a string");
      this.rows.set(key, structuredClone(value));
    });
  }

  delete(key: string): FakeRequest<void> {
    return this.transaction.run(() => { this.rows.delete(key); });
  }
}
