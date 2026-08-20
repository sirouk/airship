import { deepFreeze } from "../core/freeze";
import { CONVERSATION_NAMED_EVENT_TYPE } from "../core/contracts";
import type {
  SecurityPosture,
  SessionManifest,
  SessionProfileBinding,
} from "../core/contracts";
import type { DurableEvent, SessionRecord } from "../core/journal";
import {
  assertValidSessionInferenceBinding,
  canonicalSessionInferenceProviderId,
  historicalInferenceBindingMayUpgrade,
  inferenceBindingsMatch,
  sessionInferenceProviderIdMatches,
} from "../core/inference-binding";
import { enforcedMemoryScope } from "../profiles/domain";
import type { ConversationReceipt } from "../core/conversation-receipt";

const CAPABILITY_TIERS = new Set(["web-baseline", "web-enhanced", "native", "remote-heavy"]);

function isSecurityPosture(value: unknown): value is SecurityPosture {
  return value === "local" || value === "plaintext-remote";
}
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const TERMINAL_TURN_TYPES = new Set(["turn.completed", "turn.cancelled", "turn.failed"]);
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const HAS_UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export type SessionInspectionLimits = Readonly<{
  maxEvents: number;
  maxMessages: number;
  maxMessageChars: number;
  maxTranscriptChars: number;
}>;

export const DEFAULT_SESSION_INSPECTION_LIMITS: SessionInspectionLimits = Object.freeze({
  maxEvents: 20_000,
  maxMessages: 500,
  maxMessageChars: 64 * 1024,
  maxTranscriptChars: 512 * 1024,
});

export type SessionHistoryIssue = Readonly<{
  code: string;
  severity: "warning" | "error";
  message: string;
  sequence?: number;
  turnId?: string;
}>;

export type SessionHistoryAssessment = Readonly<{
  status: "consistent" | "incomplete" | "suspect";
  label: "Locally consistent" | "Unfinished" | "Observations recorded" | "Needs review";
  verification: Readonly<{
    scope: "structural-linkage-only";
    digestRecomputed: false;
    authenticity: "not-proven";
  }>;
  checkedEvents: number;
  totalEvents: number;
  turnCount: number;
  completedTurnCount: number;
  issues: readonly SessionHistoryIssue[];
}>;

export type MaterializedSessionMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
  turnId?: string;
  sequence: number;
  recordedAt?: string;
  phase: "request" | "tool-call" | "response";
  turnStatus: "completed" | "failed" | "cancelled" | "incomplete";
  providerContext: "included" | "excluded";
  truncated: boolean;
  /** Present only when a bounded receipt is identity-bound to this assistant event. */
  receipt?: ConversationReceipt;
}>;

export type SessionLifecycle = Readonly<{
  state: "ready" | "running" | "completed" | "failed" | "cancelled";
  label: "Ready" | "Turn in progress" | "Last turn completed" | "Last turn failed" | "Last turn cancelled";
  turnId?: string;
  sequence: number;
  recordedAt?: string;
}>;

export const READY_SESSION_LIFECYCLE: SessionLifecycle = Object.freeze({
  state: "ready",
  label: "Ready",
  sequence: 0,
});

export type SessionMaterialization = Readonly<{
  messages: readonly MaterializedSessionMessage[];
  /** Ordered, bounded receipts recovered from final assistant events in this session only. */
  receipts: readonly ConversationReceipt[];
  lifecycle: SessionLifecycle;
  omittedMessages: number;
  ignoredEvents: number;
  transcriptChars: number;
  truncated: boolean;
}>;

export type SessionPostureBinding = Readonly<{
  basis: "manifest" | "event-observation" | "not-recorded";
  value?: SecurityPosture;
  observedValues: readonly SecurityPosture[];
  mixed: boolean;
}>;

/**
 * The boundaries a profile pin actually governs a running turn with.
 *
 * Separated from the pin's identity (`profileRevision`) and its presentation
 * (`themeId`/`themeDigest`) because only these decide what a resumed turn does:
 * which workspace it may touch, which memory it may read, and whether it asks
 * before acting. A v1 pin predates the fields and carries none of them.
 */
export type SessionProfileGovernance = Readonly<{
  workspaceBinding?: string;
  memoryScope?: string;
  approvalMode?: string;
}>;

export type SessionPinnedProfile = Readonly<{
  profileId: string;
  profileRevision: string;
  themeId: string;
  themeDigest: string;
  skillSetDigest: string;
  resolutionDigest: string;
  skills: readonly Readonly<{ skillId: string; digest: string; promptOrder: number }>[];
  skillCount: number;
  skillsTruncated: boolean;
} & SessionProfileGovernance>;

export type SessionPins = Readonly<{
  protocolVersion: number;
  providerId: string;
  model: string;
  inferenceBinding?: SessionManifest["inferenceBinding"];
  /** Raw provider-as-transport ID retained only to validate a v1→v2 bridge. */
  legacyInferenceTransportId?: string;
  workspaceId: string;
  capabilityTier: SessionManifest["capabilityTier"];
  systemPromptDigest: string;
  toolManifestDigest: string;
  posture: SessionPostureBinding;
  profile?: SessionPinnedProfile;
  lineage?: Readonly<{
    sourceSessionId: string;
    sourceHeadSequence: number;
    sourceHeadDigest: string;
    forkedAt: string;
  }>;
}>;

export type ActiveSessionRuntime = Readonly<{
  providerId: string;
  model: string;
  inferenceBinding?: SessionManifest["inferenceBinding"];
  posture: SecurityPosture;
  toolManifestDigest: string;
  workspaceId?: string;
  profile?: Readonly<{
    profileId: string;
    profileRevision: string;
    themeDigest: string;
    skillSetDigest: string;
    resolutionDigest: string;
  } & SessionProfileGovernance>;
}>;

export type SessionCompatibilityReason = Readonly<{
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}>;

export type SessionResumeCompatibility = Readonly<{
  action: "resume" | "fork-required" | "blocked";
  label: "Ready to resume" | "Fork required" | "Resume blocked";
  reasons: readonly SessionCompatibilityReason[];
}>;

export type SessionListSort = "updated-desc" | "created-desc" | "title-asc";

export type SessionListQuery = Readonly<{
  search?: string;
  providerId?: string;
  model?: string;
  profileId?: string | "unbound";
  sort?: SessionListSort;
  offset?: number;
  limit?: number;
}>;

export type SessionListItem = Readonly<{
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  headSequence: number;
  headDigest: string;
  providerId: string;
  model: string;
  workspaceId: string;
  capabilityTier: SessionManifest["capabilityTier"];
  declaredPosture?: SecurityPosture;
  profileId?: string;
  profileRevision?: string;
  profileResolutionDigest?: string;
  sourceSessionId?: string;
  /**
   * Where in the source conversation this branch was cut — the selected fork
   * boundary, not the source's later head.
   *
   * The summary carried only `sourceSessionId`, so the branch could name its
   * parent but not the question it diverged at. That made the downward
   * "Alternates" list unreadable: three retries of one turn and three
   * unrelated branches of three different turns rendered identically. Both
   * lineage fields come from the same manifest commitment and are validated
   * together, so a row that states one can always state the other.
   */
  sourceHeadSequence?: number;
}>;

export type SessionListPage = Readonly<{
  items: readonly SessionListItem[];
  total: number;
  rejected: number;
  offset: number;
  limit: number;
  facets: Readonly<{
    providers: readonly string[];
    models: readonly string[];
    profiles: readonly string[];
  }>;
}>;

export function materializeSessionMessages(
  events: readonly DurableEvent[],
  limitOverrides: Partial<SessionInspectionLimits> = {},
  expectedSessionId?: string,
): SessionMaterialization {
  const limits = resolveLimits(limitOverrides);
  const start = Math.max(0, events.length - limits.maxEvents);
  const candidates: Array<Omit<MaterializedSessionMessage, "content" | "truncated"> & { raw: string }> = [];
  const receiptCandidates: ConversationReceipt[] = [];
  const boundedEvents = events.slice(start);
  const scopedBoundedEvents = expectedSessionId
    ? boundedEvents.filter((event) => event.sessionId === expectedSessionId)
    : boundedEvents;
  const terminalTurns = terminalTurnStates(scopedBoundedEvents);
  const lifecycle = advanceSessionLifecycle(
    READY_SESSION_LIFECYCLE,
    scopedBoundedEvents,
  );
  let ignoredEvents = start;

  for (let index = start; index < events.length; index += 1) {
    const event = events[index]!;
    if (expectedSessionId && event.sessionId !== expectedSessionId) {
      ignoredEvents += 1;
      continue;
    }
    const payload = plainRecord(event.payload);
    if (event.type === "turn.requested") {
      const turnStatus = materializedTurnStatus(event.turnId, terminalTurns);
      if (!payload || typeof payload.content !== "string" || payload.content.length === 0) {
        ignoredEvents += 1;
        continue;
      }
      candidates.push({
        id: safeIdentifier(event.eventId, `event-${String(event.sequence)}`)!,
        role: "user",
        raw: payload.content,
        ...(safeIdentifier(event.turnId) ? { turnId: event.turnId } : {}),
        sequence: safeSequence(event.sequence),
        ...(safeDate(event.recordedAt) ? { recordedAt: event.recordedAt } : {}),
        phase: "request",
        turnStatus,
        providerContext: providerContextDisposition(turnStatus),
      });
      continue;
    }
    if (event.type === "assistant.completed") {
      const turnStatus = materializedTurnStatus(event.turnId, terminalTurns);
      const message = plainRecord(payload?.message);
      if (!message || message.role !== "assistant" || typeof message.content !== "string" || message.content.length === 0) {
        ignoredEvents += 1;
        continue;
      }
      const receipt = turnStatus === "completed" ? boundedConversationReceipt(payload?.receipt, event) : undefined;
      if (receipt) receiptCandidates.push(receipt);
      candidates.push({
        id: safeIdentifier(event.eventId, `event-${String(event.sequence)}`)!,
        role: "assistant",
        raw: message.content,
        ...(safeIdentifier(event.turnId) ? { turnId: event.turnId } : {}),
        sequence: safeSequence(event.sequence),
        ...(safeDate(event.recordedAt) ? { recordedAt: event.recordedAt } : {}),
        phase: Array.isArray(message.toolCalls) && message.toolCalls.length > 0 ? "tool-call" : "response",
        turnStatus,
        providerContext: providerContextDisposition(turnStatus),
        ...(receipt ? { receipt } : {}),
      });
      continue;
    }
    if (event.type === CONVERSATION_NAMED_EVENT_TYPE) {
      /*
       * Naming writes its own local trace record beside the conversation, so
       * its receipt belongs in the same recovered chain as turn receipts when
       * the trace shape still matches this session and turn. It contributes no
       * transcript row because nobody said anything; it is counted as an
       * ignored event for message purposes, and the transcript renders it as a
       * marker instead.
       */
      const receipt = boundedConversationReceipt(payload?.receipt, event);
      if (receipt) receiptCandidates.push(receipt);
      ignoredEvents += 1;
      continue;
    }
    if (event.type === "turn.completed") {
      ignoredEvents += 1;
      continue;
    }
    if (event.type === "turn.failed") {
      ignoredEvents += 1;
      continue;
    }
    if (event.type === "turn.cancelled") {
      ignoredEvents += 1;
      continue;
    }
    ignoredEvents += 1;
  }

  const selected = candidates.slice(-limits.maxMessages);
  const messages: MaterializedSessionMessage[] = [];
  let remaining = limits.maxTranscriptChars;
  let omittedForBudget = 0;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const candidate = selected[index]!;
    if (remaining <= 0) {
      omittedForBudget += index + 1;
      break;
    }
    const normalized = candidate.raw.replace(UNSAFE_CONTROLS, "�");
    const maximum = Math.min(limits.maxMessageChars, remaining);
    const content = truncateSafely(normalized, maximum);
    if (!content) {
      omittedForBudget += 1;
      continue;
    }
    messages.unshift(Object.freeze({
      id: candidate.id,
      role: candidate.role,
      content,
      ...(candidate.turnId ? { turnId: candidate.turnId } : {}),
      sequence: candidate.sequence,
      ...(candidate.recordedAt ? { recordedAt: candidate.recordedAt } : {}),
      phase: candidate.phase,
      turnStatus: candidate.turnStatus,
      providerContext: candidate.providerContext,
      truncated: content !== candidate.raw,
      ...(candidate.receipt ? { receipt: candidate.receipt } : {}),
    }));
    remaining -= content.length;
  }

  const omittedMessages = candidates.length - selected.length + omittedForBudget;
  return Object.freeze({
    messages: Object.freeze(messages),
    receipts: Object.freeze(receiptCandidates.slice(-limits.maxMessages)),
    lifecycle,
    omittedMessages,
    ignoredEvents,
    transcriptChars: limits.maxTranscriptChars - remaining,
    truncated: start > 0 || omittedMessages > 0 || messages.some((message) => message.truncated),
  });
}

function terminalTurnStates(
  events: readonly DurableEvent[],
): ReadonlyMap<string, "completed" | "failed" | "cancelled"> {
  const states = new Map<string, "completed" | "failed" | "cancelled">();
  for (const event of events) {
    const turnId = safeIdentifier(event.turnId);
    if (!turnId) continue;
    if (event.type === "turn.completed") states.set(turnId, "completed");
    if (event.type === "turn.failed") states.set(turnId, "failed");
    if (event.type === "turn.cancelled") states.set(turnId, "cancelled");
  }
  return states;
}

function materializedTurnStatus(
  turnId: unknown,
  states: ReadonlyMap<string, "completed" | "failed" | "cancelled">,
): MaterializedSessionMessage["turnStatus"] {
  const safeTurnId = safeIdentifier(turnId);
  return safeTurnId ? states.get(safeTurnId) ?? "incomplete" : "incomplete";
}

function providerContextDisposition(
  status: MaterializedSessionMessage["turnStatus"],
): MaterializedSessionMessage["providerContext"] {
  return status === "failed" || status === "cancelled" ? "excluded" : "included";
}

export function advanceSessionLifecycle(
  current: SessionLifecycle,
  events: readonly DurableEvent[],
): SessionLifecycle {
  let lifecycle = current;
  for (const event of events) {
    if (event.type === "turn.requested") {
      lifecycle = lifecycleForEvent(event, "running", "Turn in progress");
    } else if (event.type === "turn.completed") {
      lifecycle = lifecycleForEvent(event, "completed", "Last turn completed");
    } else if (event.type === "turn.failed") {
      lifecycle = lifecycleForEvent(event, "failed", "Last turn failed");
    } else if (event.type === "turn.cancelled") {
      lifecycle = lifecycleForEvent(event, "cancelled", "Last turn cancelled");
    }
  }
  return lifecycle;
}

function lifecycleForEvent(
  event: DurableEvent,
  state: SessionLifecycle["state"],
  label: SessionLifecycle["label"],
): SessionLifecycle {
  return Object.freeze({
    state,
    label,
    ...(safeIdentifier(event.turnId) ? { turnId: event.turnId } : {}),
    sequence: safeSequence(event.sequence),
    ...(safeDate(event.recordedAt) ? { recordedAt: event.recordedAt } : {}),
  });
}

/**
 * Materialization is a display boundary, not a trust upgrade. Recover a
 * receipt only when its bounded public shape and session/turn identity match
 * the durable assistant event. Full binding verification remains the audit's
 * responsibility.
 */
function boundedConversationReceipt(value: unknown, event: DurableEvent): ConversationReceipt | undefined {
  const receipt = plainRecord(value);
  if (!receipt || receipt.version !== 1) return undefined;
  // Historical v1 receipts predate explicit origin metadata. Treat their
  // locally stored trace as local and never infer attestation.
  const origin = receipt.origin === undefined ? "local" : receipt.origin;
  const attestation = receipt.attestation === undefined ? "none" : receipt.attestation;
  const receiptId = boundedText(receipt.receiptId, 2_048);
  const sessionId = safeIdentifier(receipt.sessionId);
  const turnId = safeIdentifier(receipt.turnId);
  const createdAt = safeDate(receipt.createdAt) ? receipt.createdAt : undefined;
  const provider = boundedText(receipt.provider, 256);
  const model = receipt.model === undefined ? undefined : boundedText(receipt.model, 512);
  const requestDigest = receipt.requestDigest === undefined
    ? undefined
    : DIGEST_PATTERN.test(String(receipt.requestDigest)) ? String(receipt.requestDigest) : undefined;
  const responseDigest = receipt.responseDigest === undefined
    ? undefined
    : DIGEST_PATTERN.test(String(receipt.responseDigest)) ? String(receipt.responseDigest) : undefined;
  const startedAt = receipt.startedAt === undefined
    ? undefined
    : safeDate(receipt.startedAt) ? receipt.startedAt : undefined;
  const completedAt = receipt.completedAt === undefined
    ? undefined
    : safeDate(receipt.completedAt) ? receipt.completedAt : undefined;
  const timings = receipt.timings === undefined ? undefined : boundedTraceTimings(receipt.timings);
  const toolCalls = receipt.toolCalls === undefined ? undefined : boundedTraceToolCalls(receipt.toolCalls);
  if (
    (origin !== "local" && origin !== "provider") ||
    attestation !== "none" ||
    !receiptId ||
    !sessionId ||
    !turnId ||
    sessionId !== event.sessionId ||
    turnId !== event.turnId ||
    !createdAt ||
    !provider ||
    (receipt.model !== undefined && !model) ||
    (receipt.requestDigest !== undefined && !requestDigest) ||
    (receipt.responseDigest !== undefined && !responseDigest) ||
    (receipt.startedAt !== undefined && !startedAt) ||
    (receipt.completedAt !== undefined && !completedAt) ||
    (receipt.timings !== undefined && !timings) ||
    (receipt.toolCalls !== undefined && !toolCalls)
  ) return undefined;
  return deepFreeze({
    version: 1,
    origin,
    attestation,
    receiptId,
    sessionId,
    turnId,
    createdAt,
    provider,
    ...(model ? { model } : {}),
    ...(requestDigest ? { requestDigest } : {}),
    ...(responseDigest ? { responseDigest } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(timings ? { timings } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  });
}

function boundedTraceTimings(value: unknown): Readonly<Record<string, number>> | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record);
  if (entries.length > 128) return undefined;
  const bounded: Record<string, number> = {};
  for (const [key, metric] of entries) {
    if (!boundedText(key, 128) || typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) {
      return undefined;
    }
    bounded[key] = metric;
  }
  return deepFreeze(bounded);
}

function boundedTraceToolCalls(
  value: unknown,
): readonly Readonly<{ id: string; name: string }>[] | undefined {
  if (!Array.isArray(value) || value.length > 512) return undefined;
  const bounded: Array<Readonly<{ id: string; name: string }>> = [];
  for (const item of value) {
    const record = plainRecord(item);
    const id = boundedText(record?.id, 512);
    const name = boundedText(record?.name, 512);
    if (!record || !id || !name) return undefined;
    bounded.push(deepFreeze({ id, name }));
  }
  return deepFreeze(bounded);
}

export function assessSessionHistory(
  session: SessionRecord,
  events: readonly DurableEvent[],
  options: Readonly<{
    limits?: Partial<SessionInspectionLimits>;
    snapshotStable?: boolean;
  }> = {},
): SessionHistoryAssessment {
  const limits = resolveLimits(options.limits ?? {});
  const inspected = events.slice(0, limits.maxEvents);
  const issues: SessionHistoryIssue[] = [];
  const eventIds = new Set<string>();
  const turns = new Set<string>();
  const postures = new Set<SecurityPosture>();
  let activeTurn: string | undefined;
  let completedTurns = 0;
  let expectedSequence = 1;
  let expectedPreviousDigest = "genesis";
  let previousTime = Number.NEGATIVE_INFINITY;
  let sawCreation = false;
  let activeSawAssistant = false;

  const add = (issue: SessionHistoryIssue) => issues.push(Object.freeze(issue));
  if (
    (session.manifest.protocolVersion !== 1 && session.manifest.protocolVersion !== 2) ||
    (session.manifest.protocolVersion === 2 &&
      session.manifest.turnContext !== "required" && session.manifest.turnContext !== "disabled") ||
    !boundedText(session.manifest.providerId, 256) ||
    !boundedText(session.manifest.model, 512) ||
    !boundedText(session.manifest.workspaceId, 2_048) ||
    !DIGEST_PATTERN.test(session.manifest.systemPromptDigest) ||
    !DIGEST_PATTERN.test(session.manifest.toolManifestDigest) ||
    !CAPABILITY_TIERS.has(String(session.manifest.capabilityTier)) ||
    (session.manifest.securityPosture !== undefined && !isSecurityPosture(session.manifest.securityPosture))
  ) {
    add({ code: "MANIFEST_BINDING_INVALID", severity: "error", message: "The session manifest has an invalid bounded runtime binding." });
  }
  const inferenceBinding = session.manifest.inferenceBinding;
  let inferenceBindingShapeValid = true;
  try {
    assertValidSessionInferenceBinding(session.manifest);
  } catch {
    inferenceBindingShapeValid = false;
  }
  if (!inferenceBindingShapeValid || (inferenceBinding && (
    (inferenceBinding.version !== 1 && inferenceBinding.version !== 2) ||
    Object.keys(inferenceBinding).length !== (inferenceBinding.version === 2 ? 12 : 10) ||
    (inferenceBinding.version === 2 && (
      !boundedText(inferenceBinding.transportId, 256) ||
      !["openai-responses", "openai-chat-completions", "anthropic-messages", "openai-compatible"].includes(inferenceBinding.protocol)
    )) ||
    !boundedText(inferenceBinding.connectionId, 256) ||
    !Number.isSafeInteger(inferenceBinding.connectionGeneration) ||
    inferenceBinding.connectionGeneration <= 0 ||
    !boundedText(inferenceBinding.providerId, 256) ||
    (inferenceBinding.version === 2 && inferenceBinding.providerId !== session.manifest.providerId) ||
    !boundedText(inferenceBinding.providerLabel, 256) ||
    !Number.isSafeInteger(inferenceBinding.providerRevision) ||
    inferenceBinding.providerRevision <= 0 ||
    !["oauth-pkce", "api-key", "local-none"].includes(inferenceBinding.authMethod) ||
    !(inferenceBinding.version === 1
      ? ["e2ee-attestable", "provider-tls", "loopback-local"]
      : ["provider-tls", "loopback-local"]
    ).includes(inferenceBinding.transportBoundary) ||
    !boundedText(inferenceBinding.modelId, 512) ||
    inferenceBinding.modelId !== session.manifest.model ||
    !Number.isFinite(Date.parse(inferenceBinding.boundAt))
  ))) {
    add({ code: "INFERENCE_BINDING_INVALID", severity: "error", message: "The session manifest has an invalid credential-free inference connection binding." });
  }
  const manifestProfile = session.manifest.profile;
  const workspaceBinding = manifestProfile?.version === 2 ? manifestProfile.workspaceBinding : undefined;
  const v2SiloValid = manifestProfile?.version === 2 &&
    workspaceBinding !== undefined &&
    (workspaceBinding.kind === "active-workspace" ||
      (workspaceBinding.kind === "workspace-id" && boundedText(workspaceBinding.workspaceId, 512) !== undefined)) &&
    ["session", "profile", "workspace"].includes(manifestProfile.memoryScope) &&
    ["ask-first", "auto-approve", "full-access"].includes(manifestProfile.approvalMode);
  if (manifestProfile && (
    (manifestProfile.version !== 1 && manifestProfile.version !== 2) ||
    (manifestProfile.version === 2 && !v2SiloValid) ||
    !boundedText(manifestProfile.profileId, 256) ||
    !DIGEST_PATTERN.test(manifestProfile.profileRevision) ||
    !boundedText(manifestProfile.themeId, 256) ||
    !DIGEST_PATTERN.test(manifestProfile.themeDigest) ||
    !DIGEST_PATTERN.test(manifestProfile.skillSetDigest) ||
    !DIGEST_PATTERN.test(manifestProfile.resolutionDigest) ||
    !Array.isArray(manifestProfile.resolvedSkills) ||
    manifestProfile.resolvedSkills.length > 512 ||
    manifestProfile.resolvedSkills.some((skill) =>
      !boundedText(skill.skillId, 256) ||
      !DIGEST_PATTERN.test(skill.digest) ||
      !Number.isSafeInteger(skill.promptOrder) ||
      skill.promptOrder < 0)
  )) {
    add({ code: "PROFILE_BINDING_INVALID", severity: "error", message: "The manifest profile or resolved skill binding is malformed." });
  }
  const manifestLineage = session.manifest.lineage;
  if (manifestLineage && (
    manifestLineage.version !== 1 ||
    manifestLineage.kind !== "fork" ||
    !boundedText(manifestLineage.sourceSessionId, 512) ||
    !Number.isSafeInteger(manifestLineage.sourceHeadSequence) ||
    manifestLineage.sourceHeadSequence <= 0 ||
    !DIGEST_PATTERN.test(manifestLineage.sourceHeadDigest) ||
    !safeDate(manifestLineage.forkedAt) ||
    manifestLineage.forkedAt !== session.manifest.createdAt
  )) {
    add({ code: "FORK_LINEAGE_INVALID", severity: "error", message: "The immediate ancestor commitment is malformed." });
  }
  if (
    !Number.isSafeInteger(session.headSequence) ||
    session.headSequence < 0 ||
    (session.headSequence === 0 ? session.headDigest !== "genesis" : !DIGEST_PATTERN.test(session.headDigest))
  ) {
    add({ code: "SESSION_HEAD_INVALID", severity: "error", message: "The stored session head has an invalid sequence or digest shape." });
  }
  if (events.length > limits.maxEvents) {
    add({
      code: "INSPECTION_LIMIT_REACHED",
      severity: "warning",
      message: `Only the first ${String(limits.maxEvents)} of ${String(events.length)} events were structurally inspected.`,
    });
  }
  if (options.snapshotStable === false) {
    add({
      code: "SNAPSHOT_CHANGED_DURING_READ",
      severity: "warning",
      message: "The session advanced while it was being read. Refresh before resuming.",
    });
  }
  if (inspected.length === 0 || inspected[0]?.type !== "session.created") {
    add({ code: "SESSION_CREATION_MISSING", severity: "error", message: "The history does not begin with session.created." });
  }

  // The model this session has routed to at this point in its history. The
  // manifest names what the thread was created with; `session.model-changed`
  // is how a continuation addresses newer turns in the same thread.
  let effectiveModel = session.manifest.model;

  for (const event of inspected) {
    const location = {
      ...(Number.isSafeInteger(event.sequence) ? { sequence: event.sequence } : {}),
      ...(safeIdentifier(event.turnId) ? { turnId: event.turnId } : {}),
    };
    if (event.sessionId !== session.id) {
      add({ ...location, code: "CROSS_SESSION_EVENT", severity: "error", message: "An event belongs to a different session." });
    }
    if (event.version !== 1 || !boundedText(event.type, 128) || !DIGEST_PATTERN.test(event.digest) || (event.previousDigest !== "genesis" && !DIGEST_PATTERN.test(event.previousDigest))) {
      add({ ...location, code: "EVENT_SHAPE_INVALID", severity: "error", message: "An event has an invalid protocol version, type, or digest shape." });
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== expectedSequence) {
      add({ ...location, code: "SEQUENCE_GAP", severity: "error", message: `Expected event sequence ${String(expectedSequence)}.` });
    }
    if (event.previousDigest !== expectedPreviousDigest) {
      add({ ...location, code: "LINKAGE_MISMATCH", severity: "error", message: "An event does not reference the preceding stored digest." });
    }
    if (!safeIdentifier(event.eventId)) {
      add({ ...location, code: "EVENT_ID_INVALID", severity: "error", message: "An event ID is missing or unreasonably large." });
    } else if (eventIds.has(event.eventId)) {
      add({ ...location, code: "EVENT_ID_REUSED", severity: "error", message: "An event ID is reused in this session." });
    } else {
      eventIds.add(event.eventId);
    }
    const recorded = Date.parse(event.recordedAt);
    if (!Number.isFinite(recorded)) {
      add({ ...location, code: "EVENT_TIME_INVALID", severity: "error", message: "An event timestamp is invalid." });
    } else if (recorded < previousTime) {
      add({ ...location, code: "EVENT_TIME_REVERSED", severity: "error", message: "An event timestamp moves backward." });
    }
    if (Number.isFinite(recorded)) previousTime = recorded;
    expectedSequence = Number.isSafeInteger(event.sequence) ? event.sequence + 1 : expectedSequence + 1;
    expectedPreviousDigest = typeof event.digest === "string" ? event.digest : "";

    const payload = plainRecord(event.payload);
    if (event.type === "session.created") {
      if (sawCreation || event.sequence !== 1 || event.turnId || event.operationId) {
        add({ ...location, code: "SESSION_CREATION_MALFORMED", severity: "error", message: "session.created must be the first and only creation event." });
      }
      sawCreation = true;
    }
    if (event.type === "turn.requested") {
      if (!safeIdentifier(event.turnId) || event.operationId || !payload || typeof payload.content !== "string") {
        add({ ...location, code: "TURN_REQUEST_MALFORMED", severity: "error", message: "A turn request has malformed identity or content." });
        continue;
      }
      if (activeTurn) {
        add({ ...location, code: "TURN_OVERLAP", severity: "error", message: "A new turn began before the prior turn reached a terminal event." });
      }
      if (turns.has(event.turnId!)) {
        add({ ...location, code: "TURN_ID_REUSED", severity: "error", message: "A turn ID is reused." });
      }
      turns.add(event.turnId!);
      activeTurn = event.turnId;
      activeSawAssistant = false;
      continue;
    }
    if (event.type === "session.model-changed") {
      if (event.turnId || event.operationId || !payload || typeof payload.model !== "string" || !payload.model.trim() || payload.model.length > 256 || !/^[\x20-\x7E]+$/u.test(payload.model)) {
        add({ ...location, code: "MODEL_CHANGE_MALFORMED", severity: "error", message: "A session model change must carry one printable model id outside any turn." });
      } else {
        effectiveModel = payload.model;
      }
      continue;
    }
    if (event.type === "inference.started") {
      const posture = payload?.posture;
      if (!isSecurityPosture(posture)) {
        add({ ...location, code: "POSTURE_INVALID", severity: "error", message: "An inference event has no recognized inference path." });
      } else {
        postures.add(posture);
        if (session.manifest.securityPosture && posture !== session.manifest.securityPosture) {
          add({ ...location, code: "POSTURE_PIN_MISMATCH", severity: "error", message: "Observed inference posture differs from the manifest pin." });
        }
      }
      if (!sessionInferenceProviderIdMatches(session.manifest, payload?.providerId) || payload.model !== effectiveModel) {
        add({ ...location, code: "INFERENCE_BINDING_MISMATCH", severity: "error", message: "An inference event differs from the manifest provider or model." });
      }
    }
    if (event.type === "assistant.completed") {
      const message = plainRecord(payload?.message);
      if (!activeTurn || event.turnId !== activeTurn || !message || message.role !== "assistant" || typeof message.content !== "string") {
        add({ ...location, code: "ASSISTANT_EVENT_MALFORMED", severity: "error", message: "An assistant event does not match the active turn." });
      }
      if (activeTurn && event.turnId === activeTurn && message?.role === "assistant" && typeof message.content === "string") {
        activeSawAssistant = true;
      }
    }
    if (TERMINAL_TURN_TYPES.has(event.type)) {
      if (!activeTurn || event.turnId !== activeTurn || event.operationId) {
        add({ ...location, code: "TURN_TERMINAL_MALFORMED", severity: "error", message: "A terminal event does not match the active turn." });
      } else {
        if (event.type === "turn.completed" && !activeSawAssistant) {
          add({ ...location, code: "TURN_COMPLETION_WITHOUT_ASSISTANT", severity: "error", message: "A completed turn has no matching assistant event." });
        }
        if (event.type === "turn.completed") completedTurns += 1;
        activeTurn = undefined;
        activeSawAssistant = false;
      }
    }
  }

  if (postures.size > 1 && !session.manifest.securityPosture) {
    add({
      code: "POSTURE_CHANGED_WITHOUT_PIN",
      severity: "error",
      message: "The session contains multiple observed postures and no manifest posture pin.",
    });
  }
  if (activeTurn) {
    add({ code: "TURN_INCOMPLETE", severity: "warning", message: "The most recent turn has no durable terminal event.", turnId: activeTurn });
  }
  if (events.length <= limits.maxEvents) {
    const last = inspected.at(-1);
    const sequence = last?.sequence ?? 0;
    const digest = last?.digest ?? "genesis";
    if (session.headSequence !== sequence || session.headDigest !== digest) {
      add({ code: "SESSION_HEAD_MISMATCH", severity: "error", message: "The session record does not match the final event linkage." });
    }
    if (last && session.updatedAt !== last.recordedAt) {
      add({ code: "SESSION_UPDATE_TIME_MISMATCH", severity: "warning", message: "The session update timestamp differs from the final event." });
    }
  }

  const status = issues.some((issue) => issue.severity === "error")
    ? "suspect"
    : issues.length > 0
      ? "incomplete"
      : "consistent";
  return deepFreeze({
    status,
    label: sessionHistoryLabel(status, issues, inspected.length, events.length),
    verification: {
      scope: "structural-linkage-only",
      digestRecomputed: false,
      authenticity: "not-proven",
    },
    checkedEvents: inspected.length,
    totalEvents: events.length,
    turnCount: turns.size,
    completedTurnCount: completedTurns,
    issues,
  });
}

/**
 * The one word for what a journal's structure came to, said once.
 *
 * "Unfinished" is a claim about a turn, and it was being printed for any
 * observation at all — a fully terminated, fully inspected history carrying a
 * timestamp drift was labelled "Unfinished" directly above its own "103 of 103
 * events inspected" and "Last turn completed". Both assessment paths (the
 * synchronous structural pass and the audited one) call this, so the two
 * routes cannot disagree about the same journal.
 */
export function sessionHistoryLabel(
  status: SessionHistoryAssessment["status"],
  issues: readonly Readonly<{ code: string }>[],
  checkedEvents: number,
  totalEvents: number,
): SessionHistoryAssessment["label"] {
  if (status === "consistent") return "Locally consistent";
  if (status === "suspect") return "Needs review";
  return issues.some((issue) => issue.code === "TURN_INCOMPLETE") || checkedEvents < totalEvents
    ? "Unfinished"
    : "Observations recorded";
}

export function extractSessionPins(
  session: SessionRecord,
  events: readonly DurableEvent[] = [],
): SessionPins {
  const observed = new Set<SecurityPosture>();
  for (const event of events.slice(0, DEFAULT_SESSION_INSPECTION_LIMITS.maxEvents)) {
    if (event.type !== "inference.started") continue;
    const posture = plainRecord(event.payload)?.posture;
    if (isSecurityPosture(posture)) observed.add(posture);
  }
  const observedValues = [...observed].sort();
  const declared = session.manifest.securityPosture;
  const posture: SessionPostureBinding = declared && isSecurityPosture(declared)
    ? {
        basis: "manifest",
        value: declared,
        observedValues,
        mixed: observedValues.some((value) => value !== declared),
      }
    : observedValues.length === 1
      ? { basis: "event-observation", value: observedValues[0], observedValues, mixed: false }
      : {
          basis: observedValues.length ? "event-observation" : "not-recorded",
          observedValues,
          mixed: observedValues.length > 1,
        };

  const profile = session.manifest.profile ? pinnedProfile(session.manifest.profile) : undefined;
  const lineage = session.manifest.lineage;
  return deepFreeze({
    protocolVersion: session.manifest.protocolVersion,
    providerId: boundedText(canonicalSessionInferenceProviderId(session.manifest), 256) ?? "[invalid provider]",
    model: boundedText(session.modelOverride ?? session.manifest.model, 512) ?? "[invalid model]",
    ...(session.manifest.inferenceBinding?.version === 1
      ? { legacyInferenceTransportId: session.manifest.providerId }
      : {}),
    ...(session.manifest.inferenceBinding
      ? {
          // A same-thread `session.model-changed` event moves only the model
          // address; the provider account, credential generation and trust
          // boundary stay pinned. Project that durable address onto the
          // binding too, or the pin contradicts its own `model` field and a
          // normal navigation round trip becomes an inference-connection
          // mismatch.
          inferenceBinding: {
            ...session.manifest.inferenceBinding,
            modelId: session.modelOverride ?? session.manifest.model,
          },
        }
      : {}),
    workspaceId: boundedText(session.manifest.workspaceId, 2_048) ?? "[invalid workspace]",
    capabilityTier: session.manifest.capabilityTier,
    systemPromptDigest: boundedText(session.manifest.systemPromptDigest, 128) ?? "[invalid digest]",
    toolManifestDigest: boundedText(session.manifest.toolManifestDigest, 128) ?? "[invalid digest]",
    posture,
    ...(profile ? { profile } : {}),
    ...(lineage ? {
      lineage: {
        sourceSessionId: boundedText(lineage.sourceSessionId, 512) ?? "[invalid source]",
        sourceHeadSequence: lineage.sourceHeadSequence,
        sourceHeadDigest: boundedText(lineage.sourceHeadDigest, 128) ?? "[invalid digest]",
        forkedAt: boundedText(lineage.forkedAt, 128) ?? "[invalid time]",
      },
    } : {}),
  });
}

export function decideSessionResume(
  pins: SessionPins,
  assessment: SessionHistoryAssessment,
  runtime: ActiveSessionRuntime,
): SessionResumeCompatibility {
  const reasons: SessionCompatibilityReason[] = [];
  const add = (reason: SessionCompatibilityReason) => reasons.push(Object.freeze(reason));

  if (assessment.status === "suspect") {
    const firstIssue = assessment.issues.find((issue) => issue.severity === "error") ?? assessment.issues[0];
    add({
      code: "HISTORY_SUSPECT",
      severity: "error",
      message: firstIssue
        ? firstIssue.message
        : "Review history before resuming.",
    });
  } else if (assessment.status === "incomplete") {
    /*
     * Say the one that is true, and only require a fork for it.
     *
     * `incomplete` is raised for *any* non-fatal observation, and the sentence
     * asserted both halves of a disjunction — "ended mid-turn or was only
     * partially inspected" — beside the surface's own "103 of 103 events
     * inspected · last turn completed". A fully inspected, fully terminated
     * journal whose only observation was a timestamp drift was told it could
     * not be continued, while the composer for that same conversation kept
     * accepting input. Neither disjunct holds there; the journal is simply
     * carrying an observation, which is worth saying and is not a reason to
     * make somebody fork.
     */
    const endedMidTurn = assessment.issues.some((issue) => issue.code === "TURN_INCOMPLETE");
    const partiallyInspected = assessment.checkedEvents < assessment.totalEvents;
    if (endedMidTurn) {
      add({ code: "HISTORY_INCOMPLETE", severity: "warning", message: "The most recent turn has no durable terminal event; fork before continuing." });
    } else if (partiallyInspected) {
      add({ code: "HISTORY_INCOMPLETE", severity: "warning", message: `Only ${assessment.checkedEvents} of ${assessment.totalEvents} events were inspected; fork before continuing.` });
    } else {
      add({
        code: "HISTORY_OBSERVED",
        severity: "info",
        message: `${assessment.issues.length} structural observation${assessment.issues.length === 1 ? "" : "s"} on a fully inspected, fully terminated history. Fork not required.`,
      });
    }
  }
  const historicalBinding = pins.inferenceBinding?.version === 1;
  const historicalUpgrade = historicalInferenceBindingMayUpgrade({
    ...pins,
    providerId: pins.legacyInferenceTransportId ?? pins.providerId,
  }, runtime.inferenceBinding);
  const inferenceBindingMatches = historicalBinding
    ? historicalUpgrade
    : inferenceBindingsMatch(pins.inferenceBinding, runtime.inferenceBinding);
  const providerMatches = historicalBinding
    ? historicalUpgrade && pins.inferenceBinding?.providerId === runtime.providerId
    : pins.providerId === runtime.providerId;
  if (!providerMatches) {
    add({ code: "PROVIDER_MISMATCH", severity: "warning", message: `Pinned provider ${pins.providerId} differs from active provider ${runtime.providerId}.` });
  }
  if (pins.model !== runtime.model) {
    add({ code: "MODEL_MISMATCH", severity: "warning", message: `Pinned model ${pins.model} differs from active model ${runtime.model}.` });
  }
  if (!inferenceBindingMatches) {
    add({
      code: "INFERENCE_CONNECTION_MISMATCH",
      severity: "warning",
      message: "The active inference account, credential generation, provider revision, transport boundary, or model binding differs from this session pin.",
    });
  }
  if (pins.toolManifestDigest !== runtime.toolManifestDigest) {
    add({ code: "TOOL_MANIFEST_MISMATCH", severity: "warning", message: "The active tool manifest differs from the session pin." });
  }
  if (runtime.workspaceId !== undefined && pins.workspaceId !== runtime.workspaceId) {
    add({ code: "WORKSPACE_MISMATCH", severity: "warning", message: "The active workspace differs from the session pin." });
  }
  if (pins.posture.mixed) {
    add({ code: "POSTURE_AMBIGUOUS", severity: "error", message: "The history does not establish one coherent inference path." });
  } else if (pins.posture.value && pins.posture.value !== runtime.posture) {
    add({ code: "POSTURE_MISMATCH", severity: "warning", message: `Session posture ${pins.posture.value} differs from active posture ${runtime.posture}.` });
  } else if (pins.posture.basis === "not-recorded") {
    add({ code: "POSTURE_NOT_RECORDED", severity: "info", message: "No prior inference posture is recorded; the next session should pin the active posture." });
  } else if (pins.posture.basis === "event-observation") {
    add({ code: "POSTURE_OBSERVED_ONLY", severity: "info", message: "Posture was observed in turn events but was not pinned in this older manifest." });
  }

  compareProfiles(pins.profile, runtime.profile, add);
  const blocked = reasons.some((reason) => reason.severity === "error");
  // The requirement is the reasons, and nothing beside them. `status ===
  // "incomplete"` used to force a fork independently of whether any reason
  // above had survived — so a conversation could be told "Fork required" while
  // the list of why was empty or said "fork not required".
  const requiresFork = reasons.some((reason) => reason.severity === "warning");
  const action = blocked ? "blocked" : requiresFork ? "fork-required" : "resume";
  return deepFreeze({
    action,
    label: action === "resume" ? "Ready to resume" : action === "fork-required" ? "Fork required" : "Resume blocked",
    reasons,
  });
}

export function querySessionRecords(
  records: readonly SessionRecord[],
  query: SessionListQuery = {},
): SessionListPage {
  const offset = nonNegativeInteger(query.offset, 0, 1_000_000);
  const limit = positiveInteger(query.limit, 100, 200);
  const search = normalizeSearch(query.search);
  const summaries: SessionListItem[] = [];
  let rejected = 0;
  for (const record of records.slice(0, 10_000)) {
    const summary = summarizeSession(record);
    if (summary) summaries.push(summary);
    else rejected += 1;
  }
  if (records.length > 10_000) rejected += records.length - 10_000;

  // Profile is a scope boundary, not a filter. Folding it in with the others
  // made the provider and model menus enumerate the whole store, so a Profile
  // could read the name of a provider or model it has never used — and pick it,
  // and get nothing. Facets are derived after the scope and before the filters:
  // after, so they never cross the boundary; before, so choosing a provider
  // does not erase the models the reader was about to compare it against.
  const scoped = summaries.filter((item) => {
    if (query.profileId === "unbound") return !item.profileId;
    return !query.profileId || item.profileId === query.profileId;
  });
  const facets = {
    providers: uniqueSorted(scoped.map((item) => item.providerId)),
    models: uniqueSorted(scoped.map((item) => item.model)),
    profiles: uniqueSorted(scoped.flatMap((item) => item.profileId ? [item.profileId] : [])),
  };
  const filtered = scoped.filter((item) => {
    if (query.providerId && item.providerId !== query.providerId) return false;
    if (query.model && item.model !== query.model) return false;
    if (!search) return true;
    return [item.title, item.id, item.providerId, item.model, item.profileId ?? "", item.sourceSessionId ?? ""]
      .some((value) => searchable(value).includes(search));
  });
  filtered.sort(sessionComparer(query.sort ?? "updated-desc"));
  return deepFreeze({
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    rejected,
    offset,
    limit,
    facets,
  });
}

function summarizeSession(session: SessionRecord): SessionListItem | undefined {
  if (
    !safeIdentifier(session.id) ||
    typeof session.title !== "string" ||
    session.title.length === 0 ||
    session.title.length > 4_096 ||
    !safeDate(session.createdAt) ||
    !safeDate(session.updatedAt) ||
    !Number.isSafeInteger(session.headSequence) ||
    session.headSequence < 0 ||
    typeof session.headDigest !== "string" ||
    (session.headSequence === 0 ? session.headDigest !== "genesis" : !DIGEST_PATTERN.test(session.headDigest)) ||
    !safeIdentifier(canonicalSessionInferenceProviderId(session.manifest)) ||
    typeof session.manifest.model !== "string" ||
    session.manifest.model.length === 0 ||
    session.manifest.model.length > 512 ||
    typeof session.manifest.workspaceId !== "string" ||
    session.manifest.workspaceId.length === 0 ||
    session.manifest.workspaceId.length > 2_048 ||
    !CAPABILITY_TIERS.has(String(session.manifest.capabilityTier)) ||
    (session.manifest.securityPosture !== undefined && !isSecurityPosture(session.manifest.securityPosture)) ||
    (session.manifest.profile !== undefined && !safeIdentifier(session.manifest.profile.profileId)) ||
    // Lineage is validated as one commitment, on the same terms as
    // FORK_LINEAGE_INVALID in `inspectSession`: a fork boundary is a positive
    // journal sequence. Accepting a row whose parent id is sound but whose
    // fork point is not would let the library print a branch point no audit
    // would agree with; the row is counted in `rejected` instead, which the
    // Sessions surface already states out loud.
    (session.manifest.lineage !== undefined && (
      !safeIdentifier(session.manifest.lineage.sourceSessionId) ||
      !Number.isSafeInteger(session.manifest.lineage.sourceHeadSequence) ||
      session.manifest.lineage.sourceHeadSequence <= 0))
  ) return undefined;
  return Object.freeze({
    id: session.id,
    title: truncateSafely(session.title.replace(UNSAFE_CONTROLS, "�"), 240),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    headSequence: session.headSequence,
    headDigest: session.headDigest,
    providerId: canonicalSessionInferenceProviderId(session.manifest),
    // The pinned pin means "model this conversation routes to *now*" — via an
    // in-flight override the thread never asked to fork for, exactly like the
    // conversation's approval policy. The manifest seed remains the birth
    // certificate on the record itself.
    model: session.modelOverride ?? session.manifest.model,
    workspaceId: session.manifest.workspaceId,
    capabilityTier: session.manifest.capabilityTier,
    ...(session.manifest.securityPosture ? { declaredPosture: session.manifest.securityPosture } : {}),
    ...(session.manifest.profile ? {
      profileId: session.manifest.profile.profileId,
      profileRevision: session.manifest.profile.profileRevision,
      profileResolutionDigest: session.manifest.profile.resolutionDigest,
    } : {}),
    ...(session.manifest.lineage ? {
      sourceSessionId: session.manifest.lineage.sourceSessionId,
      sourceHeadSequence: session.manifest.lineage.sourceHeadSequence,
    } : {}),
  });
}

function sessionComparer(sort: SessionListSort): (left: SessionListItem, right: SessionListItem) => number {
  return (left, right) => {
    if (sort === "title-asc") {
      const title = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
      return title || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
    }
    const field = sort === "created-desc" ? "createdAt" : "updatedAt";
    return right[field].localeCompare(left[field]) || left.id.localeCompare(right.id);
  };
}

function compareProfiles(
  pinned: SessionPinnedProfile | undefined,
  active: ActiveSessionRuntime["profile"],
  add: (reason: SessionCompatibilityReason) => void,
): void {
  if (!pinned && !active) return;
  if (!pinned || !active) {
    add({ code: "PROFILE_BINDING_MISMATCH", severity: "warning", message: "The active profile binding differs from the session manifest." });
    return;
  }
  if (pinned.profileId !== active.profileId) {
    add({ code: "PROFILE_MISMATCH", severity: "warning", message: `This conversation belongs to profile ${pinned.profileId}, and ${active.profileId} is active.` });
    return;
  }
  if (pinned.skillSetDigest !== active.skillSetDigest) {
    add({ code: "PROFILE_SKILLS_MISMATCH", severity: "warning", message: "The skills resolved for this profile differ from the set this conversation pinned." });
    return;
  }
  const boundary = changedGovernance(pinned, active);
  if (boundary) {
    add({ code: "PROFILE_BOUNDARY_MISMATCH", severity: "warning", message: `The profile's ${boundary} differs from the boundary this conversation pinned.` });
    return;
  }
  /*
   * A newer revision of the same profile, governing identically.
   *
   * `profileRevision`, `themeDigest` and `resolutionDigest` all move when a
   * profile is edited at all — including for a theme, a name, or a description,
   * none of which reach a turn. Comparing them made resumability a function of
   * cosmetics: measured on this build, choosing a different interface theme and
   * pressing "Save new revision" turned a completed conversation's only forward
   * action into "Fork to continue", refused its one-press Open, and made the
   * profile report that it "had no compatible conversation" and mint an empty
   * one. What actually governs a resumed turn is compared above and is equal
   * here, so this is stated and the conversation resumes.
   */
  if (pinned.profileRevision !== active.profileRevision) {
    add({
      code: "PROFILE_REVISION_NEWER",
      severity: "info",
      message: "This conversation was started on an earlier revision of the same profile. Its skills and boundaries are unchanged, so it resumes as it stands.",
    });
  }
}

/** The governing boundaries, in the order a person would ask about them. */
const GOVERNING_BOUNDARIES = Object.freeze([
  ["workspaceBinding", "workspace boundary"],
  ["memoryScope", "memory scope"],
  ["approvalMode", "approval policy"],
] as const);

/** The first governing boundary that differs, named as a person would say it. */
function changedGovernance(
  pinned: SessionProfileGovernance,
  active: SessionProfileGovernance,
): string | undefined {
  // Only fields both sides carry are compared: a v1 pin has none of them, and
  // inventing a difference against an absent value would strand exactly the
  // oldest conversations this change exists to keep openable.
  for (const [field, name] of GOVERNING_BOUNDARIES) {
    const left = pinned[field];
    const right = active[field];
    if (left !== undefined && right !== undefined && left !== right) return name;
  }
  return undefined;
}

function pinnedProfile(profile: SessionProfileBinding): SessionPinnedProfile {
  const skillCount = profile.resolvedSkills.length;
  const skills = profile.resolvedSkills.slice(0, 512);
  return {
    profileId: boundedText(profile.profileId, 256) ?? "[invalid profile]",
    profileRevision: boundedText(profile.profileRevision, 128) ?? "[invalid digest]",
    themeId: boundedText(profile.themeId, 256) ?? "[invalid theme]",
    themeDigest: boundedText(profile.themeDigest, 128) ?? "[invalid digest]",
    skillSetDigest: boundedText(profile.skillSetDigest, 128) ?? "[invalid digest]",
    resolutionDigest: boundedText(profile.resolutionDigest, 128) ?? "[invalid digest]",
    skills: skills.map((skill) => Object.freeze({
      skillId: boundedText(skill.skillId, 256) ?? "[invalid skill]",
      digest: boundedText(skill.digest, 128) ?? "[invalid digest]",
      promptOrder: Number.isSafeInteger(skill.promptOrder) ? skill.promptOrder : -1,
    })),
    skillCount,
    skillsTruncated: skillCount > skills.length,
    ...profileGovernance(profile),
  };
}

/**
 * The governing half of a pin, in the shape both sides of a resume comparison
 * hold it. `memoryScope` arrives through `enforcedMemoryScope` for the same
 * reason `profile-cockpit` normalizes it: a pin written under the withdrawn
 * `workspace` scope is enforced as `profile` and must not read as a difference.
 */
function profileGovernance(profile: SessionProfileBinding): SessionProfileGovernance {
  if (profile.version !== 2) return {};
  return {
    workspaceBinding: profile.workspaceBinding.kind === "workspace-id"
      ? `workspace-id:${boundedText(profile.workspaceBinding.workspaceId, 2_048) ?? "[invalid workspace]"}`
      : "active-workspace",
    memoryScope: enforcedMemoryScope(profile.memoryScope),
    approvalMode: profile.approvalMode,
  };
}

function resolveLimits(overrides: Partial<SessionInspectionLimits>): SessionInspectionLimits {
  const limits = { ...DEFAULT_SESSION_INSPECTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return Object.freeze(limits);
}

function normalizeSearch(value: string | undefined): string {
  if (!value) return "";
  return searchable(value.slice(0, 256).trim());
}

function searchable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)).slice(0, 500));
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("limit must be a positive safe integer.");
  return Math.min(value, maximum);
}

function nonNegativeInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("offset must be a non-negative safe integer.");
  return Math.min(value, maximum);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => "get" in descriptor || "set" in descriptor)) return undefined;
  return value as Record<string, unknown>;
}

function safeIdentifier(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !HAS_UNSAFE_CONTROL.test(value)
    ? value
    : fallback;
}

function safeDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && Number.isFinite(Date.parse(value));
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !HAS_UNSAFE_CONTROL.test(value)
    ? value
    : undefined;
}

function safeSequence(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 0;
}

function truncateSafely(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return "…".slice(0, maximum);
  let end = maximum - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, Math.max(0, end))}…`;
}
