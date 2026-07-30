import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EvidenceAcquisitionQueuePersistenceError,
  ReceiptEvidenceAcquisitionQueue,
  type EvidenceAcquisitionPersistencePort,
  type EvidenceAcquisitionQueueSnapshot,
} from "../attestation/evidence-acquisition-queue";
import { evidenceAcquisitionNotice, wakeFaultedEvidenceAcquisitionQueue } from "./app";

function snapshotWith(status: "pending" | "retry"): EvidenceAcquisitionQueueSnapshot {
  const task = {
    request: {
      version: 1,
      receiptId: "receipt-1",
      sessionId: "session-1",
      profileId: "profile-1",
      providerId: "chutes",
      modelId: "model-1",
      chuteId: "chute-1",
      instanceId: "instance-1",
    },
    enqueuedAt: 0,
    updatedAt: 0,
    attempts: status === "retry" ? 1 : 0,
    ...(status === "retry"
      ? {
          status,
          dueAt: 0,
          failure: { code: "network", message: "Evidence pull unavailable", retryable: true },
        }
      : { status, dueAt: 0 }),
  } as unknown as EvidenceAcquisitionQueueSnapshot["tasks"][number];
  return Object.freeze({ version: 1, savedAt: 0, tasks: Object.freeze([task]) });
}

describe("evidence acquisition notice honesty", () => {
  it("stops promising a retry while a checkpoint fault has halted the queue", () => {
    // The queue's `schedule()` parks permanently on a persistence fault, so
    // the ordinary retry sentence was a promise nothing kept.
    const retry = snapshotWith("retry");

    expect(evidenceAcquisitionNotice(retry, "receipt-1")).toContain("will retry");
    const faulted = evidenceAcquisitionNotice(retry, "receipt-1", true);
    expect(faulted).toContain("Evidence checkpointing failed");
    expect(faulted).not.toContain("will retry");
    expect(faulted).toContain("the receipt remains unchanged");
  });

  it("reports the fault for scheduled work, and stays silent for a completed one", () => {
    expect(evidenceAcquisitionNotice(snapshotWith("pending"), "receipt-1", true))
      .toContain("Evidence checkpointing failed");
    expect(evidenceAcquisitionNotice(snapshotWith("retry"), "other-receipt", true)).toBeUndefined();
    expect(evidenceAcquisitionNotice(undefined, "receipt-1", true)).toBeUndefined();
  });
});

describe("evidence acquisition self-heal", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

  /** A scheduler that never fires, so `wake()` is the only thing driving work. */
  const inertScheduler = Object.freeze({
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });

  /** One revisioned checkpoint slot, refusable on demand. */
  class RefusablePersistence implements EvidenceAcquisitionPersistencePort {
    refuseNextSave = false;
    private stored?: Readonly<{ snapshot: EvidenceAcquisitionQueueSnapshot; revision: string }>;
    private revisions = 0;

    async load() {
      return this.stored ? Object.freeze({ ...this.stored }) : undefined;
    }

    async save(snapshot: EvidenceAcquisitionQueueSnapshot, expectedRevision: string | undefined) {
      if (this.refuseNextSave) {
        this.refuseNextSave = false;
        throw new Error("The encrypted queue checkpoint was refused.");
      }
      if (expectedRevision !== this.stored?.revision) throw new Error("Stale queue checkpoint revision.");
      const revision = `rev-${String(++this.revisions)}`;
      this.stored = Object.freeze({ snapshot, revision });
      return Object.freeze({ revision });
    }
  }

  it("wakes a queue whose checkpoint was refused, with no attestation record in play", async () => {
    /*
     * The one transient checkpoint failure used to be permanent: `schedule()`
     * parks while a fault stands, and the only production caller of `wake()`
     * sat behind `attestationRecords.length === 0`. This is the state that
     * produces the fault — the first acquisition of a conversation that has no
     * evidence record yet — so the recovery is asserted against a real queue in
     * exactly it, and the driver takes no presentation state at all.
     */
    const persistence = new RefusablePersistence();
    const queue = new ReceiptEvidenceAcquisitionQueue({
      worker: { acquire: async () => undefined },
      scheduler: inertScheduler,
      persistence,
    });
    await queue.recover();
    await queue.enqueue({
      version: 1,
      receiptId: "receipt-1",
      sessionId: "session-1",
      profileId: "profile-1",
      providerId: "chutes",
      modelId: "model-1",
      chuteId: "chute-1",
      instanceId: "instance-1",
    });

    persistence.refuseNextSave = true;
    await expect(queue.wake()).rejects.toBeInstanceOf(EvidenceAcquisitionQueuePersistenceError);
    expect(queue.fault()).toBeInstanceOf(EvidenceAcquisitionQueuePersistenceError);
    expect(queue.get("receipt-1")).toMatchObject({ status: "pending" });

    expect(wakeFaultedEvidenceAcquisitionQueue(queue)).toBe(true);
    // The driver is deliberately fire-and-forget, so settle until the recommit's
    // chained pump has landed rather than assuming one turn of the lock.
    for (let attempt = 0; attempt < 8 && queue.get("receipt-1")?.status !== "succeeded"; attempt += 1) {
      await queue.settle();
    }
    // Woken, not merely poked: the parked checkpoint committed and the acquisition
    // the notice promised actually ran.
    expect(queue.fault()).toBeUndefined();
    expect(queue.get("receipt-1")).toMatchObject({ status: "succeeded" });
    expect(wakeFaultedEvidenceAcquisitionQueue(queue)).toBe(false);
    expect(wakeFaultedEvidenceAcquisitionQueue(undefined)).toBe(false);
    queue.dispose();
  });

  it("drives that recovery from the fault channel, never from the record tick", () => {
    // Structural because the coupling is the defect: an effect keyed on
    // presentation state cannot run in the state that produces the fault.
    const effect = app.slice(
      app.indexOf("if (!evidenceCheckpointFaulted) return;"),
      app.indexOf("}, [evidenceCheckpointFaulted]);"),
    );
    expect(effect).toContain("wakeFaultedEvidenceAcquisitionQueue(evidenceAcquisitionQueue.current)");
    expect(effect).not.toContain("attestationRecords");

    const tick = app.slice(
      app.indexOf("if (attestationRecords.length === 0) return;"),
      app.indexOf("}, [attestationRecords, chutesConnected"),
    );
    expect(tick).not.toContain("wake");
    // The fault reaches state through the queue's own emission, so a fault that
    // arrives while nothing else re-renders still installs the recovery.
    expect(app).toContain("setEvidenceCheckpointFaulted(Boolean(queue.fault()));");
  });
});
