import { useRef } from "preact/hooks";
import type { SessionManifest } from "../../core/contracts";
import { Icon } from "../icons";
import { PROFILE_APPROVAL_LABELS } from "../profiles-governance";
import { Seal, type SealState } from "../seal";
import { capabilityTierDetail, capabilityTierLabel } from "./capability-tier";
import { ASSISTANT_LENGTH_CODE } from "./message-parts";
import type { MessagePart, TextPart, ToolCallAuthority, ToolCallPart, ToolResultPart } from "./message-parts";
import { MarkdownView } from "./markdown";
import { useTranscriptOperations, type TranscriptOperationsMode } from "./transcript-operations";
import { useReasoningVisibility } from "./reasoning-visibility";
import { densityAllows, usePresentationDensity, type DensityTag } from "../density";
import "./message-parts-view.css";

export const DEFAULT_OPERATION_RENDER_LIMIT = 12;

/**
 * Which kind of presentation each narrative part *is*, for the Profile's
 * density preference. A part named here renders only when the density allows
 * its tag — minimal unmounts the reasoning block and the turn receipt footer
 * outright, re-mounting them when the density rises, because retired is
 * unrendered, never hidden. Parts not named here (text, tool work, errors,
 * citations, attachments) are the work itself or its consequences, and those
 * never leave the page.
 */
const NARRATIVE_PART_DENSITY_TAG: Partial<Record<NarrativePart["kind"], DensityTag>> = Object.freeze({
  "reasoning-summary": "commentary",
  footer: "proof",
} as const);

/** The count below which a summary header would hide more than it saves. */
export const OPERATION_COLLAPSE_THRESHOLD = 4;

export type MessagePartsViewProps = Readonly<{
  parts: readonly MessagePart[];
  streamedContent?: string;
  streaming?: boolean;
  /** True only while this row belongs to the currently running turn. */
  live?: boolean;
  /**
   * The failed turn's own way forward, when one exists.
   *
   * The error card said "Retry is available." and pointed at nothing: on a
   * desktop the controls it referred to were a hover-revealed toolbar with
   * Retry greyed out, and on a phone they were behind an unlabelled "•••"
   * disclosure with two of three disabled. A recovery verb belongs in the card
   * that reports the failure, at every width, without a gesture.
   */
  onRetry?: () => void;
}>;

export function MessagePartsView({
  parts,
  streamedContent,
  streaming = false,
  live = false,
  onRetry,
}: MessagePartsViewProps) {
  const tail = streamedMessageTail(parts, streamedContent ?? "", streaming);
  const nodes = pairOperations(parts);
  const answerId = streaming ? undefined : answerPartId(parts);
  const mode = useTranscriptOperations();
  return (
    <div class="message-parts" role="group" aria-label="Message contents">
      {nodes.map((node) => node.kind === "operations"
        ? <OperationStrip key={node.id} node={node} mode={mode} />
        : <MessagePartView key={node.part.id} part={node.part} answer={node.part.id === answerId} live={live} onRetry={onRetry} />)}
      {/* No `aria-live` on the streaming tail: every delta mutating a polite
          region is a screen-reader backlog, one queued utterance per token.
          Both ends of the turn are announced by `chat/turn-narration.ts`, which
          owns the one region the whole lifecycle speaks through. */}
      {tail ? <div class="message-part text text--answer streaming"><MarkdownView source={tail} streaming /></div> : null}
    </div>
  );
}

/**
 * Bounds the transcript at the first operation beyond the limit. The complete
 * chronological suffix is retained: with one row per invocation the remainder
 * renders as further rows in the same strip rather than a nested disclosure,
 * so later prose, citations, and results still cannot leap ahead of the tool
 * step they depend on. The header states that the whole run is shown in order.
 */
export function boundedMessageParts(parts: readonly MessagePart[], limit = DEFAULT_OPERATION_RENDER_LIMIT): Readonly<{
  visible: readonly MessagePart[];
  overflow: readonly MessagePart[];
  operationCount: number;
}> {
  let operations = 0;
  let boundary = parts.length;
  for (let index = 0; index < parts.length; index += 1) {
    if (!isOperationPart(parts[index]!)) continue;
    operations += 1;
    if (operations > limit) { boundary = index; break; }
  }
  return Object.freeze({
    visible: Object.freeze(parts.slice(0, boundary)),
    overflow: Object.freeze(parts.slice(boundary)),
    operationCount: parts.filter(isOperationPart).length,
  });
}

export function streamedMessageTail(
  _parts: readonly MessagePart[],
  streamedContent: string,
  streaming: boolean,
): string {
  return streaming ? streamedContent : "";
}

export const OPERATION_OUTCOMES = ["ran", "running", "failed", "denied", "queued", "abandoned"] as const;

export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

export type PairedOperation = Readonly<{
  id: string;
  callId: string;
  name: string;
  /** Durable sequence of the call; equal sequences were issued together. */
  sequence: number;
  outcome: OperationOutcome;
  /** The sentence the 17px row title used to carry, kept verbatim. */
  statusSentence: string;
  argumentsSummary: string;
  argumentDigest: string;
  resultSummary?: string;
  resultDigest: string;
  metadataSummary?: string;
  capabilityTier?: SessionManifest["capabilityTier"];
  /** Who authorised this call, when its approval recorded readable provenance. */
  authority?: ToolCallAuthority;
  /** A result whose originating call is absent renders with the half marked. */
  hasCall: boolean;
  hasResult: boolean;
}>;

export type OperationGroup = Readonly<{
  id: string;
  parallel: boolean;
  operations: readonly PairedOperation[];
}>;

export type OperationsNode = Readonly<{
  kind: "operations";
  id: string;
  groups: readonly OperationGroup[];
  operations: readonly PairedOperation[];
}>;

/** Every part that is not half of an invocation renders as itself. */
export type NarrativePart = Exclude<MessagePart, ToolCallPart | ToolResultPart>;

export type TranscriptNode =
  | Readonly<{ kind: "part"; part: NarrativePart }>
  | OperationsNode;

/**
 * One row per invocation, not per message part. A result folds into the call
 * that produced it and renders at the call's chronological index, so a single
 * tool step can never again occupy two full-width cards. Each maximal run of
 * consecutive operations becomes one strip.
 */
export function pairOperations(parts: readonly MessagePart[]): readonly TranscriptNode[] {
  const terminal = turnReachedTerminal(parts);
  const results = new Map<string, ToolResultPart>();
  for (const part of parts) {
    if (part.kind === "tool-result" && !results.has(part.callId)) results.set(part.callId, part);
  }
  const nodes: TranscriptNode[] = [];
  const folded = new Set<string>();
  let run: PairedOperation[] = [];
  const closeRun = () => {
    if (run.length) nodes.push(operationsNode(run));
    run = [];
  };
  for (const part of parts) {
    if (part.kind === "tool-call") {
      const result = results.get(part.callId);
      if (result) folded.add(result.id);
      run.push(pairedOperation(part, result, terminal));
      continue;
    }
    if (part.kind === "tool-result") {
      // A second result for one call, or a result whose call never landed, is
      // never swallowed: it renders as its own row with the missing half named.
      if (folded.has(part.id)) continue;
      run.push(pairedOperation(undefined, part, terminal));
      continue;
    }
    // A provider that emits a blank text delta between two calls must not slice
    // one run into two strips: the part still renders, it simply renders no
    // pixels and no words, so it cannot be the thing that separates them.
    if (!isBlankText(part)) closeRun();
    nodes.push(Object.freeze({ kind: "part", part } as const));
  }
  closeRun();
  return Object.freeze(nodes);
}

/**
 * Whether the turn these parts belong to has already ended.
 *
 * A stop cancels the turn's AbortSignal, which is precisely what prevents the
 * settling `tool.*` appends from ever being written, so a stopped turn's calls
 * stay `requested`/`approved` in the journal for ever. Reading those statuses
 * alone, the strip said "Working" on a turn that ended minutes ago and kept
 * saying it after a reload. The terminal facts are already in the same parts
 * list — the durable cancellation/failure error and the turn footer — so the
 * strip asks them instead of asking a status that can never change again.
 */
export function turnReachedTerminal(parts: readonly MessagePart[]): boolean {
  return parts.some((part) =>
    part.kind === "footer"
    || (part.kind === "error" && (part.code === "turn.cancelled" || part.code === "turn.failed")));
}

export function operationStripState(
  operations: readonly PairedOperation[],
  mode: TranscriptOperationsMode = "summary",
): Readonly<{
  active: boolean;
  settled: boolean;
  /** A failure or a denial keeps the rows on screen whatever the preference. */
  forced: boolean;
  collapsible: boolean;
  headline: string;
}> {
  const active = operations.some((operation) => operation.outcome === "running" || operation.outcome === "queued");
  // A step that never got to finish is as much a reason to keep the rows on
  // screen as one that failed: it is the evidence of what the stop interrupted.
  const forced = operations.some((operation) =>
    operation.outcome === "failed" || operation.outcome === "denied" || operation.outcome === "abandoned");
  const settled = !active;
  return Object.freeze({
    active,
    settled,
    forced,
    collapsible: mode === "summary"
      && settled
      && !forced
      && operations.length >= OPERATION_COLLAPSE_THRESHOLD,
    headline: operationHeadline(operations, active),
  });
}

/**
 * The collapsed header must state everything the rows state at a glance:
 * how many steps ran, which tools ran them, and how they ended. It never
 * hides *that* a step occurred or *which* tool ran.
 */
export function operationHeadline(operations: readonly PairedOperation[], active: boolean): string {
  const steps = `${String(operations.length)} step${operations.length === 1 ? "" : "s"}`;
  if (active) return `Working · ${steps}`;
  const clauses = [steps, toolClause(operations), outcomeClause(operations)];
  const parallel = parallelClause(operations);
  if (parallel) clauses.push(parallel);
  // The chronological remainder is no longer a nested disclosure, so the
  // header states what the old "show chronological remainder" summary stated.
  if (operations.length > DEFAULT_OPERATION_RENDER_LIMIT) clauses.push("all shown in order");
  return clauses.filter(Boolean).join(" · ");
}

function parallelClause(operations: readonly PairedOperation[]): string {
  const batches = new Map<number, number>();
  for (const operation of operations) batches.set(operation.sequence, (batches.get(operation.sequence) ?? 0) + 1);
  const sizes = [...batches.values()].filter((size) => size > 1);
  if (!sizes.length) return "";
  return sizes.length === 1
    ? `${String(sizes[0])} in parallel`
    : `${String(sizes.length)} parallel batches`;
}

function toolClause(operations: readonly PairedOperation[]): string {
  const counts = new Map<string, number>();
  for (const operation of operations) counts.set(operation.name, (counts.get(operation.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => count > 1 ? `${name} ×${String(count)}` : name).join(", ");
}

function outcomeClause(operations: readonly PairedOperation[]): string {
  if (operations.every((operation) => operation.outcome === "ran")) return "all completed";
  const counts = new Map<OperationOutcome, number>();
  for (const operation of operations) counts.set(operation.outcome, (counts.get(operation.outcome) ?? 0) + 1);
  return OPERATION_OUTCOMES
    .filter((outcome) => counts.has(outcome))
    .map((outcome) => `${String(counts.get(outcome))} ${OUTCOME_COPY[outcome].clause}`)
    .join(", ");
}

/**
 * One table for the whole outcome vocabulary: the row's visible word, the seal
 * shape beside it, the header's counted clause, and the full sentence a screen
 * reader hears — which is verbatim the sentence the old 17px card title
 * carried, so nothing a reader could hear before is lost.
 */
const OUTCOME_COPY: Readonly<Record<OperationOutcome, Readonly<{
  word: string;
  clause: string;
  sentence: string;
  seal: SealState;
}>>> = Object.freeze({
  ran: { word: "Ran", clause: "completed", sentence: "Tool step completed", seal: "verified" },
  running: { word: "Running…", clause: "running", sentence: "Tool step running", seal: "checking" },
  failed: { word: "Failed", clause: "failed", sentence: "Tool step failed", seal: "failed" },
  denied: { word: "Denied", clause: "denied", sentence: "Tool step denied", seal: "failed" },
  // The seal vocabulary's own "not checked" belongs to an unverified proof, not
  // to a step waiting on a person; borrowing it announced a pending approval as
  // a failed verification.
  queued: { word: "Queued", clause: "queued", sentence: "Tool step queued — waiting for your approval", seal: "none" },
  // A step the turn ended underneath. Not a failure — nothing went wrong with
  // it — but not settled either, so it wears the attention seal rather than the
  // completed one.
  abandoned: { word: "Stopped", clause: "stopped", sentence: "Tool step stopped before it completed", seal: "attention" },
});

function operationsNode(operations: readonly PairedOperation[]): OperationsNode {
  const groups: { id: string; operations: PairedOperation[] }[] = [];
  for (const operation of operations) {
    const last = groups.at(-1);
    // Equal durable sequence means one provider message issued them together.
    if (last && last.operations[0]!.sequence === operation.sequence) last.operations.push(operation);
    else groups.push({ id: operation.id, operations: [operation] });
  }
  return Object.freeze({
    kind: "operations",
    id: `operations:${operations[0]!.id}`,
    groups: Object.freeze(groups.map((group) => Object.freeze({
      id: group.id,
      parallel: group.operations.length > 1,
      operations: Object.freeze(group.operations.slice()),
    }))),
    operations: Object.freeze(operations.slice()),
  });
}

function pairedOperation(
  call: ToolCallPart | undefined,
  result: ToolResultPart | undefined,
  terminal: boolean,
): PairedOperation {
  const anchor = call ?? result!;
  const outcome = pairedOutcome(call, result, terminal);
  return Object.freeze({
    id: anchor.id,
    callId: anchor.callId,
    name: call?.name ?? result?.name ?? anchor.callId,
    sequence: anchor.sequence,
    outcome,
    statusSentence: OUTCOME_COPY[outcome].sentence,
    argumentsSummary: call?.argumentsSummary ?? "",
    argumentDigest: call ? scalarDigest(call.argumentsSummary) : "Originating call not recorded",
    ...(result ? { resultSummary: result.summary } : {}),
    resultDigest: result ? resultDigest(result) : "",
    ...(result?.metadataSummary ? { metadataSummary: result.metadataSummary } : {}),
    ...(result?.capabilityTier ? { capabilityTier: result.capabilityTier } : {}),
    ...(call?.authority ? { authority: call.authority } : {}),
    hasCall: call !== undefined,
    hasResult: result !== undefined,
  });
}

/**
 * The authority a resting row shows, and the sentence it shows it with.
 *
 * Read effects are auto-allowed in every mode, so "Read-only, automatic" on a
 * `read_file` row states the rule rather than a decision — it would print on
 * nearly every row and teach a reader to stop reading the column that matters.
 * The rows that carry an accountability claim are the ones where somebody or
 * something let an *effect* through, so those are the ones the resting row
 * names; the sheet still states the authority of every approved call, read
 * effects included, because "nothing shown" must never be how the transcript
 * says "allowed automatically".
 */
export function operationAuthorityChip(operation: PairedOperation): Readonly<{
  source: ToolCallAuthority["source"];
  label: string;
  title: string;
}> | undefined {
  const authority = operation.authority;
  if (!authority || authority.source === "automatic-read") return undefined;
  return Object.freeze({ source: authority.source, label: authority.label, title: authorityTitle(authority) });
}

/** The mode name is the governance vocabulary verbatim, never a fourth wording. */
function authorityTitle(authority: ToolCallAuthority): string {
  return `${authority.label} · recorded under ${PROFILE_APPROVAL_LABELS[authority.mode]}`;
}

/**
 * A settled call is read from its own record; an unsettled one is read from
 * the turn.
 *
 * `approved` was doing double duty as "permission granted" and "currently
 * executing" while wearing the settled-positive seal, because execution start
 * is only ever a transient signal and never a durable status. An approved call
 * with no result *is* the executing state, so it renders as one — and once the
 * turn is over, no unsettled call is executing anything, so every one of them
 * reads as stopped rather than as work that is still going on.
 */
function pairedOutcome(
  call: ToolCallPart | undefined,
  result: ToolResultPart | undefined,
  terminal: boolean,
): OperationOutcome {
  if (result?.status === "denied" || call?.status === "denied") return "denied";
  if (result?.status === "error" || call?.status === "failed") return "failed";
  if (result?.status === "success" || call?.status === "completed") return "ran";
  if (terminal) return "abandoned";
  if (call?.status === "running" || call?.status === "approved") return "running";
  return "queued";
}

/**
 * The resting row promotes the first scalar the arguments carry — the path, the
 * query, the command — because that is the argument a reader is scanning for.
 * The complete bounded JSON is one gesture away in the sheet.
 */
export function scalarDigest(argumentsSummary: string): string {
  if (!argumentsSummary) return "";
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsSummary); } catch { return argumentsSummary; }
  const first = firstScalar(parsed);
  return first ?? argumentsSummary;
}

function firstScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const scalar = firstScalar(item);
      if (scalar !== undefined) return scalar;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const scalar = firstScalar(item);
      if (scalar !== undefined) return scalar;
    }
  }
  return undefined;
}

const DIGEST_ENCODER = new TextEncoder();
const DIGEST_BYTE_KEYS = ["originalContentBytes", "bytes", "byteLength", "size"] as const;
const DIGEST_COUNT_KEYS = ["count", "files", "matches", "entries", "items", "total"] as const;

/**
 * A size or a count the tool itself reported is authoritative; the length of a
 * bounded display projection is not, so a truncated body reports "+" rather
 * than claiming a size it cannot see the end of.
 */
export function resultDigest(result: ToolResultPart): string {
  if (result.status !== "success") return firstClause(result.summary);
  const metadata = parseRecord(result.metadataSummary);
  if (metadata) {
    for (const key of DIGEST_BYTE_KEYS) {
      const value = metadata[key];
      if (typeof value === "number") return formatBytes(value);
    }
    for (const key of DIGEST_COUNT_KEYS) {
      const value = metadata[key];
      if (typeof value === "number") return `${String(value)} ${key === "count" ? "items" : key}`;
    }
  }
  if (!result.summary) return "";
  const bytes = DIGEST_ENCODER.encode(result.summary).length;
  return `${formatBytes(bytes)}${result.summary.endsWith("…") ? "+" : ""}`;
}

function parseRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch { return undefined; }
}

function firstClause(summary: string): string {
  const clause = summary.split(/[.\n]/u)[0]?.trim() ?? "";
  return clause.length > 72 ? `${clause.slice(0, 71)}…` : clause;
}

function OperationStrip({ node, mode }: { node: OperationsNode; mode: TranscriptOperationsMode }) {
  const state = operationStripState(node.operations, mode);
  const strip = useRef<HTMLElement>(null);
  const anchor = useRef<Readonly<{ scroller: HTMLElement; element: HTMLElement; top: number }>>();

  /**
   * Answer anchoring. A disclosure that pushes the prose a reader is mid-way
   * through is a disclosure they will not use twice, so the scroll container
   * absorbs the growth: measure the answer before the toggle commits, and
   * repay the difference after it does.
   */
  const capture = () => { anchor.current = measureAnswer(strip.current); };
  const settle = (details: HTMLDetailsElement) => {
    const section = strip.current;
    // One open sheet per strip; the strip's own fold is not one of the sheets.
    if (section && details.open && details.classList.contains("op")) {
      for (const sibling of section.querySelectorAll<HTMLDetailsElement>("details.op[open]")) {
        if (sibling !== details) sibling.open = false;
      }
    }
    const captured = anchor.current;
    anchor.current = undefined;
    if (!captured) return;
    const moved = captured.element.getBoundingClientRect().top - captured.top;
    if (moved) captured.scroller.scrollTop += moved;
  };

  const rows = node.groups.map((group) => (
    <div
      key={group.id}
      class="op-group"
      data-parallel={group.parallel ? "true" : "false"}
      {...(group.parallel
        ? { role: "group", "aria-label": `${String(group.operations.length)} steps issued together` }
        : {})}
    >
      {group.operations.map((operation) => (
        <OperationRow key={operation.id} operation={operation} onCapture={capture} onSettle={settle} />
      ))}
    </div>
  ));

  const header = (
    <>
      {state.active
        ? <Seal state="checking" density="dot" size={16} label="Working" acting />
        : <span class="op-strip__mark" aria-hidden="true">⟡</span>}
      <span class="op-strip__headline" title={state.headline}>{state.headline}</span>
      {state.collapsible
        ? <span class="op-strip__toggle">Show steps</span>
        : state.forced ? <span class="op-strip__toggle">Steps stay open</span> : null}
    </>
  );

  return (
    <section
      ref={strip}
      class="op-strip"
      data-active={state.active ? "true" : "false"}
      /* A named `section` is a landmark, and a turn may hold several strips. */
      role="group"
      aria-label={`Tool steps · ${state.headline}`}
    >
      {state.collapsible ? (
        <details class="op-strip__fold" onToggle={(event) => settle(event.currentTarget as unknown as HTMLDetailsElement)}>
          <summary class="op-strip__header" onClick={capture}>{header}</summary>
          <div class="op-strip__rows">{rows}</div>
        </details>
      ) : (
        <>
          {/* Under four steps a header states nothing the rows do not. */}
          {node.operations.length >= OPERATION_COLLAPSE_THRESHOLD || state.active
            ? <p class="op-strip__header" {...(state.active ? { role: "status" } : {})}>{header}</p>
            : null}
          <div class="op-strip__rows">{rows}</div>
        </>
      )}
    </section>
  );
}

function OperationRow({ operation, onCapture, onSettle }: {
  operation: PairedOperation;
  onCapture(): void;
  onSettle(details: HTMLDetailsElement): void;
}) {
  const density = usePresentationDensity();
  const tier = operation.capabilityTier;
  const chip = operationAuthorityChip(operation);
  return (
    <details class="op" data-outcome={operation.outcome} onToggle={(event) => onSettle(event.currentTarget as unknown as HTMLDetailsElement)}>
      <summary class="op__summary" onClick={onCapture}>
        <span class="op__outcome" title={operation.statusSentence}>
          <Seal
            state={OUTCOME_COPY[operation.outcome].seal}
            density="dot"
            size={16}
            label={operation.statusSentence}
            acting={operation.outcome === "running"}
          />
          <span aria-hidden="true">{OUTCOME_COPY[operation.outcome].word}</span>
          {/* Inside the outcome cell, not a sixth grid column: the constant
              five-column height is what keeps a completing step from jumping
              the rows beneath it. */}
          {chip
            ? <span class="op__authority" data-source={chip.source} title={chip.title}>{chip.label}</span>
            : null}
        </span>
        <span class="op__name">{operation.name}</span>
        <span class="op__arguments">{operation.argumentDigest}</span>
        <span class="op__result">{operation.resultDigest}</span>
      </summary>
      <div class="op__body">
        {operation.authority ? (
          <p class="op__sheet-head">
            <span class="op__label">Authority</span>
            <span class="op__authority-detail">{authorityTitle(operation.authority)}</span>
          </p>
        ) : null}
        <p class="op__sheet-head">
          <span class="op__label">Arguments · bounded display</span>
          {/* The call id is raw internal addressing: it sits here for
              instrumented eyes, and the whole line stays one action away in
              the journal either way. */}
          {densityAllows("raw", density) ? <code class="op__call-id" title={`Tool call ${operation.callId}`}>{operation.callId}</code> : null}
        </p>
        <pre>{operation.hasCall ? operation.argumentsSummary || "No arguments" : "This result has no recorded originating call."}</pre>
        <p class="op__sheet-head">
          <span class="op__label" {...(tier ? { title: capabilityTierDetail(tier) } : {})}>
            Result{tier ? ` · ${capabilityTierLabel(tier)}` : ""}
          </span>
        </p>
        <pre>{operation.hasResult ? operation.resultSummary || "No visible output" : "No result is recorded for this call yet."}</pre>
        {operation.metadataSummary ? <><p class="op__sheet-head"><span class="op__label">Metadata · bounded display</span></p><pre>{operation.metadataSummary}</pre></> : null}
      </div>
    </details>
  );
}

function measureAnswer(strip: HTMLElement | null): Readonly<{ scroller: HTMLElement; element: HTMLElement; top: number }> | undefined {
  const element = strip?.closest(".message-parts")?.querySelector<HTMLElement>(".message-part.text--answer");
  const scroller = element ? scrollableAncestor(element) : undefined;
  return element && scroller
    ? Object.freeze({ scroller, element, top: element.getBoundingClientRect().top })
    : undefined;
}

/**
 * Scrollability is deliberately not required here: a conversation that fits
 * exactly is the case where an expansion first pushes the answer down, and by
 * the time the correction runs the container has the room to absorb it.
 */
function scrollableAncestor(element: HTMLElement): HTMLElement | undefined {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return undefined;
}

/**
 * The answer is the last prose of a settled turn. Interstitial narration keeps
 * its supporting size, so the thing the person asked for is the visual subject
 * of the message rather than the largest machinery above it.
 */
function answerPartId(parts: readonly MessagePart[]): string | undefined {
  if (parts.some((part) => !isSettledOperation(part))) return undefined;
  return parts.filter((part): part is TextPart => part.kind === "text").at(-1)?.id;
}

function isSettledOperation(part: MessagePart): boolean {
  return part.kind !== "tool-call"
    || part.status === "completed"
    || part.status === "failed"
    || part.status === "denied";
}

export function errorPartRole(live: boolean): "alert" | undefined {
  return live ? "alert" : undefined;
}

function MessagePartView({ part, answer, live, onRetry }: {
  part: NarrativePart;
  answer: boolean;
  live: boolean;
  onRetry?: () => void;
}) {
  const reasoningVisibility = useReasoningVisibility();
  const density = usePresentationDensity();
  const partTag = NARRATIVE_PART_DENSITY_TAG[part.kind];
  /* Retired means unrendered: a tagged part the density refuses never mounts
     at all, and it returns the frame the density re-raises it. The journal,
     the receipts and the reasoning record are untouched — this page simply
     spends less. */
  if (partTag && !densityAllows(partTag, density)) return null;
  if (part.kind === "text") {
    return <div class={answer ? "message-part text text--answer" : "message-part text"}><MarkdownView source={part.content} /></div>;
  }

  if (part.kind === "reasoning-summary") {
    /*
     * One control, two defaults. Collapsed — the Profile default — the part
     * is a headline line that opens on demand; expanded, the profile asked
     * for the whole reasoning up front and the fold is not offered, exactly
     * like tool steps under "Every step". The text itself is only ever what
     * the provider exposed; the part says so rather than letting the block
     * read as the model's private mind.
     */
    if (part.full) {
      const provenance = "Shown as the provider exposed it";
      if (reasoningVisibility === "expanded") {
        return (
          <article class="message-part reasoning-summary reasoning-full">
            <header><Icon name="context" size={14} /><span>{part.label ?? "Reasoning"}</span><small>{provenance}</small></header>
            <p class="reasoning-summary__headline">{part.summary}</p>
            <pre class="reasoning-summary__text">{part.full}</pre>
          </article>
        );
      }
      return (
        <details class="message-part reasoning-summary reasoning-full">
          <summary><Icon name="context" size={14} /><span>{part.label ?? "Reasoning"}</span><small>{`${provenance} · ${part.full.length.toLocaleString()} characters`}</small></summary>
          <pre class="reasoning-summary__text">{part.full}</pre>
        </details>
      );
    }
    return (
      <details class="message-part reasoning-summary">
        <summary><Icon name="context" size={14} /><span>{part.label ?? "Reasoning summary"}</span><small>Public summary</small></summary>
        <p>{part.summary}</p>
      </details>
    );
  }

  if (part.kind === "citation") {
    return (
      <article class="message-part reference citation">
        <header><Icon name="source" size={14} /><span>Citation</span><strong>{part.label}</strong></header>
        {part.excerpt ? <p>{part.excerpt}</p> : null}
        {part.reference ? <code>{part.reference}</code> : null}
      </article>
    );
  }

  if (part.kind === "attachment") {
    return (
      <article class={`message-part reference attachment ${part.status}`}>
        <header><Icon name="file" size={14} /><span>Attachment</span><strong>{part.name}</strong><small>{part.status}</small></header>
        {part.previewUrl ? <details class="attachment-preview"><summary aria-label={`Preview ${part.name}`}><img src={part.previewUrl} alt="" /></summary><img src={part.previewUrl} alt={`Attached image ${part.name}`} /></details> : null}
        <div class="attachment-meta">
          {part.mediaType ? <span>{part.mediaType}</span> : null}
          {part.sizeBytes !== undefined ? <span>{formatBytes(part.sizeBytes)}</span> : null}
        </div>
        {part.summary ? <p>{part.summary}</p> : null}
        {part.reference ? <code>{part.reference}</code> : null}
      </article>
    );
  }

  if (part.kind === "error") {
    return (
      <div class="message-part part-error" role={errorPartRole(live)} {...(part.code ? { "data-code": part.code } : {})}>
        <Icon name="warning" size={15} />
        <div>
          <strong {...(part.code ? { title: part.code } : {})}>{errorHeading(part.code)}</strong>
          <p>{part.summary}</p>
          {/* The claim only survives while something can act on it. With a
              handler the card carries the verb itself; without one it says
              nothing, because "Retry is available." over a disabled control is
              the failure this whole card is supposed to be honest about. */}
          {part.retryable && onRetry
            ? <button class="small-button part-error__retry" type="button" onClick={onRetry}>Send this prompt again</button>
            : null}
        </div>
      </div>
    );
  }

  return (
    <footer class="message-part part-footer">
      <span>{part.summary}</span>
      {part.recordedAt ? <time dateTime={part.recordedAt}>{formatRecordedAt(part.recordedAt)}</time> : null}
    </footer>
  );
}

/**
 * Every durable code an error part can carry, in the reader's words.
 *
 * A local command is its own group, not an agent turn (session-message-
 * presentation.ts builds it from `local.command.*`), so its failures must not
 * borrow turn vocabulary: a cancelled `/command` ended a command, not a turn.
 */
const ERROR_HEADINGS: Readonly<Record<string, string>> = Object.freeze({
  "turn.cancelled": "Turn stopped",
  "turn.failed": "Turn failed",
  "local.command.cancelled": "Command cancelled",
  "local.command.failed": "Command failed",
  // The turn itself succeeded — the provider answered, the receipt is real, the
  // footer below is true. What failed is the *answer*, and the heading has to
  // say so without borrowing turn vocabulary that would contradict the footer
  // one element away.
  [ASSISTANT_LENGTH_CODE]: "Response was cut off",
});

/**
 * The heading of an error part, in words rather than in journal vocabulary.
 *
 * `code` is the machine-readable durable event type. Printing it made the
 * transcript head a paragraph with `turn.cancelled`, which is a string a reader
 * has no way to interpret and which names an implementation detail of the
 * journal. It is kept on the element as `data-code`/`title` so the record can
 * still be traced back to the event that produced it.
 *
 * An unrecognised code gets a heading that asserts nothing about *what* ended,
 * because a wrong claim ("Turn ended" over a local command) is worse than a
 * vague one: the summary underneath and the traced code still carry the truth.
 */
export function errorHeading(code?: string): string {
  if (code === undefined) return "Turn stopped safely";
  return ERROR_HEADINGS[code] ?? "Something went wrong";
}

function isBlankText(part: MessagePart): boolean {
  return part.kind === "text" && part.content.trim() === "";
}

function isOperationPart(part: MessagePart): boolean {
  return part.kind === "tool-call" || part.kind === "tool-result";
}

function formatBytes(size: number): string {
  if (size < 1_024) return `${String(size)} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KiB`;
  return `${(size / 1_048_576).toFixed(1)} MiB`;
}

function formatRecordedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp)
    : "Recorded";
}
