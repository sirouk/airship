import { describe, expect, it } from "vitest";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store";
import type {
  ObjectStore,
  UntrackedProviderObjectPage,
  UntrackedProviderReclamationReceipt,
} from "../storage/object-store";
import { EncryptedObjectWorkspace } from "./encrypted-workspace";
import {
  DEFAULT_RECLAMATION_SAFETY_AGE_MS,
  MIN_RECLAMATION_SAFETY_AGE_MS,
  runVaultReclamationSweep,
} from "./reclamation";
import { VaultReclamationQueue } from "./reclamation-queue";

const T0 = new Date("2026-08-05T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const FILES_PREFIX = "state/workspace/v1/files/";

function differentKey(keys: readonly string[], key: string): string {
  const found = keys.find((candidate) => candidate !== key);
  if (!found) throw new Error("expected a second live object key");
  return found;
}

/** A store with no `trash` verb at all, so capability checks answer truthfully. */
function withoutReclamation(store: ObjectStore): ObjectStore {
  return {
    capabilities: store.capabilities,
    get: (key, signal) => store.get(key, signal),
    getRange: (key, start, end, signal) => store.getRange(key, start, end, signal),
    putIfAbsent: (key, bytes, signal) => store.putIfAbsent(key, bytes, signal),
    compareAndSwap: (key, etag, bytes, signal) => store.compareAndSwap(key, etag, bytes, signal),
    list: (prefix, signal) => store.list(prefix, signal),
  };
}

describe("runVaultReclamationSweep — aged supersession queue", () => {
  it("defers young entries, then ages, re-verifies, reclaims, and settles them with a receipt", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const queue = new VaultReclamationQueue(store, key, () => T0.toISOString());
    const workspace = new EncryptedObjectWorkspace(store, key, "state/workspace/v1", () => T0.toISOString(), undefined, queue);

    await workspace.write("/workspace/alpha.txt", "first");
    const [alphaV1] = await store.list(FILES_PREFIX);
    await workspace.write("/workspace/alpha.txt", "second");
    const alphaV2 = differentKey((await store.list(FILES_PREFIX)).map((file) => file.key), alphaV1!.key);
    await workspace.write("/workspace/beta.txt", "removed soon");
    await workspace.remove("/workspace/beta.txt");
    const allKeys = (await store.list(FILES_PREFIX)).map((file) => file.key);
    const betaKey = allKeys.find((candidate) => candidate !== alphaV1!.key && candidate !== alphaV2);
    if (!betaKey) throw new Error("expected the removed beta revision to remain as loose ciphertext");

    // Both edits recorded exactly one supersession each into the durable queue.
    expect([...(await queue.readEntries())].sort((left, right) => left.cloudKey < right.cloudKey ? -1 : 1)).toEqual(
      [
        { kind: "workspace-file", cloudKey: alphaV1!.key, supersededAt: T0.toISOString() },
        { kind: "workspace-file", cloudKey: betaKey, supersededAt: T0.toISOString() },
      ].sort((left, right) => left.cloudKey < right.cloudKey ? -1 : 1),
    );

    const young = await runVaultReclamationSweep({
      store, workspace, queue, now: () => T0, runId: "sweep-young-01",
    });
    expect(young.safetyAgeMs).toBe(DEFAULT_RECLAMATION_SAFETY_AGE_MS);
    expect(young.queue).toMatchObject({
      queued: 2, aged: 0, deferredYoung: 2, requested: 0, reclaimed: 0,
      confirmationCommitted: "not-needed", queueReadable: true,
    });
    expect(young.untracked).toEqual({ status: "unavailable" });
    // Too young: every byte is still exactly where the provider put it.
    expect((await store.list(FILES_PREFIX)).length).toBe(3);

    const agedNow = new Date(T0.getTime() + DEFAULT_RECLAMATION_SAFETY_AGE_MS + DAY_MS);
    const aged = await runVaultReclamationSweep({
      store, workspace, queue, now: () => agedNow, runId: "sweep-aged-001",
    });
    expect(aged.queue).toMatchObject({
      queued: 2, aged: 2, deferredYoung: 0, skippedUnverifiable: 0,
      reconciledReferenced: 0, requested: 2, reclaimed: 2, retained: 0,
      confirmationCommitted: "committed", queueReadable: true,
    });
    expect([...aged.queue.reclaimedKeys].sort()).toEqual([alphaV1!.key, betaKey].sort());
    expect(await queue.readEntries()).toEqual([]);
    expect(await store.get(alphaV1!.key)).toBeUndefined();
    expect(await store.get(betaKey)).toBeUndefined();
    // The live revision and its committed manifest are never sweep candidates.
    expect((await workspace.read("/workspace/alpha.txt"))?.content).toBe("second");
    expect((await store.list(FILES_PREFIX)).map((file) => file.key)).toEqual([alphaV2]);

    const again = await runVaultReclamationSweep({
      store, workspace, queue, now: () => agedNow, runId: "sweep-empty-001",
    });
    expect(again.queue).toMatchObject({ queued: 0, requested: 0, confirmationCommitted: "not-needed" });
  });

  it("reconciles a queue entry the fresh manifest still references, without asking the provider to trash it", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const queue = new VaultReclamationQueue(store, key, () => T0.toISOString());
    const workspace = new EncryptedObjectWorkspace(store, key, "state/workspace/v1", () => T0.toISOString(), undefined, queue);

    await workspace.write("/workspace/alpha.txt", "live");
    const [live] = await store.list(FILES_PREFIX);
    // The stale-writer race the fresh-manifest recheck exists for: a queue
    // entry naming a key the committed manifest still points at.
    await queue.recordSuperseded([live!.key]);

    const agedNow = new Date(T0.getTime() + DEFAULT_RECLAMATION_SAFETY_AGE_MS + DAY_MS);
    const receipt = await runVaultReclamationSweep({
      store, workspace, queue, now: () => agedNow, runId: "sweep-recon-01",
    });
    expect(receipt.queue).toMatchObject({
      queued: 1, aged: 1, reconciledReferenced: 1, requested: 0, reclaimed: 0,
      confirmationCommitted: "committed",
    });
    expect(await store.get(live!.key)).toBeDefined();
    expect((await workspace.read("/workspace/alpha.txt"))?.content).toBe("live");
    expect(await queue.readEntries()).toEqual([]);
  });

  it("skips candidate kinds it cannot re-verify, and re-verifies context segments against the supplied fresh root", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const queue = new VaultReclamationQueue(store, key, () => T0.toISOString());
    const workspace = new EncryptedObjectWorkspace(store, key, "state/workspace/v1", () => T0.toISOString(), undefined, queue);
    const segmentLive = "context/segments/live-segment";
    const segmentDead = "context/segments/dead-segment";
    await store.putIfAbsent(segmentLive, new Uint8Array([1]));
    await store.putIfAbsent(segmentDead, new Uint8Array([2]));
    await queue.record([
      { kind: "context-segment", cloudKey: segmentLive },
      { kind: "context-segment", cloudKey: segmentDead },
    ]);

    const agedNow = new Date(T0.getTime() + DEFAULT_RECLAMATION_SAFETY_AGE_MS + DAY_MS);
    const unverifiable = await runVaultReclamationSweep({
      store, workspace, queue, now: () => agedNow, runId: "sweep-cseg-001",
    });
    expect(unverifiable.queue).toMatchObject({
      aged: 2, skippedUnverifiable: 2, requested: 0, confirmationCommitted: "not-needed",
    });
    expect(await store.get(segmentDead)).toBeDefined();
    expect((await queue.readEntries()).length).toBe(2);

    const resolved = await runVaultReclamationSweep({
      store, workspace, queue, now: () => agedNow, runId: "sweep-cseg-002",
      resolveReferences: async (kind) =>
        kind === "context-segment" ? new Set([segmentLive]) : undefined,
    });
    expect(resolved.queue).toMatchObject({
      queued: 2, aged: 2, skippedUnverifiable: 0,
      reconciledReferenced: 1, requested: 1, reclaimed: 1, retained: 0,
      reclaimedKeys: [segmentDead], confirmationCommitted: "committed",
    });
    expect(await store.get(segmentDead)).toBeUndefined();
    expect(await store.get(segmentLive)).toBeDefined();
    expect(await queue.readEntries()).toEqual([]);
  });

  it("leaves candidates queued and says so when the Vault store cannot reclaim", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const authority = new MemoryObjectStore();
    const store = withoutReclamation(authority);
    const queue = new VaultReclamationQueue(store, key, () => T0.toISOString());
    const workspace = new EncryptedObjectWorkspace(store, key, "state/workspace/v1", () => T0.toISOString(), undefined, queue);

    await workspace.write("/workspace/alpha.txt", "first");
    await workspace.write("/workspace/alpha.txt", "second");
    const [superseded] = await queue.readEntries();

    const agedNow = new Date(T0.getTime() + DEFAULT_RECLAMATION_SAFETY_AGE_MS + DAY_MS);
    const receipt = await runVaultReclamationSweep({
      store, workspace, queue, now: () => agedNow, runId: "sweep-notrash-1",
    });
    expect(receipt.queue).toMatchObject({
      queued: 1, aged: 1, requested: 0, reclaimed: 0, retained: 0,
      confirmationCommitted: "not-needed",
    });
    expect(receipt.queue.note).toContain("cannot reclaim");
    expect(await authority.get(superseded!.cloudKey)).toBeDefined();
    expect((await queue.readEntries()).length).toBe(1);
  });

  it("aborts without sweeping anything when the caller's signal is already raised", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const queue = new VaultReclamationQueue(store, key, () => T0.toISOString());
    const workspace = new EncryptedObjectWorkspace(store, key, "state/workspace/v1", () => T0.toISOString(), undefined, queue);
    await workspace.write("/workspace/alpha.txt", "first");
    await workspace.write("/workspace/alpha.txt", "second");

    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const agedNow = new Date(T0.getTime() + DEFAULT_RECLAMATION_SAFETY_AGE_MS + DAY_MS);
    await expect(runVaultReclamationSweep({
      store, workspace, queue, now: () => agedNow, runId: "sweep-abort-01", signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect((await store.list(FILES_PREFIX)).length).toBe(2);
    expect((await queue.readEntries()).length).toBe(1);
  });
});

/** A tiny provider-side fake with Crash-window bodies only it can see. */
class UntrackedFakeStore extends MemoryObjectStore {
  readonly bodies = new Map<string, { size: number; createdAt?: string; tracked: boolean }>();
  pageSize = 1; // force the sweep to follow nextPageToken across pages

  plant(id: string, options: { size: number; createdAt?: string; tracked?: boolean }): void {
    this.bodies.set(id, { size: options.size, createdAt: options.createdAt, tracked: options.tracked ?? false });
  }

  async listUntrackedProviderObjects(options: { pageSize?: number; pageToken?: string } = {}): Promise<UntrackedProviderObjectPage> {
    const all = [...this.bodies.entries()].filter(([, body]) => !body.tracked);
    const pageSize = options.pageSize ?? this.pageSize;
    const start = options.pageToken ? Number(options.pageToken) : 0;
    const slice = all.slice(start, start + pageSize);
    const next = start + pageSize;
    return Object.freeze({
      objects: Object.freeze(slice.map(([id, body]) => Object.freeze({
        providerObjectId: id,
        size: body.size,
        ...(body.createdAt ? { createdAt: body.createdAt } : {}),
      }))),
      ...(next < all.length ? { nextPageToken: String(next) } : {}),
    });
  }

  async trashUntrackedProviderObjects(ids: readonly string[]): Promise<UntrackedProviderReclamationReceipt> {
    const outcomes = ids.map((id) => {
      const body = this.bodies.get(id);
      if (body?.tracked) return Object.freeze({ providerObjectId: id, reclaimed: false as const, reason: "became-tracked" as const });
      this.bodies.delete(id);
      return Object.freeze({ providerObjectId: id, reclaimed: true as const });
    });
    return Object.freeze({
      requested: ids.length,
      reclaimed: Object.freeze(outcomes.filter((outcome) => outcome.reclaimed).map((outcome) => outcome.providerObjectId)),
      retained: Object.freeze(outcomes.filter((outcome) => !outcome.reclaimed).map((outcome) => outcome.providerObjectId)),
      outcomes: Object.freeze(outcomes),
    });
  }
}

describe("runVaultReclamationSweep — provider-side untracked enumeration", () => {
  it("pages, ages, re-verifies, and reclaims provider orphans while sparing the young and the newly tracked", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new UntrackedFakeStore();
    const queue = new VaultReclamationQueue(store, key, () => T0.toISOString());
    const workspace = new EncryptedObjectWorkspace(store, key, "state/workspace/v1", () => T0.toISOString(), undefined, queue);

    const old = new Date(T0.getTime() - 30 * DAY_MS).toISOString();
    store.plant("orphan-a", { size: 10, createdAt: old });
    store.plant("orphan-b", { size: 20, createdAt: old });
    store.plant("young-c", { size: 30, createdAt: T0.toISOString() });
    store.plant("undated-d", { size: 40 });
    store.plant("won-the-race-e", { size: 50, createdAt: old, tracked: true });

    const receipt = await runVaultReclamationSweep({
      store, workspace, queue, now: () => T0, runId: "sweep-untr-001",
      safetyAgeMs: MIN_RECLAMATION_SAFETY_AGE_MS,
    });
    expect(receipt.untracked).toEqual({
      status: "completed", examined: 4, agedCandidates: 2, requested: 2, reclaimed: 2, retained: 0,
    });
    expect([...store.bodies.keys()].sort()).toEqual(["undated-d", "won-the-race-e", "young-c"]);
    expect(receipt.queue).toMatchObject({ queued: 0, requested: 0 });
  });

  it("never treats an untracked listing failure as license to remove anything", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new UntrackedFakeStore();
    const queue = new VaultReclamationQueue(store, key, () => T0.toISOString());
    const workspace = new EncryptedObjectWorkspace(store, key, "state/workspace/v1", () => T0.toISOString(), undefined, queue);
    const old = new Date(T0.getTime() - 30 * DAY_MS).toISOString();
    store.plant("orphan-a", { size: 10, createdAt: old });

    store.listUntrackedProviderObjects = async () => { throw new Error("provider listing failed"); };
    const receipt = await runVaultReclamationSweep({
      store, workspace, queue, now: () => T0, runId: "sweep-untr-002",
      safetyAgeMs: MIN_RECLAMATION_SAFETY_AGE_MS,
    });
    expect(receipt.untracked).toMatchObject({
      status: "failed", examined: 0, agedCandidates: 0, requested: 0, reclaimed: 0, retained: 0,
    });
    expect(store.bodies.has("orphan-a")).toBe(true);
  });
});

