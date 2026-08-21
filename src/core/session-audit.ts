import { deepFreeze } from "./freeze";
import { CONVERSATION_NAMED_EVENT_TYPE, HUMAN_INTENT_EVENT_TYPE, TERMINAL_ACTIVITY_EVENT_TYPE } from "./contracts";
import type {
  CanonicalMessage,
  JsonValue,
  SecurityPosture,
  SessionManifest,
  ToolCall,
  ToolDefinition,
} from "./contracts";
import { sha256, stableStringify } from "./hash";
import {
  assertValidSessionInferenceBinding,
  sessionInferenceProviderIdMatches,
} from "./inference-binding";
import type { DurableEvent, SessionRecord } from "./journal";
import { boundInferenceHistoryImages, canonicalImageInputs } from "./multimodal-contract";
import {
  canonicalContextSelection,
  contextSelectionScopeMatches,
  injectContextSelection,
  verifyContextSelection,
  verifyContextSelectionQuery,
} from "./context-selection";
import {
  canonicalLiveEnvironmentSnapshot,
  injectLiveEnvironment,
  liveEnvironmentScopeMatches,
  verifyLiveEnvironmentSnapshot,
  type LiveEnvironmentSnapshot,
} from "./live-environment";
import {
  FORK_CONTEXT_EVENT_TYPE,
  canonicalForkContextSeed,
  forkContextSeedMatchesScope,
  verifyForkContextSeed,
} from "./fork-context";
import {
  canonicalContextSummary,
  canonicalSessionContextPolicy,
  summaryBodiesWithinPolicy,
  verifyContextSummary,
  type ContextSummaryProvenance,
} from "./context-compressor";
import { TASK_PLAN_NOTE_EVENT_TYPE, canonicalTaskPlanNote, materializeMessages } from "./agent";

const EVENT_FIELDS = new Set([
  "version",
  "eventId",
  "sessionId",
  "sequence",
  "recordedAt",
  "previousDigest",
  "digest",
  "type",
  "turnId",
  "operationId",
  "payload",
]);
export const KNOWN_EVENT_TYPES = new Set([
  "session.created",
  "session.renamed",
  "session.favorite.changed",
  "session.approval-policy-changed",
  "session.model-changed",
  "profile.favorite-order.moved",
  "profile.active-conversation.selected",
  FORK_CONTEXT_EVENT_TYPE,
  "context.summary.updated",
  "turn.requested",
  "turn.context.selected",
  /*
   * The provider-exposed reasoning for one inference step. runTurn journals it
   * once per request the moment the request completes, beside the answer it
   * preceded; it carries text the provider chose to stream to the person, so
   * the completeness rule is the presence of the record, not its content.
   */
  "turn.reasoning",
  TASK_PLAN_NOTE_EVENT_TYPE,
  "inference.started",
  "inference.usage",
  "assistant.completed",
  "tool.requested",
  "tool.approved",
  "tool.denied",
  "tool.resulted",
  "tool.failed",
  "turn.completed",
  "turn.cancelled",
  "turn.failed",
  "local.command.requested",
  "local.command.approved",
  "local.command.completed",
  "local.command.denied",
  "local.command.failed",
  /*
   * A decision on an effect the person proposed from the interface — a stage or
   * commit, a repository import, a vault probe. It is not a turn event and
   * never becomes one: it carries no message, no receipt and no result, only
   * who allowed what. Without it the entire UI-initiated approval path was
   * adjudicated and then forgotten, so the journal claimed a completeness it
   * did not have.
   */
  HUMAN_INTENT_EVENT_TYPE,
  /*
   * The inference that named the conversation. It is not a turn step — it runs
   * beside one — but it is a billed provider request made on this session's
   * behalf, so its receipt and its cost belong to this session's record rather
   * than to the throwaway identity it used to be issued under.
   */
  CONVERSATION_NAMED_EVENT_TYPE,
  /*
   * One thing a shell session did. Terminal lineage used to live only in the
   * manager's 64-record ring buffer, so a command that rewrote the workspace
   * was absent from the local history being checked — and an event type this set does
   * not name raises EVENT_TYPE_UNKNOWN, which would have made recording shell
   * work *degrade* the completeness of the journal it was recorded in.
   */
  TERMINAL_ACTIVITY_EVENT_TYPE,
  /*
   * The Prime engine's own record vocabulary. An event type this set does not
   * name raises EVENT_TYPE_UNKNOWN, which makes the report `incomplete`.
   * Prime became the default engine while this set still listed only the
   * Airship turn protocol, so the first runtime-selection marker made each new
   * conversation unopenable after its first turn.
   *
   * Listed literally rather than imported: `src/prime` imports core, and core
   * importing Prime back would close a cycle. The direct vocabulary test holds
   * the two lists in agreement.
   *
   * Named, not interpreted. These records sit beside the canonical transcript
   * and carry no turn-protocol obligations. The former runtime marker remains
   * here only for historical journal reads; current writes use the new marker.
   */
  "prime.session.runtime.selected",
  "prime.session.runtime.seal",
  "prime.harness.refined",
  "prime.kernel.job.started",
  "prime.kernel.job.completed",
  "prime.kernel.job.failed",
  "prime.kernel.job.cancelled",
  "prime.kernel.job.crashed",
  "prime.kernel.tool.requested",
  "prime.kernel.tool.approved",
  "prime.kernel.tool.denied",
  "prime.kernel.tool.resulted",
  "prime.kernel.tool.failed",
  "prime.agent_message.sent",
  "prime.goal.updated",
  "prime.compacted",
  "prime.notice",
]);
const TERMINAL_RECORD_KINDS = new Set(["interactive-input", "process-start", "process-exit", "workspace-reconcile", "browser-git"]);
const TERMINAL_RECORD_OUTCOMES = new Set(["submitted", "completed", "failed"]);
const TERMINAL_SESSION_ORIGINS = new Set(["terminal-route", "workspace-path", "conversation"]);
/** The manager's own `MAX_AUDIT_CHANGED_PATHS`; a journal copy may not exceed the record it copies. */
const TERMINAL_MAX_CHANGED_PATHS = 64;
const TERMINAL_MAX_COMMAND_CHARS = 1_024;
const TERMINAL_MAX_SUMMARY_CHARS = 512;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const EFFECTS = new Set(["read", "write", "network", "execute", "identity"]);
const CAPABILITY_TIERS = new Set(["web-baseline", "web-enhanced", "native", "remote-heavy"]);
const POSTURES = new Set(["local", "plaintext-remote"]);
/** The closed authority vocabulary of `ApprovalProvenance`; see approvalProvenanceIssue. */
const APPROVAL_SOURCES = new Set(["automatic-read", "human", "model-review", "human-fallback", "bounded-browser-sandbox"]);
const APPROVAL_MODES = new Set(["ask-first", "auto-approve", "full-access"]);
const FINISH_REASONS = new Set(["stop", "tool-calls", "length"]);
const encoder = new TextEncoder();

export type SessionAuditSeverity = "error" | "warning" | "info";
export type SessionAuditCategory =
  | "schema"
  | "chain"
  | "manifest"
  | "protocol"
  | "trace"
  | "completeness"
  | "anchor";

export type SessionAuditFinding = Readonly<{
  code: string;
  severity: SessionAuditSeverity;
  category: SessionAuditCategory;
  message: string;
  sequence?: number;
  eventId?: string;
  turnId?: string;
  operationId?: string;
}>;

export type TrustedJournalHead = Readonly<{
  sequence: number;
  digest: string;
  /** Human-readable origin such as a signed export or external checkpoint. */
  source: string;
}>;

export type SessionAuditLimits = Readonly<{
  maxEvents: number;
  maxEventBytes: number;
  maxTotalBytes: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
}>;

export type SessionAuditInput = Readonly<{
  session: SessionRecord;
  events: readonly DurableEvent[];
}>;

export type SessionAuditReport = Readonly<{
  version: 1;
  checkedAt: string;
  sessionId: string;
  status: "verified" | "incomplete" | "invalid";
  /** A hash chain proves consistency, not authorship. This remains explicit by design. */
  authenticity: "not-proven";
  anchor: Readonly<{
    status: "not-supplied" | "matched" | "mismatched";
    source?: string;
  }>;
  commitment: Readonly<{ sequence: number; digest: string }>;
  checks: Readonly<{
    schema: boolean;
    chain: boolean;
    manifest: boolean;
    protocol: boolean;
    traceBindings: boolean;
    complete: boolean;
  }>;
  counts: Readonly<{
    events: number;
    turns: number;
    completedTurns: number;
    failedTurns: number;
    cancelledTurns: number;
    toolOperations: number;
    terminalToolOperations: number;
    /** Client-only slash-tool operations; never part of canonical provider context. */
    localCommands: number;
    terminalLocalCommands: number;
    /*
     * Shell records — deliberately not `terminalRecords`.
     *
     * Every other `terminal` in this file means "reached a terminal state" of a
     * turn, which is why shell lineage was reported as absent from a file that
     * appeared to mention terminals a dozen times. A second meaning for the
     * same word on the same object is how that reading happened; this one says
     * what it counts.
     */
    shellRecords: number;
    /*
     * Effects a person authorised directly, outside the turn protocol.
     *
     * Every other field here counts something a turn did. Staging and
     * committing from Source Control, or probing a vault, are journaled as
     * `human.intent.reviewed`, validated by this audit — and were counted by
     * nothing: an export taken immediately after two approved, write-effect
     * Git operations that changed the repository read `"toolOperations": 0`
     * beside `"complete": true`. Two numbers, because "1 decision" and
     * "1 effect permitted" are different facts and a denial is evidence too.
     */
    humanIntentDecisions: number;
    humanIntentAllowed: number;
    unknownEvents: number;
  }>;
  findings: readonly SessionAuditFinding[];
}>;

export type SessionAuditOptions = Readonly<{
  checkedAt?: string;
  trustedHead?: TrustedJournalHead;
  limits?: Partial<SessionAuditLimits>;
}>;

/** Keep issue metadata positional so the emitted object keys exist once, not once per audit rule. */
type FindingContext = Omit<SessionAuditFinding, "code" | "severity" | "category" | "message">;
type AddFinding = (
  code: string,
  category: SessionAuditCategory,
  message: string,
  context?: FindingContext,
  severity?: SessionAuditSeverity,
) => void;

function addEventFinding(
  add: AddFinding,
  event: DurableEvent,
  code: string,
  message: string,
  category: SessionAuditCategory = "protocol",
  severity?: SessionAuditSeverity,
): void {
  add(code, category, message, eventLocation(event), severity);
}

const DEFAULT_LIMITS: SessionAuditLimits = Object.freeze({
  maxEvents: 100_000,
  maxEventBytes: 2 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonNodes: 250_000,
});

type ToolState = {
  call: ToolCall;
  requested: boolean;
  decision?: "approved" | "denied";
  terminal?: "resulted" | "failed" | "denied";
};

type TurnState = {
  id: string;
  /** Route policy admitted when turn.requested joined the durable chain. */
  model: string;
  contextPolicy: SessionManifest["contextPolicy"];
  step: number;
  request?: {
    content: string;
    messageIndex: number;
    liveEnvironment?: LiveEnvironmentSnapshot;
  };
  contextSelected?: boolean;
  compacted?: boolean;
  planRestated?: boolean;
  inference?: {
    operationId: string;
    requestDigest: string;
    posture?: string;
  };
  tools: ToolState[];
  terminal?: "completed" | "failed" | "cancelled";
  finalAssistant?: {
    responseDigest: string;
    receiptId?: string;
    requestDigest: string;
  };
};

type LocalCommandState = {
  turnId: string;
  operationId: string;
  toolName: string;
  approved: boolean;
};

type LastContextMessage = Readonly<{ index: number; content: string }>;

/**
 * Verifies an exported or replayed TypeScript journal without trusting its
 * backend. The report deliberately distinguishes local consistency from
 * authenticity; only a separately trusted head can anchor the chain.
 */
export function auditSessionHistory(
  input: SessionAuditInput,
  options: SessionAuditOptions = {},
): Promise<SessionAuditReport> {
  /*
   * One synchronous ownership boundary for the whole audit call.
   *
   * The chain walk yields for every SHA-256 operation. Retaining even one
   * caller-owned event, manifest field, or trusted-head option across that
   * yield lets the digest preimage and the later protocol/report reads observe
   * different values. Snapshot the complete graph in one traversal before the
   * async implementation starts, preserving aliases while refusing accessors
   * without executing them.
   */
  let snapshot: Readonly<{ input: SessionAuditInput; options: SessionAuditOptions }>;
  try {
    snapshot = descriptorSafeDeepSnapshot({ input, options });
  } catch {
    return Promise.resolve(invalidAuditSnapshotReport());
  }
  return auditSessionHistorySnapshot(snapshot.input, snapshot.options);
}

async function auditSessionHistorySnapshot(
  input: SessionAuditInput,
  options: SessionAuditOptions,
): Promise<SessionAuditReport> {
  if (!asPlainRecord(options)) return invalidAuditSnapshotReport();
  const limits = resolveLimits(options.limits);
  const findings: SessionAuditFinding[] = [];
  const add: AddFinding = (code, category, message, context, severity = "error") =>
    findings.push(Object.freeze({ severity, ...context, code, category, message }));

  const rawInput = asPlainRecord(input);
  const rawSession = asPlainRecord(rawInput?.session);
  const rawEvents = Array.isArray(rawInput?.events) ? rawInput.events : undefined;
  const sessionId = boundedString(rawSession?.id, 512) ?? "unknown";

  if (!rawInput || !rawSession || !rawEvents) {
    add("INPUT_INVALID", "schema", "Audit input must contain a plain session record and an event array.");
    return finishReport({
      checkedAt: options.checkedAt,
      sessionId,
      session: undefined,
      events: [],
      findings,
      counts: emptyCounts(),
      anchor: options.trustedHead,
    });
  }

  if (rawEvents.length > limits.maxEvents) {
    add("EVENT_LIMIT_EXCEEDED", "schema", `Journal contains ${rawEvents.length} events; the audit limit is ${limits.maxEvents}.`);
  }

  const session = validateSessionRecord(rawSession, add);
  const events: DurableEvent[] = [];
  let expectedSequence = 1;
  let expectedPreviousDigest = "genesis";
  let previousTime = Number.NEGATIVE_INFINITY;
  let totalBytes = 0;
  const eventIds = new Set<string>();

  for (const rawEvent of rawEvents.slice(0, limits.maxEvents)) {
    const eventRecord = asPlainRecord(rawEvent);
    if (!eventRecord) {
      add("EVENT_INVALID", "schema", "Journal event must be a plain object.");
      continue;
    }
    const location = eventLocation(eventRecord);
    const unknownFields = Object.keys(eventRecord).filter((field) => !EVENT_FIELDS.has(field));
    if (unknownFields.length > 0) {
      add("EVENT_UNKNOWN_FIELDS", "schema", `Event contains fields outside protocol v1: ${unknownFields.sort().join(", ")}.`, location);
    }
    if (!isDurableEventShape(eventRecord)) {
      add("EVENT_SHAPE_INVALID", "schema", "Event is missing a required protocol-v1 field or contains an invalid field type.", location);
      continue;
    }
    const jsonInspection = inspectJson(eventRecord.payload, limits);
    if (!jsonInspection.valid) {
      add("EVENT_PAYLOAD_INVALID", "schema", jsonInspection.message, location);
      continue;
    }

    const event = eventRecord as unknown as DurableEvent;
    const digestInput: JsonValue = {
      version: 1,
      eventId: event.eventId,
      sessionId: event.sessionId,
      sequence: event.sequence,
      recordedAt: event.recordedAt,
      previousDigest: event.previousDigest,
      type: event.type,
      turnId: event.turnId ?? null,
      operationId: event.operationId ?? null,
      payload: event.payload,
    };
    const canonical = stableStringify(digestInput);
    const eventBytes = encoder.encode(canonical).byteLength;
    totalBytes += eventBytes;
    if (eventBytes > limits.maxEventBytes) {
      addEventFinding(add, event, "EVENT_SIZE_EXCEEDED", `Canonical event size ${eventBytes} exceeds the ${limits.maxEventBytes}-byte audit limit.`, "schema");
    }
    if (totalBytes > limits.maxTotalBytes) {
      addEventFinding(add, event, "JOURNAL_SIZE_EXCEEDED", `Canonical journal size exceeds the ${limits.maxTotalBytes}-byte audit limit.`, "schema");
      break;
    }

    if (event.version !== 1) {
      addEventFinding(add, event, "EVENT_VERSION_INVALID", "Event version must be 1.", "schema");
    }
    if (event.sessionId !== sessionId) {
      addEventFinding(add, event, "CROSS_SESSION_EVENT", "Event belongs to a different session.", "chain");
    }
    if (event.sequence !== expectedSequence) {
      addEventFinding(add, event, "SEQUENCE_GAP", `Expected sequence ${expectedSequence}; found ${event.sequence}.`, "chain");
    }
    if (event.previousDigest !== expectedPreviousDigest) {
      addEventFinding(add, event, "PREVIOUS_DIGEST_MISMATCH", "Event does not extend the preceding digest.", "chain");
    }
    if (!DIGEST_PATTERN.test(event.digest) || (await sha256(canonical)) !== event.digest) {
      addEventFinding(add, event, "EVENT_DIGEST_MISMATCH", "Event digest is invalid.", "chain");
    }
    if (eventIds.has(event.eventId)) {
      addEventFinding(add, event, "EVENT_ID_REUSED", "Event ID is reused in this session.", "chain");
    }
    eventIds.add(event.eventId);
    const recordedTime = Date.parse(event.recordedAt);
    if (!Number.isFinite(recordedTime)) {
      addEventFinding(add, event, "EVENT_TIME_INVALID", "Event timestamp is not a valid ISO timestamp.", "schema");
    } else if (recordedTime < previousTime) {
      addEventFinding(add, event, "EVENT_TIME_REVERSED", "Event timestamp precedes the prior event.", "chain");
    }
    previousTime = recordedTime;
    expectedSequence = event.sequence + 1;
    expectedPreviousDigest = event.digest;
    events.push(event);
  }

  if (session) {
    await validateManifest(session.manifest, add);
    validateHead(session, events, add);
  }
  const counts = session
    ? await validateProtocol(session, events, add)
    : { ...emptyCounts(), events: events.length };

  return finishReport({
    checkedAt: options.checkedAt,
    sessionId,
    session,
    events,
    findings,
    counts,
    anchor: options.trustedHead,
  });
}

/** Fail closed without consulting any part of a graph that could not be owned safely. */
function invalidAuditSnapshotReport(): SessionAuditReport {
  return finishReport({
    sessionId: "unknown",
    session: undefined,
    events: [],
    findings: [Object.freeze({
      code: "INPUT_INVALID",
      severity: "error",
      category: "schema",
      message: "Audit input must contain a plain session record and an event array.",
    })],
    counts: emptyCounts(),
  });
}

const INVALID_AUDIT_SNAPSHOT_PROTOTYPE = Object.freeze(Object.create(null) as object);

/**
 * Clone one caller-owned graph through own property descriptors only.
 *
 * `structuredClone` executes getters. That is acceptable for several trusted
 * construction APIs, but not for this verifier: exported journal data is
 * untrusted and the audit's existing plain-record contract explicitly rejects
 * accessors. This iterative clone never reads a property through `[[Get]]`.
 * It preserves data descriptors, aliases, cycles, sparse arrays, and null
 * prototypes. Exotic prototypes are replaced by one internal prototype so the
 * existing plain-record checks still reject them without retaining a caller
 * object through the clone's prototype chain.
 */
function descriptorSafeDeepSnapshot<T>(value: T): T {
  type PendingClone = Readonly<{ source: object; target: object; array: boolean }>;
  const clones = new WeakMap<object, object>();
  const pending: PendingClone[] = [];

  const allocate = (candidate: unknown): unknown => {
    if (typeof candidate === "function") {
      throw new TypeError("Audit snapshots cannot contain functions.");
    }
    if (candidate === null || typeof candidate !== "object") return candidate;
    const existing = clones.get(candidate);
    if (existing) return existing;

    let array: boolean;
    let prototype: object | null;
    try {
      array = Array.isArray(candidate);
      prototype = Object.getPrototypeOf(candidate);
    } catch {
      throw new TypeError("Audit input could not be inspected safely.");
    }
    const target = array
      ? []
      : prototype === Object.prototype
        ? {}
        : prototype === null
          ? Object.create(null) as object
          : Object.create(INVALID_AUDIT_SNAPSHOT_PROTOTYPE) as object;
    clones.set(candidate, target);
    pending.push({ source: candidate, target, array });
    return target;
  };

  const snapshot = allocate(value);
  while (pending.length > 0) {
    const { source, target, array } = pending.pop()!;
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(source);
    } catch {
      throw new TypeError("Audit input could not be inspected safely.");
    }
    const descriptorRecord = descriptors as unknown as Record<PropertyKey, PropertyDescriptor>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === "length") continue;
      const descriptor = descriptorRecord[key];
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Audit snapshots require accessor-free own data properties.");
      }
      Object.defineProperty(target, key, {
        ...descriptor,
        value: allocate(descriptor.value),
      });
    }
    if (array) {
      const lengthDescriptor = descriptorRecord.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)) {
        throw new TypeError("Audit arrays require a data length property.");
      }
      Object.defineProperty(target, "length", lengthDescriptor);
    }
  }
  return snapshot as T;
}

function resolveLimits(overrides: Partial<SessionAuditLimits> | undefined): SessionAuditLimits {
  const resolved = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return Object.freeze(resolved);
}

function validateSessionRecord(
  raw: Record<string, unknown>,
  add: AddFinding,
): SessionRecord | undefined {
  const requiredStrings = ["id", "title", "createdAt", "updatedAt", "headDigest"] as const;
  if (requiredStrings.some((field) => !boundedString(raw[field], field === "title" ? 4_096 : 512))) {
    add("SESSION_SHAPE_INVALID", "schema", "Session record has an invalid required string field.");
    return undefined;
  }
  if (!Number.isSafeInteger(raw.headSequence) || (raw.headSequence as number) < 0 || !asPlainRecord(raw.manifest)) {
    add("SESSION_SHAPE_INVALID", "schema", "Session head or manifest has an invalid shape.");
    return undefined;
  }
  if (!Number.isFinite(Date.parse(raw.createdAt as string)) || !Number.isFinite(Date.parse(raw.updatedAt as string))) {
    add("SESSION_TIME_INVALID", "schema", "Session timestamps are invalid.");
  }
  if (raw.headSequence === 0 ? raw.headDigest !== "genesis" : !DIGEST_PATTERN.test(raw.headDigest as string)) {
    add("SESSION_HEAD_INVALID", "chain", "Session head digest is invalid for its sequence.");
  }
  return raw as unknown as SessionRecord;
}

async function validateManifest(
  manifest: SessionManifest,
  add: AddFinding,
): Promise<void> {
  const raw = asPlainRecord(manifest);
  const manifestInspection = inspectJson(manifest, DEFAULT_LIMITS);
  if (!manifestInspection.valid) {
    add("MANIFEST_DATA_INVALID", "manifest", manifestInspection.message);
    return;
  }
  if (
    !raw ||
    (raw.protocolVersion !== 1 && raw.protocolVersion !== 2) ||
    !boundedString(raw.systemPrompt, 512 * 1024) ||
    !boundedString(raw.systemPromptDigest, 128) ||
    !boundedString(raw.providerId, 256) ||
    !boundedString(raw.model, 512) ||
    !boundedString(raw.toolManifestDigest, 128) ||
    !boundedString(raw.workspaceId, 2_048) ||
    !boundedString(raw.createdAt, 128) ||
    !Array.isArray(raw.tools)
  ) {
    add("MANIFEST_SHAPE_INVALID", "manifest", "Session manifest does not satisfy a supported protocol shape.");
    return;
  }
  if ((await sha256(raw.systemPrompt as string)) !== raw.systemPromptDigest) {
    add("SYSTEM_PROMPT_DIGEST_MISMATCH", "manifest", "System prompt does not match its pinned digest.");
  }
  if (!CAPABILITY_TIERS.has(String(raw.capabilityTier))) {
    add("CAPABILITY_TIER_INVALID", "manifest", "Manifest capability tier is invalid.");
  }
  if (raw.securityPosture !== undefined && !POSTURES.has(String(raw.securityPosture))) {
    add("SECURITY_POSTURE_PIN_INVALID", "manifest", "Manifest inference-path pin is invalid.");
  }
  const inferenceBinding = asPlainRecord(raw.inferenceBinding);
  let inferenceBindingShapeValid = true;
  try {
    assertValidSessionInferenceBinding(raw as unknown as Pick<SessionManifest, "providerId" | "model" | "inferenceBinding">);
  } catch {
    inferenceBindingShapeValid = false;
  }
  if (raw.inferenceBinding !== undefined && (
    !inferenceBindingShapeValid ||
    !inferenceBinding ||
    (inferenceBinding.version !== 1 && inferenceBinding.version !== 2) ||
    Object.keys(inferenceBinding).length !== (inferenceBinding.version === 2 ? 12 : 10) ||
    (inferenceBinding.version === 2 && (
      !boundedString(inferenceBinding.transportId, 256) ||
      !["openai-responses", "openai-chat-completions", "anthropic-messages", "openai-compatible"].includes(String(inferenceBinding.protocol))
    )) ||
    !boundedString(inferenceBinding.connectionId, 256) ||
    !Number.isSafeInteger(inferenceBinding.connectionGeneration) ||
    (inferenceBinding.connectionGeneration as number) <= 0 ||
    !boundedString(inferenceBinding.providerId, 256) ||
    (inferenceBinding.version === 2 && inferenceBinding.providerId !== raw.providerId) ||
    !boundedString(inferenceBinding.providerLabel, 256) ||
    !Number.isSafeInteger(inferenceBinding.providerRevision) ||
    (inferenceBinding.providerRevision as number) <= 0 ||
    !["oauth-pkce", "api-key", "local-none"].includes(String(inferenceBinding.authMethod)) ||
    !(inferenceBinding.version === 1
      ? ["e2ee-attestable", "provider-tls", "loopback-local"]
      : ["provider-tls", "loopback-local"]
    ).includes(String(inferenceBinding.transportBoundary)) ||
    !boundedString(inferenceBinding.modelId, 512) ||
    inferenceBinding.modelId !== raw.model ||
    !boundedString(inferenceBinding.boundAt, 128) ||
    !Number.isFinite(Date.parse(String(inferenceBinding.boundAt)))
  )) {
    add("INFERENCE_BINDING_INVALID", "manifest", "Manifest inference connection binding is malformed or does not match its model pin.");
  }
  if (raw.contextPolicy !== undefined && !canonicalSessionContextPolicy(raw.contextPolicy)) {
    add("CONTEXT_POLICY_INVALID", "manifest", "Manifest context-window and compression semantics are invalid.");
  }
  if (
    (raw.protocolVersion === 1 && raw.turnContext !== undefined) ||
    (raw.protocolVersion === 2 && raw.turnContext !== "required" && raw.turnContext !== "disabled")
  ) {
    add("TURN_CONTEXT_POLICY_INVALID", "manifest", "Manifest turn-context retrieval policy is invalid.");
  }
  const lineage = asPlainRecord(raw.lineage);
  if (raw.lineage !== undefined && (
    !lineage ||
    lineage.version !== 1 ||
    lineage.kind !== "fork" ||
    !boundedString(lineage.sourceSessionId, 512) ||
    !Number.isSafeInteger(lineage.sourceHeadSequence) ||
    (lineage.sourceHeadSequence as number) <= 0 ||
    !DIGEST_PATTERN.test(String(lineage.sourceHeadDigest)) ||
    !boundedString(lineage.forkedAt, 128) ||
    !Number.isFinite(Date.parse(String(lineage.forkedAt))) ||
    lineage.forkedAt !== raw.createdAt
  )) {
    add("FORK_LINEAGE_INVALID", "manifest", "Manifest fork lineage is malformed or does not match manifest creation time.");
  }
  const tools = raw.tools;
  const toolNames = new Set<string>();
  let toolsValid = true;
  for (const candidate of tools) {
    const tool = asPlainRecord(candidate);
    if (
      !tool ||
      !boundedString(tool.name, 256) ||
      !boundedString(tool.description, 32_768) ||
      !EFFECTS.has(String(tool.effect)) ||
      !inspectJson(tool.inputSchema, DEFAULT_LIMITS).valid
    ) {
      toolsValid = false;
      continue;
    }
    if (toolNames.has(tool.name as string)) toolsValid = false;
    toolNames.add(tool.name as string);
  }
  if (!toolsValid) {
    add("TOOL_MANIFEST_INVALID", "manifest", "Tool manifest contains an invalid or duplicate definition.");
  } else if ((await sha256(stableStringify(tools as JsonValue))) !== raw.toolManifestDigest) {
    add("TOOL_MANIFEST_DIGEST_MISMATCH", "manifest", "Tool definitions do not match their pinned digest.");
  }
  const profile = asPlainRecord(raw.profile);
  if (profile) {
    const skills = Array.isArray(profile.resolvedSkills) ? profile.resolvedSkills : undefined;
    const skillIds = new Set<string>();
    const skillsValid = Boolean(skills?.every((candidate, index) => {
      const skill = asPlainRecord(candidate);
      if (
        !skill ||
        !boundedString(skill.skillId, 256) ||
        !DIGEST_PATTERN.test(String(skill.digest)) ||
        !Number.isSafeInteger(skill.promptOrder) ||
        (skill.promptOrder as number) < -10_000 ||
        (skill.promptOrder as number) > 10_000 ||
        skillIds.has(skill.skillId as string)
      ) return false;
      skillIds.add(skill.skillId as string);
      if (index > 0) {
        const prior = asPlainRecord(skills![index - 1]);
        if (
          prior &&
          ((prior.promptOrder as number) > (skill.promptOrder as number) ||
            (prior.promptOrder === skill.promptOrder && String(prior.skillId) > String(skill.skillId)))
        ) return false;
      }
      return true;
    }));
    if (
      !skills ||
      !skillsValid ||
      (profile.version !== 1 && profile.version !== 2) ||
      !boundedString(profile.profileId, 256) ||
      !DIGEST_PATTERN.test(String(profile.profileRevision)) ||
      !boundedString(profile.themeId, 256) ||
      !DIGEST_PATTERN.test(String(profile.themeDigest)) ||
      !DIGEST_PATTERN.test(String(profile.skillSetDigest)) ||
      !DIGEST_PATTERN.test(String(profile.resolutionDigest))
    ) {
      add("PROFILE_BINDING_INVALID", "manifest", "Session profile binding is invalid.");
    } else if ((await sha256(stableStringify(skills as JsonValue))) !== profile.skillSetDigest) {
      add("SKILL_SET_DIGEST_MISMATCH", "manifest", "Resolved skills do not match their pinned digest.");
    }
    const workspaceBinding = asPlainRecord(profile.workspaceBinding);
    const hasSiloFields = profile.workspaceBinding !== undefined || profile.memoryScope !== undefined || profile.approvalMode !== undefined;
    const validWorkspaceBinding = workspaceBinding !== undefined && (
      (workspaceBinding.kind === "active-workspace" && Object.keys(workspaceBinding).length === 1) ||
      (workspaceBinding.kind === "workspace-id" && !!boundedString(workspaceBinding.workspaceId, 512))
    );
    const validSilo = validWorkspaceBinding
      && ["session", "profile", "workspace"].includes(String(profile.memoryScope))
      && ["ask-first", "auto-approve", "full-access"].includes(String(profile.approvalMode));
    if ((profile.version === 2 && !validSilo) || (profile.version === 1 && hasSiloFields)) {
      add("PROFILE_SILO_INVALID", "manifest", "Session profile workspace, memory, or approval boundary is invalid.");
    }
  }
}

function validateHead(
  session: SessionRecord,
  events: readonly DurableEvent[],
  add: AddFinding,
): void {
  const last = events.at(-1);
  const sequence = last?.sequence ?? 0;
  const digest = last?.digest ?? "genesis";
  if (session.headSequence !== sequence || session.headDigest !== digest) {
    add("SESSION_HEAD_MISMATCH", "chain", "Session head does not match the final audited event.");
  }
  if (last && session.updatedAt !== last.recordedAt) {
    add("SESSION_UPDATED_AT_MISMATCH", "chain", "Session update timestamp does not match the final event.", undefined, "warning");
  }
}

async function validateProtocol(
  session: SessionRecord,
  events: readonly DurableEvent[],
  add: AddFinding,
): Promise<SessionAuditReport["counts"]> {
  const counts = emptyCounts();
  counts.events = events.length;
  const seenTurns = new Set<string>();
  const seenOperations = new Set<string>();
  const messages: CanonicalMessage[] = [];
  let lastContextMessage: LastContextMessage | undefined;
  let active: TurnState | undefined;
  let activeLocal: LocalCommandState | undefined;
  /**
   * Inferences this session paid for that are not turn steps, by operation ID.
   * Their usage is admitted against the record that declared them, which is the
   * only identity they have.
   */
  const ancillaryInferences = new Map<string, string>();
  /**
   * Shell records already admitted, keyed by terminal + writer + sequence.
   *
   * The terminal manager's sequence is monotonic per writer, so that triple is
   * the record's identity. A repeat means the same shell action was appended
   * twice — a retried sink or a second page writing the same lineage — and a
   * ledger that counts one command as two is worse than one that missed it.
   */
  const seenTerminalRecords = new Set<string>();
  let sawCreation = false;
  let sawForkContext = false;
  let verifiedForkContextDigest: string | undefined;
  let projectedTitle: string | undefined;

  /*
   * Rebuild the transcript with the same canonical projector the runtime uses.
   * Most events only append, but a failed or cancelled terminal can retract an
   * entire non-actionable turn or replace its request with a salvage checkpoint.
   * An incremental array cannot express either transition safely.
   */
  const reprojectMessagesThrough = (index: number, injectLatestContext: boolean): void => {
    messages.splice(0, messages.length, ...materializeMessages(
      events.slice(0, index + 1),
      {
        injectLatestContext,
        allowEmbeddedContext: session.manifest.turnContext === undefined,
        allowSelectedContext: session.manifest.turnContext !== "disabled",
        forkContextScope: { sessionId: session.id, lineage: session.manifest.lineage },
        verifiedForkContextDigest,
      },
    ));
  };

  const requireActive = (event: DurableEvent): TurnState | undefined => {
    if (!active || !event.turnId || event.turnId !== active.id || active.terminal) {
      addEventFinding(add, event, "EVENT_OUTSIDE_ACTIVE_TURN", `${event.type} does not belong to the active turn.`);
      return undefined;
    }
    return active;
  };

  const requireActiveLocal = (event: DurableEvent): LocalCommandState | undefined => {
    if (
      !activeLocal ||
      event.turnId !== activeLocal.turnId ||
      event.operationId !== activeLocal.operationId
    ) {
      addEventFinding(add, event, "LOCAL_COMMAND_EVENT_ORPHANED", `${event.type} does not match the active client-only local command.`);
      return undefined;
    }
    return activeLocal;
  };

  /*
   * The model the thread offers to the next durable turn at this point in the
   * walk. turn.requested snapshots it into TurnState. A later model change is
   * therefore effective for the next turn without rewriting the identity of a
   * turn that is already admitted and may still be streaming.
   */
  // The walk begins at history's first event, before any change could have
  // happened: the model that binds receipts minted from a manifest-stamped
  // thread. `session.modelOverride` is never read here for the same reason
  // the audit never trusts it — it is derived from the same events, so the
  // walk recomputes the override and gets the reason for free.
  let effectiveModel: string = session.manifest.model;
  let effectiveContextPolicy = session.manifest.contextPolicy;
  /*
   * …and the approval mode, for exactly the same reason.
   *
   * Provenance was compared against the manifest's pin forever, and the
   * manifest is immutable — so the moment anyone used the approval-mode
   * control the product ships, every approval after it "claimed a mode the
   * session manifest did not pin", which is an error-severity finding, which
   * made the history suspect, which blocked the conversation from ever being
   * resumed. Choosing Full Access mid-thread quietly cost you the thread.
   *
   * The journal already carries the answer: `session.approval-policy-changed`
   * is a durable, validated record of the mode changing. The walk advances the
   * effective mode as it passes one, so an approval is checked against the
   * mode that was actually in force when it happened. Provenance is still
   * fully checked — an approval claiming a mode nothing ever put in force is
   * still a finding.
   */
  let effectiveApprovalMode = session.manifest.profile && "approvalMode" in session.manifest.profile
    ? session.manifest.profile.approvalMode
    : undefined;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const { type, turnId: eventTurnId, operationId: eventOperationId } = event;
    const payload = asPlainRecord(event.payload);
    if (!KNOWN_EVENT_TYPES.has(type)) {
      counts.unknownEvents += 1;
      addEventFinding(add, event, "EVENT_TYPE_UNKNOWN", `Event type ${type} is not interpreted by protocol-v1 audit rules.`, "completeness", "warning");
      continue;
    }

    if (type === "session.created") {
      if (index !== 0 || sawCreation || eventTurnId || eventOperationId || !payload) {
        addEventFinding(add, event, "SESSION_CREATION_INVALID", "session.created must be the first event and have no turn or operation ID.");
      } else {
        sawCreation = true;
        const eventManifest = asPlainRecord(payload.manifest);
        if (!eventManifest || stableStringify(eventManifest as JsonValue) !== stableStringify(session.manifest as unknown as JsonValue)) {
          addEventFinding(add, event, "SESSION_MANIFEST_SNAPSHOT_MISMATCH", "Creation event manifest differs from the session record.", "manifest");
        }
        if (typeof payload.title === "string") projectedTitle = payload.title;
      }
      continue;
    }
    if (type === FORK_CONTEXT_EVENT_TYPE) {
      const seed = canonicalForkContextSeed(event.payload);
      const verified = seed ? await verifyForkContextSeed(seed) : false;
      const scope = { sessionId: session.id, lineage: session.manifest.lineage };
      if (
        index !== 1 ||
        sawForkContext ||
        eventTurnId ||
        eventOperationId ||
        !seed ||
        !verified ||
        !forkContextSeedMatchesScope(seed, scope)
      ) {
        addEventFinding(add, event, !seed || !verified
            ? "FORK_CONTEXT_SEED_INVALID"
            : !forkContextSeedMatchesScope(seed, scope)
              ? "FORK_CONTEXT_SEED_SCOPE_MISMATCH"
              : "FORK_CONTEXT_SEED_LIFECYCLE_INVALID", "Fork context must be one verified, lineage-bound event immediately after session creation.");
      } else {
        sawForkContext = true;
        verifiedForkContextDigest = seed.contextDigest;
        messages.push(...seed.messages.map((message) => structuredClone(message)));
      }
      continue;
    }
    if (type === "session.renamed") {
      if (eventTurnId || eventOperationId || !payload || typeof payload.title !== "string" || !payload.title.trim() || payload.title.length > 240) {
        add("SESSION_RENAME_MALFORMED", "protocol", "A session rename must carry one bounded title outside any turn.", { sequence: event.sequence });
      } else projectedTitle = payload.title;
      continue;
    }
    if (type === "session.favorite.changed") {
      if (eventTurnId || eventOperationId || !payload || typeof payload.favorite !== "boolean") {
        add("SESSION_FAVORITE_MALFORMED", "protocol", "A session favorite change must carry one boolean outside any turn.", { sequence: event.sequence });
      }
      continue;
    }
    if (type === "session.approval-policy-changed") {
      if (eventTurnId || eventOperationId || !payload || !["ask-first", "auto-approve", "full-access"].includes(String(payload.approvalMode))) {
        add("SESSION_APPROVAL_POLICY_MALFORMED", "protocol", "A session approval-policy change must carry one named mode outside any turn.", { sequence: event.sequence });
      } else {
        // Well formed — the branch above proved the string is one of the three
        // named modes — so it is what governs from here down the chain.
        effectiveApprovalMode = payload.approvalMode as NonNullable<typeof effectiveApprovalMode>;
      }
      continue;
    }
    if (type === "session.model-changed") {
      const policyValue = payload && !Array.isArray(payload) && typeof payload === "object"
        ? payload.contextPolicy
        : undefined;
      const modelValue = payload && !Array.isArray(payload) && typeof payload === "object" ? payload.model : undefined;
      const malformedModel = typeof modelValue !== "string" || !modelValue.trim() || modelValue.length > 256 || /[\u0000-\u001F\u007F]/u.test(modelValue);
      const malformedPolicy = policyValue !== undefined && policyValue !== null && !canonicalSessionContextPolicy(policyValue);
      if (eventTurnId || eventOperationId || malformedModel || malformedPolicy) {
        add("SESSION_MODEL_CHANGE_MALFORMED", "protocol", "A session model change must carry one printable model id, and any embedded context policy, outside any turn.", { sequence: event.sequence });
      } else {
        effectiveModel = modelValue as string;
        if (policyValue !== undefined) {
          effectiveContextPolicy = policyValue === null
            ? undefined
            : canonicalSessionContextPolicy(policyValue) ?? effectiveContextPolicy;
        }
      }
      continue;
    }
    if (type === "profile.favorite-order.moved") {
      const hasBeforeSession = payload?.beforeSessionId !== undefined;
      const hasBeforeFavorite = payload?.beforeFavoriteEventId !== undefined;
      if (
        eventTurnId
        || eventOperationId
        || !payload
        || payload.version !== 1
        || !boundedString(payload.profileId, 512)
        || !boundedString(payload.sessionId, 512)
        || !boundedString(payload.favoriteEventId, 512)
        || !Number.isSafeInteger(payload.generation)
        || (payload.generation as number) < 1
        || (payload.previousEventId !== undefined && !boundedString(payload.previousEventId, 512))
        || (hasBeforeSession && !boundedString(payload.beforeSessionId, 512))
        || (hasBeforeFavorite && !boundedString(payload.beforeFavoriteEventId, 512))
        || hasBeforeSession !== hasBeforeFavorite
        || payload.profileId !== session.manifest.profile?.profileId
        || payload.sessionId !== session.id
        || payload.beforeSessionId === session.id
      ) {
        add("PROFILE_FAVORITE_ORDER_MALFORMED", "protocol", "A favorite-order move must be profile-bound, membership-bound, bounded, and recorded outside any turn.", { sequence: event.sequence });
      }
      continue;
    }
    if (type === "profile.active-conversation.selected") {
      if (
        eventTurnId
        || eventOperationId
        || active
        || !payload
        || payload.version !== 1
        || !boundedString(payload.profileId, 512)
        || !boundedString(payload.sessionId, 512)
        || !Number.isSafeInteger(payload.generation)
        || (payload.generation as number) < 1
        || (payload.previousEventId !== undefined && !boundedString(payload.previousEventId, 512))
        || payload.profileId !== session.manifest.profile?.profileId
      ) {
        add("PROFILE_ACTIVE_CONVERSATION_MALFORMED", "protocol", "A profile active-conversation selection must be profile-bound, bounded, and recorded between turns.", { sequence: event.sequence });
      }
      continue;
    }

    if (type === "context.summary.updated") {
      const summary = canonicalContextSummary(event.payload);
      const valid = summary
        ? await verifyContextSummary(summary, events.slice(0, index + 1))
        : false;
      const turnBoundPreprocessing = Boolean(
        active &&
        session.manifest.protocolVersion === 2 &&
        eventTurnId === active.id &&
        !eventOperationId &&
        active.step === -1 &&
        !active.inference &&
        !active.finalAssistant &&
        active.tools.length === 0,
      );
      const outsideTurn = !active && !eventTurnId && !eventOperationId;
      if (
        activeLocal || (!outsideTurn && !turnBoundPreprocessing) || !summary || !valid ||
        summary.sourceEndSequence >= event.sequence ||
        !summaryMatchesContextPolicy(
          summary,
          session.manifest,
          events.slice(0, index),
          turnBoundPreprocessing && active ? active.model : effectiveModel,
          turnBoundPreprocessing && active ? active.contextPolicy : effectiveContextPolicy,
        )
      ) {
        addEventFinding(add, event, "CONTEXT_SUMMARY_INVALID", "A context summary must be a verified, digest-linked transcript-prefix delta outside an active turn.");
      } else {
        reprojectMessagesThrough(index, turnBoundPreprocessing);
        if (active && turnBoundPreprocessing) active.compacted = true;
        if (active?.request) {
          active.request.messageIndex = messages.length - 1;
          lastContextMessage = active.contextSelected || active.request.liveEnvironment
            ? { index: active.request.messageIndex, content: active.request.content }
            : undefined;
        } else {
          lastContextMessage = undefined;
        }
      }
      continue;
    }

    if (type === "local.command.requested") {
      if (active || activeLocal) {
        addEventFinding(add, event, "LOCAL_COMMAND_OVERLAP", "A client-only local command started while another turn or local command was active.");
        continue;
      }
      const turnId = boundedString(eventTurnId, 512);
      const operationId = boundedString(eventOperationId, 512);
      const toolName = boundedString(payload?.toolName, 256);
      const hasArguments = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, "arguments"));
      if (
        !turnId ||
        !operationId ||
        !toolName ||
        !payload ||
        typeof payload.content !== "string" ||
        !hasArguments ||
        seenTurns.has(turnId) ||
        seenOperations.has(operationId)
      ) {
        addEventFinding(add, event, "LOCAL_COMMAND_REQUEST_INVALID", "A local command request must have new turn/operation IDs, a bounded tool name, text, and arguments.");
        continue;
      }
      seenTurns.add(turnId);
      seenOperations.add(operationId);
      counts.localCommands += 1;
      activeLocal = { turnId, operationId, toolName, approved: false };
      continue;
    }

    if (
      type === "local.command.approved" ||
      type === "local.command.completed" ||
      type === "local.command.denied" ||
      type === "local.command.failed"
    ) {
      const command = requireActiveLocal(event);
      if (!command || !payload) continue;
      if (payload.toolName !== command.toolName) {
        addEventFinding(add, event, "LOCAL_COMMAND_IDENTITY_MISMATCH", "A local-command event changed its pinned tool identity.");
        continue;
      }
      if (type === "local.command.approved") {
        if (command.approved) {
          addEventFinding(add, event, "LOCAL_COMMAND_APPROVAL_INVALID", "A local command approval is duplicated.");
        } else {
          command.approved = true;
          const issue = approvalProvenanceIssue(payload.approval, effectiveApprovalMode);
          if (issue) addEventFinding(add, event, "TOOL_APPROVAL_PROVENANCE_INVALID", issue);
        }
        continue;
      }

      let terminalValid = true;
      if (typeof payload.content !== "string") terminalValid = false;
      if (
        type === "local.command.completed" &&
        (!command.approved || typeof payload.isError !== "boolean")
      ) {
        terminalValid = false;
      }
      if (type === "local.command.denied" && command.approved) terminalValid = false;
      if (
        type === "local.command.failed" &&
        payload.cancelled !== undefined &&
        typeof payload.cancelled !== "boolean"
      ) {
        terminalValid = false;
      }
      if (!terminalValid) {
        addEventFinding(add, event, "LOCAL_COMMAND_TERMINAL_INVALID", "A local command terminal is out of order or has malformed client-only result metadata.");
      } else {
        counts.terminalLocalCommands += 1;
      }
      activeLocal = undefined;
      continue;
    }

    if (type === CONVERSATION_NAMED_EVENT_TYPE) {
      /*
       * The naming inference runs beside a turn rather than inside one, so it
       * gets its own identity and touches no turn state. What it must carry is
       * the title it produced, the answer that title was derived from — so the
       * receipt's response digest can be recomputed from the record instead of
       * trusted — and, when the transport issued one, a receipt that names this
       * session: the binding whose absence made the call unprovable at all.
       *
       * The answer is length-bounded rather than character-bounded: it is a
       * verbatim provider string, and a model that emits an odd control
       * character must not make an otherwise honest record permanently invalid.
       *
       * The title is the *outcome*, not the evidence, so it may be absent: a
       * request that came back with a refusal or an essay was still billed and
       * still recorded, and requiring a title here would have meant the only
       * way to stay audit-clean was to journal nothing — which is precisely the
       * unaudited paid request this record exists to end. A titleless record
       * must therefore carry the verbatim answer instead, so it still states
       * what was paid for and still lets the receipt's response digest be
       * recomputed. Neither field absent is an empty claim, and stays refused.
       */
      const turnId = boundedString(eventTurnId, 512);
      const operationId = boundedString(eventOperationId, 512);
      const title = boundedString(payload?.title, 240);
      const answer = typeof payload?.answer === "string" && payload.answer.length <= 4_096;
      // Absent is allowed; malformed never is. A 4 KiB "title" must still be
      // refused rather than excused by the answer standing in for it.
      const titleAcceptable = payload?.title === undefined ? answer : Boolean(title);
      if (
        !payload ||
        !turnId ||
        !operationId ||
        !titleAcceptable ||
        seenTurns.has(turnId) ||
        seenOperations.has(operationId) ||
        !boundedString(payload.model, 256) ||
        (payload.answer !== undefined && (typeof payload.answer !== "string" || payload.answer.length > 4_096)) ||
        (payload.receipt !== undefined && !receiptIdentityMatches(asPlainRecord(payload.receipt), session, turnId, effectiveModel))
      ) {
        addEventFinding(add, event, "CONVERSATION_NAMING_INVALID", "A conversation naming record must have new turn/operation IDs, a bounded model, either a bounded title or the verbatim answer it was rejected from, and any trace receipt must name this session and operation.");
        continue;
      }
      seenTurns.add(turnId);
      seenOperations.add(operationId);
      ancillaryInferences.set(operationId, turnId);
      continue;
    }

    if (type === HUMAN_INTENT_EVENT_TYPE) {
      /*
       * A human-initiated decision is deliberately outside the turn protocol:
       * the person can stage a commit or probe a vault while a turn is running,
       * and nothing about that belongs to the turn. So this validates itself
       * and touches no turn state — but it must still be complete evidence, so
       * it needs its own fresh identity, a decision, and the provenance record
       * naming the authority that allowed it. Anything less is the decoration
       * the tool-approval path was already found to be.
       */
      const turnId = boundedString(eventTurnId, 512);
      const operationId = boundedString(eventOperationId, 512);
      const name = boundedString(payload?.toolName, 256);
      const decision = payload?.decision;
      if (
        !payload ||
        !turnId ||
        !operationId ||
        !name ||
        seenTurns.has(turnId) ||
        seenOperations.has(operationId) ||
        (decision !== "allow" && decision !== "deny") ||
        !EFFECTS.has(String(payload.effect))
      ) {
        addEventFinding(add, event, "HUMAN_INTENT_INVALID", "A human-initiated approval must carry new turn/operation IDs, a bounded tool name, a known effect, and an allow/deny decision.");
        continue;
      }
      seenTurns.add(turnId);
      seenOperations.add(operationId);
      // Counted here, past the shape gate and beside the identities it just
      // claimed, so the number means "records this audit accepted" — the same
      // bar `shellRecords` is held to. A provenance complaint below is a
      // finding about a record that exists, not a reason to stop counting it.
      counts.humanIntentDecisions += 1;
      if (decision === "allow") counts.humanIntentAllowed += 1;
      const issue = approvalProvenanceIssue(payload.approval, effectiveApprovalMode);
      if (issue) {
        addEventFinding(add, event, "HUMAN_INTENT_PROVENANCE_INVALID", issue);
      }
      continue;
    }

    if (type === TERMINAL_ACTIVITY_EVENT_TYPE) {
      /*
       * A shell action, validated entirely on its own terms.
       *
       * Like a rename, it happens beside turns rather than inside one, so it
       * must carry no turn or operation identity — a shell record wearing a
       * turn ID would make this session's turn accounting describe work no
       * model did. What it must carry is the binding an auditor traverses:
       * which terminal, which writer, which process epoch, and — for a
       * reconciliation — which workspace paths moved.
       *
       * `outputTail` is rejected outright rather than truncated. The manager
       * retains a tail of raw PTY bytes for its own transcript; those bytes
       * have passed no redaction and the journal is the artifact that gets
       * exported, so a payload carrying them is malformed, not merely large.
       */
      const terminalSessionId = boundedString(payload?.terminalSessionId, 512);
      const recordId = boundedString(payload?.recordId, 512);
      const sequence = payload?.sequence;
      const processEpoch = payload?.processEpoch;
      const changedPaths = payload?.changedPaths;
      const writerId = payload?.writerId === undefined ? undefined : boundedString(payload.writerId, 512);
      const sourceRecordId = payload?.sourceRecordId === undefined ? undefined : boundedString(payload.sourceRecordId, 512);
      if (
        !payload ||
        eventTurnId ||
        eventOperationId ||
        payload.version !== 1 ||
        payload.outputTail !== undefined ||
        !terminalSessionId ||
        !recordId ||
        !Number.isSafeInteger(sequence) ||
        (sequence as number) <= 0 ||
        !Number.isSafeInteger(processEpoch) ||
        (processEpoch as number) < 0 ||
        !TERMINAL_RECORD_KINDS.has(String(payload.kind)) ||
        !TERMINAL_RECORD_OUTCOMES.has(String(payload.outcome)) ||
        !TERMINAL_SESSION_ORIGINS.has(String(payload.origin)) ||
        !boundedString(payload.cwd, 4_096) ||
        !boundedString(payload.summary, TERMINAL_MAX_SUMMARY_CHARS) ||
        !Number.isFinite(Date.parse(String(payload.recordedAt))) ||
        (payload.writerId !== undefined && !writerId) ||
        (payload.sourceRecordId !== undefined && !sourceRecordId) ||
        (payload.kind === "browser-git" && !sourceRecordId) ||
        (payload.kind !== "browser-git" && payload.sourceRecordId !== undefined) ||
        (payload.profileId !== undefined && !boundedString(payload.profileId, 512)) ||
        (payload.command !== undefined && !boundedString(payload.command, TERMINAL_MAX_COMMAND_CHARS)) ||
        (payload.exitCode !== undefined && !Number.isSafeInteger(payload.exitCode)) ||
        (changedPaths !== undefined && (
          !Array.isArray(changedPaths) ||
          changedPaths.length > TERMINAL_MAX_CHANGED_PATHS ||
          changedPaths.some((path) => !boundedString(path, 4_096))))
      ) {
        addEventFinding(add, event, "TERMINAL_RECORD_INVALID", "A terminal record must sit outside any turn and carry a bounded terminal id, record id, positive sequence, process epoch, known kind/outcome/origin, cwd, summary and timestamp — and no retained process output.");
        continue;
      }
      const identity = `${terminalSessionId}:${writerId ?? ""}:${String(sequence)}`;
      if (seenTerminalRecords.has(identity)) {
        addEventFinding(add, event, "TERMINAL_RECORD_DUPLICATE", "The same terminal record sequence was appended twice for this terminal and writer.");
        continue;
      }
      seenTerminalRecords.add(identity);
      counts.shellRecords += 1;
      continue;
    }

    if (type === "turn.requested") {
      if (activeLocal) {
        addEventFinding(add, event, "TURN_OVERLAP", "A provider turn started before the active client-only local command terminated.");
        continue;
      }
      if (active && !active.terminal) {
        addEventFinding(add, event, "TURN_OVERLAP", "A turn started before the preceding turn reached a terminal event.");
      }
      if (!eventTurnId || eventOperationId || seenTurns.has(eventTurnId)) {
        addEventFinding(add, event, "TURN_REQUEST_INVALID", "Turn request must have a new turn ID and no operation ID.");
        active = undefined;
        continue;
      }
      const images = canonicalImageInputs(payload?.images);
      const liveEnvironment = payload?.liveEnvironment === undefined
        ? undefined
        : canonicalLiveEnvironmentSnapshot(payload.liveEnvironment);
      const liveEnvironmentVerified = liveEnvironment
        ? await verifyLiveEnvironmentSnapshot(liveEnvironment)
        : false;
      const liveEnvironmentScopeVerified = liveEnvironment
        ? liveEnvironmentScopeMatches(liveEnvironment, session.id, session.manifest, effectiveModel)
        : false;
      const contextSelection = payload?.contextSelection === undefined
        ? undefined
        : canonicalContextSelection(payload.contextSelection);
      const contextVerified = contextSelection ? await verifyContextSelection(contextSelection) : false;
      const contextQueryVerified = contextSelection && typeof payload?.content === "string"
        ? await verifyContextSelectionQuery(contextSelection, payload.content)
        : false;
      const contextScopeVerified = contextSelection
        ? contextSelectionScopeMatches(contextSelection, session.id, session.manifest)
        : false;
      const embeddedContextAllowed = session.manifest.turnContext === undefined;
      if (!payload || typeof payload.content !== "string") {
        addEventFinding(add, event, "TURN_CONTENT_INVALID", "Turn request payload must contain string content.");
      }
      if (!images) {
        addEventFinding(add, event, "TURN_IMAGES_INVALID", "Turn request images violate the bounded inline-image contract.");
      }
      if (payload?.liveEnvironment !== undefined && !liveEnvironment) {
        addEventFinding(add, event, "TURN_LIVE_ENVIRONMENT_INVALID", "Turn live-environment data violates the bounded canonical snapshot contract.");
      } else if (liveEnvironment && !liveEnvironmentVerified) {
        addEventFinding(add, event, "TURN_LIVE_ENVIRONMENT_DIGEST_MISMATCH", "Turn live-environment snapshot digest does not verify.");
      } else if (liveEnvironment && !liveEnvironmentScopeVerified) {
        addEventFinding(add, event, "TURN_LIVE_ENVIRONMENT_SCOPE_MISMATCH", "Turn live-environment snapshot is outside the session's pinned scope.");
      }
      if (payload?.contextSelection !== undefined && !contextSelection) {
        addEventFinding(add, event, "TURN_CONTEXT_INVALID", "Turn context selection violates the bounded provenance contract.");
      } else if (contextSelection && !contextVerified) {
        addEventFinding(add, event, "TURN_CONTEXT_DIGEST_MISMATCH", "Turn context selection digest or selected text digest does not verify.");
      } else if (contextSelection && !contextQueryVerified) {
        addEventFinding(add, event, "TURN_CONTEXT_QUERY_MISMATCH", "Turn context selection is committed to a different canonical query.");
      } else if (contextSelection && !contextScopeVerified) {
        addEventFinding(add, event, "TURN_CONTEXT_SCOPE_MISMATCH", "Turn context selection lineage is outside the session's pinned scope.");
      }
      if (payload?.contextSelection !== undefined && !embeddedContextAllowed) {
        addEventFinding(add, event, "TURN_CONTEXT_LEGACY_EMBED_INVALID", "Only historical manifests without an explicit turn-context policy may embed selection data in turn.requested.");
      }
      seenTurns.add(eventTurnId);
      counts.turns += 1;
      active = {
        id: eventTurnId,
        model: effectiveModel,
        contextPolicy: effectiveContextPolicy,
        step: -1,
        tools: [],
      };
      if (lastContextMessage) {
        const prior = messages[lastContextMessage.index];
        if (prior?.role === "user") messages[lastContextMessage.index] = { ...prior, content: lastContextMessage.content };
        lastContextMessage = undefined;
      }
      if (payload && typeof payload.content === "string" && images &&
          (payload.liveEnvironment === undefined || (
            liveEnvironment && liveEnvironmentVerified && liveEnvironmentScopeVerified
          )) &&
          (payload.contextSelection === undefined || (
            embeddedContextAllowed && contextSelection && contextVerified && contextQueryVerified && contextScopeVerified
          ))) {
        const index = messages.length;
        /*
         * The exemption the agent applies when it builds the request it sends
         * (see `slashLocal` in agent.ts). This copy did not, so a prompt whose
         * text starts with `/` — including `/reason`, which the demo answer
         * tells a first-time reader to try — hashed here as the injected form
         * and there as the raw one. The digests could never agree, and the
         * conversation quarantined itself on the next open with
         * INFERENCE_REQUEST_DIGEST_MISMATCH. The agent is the authority on what
         * it sent; this rebuild has to model it exactly.
         */
        const slashLocal = payload.content.trimStart().startsWith("/");
        messages.push({
          role: "user",
          content: slashLocal
            ? payload.content
            : injectContextSelection(injectLiveEnvironment(payload.content, liveEnvironment), contextSelection),
          ...(images.length ? { images: [...images] } : {}),
        });
        active.request = {
          content: payload.content,
          messageIndex: index,
          ...(liveEnvironment ? { liveEnvironment } : {}),
        };
        active.contextSelected = embeddedContextAllowed && Boolean(contextSelection);
        if (liveEnvironment || (embeddedContextAllowed && contextSelection?.hits.length)) {
          lastContextMessage = { index, content: payload.content };
        }
      }
      continue;
    }

    if (type === "turn.context.selected") {
      const turn = requireActive(event);
      const selection = canonicalContextSelection(payload?.contextSelection);
      const verified = selection ? await verifyContextSelection(selection) : false;
      const queryVerified = selection && turn?.request
        ? await verifyContextSelectionQuery(selection, turn.request.content)
        : false;
      const scopeVerified = selection
        ? contextSelectionScopeMatches(selection, session.id, session.manifest)
        : false;
      if (
        !turn ||
        eventOperationId ||
        turn.step !== -1 ||
        turn.inference ||
        turn.tools.length ||
        turn.contextSelected ||
        !turn.request ||
        session.manifest.protocolVersion !== 2 ||
        session.manifest.turnContext === "disabled" ||
        !selection ||
        !verified ||
        !queryVerified ||
        !scopeVerified
      ) {
        addEventFinding(add, event, !selection
            ? "TURN_CONTEXT_INVALID"
            : !verified
              ? "TURN_CONTEXT_DIGEST_MISMATCH"
              : !queryVerified
                ? "TURN_CONTEXT_QUERY_MISMATCH"
                : !scopeVerified
                  ? "TURN_CONTEXT_SCOPE_MISMATCH"
                  : "TURN_CONTEXT_LIFECYCLE_INVALID", "Turn context must be canonical, verified, policy-allowed, unique, and journaled before inference.");
        continue;
      }
      const message = messages[turn.request.messageIndex];
      if (!message || message.role !== "user") {
        addEventFinding(add, event, "TURN_CONTEXT_LIFECYCLE_INVALID", "Turn context has no matching user request.");
        continue;
      }
      // Same exemption as the request site above and as agent.ts.
      messages[turn.request.messageIndex] = turn.request.content.trimStart().startsWith("/")
        ? { ...message, content: turn.request.content }
        : {
          ...message,
          content: injectContextSelection(
            injectLiveEnvironment(turn.request.content, turn.request.liveEnvironment),
            selection,
          ),
        };
      turn.contextSelected = true;
      if (turn.request.liveEnvironment || selection.hits.length) {
        lastContextMessage = { index: turn.request.messageIndex, content: turn.request.content };
      }
      continue;
    }

    if (type === TASK_PLAN_NOTE_EVENT_TYPE) {
      const turn = requireActive(event);
      const note = canonicalTaskPlanNote(payload);
      if (
        !turn ||
        eventOperationId ||
        turn.step !== -1 ||
        turn.inference ||
        turn.tools.length ||
        !turn.request ||
        // A restatement with no compaction behind it is not a restatement; it
        // is an extra message somebody added to the transcript.
        !turn.compacted ||
        turn.planRestated ||
        !note
      ) {
        addEventFinding(add, event, "TURN_PLAN_NOTE_INVALID", "A work-plan restatement must be a canonical, unique note journaled after this turn's compaction and before inference.");
        continue;
      }
      turn.planRestated = true;
      messages.push({ role: "user", content: note });
      continue;
    }

    if (type === "inference.started") {
      const turn = requireActive(event);
      if (!turn || !payload) continue;
      if (
        session.manifest.turnContext === "required" &&
        turn.request?.content.trim() &&
        !turn.contextSelected
      ) {
        addEventFinding(add, event, "TURN_CONTEXT_REQUIRED_MISSING", "Inference started without the turn-context selection required by the immutable session manifest.");
      }
      const step = payload.step;
      const operationId = eventOperationId;
      if (
        !operationId ||
        seenOperations.has(operationId) ||
        turn.inference ||
        !Number.isSafeInteger(step) ||
        (step as number) !== turn.step + 1 ||
        turn.tools.some((tool) => !tool.terminal)
      ) {
        addEventFinding(add, event, "INFERENCE_LIFECYCLE_INVALID", "Inference operation is reused, out of order, overlapping, or starts before tools are terminal.");
        continue;
      }
      if (
        !sessionInferenceProviderIdMatches(session.manifest, payload.providerId) ||
        payload.model !== turn.model ||
        !POSTURES.has(String(payload.posture))
      ) {
        addEventFinding(add, event, "INFERENCE_BINDING_MISMATCH", "Inference provider, model, or posture does not match the pinned session/runtime vocabulary.");
      }
      if (
        turn.request?.liveEnvironment &&
        turn.request.liveEnvironment.inference.posture !== payload.posture
      ) {
        addEventFinding(add, event, "TURN_LIVE_ENVIRONMENT_POSTURE_MISMATCH", "The live-environment transport posture differs from the inference operation it describes.");
      }
      const idempotencyKey = `${session.id}:${turn.id}:${String(step)}`;
      if (payload.idempotencyKey !== idempotencyKey || !DIGEST_PATTERN.test(String(payload.requestDigest))) {
        addEventFinding(add, event, "INFERENCE_REQUEST_METADATA_INVALID", "Inference idempotency key or request digest is invalid.");
      } else {
        const expectedRequestDigest = await sha256(stableStringify({
          model: turn.model,
          systemPromptDigest: session.manifest.systemPromptDigest,
          messages: boundInferenceHistoryImages(messages),
          tools: session.manifest.tools,
          idempotencyKey,
        } as unknown as JsonValue));
        if (expectedRequestDigest !== payload.requestDigest) {
          addEventFinding(add, event, "INFERENCE_REQUEST_DIGEST_MISMATCH", "Inference request digest does not match the canonical transcript prefix.");
        }
      }
      seenOperations.add(operationId);
      turn.step = step as number;
      turn.tools = [];
      turn.finalAssistant = undefined;
      turn.inference = {
        operationId,
        requestDigest: String(payload.requestDigest),
        posture: typeof payload.posture === "string" ? payload.posture : undefined,
      };
      continue;
    }

    if (type === "inference.usage") {
      /*
       * Two inferences can bill a session, and only one of them is a turn step.
       * The other is Auto Approve's safety review, which runs between a tool
       * call being requested and being decided, so it has no step of its own
       * and borrows the identity of the call it adjudicates. Its cost is real,
       * so refusing to record it would make an unavoidable charge invisible.
       *
       * The window stays narrow on purpose: a review usage must name the call
       * (or the client-only local command) that is *pending a decision* right
       * now. Nothing here can carry a response, a receipt or a message, so the
       * relaxation admits token counts and nothing else.
       */
      const turnOfEvent = active && eventTurnId === active.id && !active.terminal ? active : undefined;
      const stepUsage = Boolean(turnOfEvent?.inference && eventOperationId === turnOfEvent.inference.operationId);
      const reviewOfPendingCall = Boolean(turnOfEvent?.tools.some((tool) =>
        tool.call.id === eventOperationId && tool.requested && !tool.decision && !tool.terminal));
      const reviewOfPendingLocalCommand = Boolean(activeLocal
        && !activeLocal.approved
        && eventTurnId === activeLocal.turnId
        && eventOperationId === activeLocal.operationId);
      // The third payer: an ancillary inference that already declared itself,
      // such as the request that named this conversation.
      const ancillary = Boolean(eventOperationId
        && ancillaryInferences.get(eventOperationId) === eventTurnId);
      if (!payload || (!stepUsage && !reviewOfPendingCall && !reviewOfPendingLocalCommand && !ancillary)) {
        addEventFinding(add, event, "INFERENCE_USAGE_ORPHANED", "Usage event does not match an active inference or a tool action pending a decision.");
        continue;
      }
      for (const tokenField of ["inputTokens", "outputTokens"] as const) {
        const value = payload[tokenField];
        if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
          addEventFinding(add, event, "INFERENCE_USAGE_INVALID", "Usage token counts must be non-negative safe integers.");
          break;
        }
      }
      continue;
    }

    if (type === "assistant.completed") {
      const turn = requireActive(event);
      if (!turn || !payload || !turn.inference || eventOperationId !== turn.inference.operationId) {
        addEventFinding(add, event, "ASSISTANT_ORPHANED", "Assistant event does not terminate the active inference.");
        continue;
      }
      const message = asPlainRecord(payload.message);
      const finishReason = payload.finishReason;
      if (!message || message.role !== "assistant" || typeof message.content !== "string" || !FINISH_REASONS.has(String(finishReason))) {
        addEventFinding(add, event, "ASSISTANT_MESSAGE_INVALID", "Assistant payload has an invalid canonical message or finish reason.");
        turn.inference = undefined;
        continue;
      }
      const toolCalls = parseToolCalls(message.toolCalls, event, add);
      const canonicalMessage: CanonicalMessage = {
        role: "assistant",
        content: message.content,
        ...(toolCalls.length ? { toolCalls } : {}),
      };
      messages.push(canonicalMessage);
      if (toolCalls.length > 0) {
        if (finishReason !== "tool-calls" || payload.responseDigest !== undefined || payload.receipt !== undefined) {
          addEventFinding(add, event, "TOOL_ASSISTANT_TERMINAL_INVALID", "Assistant tool-call phase has inconsistent terminal metadata.");
        }
        const localIds = new Set<string>();
        for (const call of toolCalls) {
          if (localIds.has(call.id) || seenOperations.has(call.id)) {
            addEventFinding(add, event, "TOOL_CALL_ID_REUSED", "Tool-call ID is duplicated or reused as another operation.");
          }
          localIds.add(call.id);
        }
        turn.tools = toolCalls.map((call) => ({ call, requested: false }));
      } else {
        if (finishReason === "tool-calls" || !DIGEST_PATTERN.test(String(payload.responseDigest))) {
          addEventFinding(add, event, "FINAL_ASSISTANT_TERMINAL_INVALID", "Final assistant event has inconsistent finish or response-digest metadata.");
        }
        const expectedResponseDigest = await sha256(message.content);
        if (expectedResponseDigest !== payload.responseDigest) {
          addEventFinding(add, event, "RESPONSE_DIGEST_MISMATCH", "Assistant response does not match its response digest.", "trace");
        }
        const receiptId = validateReceipt(
          payload.receipt,
          session,
          turn,
          String(payload.responseDigest),
          event,
          add,
          turn.model,
        );
        turn.finalAssistant = {
          responseDigest: String(payload.responseDigest),
          receiptId,
          requestDigest: turn.inference.requestDigest,
        };
      }
      turn.inference = undefined;
      continue;
    }

    if (type === "tool.requested") {
      const turn = requireActive(event);
      if (!turn || !payload || turn.inference || !eventOperationId) continue;
      const call = asPlainRecord(payload.call);
      const expected = turn.tools.find((tool) => tool.call.id === eventOperationId);
      if (
        !call ||
        !expected ||
        expected.requested ||
        call.id !== expected.call.id ||
        call.name !== expected.call.name ||
        !jsonEqual(call.arguments, expected.call.arguments)
      ) {
        addEventFinding(add, event, "TOOL_REQUEST_MISMATCH", "Tool request does not match a unique call declared by the preceding assistant message.");
        continue;
      }
      expected.requested = true;
      seenOperations.add(eventOperationId);
      counts.toolOperations += 1;
      continue;
    }

    if (type === "tool.approved" || type === "tool.denied") {
      const turn = requireActive(event);
      if (!turn || !payload || !eventOperationId) continue;
      const tool = turn.tools.find((candidate) => candidate.call.id === eventOperationId);
      if (
        !tool ||
        !tool.requested ||
        tool.decision ||
        payload.callId !== tool.call.id ||
        payload.name !== tool.call.name
      ) {
        addEventFinding(add, event, "TOOL_DECISION_INVALID", "Tool decision is duplicated or does not match a requested call.");
        continue;
      }
      tool.decision = type === "tool.approved" ? "approved" : "denied";
      if (type === "tool.approved") {
        const issue = approvalProvenanceIssue(payload.approval, effectiveApprovalMode);
        if (issue) addEventFinding(add, event, "TOOL_APPROVAL_PROVENANCE_INVALID", issue);
      }
      if (type === "tool.denied") {
        if (typeof payload.content !== "string") {
          addEventFinding(add, event, "TOOL_DENIAL_INVALID", "Tool denial lacks its canonical tool-message content.");
        } else {
          messages.push({ role: "tool", toolCallId: tool.call.id, content: payload.content });
        }
        tool.terminal = "denied";
        counts.terminalToolOperations += 1;
      }
      continue;
    }

    if (type === "tool.resulted" || type === "tool.failed") {
      const turn = requireActive(event);
      if (!turn || !payload || !eventOperationId) continue;
      const tool = turn.tools.find((candidate) => candidate.call.id === eventOperationId);
      if (
        !tool ||
        tool.decision !== "approved" ||
        tool.terminal ||
        payload.callId !== tool.call.id ||
        payload.name !== tool.call.name ||
        typeof payload.content !== "string"
      ) {
        addEventFinding(add, event, "TOOL_TERMINAL_INVALID", "Tool terminal is duplicated, unapproved, or does not match its request.");
        continue;
      }
      if (type === "tool.resulted" && typeof payload.isError !== "boolean") {
        addEventFinding(add, event, "TOOL_RESULT_INVALID", "Tool result must include an explicit isError boolean.");
      }
      tool.terminal = type === "tool.resulted" ? "resulted" : "failed";
      counts.terminalToolOperations += 1;
      messages.push({ role: "tool", toolCallId: tool.call.id, content: payload.content });
      continue;
    }

    if (type === "turn.completed") {
      const turn = requireActive(event);
      if (!turn || !payload) continue;
      if (
        eventOperationId ||
        turn.inference ||
        turn.tools.some((tool) => !tool.terminal) ||
        !turn.finalAssistant ||
        payload.responseDigest !== turn.finalAssistant.responseDigest ||
        payload.receiptId !== turn.finalAssistant.receiptId
      ) {
        addEventFinding(add, event, "TURN_COMPLETION_INVALID", "Turn completed without a matching final assistant, receipt, or fully terminal operations.");
      }
      turn.terminal = "completed";
      counts.completedTurns += 1;
      active = undefined;
      continue;
    }

    if (type === "turn.failed" || type === "turn.cancelled") {
      const turn = requireActive(event);
      if (!turn || !payload) continue;
      if (eventOperationId || typeof payload.error !== "string") {
        addEventFinding(add, event, "TURN_TERMINAL_INVALID", "Failed or cancelled turn has invalid terminal metadata.");
      }
      const unresolved = Boolean(turn.inference) || turn.tools.some((tool) => !tool.terminal);
      if (unresolved) {
        addEventFinding(add, event, "OPERATION_OUTCOME_UNKNOWN", "Turn terminated with an operation whose durable outcome is unknown.", "completeness", "warning");
      }
      turn.terminal = type === "turn.failed" ? "failed" : "cancelled";
      if (type === "turn.failed") counts.failedTurns += 1;
      else counts.cancelledTurns += 1;
      active = undefined;
      /*
       * This terminal changes history, not just turn state. Failed turns and
       * no-work cancellations disappear from future provider context; a
       * cancellation with completed tools becomes a checkpoint plus only the
       * work that actually landed. Reproject now so the next inference digest
       * is checked against the same history the runtime will send.
       */
      reprojectMessagesThrough(index, false);
      lastContextMessage = undefined;
    }
  }

  if (!sawCreation) {
    add("SESSION_CREATION_MISSING", "protocol", "Journal has no canonical session.created event.");
  } else if (projectedTitle !== session.title) {
    add("SESSION_TITLE_SNAPSHOT_MISMATCH", "manifest", "The title projected from creation and rename events differs from the session record.", undefined, "warning");
  }
  if (session.manifest.lineage && !sawForkContext) {
    add("FORK_CONTEXT_SEED_MISSING", "protocol", "A fork manifest has no verified destination context-seed event.");
  }
  if (active) {
    add("TURN_INCOMPLETE", "completeness", `Turn ${active.id} has no durable terminal event.`, { turnId: active.id, operationId: active.inference?.operationId }, "warning");
  }
  if (activeLocal) {
    add("LOCAL_COMMAND_INCOMPLETE", "completeness", `Client-only local command ${activeLocal.turnId} has no durable terminal event.`, { turnId: activeLocal.turnId, operationId: activeLocal.operationId });
  }
  return counts;
}

function summaryMatchesContextPolicy(
  summary: NonNullable<ReturnType<typeof canonicalContextSummary>>,
  manifest: SessionManifest,
  priorEvents: readonly DurableEvent[],
  effectiveModel: string,
  effectiveContextPolicy: SessionManifest["contextPolicy"],
): boolean {
  const canonical = canonicalSessionContextPolicy(effectiveContextPolicy);
  if (!canonical) return false;
  if (
    summary.contextWindowTokens !== canonical.contextWindowTokens ||
    summary.thresholdBasisPoints !== canonical.compression.thresholdBasisPoints ||
    summary.targetRatioBasisPoints !== canonical.compression.targetRatioBasisPoints ||
    // Both free-text bodies, not just the delta: a compacted tier is written by
    // the same summarizer under the same cap, and one that is larger than the
    // pinned budget was not produced by this session's policy. Bounding only
    // the delta leaves the tier capped at the 64 KiB hard ceiling, several
    // times the pinned budget, and it rides into every future prompt.
    !summaryBodiesWithinPolicy(summary, canonical.compression.maxSummaryDeltaBytes) ||
    summary.estimatedTokensBefore / summary.contextWindowTokens < summary.thresholdBasisPoints / 10_000 ||
    priorEvents.filter((event) =>
      event.type === "turn.completed" && event.sequence > summary.sourceEndSequence
    ).length !== canonical.compression.preserveRecentTurns
  ) return false;
  const summarizer = canonical.compression.summarizer;
  if (!compactionMatchesContextPolicy(summary.compaction, summarizer, manifest, effectiveModel)) return false;
  if (summarizer.mode === "extractive-fallback") {
    return summary.summaryMethod === "extractive-fallback-v1" &&
      summary.summarizerProvenance === undefined &&
      summary.summarizerAttempt === undefined;
  }
  if (summary.summaryMethod === "summarizer-port-v1") {
    return summary.summarizerId === summarizer.adapterId &&
      provenanceMatchesContextPolicy(summary.summarizerProvenance, summarizer.adapterId, manifest, effectiveModel);
  }
  return summarizer.onFailure === "extractive-fallback" &&
    summary.summaryMethod === "extractive-fallback-v1" &&
    summary.summarizerAttempt?.summarizerId === summarizer.adapterId;
}

/**
 * The compacted tier gets the same cross-check the delta gets. Without it a
 * fabricated tier provenance only has to be internally self-consistent — its
 * `responseDigest` matching its own body — to pass replay, while naming an
 * adapter, provider, model, or posture this session never pinned. The tier
 * stands in for the entire start of the conversation, so it is the last place
 * an unchecked label belongs.
 */
function compactionMatchesContextPolicy(
  compaction: NonNullable<ReturnType<typeof canonicalContextSummary>>["compaction"],
  summarizer: NonNullable<ReturnType<typeof canonicalSessionContextPolicy>>["compression"]["summarizer"],
  manifest: SessionManifest,
  effectiveModel: string,
): boolean {
  if (!compaction) return true;
  if (summarizer.mode === "extractive-fallback") {
    // No summarizer was pinned, so no tier this session wrote can claim one.
    return compaction.method === "extractive-fallback-v1" &&
      compaction.provenance === undefined &&
      compaction.attempt === undefined;
  }
  if (compaction.method === "summarizer-port-v1") {
    return compaction.attempt === undefined &&
      provenanceMatchesContextPolicy(compaction.provenance, summarizer.adapterId, manifest, effectiveModel);
  }
  // An extractive tier under a summarizer policy is only legitimate when the
  // policy permits the fallback and the commitment records which summarizer
  // failed, exactly as the delta must.
  return summarizer.onFailure === "extractive-fallback" &&
    compaction.provenance === undefined &&
    compaction.attempt?.summarizerId === summarizer.adapterId;
}

function provenanceMatchesContextPolicy(
  provenance: ContextSummaryProvenance | undefined,
  adapterId: string,
  manifest: SessionManifest,
  effectiveModel: string = manifest.model,
): boolean {
  return provenance?.adapterId === adapterId &&
    sessionInferenceProviderIdMatches(manifest, provenance.providerId) &&
    provenance.model === effectiveModel &&
    (manifest.securityPosture === undefined || provenance.posture === manifest.securityPosture);
}

function parseToolCalls(
  value: unknown,
  event: DurableEvent,
  add: AddFinding,
): ToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    addEventFinding(add, event, "TOOL_CALLS_INVALID", "Assistant toolCalls must be an array.");
    return [];
  }
  const calls: ToolCall[] = [];
  for (const candidate of value) {
    const call = asPlainRecord(candidate);
    if (
      !call ||
      !boundedString(call.id, 512) ||
      !boundedString(call.name, 256) ||
      !inspectJson(call.arguments, DEFAULT_LIMITS).valid
    ) {
      addEventFinding(add, event, "TOOL_CALL_INVALID", "Assistant declared an invalid tool call.");
      continue;
    }
    calls.push(call as unknown as ToolCall);
  }
  return calls;
}

/**
 * Whose request this trace receipt belongs to.
 *
 * A naming inference is not a turn step, so identity is the only common
 * property the audit can check there. A final assistant event also validates
 * request and response digests below.
 */
function receiptIdentityMatches(
  receipt: Record<string, unknown> | undefined,
  session: SessionRecord,
  turnId: string,
  effectiveModel: string = session.manifest.model,
): boolean {
  return Boolean(
    receipt
    && receipt.version === 1
    && boundedString(receipt.receiptId, 2_048)
    && receipt.sessionId === session.id
    && receipt.turnId === turnId
    && sessionInferenceProviderIdMatches(session.manifest, receipt.provider)
    && (receipt.model === undefined || receipt.model === effectiveModel)
    && (receipt.requestDigest === undefined || DIGEST_PATTERN.test(String(receipt.requestDigest)))
    && (receipt.responseDigest === undefined || DIGEST_PATTERN.test(String(receipt.responseDigest))),
  );
}

function validateReceipt(
  value: unknown,
  session: SessionRecord,
  turn: TurnState,
  responseDigest: string,
  event: DurableEvent,
  add: AddFinding,
  effectiveModel: string,
): string | undefined {
  const receipt = asPlainRecord(value);
  const receiptId = boundedString(receipt?.receiptId, 2_048);
  if (!receiptIdentityMatches(receipt, session, turn.id, effectiveModel)) {
    addEventFinding(add, event, "RECEIPT_IDENTITY_MISMATCH", "Trace receipt does not match the session, turn, provider, model, or digest shape.", "trace");
    return receiptId;
  }
  if (receipt?.requestDigest !== turn.inference?.requestDigest || receipt?.responseDigest !== responseDigest) {
    addEventFinding(add, event, "RECEIPT_BINDING_MISMATCH", "Trace receipt request/response digests do not match the audited turn.", "trace");
  }
  return receiptId;
}

function finishReport(args: {
  checkedAt?: string;
  sessionId: string;
  session: SessionRecord | undefined;
  events: readonly DurableEvent[];
  findings: SessionAuditFinding[];
  counts: SessionAuditReport["counts"];
  anchor?: TrustedJournalHead;
}): SessionAuditReport {
  let anchorStatus: SessionAuditReport["anchor"]["status"] = "not-supplied";
  if (args.anchor) {
    const actualSequence = args.session?.headSequence ?? args.events.at(-1)?.sequence ?? 0;
    const actualDigest = args.session?.headDigest ?? args.events.at(-1)?.digest ?? "genesis";
    anchorStatus = args.anchor.sequence === actualSequence && args.anchor.digest === actualDigest ? "matched" : "mismatched";
    if (anchorStatus === "mismatched") {
      args.findings.push(Object.freeze({
        code: "TRUSTED_HEAD_MISMATCH",
        severity: "error",
        category: "anchor",
        message: "Journal head does not match the separately supplied trusted commitment.",
      }));
    }
  }

  const categoryPasses = (category: SessionAuditCategory) =>
    !args.findings.some((finding) => finding.severity === "error" && finding.category === category);
  const complete = !args.findings.some((finding) => finding.category === "completeness");
  const invalid = args.findings.some((finding) => finding.severity === "error");
  const last = args.events.at(-1);
  const report: SessionAuditReport = {
    version: 1,
    checkedAt: args.checkedAt ?? new Date().toISOString(),
    sessionId: args.sessionId,
    status: invalid ? "invalid" : complete ? "verified" : "incomplete",
    authenticity: "not-proven",
    anchor: {
      status: anchorStatus,
      ...(args.anchor ? { source: args.anchor.source.slice(0, 512) } : {}),
    },
    commitment: {
      sequence: args.session?.headSequence ?? last?.sequence ?? 0,
      digest: args.session?.headDigest ?? last?.digest ?? "genesis",
    },
    checks: {
      schema: categoryPasses("schema"),
      chain: categoryPasses("chain") && categoryPasses("anchor"),
      manifest: categoryPasses("manifest"),
      protocol: categoryPasses("protocol"),
      traceBindings: categoryPasses("trace"),
      complete,
    },
    counts: Object.freeze({ ...args.counts }),
    findings: Object.freeze([...args.findings]),
  };
  return deepFreeze(report);
}

function emptyCounts(): {
  events: number;
  turns: number;
  completedTurns: number;
  failedTurns: number;
  cancelledTurns: number;
  toolOperations: number;
  terminalToolOperations: number;
  localCommands: number;
  terminalLocalCommands: number;
  shellRecords: number;
  humanIntentDecisions: number;
  humanIntentAllowed: number;
  unknownEvents: number;
} {
  return {
    events: 0,
    turns: 0,
    completedTurns: 0,
    failedTurns: 0,
    cancelledTurns: 0,
    toolOperations: 0,
    terminalToolOperations: 0,
    localCommands: 0,
    terminalLocalCommands: 0,
    shellRecords: 0,
    humanIntentDecisions: 0,
    humanIntentAllowed: 0,
    unknownEvents: 0,
  };
}

function isDurableEventShape(value: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(value.version) &&
    value.version === 1 &&
    !!boundedString(value.eventId, 512) &&
    !!boundedString(value.sessionId, 512) &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) > 0 &&
    !!boundedString(value.recordedAt, 128) &&
    !!boundedString(value.previousDigest, 128) &&
    !!boundedString(value.digest, 128) &&
    !!boundedString(value.type, 128) &&
    (value.turnId === undefined || !!boundedString(value.turnId, 512)) &&
    (value.operationId === undefined || !!boundedString(value.operationId, 512)) &&
    Object.prototype.hasOwnProperty.call(value, "payload")
  );
}

function inspectJson(
  value: unknown,
  limits: Pick<SessionAuditLimits, "maxEventBytes" | "maxJsonDepth" | "maxJsonNodes">,
): { valid: true } | { valid: false; message: string } {
  let nodes = 0;
  let stringBytes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (candidate: unknown, depth: number): string | undefined => {
    nodes += 1;
    if (nodes > limits.maxJsonNodes) return `JSON value exceeds the ${limits.maxJsonNodes}-node limit.`;
    if (depth > limits.maxJsonDepth) return `JSON value exceeds the ${limits.maxJsonDepth}-level depth limit.`;
    if (candidate === null || typeof candidate === "boolean") return undefined;
    if (typeof candidate === "string") {
      stringBytes += encoder.encode(candidate).byteLength;
      return stringBytes <= limits.maxEventBytes
        ? undefined
        : `JSON string content exceeds the ${limits.maxEventBytes}-byte event limit.`;
    }
    if (typeof candidate === "number") return Number.isFinite(candidate) ? undefined : "JSON numbers must be finite.";
    if (typeof candidate !== "object") return "Value is not JSON-compatible.";
    if (ancestors.has(candidate)) return "JSON value contains a cycle.";
    const record = asPlainRecord(candidate);
    if (!Array.isArray(candidate) && !record) return "JSON objects must be plain data objects without accessors.";
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      for (const child of candidate) {
        const problem = visit(child, depth + 1);
        if (problem) return problem;
      }
    } else {
      for (const child of Object.values(record!)) {
        const problem = visit(child, depth + 1);
        if (problem) return problem;
      }
    }
    ancestors.delete(candidate);
    return undefined;
  };

  const problem = visit(value, 0);
  return problem ? { valid: false, message: problem } : { valid: true };
}

/**
 * Provenance is the whole answer to "who let this run", so the audit has to ask.
 *
 * It was journaled from the day approval modes shipped and read by nobody: the
 * reducer's per-event required-field table never mentioned it, so an approval
 * carrying `approval: null` verified clean, and one claiming Full Access
 * authority inside a session pinned to ask-first verified clean too. A field no
 * side of the contract validates is not evidence — it is decoration that looks
 * like a supported record, which is worse than an explicit unknown.
 *
 * The mode is compared against whichever mode was in force at this point in
 * the chain — the manifest's pin as amended by every `session.approval-policy-
 * changed` record before it. A v1 profile pin, or a session with no profile at
 * all, pinned no mode, so there is nothing to disagree with and only the shape
 * is checked.
 */
function approvalProvenanceIssue(value: unknown, inForce: string | undefined): string | undefined {
  const approval = asPlainRecord(value);
  if (!approval) return "An approval must carry the provenance record that authorized it.";
  if (!APPROVAL_SOURCES.has(String(approval.source))) return "Approval provenance names no known authority source.";
  if (!APPROVAL_MODES.has(String(approval.mode))) return "Approval provenance names no known approval mode.";
  if (inForce && approval.mode !== inForce) {
    return "Approval provenance claims an approval mode that was not in force when it ran.";
  }
  return undefined;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => "get" in descriptor || "set" in descriptor)) return undefined;
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
    ? value
    : undefined;
}

function jsonEqual(left: unknown, right: JsonValue): boolean {
  if (!inspectJson(left, DEFAULT_LIMITS).valid) return false;
  return stableStringify(left as JsonValue) === stableStringify(right);
}

function eventLocation(value: Partial<DurableEvent> | Record<string, unknown>): {
  sequence?: number;
  eventId?: string;
  turnId?: string;
  operationId?: string;
} {
  return {
    ...(Number.isSafeInteger(value.sequence) ? { sequence: value.sequence as number } : {}),
    ...(typeof value.eventId === "string" ? { eventId: value.eventId } : {}),
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    ...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
  };
}
