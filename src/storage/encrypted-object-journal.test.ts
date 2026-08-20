import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import { EventJournal, JournalConflictError } from "../core/journal";
import { MemoryObjectStore } from "./memory-object-store";
import { WorkspaceRootKey } from "./encrypted-envelope";
import {
  EncryptedJournalCleanupNeededError,
  EncryptedObjectJournalBackend,
} from "./encrypted-object-journal";
import type { ObjectReclamationReceipt } from "./object-store";

class StallingPreCasObjectStore extends MemoryObjectStore {
  private stallNextImmutableWrite = false;
  private enteredStall?: () => void;
  receivedSignal?: AbortSignal;
  compareAndSwapCalls = 0;

  stallNextPut(): Promise<void> {
    this.stallNextImmutableWrite = true;
    return new Promise<void>((resolve) => { this.enteredStall = resolve; });
  }

  override async putIfAbsent(key: string, bytes: Uint8Array, signal?: AbortSignal) {
    if (!this.stallNextImmutableWrite) return super.putIfAbsent(key, bytes);
    this.stallNextImmutableWrite = false;
    this.receivedSignal = signal;
    this.enteredStall?.();
    await new Promise<void>((_resolve, reject) => {
      const refuse = () => reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      if (signal?.aborted) refuse();
      else signal?.addEventListener("abort", refuse, { once: true });
    });
    throw new Error("The stalled immutable write unexpectedly resumed.");
  }

  override compareAndSwap(key: string, expectedEtag: string, bytes: Uint8Array) {
    this.compareAndSwapCalls += 1;
    return super.compareAndSwap(key, expectedEtag, bytes);
  }
}

class AbortAfterCasObjectStore extends MemoryObjectStore {
  abortAfterNextCas?: AbortController;
  receivedCasSignal: AbortSignal | undefined | null = null;

  override async compareAndSwap(
    key: string,
    expectedEtag: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ) {
    const committed = await super.compareAndSwap(key, expectedEtag, bytes);
    if (this.abortAfterNextCas) {
      this.receivedCasSignal = signal;
      const controller = this.abortAfterNextCas;
      this.abortAfterNextCas = undefined;
      controller.abort(new DOMException("Stopped after CAS", "AbortError"));
    }
    return committed;
  }
}

class AbortAfterSegmentPutObjectStore extends MemoryObjectStore {
  abortAfterNextSegmentPut?: AbortController;
  compareAndSwapCalls = 0;

  override async putIfAbsent(key: string, bytes: Uint8Array, signal?: AbortSignal) {
    const created = await super.putIfAbsent(key, bytes);
    if (this.abortAfterNextSegmentPut && key.includes("/session-segments/") && created.created) {
      const controller = this.abortAfterNextSegmentPut;
      this.abortAfterNextSegmentPut = undefined;
      controller.abort(new DOMException("Stopped after segment put", "AbortError"));
    }
    signal?.throwIfAborted();
    return created;
  }

  override compareAndSwap(key: string, expectedEtag: string, bytes: Uint8Array) {
    this.compareAndSwapCalls += 1;
    return super.compareAndSwap(key, expectedEtag, bytes);
  }
}

class CommittedCasResponseFailureObjectStore extends MemoryObjectStore {
  failAfterNextCommittedCas = false;
  readonly trashCalls: string[][] = [];

  override async compareAndSwap(key: string, expectedEtag: string, bytes: Uint8Array) {
    const committed = await super.compareAndSwap(key, expectedEtag, bytes);
    if (this.failAfterNextCommittedCas && committed.updated) {
      this.failAfterNextCommittedCas = false;
      throw new Error("The committed CAS response was lost.");
    }
    return committed;
  }

  override async trash(keys: readonly string[]) {
    this.trashCalls.push([...keys]);
    return super.trash(keys);
  }
}

class InterruptingTrashObjectStore extends MemoryObjectStore {
  interruptNextSegmentBatch = false;
  partiallyRetainNextSegmentBatch = false;
  readonly trashCalls: string[][] = [];

  override async trash(keys: readonly string[]): Promise<ObjectReclamationReceipt> {
    this.trashCalls.push([...keys]);
    const isSegmentBatch = keys.length > 0 && keys.every((key) => key.includes("/session-segments/"));
    if (isSegmentBatch && this.interruptNextSegmentBatch) {
      this.interruptNextSegmentBatch = false;
      const reclaimed = keys.slice(0, Math.max(1, Math.floor(keys.length / 2)));
      await super.trash(reclaimed);
      throw new Error("Vault reclamation was interrupted mid-batch.");
    }
    if (isSegmentBatch && this.partiallyRetainNextSegmentBatch) {
      this.partiallyRetainNextSegmentBatch = false;
      const reclaimed = keys.slice(0, Math.max(1, Math.floor(keys.length / 2)));
      const retained = keys.slice(reclaimed.length);
      await super.trash(reclaimed);
      const reclaimedSet = new Set(reclaimed);
      return Object.freeze({
        requested: keys.length,
        reclaimed: Object.freeze([...reclaimed]),
        retained: Object.freeze([...retained]),
        outcomes: Object.freeze(keys.map((key) => Object.freeze(
          reclaimedSet.has(key)
            ? { key, reclaimed: true as const }
            : { key, reclaimed: false as const, reason: "refused" as const },
        ))),
      });
    }
    return super.trash(keys);
  }
}

class ConcurrentRetryTrashObjectStore extends InterruptingTrashObjectStore {
  private gateTarget = 0;
  private gateEntered = 0;
  private enteredTarget?: () => void;
  private releaseGate?: () => void;
  private resumeGate?: Promise<void>;

  stallNextSegmentBatches(count: number): Promise<void> {
    this.gateTarget = count;
    this.gateEntered = 0;
    this.resumeGate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
    return new Promise<void>((resolve) => { this.enteredTarget = resolve; });
  }

  releaseSegmentBatches(): void {
    this.gateTarget = 0;
    this.releaseGate?.();
  }

  override async trash(keys: readonly string[]): Promise<ObjectReclamationReceipt> {
    if (this.gateTarget > 0 && keys.length > 0 && keys.every((key) => key.includes("/session-segments/"))) {
      this.gateEntered += 1;
      if (this.gateEntered === this.gateTarget) this.enteredTarget?.();
      await this.resumeGate;
    }
    return super.trash(keys);
  }
}

class StallingFirstTrashObjectStore extends MemoryObjectStore {
  private firstTrash = true;
  private entered!: () => void;
  private releaseTrash!: () => void;
  readonly firstTrashEntered = new Promise<void>((resolve) => { this.entered = resolve; });
  private readonly resumeTrash = new Promise<void>((resolve) => { this.releaseTrash = resolve; });

  release(): void {
    this.releaseTrash();
  }

  override async trash(keys: readonly string[]) {
    if (this.firstTrash) {
      this.firstTrash = false;
      this.entered();
      await this.resumeTrash;
    }
    return super.trash(keys);
  }
}

class StallingNextCasObjectStore extends MemoryObjectStore {
  private shouldStall = false;
  private entered?: () => void;
  private releaseCas?: () => void;
  private resumeCas?: Promise<void>;

  stallNextCas(): Promise<void> {
    this.shouldStall = true;
    this.resumeCas = new Promise<void>((resolve) => { this.releaseCas = resolve; });
    return new Promise<void>((resolve) => { this.entered = resolve; });
  }

  release(): void {
    this.releaseCas?.();
  }

  override async compareAndSwap(key: string, expectedEtag: string, bytes: Uint8Array) {
    if (this.shouldStall) {
      this.shouldStall = false;
      this.entered?.();
      await this.resumeCas;
    }
    return super.compareAndSwap(key, expectedEtag, bytes);
  }
}

/**
 * A store that throws from `trash` the way real providers do: Google Drive
 * rejects a call naming more than its key limit outright, and both it and S3
 * can throw mid-sweep on an exhausted retry budget or a raised signal.
 */
class ThrowingTrashObjectStore extends MemoryObjectStore {
  readonly trashBatchSizes: number[] = [];
  maxKeysPerCall = Number.MAX_SAFE_INTEGER;
  throwAfterCalls = Number.MAX_SAFE_INTEGER;

  override async trash(keys: readonly string[]) {
    this.trashBatchSizes.push(keys.length);
    if (keys.length > this.maxKeysPerCall) throw new Error("Vault reclamation exceeds the client key limit.");
    if (this.trashBatchSizes.length > this.throwAfterCalls) throw new Error("Vault reclamation retry budget was exhausted.");
    return super.trash(keys);
  }
}

describe("EncryptedObjectJournalBackend", () => {
  it("round-trips cloud-authoritative sessions without plaintext object bytes", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    let id = 0;
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => `id-${++id}`);
    const session = await journal.createSession("Private title", await manifest());
    await journal.append(session.id, [{ type: "message.user", payload: { content: "private prompt" } }]);

    const sessions = await journal.listSessions();
    const events = await journal.readEvents(session.id);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.headSequence).toBe(2);
    expect(events.map((event) => event.type)).toEqual(["session.created", "message.user"]);
    expect(events[1]!.payload).toEqual({ content: "private prompt" });
    const objects = await store.list("airship/v1/");
    const serializedCiphertext = await Promise.all(objects.map(async (object) => new TextDecoder().decode((await store.get(object.key))!.bytes)));
    expect(serializedCiphertext.join("\n")).not.toContain("Private title");
    expect(serializedCiphertext.join("\n")).not.toContain("private prompt");
  });

  it("serializes concurrent writers with exactly one session-head winner", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    const seed = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await seed.createSession("Race", await manifest());
    const left = new EventJournal(backend, () => "2026-07-18T00:00:01.000Z", () => `left-${crypto.randomUUID()}`);
    const right = new EventJournal(backend, () => "2026-07-18T00:00:01.000Z", () => `right-${crypto.randomUUID()}`);

    const results = await Promise.allSettled([
      left.append(session.id, [{ type: "message.user", payload: { writer: "left" } }]),
      right.append(session.id, [{ type: "message.user", payload: { writer: "right" } }]),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(JournalConflictError);
    const events = await seed.readEvents(session.id);
    expect(events).toHaveLength(2);
    // Head plus the two committed segments; the losing writer's immutable put
    // is reclaimed rather than left as decryptable provider litter.
    expect(await store.list("airship/v1/")).toHaveLength(3);
  });

  it("cancels a fenced append during remote preparation before the head CAS", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new StallingPreCasObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await journal.createSession("Cancelable selection", await manifest());
    const audited = (await journal.getSession(session.id))!;
    const compareAndSwapCallsBeforeSelection = store.compareAndSwapCalls;
    const immutableWriteStarted = store.stallNextPut();
    const controller = new AbortController();

    const selection = journal.appendAtHead(
      session.id,
      { sequence: audited.headSequence, digest: audited.headDigest },
      [{ type: "profile.active-conversation.selected", payload: { generation: 1 } }],
      controller.signal,
    );
    await immutableWriteStarted;
    controller.abort(new DOMException("Return request abandoned", "AbortError"));

    await expect(selection).rejects.toMatchObject({ name: "AbortError" });
    expect(store.receivedSignal).toBe(controller.signal);
    expect(store.compareAndSwapCalls).toBe(compareAndSwapCallsBeforeSelection);
    expect((await journal.readEvents(session.id)).map((event) => event.type))
      .toEqual(["session.created"]);
  });

  it("returns a fenced append that committed before cancellation reached the CAS response", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new AbortAfterCasObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await journal.createSession("Committed selection", await manifest());
    const audited = (await journal.getSession(session.id))!;
    const controller = new AbortController();
    store.abortAfterNextCas = controller;

    const committed = await journal.appendAtHead(
      session.id,
      { sequence: audited.headSequence, digest: audited.headDigest },
      [{ type: "profile.active-conversation.selected", payload: { generation: 1 } }],
      controller.signal,
    );

    expect(controller.signal.aborted).toBe(true);
    expect(store.receivedCasSignal).toBeUndefined();
    expect(committed.session.headSequence).toBe(audited.headSequence + 1);
    expect((await journal.readEvents(session.id)).map((event) => event.type))
      .toEqual(["session.created", "profile.active-conversation.selected"]);
  });

  it("reclaims a segment when cancellation lands after its put but before head CAS", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new AbortAfterSegmentPutObjectStore();
    const journal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const session = await journal.createSession("Abort orphan", await manifest());
    const objectsBefore = (await store.list("airship/v1/")).map((object) => object.key);
    const casCallsBefore = store.compareAndSwapCalls;
    const controller = new AbortController();
    store.abortAfterNextSegmentPut = controller;

    await expect(journal.appendAtHead(
      session.id,
      { sequence: session.headSequence, digest: session.headDigest },
      [{ type: "message.user", payload: { content: "must not become an orphan" } }],
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });

    expect(store.compareAndSwapCalls).toBe(casCallsBefore);
    expect((await store.list("airship/v1/")).map((object) => object.key)).toEqual(objectsBefore);
    expect((await journal.readEvents(session.id)).map((event) => event.type)).toEqual(["session.created"]);
  });

  it("does not reclaim a segment whose head CAS committed before its response failed", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new CommittedCasResponseFailureObjectStore();
    const journal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const session = await journal.createSession("Committed response failure", await manifest());
    store.failAfterNextCommittedCas = true;

    await expect(journal.append(session.id, [
      { type: "message.user", payload: { content: "committed despite response failure" } },
    ])).rejects.toThrow("committed CAS response was lost");

    expect(store.trashCalls).toEqual([]);
    expect((await journal.readEvents(session.id)).map((event) => event.type)).toEqual([
      "session.created",
      "message.user",
    ]);
    expect(await store.list("airship/v1/")).toHaveLength(3);
  });
});

async function manifest() {
  return createSessionManifest({
    systemPrompt: "private system prompt",
    providerId: "test",
    model: "test-model",
    tools: [],
    workspaceId: "workspace",
  });
}

/**
 * Deletion at the tier where it matters most.
 *
 * The encrypted Vault is what a person chose when they decided their
 * conversations were nobody else's business, so "delete" here has to mean the
 * ciphertext is gone from the store, not that the conversation stopped being
 * listed. These read the object store directly afterwards rather than trusting
 * the journal's own view of itself.
 */
describe("EncryptedObjectJournalBackend deletion", () => {
  it("removes the head and every segment from the object store", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await journal.createSession("Doomed", await manifest());
    await journal.append(session.id, [{ type: "message.user", payload: { content: "delete me" } }]);
    const kept = await journal.createSession("Kept", await manifest());
    expect((await store.list("airship/v1/")).length).toBeGreaterThan(2);

    const record = (await journal.getSession(session.id))!;
    await journal.deleteSession(session.id, { sequence: record.headSequence, digest: record.headDigest });

    expect(await journal.getSession(session.id)).toBeUndefined();
    expect((await journal.listSessions()).map((item) => item.id)).toEqual([kept.id]);
    // Nothing of the deleted conversation may remain addressable in the store.
    const remaining = await Promise.all((await store.list("airship/v1/"))
      .map(async (summary) => new TextDecoder().decode((await store.get(summary.key))!.bytes)));
    expect(remaining.join("\n")).not.toContain("delete me");
    // And the conversation that was not deleted is still readable.
    expect(await journal.getSession(kept.id)).toBeDefined();
  });

  it("refuses a delete whose head is not the head that was read", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await journal.createSession("Racing", await manifest());
    const read = (await journal.getSession(session.id))!;
    await journal.append(session.id, [{ type: "message.user", payload: { content: "arrived late" } }]);

    await expect(journal.deleteSession(session.id, { sequence: read.headSequence, digest: read.headDigest }))
      .rejects.toThrow(JournalConflictError);
    expect(await journal.getSession(session.id)).toBeDefined();
  });

  it("reclaims an append segment prepared before a separate deletion wins", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new StallingNextCasObjectStore();
    const seed = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const deleteJournal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const appendJournal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const session = await seed.createSession("Prepared append loses", await manifest());
    const read = (await deleteJournal.getSession(session.id))!;
    const appendCasEntered = store.stallNextCas();
    const append = appendJournal.append(session.id, [
      { type: "message.user", payload: { content: "prepared but never committed" } },
    ]);
    await appendCasEntered;

    await deleteJournal.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    );
    store.release();

    await expect(append).rejects.toBeInstanceOf(JournalConflictError);
    expect(await seed.getSession(session.id)).toBeUndefined();
    expect(await store.list("airship/v1/")).toEqual([]);
  });

  it("makes a deletion winner visible before unconditional trash so a separate writer cannot append", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new StallingFirstTrashObjectStore();
    const seed = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const deleteJournal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const appendJournal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const session = await seed.createSession("Delete wins", await manifest());
    const read = (await deleteJournal.getSession(session.id))!;

    const deletion = deleteJournal.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    );
    await store.firstTrashEntered;
    const append = appendJournal.append(session.id, [
      { type: "message.user", payload: { content: "must not land after deletion" } },
    ]);

    await expect(append).rejects.toThrow(`Unknown session: ${session.id}`);
    store.release();
    await expect(deletion).resolves.toBeUndefined();
    expect(await seed.getSession(session.id)).toBeUndefined();
    expect(await seed.readEvents(session.id)).toEqual([]);
    expect(await store.list("airship/v1/")).toEqual([]);
  });

  it("conflicts a stale deletion when a separate writer wins the head CAS", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new StallingNextCasObjectStore();
    const seed = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const deleteJournal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const appendJournal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const session = await seed.createSession("Append wins", await manifest());
    const read = (await deleteJournal.getSession(session.id))!;
    const deletionCasEntered = store.stallNextCas();
    const deletion = deleteJournal.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    );
    await deletionCasEntered;

    await appendJournal.append(session.id, [
      { type: "message.user", payload: { content: "committed before deletion" } },
    ]);
    store.release();

    await expect(deletion).rejects.toBeInstanceOf(JournalConflictError);
    expect((await seed.getSession(session.id))?.headSequence).toBe(2);
    expect((await seed.readEvents(session.id)).map((event) => event.type)).toEqual([
      "session.created",
      "message.user",
    ]);
  });

  it("keeps the authenticated marker when a provider returns a partial segment receipt", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new InterruptingTrashObjectStore();
    const journal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const session = await journal.createSession("Partial cleanup", await manifest());
    await journal.append(session.id, [{ type: "message.user", payload: { index: 1 } }]);
    await journal.append(session.id, [{ type: "message.user", payload: { index: 2 } }]);
    const read = (await journal.getSession(session.id))!;
    store.partiallyRetainNextSegmentBatch = true;

    await expect(journal.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    )).rejects.toBeInstanceOf(EncryptedJournalCleanupNeededError);

    expect(await journal.getSession(session.id)).toBeUndefined();
    expect(await journal.listSessions()).toEqual([]);
    expect(await store.list("airship/v1/session-heads/")).toHaveLength(1);
    expect(await store.list("airship/v1/session-segments/")).toHaveLength(2);
    // No marker reclamation is admissible after an incomplete receipt.
    expect(store.trashCalls).toHaveLength(1);
    expect(store.trashCalls[0]!.every((key) => key.includes("/session-segments/"))).toBe(true);

    await expect(journal.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    )).resolves.toBeUndefined();
    expect(store.trashCalls.at(-1)!.every((key) => key.includes("/session-heads/"))).toBe(true);
    expect(await store.list("airship/v1/")).toEqual([]);
  });

  it("retries deterministically after a provider throws midway through a segment batch", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new InterruptingTrashObjectStore();
    const journal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const session = await journal.createSession("Interrupted cleanup", await manifest());
    await journal.append(session.id, [{ type: "message.user", payload: { index: 1 } }]);
    await journal.append(session.id, [{ type: "message.user", payload: { index: 2 } }]);
    const read = (await journal.getSession(session.id))!;
    store.interruptNextSegmentBatch = true;

    await expect(journal.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    )).rejects.toMatchObject({
      name: "EncryptedJournalCleanupNeededError",
      cause: expect.objectContaining({ message: "Vault reclamation was interrupted mid-batch." }),
    });
    expect(await store.list("airship/v1/session-heads/")).toHaveLength(1);
    expect(await store.list("airship/v1/session-segments/")).toHaveLength(2);

    await expect(journal.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    )).resolves.toBeUndefined();
    expect(await store.list("airship/v1/")).toEqual([]);
  });

  it("allows concurrent cleanup retries and a later absent retry to remain idempotent", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new ConcurrentRetryTrashObjectStore();
    const seed = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const session = await seed.createSession("Concurrent cleanup", await manifest());
    await seed.append(session.id, [{ type: "message.user", payload: { content: "delete me" } }]);
    const read = (await seed.getSession(session.id))!;
    store.partiallyRetainNextSegmentBatch = true;
    await expect(seed.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    )).rejects.toBeInstanceOf(EncryptedJournalCleanupNeededError);

    const bothSegmentBatchesEntered = store.stallNextSegmentBatches(2);
    const left = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const right = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const retries = [left, right].map((journal) => journal.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    ));
    await bothSegmentBatchesEntered;
    store.releaseSegmentBatches();

    await expect(Promise.all(retries)).resolves.toEqual([undefined, undefined]);
    await expect(seed.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    )).resolves.toBeUndefined();
    expect(await store.list("airship/v1/")).toEqual([]);
  });

  it("keeps the marker retryable when its last, post-segment reclamation throws", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new ThrowingTrashObjectStore();
    const journal = new EventJournal(new EncryptedObjectJournalBackend(store, key));
    const session = await journal.createSession("Marker retry", await manifest());
    await journal.append(session.id, [{ type: "message.user", payload: { content: "delete me" } }]);
    const read = (await journal.getSession(session.id))!;
    store.throwAfterCalls = 1;

    await expect(journal.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    )).rejects.toBeInstanceOf(EncryptedJournalCleanupNeededError);
    expect(await store.list("airship/v1/session-segments/")).toEqual([]);
    expect(await store.list("airship/v1/session-heads/")).toHaveLength(1);

    store.throwAfterCalls = Number.MAX_SAFE_INTEGER;
    await expect(journal.deleteSession(
      session.id,
      { sequence: read.headSequence, digest: read.headDigest },
    )).resolves.toBeUndefined();
    expect(await store.list("airship/v1/")).toEqual([]);
  });

  it("sweeps a long conversation's segments in batches no provider will reject outright", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new ThrowingTrashObjectStore();
    const backend = new EncryptedObjectJournalBackend(store, key);
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await journal.createSession("Long-running", await manifest());
    // One segment per append, plus the one `session.created` wrote: 501 in all,
    // more than a single sweep batch and enough that an unbatched call to a
    // real Drive vault would refuse the whole set.
    for (let index = 0; index < 500; index += 1) {
      await journal.append(session.id, [{ type: "message.user", payload: { index } }]);
    }
    store.maxKeysPerCall = 500;

    const record = (await journal.getSession(session.id))!;
    await journal.deleteSession(session.id, { sequence: record.headSequence, digest: record.headDigest });

    // Every segment is confirmed in provider-safe batches before the marker is
    // reclaimed last — and nothing survives.
    expect(store.trashBatchSizes).toEqual([500, 1, 1]);
    expect(await journal.getSession(session.id)).toBeUndefined();
    expect(await store.list("airship/v1/")).toEqual([]);
  }, 60_000);

  it("says so rather than reporting a deletion a store cannot perform", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    // A store from the base contract, which is deliberately delete-free.
    const unreclaimable = Object.create(store, { trash: { value: undefined } }) as typeof store;
    const backend = new EncryptedObjectJournalBackend(unreclaimable, key);
    const journal = new EventJournal(backend, () => "2026-07-18T00:00:00.000Z", () => crypto.randomUUID());
    const session = await journal.createSession("Undeletable", await manifest());
    const record = (await journal.getSession(session.id))!;

    await expect(journal.deleteSession(session.id, { sequence: record.headSequence, digest: record.headDigest }))
      .rejects.toThrow(/cannot delete objects/u);
    // Telling someone their conversation is gone while the ciphertext stays is
    // the one outcome worse than refusing.
    expect(await journal.getSession(session.id)).toBeDefined();
  });
});
