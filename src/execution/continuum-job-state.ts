export type ContinuumJobPhase =
  | "draft"
  | "planned"
  | "awaiting-approval"
  | "denied"
  | "cancelled"
  | "failed-local"
  | "approved"
  | "staging"
  | "dispatching"
  | "dispatch-unknown"
  | "accepted"
  | "running"
  | "cancelling"
  | "draining"
  | "disconnected"
  | "reconciling"
  | "result-received"
  | "verifying-result"
  | "quarantined"
  | "verified"
  | "completed-without-writeback"
  | "awaiting-adoption"
  | "adopting"
  | "completed"
  | "conflicted"
  | "lost";

export type ContinuumJobLifecycle = Readonly<{
  schema: "airship.continuum-job-lifecycle.v1";
  operationId: string;
  idempotencyKey: string;
  placement: "browser";
  phase: ContinuumJobPhase;
  sequence: number;
  accepted: boolean;
  terminalObserved: boolean;
  resultVerified: boolean;
  cancelRequested: boolean;
  reconciliationAttempts: number;
  maxReconciliationAttempts: number;
  reconcileDeadlineAt: string;
  updatedAt: string;
}>;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const MAX_SEQUENCE = 1_000_000;
const MAX_RECONCILIATION_ATTEMPTS = 32;
const DEFAULT_RECONCILIATION_ATTEMPTS = 8;
const DEFAULT_RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1_000;

const ALLOWED_TRANSITIONS: Readonly<Record<ContinuumJobPhase, readonly ContinuumJobPhase[]>> = Object.freeze({
  draft: ["planned", "failed-local"],
  planned: ["awaiting-approval", "failed-local"],
  "awaiting-approval": ["denied", "approved", "cancelled", "failed-local"],
  denied: [],
  cancelled: [],
  "failed-local": [],
  approved: ["staging", "cancelled", "failed-local"],
  staging: ["dispatching", "cancelled", "failed-local"],
  dispatching: ["dispatch-unknown", "accepted", "result-received"],
  "dispatch-unknown": ["reconciling", "result-received"],
  accepted: ["running", "cancelling", "disconnected", "result-received"],
  running: ["cancelling", "disconnected", "result-received"],
  cancelling: ["draining", "disconnected", "result-received"],
  draining: ["disconnected", "result-received"],
  disconnected: ["reconciling", "result-received"],
  reconciling: ["accepted", "running", "result-received", "lost"],
  "result-received": ["verifying-result"],
  "verifying-result": ["quarantined", "verified"],
  quarantined: [],
  verified: ["completed-without-writeback", "awaiting-adoption"],
  "completed-without-writeback": [],
  "awaiting-adoption": ["adopting"],
  adopting: ["completed", "conflicted"],
  completed: [],
  conflicted: [],
  lost: ["result-received"],
});

export function createContinuumJobLifecycle(args: Readonly<{
  operationId: string;
  idempotencyKey: string;
  placement: "browser";
  now?: string;
  maxReconciliationAttempts?: number;
  reconcileDeadlineAt?: string;
}>): ContinuumJobLifecycle {
  assertLifecycleCreateArgs(args);
  const snapshot = structuredClone(args);
  assertLifecycleCreateArgs(snapshot);
  assertSafeId(snapshot.operationId, "Continuum operation ID");
  assertSafeId(snapshot.idempotencyKey, "Continuum idempotency key");
  if (snapshot.placement !== "browser") {
    throw new Error("Continuum placement is invalid.");
  }
  const updatedAt = validTimestamp(snapshot.now ?? new Date().toISOString());
  const maxReconciliationAttempts = snapshot.maxReconciliationAttempts ?? DEFAULT_RECONCILIATION_ATTEMPTS;
  assertInteger(maxReconciliationAttempts, "Continuum reconciliation-attempt limit", 1, MAX_RECONCILIATION_ATTEMPTS);
  const reconcileDeadlineAt = validTimestamp(
    snapshot.reconcileDeadlineAt
      ?? new Date(Date.parse(updatedAt) + DEFAULT_RECONCILIATION_WINDOW_MS).toISOString(),
  );
  if (Date.parse(reconcileDeadlineAt) < Date.parse(updatedAt)) {
    throw new Error("Continuum reconciliation deadline precedes job creation.");
  }
  return Object.freeze({
    schema: "airship.continuum-job-lifecycle.v1",
    operationId: snapshot.operationId,
    idempotencyKey: snapshot.idempotencyKey,
    placement: snapshot.placement,
    phase: "draft",
    sequence: 0,
    accepted: false,
    terminalObserved: false,
    resultVerified: false,
    cancelRequested: false,
    reconciliationAttempts: 0,
    maxReconciliationAttempts,
    reconcileDeadlineAt,
    updatedAt,
  });
}

/**
 * Advances one structural lifecycle edge. This reducer is not an authority
 * boundary: a future private broker must map authenticated approval, dispatch,
 * verification, and CAS outcomes into these edges. Unknown dispatch must
 * reconcile rather than dispatch again; cancellation is sticky; and no output
 * can be adopted before result verification.
 */
export function transitionContinuumJob(
  current: ContinuumJobLifecycle,
  next: ContinuumJobPhase,
  now = new Date().toISOString(),
): ContinuumJobLifecycle {
  assertLifecycle(current);
  const snapshot = structuredClone(current);
  assertLifecycle(snapshot);
  current = snapshot;
  if (!ALLOWED_TRANSITIONS[current.phase].includes(next)) {
    throw new Error(`Illegal continuum job transition: ${current.phase} -> ${next}.`);
  }
  const updatedAt = validTimestamp(now);
  if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error("Continuum job transition time regressed.");
  }
  if (current.sequence >= MAX_SEQUENCE) throw new Error("Continuum job transition sequence is exhausted.");
  if (next === "reconciling") {
    if (Date.parse(updatedAt) > Date.parse(current.reconcileDeadlineAt)) {
      throw new Error("Continuum job reconciliation deadline has elapsed.");
    }
    if (current.reconciliationAttempts >= current.maxReconciliationAttempts) {
      throw new Error("Continuum job reconciliation-attempt limit is exhausted.");
    }
  }
  if (
    next === "lost"
    && current.reconciliationAttempts < current.maxReconciliationAttempts
    && Date.parse(updatedAt) <= Date.parse(current.reconcileDeadlineAt)
  ) {
    throw new Error("Continuum job cannot become lost before reconciliation is exhausted.");
  }

  const accepted = current.accepted || ["accepted", "running", "result-received"].includes(next);
  const terminalObserved = current.terminalObserved || next === "result-received";
  const resultVerified = current.resultVerified || next === "verified";
  const cancelRequested = current.cancelRequested || next === "cancelled" || next === "cancelling";

  if (["running", "cancelling", "draining"].includes(next) && !accepted) {
    throw new Error("A continuum job cannot run or cancel before acceptance.");
  }
  if (["verifying-result", "quarantined", "verified"].includes(next) && !terminalObserved) {
    throw new Error("A continuum job cannot verify a result before a terminal observation.");
  }
  if (["completed-without-writeback", "awaiting-adoption", "adopting", "completed", "conflicted"].includes(next) && !resultVerified) {
    throw new Error("A continuum job cannot complete or adopt output before result verification.");
  }
  if (cancelRequested && ["accepted", "running"].includes(next)) {
    throw new Error("A cancelled continuum job cannot resume ordinary execution.");
  }
  if (cancelRequested && ["awaiting-adoption", "adopting", "completed", "conflicted"].includes(next)) {
    throw new Error("A cancelled continuum job cannot adopt remote output.");
  }

  return Object.freeze({
    schema: current.schema,
    operationId: current.operationId,
    idempotencyKey: current.idempotencyKey,
    placement: current.placement,
    phase: next,
    sequence: current.sequence + 1,
    accepted,
    terminalObserved,
    resultVerified,
    cancelRequested,
    reconciliationAttempts: current.reconciliationAttempts + (next === "reconciling" ? 1 : 0),
    maxReconciliationAttempts: current.maxReconciliationAttempts,
    reconcileDeadlineAt: current.reconcileDeadlineAt,
    updatedAt,
  });
}

export function isContinuumJobSettled(phase: ContinuumJobPhase): boolean {
  return ["denied", "cancelled", "failed-local", "quarantined", "completed-without-writeback", "completed", "conflicted"].includes(phase);
}

function assertLifecycle(value: ContinuumJobLifecycle): void {
  assertExactLifecycleKeys(value);
  if (value.schema !== "airship.continuum-job-lifecycle.v1") throw new Error("Unsupported continuum lifecycle schema.");
  assertSafeId(value.operationId, "Continuum operation ID");
  assertSafeId(value.idempotencyKey, "Continuum idempotency key");
  if (!Object.hasOwn(ALLOWED_TRANSITIONS, value.phase)) throw new Error("Continuum lifecycle phase is invalid.");
  if (value.placement !== "browser") throw new Error("Continuum lifecycle placement is invalid.");
  assertInteger(value.sequence, "Continuum lifecycle sequence", 0, MAX_SEQUENCE);
  if (typeof value.accepted !== "boolean" || typeof value.terminalObserved !== "boolean"
    || typeof value.resultVerified !== "boolean" || typeof value.cancelRequested !== "boolean") {
    throw new Error("Continuum lifecycle flags are invalid.");
  }
  assertInteger(value.reconciliationAttempts, "Continuum reconciliation attempts", 0, MAX_RECONCILIATION_ATTEMPTS);
  assertInteger(value.maxReconciliationAttempts, "Continuum reconciliation-attempt limit", 1, MAX_RECONCILIATION_ATTEMPTS);
  if (value.reconciliationAttempts > value.maxReconciliationAttempts) {
    throw new Error("Continuum reconciliation attempts exceed their limit.");
  }
  if (value.resultVerified && !value.terminalObserved) throw new Error("Continuum lifecycle verification state is inconsistent.");
  if (value.terminalObserved && !value.accepted) throw new Error("Continuum lifecycle terminal state is inconsistent.");
  const requiresAcceptance: readonly ContinuumJobPhase[] = [
    "accepted", "running", "cancelling", "draining", "result-received",
    "verifying-result", "quarantined", "verified", "completed-without-writeback",
    "awaiting-adoption", "adopting", "completed", "conflicted",
  ];
  const requiresTerminal: readonly ContinuumJobPhase[] = [
    "result-received", "verifying-result", "quarantined", "verified",
    "completed-without-writeback", "awaiting-adoption", "adopting", "completed", "conflicted",
  ];
  const requiresVerification: readonly ContinuumJobPhase[] = [
    "verified", "completed-without-writeback", "awaiting-adoption", "adopting", "completed", "conflicted",
  ];
  const beforeAcceptance: readonly ContinuumJobPhase[] = [
    "draft", "planned", "awaiting-approval", "denied", "cancelled", "failed-local",
    "approved", "staging", "dispatching", "dispatch-unknown",
  ];
  if (requiresAcceptance.includes(value.phase) && !value.accepted) throw new Error("Continuum lifecycle acceptance state is inconsistent.");
  if (requiresTerminal.includes(value.phase) && !value.terminalObserved) throw new Error("Continuum lifecycle terminal phase is inconsistent.");
  if (requiresVerification.includes(value.phase) && !value.resultVerified) throw new Error("Continuum lifecycle verified phase is inconsistent.");
  if (beforeAcceptance.includes(value.phase) && value.accepted) throw new Error("Continuum lifecycle pre-acceptance state is inconsistent.");
  if (!requiresTerminal.includes(value.phase) && value.terminalObserved) throw new Error("Continuum lifecycle premature terminal state is inconsistent.");
  if (!requiresVerification.includes(value.phase) && value.resultVerified) throw new Error("Continuum lifecycle premature verification state is inconsistent.");
  if (value.phase === "cancelled" && !value.cancelRequested) throw new Error("Continuum lifecycle cancellation state is inconsistent.");
  if (["cancelling", "draining"].includes(value.phase) && !value.cancelRequested) throw new Error("Continuum lifecycle cancellation state is inconsistent.");
  if (value.cancelRequested && ["awaiting-adoption", "adopting", "completed", "conflicted"].includes(value.phase)) {
    throw new Error("Cancelled continuum output cannot be in an adoption phase.");
  }
  const updatedAt = validTimestamp(value.updatedAt);
  const deadline = validTimestamp(value.reconcileDeadlineAt);
  if (Date.parse(deadline) < Date.parse(updatedAt) && value.phase === "reconciling") {
    throw new Error("Continuum lifecycle reconciliation deadline has elapsed.");
  }
}

function assertSafeId(value: string, label: string): void {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
}

function validTimestamp(value: string): string {
  if (typeof value !== "string" || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error("Continuum lifecycle timestamp is invalid.");
  }
  return value;
}

function assertInteger(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid.`);
}

function assertExactLifecycleKeys(value: ContinuumJobLifecycle): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Continuum lifecycle must be a record.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Continuum lifecycle must be a plain record.");
  const expected = new Set([
    "schema", "operationId", "idempotencyKey", "placement", "phase", "sequence",
    "accepted", "terminalObserved", "resultVerified", "cancelRequested",
    "reconciliationAttempts", "maxReconciliationAttempts", "reconcileDeadlineAt", "updatedAt",
  ]);
  const keys = Object.keys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => descriptors[key]?.get || descriptors[key]?.set)) {
    throw new Error("Continuum lifecycle cannot contain accessors.");
  }
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error("Continuum lifecycle contains unknown or missing fields.");
  }
}

function assertLifecycleCreateArgs(value: Readonly<{
  operationId: string;
  idempotencyKey: string;
  placement: "browser";
  now?: string;
  maxReconciliationAttempts?: number;
  reconcileDeadlineAt?: string;
}>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Continuum lifecycle constructor arguments must be a record.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Continuum lifecycle constructor arguments must be a plain record.");
  }
  const keys = Object.keys(value);
  const required = ["operationId", "idempotencyKey", "placement"];
  const allowed = new Set([...required, "now", "maxReconciliationAttempts", "reconcileDeadlineAt"]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => descriptors[key]?.get || descriptors[key]?.set)) {
    throw new Error("Continuum lifecycle constructor arguments cannot contain accessors.");
  }
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Continuum lifecycle constructor arguments contain unknown or missing fields.");
  }
  if (keys.some((key) => (value as Record<string, unknown>)[key] === undefined)) {
    throw new Error("Continuum lifecycle constructor arguments contain an explicit undefined value.");
  }
}
