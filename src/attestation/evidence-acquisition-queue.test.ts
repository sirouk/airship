import { describe, expect, it } from "vitest";
import {
  EvidenceAcquisitionAttemptError,
  EvidenceAcquisitionIdentityConflictError,
  EvidenceAcquisitionQueuePersistenceError,
  ReceiptEvidenceAcquisitionQueue,
  evidenceAcquisitionBackoffMs,
  type EvidenceAcquisitionPersistenceCheckpoint,
  type EvidenceAcquisitionPersistencePort,
  type EvidenceAcquisitionQueueSnapshot,
  type EvidenceAcquisitionScheduler,
  type EvidenceAcquisitionWorker,
  type ReceiptEvidenceAcquisitionRequest,
} from "./evidence-acquisition-queue";

describe("receipt evidence acquisition queue", () => {
  it("deduplicates one immutable receipt and rejects conflicting target metadata", async () => {
    const scheduler = new FakeScheduler();
    const worker = new ScriptedWorker(async () => undefined);
    const queue = new ReceiptEvidenceAcquisitionQueue({ worker, scheduler });
    await queue.recover();

    const first = await queue.enqueue(request("receipt-1"));
    const duplicate = await queue.enqueue({ ...request("receipt-1") });
    expect(first.disposition).toBe("queued");
    expect(duplicate).toEqual({ disposition: "duplicate", task: first.task });
    await expect(queue.enqueue({ ...request("receipt-1"), instanceId: "other-instance" }))
      .rejects.toBeInstanceOf(EvidenceAcquisitionIdentityConflictError);
    expect(queue.list()).toHaveLength(1);
    expect(worker.calls).toHaveLength(0);
    queue.dispose();
  });

  it("moves pending → running → retry → success using bounded exponential deadlines", async () => {
    const scheduler = new FakeScheduler(10_000);
    const worker = new ScriptedWorker(async (_request, attempt) => {
      if (attempt < 3) throw new EvidenceAcquisitionAttemptError("network", "Provider did not answer.", true);
    });
    const queue = new ReceiptEvidenceAcquisitionQueue({
      worker,
      scheduler,
      retryPolicy: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 150 },
    });
    await queue.recover();
    await queue.enqueue(request("receipt-retry"));

    scheduler.runDue();
    await queue.settle();
    expect(queue.get("receipt-retry")).toMatchObject({ status: "retry", attempts: 1, dueAt: 10_100 });
    expect(worker.calls.map((call) => call.attempt)).toEqual([1]);

    scheduler.advance(99);
    await queue.settle();
    expect(worker.calls).toHaveLength(1);
    scheduler.advance(1);
    await queue.settle();
    expect(queue.get("receipt-retry")).toMatchObject({ status: "retry", attempts: 2, dueAt: 10_250 });

    scheduler.advance(150);
    await queue.settle();
    expect(queue.get("receipt-retry")).toMatchObject({ status: "succeeded", attempts: 3, completedAt: 10_250 });
    expect(worker.calls.map((call) => call.attempt)).toEqual([1, 2, 3]);
    expect(evidenceAcquisitionBackoffMs(1, { maxAttempts: 9, baseDelayMs: 100, maxDelayMs: 250 })).toBe(100);
    expect(evidenceAcquisitionBackoffMs(2, { maxAttempts: 9, baseDelayMs: 100, maxDelayMs: 250 })).toBe(200);
    expect(evidenceAcquisitionBackoffMs(3, { maxAttempts: 9, baseDelayMs: 100, maxDelayMs: 250 })).toBe(250);
    expect(evidenceAcquisitionBackoffMs(20, { maxAttempts: 20, baseDelayMs: 100, maxDelayMs: 250 })).toBe(250);
    queue.dispose();
  });

  it("makes retry exhaustion and unclassified failures terminal without spinning", async () => {
    const scheduler = new FakeScheduler();
    const retrying = new ScriptedWorker(async () => {
      throw new EvidenceAcquisitionAttemptError("temporarily-unavailable", "Try later.", true);
    });
    const queue = new ReceiptEvidenceAcquisitionQueue({
      worker: retrying,
      scheduler,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 25, maxDelayMs: 25 },
    });
    await queue.recover();
    await queue.enqueue(request("receipt-exhausted"));
    scheduler.runDue();
    await queue.settle();
    scheduler.advance(25);
    await queue.settle();
    expect(queue.get("receipt-exhausted")).toMatchObject({
      status: "failed",
      attempts: 2,
      failure: { code: "temporarily-unavailable", retryable: true },
    });
    scheduler.advance(10_000);
    await queue.settle();
    expect(retrying.calls).toHaveLength(2);

    const unexpectedScheduler = new FakeScheduler();
    const unexpected = new ScriptedWorker(async () => { throw new Error("secret provider body"); });
    const unexpectedQueue = new ReceiptEvidenceAcquisitionQueue({ worker: unexpected, scheduler: unexpectedScheduler });
    await unexpectedQueue.recover();
    await unexpectedQueue.enqueue(request("receipt-unexpected"));
    unexpectedScheduler.runDue();
    await unexpectedQueue.settle();
    expect(unexpectedQueue.get("receipt-unexpected")).toMatchObject({
      status: "failed",
      attempts: 1,
      failure: {
        code: "unexpected",
        message: "Evidence acquisition failed without a classified public reason.",
        retryable: false,
      },
    });
    expect(JSON.stringify(unexpectedQueue.snapshot())).not.toContain("secret provider body");
    queue.dispose();
    unexpectedQueue.dispose();
  });

  it("requires an explicit terminal retry, resets its budget, and redacts classified failure state", async () => {
    const scheduler = new FakeScheduler();
    let invocation = 0;
    const worker = new ScriptedWorker(async () => {
      invocation += 1;
      if (invocation === 1) {
        throw new EvidenceAcquisitionAttemptError(
          "authorization",
          "Bearer private-token sk_this-credential-must-not-persist",
          false,
        );
      }
    });
    const queue = new ReceiptEvidenceAcquisitionQueue({ worker, scheduler });
    await queue.recover();
    await queue.enqueue(request("receipt-explicit-retry"));
    scheduler.runDue();
    await queue.settle();
    expect(queue.get("receipt-explicit-retry")).toMatchObject({
      status: "failed",
      attempts: 1,
      failure: { code: "authorization", message: "Bearer [credential] [credential]", retryable: false },
    });
    expect(JSON.stringify(queue.snapshot())).not.toContain("private-token");
    expect(JSON.stringify(queue.snapshot())).not.toContain("sk_this");

    expect(await queue.retryTerminal("receipt-explicit-retry")).toMatchObject({ status: "pending", attempts: 0 });
    scheduler.runDue();
    await queue.settle();
    const succeeded = queue.get("receipt-explicit-retry");
    expect(succeeded).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(await queue.retryTerminal("receipt-explicit-retry")).toBe(succeeded);
    expect((await queue.enqueue(request("receipt-explicit-retry"))).disposition).toBe("duplicate");
    queue.dispose();
  });

  it("cancels pending and running acquisitions without allowing late completion to overwrite cancellation", async () => {
    const scheduler = new FakeScheduler();
    let runningSignal: AbortSignal | undefined;
    const worker = new ScriptedWorker((_request, _attempt, signal) => new Promise<void>((_resolve, reject) => {
      runningSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const queue = new ReceiptEvidenceAcquisitionQueue({ worker, scheduler });
    await queue.recover();

    await queue.enqueue(request("receipt-pending"));
    expect(await queue.cancel("receipt-pending", "scope-released")).toMatchObject({
      status: "cancelled",
      reason: "scope-released",
      attempts: 0,
    });

    await queue.enqueue(request("receipt-running"));
    scheduler.runDue();
    await eventually(() => queue.get("receipt-running")?.status === "running");
    expect(runningSignal?.aborted).toBe(false);
    expect(await queue.cancel("receipt-running")).toMatchObject({ status: "cancelled", reason: "operator", attempts: 1 });
    expect(runningSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(queue.get("receipt-running")).toMatchObject({ status: "cancelled", reason: "operator" });
    scheduler.advance(60_000);
    expect(worker.calls).toHaveLength(1);
    queue.dispose();
  });

  it("recovers a persisted interrupted run as a bounded retry through the supplied port", async () => {
    const persistence = new MemoryCasPersistence();
    const firstScheduler = new FakeScheduler(5_000);
    const firstWorker = new ScriptedWorker((_request, _attempt, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const first = new ReceiptEvidenceAcquisitionQueue({
      worker: firstWorker,
      scheduler: firstScheduler,
      persistence,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
    });
    await first.recover();
    await first.enqueue(request("receipt-recovered"));
    firstScheduler.runDue();
    await eventually(() => first.get("receipt-recovered")?.status === "running");
    expect(persistence.checkpoint?.snapshot.tasks[0]).toMatchObject({ status: "running", attempts: 1 });
    first.dispose();

    const secondScheduler = new FakeScheduler(6_000);
    const secondWorker = new ScriptedWorker(async () => undefined);
    const second = new ReceiptEvidenceAcquisitionQueue({
      worker: secondWorker,
      scheduler: secondScheduler,
      persistence,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
    });
    await second.recover();
    expect(second.get("receipt-recovered")).toMatchObject({
      status: "retry",
      attempts: 1,
      dueAt: 6_100,
      failure: { code: "interrupted", retryable: true },
    });
    expect(persistence.checkpoint?.snapshot.tasks[0]).toMatchObject({ status: "retry" });
    secondScheduler.advance(100);
    await second.settle();
    expect(second.get("receipt-recovered")).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(secondWorker.calls.map((call) => call.attempt)).toEqual([2]);
    second.dispose();
  });

  it("does not start work until a running-state commit succeeds, and can wake after a transient port fault", async () => {
    const scheduler = new FakeScheduler();
    const persistence = new MemoryCasPersistence();
    const worker = new ScriptedWorker(async () => undefined);
    const queue = new ReceiptEvidenceAcquisitionQueue({ worker, scheduler, persistence });
    await queue.recover();
    await queue.enqueue(request("receipt-persist-first"));
    persistence.failNextSave = true;
    scheduler.runDue();
    await queue.settle();
    expect(queue.fault()).toBeInstanceOf(EvidenceAcquisitionQueuePersistenceError);
    expect(queue.get("receipt-persist-first")).toMatchObject({ status: "pending", attempts: 0 });
    expect(worker.calls).toHaveLength(0);

    await queue.wake();
    await queue.settle();
    expect(queue.fault()).toBeUndefined();
    expect(queue.get("receipt-persist-first")).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(worker.calls).toHaveLength(1);
    queue.dispose();
  });

  it("recovers an orphaned running state after a terminal-state commit fault", async () => {
    const scheduler = new FakeScheduler(2_000);
    const persistence = new MemoryCasPersistence();
    let releaseFirst: (() => void) | undefined;
    const worker = new ScriptedWorker((_request, attempt) => attempt === 1
      ? new Promise<void>((resolve) => { releaseFirst = resolve; })
      : Promise.resolve());
    const queue = new ReceiptEvidenceAcquisitionQueue({
      worker,
      scheduler,
      persistence,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 100 },
    });
    await queue.recover();
    await queue.enqueue(request("receipt-terminal-commit"));
    scheduler.runDue();
    await eventually(() => queue.get("receipt-terminal-commit")?.status === "running" && Boolean(releaseFirst));

    persistence.failNextSave = true;
    releaseFirst!();
    await queue.settle();
    expect(queue.fault()).toBeInstanceOf(EvidenceAcquisitionQueuePersistenceError);
    expect(queue.get("receipt-terminal-commit")).toMatchObject({ status: "running", attempts: 1 });

    await queue.wake();
    expect(queue.get("receipt-terminal-commit")).toMatchObject({
      status: "retry",
      attempts: 1,
      dueAt: 2_050,
      failure: { code: "interrupted" },
    });
    scheduler.advance(50);
    await queue.settle();
    expect(queue.get("receipt-terminal-commit")).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(worker.calls.map((call) => call.attempt)).toEqual([1, 2]);
    queue.dispose();
  });

  it("bounds retained state by pruning the oldest terminal task, never active work", async () => {
    const scheduler = new FakeScheduler();
    const worker = new ScriptedWorker(async () => undefined);
    const queue = new ReceiptEvidenceAcquisitionQueue({ worker, scheduler, maxTasks: 2 });
    await queue.recover();
    await queue.enqueue(request("receipt-oldest"));
    scheduler.runDue();
    await queue.settle();
    scheduler.advance(1);
    await queue.enqueue(request("receipt-newer"));
    scheduler.runDue();
    await queue.settle();
    scheduler.advance(1);
    await queue.enqueue(request("receipt-latest"));
    expect(queue.list().map((task) => task.request.receiptId)).toEqual(["receipt-newer", "receipt-latest"]);
    queue.dispose();

    const activeScheduler = new FakeScheduler();
    const active = new ReceiptEvidenceAcquisitionQueue({ worker: new ScriptedWorker(async () => undefined), scheduler: activeScheduler, maxTasks: 1 });
    await active.recover();
    await active.enqueue(request("receipt-active"));
    await expect(active.enqueue(request("receipt-overflow"))).rejects.toThrow("1-task active boundary");
    active.dispose();
  });
});

function request(receiptId: string): ReceiptEvidenceAcquisitionRequest {
  return Object.freeze({
    version: 1,
    receiptId,
    sessionId: "session-1",
    profileId: "profile-1",
    providerId: "chutes",
    modelId: "model-1",
    chuteId: "chute-1",
    instanceId: "instance-1",
    endpointKeyDigest: `sha256:${"a".repeat(64)}`,
  });
}

class ScriptedWorker implements EvidenceAcquisitionWorker {
  readonly calls: Array<Readonly<{ receiptId: string; attempt: number; signal: AbortSignal }>> = [];

  constructor(
    private readonly script: (
      request: ReceiptEvidenceAcquisitionRequest,
      attempt: number,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  async acquire(
    request: ReceiptEvidenceAcquisitionRequest,
    context: Readonly<{ attempt: number; signal: AbortSignal }>,
  ): Promise<void> {
    this.calls.push(Object.freeze({ receiptId: request.receiptId, attempt: context.attempt, signal: context.signal }));
    await this.script(request, context.attempt, context.signal);
  }
}

class FakeScheduler implements EvidenceAcquisitionScheduler {
  private sequence = 0;
  private readonly timers = new Map<number, Readonly<{ at: number; callback: () => void }>>();

  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence;
    this.timers.set(id, Object.freeze({ at: this.current + delayMs, callback }));
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(Number(handle));
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
    this.runDue();
  }

  runDue(): void {
    while (true) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= this.current)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) return;
      this.timers.delete(next[0]);
      next[1].callback();
    }
  }
}

class MemoryCasPersistence implements EvidenceAcquisitionPersistencePort {
  checkpoint?: EvidenceAcquisitionPersistenceCheckpoint;
  failNextSave = false;
  private revision = 0;

  async load(): Promise<EvidenceAcquisitionPersistenceCheckpoint | undefined> {
    return this.checkpoint;
  }

  async save(
    snapshot: EvidenceAcquisitionQueueSnapshot,
    expectedRevision: string | undefined,
  ): Promise<Readonly<{ revision: string }>> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected persistence failure");
    }
    if (expectedRevision !== this.checkpoint?.revision) throw new Error("injected compare-and-swap conflict");
    const revision = `revision-${++this.revision}`;
    this.checkpoint = Object.freeze({ revision, snapshot });
    return Object.freeze({ revision });
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Deterministic queue condition did not settle.");
}
