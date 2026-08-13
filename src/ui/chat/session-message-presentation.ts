import type { JsonValue, SessionForkContextSeed } from "../../core/contracts";
import { CONVERSATION_NAMED_EVENT_TYPE, HUMAN_INTENT_EVENT_TYPE } from "../../core/contracts";
import { FORK_CONTEXT_EVENT_TYPE, canonicalForkContextSeed } from "../../core/fork-context";
import type { DurableEvent, SessionRecord } from "../../core/journal";
import { SESSION_BOOKKEEPING_EVENT_TYPES } from "../../core/journal";
import type { SessionAuditReport } from "../../core/session-audit";
import type { ConversationReceipt } from "../../receipts/types";
import {
  ASSISTANT_LENGTH_FINISH,
  messagePartsFromFacts,
  messagePartsFromDurableEvents,
  toolCallAuthorityFrom,
  TOOL_AUTHORITY_LABELS,
  type MessagePart,
  type MessagePartFact,
  type ToolCallAuthority,
} from "./message-parts";

export type SessionPresentationTurnStatus = "completed" | "failed" | "cancelled" | "incomplete";
export type SessionPresentationProviderContext = "included" | "excluded";

/**
 * Who let one tool call run, projected from the approval's journaled provenance.
 *
 * The journal recorded this from the day approval modes shipped and nothing
 * read it, so every approved tool card in the transcript looked identical
 * whether a person clicked Allow, a review model judged it safe, or Full Access
 * let it through unasked. Those are three different claims about who is
 * accountable for the effect, and a transcript that renders them the same way
 * is not a record of what happened.
 *
 * The authority also rides on each `ToolCallPart` so the transcript can render
 * it without a second channel; this list is the turn-level index of the same
 * facts, keyed by `callId`, for a surface that wants a turn's approvals without
 * walking its parts. One reader (`toolCallAuthorityFrom`) produces both, so the
 * two can never disagree about the label or about what a readable record is.
 */
export type SessionPresentationToolAuthority = ToolCallAuthority & Readonly<{ callId: string }>;

export type SessionPresentationRow = Readonly<{
  id: string;
  sessionId: string;
  turnId: string;
  role: "user" | "assistant";
  sequence: number;
  endSequence: number;
  sourcePoint: Readonly<{ sequence: number; digest: string }>;
  /**
   * The boundary immediately *before* this row's turn was requested.
   *
   * An assistant row's `sourcePoint` is deliberately the post-answer terminal,
   * because "Fork from here" on an answer means "keep this answer". Retry means
   * the opposite — regenerate the turn — and forking at the post-answer point
   * hands the replacement answer the answer it is replacing. The two boundaries
   * are different facts, so the row states both rather than letting the caller
   * guess. Present on assistant rows only; a user row's `sourcePoint` already
   * is the pre-turn boundary.
   */
  turnStartPoint?: Readonly<{ sequence: number; digest: string }>;
  recordedAt?: string;
  parts: readonly MessagePart[];
  turnStatus: SessionPresentationTurnStatus;
  providerContext: SessionPresentationProviderContext;
  /** A validated receipt object remains separate from its display-only FooterPart. */
  receipt?: Readonly<ConversationReceipt>;
  /**
   * Authority for each approved tool call in this turn, in durable order.
   *
   * Present on assistant rows only, and only for approvals whose journaled
   * provenance is well formed — an unreadable record is left absent rather than
   * given a reassuring default, because "we do not know who approved this" and
   * "the user approved this" must never render the same.
   */
  toolAuthorities?: readonly SessionPresentationToolAuthority[];
}>;

/**
 * A durable event that belongs to the session rather than to any turn.
 *
 * protocol-v1 defines these — `session.renamed` carries no `turnId` at all
 * (`session-audit.ts` actively requires `!event.turnId`) and
 * `context.summary.updated` has an outside-turn form — and Airship writes the
 * first of them itself on the first prompt of every default-titled session.
 * They are not turns and cannot become rows, but they are records the user
 * created, so they are returned in sequence order and rendered rather than
 * skipped. A page that dropped them would keep reporting `turnCount` and `page`
 * as though it were complete, which is the failure this type exists to prevent.
 */
export type SessionPresentationMarker = Readonly<{
  /** The durable event type, unmapped, so a marker can be traced to its record. */
  kind: string;
  eventId: string;
  sequence: number;
  digest: string;
  recordedAt?: string;
  /** One plain sentence, already presentable. */
  detail: string;
  /**
   * The fresh identity an out-of-turn *inference* record owns, when it has one.
   *
   * Only the records that made a provider request carry this; a rename or a
   * favourite change has no turn identity at all. It exists so the receipt
   * below can be indexed by the same key turn receipts use.
   */
  turnId?: string;
  /**
   * The receipt for the billed request this marker records.
   *
   * A naming call is a real, paid, attestation-producing request, and its
   * receipt was being minted, validated and journaled while no surface could
   * open it — which is exactly the state a receipt exists to prevent. It is
   * carried here so the transcript row that reports the request can also hand
   * Proof the identity that resolves it.
   */
  receipt?: Readonly<ConversationReceipt>;
  /**
   * Whether this marker's own content could be read.
   *
   * `false` for a session-scoped event whose type this build does not
   * interpret. The event is still counted and still shown — "there is a record
   * here that this version cannot replay" is information the user is owed, and
   * it is the honest alternative to the throw that used to strand a whole vault
   * over one perfectly valid rename.
   */
  presentable: boolean;
  /**
   * The ancestor turns a branch actually inherited, in order.
   *
   * The seed event has always carried them; nothing read them, so a branch
   * opened announcing "Carrying 4 ancestor messages; none omitted." over
   * `document.querySelectorAll('.message').length === 0` and the first-run
   * empty state. The count and the screen disagreed, the model was answering
   * from context the person could not read, and the only other trace was a
   * digest. A number the reader can expand is a disclosure; a number they must
   * take on faith is not.
   */
  carriedContext?: readonly Readonly<{ role: string; content: string }>[];
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
  /** Session-scoped records in the page, in durable sequence order. */
  markers: readonly SessionPresentationMarker[];
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

/**
 * Where a presentation refused, in terms a person can act on.
 *
 * The shipped failure named one thing — a bare event UUID — on a screen that
 * offered no session name, no position and no reason. A user handed
 * "Event 4eb86679-… has no valid turn identity" cannot tell which of their
 * conversations is involved, and the most likely response to that screen is to
 * delete the store. These fields exist so every surfacing site can say which
 * conversation, where in it, and what kind of record.
 */
export type SessionMessagePresentationErrorContext = Readonly<{
  sessionId?: string;
  sequence?: number;
  eventType?: string;
}>;

export class SessionMessagePresentationError extends Error {
  readonly name = "SessionMessagePresentationError";
  readonly sessionId?: string;
  readonly sequence?: number;
  readonly eventType?: string;

  constructor(
    readonly code: SessionMessagePresentationErrorCode,
    message: string,
    context: SessionMessagePresentationErrorContext = {},
  ) {
    super(message);
    this.sessionId = context.sessionId;
    this.sequence = context.sequence;
    this.eventType = context.eventType;
  }
}

/**
 * The same fault, stated for a person rather than for a log.
 *
 * Kept beside the error so the four surfaces that render it — adoption, deep
 * link, command palette and the library resume — cannot each invent their own
 * subset of the facts, which is how one of them came to print only the UUID.
 */
export function describeSessionPresentationFault(error: unknown): string {
  if (!(error instanceof SessionMessagePresentationError)) {
    return error instanceof Error ? error.message : "The transcript could not be replayed.";
  }
  const at = error.sequence === undefined
    ? ""
    : ` at event ${String(error.sequence)}${error.eventType ? ` (${error.eventType})` : ""}`;
  const which = error.sessionId ? ` in session ${error.sessionId.slice(0, 8)}` : "";
  return `${error.message}${at}${which}`;
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
/**
 * Which durable event types belong to a turn, as one rule rather than a list.
 *
 * This is the fix for the defect that stranded a whole vault. The grouper used
 * to assume that *everything* after `session.created` carried a `turnId`, and
 * fell through to `requiredTurnId` — a throw — for anything that did not. But
 * protocol-v1 defines session-scoped events with no `turnId` at all
 * (`session.renamed`, and the outside-turn form of `context.summary.updated`),
 * and `auditSessionHistory` rates journals containing them `verified`. Two
 * validators disagreed and the stricter one was the renderer, so a conversation
 * with a perfect digest chain raised a protocol error — and because the
 * renderer runs inside vault adoption, one ordinary rename cost the whole vault.
 *
 * Turn-scoped families are named positively, so an event outside them and
 * outside a turn is a session marker rather than a violation. A `turn.*` or
 * `tool.*` event that arrives with no turn identity is still a violation and
 * still fails: the permissiveness is scoped to the families that were never
 * turn-scoped in the first place.
 */
const TURN_SCOPED_PREFIX = /^(?:turn|inference|assistant|tool|local)\./u;
/**
 * The records that are session-scoped *despite* carrying turn and operation IDs.
 *
 * The rule above reads identity to decide scope, and for these two that reading
 * is wrong. `auditSessionHistory` defines both as deliberately outside the turn
 * protocol — a person can approve a commit or a vault probe while a turn is
 * running, and the naming inference runs beside a turn rather than in it — and
 * requires each to carry a *fresh* turn/operation ID precisely so it can never
 * be mistaken for a step of a real turn. The grouper saw that identity, looked
 * for the `turn.requested` boundary that by contract does not exist, and threw.
 *
 * That is the same "two validators disagree and the stricter one is the
 * renderer" defect described below, with the same blast radius: the renderer
 * runs inside profile switching and vault adoption, so one approved Git
 * operation made the whole conversation unreplayable and reverted the switch.
 * Naming them here keeps the disagreement closed by *type*, so their identity
 * is used for what it is for — collision detection in the audit — rather than
 * read as turn membership.
 */
const OUT_OF_TURN_RECORD_TYPES = new Set<string>([HUMAN_INTENT_EVENT_TYPE, CONVERSATION_NAMED_EVENT_TYPE]);
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

  const { groups, markers: ungroupedMarkers } = groupTurns(input.events, limits.maxTurns);
  const receipts = receiptIndex(input.receipts ?? [], input.session.id);
  const history = historyIndex(input.history ?? []);
  /*
   * Bind the ancillary-inference markers to their receipts from the same index
   * the turn rows use, so there is exactly one rule for "which receipt belongs
   * to which identity" and a naming receipt cannot be shown against a turn.
   * Only the record that declares a provider request may claim one; every other
   * session-scoped marker is a local bookkeeping fact with nothing to prove.
   */
  const markers = ungroupedMarkers.map((marker) => {
    if (marker.kind !== CONVERSATION_NAMED_EVENT_TYPE || !marker.turnId) return marker;
    const receipt = receipts.get(marker.turnId);
    return receipt ? Object.freeze({ ...marker, receipt }) : marker;
  });
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
    const toolAuthorities = toolAuthoritiesForGroup(group);
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
      turnStartPoint: Object.freeze({ sequence: group.request.sequence - 1, digest: group.request.previousDigest }),
      recordedAt: lastEvent.recordedAt,
      parts: assistantParts,
      turnStatus,
      providerContext,
      ...(receipt ? { receipt } : {}),
      ...(toolAuthorities.length ? { toolAuthorities: Object.freeze(toolAuthorities) } : {}),
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
    markers: Object.freeze(markers),
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

function groupTurns(
  events: readonly DurableEvent[],
  maxTurns: number,
): { groups: TurnGroup[]; markers: SessionPresentationMarker[] } {
  const groups: TurnGroup[] = [];
  const markers: SessionPresentationMarker[] = [];
  const seenTurnIds = new Set<string>();
  /**
   * `operationId` → `turnId` for each ancillary inference this page declared.
   *
   * The naming request is billed, so it emits `inference.usage` under the same
   * fresh identity as its `conversation.named` record. That type is turn-scoped
   * by prefix and has no `turn.requested` boundary, so it would be refused here
   * while `auditSessionHistory` admits it against exactly this map. Admitted on
   * the same terms — the declaring record must come first, and both IDs must
   * match it — so an ordinary orphaned usage event stays the violation it is.
   */
  const ancillaryInferences = new Map<string, string>();
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

    // A session-scoped record: it carries no turn identity, or it is one of the
    // out-of-turn records that own a fresh identity by contract. It is kept,
    // counted and rendered, never dropped — see `SessionPresentationMarker`.
    if (
      OUT_OF_TURN_RECORD_TYPES.has(event.type)
      || isAncillaryInferenceUsage(event, ancillaryInferences)
      || (!event.turnId && !event.operationId && !TURN_SCOPED_PREFIX.test(event.type))
    ) {
      if (event.type === CONVERSATION_NAMED_EVENT_TYPE && event.turnId && event.operationId) {
        ancillaryInferences.set(event.operationId, event.turnId);
      }
      /*
       * Journaled, audited, and not in the transcript.
       *
       * "Selected as this profile's active conversation." is a fact about
       * which thread is open, not about this one. Switching between two
       * conversations wrote it into the middle of whichever you were reading —
       * three of them in a row directly above the composer, in a thread whose
       * actual content was two messages. The record is untouched: the head
       * advances, the audit names the type, and Proof lists every one. This
       * only declines to narrate it back to the person who caused it by
       * clicking.
       */
      if (SESSION_BOOKKEEPING_EVENT_TYPES.has(event.type)) continue;
      markers.push(sessionMarker(event));
      continue;
    }

    const turnId = requiredTurnId(event);
    if (!active || active.turnId !== turnId) {
      fail(
        "TURN_PROTOCOL_INVALID",
        "A turn event appears without its request boundary in the page.",
        eventContext(event),
      );
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

  return { groups, markers };
}

function isAncillaryInferenceUsage(
  event: DurableEvent,
  ancillaryInferences: ReadonlyMap<string, string>,
): boolean {
  return event.type === "inference.usage"
    && Boolean(event.operationId)
    && ancillaryInferences.get(event.operationId!) === event.turnId;
}

/**
 * The presentable form of one session-scoped record.
 *
 * `presentable: false` is not an error state and not a reason to hide the row.
 * It says the record exists, where it sits in the chain, and that this build
 * cannot read its content — which is strictly more than the previous behaviour,
 * which said nothing because it threw.
 */
function sessionMarker(event: DurableEvent): SessionPresentationMarker {
  const payload = record(event.payload);
  const base = {
    kind: event.type,
    eventId: event.eventId,
    sequence: event.sequence,
    digest: event.digest,
    ...(event.recordedAt ? { recordedAt: event.recordedAt } : {}),
    // Kept only where the record actually owns one; `session.renamed` and the
    // profile pointers carry no turn identity and must not appear to.
    ...(validIdentifier(event.turnId) ? { turnId: event.turnId } : {}),
  };
  const title = event.type === "session.renamed" && typeof payload?.title === "string"
    ? presentableTitle(payload.title)
    : undefined;
  if (title !== undefined) return Object.freeze({ ...base, presentable: true, detail: `Renamed to “${title}”` });
  if (event.type === "context.summary.updated") {
    return Object.freeze({
      ...base,
      presentable: true,
      detail: "Earlier turns were summarised into context; the original events remain in the journal.",
    });
  }
  if (event.type === "session.favorite.changed" && typeof payload?.favorite === "boolean") {
    return Object.freeze({
      ...base,
      presentable: true,
      detail: payload.favorite ? "Added to this profile’s favorites." : "Removed from this profile’s favorites.",
    });
  }
  if (
    event.type === "profile.favorite-order.moved"
    && payload?.version === 1
    && typeof payload.profileId === "string"
    && typeof payload.sessionId === "string"
    && Number.isSafeInteger(payload.generation)
  ) {
    return Object.freeze({
      ...base,
      presentable: true,
      detail: "Moved within this profile’s favorite conversations.",
    });
  }
  if (
    event.type === "profile.active-conversation.selected"
    && payload?.version === 1
    && typeof payload.profileId === "string"
    && typeof payload.sessionId === "string"
    && Number.isSafeInteger(payload.generation)
  ) {
    return Object.freeze({
      ...base,
      presentable: true,
      detail: "Selected as this profile’s active conversation.",
    });
  }
  // Airship writes this record itself, one operation before rendering it, so
  // the unread fallback below was never honest about it: every fork, edit and
  // retry branch opened by telling its author the build could not replay the
  // record it had just written. The seed is re-validated rather than trusted,
  // because a marker that states a lineage must state one the payload proves.
  if (event.type === FORK_CONTEXT_EVENT_TYPE) {
    const seed = canonicalForkContextSeed(event.payload);
    if (seed) {
      return Object.freeze({
        ...base,
        presentable: true,
        detail: forkContextDetail(seed),
        // Re-validated above, so these are the exact messages the branch's
        // provider context was sealed with — not a reconstruction of them.
        carriedContext: Object.freeze(seed.messages.map((message) => Object.freeze({
          role: message.role,
          content: message.content,
        }))),
      });
    }
  }
  /*
   * The two out-of-turn records, said in the transcript rather than counted in
   * it. Reaching the fallback below would have been a lie of a second kind:
   * "this build cannot replay" a record this build writes itself, one operation
   * before it renders it. Each payload is re-read rather than trusted, so a
   * malformed record still falls through to the honest unread marker.
   */
  if (event.type === HUMAN_INTENT_EVENT_TYPE) {
    const detail = humanIntentDetail(payload);
    if (detail) return Object.freeze({ ...base, presentable: true, detail });
  }
  if (event.type === CONVERSATION_NAMED_EVENT_TYPE) {
    const named = typeof payload?.title === "string" ? presentableTitle(payload.title) : undefined;
    const model = typeof payload?.model === "string" ? presentableTitle(payload.model) : undefined;
    if (named) {
      return Object.freeze({
        ...base,
        presentable: true,
        detail: `Named “${named}” by ${model ?? "an inference request"} made for this conversation, beside the turn rather than in it.`,
      });
    }
    /*
     * The request completed and returned something this build would not accept
     * as a name — a refusal, a preamble, an essay. That is not a failure to
     * record: it was billed, it produced a receipt, and the only visible effect
     * is that the local name stayed. Saying so is the difference between a
     * charge the user can account for and one that appears nowhere.
     */
    if (typeof payload?.answer === "string") {
      return Object.freeze({
        ...base,
        presentable: true,
        detail: `${model ?? "An inference request"} was asked to name this conversation and returned no usable name; the local name stands.`,
      });
    }
  }
  if (event.type === "inference.usage") {
    return Object.freeze({
      ...base,
      presentable: true,
      detail: "Token usage for the inference that named this conversation.",
    });
  }
  return Object.freeze({
    ...base,
    presentable: false,
    detail: `This build cannot replay a ${event.type} record; the record is intact in the journal.`,
  });
}

/**
 * The lineage sentence a branch opens with.
 *
 * The boundary sequence is the point in the source conversation this branch
 * was taken from, and the carried/omitted counts are what the bounded seed
 * could and could not bring across — a reader who is told neither cannot tell
 * a complete continuation from a truncated one.
 */
function forkContextDetail(seed: SessionForkContextSeed): string {
  const carried = `${String(seed.messages.length)} ancestor ${plural(seed.messages.length, "message")} carried`;
  const images = seed.omittedImages > 0
    ? ` (${String(seed.omittedImages)} ${plural(seed.omittedImages, "image")} omitted)`
    : "";
  return `Continued from the source conversation at event ${String(seed.sourceBoundarySequence)}`
    + ` · ${carried}, ${String(seed.omittedMessages)} omitted${images}.`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/**
 * The sentence for a decision the *person* proposed, not the model.
 *
 * It names the authority the provenance recorded, for the same reason the tool
 * cards do: "you approved this" and "a standing grant approved this" are
 * different claims about who is accountable, and an unreadable provenance
 * yields no claim at all rather than a reassuring one.
 */
function humanIntentDetail(payload: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!payload) return undefined;
  const decision = payload.decision === "allow" ? "Allowed" : payload.decision === "deny" ? "Denied" : undefined;
  const toolName = typeof payload.toolName === "string" ? presentableTitle(payload.toolName) : undefined;
  if (!decision || !toolName) return undefined;
  const effect = typeof payload.effect === "string" ? presentableTitle(payload.effect) : undefined;
  // Source alone, not the full authority: a human-intent record is the decision
  // itself and carries no approval mode to state alongside it.
  const source = record(payload.approval)?.source as SessionPresentationToolAuthority["source"] | undefined;
  const authority = source && source in TOOL_AUTHORITY_LABELS ? ` ${TOOL_AUTHORITY_LABELS[source]}.` : "";
  return `${decision} ${toolName}${effect ? ` (${effect} effect)` : ""} — requested from the interface, outside any turn.${authority}`;
}

/**
 * Bounded, control-character-free title text, or nothing.
 *
 * The journal caps a title at 240 characters and this line renders 120, so a
 * long one is shortened — but never silently. The ellipsis is the difference
 * between a shortened title and a title the reader believes they have all of.
 */
function presentableTitle(value: string): string | undefined {
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/gu, " ").trim();
  if (trimmed.length === 0 || value.length > 240) return undefined;
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

function eventContext(event: DurableEvent): SessionMessagePresentationErrorContext {
  return { sessionId: event.sessionId, sequence: event.sequence, eventType: event.type };
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

/**
 * The turn-level index of the same authorities the call parts now carry.
 *
 * Both projections read one journaled record through `toolCallAuthorityFrom`,
 * so a surface that walks parts and a surface that wants the turn's approvals
 * without walking them cannot drift into two different vocabularies or two
 * different notions of a well-formed provenance record.
 */
function toolAuthoritiesForGroup(group: TurnGroup): SessionPresentationToolAuthority[] {
  const authorities: SessionPresentationToolAuthority[] = [];
  for (const event of group.events) {
    if (event.type !== "tool.approved" && event.type !== "local.command.approved") continue;
    const payload = record(event.payload);
    const callId = event.type === "tool.approved" ? payload?.callId : requiredOperationId(event);
    const authority = toolCallAuthorityFrom(payload?.approval);
    if (!authority || typeof callId !== "string" || callId.length === 0) continue;
    authorities.push(Object.freeze({ callId, ...authority }));
  }
  return authorities;
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
      // A command the *person* proposed still records who authorised the
      // effect, and the card renders the same authority line as a model's call.
      const authority = toolCallAuthorityFrom(payload.approval);
      facts.push({
        kind: "tool-status",
        factId: `${event.eventId}:local-approved`,
        sequence: event.sequence,
        callId: group.operationId,
        status: "approved",
        ...(authority ? { authority } : {}),
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
      // A length-finished answer also projects its cut-off marker.
      if (payload?.finishReason === ASSISTANT_LENGTH_FINISH) count += 1;
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
    markers: Object.freeze([]),
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
    fail(
      "TURN_PROTOCOL_INVALID",
      `Event ${event.eventId} has no valid turn identity.`,
      eventContext(event),
    );
  }
  return event.turnId!;
}

function requiredOperationId(event: DurableEvent): string {
  if (!validIdentifier(event.operationId)) {
    fail(
      "TURN_PROTOCOL_INVALID",
      `Event ${event.eventId} has no valid operation identity.`,
      eventContext(event),
    );
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

function fail(
  code: SessionMessagePresentationErrorCode,
  message: string,
  context?: SessionMessagePresentationErrorContext,
): never {
  throw new SessionMessagePresentationError(code, message, context);
}
