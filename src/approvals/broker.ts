import type {
  ApprovalDecision,
  ApprovalPolicy,
  JsonValue,
  ToolContext,
  ToolDefinition,
} from "../core/contracts";

export type ApprovalRisk = "observe" | "change" | "communicate" | "execute" | "identity";

/**
 * What actually became of a request, as opposed to what the gate had to do
 * about it.
 *
 * The decision timer settled an abandoned request with `deny`, so a request
 * that ran out the clock while the person was away from the screen entered the
 * journal — the product's evidence chain — as one they had refused. A denial is
 * a decision on the record; an expiry is the absence of one, and the record is
 * not entitled to invent the difference.
 *
 * `ApprovalDecision` stays two-valued on purpose: it is the gate every caller
 * fails closed on, and an expiry must keep failing closed exactly as before.
 * The outcome is the wider fact, kept beside the decision rather than folded
 * into it, so no reader can count an expiry as a denial without saying so.
 */
export type ApprovalOutcome = ApprovalDecision | "expired";

export type PendingApproval = Readonly<{
  id: string;
  toolName: string;
  description: string;
  effect: ToolDefinition["effect"];
  risk: ApprovalRisk;
  sessionId: string;
  turnId: string;
  operationId: string;
  requestedAt: string;
  expiresAt: string;
  displayArguments: JsonValue;
}>;

export type ApprovalBrokerSnapshot = Readonly<{
  /** Requests still demanding an answer. The shell goes inert for exactly these. */
  pending: readonly PendingApproval[];
  /**
   * Requests the person put down without answering.
   *
   * Escape used to file a denial, so the two reflexes a chat surface trains —
   * Escape to dismiss, Enter on the focused control — destroyed a typed command
   * and its arguments with no way back. Escape now leaves the request exactly
   * where it was: still live, still counted against `maxPending`, still on the
   * same clock. It is only removed from `pending`, which is what makes the
   * shell behind it usable again — a person who needs to re-read the file
   * before authorising a write to it cannot do that inside a modal.
   */
  deferred: readonly PendingApproval[];
}>;

/**
 * One settled request, published to whatever has to *say* what happened.
 *
 * Separate from `takeOutcome`, which is a one-shot record for a single writer:
 * an announcement is not a record, and consuming the record to speak it would
 * leave the journal with nothing to file. Carries the request itself because
 * the request is gone from every snapshot by the time this fires, and an
 * outcome sentence that cannot name the tool or its target is the defect this
 * exists to fix.
 */
export type ApprovalSettlement = Readonly<{
  request: PendingApproval;
  outcome: ApprovalOutcome;
}>;

export type ApprovalBrokerOptions = Readonly<{
  maxPending?: number;
  decisionTimeoutMs?: number;
  now?: () => string;
}>;

type PendingEntry = {
  request: PendingApproval;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  abort: () => void;
};

const SECRET_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key|signature)/iu;
/** How much of one string the approval dock puts in front of a person before it elides. */
const MAX_DISPLAY_STRING_CHARS = 512;
const DEFAULT_DECISION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_PENDING = 16;
/** Bounded like every other page-memory ledger here; the oldest settled outcome is dropped first. */
const MAX_SETTLED_OUTCOMES = 256;

/**
 * The sentence each outcome is entitled to, in one place.
 *
 * The reason string is what the journal keeps and what Memory and the message
 * transcript read back, so two writers of it drift into two accounts of the
 * same event. The `deny` sentence names no author because this broker denies
 * for four different reasons — the person pressed Deny, the turn aborted, the
 * queue was full, the operation identity repeated — and only the first is a
 * person refusing. Expiry says plainly that nobody answered.
 */
export function approvalOutcomeReason(outcome: ApprovalOutcome): string {
  if (outcome === "allow") return "Allowed once by the user.";
  if (outcome === "expired") return "No decision was recorded; the request expired before the user answered it.";
  return "Denied without approval; the effect did not run.";
}

/** The identity a request is filed and settled under, shared so a lookup cannot rebuild it differently. */
export function approvalRequestId(context: Readonly<Pick<ToolContext, "sessionId" | "turnId" | "operationId">>): string {
  return `${context.sessionId}:${context.turnId}:${context.operationId}`;
}

/**
 * Page-memory approval coordinator. It receives arguments only long enough to
 * derive a bounded, recursively redacted display copy and never retains the
 * raw value after `request` returns.
 */
export class ApprovalBroker {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly outcomes = new Map<string, ApprovalOutcome>();
  private readonly postponed = new Set<string>();
  private readonly listeners = new Set<(snapshot: ApprovalBrokerSnapshot) => void>();
  private readonly settleListeners = new Set<(settlement: ApprovalSettlement) => void>();
  private readonly maxPending: number;
  private readonly decisionTimeoutMs: number;
  private readonly now: () => string;

  constructor(options: ApprovalBrokerOptions = {}) {
    this.maxPending = integerWithin(options.maxPending ?? DEFAULT_MAX_PENDING, 1, 128, "maxPending");
    this.decisionTimeoutMs = integerWithin(
      options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
      1,
      30 * 60_000,
      "decisionTimeoutMs",
    );
    this.now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(): ApprovalBrokerSnapshot {
    const pending: PendingApproval[] = [];
    const deferred: PendingApproval[] = [];
    for (const entry of this.entries.values()) {
      (this.postponed.has(entry.request.id) ? deferred : pending).push(entry.request);
    }
    return Object.freeze({ pending: Object.freeze(pending), deferred: Object.freeze(deferred) });
  }

  subscribe(listener: (snapshot: ApprovalBrokerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /** Fires once per settled request, for surfaces that must speak the outcome. */
  subscribeSettled(listener: (settlement: ApprovalSettlement) => void): () => void {
    this.settleListeners.add(listener);
    return () => this.settleListeners.delete(listener);
  }

  /**
   * Put a request down without answering it.
   *
   * Not a decision, and deliberately not reachable from `decide`: nothing is
   * resolved, the expiry clock is untouched, and the gate is exactly as closed
   * as it was. The only thing that changes is that the request stops being
   * modal, so the person can go and find out what they are being asked before
   * they answer it.
   */
  defer(id: string): boolean {
    if (!this.entries.has(id) || this.postponed.has(id)) return false;
    this.postponed.add(id);
    this.emit();
    return true;
  }

  resume(id: string): boolean {
    if (!this.postponed.delete(id)) return false;
    this.emit();
    return true;
  }

  /**
   * The outcome of one settled request, consumed once by whatever writes the
   * record for it.
   *
   * Separate from the resolved decision because the decision is a gate — an
   * expiry has to read `deny` there, or an unanswered request would run — while
   * the record has to state what happened. A caller that never asks is exactly
   * as safe as before; it just cannot tell the two apart, which is the defect.
   */
  takeOutcome(id: string): ApprovalOutcome | undefined {
    const outcome = this.outcomes.get(id);
    this.outcomes.delete(id);
    return outcome;
  }

  request(tool: ToolDefinition, argumentsValue: JsonValue, context: ToolContext): Promise<ApprovalDecision> {
    const id = approvalRequestId(context);
    if (context.signal.aborted || this.entries.size >= this.maxPending || this.entries.has(id)) {
      this.remember(id, "deny");
      return Promise.resolve("deny");
    }

    const requestedAt = this.now();
    const requestedAtMs = Date.parse(requestedAt);
    const expiresAt = new Date((Number.isFinite(requestedAtMs) ? requestedAtMs : Date.now()) + this.decisionTimeoutMs).toISOString();
    const request = Object.freeze({
      id,
      toolName: tool.name,
      description: tool.description,
      effect: tool.effect,
      risk: riskForEffect(tool.effect),
      sessionId: context.sessionId,
      turnId: context.turnId,
      operationId: context.operationId,
      requestedAt,
      expiresAt,
      displayArguments: redactForDisplay(argumentsValue),
    } satisfies PendingApproval);

    return new Promise<ApprovalDecision>((resolve) => {
      const abort = () => this.settle(id, "deny");
      // Not `deny`: the clock running out is the absence of a decision, and the
      // record that reads this must not report it as one the person made.
      const timer = setTimeout(() => this.settle(id, "expired"), this.decisionTimeoutMs);
      this.entries.set(id, { request, resolve, timer, signal: context.signal, abort });
      context.signal.addEventListener("abort", abort, { once: true });
      this.emit();
    });
  }

  /**
   * Only a person decides. `expired` is deliberately not reachable from here:
   * it is the clock's outcome, and a surface that could declare it would be
   * able to file a decision the person never made as if they had made none.
   */
  decide(id: string, decision: ApprovalDecision): boolean {
    if (decision !== "allow" && decision !== "deny") return false;
    return this.settle(id, decision);
  }

  denyAll(): void {
    for (const id of [...this.entries.keys()]) this.settle(id, "deny");
  }

  private settle(id: string, outcome: ApprovalOutcome): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this.postponed.delete(id);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.abort);
    this.remember(id, outcome);
    // An expiry still fails closed at the gate — only the record it leaves
    // behind distinguishes it from a refusal.
    entry.resolve(outcome === "expired" ? "deny" : outcome);
    this.emit();
    const settlement = Object.freeze({ request: entry.request, outcome });
    for (const listener of this.settleListeners) listener(settlement);
    return true;
  }

  private remember(id: string, outcome: ApprovalOutcome): void {
    if (this.outcomes.size >= MAX_SETTLED_OUTCOMES) {
      this.outcomes.delete(this.outcomes.keys().next().value as string);
    }
    this.outcomes.set(id, outcome);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function createBrokeredApprovalPolicy(
  broker: ApprovalBroker,
  options: Readonly<{ autoAllowEffects?: readonly ToolDefinition["effect"][] }> = {},
): ApprovalPolicy {
  const autoAllow = new Set(options.autoAllowEffects ?? ["read"]);
  return {
    review(tool, argumentsValue, context) {
      if (autoAllow.has(tool.effect)) return Promise.resolve("allow");
      return broker.request(tool, argumentsValue, context);
    },
  };
}

export function riskForEffect(effect: ToolDefinition["effect"]): ApprovalRisk {
  if (effect === "read") return "observe";
  if (effect === "write") return "change";
  if (effect === "network") return "communicate";
  return effect;
}

/**
 * The bounded copy of an argument value, for whoever has to read it.
 *
 * The string budget is a parameter because the two readers are not the same
 * reader. The dock renders for a person who can go and open the file the
 * argument names; the safety reviewer in Auto Approve is adjudicating the value
 * itself, and 512 characters of a 64 KB script is not the script. Everything
 * else — secret keys, depth, array and field caps — is identical for both,
 * because those bounds exist for reasons the audience does not change.
 */
export function redactForDisplay(value: JsonValue, maxStringChars = MAX_DISPLAY_STRING_CHARS): JsonValue {
  return redactValue(value, 0, "", maxStringChars);
}

function redactValue(value: JsonValue, depth: number, key: string, maxStringChars: number): JsonValue {
  if (key && SECRET_KEY.test(key)) return "[redacted]";
  if (depth >= 7) return "[depth limit]";
  // An elision states its own size. A bare ellipsis told neither the person at
  // the dock nor the safety reviewer how much of the value was withheld from
  // them, so both could read a preamble as if it were the whole argument.
  if (typeof value === "string") {
    return value.length <= maxStringChars
      ? value
      : `${value.slice(0, maxStringChars)}…[${maxStringChars} of ${value.length} characters shown]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const result = value.slice(0, 32).map((item) => redactValue(item, depth + 1, "", maxStringChars));
    if (value.length > 32) result.push(`[${value.length - 32} more items]`);
    return result;
  }
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  const entries = Object.entries(value).slice(0, 64);
  for (const [childKey, child] of entries) result[childKey] = redactValue(child, depth + 1, childKey, maxStringChars);
  if (Object.keys(value).length > entries.length) result["…"] = `[${Object.keys(value).length - entries.length} more fields]`;
  return result;
}

function integerWithin(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
