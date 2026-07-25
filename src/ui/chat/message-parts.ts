import type { JsonValue, SessionManifest } from "../../core/contracts";
import type { DurableEvent } from "../../core/journal";
import { parseCapabilityTier } from "./capability-tier";

export const MESSAGE_PART_KINDS = [
  "text",
  "tool-call",
  "tool-result",
  "reasoning-summary",
  "citation",
  "attachment",
  "error",
  "footer",
] as const;

export type MessagePartKind = (typeof MESSAGE_PART_KINDS)[number];

export const MESSAGE_PART_DISPLAY_LIMITS = Object.freeze({
  textChars: 65_536,
  toolArgumentsChars: 768,
  toolResultChars: 8_192,
  reasoningSummaryChars: 4_096,
  citationLabelChars: 256,
  citationExcerptChars: 2_048,
  referenceChars: 2_048,
  attachmentNameChars: 256,
  attachmentSummaryChars: 1_024,
  errorChars: 2_048,
  footerChars: 1_024,
  plainTextChars: 131_072,
  jsonDepth: 4,
  jsonCollectionItems: 12,
  jsonNodes: 96,
  jsonStringChars: 256,
} as const);

type MessagePartBase<Kind extends MessagePartKind> = Readonly<{
  /** Stable presentation identity derived from the first durable fact. */
  id: string;
  kind: Kind;
  /** First and most recent durable sequence represented by this part. */
  sequence: number;
  endSequence: number;
  /** Fact provenance is retained without carrying raw journal payloads. */
  sourceFactIds: readonly string[];
}>;

export type TextPart = MessagePartBase<"text"> & Readonly<{
  content: string;
  /** Adjacent text merges only within the same optional streaming segment. */
  segmentId?: string;
}>;

export type ToolCallStatus =
  | "requested"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "denied";

export type ToolCallPart = MessagePartBase<"tool-call"> & Readonly<{
  callId: string;
  name: string;
  /** A bounded display projection. Raw arguments are never retained here. */
  argumentsSummary: string;
  status: ToolCallStatus;
}>;

export type ToolResultStatus = "success" | "error" | "denied";

export type ToolResultPart = MessagePartBase<"tool-result"> & Readonly<{
  callId: string;
  name?: string;
  summary: string;
  metadataSummary?: string;
  /** Exact producing tier when the durable tool result reports one. */
  capabilityTier?: SessionManifest["capabilityTier"];
  status: ToolResultStatus;
}>;

export type ReasoningSummaryPart = MessagePartBase<"reasoning-summary"> & Readonly<{
  /** Provider- or agent-authored user-visible summary; never hidden chain-of-thought. */
  summary: string;
  label?: string;
}>;

export type CitationPart = MessagePartBase<"citation"> & Readonly<{
  citationId: string;
  label: string;
  excerpt?: string;
  /** Display reference only. A renderer must still apply its own navigation policy. */
  reference?: string;
}>;

export type AttachmentStatus = "pending" | "available" | "failed";

export type AttachmentPart = MessagePartBase<"attachment"> & Readonly<{
  attachmentId: string;
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  /** Page-memory visual confirmation only; absent after durable replay. */
  previewUrl?: string;
  summary?: string;
  /** Opaque object reference or display URI; never an embedded file payload. */
  reference?: string;
  status: AttachmentStatus;
}>;

export type ErrorPart = MessagePartBase<"error"> & Readonly<{
  summary: string;
  code?: string;
  retryable: boolean;
}>;

export type FooterPart = MessagePartBase<"footer"> & Readonly<{
  summary: string;
  receiptId?: string;
  recordedAt?: string;
}>;

export type MessagePart =
  | TextPart
  | ToolCallPart
  | ToolResultPart
  | ReasoningSummaryPart
  | CitationPart
  | AttachmentPart
  | ErrorPart
  | FooterPart;

type MessagePartFactBase<Kind extends string> = Readonly<{
  kind: Kind;
  factId: string;
  sequence: number;
  /** Orders multiple projections of the same durable sequence. */
  ordinal?: number;
}>;

export type TextMessagePartFact = MessagePartFactBase<"text"> & Readonly<{
  text: string;
  /** Supply one stable ID for all durable chunks of a single text segment. */
  segmentId?: string;
}>;

export type ToolCallMessagePartFact = MessagePartFactBase<"tool-call"> & Readonly<{
  callId: string;
  name: string;
  arguments?: JsonValue;
  /** Use this for a pre-redacted summary; it takes precedence over `arguments`. */
  argumentsSummary?: string;
  status?: ToolCallStatus;
}>;

export type ToolStatusMessagePartFact = MessagePartFactBase<"tool-status"> & Readonly<{
  callId: string;
  status: ToolCallStatus;
}>;

export type ToolResultMessagePartFact = MessagePartFactBase<"tool-result"> & Readonly<{
  callId: string;
  name?: string;
  content: string;
  metadata?: JsonValue;
  status?: ToolResultStatus;
}>;

export type ReasoningSummaryMessagePartFact = MessagePartFactBase<"reasoning-summary"> & Readonly<{
  /** Must contain only a user-visible summary, never private reasoning tokens. */
  summary: string;
  label?: string;
}>;

export type CitationMessagePartFact = MessagePartFactBase<"citation"> & Readonly<{
  citationId: string;
  label: string;
  excerpt?: string;
  reference?: string;
}>;

export type AttachmentMessagePartFact = MessagePartFactBase<"attachment"> & Readonly<{
  attachmentId: string;
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  summary?: string;
  reference?: string;
  status?: AttachmentStatus;
}>;

export type ErrorMessagePartFact = MessagePartFactBase<"error"> & Readonly<{
  summary: string;
  code?: string;
  retryable?: boolean;
}>;

export type FooterMessagePartFact = MessagePartFactBase<"footer"> & Readonly<{
  summary: string;
  receiptId?: string;
  recordedAt?: string;
}>;

/**
 * A presentation fact is intentionally narrower than a journal event. It may
 * carry raw tool JSON only long enough to derive a bounded display summary.
 */
export type MessagePartFact =
  | TextMessagePartFact
  | ToolCallMessagePartFact
  | ToolStatusMessagePartFact
  | ToolResultMessagePartFact
  | ReasoningSummaryMessagePartFact
  | CitationMessagePartFact
  | AttachmentMessagePartFact
  | ErrorMessagePartFact
  | FooterMessagePartFact;

export type DurableMessagePartOptions = Readonly<{
  /** Scope a mixed journal to one turn. */
  turnId?: string;
  /** User requests are normally rendered as their own message. */
  includeTurnRequest?: boolean;
  includeTurnFooter?: boolean;
}>;

const MAX_FACT_ID_CHARS = 512;
const UNSAFE_IDENTIFIER = /[\u0000-\u001F\u007F]/u;
const UNSAFE_DISPLAY_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/**
 * Builds an immutable part list in durable sequence order. Sorting is stable
 * for equal sequence/ordinal values, and replayed fact IDs are idempotent.
 */
export function messagePartsFromFacts(facts: readonly MessagePartFact[]): readonly MessagePart[] {
  const ordered = facts.map((fact, inputIndex) => ({ fact, inputIndex }));
  for (const { fact } of ordered) validateFact(fact);
  ordered.sort((left, right) =>
    left.fact.sequence - right.fact.sequence ||
    (left.fact.ordinal ?? 0) - (right.fact.ordinal ?? 0) ||
    left.inputIndex - right.inputIndex,
  );

  const parts: MessagePart[] = [];
  const seen = new Set<string>();
  for (const { fact } of ordered) {
    if (seen.has(fact.factId)) continue;
    seen.add(fact.factId);
    applyFact(parts, fact);
  }
  return Object.freeze(parts.slice());
}

/**
 * Pure append reducer for live durable facts. Facts should arrive in journal
 * order; use `messagePartsFromFacts` when rebuilding from an unordered batch.
 */
export function reduceMessagePartFact(
  current: readonly MessagePart[],
  fact: MessagePartFact,
): readonly MessagePart[] {
  validateFact(fact);
  if (current.some((part) => part.sourceFactIds.includes(fact.factId))) return current;
  const next = current.slice();
  const changed = applyFact(next, fact);
  return changed ? Object.freeze(next) : current;
}

/**
 * Projects the existing agent journal into renderable facts without changing
 * CanonicalMessage or the journal schema. The input may contain several turns
 * when `turnId` is supplied; callers rendering one turn may also pass a scoped
 * event slice directly.
 */
export function messagePartFactsFromDurableEvents(
  events: readonly DurableEvent[],
  options: DurableMessagePartOptions = {},
): readonly MessagePartFact[] {
  const scoped = options.turnId
    ? events.filter((event) => event.turnId === options.turnId)
    : events.slice();
  const requestedCallIds = new Set<string>();
  for (const event of scoped) {
    if (event.type !== "tool.requested") continue;
    const call = toolCallFrom(record(event.payload)?.call);
    if (call) requestedCallIds.add(call.id);
  }

  const facts: MessagePartFact[] = [];
  for (const event of scoped) {
    const payload = record(event.payload);
    if (
      event.type === "turn.requested" &&
      options.includeTurnRequest &&
      typeof payload?.content === "string"
    ) {
      facts.push({
        kind: "text",
        factId: eventFactId(event, "request"),
        sequence: event.sequence,
        text: payload.content,
        segmentId: `request:${event.eventId}`,
      });
      continue;
    }

    if (event.type === "assistant.completed") {
      const message = record(payload?.message);
      if (message?.role !== "assistant") continue;
      let ordinal = 0;
      if (typeof message.content === "string" && message.content.length > 0) {
        facts.push({
          kind: "text",
          factId: eventFactId(event, "text"),
          sequence: event.sequence,
          ordinal,
          text: message.content,
          segmentId: `assistant:${event.eventId}`,
        });
        ordinal += 1;
      }
      if (Array.isArray(message.toolCalls)) {
        for (let index = 0; index < message.toolCalls.length; index += 1) {
          const call = toolCallFrom(message.toolCalls[index]);
          if (!call || requestedCallIds.has(call.id)) continue;
          facts.push({
            kind: "tool-call",
            factId: eventFactId(event, `embedded-tool-${String(index)}`),
            sequence: event.sequence,
            ordinal,
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
          });
          ordinal += 1;
        }
      }
      continue;
    }

    if (event.type === "tool.requested") {
      const call = toolCallFrom(payload?.call);
      if (!call) continue;
      facts.push({
        kind: "tool-call",
        factId: eventFactId(event, "requested"),
        sequence: event.sequence,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      continue;
    }

    if (event.type === "tool.approved" && typeof payload?.callId === "string") {
      facts.push({
        kind: "tool-status",
        factId: eventFactId(event, "approved"),
        sequence: event.sequence,
        callId: payload.callId,
        status: "approved",
      });
      continue;
    }

    if (
      ["tool.resulted", "tool.failed", "tool.denied"].includes(event.type) &&
      typeof payload?.callId === "string" &&
      typeof payload.content === "string"
    ) {
      facts.push({
        kind: "tool-result",
        factId: eventFactId(event, "result"),
        sequence: event.sequence,
        callId: payload.callId,
        ...(typeof payload.name === "string" ? { name: payload.name } : {}),
        content: payload.content,
        ...(payload.metadata !== undefined ? { metadata: payload.metadata as JsonValue } : {}),
        status: event.type === "tool.denied"
          ? "denied"
          : event.type === "tool.failed" || payload.isError === true
            ? "error"
            : "success",
      });
      continue;
    }

    if (
      (event.type === "turn.failed" || event.type === "turn.cancelled") &&
      typeof payload?.error === "string"
    ) {
      facts.push({
        kind: "error",
        factId: eventFactId(event, "error"),
        sequence: event.sequence,
        summary: payload.error,
        code: event.type,
        retryable: event.type === "turn.failed",
      });
      continue;
    }

    if (event.type === "turn.completed" && options.includeTurnFooter !== false) {
      facts.push({
        kind: "footer",
        factId: eventFactId(event, "footer"),
        sequence: event.sequence,
        summary: "Turn completed.",
        ...(typeof payload?.receiptId === "string" ? { receiptId: payload.receiptId } : {}),
        recordedAt: event.recordedAt,
      });
    }
  }
  return Object.freeze(facts);
}

export function messagePartsFromDurableEvents(
  events: readonly DurableEvent[],
  options: DurableMessagePartOptions = {},
): readonly MessagePart[] {
  return messagePartsFromFacts(messagePartFactsFromDurableEvents(events, options));
}

/** A bounded, deterministic JSON display projection for tool cards. */
export function summarizeJson(
  value: JsonValue,
  maxChars: number = MESSAGE_PART_DISPLAY_LIMITS.toolArgumentsChars,
): string {
  assertPositiveLimit(maxChars);
  const context: JsonProjectionContext = {
    remainingNodes: MESSAGE_PART_DISPLAY_LIMITS.jsonNodes,
    path: new WeakSet<object>(),
  };
  let encoded: string;
  try {
    encoded = JSON.stringify(projectJson(value, 0, context)) ?? "null";
  } catch {
    encoded = "[Unserializable value]";
  }
  return boundedDisplayText(encoded, maxChars);
}

/** Replaces unsafe controls and truncates without leaving a dangling surrogate. */
export function boundedDisplayText(value: string, maxChars: number): string {
  assertPositiveLimit(maxChars);
  const normalized = value.replace(UNSAFE_DISPLAY_CONTROLS, "�");
  if (normalized.length <= maxChars) return normalized;
  if (maxChars === 1) return "…";
  let prefix = normalized.slice(0, maxChars - 1);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

/**
 * Plain visible projection used by copy and Memory ingestion. It contains the
 * public reasoning summary only; no hidden reasoning field exists in the model.
 */
export function messagePlainText(
  parts: readonly MessagePart[],
  maxChars: number = MESSAGE_PART_DISPLAY_LIMITS.plainTextChars,
): string {
  assertPositiveLimit(maxChars);
  let output = "";
  for (const part of parts) {
    const segment = partPlainText(part);
    if (!segment) continue;
    const next = output ? `${output}\n\n${segment}` : segment;
    if (next.length > maxChars) return boundedDisplayText(next, maxChars);
    output = next;
  }
  return output;
}

function applyFact(parts: MessagePart[], fact: MessagePartFact): boolean {
  if (fact.kind === "text") {
    if (!fact.text) return false;
    const text = boundedDisplayText(fact.text, MESSAGE_PART_DISPLAY_LIMITS.textChars);
    const previous = parts.at(-1);
    if (previous?.kind === "text" && previous.segmentId === fact.segmentId) {
      parts[parts.length - 1] = freezePart({
        ...previous,
        endSequence: Math.max(previous.endSequence, fact.sequence),
        sourceFactIds: appendSource(previous.sourceFactIds, fact.factId),
        content: boundedDisplayText(
          `${previous.content}${text}`,
          MESSAGE_PART_DISPLAY_LIMITS.textChars,
        ),
      });
    } else {
      parts.push(freezePart({
        ...basePart("text", fact),
        content: text,
        ...(fact.segmentId ? { segmentId: fact.segmentId } : {}),
      }));
    }
    return true;
  }

  if (fact.kind === "tool-call") {
    const existingIndex = parts.findIndex(
      (part): part is ToolCallPart => part.kind === "tool-call" && part.callId === fact.callId,
    );
    if (existingIndex >= 0) {
      const existing = parts[existingIndex] as ToolCallPart;
      parts[existingIndex] = freezePart({
        ...existing,
        endSequence: Math.max(existing.endSequence, fact.sequence),
        sourceFactIds: appendSource(existing.sourceFactIds, fact.factId),
        status: fact.status ?? existing.status,
      });
      return true;
    }
    const argumentsSummary = fact.argumentsSummary !== undefined
      ? boundedDisplayText(fact.argumentsSummary, MESSAGE_PART_DISPLAY_LIMITS.toolArgumentsChars)
      : fact.arguments !== undefined
        ? summarizeJson(fact.arguments)
        : "";
    parts.push(freezePart({
      ...basePart("tool-call", fact),
      callId: stableIdentifier(fact.callId, "tool call"),
      name: displayLabel(fact.name, "Unknown tool", 256),
      argumentsSummary,
      status: fact.status ?? "requested",
    }));
    return true;
  }

  if (fact.kind === "tool-status") {
    return updateToolCall(parts, fact.callId, fact.factId, fact.sequence, fact.status);
  }

  if (fact.kind === "tool-result") {
    const status = fact.status ?? "success";
    const capabilityTier = toolResultCapabilityTier(fact.metadata);
    updateToolCall(
      parts,
      fact.callId,
      fact.factId,
      fact.sequence,
      status === "success" ? "completed" : status === "denied" ? "denied" : "failed",
    );
    parts.push(freezePart({
      ...basePart("tool-result", fact),
      callId: stableIdentifier(fact.callId, "tool call"),
      ...(fact.name ? { name: displayLabel(fact.name, "Unknown tool", 256) } : {}),
      summary: boundedDisplayText(fact.content, MESSAGE_PART_DISPLAY_LIMITS.toolResultChars),
      ...(fact.metadata !== undefined
        ? { metadataSummary: summarizeJson(fact.metadata, MESSAGE_PART_DISPLAY_LIMITS.toolArgumentsChars) }
        : {}),
      ...(capabilityTier ? { capabilityTier } : {}),
      status,
    }));
    return true;
  }

  if (fact.kind === "reasoning-summary") {
    parts.push(freezePart({
      ...basePart("reasoning-summary", fact),
      summary: boundedDisplayText(
        fact.summary,
        MESSAGE_PART_DISPLAY_LIMITS.reasoningSummaryChars,
      ),
      ...(fact.label
        ? { label: displayLabel(fact.label, "Reasoning summary", 128) }
        : {}),
    }));
    return true;
  }

  if (fact.kind === "citation") {
    parts.push(freezePart({
      ...basePart("citation", fact),
      citationId: stableIdentifier(fact.citationId, "citation"),
      label: displayLabel(fact.label, "Source", MESSAGE_PART_DISPLAY_LIMITS.citationLabelChars),
      ...(fact.excerpt
        ? { excerpt: boundedDisplayText(fact.excerpt, MESSAGE_PART_DISPLAY_LIMITS.citationExcerptChars) }
        : {}),
      ...(fact.reference
        ? { reference: boundedDisplayText(fact.reference, MESSAGE_PART_DISPLAY_LIMITS.referenceChars) }
        : {}),
    }));
    return true;
  }

  if (fact.kind === "attachment") {
    parts.push(freezePart({
      ...basePart("attachment", fact),
      attachmentId: stableIdentifier(fact.attachmentId, "attachment"),
      name: displayLabel(
        fact.name,
        "Attachment",
        MESSAGE_PART_DISPLAY_LIMITS.attachmentNameChars,
      ),
      ...(fact.mediaType ? { mediaType: displayLabel(fact.mediaType, "application/octet-stream", 128) } : {}),
      ...(fact.sizeBytes !== undefined ? { sizeBytes: validSize(fact.sizeBytes) } : {}),
      ...(fact.summary
        ? { summary: boundedDisplayText(fact.summary, MESSAGE_PART_DISPLAY_LIMITS.attachmentSummaryChars) }
        : {}),
      ...(fact.reference
        ? { reference: boundedDisplayText(fact.reference, MESSAGE_PART_DISPLAY_LIMITS.referenceChars) }
        : {}),
      status: fact.status ?? "available",
    }));
    return true;
  }

  if (fact.kind === "error") {
    parts.push(freezePart({
      ...basePart("error", fact),
      summary: boundedDisplayText(fact.summary, MESSAGE_PART_DISPLAY_LIMITS.errorChars),
      ...(fact.code ? { code: displayLabel(fact.code, "error", 128) } : {}),
      retryable: fact.retryable ?? false,
    }));
    return true;
  }

  parts.push(freezePart({
    ...basePart("footer", fact),
    summary: boundedDisplayText(fact.summary, MESSAGE_PART_DISPLAY_LIMITS.footerChars),
    ...(fact.receiptId ? { receiptId: displayLabel(fact.receiptId, "receipt", 512) } : {}),
    ...(fact.recordedAt ? { recordedAt: boundedDisplayText(fact.recordedAt, 64) } : {}),
  }));
  return true;
}

export function toolResultCapabilityTier(
  metadata: JsonValue | undefined,
): SessionManifest["capabilityTier"] | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return parseCapabilityTier(metadata.capabilityTier);
}

function updateToolCall(
  parts: MessagePart[],
  callId: string,
  factId: string,
  sequence: number,
  status: ToolCallStatus,
): boolean {
  const index = parts.findIndex(
    (part): part is ToolCallPart => part.kind === "tool-call" && part.callId === callId,
  );
  if (index < 0) return false;
  const call = parts[index] as ToolCallPart;
  parts[index] = freezePart({
    ...call,
    endSequence: Math.max(call.endSequence, sequence),
    sourceFactIds: appendSource(call.sourceFactIds, factId),
    status,
  });
  return true;
}

function basePart<Kind extends MessagePartKind>(
  kind: Kind,
  fact: MessagePartFact,
): MessagePartBase<Kind> {
  return {
    id: `${kind}:${fact.factId}`,
    kind,
    sequence: fact.sequence,
    endSequence: fact.sequence,
    sourceFactIds: Object.freeze([fact.factId]),
  };
}

function appendSource(sourceFactIds: readonly string[], factId: string): readonly string[] {
  return sourceFactIds.includes(factId)
    ? sourceFactIds
    : Object.freeze([...sourceFactIds, factId]);
}

function freezePart<Part extends MessagePart>(part: Part): Part {
  return Object.freeze(part);
}

function partPlainText(part: MessagePart): string {
  if (part.kind === "text") return part.content;
  if (part.kind === "tool-call") {
    const heading = `Tool call · ${part.name} · ${part.status}`;
    return part.argumentsSummary ? `${heading}\n${part.argumentsSummary}` : heading;
  }
  if (part.kind === "tool-result") {
    const heading = `Tool result · ${part.name ?? part.callId} · ${part.status}`;
    return part.summary ? `${heading}\n${part.summary}` : heading;
  }
  if (part.kind === "reasoning-summary") {
    return `${part.label ?? "Reasoning summary"}\n${part.summary}`;
  }
  if (part.kind === "citation") {
    return [
      `Citation · ${part.label}`,
      part.excerpt,
      part.reference,
    ].filter((value): value is string => Boolean(value)).join("\n");
  }
  if (part.kind === "attachment") {
    const details = [part.mediaType, part.sizeBytes !== undefined ? `${String(part.sizeBytes)} bytes` : undefined]
      .filter((value): value is string => Boolean(value))
      .join(", ");
    return [
      `Attachment · ${part.name}${details ? ` (${details})` : ""} · ${part.status}`,
      part.summary,
      part.reference,
    ].filter((value): value is string => Boolean(value)).join("\n");
  }
  if (part.kind === "error") {
    return `Error${part.code ? ` · ${part.code}` : ""}\n${part.summary}`;
  }
  return [part.summary, part.receiptId ? `Receipt · ${part.receiptId}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

type JsonProjectionContext = {
  remainingNodes: number;
  path: WeakSet<object>;
};

function projectJson(value: JsonValue, depth: number, context: JsonProjectionContext): unknown {
  if (context.remainingNodes <= 0) return "…";
  context.remainingNodes -= 1;
  if (typeof value === "string") {
    return boundedDisplayText(value, MESSAGE_PART_DISPLAY_LIMITS.jsonStringChars);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (depth >= MESSAGE_PART_DISPLAY_LIMITS.jsonDepth) {
    return Array.isArray(value) ? "[…]" : "{…}";
  }
  if (context.path.has(value)) return "[Circular]";
  context.path.add(value);
  try {
    if (Array.isArray(value)) {
      const selected = value.slice(0, MESSAGE_PART_DISPLAY_LIMITS.jsonCollectionItems)
        .map((item) => projectJson(item, depth + 1, context));
      const omitted = value.length - selected.length;
      if (omitted > 0) selected.push(`… ${String(omitted)} more item${omitted === 1 ? "" : "s"}`);
      return selected;
    }

    const output: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    const selectedKeys = keys.slice(0, MESSAGE_PART_DISPLAY_LIMITS.jsonCollectionItems);
    for (const key of selectedKeys) {
      if (context.remainingNodes <= 0) break;
      const displayKey = boundedDisplayText(key, MESSAGE_PART_DISPLAY_LIMITS.jsonStringChars);
      output[displayKey] = projectJson(value[key]!, depth + 1, context);
    }
    const omitted = keys.length - selectedKeys.length;
    if (omitted > 0) output["…"] = `${String(omitted)} more field${omitted === 1 ? "" : "s"}`;
    return output;
  } finally {
    context.path.delete(value);
  }
}

function displayLabel(value: string, fallback: string, maxChars: number): string {
  const bounded = boundedDisplayText(value, maxChars).trim();
  return bounded || fallback;
}

function stableIdentifier(value: string, label: string): string {
  if (!value || value.length > MAX_FACT_ID_CHARS || UNSAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${label} identifier.`);
  }
  return value;
}

function validSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid attachment size.");
  return value;
}

function validateFact(fact: MessagePartFact): void {
  stableIdentifier(fact.factId, "message fact");
  if (fact.kind === "text" && fact.segmentId !== undefined) {
    stableIdentifier(fact.segmentId, "text segment");
  }
  if (!Number.isSafeInteger(fact.sequence) || fact.sequence < 0) {
    throw new Error("Message fact sequence must be a non-negative safe integer.");
  }
  if (fact.ordinal !== undefined && (!Number.isSafeInteger(fact.ordinal) || fact.ordinal < 0)) {
    throw new Error("Message fact ordinal must be a non-negative safe integer.");
  }
}

function assertPositiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Display limits must be positive safe integers.");
  }
}

function eventFactId(event: DurableEvent, suffix: string): string {
  return `${event.eventId}:${suffix}`;
}

function toolCallFrom(value: unknown): { id: string; name: string; arguments: JsonValue } | undefined {
  const call = record(value);
  if (!call || typeof call.id !== "string" || typeof call.name !== "string") return undefined;
  return {
    id: call.id,
    name: call.name,
    arguments: (call.arguments ?? null) as JsonValue,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
