import { describe, expect, it } from "vitest";
import { EvidenceAcquisitionIdentityConflictError } from "./evidence-acquisition-queue";
import type {
  EvidenceAcquisitionQueueSnapshot,
  EvidenceAcquisitionScheduler,
  ReceiptEvidenceAcquisitionRequest,
} from "./evidence-acquisition-queue";
import {
  WorkspaceEvidenceAcquisitionAuthority,
  WorkspaceEvidenceAcquisitionPersistence,
  evidenceAcquisitionQueueCheckpointPath,
} from "./workspace-evidence-acquisition-persistence";
import { WorkspaceConflictError, isWorkspaceControlPlanePath, type WorkspacePort } from "../workspace/contracts";
import { MemoryWorkspace } from "../workspace/memory";
import { migrateWorkspaceState } from "../vault/runtime-adoption";

describe("workspace evidence acquisition persistence", () => {
  it("recovers a queued receipt after the page controller is recreated", async () => {
    const workspace = new MemoryWorkspace();
    const scheduler = new HeldScheduler(1_000);
    let workerInstalled = false;
    let recoveredCalls = 0;
    const first = new WorkspaceEvidenceAcquisitionAuthority({
      worker: { acquire: async () => undefined },
      scheduler,
    });
    const firstBinding = await first.activate(scope(workspace, "memory://page-a", "general"));
    await firstBinding.queue.enqueue(request("receipt-reload", "general"));
    await first.release();

    const stored = await workspace.read(evidenceAcquisitionQueueCheckpointPath("general"));
    expect(stored).toBeDefined();
    expect(isWorkspaceControlPlanePath(stored!.path)).toBe(true);

    // A reload has no memory credential. The persisted task remains inert
    // until connection setup installs a new credential-backed worker.
    expect(recoveredCalls).toBe(0);
    workerInstalled = true;
    const reloaded = new WorkspaceEvidenceAcquisitionAuthority({
      worker: {
        acquire: async () => {
          if (!workerInstalled) throw new Error("worker activated before credential installation");
          recoveredCalls += 1;
        },
      },
      scheduler,
    });
    const recovered = await reloaded.activate(scope(workspace, "memory://page-a", "general"));
    expect(recovered.queue.get("receipt-reload")).toMatchObject({
      status: "pending",
      request: { profileId: "general" },
    });
    scheduler.runAll();
    await recovered.queue.settle();
    expect(recoveredCalls).toBe(1);
    expect(recovered.queue.get("receipt-reload")).toMatchObject({ status: "succeeded" });
    await reloaded.release();
  });

  /*
   * Two tabs are two writers, and a receipt is evidence of a turn that really
   * completed. A strict single-writer CAS made that a data-loss bug rather
   * than a retry: both tabs recover revision R, the first commits its receipt,
   * the second's enqueue is rejected and rolled back, and nothing ever rebuilds
   * it — so the completed turn silently never acquires evidence.
   *
   * The fence is still WorkspacePort revisions. What changed is what a losing
   * writer does with the conflict: re-read, merge by receipt identity, and
   * commit against the observed revision.
   */
  it("converges concurrent writers instead of dropping the loser's receipt", async () => {
    const workspace = new MemoryWorkspace();
    const left = new WorkspaceEvidenceAcquisitionPersistence(workspace, "general");
    const right = new WorkspaceEvidenceAcquisitionPersistence(workspace, "general");
    expect(await left.load()).toBeUndefined();
    expect(await right.load()).toBeUndefined();

    const first = await left.save(snapshot("receipt-left", "general"), undefined);
    const converged = await right.save(snapshot("receipt-right", "general"), undefined);
    expect(converged.revision).not.toBe(first.revision);

    const loaded = await right.load();
    expect(loaded?.revision).toBe(converged.revision);
    expect(loaded?.snapshot.tasks.map((task) => task.request.receiptId))
      .toEqual(["receipt-left", "receipt-right"]);
  });

  it("refuses to merge a receipt identity whose immutable acquisition facts disagree", async () => {
    const workspace = new MemoryWorkspace();
    const left = new WorkspaceEvidenceAcquisitionPersistence(workspace, "general");
    const right = new WorkspaceEvidenceAcquisitionPersistence(workspace, "general");
    await left.save(snapshot("receipt-shared", "general"), undefined);
    await expect(right.save(snapshot("receipt-shared", "general", { modelId: "model-2" }), undefined))
      .rejects.toBeInstanceOf(EvidenceAcquisitionIdentityConflictError);
    expect((await left.load())?.snapshot.tasks[0]?.request.modelId).toBe("model-1");
  });

  it("keeps a terminal acquisition terminal when a stale writer replays it as pending", async () => {
    const workspace = new MemoryWorkspace();
    const winner = new WorkspaceEvidenceAcquisitionPersistence(workspace, "general");
    const stale = new WorkspaceEvidenceAcquisitionPersistence(workspace, "general");
    expect(await stale.load()).toBeUndefined();

    await winner.save(succeeded(snapshot("receipt-shared", "general")), undefined);
    await stale.save(snapshot("receipt-shared", "general"), undefined);

    const loaded = await winner.load();
    expect(loaded?.snapshot.tasks).toHaveLength(1);
    expect(loaded?.snapshot.tasks[0]).toMatchObject({ status: "succeeded" });
  });

  it("bounds the merge retry rather than spinning on a permanently contended checkpoint", async () => {
    const workspace = new MemoryWorkspace();
    await new WorkspaceEvidenceAcquisitionPersistence(workspace, "general")
      .save(snapshot("receipt-seed", "general"), undefined);
    const contended = new WorkspaceEvidenceAcquisitionPersistence(refusingWrites(workspace), "general");
    await expect(contended.save(snapshot("receipt-contended", "general"), undefined))
      .rejects.toBeInstanceOf(WorkspaceConflictError);
  });

  it("isolates checkpoints by Profile path and WorkspacePort authority", async () => {
    const firstAuthority = new MemoryWorkspace();
    const secondAuthority = new MemoryWorkspace();
    const general = new WorkspaceEvidenceAcquisitionPersistence(firstAuthority, "general");
    const research = new WorkspaceEvidenceAcquisitionPersistence(firstAuthority, "research");
    const separateGeneral = new WorkspaceEvidenceAcquisitionPersistence(secondAuthority, "general");

    await general.save(snapshot("receipt-general", "general"), undefined);
    await research.save(snapshot("receipt-research", "research"), undefined);

    expect((await general.load())?.snapshot.tasks[0]?.request.receiptId).toBe("receipt-general");
    expect((await research.load())?.snapshot.tasks[0]?.request.receiptId).toBe("receipt-research");
    expect(await separateGeneral.load()).toBeUndefined();
    await expect(general.save(snapshot("receipt-cross-profile", "research"), (await general.load())?.revision))
      .rejects.toThrow("crosses its active Profile scope");
  });

  it("recovers only after an explicit authority migration copies the checkpoint", async () => {
    const pageMemory = new MemoryWorkspace();
    const adoptedVault = new MemoryWorkspace();
    const source = new WorkspaceEvidenceAcquisitionPersistence(pageMemory, "general");
    const target = new WorkspaceEvidenceAcquisitionPersistence(adoptedVault, "general");
    await source.save(snapshot("receipt-migrated", "general"), undefined);
    expect(await target.load()).toBeUndefined();

    await migrateWorkspaceState(pageMemory, adoptedVault);
    expect((await target.load())?.snapshot.tasks[0]?.request.receiptId).toBe("receipt-migrated");
  });

  it("disposes and restores the correct controller across Profile and authority switches", async () => {
    const firstWorkspace = new MemoryWorkspace();
    const secondWorkspace = new MemoryWorkspace();
    const scheduler = new HeldScheduler(5_000);
    const authority = new WorkspaceEvidenceAcquisitionAuthority({
      worker: {
        acquire: async (_request, context) => new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        }),
      },
      scheduler,
    });

    const general = await authority.activate(scope(firstWorkspace, "vault+s3://first", "general"));
    await general.queue.enqueue(request("receipt-general", "general"));
    scheduler.runAll();
    await eventually(() => general.queue.get("receipt-general")?.status === "running");
    const research = await authority.activate(scope(firstWorkspace, "vault+s3://first", "research"));
    expect(research.queue.list()).toEqual([]);
    await expect(general.queue.enqueue(request("receipt-after-switch", "general")))
      .rejects.toThrow("disposed");
    await research.queue.enqueue(request("receipt-research", "research"));

    const otherAuthority = await authority.activate(scope(secondWorkspace, "vault+s3://second", "research"));
    expect(otherAuthority.queue.list()).toEqual([]);
    const restoredGeneral = await authority.activate(scope(firstWorkspace, "vault+s3://first", "general"));
    expect(restoredGeneral.queue.list().map((task) => task.request.receiptId)).toEqual(["receipt-general"]);
    expect(restoredGeneral.queue.get("receipt-general")).toMatchObject({ status: "retry", attempts: 1 });
    await authority.release();
  });
});

function scope(workspace: MemoryWorkspace, workspaceId: string, profileId: string) {
  return Object.freeze({ workspace, workspaceId, profileId });
}

function request(receiptId: string, profileId: string): ReceiptEvidenceAcquisitionRequest {
  return Object.freeze({
    version: 1,
    receiptId,
    sessionId: `session-${profileId}`,
    profileId,
    providerId: "chutes",
    modelId: "model-1",
    chuteId: "chute-1",
    instanceId: "instance-1",
  });
}

function snapshot(
  receiptId: string,
  profileId: string,
  overrides: Partial<ReceiptEvidenceAcquisitionRequest> = {},
): EvidenceAcquisitionQueueSnapshot {
  return Object.freeze({
    version: 1,
    savedAt: 1_000,
    tasks: Object.freeze([Object.freeze({
      request: Object.freeze({ ...request(receiptId, profileId), ...overrides }),
      enqueuedAt: 1_000,
      updatedAt: 1_000,
      attempts: 0,
      status: "pending" as const,
      dueAt: 1_000,
    })]),
  });
}

function succeeded(source: EvidenceAcquisitionQueueSnapshot): EvidenceAcquisitionQueueSnapshot {
  return Object.freeze({
    ...source,
    tasks: Object.freeze(source.tasks.map((task) => Object.freeze({
      request: task.request,
      enqueuedAt: task.enqueuedAt,
      updatedAt: task.updatedAt + 1,
      attempts: 1,
      status: "succeeded" as const,
      completedAt: task.updatedAt + 1,
    }))),
  });
}

/** Reads through to `inner`; every write loses its compare-and-swap. */
function refusingWrites(inner: WorkspacePort): WorkspacePort {
  return {
    read: (path) => inner.read(path),
    list: (path) => inner.list(path),
    remove: (path, options) => inner.remove(path, options),
    write: () => Promise.reject(new WorkspaceConflictError()),
  };
}

class HeldScheduler implements EvidenceAcquisitionScheduler {
  private readonly callbacks = new Set<() => void>();

  constructor(private readonly current: number) {}

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void): unknown {
    this.callbacks.add(callback);
    return callback;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as () => void);
  }

  runAll(): void {
    const callbacks = [...this.callbacks];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("The evidence acquisition state did not settle.");
}
