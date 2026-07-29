/**
 * Receipt-keyed endpoint-evidence acquisition coordination.
 *
 * This module owns scheduling state only. It does not store evidence, retain a
 * credential, or imply that a supplied persistence port is encrypted or
 * durable. A caller must wire those boundaries explicitly.
 */

export type ReceiptEvidenceAcquisitionRequest = Readonly<{
  version: 1;
  receiptId: string;
  sessionId: string;
  profileId: string;
  providerId: "chutes";
  modelId: string;
  chuteId: string;
  instanceId: string;
  endpointKeyDigest?: string;
}>;

export type EvidenceAcquisitionFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

type EvidenceAcquisitionTaskBase = Readonly<{
  request: ReceiptEvidenceAcquisitionRequest;
  enqueuedAt: number;
  updatedAt: number;
  attempts: number;
}>;

export type PendingEvidenceAcquisition = EvidenceAcquisitionTaskBase & Readonly<{
  status: "pending";
  dueAt: number;
}>;

export type RunningEvidenceAcquisition = EvidenceAcquisitionTaskBase & Readonly<{
  status: "running";
  attempt: number;
  startedAt: number;
}>;

export type RetryEvidenceAcquisition = EvidenceAcquisitionTaskBase & Readonly<{
  status: "retry";
  dueAt: number;
  failure: EvidenceAcquisitionFailure;
}>;

export type SucceededEvidenceAcquisition = EvidenceAcquisitionTaskBase & Readonly<{
  status: "succeeded";
  completedAt: number;
}>;

export type FailedEvidenceAcquisition = EvidenceAcquisitionTaskBase & Readonly<{
  status: "failed";
  failedAt: number;
  failure: EvidenceAcquisitionFailure;
}>;

export type EvidenceAcquisitionCancellationReason = "operator" | "scope-released" | "superseded";

export type CancelledEvidenceAcquisition = EvidenceAcquisitionTaskBase & Readonly<{
  status: "cancelled";
  cancelledAt: number;
  reason: EvidenceAcquisitionCancellationReason;
}>;

export type EvidenceAcquisitionTask =
  | PendingEvidenceAcquisition
  | RunningEvidenceAcquisition
  | RetryEvidenceAcquisition
  | SucceededEvidenceAcquisition
  | FailedEvidenceAcquisition
  | CancelledEvidenceAcquisition;

export type EvidenceAcquisitionQueueSnapshot = Readonly<{
  version: 1;
  savedAt: number;
  tasks: readonly EvidenceAcquisitionTask[];
}>;

export type EvidenceAcquisitionPersistenceCheckpoint = Readonly<{
  revision: string;
  snapshot: EvidenceAcquisitionQueueSnapshot;
}>;

/**
 * Single-writer persistence boundary. `revision` is an opaque compare-and-swap
 * token. Implementing this interface alone says nothing about encryption,
 * browser-restart survival, or cross-device durability.
 */
export interface EvidenceAcquisitionPersistencePort {
  load(signal?: AbortSignal): Promise<EvidenceAcquisitionPersistenceCheckpoint | undefined>;
  save(
    snapshot: EvidenceAcquisitionQueueSnapshot,
    expectedRevision: string | undefined,
    signal?: AbortSignal,
  ): Promise<Readonly<{ revision: string }>>;
}

export interface EvidenceAcquisitionWorker {
  /**
   * At-least-once boundary: an interrupted attempt can have completed outside
   * this controller before its terminal checkpoint landed. Implementations
   * must commit observations idempotently under `request.receiptId`.
   */
  acquire(
    request: ReceiptEvidenceAcquisitionRequest,
    context: Readonly<{ attempt: number; signal: AbortSignal }>,
  ): Promise<void>;
}

export interface EvidenceAcquisitionScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type EvidenceAcquisitionRetryPolicy = Readonly<{
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}>;

export const DEFAULT_EVIDENCE_ACQUISITION_RETRY_POLICY: EvidenceAcquisitionRetryPolicy = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
});

export type EvidenceAcquisitionQueueOptions = Readonly<{
  worker: EvidenceAcquisitionWorker;
  persistence?: EvidenceAcquisitionPersistencePort;
  scheduler?: EvidenceAcquisitionScheduler;
  retryPolicy?: EvidenceAcquisitionRetryPolicy;
  concurrency?: number;
  maxTasks?: number;
}>;

export type EvidenceAcquisitionEnqueueResult = Readonly<{
  disposition: "queued" | "duplicate";
  task: EvidenceAcquisitionTask;
}>;

export class EvidenceAcquisitionAttemptError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly publicMessage: string;

  constructor(code: string, publicMessage: string, retryable: boolean) {
    super(safeFailureMessage(publicMessage));
    this.name = "EvidenceAcquisitionAttemptError";
    this.code = safeFailureCode(code);
    this.publicMessage = safeFailureMessage(publicMessage);
    this.retryable = retryable;
  }
}

export class EvidenceAcquisitionIdentityConflictError extends Error {
  constructor(receiptId: string) {
    super(`Receipt ${receiptId} was queued with conflicting immutable acquisition metadata.`);
    this.name = "EvidenceAcquisitionIdentityConflictError";
  }
}

export class EvidenceAcquisitionQueuePersistenceError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("The evidence acquisition queue state could not be committed through its persistence port.");
    this.name = "EvidenceAcquisitionQueuePersistenceError";
    this.cause = cause;
  }
}

type ActiveRun = Readonly<{
  token: number;
  controller: AbortController;
  promise: Promise<void>;
}>;

const DEFAULT_MAX_TASKS = 256;
const DEFAULT_CONCURRENCY = 1;
const MAX_ID_LENGTH = 1_024;
const MAX_FAILURE_MESSAGE_LENGTH = 320;
const MAX_FAILURE_CODE_LENGTH = 80;

export class ReceiptEvidenceAcquisitionQueue {
  private readonly worker: EvidenceAcquisitionWorker;
  private readonly persistence?: EvidenceAcquisitionPersistencePort;
  private readonly scheduler: EvidenceAcquisitionScheduler;
  private readonly retryPolicy: EvidenceAcquisitionRetryPolicy;
  private readonly concurrency: number;
  private readonly maxTasks: number;
  private readonly tasks = new Map<string, EvidenceAcquisitionTask>();
  private readonly listeners = new Set<(snapshot: EvidenceAcquisitionQueueSnapshot) => void>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private operations: Promise<void> = Promise.resolve();
  private persistenceRevision?: string;
  private wakeTimer?: unknown;
  private runToken = 0;
  private recovered = false;
  private disposed = false;
  private persistenceFault?: EvidenceAcquisitionQueuePersistenceError;

  constructor(options: EvidenceAcquisitionQueueOptions) {
    this.worker = options.worker;
    this.persistence = options.persistence;
    this.scheduler = options.scheduler ?? SYSTEM_EVIDENCE_ACQUISITION_SCHEDULER;
    this.retryPolicy = validateRetryPolicy(options.retryPolicy ?? DEFAULT_EVIDENCE_ACQUISITION_RETRY_POLICY);
    this.concurrency = positiveBoundedInteger(options.concurrency ?? DEFAULT_CONCURRENCY, 1, 16, "concurrency");
    this.maxTasks = positiveBoundedInteger(options.maxTasks ?? DEFAULT_MAX_TASKS, 1, 4_096, "task limit");
  }

  /**
   * Hydrates scheduler state from the supplied port. A recovered `running`
   * task is never assumed to have completed: it becomes a bounded retry, or a
   * terminal failure when its attempt budget was already exhausted.
   */
  async recover(signal?: AbortSignal): Promise<EvidenceAcquisitionQueueSnapshot> {
    return this.exclusive(async () => {
      this.assertUsable(false);
      if (this.recovered) return this.snapshot();
      const checkpoint = this.persistence ? await this.persistence.load(signal) : undefined;
      signal?.throwIfAborted();
      const restored = checkpoint
        ? validateQueueSnapshot(checkpoint.snapshot, this.maxTasks)
        : emptySnapshot(this.scheduler.now());
      if (checkpoint && !validRevision(checkpoint.revision)) {
        throw new Error("Evidence acquisition persistence returned an invalid revision token.");
      }
      this.tasks.clear();
      for (const task of restored.tasks) this.tasks.set(task.request.receiptId, task);
      this.persistenceRevision = checkpoint?.revision;
      this.recovered = true;

      const interrupted = [...this.tasks.values()].filter((task): task is RunningEvidenceAcquisition => task.status === "running");
      if (interrupted.length > 0) {
        const now = this.scheduler.now();
        const previous = new Map(this.tasks);
        for (const task of interrupted) {
          const failure = interruptedFailure();
          this.tasks.set(task.request.receiptId, task.attempts >= this.retryPolicy.maxAttempts
            ? freezeTask({
                ...baseFrom(task, now),
                status: "failed",
                failedAt: now,
                failure,
              })
            : freezeTask({
                ...baseFrom(task, now),
                status: "retry",
                dueAt: now + evidenceAcquisitionBackoffMs(task.attempts, this.retryPolicy),
                failure,
              }));
        }
        try {
          await this.persistCurrent(signal);
        } catch (error) {
          this.replaceTasks(previous);
          this.recovered = false;
          throw error;
        }
      }
      this.emit();
      this.schedule();
      return this.snapshot();
    });
  }

  async enqueue(request: ReceiptEvidenceAcquisitionRequest, signal?: AbortSignal): Promise<EvidenceAcquisitionEnqueueResult> {
    const normalized = validateRequest(request);
    return this.exclusive(async () => {
      this.assertUsable();
      signal?.throwIfAborted();
      const existing = this.tasks.get(normalized.receiptId);
      if (existing) {
        if (!sameRequest(existing.request, normalized)) {
          throw new EvidenceAcquisitionIdentityConflictError(normalized.receiptId);
        }
        return Object.freeze({ disposition: "duplicate", task: existing });
      }
      const previous = new Map(this.tasks);
      this.makeRoomForTask();
      const now = this.scheduler.now();
      const task = freezeTask({
        request: normalized,
        enqueuedAt: now,
        updatedAt: now,
        attempts: 0,
        status: "pending",
        dueAt: now,
      });
      this.tasks.set(normalized.receiptId, task);
      try {
        await this.persistCurrent(signal);
      } catch (error) {
        this.replaceTasks(previous);
        throw error;
      }
      this.emit();
      this.schedule();
      return Object.freeze({ disposition: "queued", task });
    });
  }

  async cancel(
    receiptId: string,
    reason: EvidenceAcquisitionCancellationReason = "operator",
    signal?: AbortSignal,
  ): Promise<EvidenceAcquisitionTask | undefined> {
    const cancellationReason = validateCancellationReason(reason);
    return this.exclusive(async () => {
      this.assertUsable();
      signal?.throwIfAborted();
      const current = this.tasks.get(receiptId);
      if (!current || isTerminalEvidenceAcquisition(current)) return current;
      const previous = new Map(this.tasks);
      const now = this.scheduler.now();
      const cancelled = freezeTask({
        ...baseFrom(current, now),
        status: "cancelled",
        cancelledAt: now,
        reason: cancellationReason,
      });
      this.tasks.set(receiptId, cancelled);
      try {
        await this.persistCurrent(signal);
      } catch (error) {
        this.replaceTasks(previous);
        throw error;
      }
      const run = this.activeRuns.get(receiptId);
      if (run) {
        this.activeRuns.delete(receiptId);
        run.controller.abort(new DOMException("Evidence acquisition was cancelled.", "AbortError"));
      }
      this.emit();
      this.schedule();
      return cancelled;
    });
  }

  /** Starts a fresh attempt budget only for a cancelled or failed receipt. */
  async retryTerminal(receiptId: string, signal?: AbortSignal): Promise<EvidenceAcquisitionTask | undefined> {
    return this.exclusive(async () => {
      this.assertUsable();
      signal?.throwIfAborted();
      const current = this.tasks.get(receiptId);
      if (!current) return undefined;
      if (current.status === "succeeded") return current;
      if (current.status !== "failed" && current.status !== "cancelled") return current;
      const previous = new Map(this.tasks);
      const now = this.scheduler.now();
      const pending = freezeTask({
        request: current.request,
        enqueuedAt: current.enqueuedAt,
        updatedAt: now,
        attempts: 0,
        status: "pending",
        dueAt: now,
      });
      this.tasks.set(receiptId, pending);
      try {
        await this.persistCurrent(signal);
      } catch (error) {
        this.replaceTasks(previous);
        throw error;
      }
      this.emit();
      this.schedule();
      return pending;
    });
  }

  async forgetTerminal(receiptId: string, signal?: AbortSignal): Promise<boolean> {
    return this.exclusive(async () => {
      this.assertUsable();
      signal?.throwIfAborted();
      const current = this.tasks.get(receiptId);
      if (!current || !isTerminalEvidenceAcquisition(current)) return false;
      const previous = new Map(this.tasks);
      this.tasks.delete(receiptId);
      try {
        await this.persistCurrent(signal);
      } catch (error) {
        this.replaceTasks(previous);
        throw error;
      }
      this.emit();
      this.schedule();
      return true;
    });
  }

  get(receiptId: string): EvidenceAcquisitionTask | undefined {
    return this.tasks.get(receiptId);
  }

  list(): readonly EvidenceAcquisitionTask[] {
    return Object.freeze(sortedTasks(this.tasks.values()));
  }

  snapshot(): EvidenceAcquisitionQueueSnapshot {
    return freezeSnapshot(this.scheduler.now(), this.tasks.values());
  }

  fault(): EvidenceAcquisitionQueuePersistenceError | undefined {
    return this.persistenceFault;
  }

  subscribe(listener: (snapshot: EvidenceAcquisitionQueueSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Retries a due scheduler transition after a transient persistence fault. */
  async wake(): Promise<void> {
    this.assertUsable();
    await this.pump();
  }

  /** Waits for mutations and currently running workers, but not future retries. */
  async settle(): Promise<void> {
    while (true) {
      await this.operations;
      const running = [...this.activeRuns.values()].map((run) => run.promise);
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  /**
   * Stops page-lifetime scheduling without converting persisted work to
   * `cancelled`. A later controller may recover an interrupted `running` state
   * through its explicitly supplied persistence port.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.wakeTimer !== undefined) this.scheduler.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    for (const run of this.activeRuns.values()) {
      run.controller.abort(new DOMException("Evidence acquisition controller disposed.", "AbortError"));
    }
    this.activeRuns.clear();
    this.listeners.clear();
  }

  private async pump(): Promise<void> {
    await this.exclusive(async () => {
      this.assertUsable();
      this.wakeTimer = undefined;
      const orphaned = [...this.tasks.values()].filter((task): task is RunningEvidenceAcquisition =>
        task.status === "running" && !this.activeRuns.has(task.request.receiptId));
      if (orphaned.length > 0) {
        const previous = new Map(this.tasks);
        const now = this.scheduler.now();
        for (const task of orphaned) {
          this.tasks.set(task.request.receiptId, interruptedTask(task, now, this.retryPolicy));
        }
        try {
          await this.persistCurrent();
        } catch (error) {
          this.replaceTasks(previous);
          throw error;
        }
        this.emit();
      }
      const starts: RunningEvidenceAcquisition[] = [];
      while (this.activeRuns.size + starts.length < this.concurrency) {
        const current = this.nextReadyTask();
        if (!current) break;
        const previous = new Map(this.tasks);
        const now = this.scheduler.now();
        const attempt = current.attempts + 1;
        const running = freezeTask({
          ...baseFrom(current, now),
          attempts: attempt,
          status: "running",
          attempt,
          startedAt: now,
        });
        this.tasks.set(current.request.receiptId, running);
        try {
          await this.persistCurrent();
        } catch (error) {
          this.replaceTasks(previous);
          throw error;
        }
        starts.push(running);
        this.emit();
      }
      // `dispose()` is synchronous and may land while the running checkpoint
      // above is awaiting its persistence port. In that race the checkpoint is
      // intentionally left as `running` for destination recovery, but no new
      // worker may be born after the controller has released its authority.
      if (this.disposed) return;
      for (const task of starts) this.startWorker(task);
      this.schedule();
    }).catch((error) => {
      if (error instanceof EvidenceAcquisitionQueuePersistenceError) {
        this.persistenceFault = error;
        this.cancelWakeTimer();
      }
      throw error;
    });
  }

  private startWorker(task: RunningEvidenceAcquisition): void {
    const controller = new AbortController();
    const token = ++this.runToken;
    const promise = this.executeWorker(task, token, controller);
    this.activeRuns.set(task.request.receiptId, Object.freeze({ token, controller, promise }));
  }

  private async executeWorker(
    task: RunningEvidenceAcquisition,
    token: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      await this.worker.acquire(task.request, { attempt: task.attempt, signal: controller.signal });
      await this.finishAttempt(task.request.receiptId, token, undefined);
    } catch (error) {
      await this.finishAttempt(task.request.receiptId, token, failureFrom(error));
    }
  }

  private async finishAttempt(
    receiptId: string,
    token: number,
    failure: EvidenceAcquisitionFailure | undefined,
  ): Promise<void> {
    await this.exclusive(async () => {
      const run = this.activeRuns.get(receiptId);
      if (!run || run.token !== token) return;
      this.activeRuns.delete(receiptId);
      if (this.disposed) return;
      const current = this.tasks.get(receiptId);
      if (!current || current.status !== "running" || current.attempt !== current.attempts) return;
      const previous = new Map(this.tasks);
      const now = this.scheduler.now();
      const next = !failure
        ? freezeTask({
            ...baseFrom(current, now),
            status: "succeeded",
            completedAt: now,
          })
        : failure.retryable && current.attempts < this.retryPolicy.maxAttempts
          ? freezeTask({
              ...baseFrom(current, now),
              status: "retry",
              dueAt: now + evidenceAcquisitionBackoffMs(current.attempts, this.retryPolicy),
              failure,
            })
          : freezeTask({
              ...baseFrom(current, now),
              status: "failed",
              failedAt: now,
              failure,
            });
      this.tasks.set(receiptId, next);
      try {
        await this.persistCurrent();
      } catch (error) {
        this.replaceTasks(previous);
        throw error;
      }
      this.emit();
      this.schedule();
    }).catch((error) => {
      if (error instanceof EvidenceAcquisitionQueuePersistenceError) {
        this.persistenceFault = error;
        this.cancelWakeTimer();
      }
    });
  }

  private schedule(): void {
    this.cancelWakeTimer();
    if (!this.recovered || this.disposed || this.persistenceFault) return;
    if (this.activeRuns.size >= this.concurrency) return;
    const next = [...this.tasks.values()]
      .filter(isScheduledEvidenceAcquisition)
      .sort((left, right) => left.dueAt - right.dueAt || left.enqueuedAt - right.enqueuedAt || left.request.receiptId.localeCompare(right.request.receiptId))[0];
    if (!next) return;
    const delay = Math.max(0, next.dueAt - this.scheduler.now());
    this.wakeTimer = this.scheduler.setTimeout(() => {
      this.wakeTimer = undefined;
      void this.pump().catch(() => {
        // `pump` records a persistence fault and requires an explicit `wake`.
      });
    }, delay);
  }

  private nextReadyTask(): PendingEvidenceAcquisition | RetryEvidenceAcquisition | undefined {
    const now = this.scheduler.now();
    return [...this.tasks.values()]
      .filter((task): task is PendingEvidenceAcquisition | RetryEvidenceAcquisition =>
        isScheduledEvidenceAcquisition(task) && task.dueAt <= now)
      .sort((left, right) => left.dueAt - right.dueAt || left.enqueuedAt - right.enqueuedAt || left.request.receiptId.localeCompare(right.request.receiptId))[0];
  }

  private async persistCurrent(signal?: AbortSignal): Promise<void> {
    if (!this.persistence) {
      this.persistenceFault = undefined;
      return;
    }
    try {
      const result = await this.persistence.save(this.snapshot(), this.persistenceRevision, signal);
      if (!validRevision(result.revision)) throw new Error("Evidence acquisition persistence returned an invalid revision token.");
      this.persistenceRevision = result.revision;
      this.persistenceFault = undefined;
    } catch (error) {
      throw error instanceof EvidenceAcquisitionQueuePersistenceError
        ? error
        : new EvidenceAcquisitionQueuePersistenceError(error);
    }
  }

  private makeRoomForTask(): void {
    if (this.tasks.size < this.maxTasks) return;
    const removable = sortedTasks(this.tasks.values()).filter(isTerminalEvidenceAcquisition);
    while (this.tasks.size >= this.maxTasks && removable.length > 0) {
      const task = removable.shift()!;
      this.tasks.delete(task.request.receiptId);
    }
    if (this.tasks.size >= this.maxTasks) {
      throw new RangeError(`The evidence acquisition queue reached its ${this.maxTasks}-task active boundary.`);
    }
  }

  private replaceTasks(next: Map<string, EvidenceAcquisitionTask>): void {
    this.tasks.clear();
    for (const [receiptId, task] of next) this.tasks.set(receiptId, task);
  }

  private cancelWakeTimer(): void {
    if (this.wakeTimer !== undefined) this.scheduler.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observation cannot change scheduler truth.
      }
    }
  }

  private assertUsable(requireRecovery = true): void {
    if (this.disposed) throw new Error("The evidence acquisition queue is disposed.");
    if (requireRecovery && !this.recovered) throw new Error("Recover the evidence acquisition queue before using it.");
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function evidenceAcquisitionBackoffMs(
  attempts: number,
  policy: EvidenceAcquisitionRetryPolicy = DEFAULT_EVIDENCE_ACQUISITION_RETRY_POLICY,
): number {
  const normalized = validateRetryPolicy(policy);
  const exponent = Math.max(0, Math.min(52, Math.trunc(attempts) - 1));
  return Math.min(normalized.maxDelayMs, normalized.baseDelayMs * (2 ** exponent));
}

export function isTerminalEvidenceAcquisition(
  task: EvidenceAcquisitionTask,
): task is SucceededEvidenceAcquisition | FailedEvidenceAcquisition | CancelledEvidenceAcquisition {
  return task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";
}

function isScheduledEvidenceAcquisition(
  task: EvidenceAcquisitionTask,
): task is PendingEvidenceAcquisition | RetryEvidenceAcquisition {
  return task.status === "pending" || task.status === "retry";
}

function baseFrom(task: EvidenceAcquisitionTask, updatedAt: number): EvidenceAcquisitionTaskBase {
  return {
    request: task.request,
    enqueuedAt: task.enqueuedAt,
    updatedAt,
    attempts: task.attempts,
  };
}

function validateRequest(value: ReceiptEvidenceAcquisitionRequest): ReceiptEvidenceAcquisitionRequest {
  if (!value || typeof value !== "object" || value.version !== 1 || value.providerId !== "chutes") {
    throw new TypeError("Evidence acquisition request must be a version 1 Chutes receipt target.");
  }
  const request = {
    version: 1 as const,
    receiptId: boundedIdentity(value.receiptId, "receipt ID"),
    sessionId: boundedIdentity(value.sessionId, "session ID"),
    profileId: boundedIdentity(value.profileId, "profile ID"),
    providerId: "chutes" as const,
    modelId: boundedIdentity(value.modelId, "model ID"),
    chuteId: boundedIdentity(value.chuteId, "chute ID"),
    instanceId: boundedIdentity(value.instanceId, "instance ID"),
    ...(value.endpointKeyDigest
      ? { endpointKeyDigest: boundedIdentity(value.endpointKeyDigest, "endpoint-key digest") }
      : {}),
  };
  return Object.freeze(request);
}

function validateQueueSnapshot(value: unknown, maxTasks: number): EvidenceAcquisitionQueueSnapshot {
  if (!isRecord(value) || value.version !== 1 || !finiteTimestamp(value.savedAt) || !Array.isArray(value.tasks)) {
    throw new TypeError("Evidence acquisition queue snapshot is invalid.");
  }
  if (value.tasks.length > maxTasks) throw new RangeError(`Evidence acquisition queue snapshot exceeds ${maxTasks} tasks.`);
  const seen = new Set<string>();
  const tasks = value.tasks.map((candidate) => validatePersistedTask(candidate));
  for (const task of tasks) {
    if (seen.has(task.request.receiptId)) throw new TypeError("Evidence acquisition queue snapshot contains duplicate receipt IDs.");
    seen.add(task.request.receiptId);
  }
  return Object.freeze({ version: 1, savedAt: value.savedAt, tasks: Object.freeze(tasks) });
}

function validatePersistedTask(value: unknown): EvidenceAcquisitionTask {
  if (!isRecord(value) || !isRecord(value.request)) throw new TypeError("Evidence acquisition task is invalid.");
  const request = validateRequest(value.request as unknown as ReceiptEvidenceAcquisitionRequest);
  const base = {
    request,
    enqueuedAt: requiredTimestamp(value.enqueuedAt, "enqueue time"),
    updatedAt: requiredTimestamp(value.updatedAt, "update time"),
    attempts: nonNegativeInteger(value.attempts, "attempt count"),
  };
  if (base.updatedAt < base.enqueuedAt) throw new TypeError("Evidence acquisition task update time predates its enqueue time.");
  if (value.status === "pending") {
    if (base.attempts !== 0) throw new TypeError("Pending evidence acquisition cannot contain a started attempt.");
    return freezeTask({ ...base, status: "pending", dueAt: requiredTimestamp(value.dueAt, "pending deadline") });
  }
  if (value.status === "running") {
    const attempt = positiveBoundedInteger(value.attempt, 1, Number.MAX_SAFE_INTEGER, "running attempt");
    if (attempt !== base.attempts) throw new TypeError("Evidence acquisition running attempt does not match its attempt count.");
    return freezeTask({ ...base, status: "running", attempt, startedAt: requiredTimestamp(value.startedAt, "start time") });
  }
  if (value.status === "retry") {
    if (base.attempts < 1) throw new TypeError("Evidence acquisition retry has no prior attempt.");
    return freezeTask({
      ...base,
      status: "retry",
      dueAt: requiredTimestamp(value.dueAt, "retry deadline"),
      failure: validateFailure(value.failure),
    });
  }
  if (value.status === "succeeded") {
    if (base.attempts < 1) throw new TypeError("Successful evidence acquisition has no completed attempt.");
    return freezeTask({ ...base, status: "succeeded", completedAt: requiredTimestamp(value.completedAt, "completion time") });
  }
  if (value.status === "failed") {
    if (base.attempts < 1) throw new TypeError("Failed evidence acquisition has no completed attempt.");
    return freezeTask({
      ...base,
      status: "failed",
      failedAt: requiredTimestamp(value.failedAt, "failure time"),
      failure: validateFailure(value.failure),
    });
  }
  if (value.status === "cancelled") {
    if (value.reason !== "operator" && value.reason !== "scope-released" && value.reason !== "superseded") {
      throw new TypeError("Evidence acquisition cancellation reason is invalid.");
    }
    return freezeTask({
      ...base,
      status: "cancelled",
      cancelledAt: requiredTimestamp(value.cancelledAt, "cancellation time"),
      reason: value.reason,
    });
  }
  throw new TypeError("Evidence acquisition task status is invalid.");
}

function validateFailure(value: unknown): EvidenceAcquisitionFailure {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string" || typeof value.retryable !== "boolean") {
    throw new TypeError("Evidence acquisition failure state is invalid.");
  }
  return Object.freeze({
    code: safeFailureCode(value.code),
    message: safeFailureMessage(value.message),
    retryable: value.retryable,
  });
}

function failureFrom(error: unknown): EvidenceAcquisitionFailure {
  if (error instanceof EvidenceAcquisitionAttemptError) {
    return Object.freeze({ code: error.code, message: error.publicMessage, retryable: error.retryable });
  }
  if (error instanceof DOMException && error.name === "AbortError") return interruptedFailure();
  return Object.freeze({
    code: "unexpected",
    message: "Evidence acquisition failed without a classified public reason.",
    retryable: false,
  });
}

function interruptedFailure(): EvidenceAcquisitionFailure {
  return Object.freeze({
    code: "interrupted",
    message: "The prior acquisition attempt ended without a committed terminal result.",
    retryable: true,
  });
}

function interruptedTask(
  task: RunningEvidenceAcquisition,
  now: number,
  policy: EvidenceAcquisitionRetryPolicy,
): RetryEvidenceAcquisition | FailedEvidenceAcquisition {
  const failure = interruptedFailure();
  return task.attempts >= policy.maxAttempts
    ? freezeTask({
        ...baseFrom(task, now),
        status: "failed",
        failedAt: now,
        failure,
      })
    : freezeTask({
        ...baseFrom(task, now),
        status: "retry",
        dueAt: now + evidenceAcquisitionBackoffMs(task.attempts, policy),
        failure,
      });
}

function safeFailureCode(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized) || normalized.length > MAX_FAILURE_CODE_LENGTH) return "invalid-failure-code";
  return normalized;
}

function safeFailureMessage(value: string): string {
  const normalized = value
    .replace(/\bBearer\s+\S+/giu, "Bearer [credential]")
    .replace(/\b(?:c[ap]k|csc|sk|xai|api)[_-][A-Za-z0-9._-]{8,}/giu, "[credential]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const safe = normalized || "Evidence acquisition failed without a public reason.";
  return safe.length > MAX_FAILURE_MESSAGE_LENGTH ? `${safe.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…` : safe;
}

function sameRequest(left: ReceiptEvidenceAcquisitionRequest, right: ReceiptEvidenceAcquisitionRequest): boolean {
  return left.version === right.version
    && left.receiptId === right.receiptId
    && left.sessionId === right.sessionId
    && left.profileId === right.profileId
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.chuteId === right.chuteId
    && left.instanceId === right.instanceId
    && left.endpointKeyDigest === right.endpointKeyDigest;
}

function freezeTask<T extends EvidenceAcquisitionTask>(task: T): T {
  const failure = "failure" in task ? { failure: Object.freeze({ ...task.failure }) } : {};
  return Object.freeze({ ...task, request: Object.freeze({ ...task.request }), ...failure }) as T;
}

function freezeSnapshot(savedAt: number, tasks: Iterable<EvidenceAcquisitionTask>): EvidenceAcquisitionQueueSnapshot {
  return Object.freeze({ version: 1, savedAt, tasks: Object.freeze(sortedTasks(tasks)) });
}

function emptySnapshot(savedAt: number): EvidenceAcquisitionQueueSnapshot {
  return Object.freeze({ version: 1, savedAt, tasks: Object.freeze([]) });
}

function sortedTasks(tasks: Iterable<EvidenceAcquisitionTask>): EvidenceAcquisitionTask[] {
  return [...tasks].sort((left, right) =>
    left.enqueuedAt - right.enqueuedAt
    || left.request.receiptId.localeCompare(right.request.receiptId));
}

function validateRetryPolicy(policy: EvidenceAcquisitionRetryPolicy): EvidenceAcquisitionRetryPolicy {
  const maxAttempts = positiveBoundedInteger(policy.maxAttempts, 1, 32, "maximum attempts");
  const baseDelayMs = positiveBoundedInteger(policy.baseDelayMs, 1, 86_400_000, "base retry delay");
  const maxDelayMs = positiveBoundedInteger(policy.maxDelayMs, baseDelayMs, 604_800_000, "maximum retry delay");
  return Object.freeze({ maxAttempts, baseDelayMs, maxDelayMs });
}

function positiveBoundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RangeError(`Evidence acquisition ${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`Evidence acquisition ${label} is invalid.`);
  return Number(value);
}

function requiredTimestamp(value: unknown, label: string): number {
  if (!finiteTimestamp(value)) throw new TypeError(`Evidence acquisition ${label} is invalid.`);
  return value;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedIdentity(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`Evidence acquisition ${label} is invalid.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`Evidence acquisition ${label} is invalid.`);
  }
  return normalized;
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateCancellationReason(value: unknown): EvidenceAcquisitionCancellationReason {
  if (value === "operator" || value === "scope-released" || value === "superseded") return value;
  throw new TypeError("Evidence acquisition cancellation reason is invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const SYSTEM_EVIDENCE_ACQUISITION_SCHEDULER: EvidenceAcquisitionScheduler = Object.freeze({
  now: () => Date.now(),
  setTimeout(callback: () => void, delayMs: number) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle: unknown) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});
