import { CONVERSATION_NAMED_EVENT_TYPE, HUMAN_INTENT_EVENT_TYPE, TERMINAL_ACTIVITY_EVENT_TYPE, type JsonValue } from "../core/contracts";
import { canonicalContextSelection, type CanonicalContextHit } from "../core/context-selection";
import type { DurableEvent } from "../core/journal";

/*
 * What this session actually did, read from the journal Proof already audits.
 *
 * The one cause behind four measured journeys. Proof could only report what
 * `SessionAuditReport["counts"]` classifies, and it never read the events
 * themselves — so:
 *
 * - a `/read` turn that the transcript badged "COMPLETED TURN" appeared here
 *   only as the integer `1`, with no record of what ran (J048);
 * - the sources the turn seam selects and journals as `turn.context.selected`
 *   — path, revision, chunk id, content digest, every one of them already
 *   sealed into a digest the audit verifies — were readable nowhere in the
 *   product, so a receipt that binds request and response bytes was the whole
 *   of "where did this answer come from" (J049);
 * - a deep link carrying `session`, `receipt` and `turn` rendered no turn, so
 *   Proof named neither the conversation nor the message it was opened for and
 *   offered nothing that went back (J050);
 * - two Git commits made under two human approvals are journaled as
 *   `human.intent.reviewed` and validated by the audit, but `counts` has no
 *   field for them, so a person who had just committed read four zeros (J069).
 *
 * Nothing here is computed that the journal does not already hold. It is read,
 * which is the whole of the fix this module is.
 */

/** One recorded unit of work, in the vocabulary a reader already met. */
export type ProofActivityKind =
  | "provider-turn"
  | "local-command"
  | "approved-effect"
  | "shell"
  | "naming";

export type ProofGroundingSource = Readonly<{
  path: string;
  revision: string;
  chunkId: string;
  chunkIndex: number;
  contentDigest: string;
  score: number;
  corpus?: string;
}>;

export type ProofActivityRow = Readonly<{
  /** Stable within one journal read; the turn id when there is one. */
  id: string;
  kind: ProofActivityKind;
  /** The journal sequence this row opened at — the reader's ordering key. */
  sequence: number;
  recordedAt: string;
  /** Present only for rows the chat transcript can be returned to. */
  turnId?: string;
  /** What was asked or done, bounded and control-character free. */
  title: string;
  outcome: "completed" | "failed" | "cancelled" | "denied" | "running" | "recorded";
  /** The state word this row renders. One vocabulary with the transcript. */
  outcomeLabel: string;
  receiptId?: string;
  /**
   * Why this row carries no receipt, when a reader could expect one. Absent
   * when a receipt is present, and absent for rows that are not turns.
   */
  receiptNote?: string;
  /** The sources this turn's answer was selected from, in journal order. */
  grounding: readonly ProofGroundingSource[];
  /** Bytes the selection bound, from the sealed selection. */
  groundingBytes?: number;
  /** True when the selection reports it was cut at its own ceiling. */
  groundingTruncated?: boolean;
  /** Extra facts a row type carries: an effect's target, a shell exit code. */
  facts: readonly Readonly<{ label: string; value: string }>[];
}>;

export type ProofActivityLedger = Readonly<{
  rows: readonly ProofActivityRow[];
  /** Events the reader can see accounted for in `rows`, and the total read. */
  accountedEvents: number;
  totalEvents: number;
}>;

const MAX_ROWS = 200;
const MAX_TITLE = 120;

export function proofActivityLedger(events: readonly DurableEvent[]): ProofActivityLedger {
  const turns = new Map<string, Mutable>();
  const order: Mutable[] = [];
  let accounted = 0;

  const openTurn = (event: DurableEvent, kind: ProofActivityKind, title: string): Mutable | undefined => {
    const turnId = event.turnId;
    if (!turnId) return undefined;
    const existing = turns.get(turnId);
    if (existing) return existing;
    const row: Mutable = {
      id: turnId,
      kind,
      sequence: event.sequence,
      recordedAt: event.recordedAt,
      turnId,
      title,
      outcome: "running",
      outcomeLabel: kind === "local-command" ? "Running on this device" : "In progress",
      grounding: [],
      facts: [],
    };
    turns.set(turnId, row);
    order.push(row);
    return row;
  };

  for (const event of events) {
    const payload = record(event.payload);
    switch (event.type) {
      case "turn.requested": {
        openTurn(event, "provider-turn", bounded(payload?.content) ?? "Turn");
        accounted += 1;
        continue;
      }
      case "local.command.requested": {
        const row = openTurn(event, "local-command", bounded(payload?.content) ?? "Local command");
        if (row) {
          const tool = bounded(payload?.toolName);
          if (tool) row.facts = [...row.facts, { label: "Tool", value: tool }];
        }
        accounted += 1;
        continue;
      }
      case "turn.context.selected": {
        const row = event.turnId ? turns.get(event.turnId) : undefined;
        const selection = canonicalContextSelection(payload?.contextSelection);
        if (row && selection) {
          row.grounding = selection.hits.map(groundingSource);
          row.groundingBytes = selection.selectedBytes;
          row.groundingTruncated = selection.truncated;
        }
        accounted += 1;
        continue;
      }
      case "turn.completed": {
        const row = event.turnId ? turns.get(event.turnId) : undefined;
        if (row) {
          row.outcome = "completed";
          row.outcomeLabel = "Completed";
          const receiptId = bounded(payload?.receiptId);
          if (receiptId) row.receiptId = receiptId;
        }
        accounted += 1;
        continue;
      }
      case "local.command.completed": {
        const row = event.turnId ? turns.get(event.turnId) : undefined;
        if (row) {
          row.outcome = payload?.isError === true ? "failed" : "completed";
          row.outcomeLabel = payload?.isError === true ? "Failed on this device" : "Completed on this device";
        }
        accounted += 1;
        continue;
      }
      case "local.command.denied": {
        const row = event.turnId ? turns.get(event.turnId) : undefined;
        if (row) { row.outcome = "denied"; row.outcomeLabel = "Permission denied"; }
        accounted += 1;
        continue;
      }
      case "turn.failed":
      case "local.command.failed": {
        const row = event.turnId ? turns.get(event.turnId) : undefined;
        if (row) { row.outcome = "failed"; row.outcomeLabel = "Failed"; }
        accounted += 1;
        continue;
      }
      case "turn.cancelled": {
        const row = event.turnId ? turns.get(event.turnId) : undefined;
        if (row) { row.outcome = "cancelled"; row.outcomeLabel = "Cancelled"; }
        accounted += 1;
        continue;
      }
      case HUMAN_INTENT_EVENT_TYPE: {
        const tool = bounded(payload?.toolName);
        const decision = payload?.decision === "allow" ? "Allowed" : payload?.decision === "deny" ? "Denied" : undefined;
        if (payload && tool && decision) {
          order.push({
            id: event.eventId,
            kind: "approved-effect",
            sequence: event.sequence,
            recordedAt: event.recordedAt,
            title: tool,
            outcome: decision === "Allowed" ? "recorded" : "denied",
            outcomeLabel: `${decision} from the interface`,
            grounding: [],
            facts: approvedEffectFacts(payload),
          });
          accounted += 1;
        }
        continue;
      }
      case TERMINAL_ACTIVITY_EVENT_TYPE: {
        const summary = bounded(payload?.command) ?? bounded(payload?.summary);
        if (payload && summary) {
          order.push({
            id: event.eventId,
            kind: "shell",
            sequence: event.sequence,
            recordedAt: event.recordedAt,
            title: summary,
            outcome: "recorded",
            outcomeLabel: bounded(payload?.outcome) ?? "Recorded",
            grounding: [],
            facts: shellFacts(payload),
          });
          accounted += 1;
        }
        continue;
      }
      case CONVERSATION_NAMED_EVENT_TYPE: {
        // A real, billed provider request made on this conversation's behalf,
        // beside the turn rather than inside it. It is the one recorded thing
        // in the journal that costs money and belongs to no turn, so a ledger
        // that omitted it would under-report spend on the surface a person
        // opens to account for it.
        const title = bounded(payload?.title);
        order.push({
          id: event.eventId,
          kind: "naming",
          sequence: event.sequence,
          recordedAt: event.recordedAt,
          title: title ? `Named “${title}”` : "Conversation naming returned no usable name",
          outcome: "recorded",
          outcomeLabel: "Provider request beside the turn",
          grounding: [],
          facts: Object.freeze(bounded(payload?.model) ? [{ label: "Model", value: bounded(payload?.model)! }] : []),
        });
        accounted += 1;
        continue;
      }
      default:
        continue;
    }
  }

  // A turn's receipt is a *provider* artifact. Saying "no receipt" without
  // saying why is how the route came to print "Complete a turn to create the
  // first local receipt" at somebody who had just completed one.
  for (const row of order) {
    if (row.kind === "local-command" && row.outcome === "completed") {
      row.receiptNote = "Ran on this device and called no provider, so no turn receipt was minted.";
    } else if (row.kind === "provider-turn" && row.outcome === "completed" && !row.receiptId) {
      row.receiptNote = "This turn completed without recording a receipt id.";
    } else if (row.kind === "provider-turn" && row.outcome === "running") {
      row.receiptNote = "No terminal event was journaled for this turn.";
    }
  }

  const rows = order
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_ROWS)
    .map((row) => Object.freeze({ ...row, grounding: Object.freeze(row.grounding), facts: Object.freeze(row.facts) }));
  return Object.freeze({ rows: Object.freeze(rows), accountedEvents: accounted, totalEvents: events.length });
}

/** The row a `#proof?turn=` deep link is scoped to, if the journal holds it. */
export function proofActivityRowForTurn(
  ledger: ProofActivityLedger,
  turnId: string | undefined,
): ProofActivityRow | undefined {
  return turnId ? ledger.rows.find((row) => row.turnId === turnId) : undefined;
}

/**
 * Every source every turn in this session was grounded on, de-duplicated.
 *
 * Used by the export, where a per-turn nesting would bury the one thing an
 * auditor is checking: which revisions of which files this conversation read.
 */
export function proofGroundingIndex(ledger: ProofActivityLedger): readonly ProofGroundingSource[] {
  const seen = new Map<string, ProofGroundingSource>();
  for (const row of ledger.rows) {
    for (const source of row.grounding) {
      const key = `${source.path}@${source.revision}#${source.chunkId}`;
      if (!seen.has(key)) seen.set(key, source);
    }
  }
  return Object.freeze([...seen.values()]);
}

type Mutable = {
  -readonly [K in keyof ProofActivityRow]: ProofActivityRow[K];
};

function groundingSource(hit: CanonicalContextHit): ProofGroundingSource {
  return Object.freeze({
    path: hit.path,
    revision: hit.revision,
    chunkId: hit.chunkId,
    chunkIndex: hit.chunkIndex,
    contentDigest: hit.contentDigest,
    score: hit.score,
    ...(hit.corpus ? { corpus: hit.corpus } : {}),
  });
}

function approvedEffectFacts(payload: Readonly<Record<string, unknown>>): readonly Readonly<{ label: string; value: string }>[] {
  const effect = bounded(payload.effect);
  const args = record(payload.arguments as JsonValue | undefined);
  // The arguments the approval policy was shown, already redacted upstream by
  // `redactForDisplay`. Naming the target is the difference between "a Git
  // verb happened" and "this repository was committed to".
  // `paths` first: the Git verbs dispatch `{repositoryId, worktreeId, paths}`,
  // so reading `path` alone made a stage of README.md render its target as
  // "airship-workspace" — the repository, not the thing that changed.
  const paths = Array.isArray(args?.paths) ? args.paths.filter((value): value is string => typeof value === "string") : [];
  const target = paths.length > 0
    ? bounded(paths.length === 1 ? paths[0] : `${paths[0]} and ${paths.length - 1} more`)
    : bounded(args?.path) ?? bounded(args?.message) ?? bounded(args?.repositoryId);
  return Object.freeze([
    ...(effect ? [{ label: "Effect", value: effect }] : []),
    ...(target ? [{ label: "Target", value: target }] : []),
  ]);
}

function shellFacts(payload: Readonly<Record<string, unknown>>): readonly Readonly<{ label: string; value: string }>[] {
  const cwd = bounded(payload.cwd);
  const exit = typeof payload.exitCode === "number" ? String(payload.exitCode) : undefined;
  const changed = Array.isArray(payload.changedPaths) ? payload.changedPaths.length : 0;
  return Object.freeze([
    ...(cwd ? [{ label: "Directory", value: cwd }] : []),
    ...(exit ? [{ label: "Exit code", value: exit }] : []),
    ...(changed > 0 ? [{ label: "Changed paths", value: String(changed) }] : []),
  ]);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Bounded, control-character-free text, or nothing.
 *
 * Same rule as the transcript's `presentableTitle`: a shortened string always
 * says it was shortened, because a title a reader believes they have all of is
 * a quieter lie than a missing one.
 */
function bounded(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/gu, " ").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_TITLE ? `${trimmed.slice(0, MAX_TITLE - 1)}…` : trimmed;
}
