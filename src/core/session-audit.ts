import type {
  CanonicalMessage,
  JsonValue,
  SecurityPosture,
  SessionManifest,
  ToolCall,
  ToolDefinition,
} from "./contracts";
import { sha256, stableStringify } from "./hash";
import type { DurableEvent, SessionRecord } from "./journal";
import { boundInferenceHistoryImages, canonicalImageInputs } from "./multimodal";
import {
  canonicalContextSelection,
  contextSelectionScopeMatches,
  injectContextSelection,
  verifyContextSelection,
  verifyContextSelectionQuery,
} from "./context-selection";
import {
  canonicalContextSummary,
  canonicalSessionContextPolicy,
  summaryBodiesWithinPolicy,
  verifyContextSummary,
  type ContextSummaryProvenance,
} from "./context-compressor";
import { materializeMessages } from "./agent";

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
const KNOWN_EVENT_TYPES = new Set([
  "session.created",
  "session.renamed",
  "context.summary.updated",
  "turn.requested",
  "turn.context.selected",
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
]);
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const EFFECTS = new Set(["read", "write", "network", "execute", "identity"]);
const POSTURES = new Set(["local", "plaintext-remote", "encrypted-unattested", "encrypted-attested"]);
const CAPABILITY_TIERS = new Set(["web-baseline", "web-enhanced", "native", "remote-confidential"]);
const FINISH_REASONS = new Set(["stop", "tool-calls", "length"]);
const encoder = new TextEncoder();

export type SessionAuditSeverity = "error" | "warning" | "info";
export type SessionAuditCategory =
  | "schema"
  | "chain"
  | "manifest"
  | "protocol"
  | "receipt"
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
  /** Human-readable origin such as an enclave receipt, transparency log, or signed export. */
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
    receiptBindings: boolean;
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
    unknownEvents: number;
  }>;
  findings: readonly SessionAuditFinding[];
}>;

export type SessionAuditOptions = Readonly<{
  checkedAt?: string;
  trustedHead?: TrustedJournalHead;
  limits?: Partial<SessionAuditLimits>;
}>;

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
  step: number;
  request?: {
    content: string;
    messageIndex: number;
  };
  contextSelected?: boolean;
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
export async function auditSessionHistory(
  input: SessionAuditInput,
  options: SessionAuditOptions = {},
): Promise<SessionAuditReport> {
  const limits = resolveLimits(options.limits);
  const findings: SessionAuditFinding[] = [];
  const add = (
    finding: Omit<SessionAuditFinding, "severity"> & { severity?: SessionAuditSeverity },
  ) => findings.push(Object.freeze({ severity: "error", ...finding }));

  const rawInput = asPlainRecord(input);
  const rawSession = asPlainRecord(rawInput?.session);
  const rawEvents = Array.isArray(rawInput?.events) ? rawInput.events : undefined;
  const sessionId = boundedString(rawSession?.id, 512) ?? "unknown";

  if (!rawInput || !rawSession || !rawEvents) {
    add({
      code: "INPUT_INVALID",
      category: "schema",
      message: "Audit input must contain a plain session record and an event array.",
    });
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
    add({
      code: "EVENT_LIMIT_EXCEEDED",
      category: "schema",
      message: `Journal contains ${rawEvents.length} events; the audit limit is ${limits.maxEvents}.`,
    });
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
      add({ code: "EVENT_INVALID", category: "schema", message: "Journal event must be a plain object." });
      continue;
    }
    const location = eventLocation(eventRecord);
    const unknownFields = Object.keys(eventRecord).filter((field) => !EVENT_FIELDS.has(field));
    if (unknownFields.length > 0) {
      add({
        ...location,
        code: "EVENT_UNKNOWN_FIELDS",
        category: "schema",
        message: `Event contains fields outside protocol v1: ${unknownFields.sort().join(", ")}.`,
      });
    }
    if (!isDurableEventShape(eventRecord)) {
      add({
        ...location,
        code: "EVENT_SHAPE_INVALID",
        category: "schema",
        message: "Event is missing a required protocol-v1 field or contains an invalid field type.",
      });
      continue;
    }
    const jsonInspection = inspectJson(eventRecord.payload, limits);
    if (!jsonInspection.valid) {
      add({
        ...location,
        code: "EVENT_PAYLOAD_INVALID",
        category: "schema",
        message: jsonInspection.message,
      });
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
      add({
        ...eventLocation(event),
        code: "EVENT_SIZE_EXCEEDED",
        category: "schema",
        message: `Canonical event size ${eventBytes} exceeds the ${limits.maxEventBytes}-byte audit limit.`,
      });
    }
    if (totalBytes > limits.maxTotalBytes) {
      add({
        ...eventLocation(event),
        code: "JOURNAL_SIZE_EXCEEDED",
        category: "schema",
        message: `Canonical journal size exceeds the ${limits.maxTotalBytes}-byte audit limit.`,
      });
      break;
    }

    if (event.version !== 1) {
      add({ ...eventLocation(event), code: "EVENT_VERSION_INVALID", category: "schema", message: "Event version must be 1." });
    }
    if (event.sessionId !== sessionId) {
      add({ ...eventLocation(event), code: "CROSS_SESSION_EVENT", category: "chain", message: "Event belongs to a different session." });
    }
    if (event.sequence !== expectedSequence) {
      add({
        ...eventLocation(event),
        code: "SEQUENCE_GAP",
        category: "chain",
        message: `Expected sequence ${expectedSequence}; found ${event.sequence}.`,
      });
    }
    if (event.previousDigest !== expectedPreviousDigest) {
      add({
        ...eventLocation(event),
        code: "PREVIOUS_DIGEST_MISMATCH",
        category: "chain",
        message: "Event does not extend the preceding digest.",
      });
    }
    if (!DIGEST_PATTERN.test(event.digest) || (await sha256(canonical)) !== event.digest) {
      add({ ...eventLocation(event), code: "EVENT_DIGEST_MISMATCH", category: "chain", message: "Event digest is invalid." });
    }
    if (eventIds.has(event.eventId)) {
      add({ ...eventLocation(event), code: "EVENT_ID_REUSED", category: "chain", message: "Event ID is reused in this session." });
    }
    eventIds.add(event.eventId);
    const recordedTime = Date.parse(event.recordedAt);
    if (!Number.isFinite(recordedTime)) {
      add({ ...eventLocation(event), code: "EVENT_TIME_INVALID", category: "schema", message: "Event timestamp is not a valid ISO timestamp." });
    } else if (recordedTime < previousTime) {
      add({ ...eventLocation(event), code: "EVENT_TIME_REVERSED", category: "chain", message: "Event timestamp precedes the prior event." });
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

function resolveLimits(overrides: Partial<SessionAuditLimits> | undefined): SessionAuditLimits {
  const resolved = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return Object.freeze(resolved);
}

function validateSessionRecord(
  raw: Record<string, unknown>,
  add: (finding: Omit<SessionAuditFinding, "severity"> & { severity?: SessionAuditSeverity }) => void,
): SessionRecord | undefined {
  const requiredStrings = ["id", "title", "createdAt", "updatedAt", "headDigest"] as const;
  if (requiredStrings.some((field) => boundedString(raw[field], field === "title" ? 4_096 : 512) === undefined)) {
    add({ code: "SESSION_SHAPE_INVALID", category: "schema", message: "Session record has an invalid required string field." });
    return undefined;
  }
  if (!Number.isSafeInteger(raw.headSequence) || (raw.headSequence as number) < 0 || !asPlainRecord(raw.manifest)) {
    add({ code: "SESSION_SHAPE_INVALID", category: "schema", message: "Session head or manifest has an invalid shape." });
    return undefined;
  }
  if (!Number.isFinite(Date.parse(raw.createdAt as string)) || !Number.isFinite(Date.parse(raw.updatedAt as string))) {
    add({ code: "SESSION_TIME_INVALID", category: "schema", message: "Session timestamps are invalid." });
  }
  if (raw.headSequence === 0 ? raw.headDigest !== "genesis" : !DIGEST_PATTERN.test(raw.headDigest as string)) {
    add({ code: "SESSION_HEAD_INVALID", category: "chain", message: "Session head digest is invalid for its sequence." });
  }
  return raw as unknown as SessionRecord;
}

async function validateManifest(
  manifest: SessionManifest,
  add: (finding: Omit<SessionAuditFinding, "severity"> & { severity?: SessionAuditSeverity }) => void,
): Promise<void> {
  const raw = asPlainRecord(manifest);
  const manifestInspection = inspectJson(manifest, DEFAULT_LIMITS);
  if (!manifestInspection.valid) {
    add({ code: "MANIFEST_DATA_INVALID", category: "manifest", message: manifestInspection.message });
    return;
  }
  if (
    !raw ||
    (raw.protocolVersion !== 1 && raw.protocolVersion !== 2) ||
    boundedString(raw.systemPrompt, 512 * 1024) === undefined ||
    boundedString(raw.systemPromptDigest, 128) === undefined ||
    boundedString(raw.providerId, 256) === undefined ||
    boundedString(raw.model, 512) === undefined ||
    boundedString(raw.toolManifestDigest, 128) === undefined ||
    boundedString(raw.workspaceId, 2_048) === undefined ||
    boundedString(raw.createdAt, 128) === undefined ||
    !Array.isArray(raw.tools)
  ) {
    add({ code: "MANIFEST_SHAPE_INVALID", category: "manifest", message: "Session manifest does not satisfy a supported protocol shape." });
    return;
  }
  if ((await sha256(raw.systemPrompt as string)) !== raw.systemPromptDigest) {
    add({ code: "SYSTEM_PROMPT_DIGEST_MISMATCH", category: "manifest", message: "System prompt does not match its pinned digest." });
  }
  if (!CAPABILITY_TIERS.has(String(raw.capabilityTier))) {
    add({ code: "CAPABILITY_TIER_INVALID", category: "manifest", message: "Manifest capability tier is invalid." });
  }
  if (raw.securityPosture !== undefined && !POSTURES.has(String(raw.securityPosture))) {
    add({ code: "SECURITY_POSTURE_PIN_INVALID", category: "manifest", message: "Manifest security posture pin is invalid." });
  }
  const inferenceBinding = asPlainRecord(raw.inferenceBinding);
  if (raw.inferenceBinding !== undefined && (
    !inferenceBinding ||
    inferenceBinding.version !== 1 ||
    boundedString(inferenceBinding.connectionId, 256) === undefined ||
    !Number.isSafeInteger(inferenceBinding.connectionGeneration) ||
    (inferenceBinding.connectionGeneration as number) <= 0 ||
    boundedString(inferenceBinding.providerId, 256) === undefined ||
    boundedString(inferenceBinding.providerLabel, 256) === undefined ||
    !Number.isSafeInteger(inferenceBinding.providerRevision) ||
    (inferenceBinding.providerRevision as number) <= 0 ||
    !["oauth-pkce", "api-key", "local-none"].includes(String(inferenceBinding.authMethod)) ||
    !["e2ee-attestable", "provider-tls", "loopback-local"].includes(String(inferenceBinding.transportBoundary)) ||
    boundedString(inferenceBinding.modelId, 512) === undefined ||
    inferenceBinding.modelId !== raw.model ||
    boundedString(inferenceBinding.boundAt, 128) === undefined ||
    !Number.isFinite(Date.parse(String(inferenceBinding.boundAt)))
  )) {
    add({ code: "INFERENCE_BINDING_INVALID", category: "manifest", message: "Manifest inference connection binding is malformed or does not match its model pin." });
  }
  if (raw.contextPolicy !== undefined && !canonicalSessionContextPolicy(raw.contextPolicy)) {
    add({ code: "CONTEXT_POLICY_INVALID", category: "manifest", message: "Manifest context-window and compression semantics are invalid." });
  }
  if (
    (raw.protocolVersion === 1 && raw.turnContext !== undefined) ||
    (raw.protocolVersion === 2 && raw.turnContext !== "required" && raw.turnContext !== "disabled")
  ) {
    add({ code: "TURN_CONTEXT_POLICY_INVALID", category: "manifest", message: "Manifest turn-context retrieval policy is invalid." });
  }
  const lineage = asPlainRecord(raw.lineage);
  if (raw.lineage !== undefined && (
    !lineage ||
    lineage.version !== 1 ||
    lineage.kind !== "fork" ||
    boundedString(lineage.sourceSessionId, 512) === undefined ||
    !Number.isSafeInteger(lineage.sourceHeadSequence) ||
    (lineage.sourceHeadSequence as number) <= 0 ||
    !DIGEST_PATTERN.test(String(lineage.sourceHeadDigest)) ||
    boundedString(lineage.forkedAt, 128) === undefined ||
    !Number.isFinite(Date.parse(String(lineage.forkedAt))) ||
    lineage.forkedAt !== raw.createdAt
  )) {
    add({ code: "FORK_LINEAGE_INVALID", category: "manifest", message: "Manifest fork lineage is malformed or does not match manifest creation time." });
  }
  const tools = raw.tools;
  const toolNames = new Set<string>();
  let toolsValid = true;
  for (const candidate of tools) {
    const tool = asPlainRecord(candidate);
    if (
      !tool ||
      boundedString(tool.name, 256) === undefined ||
      boundedString(tool.description, 32_768) === undefined ||
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
    add({ code: "TOOL_MANIFEST_INVALID", category: "manifest", message: "Tool manifest contains an invalid or duplicate definition." });
  } else if ((await sha256(stableStringify(tools as JsonValue))) !== raw.toolManifestDigest) {
    add({ code: "TOOL_MANIFEST_DIGEST_MISMATCH", category: "manifest", message: "Tool definitions do not match their pinned digest." });
  }
  const profile = asPlainRecord(raw.profile);
  if (profile) {
    const skills = Array.isArray(profile.resolvedSkills) ? profile.resolvedSkills : undefined;
    const skillIds = new Set<string>();
    const skillsValid = Boolean(skills?.every((candidate, index) => {
      const skill = asPlainRecord(candidate);
      if (
        !skill ||
        boundedString(skill.skillId, 256) === undefined ||
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
      boundedString(profile.profileId, 256) === undefined ||
      !DIGEST_PATTERN.test(String(profile.profileRevision)) ||
      boundedString(profile.themeId, 256) === undefined ||
      !DIGEST_PATTERN.test(String(profile.themeDigest)) ||
      !DIGEST_PATTERN.test(String(profile.skillSetDigest)) ||
      !DIGEST_PATTERN.test(String(profile.resolutionDigest))
    ) {
      add({ code: "PROFILE_BINDING_INVALID", category: "manifest", message: "Session profile binding is invalid." });
    } else if ((await sha256(stableStringify(skills as JsonValue))) !== profile.skillSetDigest) {
      add({ code: "SKILL_SET_DIGEST_MISMATCH", category: "manifest", message: "Resolved skills do not match their pinned digest." });
    }
    const workspaceBinding = asPlainRecord(profile.workspaceBinding);
    const hasSiloFields = profile.workspaceBinding !== undefined || profile.memoryScope !== undefined || profile.approvalMode !== undefined || profile.minimumPosture !== undefined;
    const validWorkspaceBinding = workspaceBinding !== undefined && (
      (workspaceBinding.kind === "active-workspace" && Object.keys(workspaceBinding).length === 1) ||
      (workspaceBinding.kind === "workspace-id" && boundedString(workspaceBinding.workspaceId, 512) !== undefined)
    );
    const validSilo = validWorkspaceBinding
      && ["session", "profile", "workspace"].includes(String(profile.memoryScope))
      && ["ask-first", "auto-approve", "full-access"].includes(String(profile.approvalMode))
      && POSTURES.has(String(profile.minimumPosture) as SecurityPosture);
    if ((profile.version === 2 && !validSilo) || (profile.version === 1 && hasSiloFields)) {
      add({ code: "PROFILE_SILO_INVALID", category: "manifest", message: "Session profile workspace, memory, approval, or proof boundary is invalid." });
    }
  }
}

function validateHead(
  session: SessionRecord,
  events: readonly DurableEvent[],
  add: (finding: Omit<SessionAuditFinding, "severity"> & { severity?: SessionAuditSeverity }) => void,
): void {
  const last = events.at(-1);
  const sequence = last?.sequence ?? 0;
  const digest = last?.digest ?? "genesis";
  if (session.headSequence !== sequence || session.headDigest !== digest) {
    add({ code: "SESSION_HEAD_MISMATCH", category: "chain", message: "Session head does not match the final audited event." });
  }
  if (last && session.updatedAt !== last.recordedAt) {
    add({ code: "SESSION_UPDATED_AT_MISMATCH", category: "chain", message: "Session update timestamp does not match the final event.", severity: "warning" });
  }
}

async function validateProtocol(
  session: SessionRecord,
  events: readonly DurableEvent[],
  add: (finding: Omit<SessionAuditFinding, "severity"> & { severity?: SessionAuditSeverity }) => void,
): Promise<SessionAuditReport["counts"]> {
  const counts = emptyCounts();
  counts.events = events.length;
  const seenTurns = new Set<string>();
  const seenOperations = new Set<string>();
  const messages: CanonicalMessage[] = [];
  let lastContextMessage: LastContextMessage | undefined;
  let active: TurnState | undefined;
  let activeLocal: LocalCommandState | undefined;
  let sawCreation = false;

  const requireActive = (event: DurableEvent): TurnState | undefined => {
    if (!active || !event.turnId || event.turnId !== active.id || active.terminal) {
      add({
        ...eventLocation(event),
        code: "EVENT_OUTSIDE_ACTIVE_TURN",
        category: "protocol",
        message: `${event.type} does not belong to the active turn.`,
      });
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
      add({
        ...eventLocation(event),
        code: "LOCAL_COMMAND_EVENT_ORPHANED",
        category: "protocol",
        message: `${event.type} does not match the active client-only local command.`,
      });
      return undefined;
    }
    return activeLocal;
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const payload = asPlainRecord(event.payload);
    if (!KNOWN_EVENT_TYPES.has(event.type)) {
      counts.unknownEvents += 1;
      add({
        ...eventLocation(event),
        code: "EVENT_TYPE_UNKNOWN",
        category: "completeness",
        severity: "warning",
        message: `Event type ${event.type} is not interpreted by protocol-v1 audit rules.`,
      });
      continue;
    }

    if (event.type === "session.created") {
      if (index !== 0 || sawCreation || event.turnId || event.operationId || !payload) {
        add({ ...eventLocation(event), code: "SESSION_CREATION_INVALID", category: "protocol", message: "session.created must be the first event and have no turn or operation ID." });
      } else {
        sawCreation = true;
        const eventManifest = asPlainRecord(payload.manifest);
        if (!eventManifest || stableStringify(eventManifest as JsonValue) !== stableStringify(session.manifest as unknown as JsonValue)) {
          add({ ...eventLocation(event), code: "SESSION_MANIFEST_SNAPSHOT_MISMATCH", category: "manifest", message: "Creation event manifest differs from the session record." });
        }
        if (payload.title !== session.title) {
          add({ ...eventLocation(event), code: "SESSION_TITLE_SNAPSHOT_MISMATCH", category: "manifest", message: "Creation event title differs from the session record.", severity: "warning" });
        }
      }
      continue;
    }
    if (event.type === "session.renamed") {
      if (event.turnId || event.operationId || !payload || typeof payload.title !== "string" || !payload.title.trim() || payload.title.length > 240) {
        add({ severity: "error", category: "protocol", code: "SESSION_RENAME_MALFORMED", sequence: event.sequence, message: "A session rename must carry one bounded title outside any turn." });
      }
      continue;
    }

    if (event.type === "context.summary.updated") {
      const summary = canonicalContextSummary(event.payload);
      const valid = summary
        ? await verifyContextSummary(summary, events.slice(0, index + 1))
        : false;
      const turnBoundPreprocessing = Boolean(
        active &&
        session.manifest.protocolVersion === 2 &&
        event.turnId === active.id &&
        !event.operationId &&
        active.step === -1 &&
        !active.inference &&
        !active.finalAssistant &&
        active.tools.length === 0,
      );
      const outsideTurn = !active && !event.turnId && !event.operationId;
      if (
        activeLocal || (!outsideTurn && !turnBoundPreprocessing) || !summary || !valid ||
        summary.sourceEndSequence >= event.sequence ||
        !summaryMatchesContextPolicy(summary, session.manifest, events.slice(0, index))
      ) {
        add({
          ...eventLocation(event),
          code: "CONTEXT_SUMMARY_INVALID",
          category: "protocol",
          message: "A context summary must be a verified, digest-linked transcript-prefix delta outside an active turn.",
        });
      } else {
        messages.splice(0, messages.length, ...materializeMessages(
          events.slice(0, index + 1),
          {
            injectLatestContext: turnBoundPreprocessing,
            allowEmbeddedContext: session.manifest.turnContext === undefined,
            allowSelectedContext: session.manifest.turnContext !== "disabled",
          },
        ));
        if (active?.request) {
          active.request.messageIndex = messages.length - 1;
          lastContextMessage = active.contextSelected
            ? { index: active.request.messageIndex, content: active.request.content }
            : undefined;
        } else {
          lastContextMessage = undefined;
        }
      }
      continue;
    }

    if (event.type === "local.command.requested") {
      if (active || activeLocal) {
        add({
          ...eventLocation(event),
          code: "LOCAL_COMMAND_OVERLAP",
          category: "protocol",
          message: "A client-only local command started while another turn or local command was active.",
        });
        continue;
      }
      const turnId = boundedString(event.turnId, 512);
      const operationId = boundedString(event.operationId, 512);
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
        add({
          ...eventLocation(event),
          code: "LOCAL_COMMAND_REQUEST_INVALID",
          category: "protocol",
          message: "A local command request must have new turn/operation IDs, a bounded tool name, text, and arguments.",
        });
        continue;
      }
      seenTurns.add(turnId);
      seenOperations.add(operationId);
      counts.localCommands += 1;
      activeLocal = { turnId, operationId, toolName, approved: false };
      continue;
    }

    if (
      event.type === "local.command.approved" ||
      event.type === "local.command.completed" ||
      event.type === "local.command.denied" ||
      event.type === "local.command.failed"
    ) {
      const command = requireActiveLocal(event);
      if (!command || !payload) continue;
      if (payload.toolName !== command.toolName) {
        add({
          ...eventLocation(event),
          code: "LOCAL_COMMAND_IDENTITY_MISMATCH",
          category: "protocol",
          message: "A local-command event changed its pinned tool identity.",
        });
        continue;
      }
      if (event.type === "local.command.approved") {
        if (command.approved) {
          add({
            ...eventLocation(event),
            code: "LOCAL_COMMAND_APPROVAL_INVALID",
            category: "protocol",
            message: "A local command approval is duplicated.",
          });
        } else {
          command.approved = true;
        }
        continue;
      }

      let terminalValid = true;
      if (typeof payload.content !== "string") terminalValid = false;
      if (
        event.type === "local.command.completed" &&
        (!command.approved || typeof payload.isError !== "boolean")
      ) {
        terminalValid = false;
      }
      if (event.type === "local.command.denied" && command.approved) terminalValid = false;
      if (
        event.type === "local.command.failed" &&
        payload.cancelled !== undefined &&
        typeof payload.cancelled !== "boolean"
      ) {
        terminalValid = false;
      }
      if (!terminalValid) {
        add({
          ...eventLocation(event),
          code: "LOCAL_COMMAND_TERMINAL_INVALID",
          category: "protocol",
          message: "A local command terminal is out of order or has malformed client-only result metadata.",
        });
      } else {
        counts.terminalLocalCommands += 1;
      }
      activeLocal = undefined;
      continue;
    }

    if (event.type === "turn.requested") {
      if (activeLocal) {
        add({
          ...eventLocation(event),
          code: "TURN_OVERLAP",
          category: "protocol",
          message: "A provider turn started before the active client-only local command terminated.",
        });
        continue;
      }
      if (active && !active.terminal) {
        add({ ...eventLocation(event), code: "TURN_OVERLAP", category: "protocol", message: "A turn started before the preceding turn reached a terminal event." });
      }
      if (!event.turnId || event.operationId || seenTurns.has(event.turnId)) {
        add({ ...eventLocation(event), code: "TURN_REQUEST_INVALID", category: "protocol", message: "Turn request must have a new turn ID and no operation ID." });
        active = undefined;
        continue;
      }
      const images = canonicalImageInputs(payload?.images);
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
        add({ ...eventLocation(event), code: "TURN_CONTENT_INVALID", category: "protocol", message: "Turn request payload must contain string content." });
      }
      if (!images) {
        add({ ...eventLocation(event), code: "TURN_IMAGES_INVALID", category: "protocol", message: "Turn request images violate the bounded inline-image contract." });
      }
      if (payload?.contextSelection !== undefined && !contextSelection) {
        add({ ...eventLocation(event), code: "TURN_CONTEXT_INVALID", category: "protocol", message: "Turn context selection violates the bounded provenance contract." });
      } else if (contextSelection && !contextVerified) {
        add({ ...eventLocation(event), code: "TURN_CONTEXT_DIGEST_MISMATCH", category: "protocol", message: "Turn context selection digest or selected text digest does not verify." });
      } else if (contextSelection && !contextQueryVerified) {
        add({ ...eventLocation(event), code: "TURN_CONTEXT_QUERY_MISMATCH", category: "protocol", message: "Turn context selection is committed to a different canonical query." });
      } else if (contextSelection && !contextScopeVerified) {
        add({ ...eventLocation(event), code: "TURN_CONTEXT_SCOPE_MISMATCH", category: "protocol", message: "Turn context selection lineage is outside the session's pinned scope." });
      }
      if (payload?.contextSelection !== undefined && !embeddedContextAllowed) {
        add({
          ...eventLocation(event),
          code: "TURN_CONTEXT_LEGACY_EMBED_INVALID",
          category: "protocol",
          message: "Only historical manifests without an explicit turn-context policy may embed selection data in turn.requested.",
        });
      }
      seenTurns.add(event.turnId);
      counts.turns += 1;
      active = { id: event.turnId, step: -1, tools: [] };
      if (lastContextMessage) {
        const prior = messages[lastContextMessage.index];
        if (prior?.role === "user") messages[lastContextMessage.index] = { ...prior, content: lastContextMessage.content };
        lastContextMessage = undefined;
      }
      if (payload && typeof payload.content === "string" && images &&
          (payload.contextSelection === undefined || (
            embeddedContextAllowed && contextSelection && contextVerified && contextQueryVerified && contextScopeVerified
          ))) {
        const index = messages.length;
        messages.push({
          role: "user",
          content: injectContextSelection(payload.content, contextSelection),
          ...(images.length ? { images: [...images] } : {}),
        });
        active.request = { content: payload.content, messageIndex: index };
        active.contextSelected = embeddedContextAllowed && Boolean(contextSelection);
        if (embeddedContextAllowed && contextSelection?.hits.length) lastContextMessage = { index, content: payload.content };
      }
      continue;
    }

    if (event.type === "turn.context.selected") {
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
        event.operationId ||
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
        add({
          ...eventLocation(event),
          code: !selection
            ? "TURN_CONTEXT_INVALID"
            : !verified
              ? "TURN_CONTEXT_DIGEST_MISMATCH"
              : !queryVerified
                ? "TURN_CONTEXT_QUERY_MISMATCH"
                : !scopeVerified
                  ? "TURN_CONTEXT_SCOPE_MISMATCH"
                  : "TURN_CONTEXT_LIFECYCLE_INVALID",
          category: "protocol",
          message: "Turn context must be canonical, verified, policy-allowed, unique, and journaled before inference.",
        });
        continue;
      }
      const message = messages[turn.request.messageIndex];
      if (!message || message.role !== "user") {
        add({ ...eventLocation(event), code: "TURN_CONTEXT_LIFECYCLE_INVALID", category: "protocol", message: "Turn context has no matching user request." });
        continue;
      }
      messages[turn.request.messageIndex] = {
        ...message,
        content: injectContextSelection(turn.request.content, selection),
      };
      turn.contextSelected = true;
      if (selection.hits.length) {
        lastContextMessage = { index: turn.request.messageIndex, content: turn.request.content };
      }
      continue;
    }

    if (event.type === "inference.started") {
      const turn = requireActive(event);
      if (!turn || !payload) continue;
      if (
        session.manifest.turnContext === "required" &&
        turn.request?.content.trim() &&
        !turn.contextSelected
      ) {
        add({
          ...eventLocation(event),
          code: "TURN_CONTEXT_REQUIRED_MISSING",
          category: "protocol",
          message: "Inference started without the turn-context selection required by the immutable session manifest.",
        });
      }
      const step = payload.step;
      const operationId = event.operationId;
      if (
        !operationId ||
        seenOperations.has(operationId) ||
        turn.inference ||
        !Number.isSafeInteger(step) ||
        (step as number) !== turn.step + 1 ||
        turn.tools.some((tool) => !tool.terminal)
      ) {
        add({ ...eventLocation(event), code: "INFERENCE_LIFECYCLE_INVALID", category: "protocol", message: "Inference operation is reused, out of order, overlapping, or starts before tools are terminal." });
        continue;
      }
      if (
        payload.providerId !== session.manifest.providerId ||
        payload.model !== session.manifest.model ||
        !POSTURES.has(String(payload.posture))
      ) {
        add({ ...eventLocation(event), code: "INFERENCE_BINDING_MISMATCH", category: "protocol", message: "Inference provider, model, or posture does not match the pinned session/runtime vocabulary." });
      }
      const idempotencyKey = `${session.id}:${turn.id}:${String(step)}`;
      if (payload.idempotencyKey !== idempotencyKey || !DIGEST_PATTERN.test(String(payload.requestDigest))) {
        add({ ...eventLocation(event), code: "INFERENCE_REQUEST_METADATA_INVALID", category: "protocol", message: "Inference idempotency key or request digest is invalid." });
      } else {
        const expectedRequestDigest = await sha256(stableStringify({
          model: session.manifest.model,
          systemPromptDigest: session.manifest.systemPromptDigest,
          messages: boundInferenceHistoryImages(messages),
          tools: session.manifest.tools,
          idempotencyKey,
        } as unknown as JsonValue));
        if (expectedRequestDigest !== payload.requestDigest) {
          add({ ...eventLocation(event), code: "INFERENCE_REQUEST_DIGEST_MISMATCH", category: "protocol", message: "Inference request digest does not match the canonical transcript prefix." });
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

    if (event.type === "inference.usage") {
      const turn = requireActive(event);
      if (!turn || !turn.inference || event.operationId !== turn.inference.operationId || !payload) {
        add({ ...eventLocation(event), code: "INFERENCE_USAGE_ORPHANED", category: "protocol", message: "Usage event does not match an active inference." });
        continue;
      }
      for (const tokenField of ["inputTokens", "outputTokens"] as const) {
        const value = payload[tokenField];
        if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
          add({ ...eventLocation(event), code: "INFERENCE_USAGE_INVALID", category: "protocol", message: "Usage token counts must be non-negative safe integers." });
          break;
        }
      }
      continue;
    }

    if (event.type === "assistant.completed") {
      const turn = requireActive(event);
      if (!turn || !payload || !turn.inference || event.operationId !== turn.inference.operationId) {
        add({ ...eventLocation(event), code: "ASSISTANT_ORPHANED", category: "protocol", message: "Assistant event does not terminate the active inference." });
        continue;
      }
      const message = asPlainRecord(payload.message);
      const finishReason = payload.finishReason;
      if (!message || message.role !== "assistant" || typeof message.content !== "string" || !FINISH_REASONS.has(String(finishReason))) {
        add({ ...eventLocation(event), code: "ASSISTANT_MESSAGE_INVALID", category: "protocol", message: "Assistant payload has an invalid canonical message or finish reason." });
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
          add({ ...eventLocation(event), code: "TOOL_ASSISTANT_TERMINAL_INVALID", category: "protocol", message: "Assistant tool-call phase has inconsistent terminal metadata." });
        }
        const localIds = new Set<string>();
        for (const call of toolCalls) {
          if (localIds.has(call.id) || seenOperations.has(call.id)) {
            add({ ...eventLocation(event), code: "TOOL_CALL_ID_REUSED", category: "protocol", message: "Tool-call ID is duplicated or reused as another operation." });
          }
          localIds.add(call.id);
        }
        turn.tools = toolCalls.map((call) => ({ call, requested: false }));
      } else {
        if (finishReason === "tool-calls" || !DIGEST_PATTERN.test(String(payload.responseDigest))) {
          add({ ...eventLocation(event), code: "FINAL_ASSISTANT_TERMINAL_INVALID", category: "protocol", message: "Final assistant event has inconsistent finish or response-digest metadata." });
        }
        const expectedResponseDigest = await sha256(message.content);
        if (expectedResponseDigest !== payload.responseDigest) {
          add({ ...eventLocation(event), code: "RESPONSE_DIGEST_MISMATCH", category: "receipt", message: "Assistant response does not match its response digest." });
        }
        const receiptId = validateReceipt(
          payload.receipt,
          session,
          turn,
          String(payload.responseDigest),
          event,
          add,
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

    if (event.type === "tool.requested") {
      const turn = requireActive(event);
      if (!turn || !payload || turn.inference || !event.operationId) continue;
      const call = asPlainRecord(payload.call);
      const expected = turn.tools.find((tool) => tool.call.id === event.operationId);
      if (
        !call ||
        !expected ||
        expected.requested ||
        call.id !== expected.call.id ||
        call.name !== expected.call.name ||
        !jsonEqual(call.arguments, expected.call.arguments)
      ) {
        add({ ...eventLocation(event), code: "TOOL_REQUEST_MISMATCH", category: "protocol", message: "Tool request does not match a unique call declared by the preceding assistant message." });
        continue;
      }
      expected.requested = true;
      seenOperations.add(event.operationId);
      counts.toolOperations += 1;
      continue;
    }

    if (event.type === "tool.approved" || event.type === "tool.denied") {
      const turn = requireActive(event);
      if (!turn || !payload || !event.operationId) continue;
      const tool = turn.tools.find((candidate) => candidate.call.id === event.operationId);
      if (
        !tool ||
        !tool.requested ||
        tool.decision ||
        payload.callId !== tool.call.id ||
        payload.name !== tool.call.name
      ) {
        add({ ...eventLocation(event), code: "TOOL_DECISION_INVALID", category: "protocol", message: "Tool decision is duplicated or does not match a requested call." });
        continue;
      }
      tool.decision = event.type === "tool.approved" ? "approved" : "denied";
      if (event.type === "tool.denied") {
        if (typeof payload.content !== "string") {
          add({ ...eventLocation(event), code: "TOOL_DENIAL_INVALID", category: "protocol", message: "Tool denial lacks its canonical tool-message content." });
        } else {
          messages.push({ role: "tool", toolCallId: tool.call.id, content: payload.content });
        }
        tool.terminal = "denied";
        counts.terminalToolOperations += 1;
      }
      continue;
    }

    if (event.type === "tool.resulted" || event.type === "tool.failed") {
      const turn = requireActive(event);
      if (!turn || !payload || !event.operationId) continue;
      const tool = turn.tools.find((candidate) => candidate.call.id === event.operationId);
      if (
        !tool ||
        tool.decision !== "approved" ||
        tool.terminal ||
        payload.callId !== tool.call.id ||
        payload.name !== tool.call.name ||
        typeof payload.content !== "string"
      ) {
        add({ ...eventLocation(event), code: "TOOL_TERMINAL_INVALID", category: "protocol", message: "Tool terminal is duplicated, unapproved, or does not match its request." });
        continue;
      }
      if (event.type === "tool.resulted" && typeof payload.isError !== "boolean") {
        add({ ...eventLocation(event), code: "TOOL_RESULT_INVALID", category: "protocol", message: "Tool result must include an explicit isError boolean." });
      }
      tool.terminal = event.type === "tool.resulted" ? "resulted" : "failed";
      counts.terminalToolOperations += 1;
      messages.push({ role: "tool", toolCallId: tool.call.id, content: payload.content });
      continue;
    }

    if (event.type === "turn.completed") {
      const turn = requireActive(event);
      if (!turn || !payload) continue;
      if (
        event.operationId ||
        turn.inference ||
        turn.tools.some((tool) => !tool.terminal) ||
        !turn.finalAssistant ||
        payload.responseDigest !== turn.finalAssistant.responseDigest ||
        payload.receiptId !== turn.finalAssistant.receiptId
      ) {
        add({ ...eventLocation(event), code: "TURN_COMPLETION_INVALID", category: "protocol", message: "Turn completed without a matching final assistant, receipt, or fully terminal operations." });
      }
      turn.terminal = "completed";
      counts.completedTurns += 1;
      active = undefined;
      continue;
    }

    if (event.type === "turn.failed" || event.type === "turn.cancelled") {
      const turn = requireActive(event);
      if (!turn || !payload) continue;
      if (event.operationId || typeof payload.error !== "string") {
        add({ ...eventLocation(event), code: "TURN_TERMINAL_INVALID", category: "protocol", message: "Failed or cancelled turn has invalid terminal metadata." });
      }
      const unresolved = Boolean(turn.inference) || turn.tools.some((tool) => !tool.terminal);
      if (unresolved) {
        add({
          ...eventLocation(event),
          code: "OPERATION_OUTCOME_UNKNOWN",
          category: "completeness",
          severity: "warning",
          message: "Turn terminated with an operation whose durable outcome is unknown.",
        });
      }
      turn.terminal = event.type === "turn.failed" ? "failed" : "cancelled";
      if (event.type === "turn.failed") counts.failedTurns += 1;
      else counts.cancelledTurns += 1;
      active = undefined;
    }
  }

  if (!sawCreation) {
    add({ code: "SESSION_CREATION_MISSING", category: "protocol", message: "Journal has no canonical session.created event." });
  }
  if (active) {
    add({
      code: "TURN_INCOMPLETE",
      category: "completeness",
      severity: "warning",
      message: `Turn ${active.id} has no durable terminal event.`,
      turnId: active.id,
      operationId: active.inference?.operationId,
    });
  }
  if (activeLocal) {
    add({
      code: "LOCAL_COMMAND_INCOMPLETE",
      category: "completeness",
      message: `Client-only local command ${activeLocal.turnId} has no durable terminal event.`,
      turnId: activeLocal.turnId,
      operationId: activeLocal.operationId,
    });
  }
  return counts;
}

function summaryMatchesContextPolicy(
  summary: NonNullable<ReturnType<typeof canonicalContextSummary>>,
  manifest: SessionManifest,
  priorEvents: readonly DurableEvent[],
): boolean {
  const canonical = canonicalSessionContextPolicy(manifest.contextPolicy);
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
  if (!compactionMatchesContextPolicy(summary.compaction, summarizer, manifest)) return false;
  if (summarizer.mode === "extractive-fallback") {
    return summary.summaryMethod === "extractive-fallback-v1" &&
      summary.summarizerProvenance === undefined &&
      summary.summarizerAttempt === undefined;
  }
  if (summary.summaryMethod === "summarizer-port-v1") {
    return summary.summarizerId === summarizer.adapterId &&
      provenanceMatchesContextPolicy(summary.summarizerProvenance, summarizer.adapterId, manifest);
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
      provenanceMatchesContextPolicy(compaction.provenance, summarizer.adapterId, manifest);
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
): boolean {
  return provenance?.adapterId === adapterId &&
    provenance.providerId === manifest.providerId &&
    provenance.model === manifest.model &&
    (manifest.securityPosture === undefined || provenance.posture === manifest.securityPosture);
}

function parseToolCalls(
  value: unknown,
  event: DurableEvent,
  add: (finding: Omit<SessionAuditFinding, "severity"> & { severity?: SessionAuditSeverity }) => void,
): ToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    add({ ...eventLocation(event), code: "TOOL_CALLS_INVALID", category: "protocol", message: "Assistant toolCalls must be an array." });
    return [];
  }
  const calls: ToolCall[] = [];
  for (const candidate of value) {
    const call = asPlainRecord(candidate);
    if (
      !call ||
      boundedString(call.id, 512) === undefined ||
      boundedString(call.name, 256) === undefined ||
      !inspectJson(call.arguments, DEFAULT_LIMITS).valid
    ) {
      add({ ...eventLocation(event), code: "TOOL_CALL_INVALID", category: "protocol", message: "Assistant declared an invalid tool call." });
      continue;
    }
    calls.push(call as unknown as ToolCall);
  }
  return calls;
}

function validateReceipt(
  value: unknown,
  session: SessionRecord,
  turn: TurnState,
  responseDigest: string,
  event: DurableEvent,
  add: (finding: Omit<SessionAuditFinding, "severity"> & { severity?: SessionAuditSeverity }) => void,
): string | undefined {
  const receipt = asPlainRecord(value);
  const bindings = asPlainRecord(receipt?.bindings);
  const receiptId = boundedString(receipt?.receiptId, 2_048);
  if (
    !receipt ||
    receipt.version !== 1 ||
    !receiptId ||
    receipt.sessionId !== session.id ||
    receipt.turnId !== turn.id ||
    receipt.provider !== session.manifest.providerId ||
    (receipt.model !== undefined && receipt.model !== session.manifest.model) ||
    !POSTURES.has(String(receipt.posture)) ||
    !bindings ||
    bindings.algorithm !== "SHA-256"
  ) {
    add({ ...eventLocation(event), code: "RECEIPT_IDENTITY_MISMATCH", category: "receipt", message: "Receipt does not match the session, turn, provider, model, or digest algorithm." });
    return receiptId;
  }
  if (bindings.requestDigest !== turn.inference?.requestDigest || bindings.responseDigest !== responseDigest) {
    add({ ...eventLocation(event), code: "RECEIPT_BINDING_MISMATCH", category: "receipt", message: "Receipt request/response bindings do not match the audited turn." });
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
      receiptBindings: categoryPasses("receipt"),
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
    unknownEvents: 0,
  };
}

function isDurableEventShape(value: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(value.version) &&
    value.version === 1 &&
    boundedString(value.eventId, 512) !== undefined &&
    boundedString(value.sessionId, 512) !== undefined &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) > 0 &&
    boundedString(value.recordedAt, 128) !== undefined &&
    boundedString(value.previousDigest, 128) !== undefined &&
    boundedString(value.digest, 128) !== undefined &&
    boundedString(value.type, 128) !== undefined &&
    (value.turnId === undefined || boundedString(value.turnId, 512) !== undefined) &&
    (value.operationId === undefined || boundedString(value.operationId, 512) !== undefined) &&
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

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
