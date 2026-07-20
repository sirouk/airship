import type { JsonValue } from "../../core/contracts";
import type { DurableEvent, SessionRecord } from "../../core/journal";
import type { SessionAuditReport } from "../../core/session-audit";
import type { ConversationReceipt } from "../../receipts/types";
import {
  messagePartsFromFacts,
  messagePartsFromDurableEvents,
  type MessagePart,
  type MessagePartFact,
} from "./message-parts";

export type SessionPresentationTurnStatus = "completed" | "failed" | "cancelled" | "incomplete";
export type SessionPresentationProviderContext = "included" | "excluded";

export type SessionPresentationRow = Readonly<{
  id: string;
  sessionId: string;
  turnId: string;
  role: "user" | "assistant";
  sequence: number;
  endSequence: number;
  sourcePoint: Readonly<{ sequence: number; digest: string }>;
  recordedAt?: string;
  parts: readonly MessagePart[];
  turnStatus: SessionPresentationTurnStatus;
  providerContext: SessionPresentationProviderContext;
  /** A validated receipt object remains separate from its display-only FooterPart. */
  receipt?: Readonly<ConversationReceipt>;
}>;

export type SessionMessagePresentation = Readonly<{
  sessionId: string;
  auditStatus: "verified" | "incomplete";
  head: Readonly<{ sequence: number; digest: string }>;
  page: Readonly<{
    firstSequence: number;
    lastSequence: number;
    omittedPrefix: boolean;
  }>;
  turnCount: number;
  rows: readonly SessionPresentationRow[];
}>;

export type SessionPresentationAudit = Readonly<Pick<
  SessionAuditReport,
  "status" | "sessionId" | "commitment"
>>;

export type SessionPresentationHistory = Readonly<{
  turnId: string;
  turnStatus: SessionPresentationTurnStatus;
  providerContext: SessionPresentationProviderContext;
}>;

export type SessionMessagePresentationLimits = Readonly<{
  maxEvents: number;
  maxTurns: number;
  maxParts: number;
  maxReceipts: number;
  maxHistoryEntries: number;
}>;

export const DEFAULT_SESSION_MESSAGE_PRESENTATION_LIMITS: SessionMessagePresentationLimits =
  Object.freeze({
    maxEvents: 20_000,
    maxTurns: 500,
    maxParts: 20_000,
    maxReceipts: 500,
    maxHistoryEntries: 1_000,
  });

export type SessionMessagePresentationInput = Readonly<{
  session: Readonly<Pick<SessionRecord, "id" | "headSequence" | "headDigest">>;
  /** Report for the same stable journal head. Invalid audits are never presented. */
  audit: SessionPresentationAudit;
  /** A contiguous, audited tail page ending at `session` and `audit` head. */
  events: readonly DurableEvent[];
  /** Bounded, already-validated public receipts, normally from SessionLibrary. */
  receipts?: readonly Readonly<ConversationReceipt>[];
  /** Optional bounded materializer metadata; it is checked, never trusted over events. */
  history?: readonly SessionPresentationHistory[];
  /** Overrides may only make the built-in limits smaller. */
  limits?: Partial<SessionMessagePresentationLimits>;
}>;

export type SessionMessagePresentationErrorCode =
  | "AUDIT_REJECTED"
  | "SESSION_MISMATCH"
  | "HEAD_MISMATCH"
  | "BOUND_EXCEEDED"
  | "EVENT_ORDER_INVALID"
  | "MID_TURN_SLICE"
  | "TURN_PROTOCOL_INVALID"
  | "RECEIPT_MISMATCH"
  | "HISTORY_MISMATCH";

export class SessionMessagePresentationError extends Error {
  readonly name = "SessionMessagePresentationError";

  constructor(
    readonly code: SessionMessagePresentationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type GroupBase = {
  turnId: string;
  request: DurableEvent;
  events: DurableEvent[];
  terminal?: DurableEvent;
};

type AgentTurnGroup = GroupBase & {
  kind: "agent";
};

type LocalCommandGroup = GroupBase & {
  kind: "local-command";
  operationId: string;
  toolName: string;
  approved: boolean;
};

type TurnGroup = AgentTurnGroup | LocalCommandGroup;

const AGENT_TERMINAL_TYPES = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);
const LOCAL_COMMAND_TERMINAL_TYPES = new Set([
  "local.command.completed",
  "local.command.denied",
  "local.command.failed",
]);
const LOCAL_COMMAND_TYPES = new Set([
  "local.command.requested",
  "local.command.approved",
  ...LOCAL_COMMAND_TERMINAL_TYPES,
]);
const TURN_STATUSES = new Set<SessionPresentationTurnStatus>([
  "completed",
  "failed",
  "cancelled",
  "incomplete",
]);
const PROVIDER_CONTEXTS = new Set<SessionPresentationProviderContext>(["included", "excluded"]);
const UNSAFE_IDENTIFIER = /[\u0000-\u001F\u007F]/u;

/**
 * Groups an audited journal tail into one user row and one assistant row per
 * turn. Presentation is derived state: inference-step rows are never copied
 * from SessionLibrary, and durable sequence order remains authoritative.
 */
export function presentSessionMessages(
  input: SessionMessagePresentationInput,
): SessionMessagePresentation {
  const limits = resolveLimits(input.limits);
  validateAuditAndHead(input);
  if (input.events.length > limits.maxEvents) {
    fail("BOUND_EXCEEDED", `The event page exceeds the ${String(limits.maxEvents)}-event presentation limit.`);
  }
  if ((input.receipts?.length ?? 0) > limits.maxReceipts) {
    fail("BOUND_EXCEEDED", `The receipt page exceeds the ${String(limits.maxReceipts)}-receipt presentation limit.`);
  }
  if ((input.history?.length ?? 0) > limits.maxHistoryEntries) {
    fail("BOUND_EXCEEDED", `The history page exceeds the ${String(limits.maxHistoryEntries)}-entry presentation limit.`);
  }

  validateEventPage(input.session, input.events);
  if (input.events.length === 0) return emptyPresentation(input);

  const groups = groupTurns(input.events, limits.maxTurns);
  const receipts = receiptIndex(input.receipts ?? [], input.session.id);
  const history = historyIndex(input.history ?? []);
  const rows: SessionPresentationRow[] = [];
  let partCount = 0;

  for (const group of groups) {
    const turnStatus = groupTerminalStatus(group);
    const providerContext: SessionPresentationProviderContext =
      group.kind === "local-command" || turnStatus !== "completed" ? "excluded" : "included";
    validateHistory(group.turnId, turnStatus, providerContext, history.get(group.turnId));

    const projectedUpperBound = estimatedPartCount(group);
    if (partCount + projectedUpperBound > limits.maxParts) {
      fail("BOUND_EXCEEDED", `The presentation exceeds the ${String(limits.maxParts)}-part limit.`);
    }
    const userParts = userPartsForGroup(group);
    const assistantParts = assistantPartsForGroup(group);
    partCount += userParts.length + assistantParts.length;
    if (partCount > limits.maxParts) {
      fail("BOUND_EXCEEDED", `The presentation exceeds the ${String(limits.maxParts)}-part limit.`);
    }

    const indexedReceipt = receipts.get(group.turnId);
    if (group.kind === "local-command" && indexedReceipt) {
      fail("RECEIPT_MISMATCH", "A local command cannot carry a provider conversation receipt.");
    }
    const receipt = group.kind === "agent" ? indexedReceipt : undefined;
    if (group.kind === "agent") validateTurnReceipt(group, turnStatus, receipt);
    const lastEvent = group.events.at(-1) ?? group.request;
    rows.push(Object.freeze({
      id: `message:${group.request.eventId}:user`,
      sessionId: input.session.id,
      turnId: group.turnId,
      role: "user",
      sequence: group.request.sequence,
      endSequence: group.request.sequence,
      sourcePoint: Object.freeze({ sequence: group.request.sequence - 1, digest: group.request.previousDigest }),
      recordedAt: group.request.recordedAt,
      parts: userParts,
      turnStatus,
      providerContext,
    }));
    rows.push(Object.freeze({
      id: `message:${group.turnId}:assistant`,
      sessionId: input.session.id,
      turnId: group.turnId,
      role: "assistant",
      sequence: assistantParts[0]?.sequence ?? group.request.sequence,
      endSequence: lastEvent.sequence,
      sourcePoint: Object.freeze(
        lastEvent.type === "turn.completed" || lastEvent.type === "local.command.completed" || lastEvent.type === "local.command.failed"
          ? { sequence: lastEvent.sequence, digest: lastEvent.digest }
          : { sequence: group.request.sequence - 1, digest: group.request.previousDigest },
      ),
      recordedAt: lastEvent.recordedAt,
      parts: assistantParts,
      turnStatus,
      providerContext,
      ...(receipt ? { receipt } : {}),
    }));
  }

  const first = input.events[0]!;
  const last = input.events.at(-1)!;
  return Object.freeze({
    sessionId: input.session.id,
    auditStatus: acceptedAuditStatus(input.audit.status),
    head: Object.freeze({ sequence: input.session.headSequence, digest: input.session.headDigest }),
    page: Object.freeze({
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      omittedPrefix: first.sequence > 1,
    }),
    turnCount: groups.length,
    rows: Object.freeze(rows),
  });
}

function validateAuditAndHead(input: SessionMessagePresentationInput): void {
  if (!validIdentifier(input.session.id) || !validIdentifier(input.audit.sessionId)) {
    fail("SESSION_MISMATCH", "The audit or session identity is malformed.");
  }
  if (!["verified", "incomplete", "invalid"].includes(input.audit.status)) {
    fail("AUDIT_REJECTED", "The session audit has an unknown status.");
  }
  if (input.audit.status === "invalid") {
    fail("AUDIT_REJECTED", "An invalid session audit cannot be presented as durable history.");
  }
  if (input.audit.sessionId !== input.session.id) {
    fail("SESSION_MISMATCH", "The audit and session identities do not match.");
  }
  if (
    input.audit.commitment.sequence !== input.session.headSequence ||
    input.audit.commitment.digest !== input.session.headDigest
  ) {
    fail("HEAD_MISMATCH", "The audit commitment does not match the selected session head.");
  }
  if (
    !Number.isSafeInteger(input.session.headSequence) ||
    input.session.headSequence < 0 ||
    !input.session.headDigest
  ) {
    fail("HEAD_MISMATCH", "The selected session head is malformed.");
  }
}

function validateEventPage(
  session: SessionMessagePresentationInput["session"],
  events: readonly DurableEvent[],
): void {
  if (events.length === 0) {
    if (session.headSequence !== 0 || session.headDigest !== "genesis") {
      fail("HEAD_MISMATCH", "An empty event page cannot represent a non-genesis session head.");
    }
    return;
  }

  const first = events[0]!;
  const last = events.at(-1)!;
  if (last.sequence !== session.headSequence || last.digest !== session.headDigest) {
    fail("HEAD_MISMATCH", "The event page does not end at the selected session head.");
  }
  if (first.sequence === 1 && first.type !== "session.created") {
    fail("EVENT_ORDER_INVALID", "Sequence one must be the session creation event.");
  }
  if (
    first.sequence > 1 &&
    first.type !== "turn.requested" &&
    first.type !== "local.command.requested"
  ) {
    fail(
      "MID_TURN_SLICE",
      "A bounded tail page must begin at a turn.requested or local.command.requested boundary.",
    );
  }
  if (!Number.isSafeInteger(first.sequence) || first.sequence < 1) {
    fail("EVENT_ORDER_INVALID", "The event page begins with an invalid sequence.");
  }

  const eventIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.sessionId !== session.id) {
      fail("SESSION_MISMATCH", "The event page contains an event from another session.");
    }
    if (!validIdentifier(event.eventId) || eventIds.has(event.eventId)) {
      fail("EVENT_ORDER_INVALID", "The event page contains an invalid or duplicate event ID.");
    }
    eventIds.add(event.eventId);
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      fail("EVENT_ORDER_INVALID", "The event page contains an invalid sequence.");
    }
    if (index === 0) continue;
    const previous = events[index - 1]!;
    if (event.sequence !== previous.sequence + 1 || event.previousDigest !== previous.digest) {
      fail("EVENT_ORDER_INVALID", "The bounded event page is not contiguous in durable chain order.");
    }
    if (event.type === "session.created") {
      fail("EVENT_ORDER_INVALID", "session.created may appear only at sequence one.");
    }
  }
}

function groupTurns(events: readonly DurableEvent[], maxTurns: number): TurnGroup[] {
  const groups: TurnGroup[] = [];
  const seenTurnIds = new Set<string>();
  let active: TurnGroup | undefined;

  for (const event of events) {
    if (event.type === "session.created") {
      if (event.sequence !== 1 || active) {
        fail("TURN_PROTOCOL_INVALID", "The creation event is outside its protocol position.");
      }
      continue;
    }

    if (event.type === "turn.requested" || event.type === "local.command.requested") {
      if (active) {
        fail("TURN_PROTOCOL_INVALID", "A new turn or local command begins before the current group reaches a terminal event.");
      }
      const turnId = requiredTurnId(event);
      if (seenTurnIds.has(turnId)) {
        fail("TURN_PROTOCOL_INVALID", "A durable turn ID is reused in the event page.");
      }
      if (groups.length >= maxTurns) {
        fail("BOUND_EXCEEDED", `The presentation exceeds the ${String(maxTurns)}-turn limit.`);
      }
      const payload = record(event.payload);
      if (!payload || typeof payload.content !== "string") {
        fail("TURN_PROTOCOL_INVALID", "A turn or local-command request has no presentable text content.");
      }
      if (event.type === "local.command.requested") {
        const operationId = requiredOperationId(event);
        const toolName = requiredToolName(payload);
        active = {
          kind: "local-command",
          turnId,
          request: event,
          events: [event],
          operationId,
          toolName,
          approved: false,
        };
      } else {
        active = { kind: "agent", turnId, request: event, events: [event] };
      }
      groups.push(active);
      seenTurnIds.add(turnId);
      continue;
    }

    const turnId = requiredTurnId(event);
    if (!active || active.turnId !== turnId) {
      fail("TURN_PROTOCOL_INVALID", "A turn event appears without its request boundary in the page.");
    }
    if (active.kind === "local-command") {
      validateLocalCommandEvent(active, event);
      active.events.push(event);
      if (event.type === "local.command.approved") {
        active.approved = true;
        continue;
      }
      if (!LOCAL_COMMAND_TERMINAL_TYPES.has(event.type)) continue;
      active.terminal = event;
      active = undefined;
      continue;
    }
    if (LOCAL_COMMAND_TYPES.has(event.type)) {
      fail("TURN_PROTOCOL_INVALID", "A local-command event cannot occur inside an ordinary agent turn.");
    }
    active.events.push(event);
    if (!AGENT_TERMINAL_TYPES.has(event.type)) continue;
    active.terminal = event;
    active = undefined;
  }

  return groups;
}

function validateLocalCommandEvent(group: LocalCommandGroup, event: DurableEvent): void {
  if (!LOCAL_COMMAND_TYPES.has(event.type) || event.type === "local.command.requested") {
    fail("TURN_PROTOCOL_INVALID", "An ordinary agent event cannot occur inside a local command group.");
  }
  if (requiredOperationId(event) !== group.operationId) {
    fail("TURN_PROTOCOL_INVALID", "A local command changed operation identity before termination.");
  }
  const payload = record(event.payload);
  if (!payload || requiredToolName(payload) !== group.toolName) {
    fail("TURN_PROTOCOL_INVALID", "A local command changed tool identity before termination.");
  }
  if (event.type === "local.command.approved") {
    if (group.approved) fail("TURN_PROTOCOL_INVALID", "A local command is approved more than once.");
    return;
  }
  if (typeof payload.content !== "string") {
    fail("TURN_PROTOCOL_INVALID", "A terminal local-command event has no presentable content.");
  }
  if (event.type === "local.command.completed") {
    if (!group.approved) {
      fail("TURN_PROTOCOL_INVALID", "A local command completed without a durable approval event.");
    }
    if (payload.isError !== undefined && typeof payload.isError !== "boolean") {
      fail("TURN_PROTOCOL_INVALID", "A local command completed with an invalid error disposition.");
    }
  }
  if (event.type === "local.command.denied" && group.approved) {
    fail("TURN_PROTOCOL_INVALID", "A local command cannot be denied after durable approval.");
  }
  if (
    event.type === "local.command.failed" &&
    payload.cancelled !== undefined &&
    typeof payload.cancelled !== "boolean"
  ) {
    fail("TURN_PROTOCOL_INVALID", "A failed local command has an invalid cancellation disposition.");
  }
}

function userPartsForGroup(group: TurnGroup): readonly MessagePart[] {
  if (group.kind === "agent") {
    return messagePartsFromDurableEvents([group.request], {
      turnId: group.turnId,
      includeTurnRequest: true,
      includeTurnFooter: false,
    });
  }
  const payload = record(group.request.payload)!;
  return messagePartsFromFacts([{
    kind: "text",
    factId: `${group.request.eventId}:local-request`,
    sequence: group.request.sequence,
    text: payload.content as string,
    segmentId: `local-request:${group.request.eventId}`,
  }]);
}

function assistantPartsForGroup(group: TurnGroup): readonly MessagePart[] {
  if (group.kind === "agent") {
    return messagePartsFromDurableEvents(group.events, { turnId: group.turnId });
  }

  const requestPayload = record(group.request.payload)!;
  const facts: MessagePartFact[] = [{
    kind: "tool-call",
    factId: `${group.request.eventId}:local-tool-call`,
    sequence: group.request.sequence,
    callId: group.operationId,
    name: group.toolName,
    arguments: (requestPayload.arguments ?? null) as JsonValue,
    status: "requested",
  }];
  for (const event of group.events.slice(1)) {
    const payload = record(event.payload)!;
    if (event.type === "local.command.approved") {
      facts.push({
        kind: "tool-status",
        factId: `${event.eventId}:local-approved`,
        sequence: event.sequence,
        callId: group.operationId,
        status: "approved",
      });
      continue;
    }
    if (event.type === "local.command.completed") {
      facts.push({
        kind: "tool-result",
        factId: `${event.eventId}:local-result`,
        sequence: event.sequence,
        ordinal: 0,
        callId: group.operationId,
        name: group.toolName,
        content: payload.content as string,
        ...(payload.metadata !== undefined ? { metadata: payload.metadata as JsonValue } : {}),
        status: payload.isError === true ? "error" : "success",
      });
      facts.push(localFooterFact(event, "Local command completed · excluded from provider context."));
      continue;
    }
    if (event.type === "local.command.denied") {
      facts.push({
        kind: "tool-result",
        factId: `${event.eventId}:local-denied`,
        sequence: event.sequence,
        ordinal: 0,
        callId: group.operationId,
        name: group.toolName,
        content: payload.content as string,
        status: "denied",
      });
      facts.push(localFooterFact(event, "Local command denied · excluded from provider context."));
      continue;
    }
    if (event.type === "local.command.failed") {
      const cancelled = payload.cancelled === true;
      facts.push({
        kind: "tool-status",
        factId: `${event.eventId}:local-failed-status`,
        sequence: event.sequence,
        ordinal: 0,
        callId: group.operationId,
        status: "failed",
      });
      facts.push({
        kind: "error",
        factId: `${event.eventId}:local-error`,
        sequence: event.sequence,
        ordinal: 1,
        summary: payload.content as string,
        code: cancelled ? "local.command.cancelled" : "local.command.failed",
        retryable: !cancelled,
      });
      facts.push(localFooterFact(
        event,
        cancelled
          ? "Local command cancelled · excluded from provider context."
          : "Local command failed · excluded from provider context.",
        2,
      ));
    }
  }
  return messagePartsFromFacts(facts);
}

function localFooterFact(
  event: DurableEvent,
  summary: string,
  ordinal = 1,
): Extract<MessagePartFact, { kind: "footer" }> {
  return {
    kind: "footer",
    factId: `${event.eventId}:local-footer`,
    sequence: event.sequence,
    ordinal,
    summary,
    recordedAt: event.recordedAt,
  };
}

function receiptIndex(
  receipts: readonly Readonly<ConversationReceipt>[],
  sessionId: string,
): ReadonlyMap<string, Readonly<ConversationReceipt>> {
  const byTurn = new Map<string, Readonly<ConversationReceipt>>();
  const receiptTurns = new Map<string, string>();
  for (const receipt of receipts) {
    if (receipt.sessionId !== sessionId) {
      fail("SESSION_MISMATCH", "The receipt page contains a receipt from another session.");
    }
    if (!validIdentifier(receipt.turnId) || !receipt.receiptId || receipt.receiptId.length > 2_048) {
      fail("RECEIPT_MISMATCH", "The receipt page contains malformed presentation identity.");
    }
    const priorTurnId = receiptTurns.get(receipt.receiptId);
    if (priorTurnId) {
      if (priorTurnId !== receipt.turnId) {
        fail("RECEIPT_MISMATCH", "A receipt ID is reused across different turns.");
      }
      continue;
    }
    const existing = byTurn.get(receipt.turnId);
    if (existing && existing.receiptId !== receipt.receiptId) {
      fail("RECEIPT_MISMATCH", "A turn is associated with more than one receipt.");
    }
    receiptTurns.set(receipt.receiptId, receipt.turnId);
    byTurn.set(receipt.turnId, receipt);
  }
  return byTurn;
}

function historyIndex(
  entries: readonly SessionPresentationHistory[],
): ReadonlyMap<string, SessionPresentationHistory> {
  const byTurn = new Map<string, SessionPresentationHistory>();
  for (const entry of entries) {
    if (
      !validIdentifier(entry.turnId) ||
      !TURN_STATUSES.has(entry.turnStatus) ||
      !PROVIDER_CONTEXTS.has(entry.providerContext)
    ) {
      fail("HISTORY_MISMATCH", "The history page contains an invalid turn identity.");
    }
    const existing = byTurn.get(entry.turnId);
    if (
      existing &&
      (existing.turnStatus !== entry.turnStatus || existing.providerContext !== entry.providerContext)
    ) {
      fail("HISTORY_MISMATCH", "The history page gives conflicting dispositions for one turn.");
    }
    byTurn.set(entry.turnId, entry);
  }
  return byTurn;
}

function validateHistory(
  turnId: string,
  turnStatus: SessionPresentationTurnStatus,
  providerContext: SessionPresentationProviderContext,
  history: SessionPresentationHistory | undefined,
): void {
  if (!history) return;
  if (history.turnStatus !== turnStatus || history.providerContext !== providerContext) {
    fail("HISTORY_MISMATCH", `Bounded history metadata disagrees with durable turn ${turnId}.`);
  }
}

function validateTurnReceipt(
  group: AgentTurnGroup,
  turnStatus: SessionPresentationTurnStatus,
  receipt: Readonly<ConversationReceipt> | undefined,
): void {
  if (!receipt) return;
  if (turnStatus !== "completed") {
    fail("RECEIPT_MISMATCH", "A non-completed turn cannot carry a presentation receipt.");
  }
  const payload = record(group.terminal?.payload);
  const committedReceiptId = typeof payload?.receiptId === "string" ? payload.receiptId : undefined;
  if (committedReceiptId && committedReceiptId !== receipt.receiptId) {
    fail("RECEIPT_MISMATCH", "The bounded receipt does not match turn.completed.");
  }
}

function groupTerminalStatus(group: TurnGroup): SessionPresentationTurnStatus {
  if (group.kind === "agent") return agentTerminalStatus(group.terminal);
  if (!group.terminal) return "incomplete";
  if (
    group.terminal.type === "local.command.completed" ||
    group.terminal.type === "local.command.denied"
  ) {
    return "completed";
  }
  const payload = record(group.terminal.payload);
  return payload?.cancelled === true ? "cancelled" : "failed";
}

function agentTerminalStatus(event: DurableEvent | undefined): SessionPresentationTurnStatus {
  if (!event) return "incomplete";
  if (event.type === "turn.completed") return "completed";
  if (event.type === "turn.failed") return "failed";
  if (event.type === "turn.cancelled") return "cancelled";
  return "incomplete";
}

/** Conservative preflight prevents a single large embedded tool-call array from allocating past the part bound. */
function estimatedPartCount(group: TurnGroup): number {
  if (group.kind === "local-command") return group.terminal ? 4 : 2;
  let count = 1; // user request
  for (const event of group.events) {
    const payload = record(event.payload);
    if (event.type === "assistant.completed") {
      const message = record(payload?.message);
      if (typeof message?.content === "string" && message.content.length > 0) count += 1;
      if (Array.isArray(message?.toolCalls)) count += message.toolCalls.length;
    }
    if (event.type === "tool.requested") count += 1;
    if (["tool.resulted", "tool.failed", "tool.denied"].includes(event.type)) count += 1;
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) count += 1;
  }
  return count;
}

function emptyPresentation(input: SessionMessagePresentationInput): SessionMessagePresentation {
  return Object.freeze({
    sessionId: input.session.id,
    auditStatus: acceptedAuditStatus(input.audit.status),
    head: Object.freeze({ sequence: 0, digest: "genesis" }),
    page: Object.freeze({ firstSequence: 0, lastSequence: 0, omittedPrefix: false }),
    turnCount: 0,
    rows: Object.freeze([]),
  });
}

function acceptedAuditStatus(status: SessionAuditReport["status"]): "verified" | "incomplete" {
  if (status === "invalid") fail("AUDIT_REJECTED", "An invalid session audit cannot be presented.");
  return status;
}

function resolveLimits(
  overrides: Partial<SessionMessagePresentationLimits> | undefined,
): SessionMessagePresentationLimits {
  const resolved = { ...DEFAULT_SESSION_MESSAGE_PRESENTATION_LIMITS };
  if (!overrides) return resolved;
  for (const key of Object.keys(resolved) as Array<keyof SessionMessagePresentationLimits>) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_SESSION_MESSAGE_PRESENTATION_LIMITS[key]) {
      throw new RangeError(`${key} must be a positive integer no larger than the built-in bound.`);
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

function requiredTurnId(event: DurableEvent): string {
  if (!validIdentifier(event.turnId)) {
    fail("TURN_PROTOCOL_INVALID", `Event ${event.eventId} has no valid turn identity.`);
  }
  return event.turnId!;
}

function requiredOperationId(event: DurableEvent): string {
  if (!validIdentifier(event.operationId)) {
    fail("TURN_PROTOCOL_INVALID", `Event ${event.eventId} has no valid operation identity.`);
  }
  return event.operationId!;
}

function requiredToolName(payload: Record<string, unknown>): string {
  const value = payload.toolName;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    UNSAFE_IDENTIFIER.test(value)
  ) {
    fail("TURN_PROTOCOL_INVALID", "A local command has no valid tool identity.");
  }
  return value;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !UNSAFE_IDENTIFIER.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fail(code: SessionMessagePresentationErrorCode, message: string): never {
  throw new SessionMessagePresentationError(code, message);
}
