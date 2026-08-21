import { describe, expect, it } from "vitest";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store.test-support";
import type { ObjectRecord, ObjectStore } from "../storage/object-store";
import { VaultReclamationQueue } from "./reclamation-queue";

const T0 = "2026-08-05T10:00:00.000Z";
const T1 = "2026-08-05T12:30:00.000Z";
const KEY_A = "state/workspace/v1/files/aaaaaa";
const KEY_B = "state/workspace/v1/files/bbbbbb";

describe("VaultReclamationQueue", () => {
  it("records supersessions durably across instances, keeping the first supersession time per key", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const first = new VaultReclamationQueue(store, key, () => T0);

    await expect(first.recordSuperseded([KEY_A, KEY_B])).resolves.toBe(true);

    // A replacement instance — the shape a page reload takes — must read the
    // same encrypted, self-validating document back out of the store.
    const second = new VaultReclamationQueue(store, key, () => T1);
    expect(await second.readEntries()).toEqual([
      { kind: "workspace-file", cloudKey: KEY_A, supersededAt: T0 },
      { kind: "workspace-file", cloudKey: KEY_B, supersededAt: T0 },
    ]);

    // Re-recording a key keeps the first recorded time: the honest age of the
    // supersession is when it actually became unreachable, not the last time a
    // racing writer noticed.
    await expect(second.record([
      { kind: "workspace-file", cloudKey: KEY_A },
      { kind: "context-segment", cloudKey: "context/segments/cccccc" },
    ])).resolves.toBe(true);
    expect(await second.readEntries()).toEqual([
      { kind: "context-segment", cloudKey: "context/segments/cccccc", supersededAt: T1 },
      { kind: "workspace-file", cloudKey: KEY_A, supersededAt: T0 },
      { kind: "workspace-file", cloudKey: KEY_B, supersededAt: T0 },
    ]);
    expect((await store.list("state/reclamation/v1/")).length).toBe(1);
  });

  it("drops keys a run confirmed settled and tolerates repeating that confirmation", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const queue = new VaultReclamationQueue(store, key, () => T0);
    await queue.recordSuperseded([KEY_A, KEY_B]);

    await expect(queue.confirmReclaimed([KEY_A])).resolves.toBe(true);
    expect((await queue.readEntries()).map((entry) => entry.cloudKey)).toEqual([KEY_B]);
    await expect(queue.confirmReclaimed([KEY_A, "state/workspace/v1/files/never-queued"])).resolves.toBe(true);
    expect((await queue.readEntries()).map((entry) => entry.cloudKey)).toEqual([KEY_B]);
  });

  it("turns provider commit failures into a false return, never into a broken write path", async () => {
    const { key } = await WorkspaceRootKey.generate();
    // Interface-typed so the fault-injecting facade below can forward signals.
    const store: ObjectStore = new MemoryObjectStore();
    const seeded = new VaultReclamationQueue(store, key, () => T0);
    await seeded.recordSuperseded([KEY_A]);

    let failCommits = true;
    const flaky: ObjectStore = {
      capabilities: store.capabilities,
      get: (cloudKey, signal) => store.get(cloudKey, signal),
      getRange: (cloudKey, start, end, signal) => store.getRange(cloudKey, start, end, signal),
      putIfAbsent: (cloudKey, bytes, signal) => store.putIfAbsent(cloudKey, bytes, signal),
      compareAndSwap: async (cloudKey, etag, bytes, signal) => {
        if (failCommits) throw new Error("provider unavailable");
        return store.compareAndSwap(cloudKey, etag, bytes, signal);
      },
      list: (prefix, signal) => store.list(prefix, signal),
    };
    const queue = new VaultReclamationQueue(flaky, key, () => T1);
    await expect(queue.recordSuperseded([KEY_B])).resolves.toBe(false);
    await expect(queue.confirmReclaimed([KEY_A])).resolves.toBe(false);
    expect((await seeded.readEntries()).map((entry) => entry.cloudKey)).toEqual([KEY_A]);

    failCommits = false;
    await expect(queue.recordSuperseded([KEY_B])).resolves.toBe(true);
    expect((await seeded.readEntries()).map((entry) => entry.cloudKey)).toEqual([KEY_A, KEY_B]);
  });

  it("fails commits once the entry budget is exhausted instead of silently shedding entries", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const queue = new VaultReclamationQueue(store, key, () => T0);
    const fill = Array.from({ length: 10_001 }, (_, index) => `state/workspace/v1/files/f${String(index).padStart(6, "0")}`);
    await expect(queue.recordSuperseded(fill)).resolves.toBe(false);
    expect(await queue.readEntries()).toEqual([]);

    const withinBudget = fill.slice(0, 10_000);
    await expect(queue.recordSuperseded(withinBudget)).resolves.toBe(true);
    expect((await queue.readEntries()).length).toBe(10_000);
    await expect(queue.recordSuperseded(["state/workspace/v1/files/one-more"])).resolves.toBe(false);
    expect((await queue.readEntries()).length).toBe(10_000);
  });

  it("refuses a queue object that does not decrypt and self-validate", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const queue = new VaultReclamationQueue(store, key, () => T0);
    const created = await store.putIfAbsent(await queue.objectKey(), new TextEncoder().encode("not an envelope"));
    expect(created.created).toBe(true);
    await expect(queue.readEntries()).rejects.toThrow();
    // Recording is best-effort by contract: it fails closed without throwing.
    await expect(queue.recordSuperseded([KEY_A])).resolves.toBe(false);
  });

  it("rejects tampered entries on read rather than trusting the encrypted document", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const other = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const queue = new VaultReclamationQueue(store, key, () => T0);
    await queue.recordSuperseded([KEY_A, KEY_B]);
    const objectKey = await queue.objectKey();
    const original: ObjectRecord = await store.get(objectKey).then((record) => {
      if (!record) throw new Error("queue object missing");
      return record;
    });
    // A document sealed by a different root key is an opaque object the wrong
    // authority addressed: authentication must fail, not parse.
    const otherStore = new MemoryObjectStore();
    const otherQueue = new VaultReclamationQueue(otherStore, other.key, () => T1);
    await otherQueue.recordSuperseded([KEY_A]);
    const replacement = await otherStore.get(await otherQueue.objectKey());
    const swapped = await store.compareAndSwap(objectKey, original.etag, replacement!.bytes);
    expect(swapped.updated).toBe(true);
    await expect(queue.readEntries()).rejects.toThrow();
  });
});
