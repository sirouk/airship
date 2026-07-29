import {
  EvidenceAcquisitionIdentityConflictError,
  ReceiptEvidenceAcquisitionQueue,
  isTerminalEvidenceAcquisition,
  type EvidenceAcquisitionPersistenceCheckpoint,
  type EvidenceAcquisitionPersistencePort,
  type EvidenceAcquisitionQueueOptions,
  type EvidenceAcquisitionQueueSnapshot,
  type EvidenceAcquisitionTask,
} from "./evidence-acquisition-queue";
import { stableStringify } from "../core/hash";
import { WorkspaceConflictError, type WorkspacePort } from "../workspace/contracts";

const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const MAX_QUEUE_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const QUEUE_CHECKPOINT_ROOT = "/workspace/.airship/evidence-acquisition/profiles";
const DEFAULT_MAX_QUEUE_TASKS = 256;
const MAX_QUEUE_TASKS = 4_096;
const MAX_CAS_ATTEMPTS = 8;

type QueueCheckpointEnvelope = Readonly<{
  version: 1;
  kind: "airship-evidence-acquisition-queue";
  profileId: string;
  snapshot: EvidenceAcquisitionQueueSnapshot;
}>;

export type WorkspaceEvidenceAcquisitionScope = Readonly<{
  /** The object identity is the active storage authority fence. */
  workspace: WorkspacePort;
  /** Credential-free diagnostic identity; never used as a storage path. */
  workspaceId: string;
  profileId: string;
}>;

export type WorkspaceEvidenceAcquisitionBinding = WorkspaceEvidenceAcquisitionScope & Readonly<{
  queue: ReceiptEvidenceAcquisitionQueue;
}>;

export function evidenceAcquisitionQueueCheckpointPath(profileId: string): string {
  return `${QUEUE_CHECKPOINT_ROOT}/${validatedProfileId(profileId)}/queue.v1.json`;
}

/**
 * A profile-partitioned compare-and-swap checkpoint stored through the same
 * WorkspacePort that owns the active runtime. A MemoryWorkspace remains page
 * lifetime only. A ClientEncryptedWorkspacePort inherits that port's
 * encrypted durability; this adapter does not make a weaker port durable.
 *
 * This checkpoint contains scheduler state only. Endpoint evidence records,
 * quotes, certificates, and provider credentials never enter this file.
 */
export class WorkspaceEvidenceAcquisitionPersistence implements EvidenceAcquisitionPersistencePort {
  readonly path: string;
  private readonly profileId: string;
  private readonly maxTasks: number;
  /** Last complete checkpoint observed or committed by this page authority. */
  private knownSnapshot?: EvidenceAcquisitionQueueSnapshot;
  /** Last snapshot submitted by this controller (remote merged tasks excluded). */
  private localSnapshot?: EvidenceAcquisitionQueueSnapshot;
  private knownRevision?: string;

  constructor(
    private readonly workspace: WorkspacePort,
    profileId: string,
    maxTasks = DEFAULT_MAX_QUEUE_TASKS,
  ) {
    this.profileId = validatedProfileId(profileId);
    if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > MAX_QUEUE_TASKS) {
      throw new TypeError(`Evidence acquisition task capacity must be between 1 and ${MAX_QUEUE_TASKS}.`);
    }
    this.maxTasks = maxTasks;
    this.path = evidenceAcquisitionQueueCheckpointPath(this.profileId);
  }

  async load(signal?: AbortSignal): Promise<EvidenceAcquisitionPersistenceCheckpoint | undefined> {
    const checkpoint = await this.readCheckpoint(signal);
    this.knownSnapshot = checkpoint?.snapshot;
    this.localSnapshot = checkpoint?.snapshot;
    this.knownRevision = checkpoint?.revision;
    return checkpoint;
  }

  async save(
    snapshot: EvidenceAcquisitionQueueSnapshot,
    expectedRevision: string | undefined,
    signal?: AbortSignal,
  ): Promise<Readonly<{ revision: string }>> {
    signal?.throwIfAborted();
    assertSnapshotProfile(snapshot, this.profileId, this.maxTasks);
    const priorLocal = this.localSnapshot;
    const removedReceiptIds = removedLocalReceiptIds(priorLocal, snapshot);
    let candidate = evolveKnownSnapshot(
      this.knownSnapshot,
      priorLocal,
      snapshot,
      removedReceiptIds,
      this.maxTasks,
    );
    let revision = expectedRevision;

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      try {
        const written = await this.workspace.write(this.path, serializeEnvelope(candidate, this.profileId), {
          expectedRevision: revision ?? null,
        });
        // Once WorkspacePort returns, the CAS commit is authoritative. Treating
        // an immediately delivered abort as rollback would lose its revision.
        this.knownSnapshot = candidate;
        this.localSnapshot = snapshot;
        this.knownRevision = written.revision;
        return Object.freeze({ revision: written.revision });
      } catch (error) {
        if (!(error instanceof WorkspaceConflictError) || attempt === MAX_CAS_ATTEMPTS - 1) throw error;
        const latest = await this.readCheckpoint(signal);
        if (!latest) throw error;
        candidate = mergeConcurrentSnapshots(
          latest.snapshot,
          candidate,
          priorLocal,
          removedReceiptIds,
          this.maxTasks,
        );
        revision = latest.revision;
      }
    }
    throw new Error("Evidence acquisition persistence exhausted its compare-and-swap retry boundary.");
  }

  private async readCheckpoint(
    signal?: AbortSignal,
  ): Promise<EvidenceAcquisitionPersistenceCheckpoint | undefined> {
    signal?.throwIfAborted();
    const file = this.workspace.readBounded
      ? await this.workspace.readBounded(this.path, MAX_QUEUE_CHECKPOINT_BYTES + 1)
      : await this.workspace.read(this.path);
    signal?.throwIfAborted();
    if (!file) return undefined;
    if (file.size > MAX_QUEUE_CHECKPOINT_BYTES) {
      throw new Error("The evidence acquisition queue checkpoint exceeds its 4 MiB boundary.");
    }
    const envelope = parseEnvelope(file.content, this.profileId, this.maxTasks);
    return Object.freeze({ revision: file.revision, snapshot: envelope.snapshot });
  }
}

/**
 * Serializes profile/authority changes around one scheduler. Switching first
 * disposes the old controller, which aborts page work without rewriting its
 * persisted `running` checkpoint. Recovery on the destination then converts
 * an interrupted attempt into the queue's bounded at-least-once retry state.
 */
export class WorkspaceEvidenceAcquisitionAuthority {
  private bindingValue?: WorkspaceEvidenceAcquisitionBinding;
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: Omit<EvidenceAcquisitionQueueOptions, "persistence">,
  ) {}

  current(): WorkspaceEvidenceAcquisitionBinding | undefined {
    return this.bindingValue;
  }

  activate(scope: WorkspaceEvidenceAcquisitionScope): Promise<WorkspaceEvidenceAcquisitionBinding> {
    const normalized = normalizeScope(scope);
    return this.exclusive(async () => {
      const current = this.bindingValue;
      if (current && sameScope(current, normalized)) return current;
      await this.releaseCurrent();
      const queue = new ReceiptEvidenceAcquisitionQueue({
        ...this.options,
        persistence: new WorkspaceEvidenceAcquisitionPersistence(
          normalized.workspace,
          normalized.profileId,
          this.options.maxTasks ?? DEFAULT_MAX_QUEUE_TASKS,
        ),
      });
      try {
        await queue.recover();
      } catch (error) {
        queue.dispose();
        throw error;
      }
      const binding = Object.freeze({ ...normalized, queue });
      this.bindingValue = binding;
      return binding;
    });
  }

  release(): Promise<void> {
    return this.exclusive(() => this.releaseCurrent());
  }

  private async releaseCurrent(): Promise<void> {
    const current = this.bindingValue;
    this.bindingValue = undefined;
    if (!current) return;
    current.queue.dispose();
    await current.queue.settle();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
}

function normalizeScope(scope: WorkspaceEvidenceAcquisitionScope): WorkspaceEvidenceAcquisitionScope {
  if (!scope.workspace || typeof scope.workspace !== "object") {
    throw new TypeError("Evidence acquisition requires an active WorkspacePort authority.");
  }
  const workspaceId = scope.workspaceId.trim();
  if (!workspaceId || workspaceId.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(workspaceId)) {
    throw new TypeError("Evidence acquisition workspace identity is invalid.");
  }
  return Object.freeze({
    workspace: scope.workspace,
    workspaceId,
    profileId: validatedProfileId(scope.profileId),
  });
}

function sameScope(
  left: WorkspaceEvidenceAcquisitionScope,
  right: WorkspaceEvidenceAcquisitionScope,
): boolean {
  return left.workspace === right.workspace
    && left.workspaceId === right.workspaceId
    && left.profileId === right.profileId;
}

function validatedProfileId(value: string): string {
  const profileId = value.trim();
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new TypeError("Evidence acquisition profile identity must be a lowercase, path-free identifier.");
  }
  return profileId;
}

function parseEnvelope(content: string, profileId: string, maxTasks: number): QueueCheckpointEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The evidence acquisition queue checkpoint is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The evidence acquisition queue checkpoint is invalid.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== 1
    || candidate.kind !== "airship-evidence-acquisition-queue"
    || candidate.profileId !== profileId
    || !candidate.snapshot
    || typeof candidate.snapshot !== "object"
    || Array.isArray(candidate.snapshot)
  ) {
    throw new Error("The evidence acquisition queue checkpoint does not match the active Profile scope.");
  }
  const envelope = parsed as QueueCheckpointEnvelope;
  assertSnapshotProfile(envelope.snapshot, profileId, maxTasks);
  return envelope;
}

function assertSnapshotProfile(
  snapshot: EvidenceAcquisitionQueueSnapshot,
  profileId: string,
  maxTasks: number,
): void {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.tasks)) {
    throw new Error("The evidence acquisition queue snapshot is invalid.");
  }
  if (snapshot.tasks.length > maxTasks) {
    throw new RangeError(`The evidence acquisition queue snapshot exceeds its ${maxTasks}-task boundary.`);
  }
  const receiptIds = new Set<string>();
  for (const task of snapshot.tasks) {
    if (!task || typeof task !== "object" || task.request?.profileId !== profileId) {
      throw new Error("The evidence acquisition queue snapshot crosses its active Profile scope.");
    }
    if (!task.request.receiptId || receiptIds.has(task.request.receiptId)) {
      throw new Error("The evidence acquisition queue snapshot contains an invalid or duplicate receipt identity.");
    }
    receiptIds.add(task.request.receiptId);
  }
}

function serializeEnvelope(snapshot: EvidenceAcquisitionQueueSnapshot, profileId: string): string {
  const envelope: QueueCheckpointEnvelope = Object.freeze({
    version: 1,
    kind: "airship-evidence-acquisition-queue",
    profileId,
    snapshot,
  });
  const content = JSON.stringify(envelope);
  if (new TextEncoder().encode(content).byteLength > MAX_QUEUE_CHECKPOINT_BYTES) {
    throw new Error("The evidence acquisition queue checkpoint exceeds its 4 MiB boundary.");
  }
  return content;
}

function removedLocalReceiptIds(
  previous: EvidenceAcquisitionQueueSnapshot | undefined,
  next: EvidenceAcquisitionQueueSnapshot,
): ReadonlySet<string> {
  if (!previous) return new Set<string>();
  const retained = new Set(next.tasks.map((task) => task.request.receiptId));
  return new Set(previous.tasks
    .map((task) => task.request.receiptId)
    .filter((receiptId) => !retained.has(receiptId)));
}

function evolveKnownSnapshot(
  known: EvidenceAcquisitionQueueSnapshot | undefined,
  priorLocal: EvidenceAcquisitionQueueSnapshot | undefined,
  nextLocal: EvidenceAcquisitionQueueSnapshot,
  removedReceiptIds: ReadonlySet<string>,
  maxTasks: number,
): EvidenceAcquisitionQueueSnapshot {
  return mergeConcurrentSnapshots(
    known ?? Object.freeze({ version: 1, savedAt: nextLocal.savedAt, tasks: Object.freeze([]) }),
    nextLocal,
    priorLocal,
    removedReceiptIds,
    maxTasks,
  );
}

function mergeConcurrentSnapshots(
  durable: EvidenceAcquisitionQueueSnapshot,
  candidate: EvidenceAcquisitionQueueSnapshot,
  priorLocal: EvidenceAcquisitionQueueSnapshot | undefined,
  removedReceiptIds: ReadonlySet<string>,
  maxTasks: number,
): EvidenceAcquisitionQueueSnapshot {
  const prior = new Map(priorLocal?.tasks.map((task) => [task.request.receiptId, task]) ?? []);
  const merged = new Map(durable.tasks.map((task) => [task.request.receiptId, task]));
  for (const receiptId of removedReceiptIds) merged.delete(receiptId);
  for (const task of candidate.tasks) {
    const existing = merged.get(task.request.receiptId);
    merged.set(task.request.receiptId, existing
      ? mergeConcurrentTask(existing, task, prior.get(task.request.receiptId))
      : task);
  }
  return boundedMergedSnapshot(
    Math.max(durable.savedAt, candidate.savedAt),
    [...merged.values()],
    maxTasks,
  );
}

function mergeConcurrentTask(
  durable: EvidenceAcquisitionTask,
  candidate: EvidenceAcquisitionTask,
  priorLocal: EvidenceAcquisitionTask | undefined,
): EvidenceAcquisitionTask {
  const durableRequest = stableStringify(durable.request);
  const candidateRequest = stableStringify(candidate.request);
  if (durableRequest !== candidateRequest) {
    throw new EvidenceAcquisitionIdentityConflictError(candidate.request.receiptId);
  }
  if (sameTask(durable, candidate)) return durable;
  // If only one side evolved from the local controller's prior state, that
  // transition is authoritative. This preserves explicit failed/cancelled →
  // pending retries while still detecting a genuinely concurrent transition.
  if (priorLocal) {
    if (sameTask(durable, priorLocal)) return candidate;
    if (sameTask(candidate, priorLocal)) return durable;
  }
  if (durable.status === "succeeded" || candidate.status === "succeeded") {
    return durable.status === "succeeded" ? durable : candidate;
  }
  const durableTerminal = isTerminalEvidenceAcquisition(durable);
  const candidateTerminal = isTerminalEvidenceAcquisition(candidate);
  if (durableTerminal !== candidateTerminal) return durableTerminal ? durable : candidate;
  if (durable.attempts !== candidate.attempts) {
    return durable.attempts > candidate.attempts ? durable : candidate;
  }
  if (durable.updatedAt !== candidate.updatedAt) {
    return durable.updatedAt > candidate.updatedAt ? durable : candidate;
  }
  const durableRank = taskStateRank(durable);
  const candidateRank = taskStateRank(candidate);
  if (durableRank !== candidateRank) return durableRank > candidateRank ? durable : candidate;
  return stableStringify(durable).localeCompare(stableStringify(candidate)) >= 0 ? durable : candidate;
}

function taskStateRank(task: EvidenceAcquisitionTask): number {
  switch (task.status) {
    case "pending": return 0;
    case "running": return 1;
    case "retry": return 2;
    case "cancelled": return 3;
    case "failed": return 4;
    case "succeeded": return 5;
  }
}

function sameTask(left: EvidenceAcquisitionTask, right: EvidenceAcquisitionTask): boolean {
  return stableStringify(left) === stableStringify(right);
}

function boundedMergedSnapshot(
  savedAt: number,
  tasks: readonly EvidenceAcquisitionTask[],
  maxTasks: number,
): EvidenceAcquisitionQueueSnapshot {
  const sorted = [...tasks].sort((left, right) =>
    left.enqueuedAt - right.enqueuedAt
    || left.request.receiptId.localeCompare(right.request.receiptId));
  if (sorted.length > maxTasks) {
    const removable = sorted.filter(isTerminalEvidenceAcquisition);
    while (sorted.length > maxTasks && removable.length > 0) {
      const oldest = removable.shift()!;
      const index = sorted.findIndex((task) => task.request.receiptId === oldest.request.receiptId);
      if (index >= 0) sorted.splice(index, 1);
    }
  }
  if (sorted.length > maxTasks) {
    throw new RangeError(`The converged evidence acquisition queue exceeds its ${maxTasks}-task active boundary.`);
  }
  return Object.freeze({ version: 1, savedAt, tasks: Object.freeze(sorted) });
}
