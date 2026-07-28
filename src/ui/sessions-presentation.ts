import type { SealState } from "./seal";

/**
 * How the conversation library says what it knows.
 *
 * The library's measured defect was not that it showed too little — it showed
 * seven data points per card, of which seven were identical row to row, and
 * three full-width green bands per detail pane saying that nothing was wrong.
 * Signal was the missing thing, not information. Everything here therefore
 * *ranks* and *re-words* facts the journal already holds; nothing invents one.
 *
 * Kept out of the view because each of these is a claim, and a claim has to be
 * assertable without a browser.
 */

/** Below this the elapsed time is not worth a number. */
const JUST_NOW_MS = 45_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Inside a week a weekday name locates a conversation better than a date. */
const WEEK_MS = 7 * DAY_MS;

function clockOf(value: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(value);
}

/**
 * The elapsed-time word for a conversation row.
 *
 * `Jul 27, 10:15 AM` on a session created thirty seconds ago is technically
 * true and practically useless: it is the same 17 characters for every row in a
 * library built in one sitting, which is exactly how nine conversations became
 * indistinguishable. The absolute timestamp is not lost — the row keeps it in
 * `<time datetime>` and in the card's `title`, and the detail pane still prints
 * created and updated in full.
 */
export function relativeSessionTime(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < 0) return clockOf(date);
  if (elapsed < JUST_NOW_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.max(1, Math.floor(elapsed / MINUTE_MS))}m`;
  if (elapsed < DAY_MS && date.getDate() === now.getDate()) return `${Math.floor(elapsed / HOUR_MS)}h`;
  const yesterday = new Date(now.getTime() - DAY_MS);
  if (date.getDate() === yesterday.getDate() && date.getMonth() === yesterday.getMonth() && date.getFullYear() === yesterday.getFullYear()) {
    return `Yesterday ${clockOf(date)}`;
  }
  if (elapsed < WEEK_MS) {
    return `${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date)} ${clockOf(date)}`;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

/**
 * The journal-head count, in the units the journal actually counts in.
 *
 * The card said `1 event` and the continuity row said `1 events` for the same
 * number on the same screen. Both call sites now come through here. The word
 * stays "event" rather than becoming "message": `headSequence` counts journal
 * events, and one turn writes several — calling them messages would be a
 * smaller number's label on a larger number.
 */
export function sessionEventCount(headSequence: number): string {
  return `${headSequence} event${headSequence === 1 ? "" : "s"}`;
}

/** Ranked worst-first, so a row of pills can be reduced to one verdict. */
const INTEGRITY_SEVERITY: Readonly<Record<SealState, number>> = Object.freeze({
  failed: 5,
  attention: 4,
  stale: 3,
  checking: 2,
  none: 1,
  asserted: 1,
  verified: 0,
});

export type SessionIntegrityPill = Readonly<{
  key: "structure" | "resume" | "receipts";
  state: SealState;
  /** The visible word. Never a raw enum. */
  label: string;
  /** The sentence the pill carries into the expansion, verbatim from source. */
  detail: string;
}>;

export type SessionIntegrityRow = Readonly<{
  pills: readonly SessionIntegrityPill[];
  /** Worst of the two verdict pills; the receipt count is a figure, not a verdict. */
  state: SealState;
  /**
   * Fail open. A row that is not entirely green opens itself, so a problem is
   * never one click away — collapse is only ever allowed to hide agreement.
   */
  autoExpanded: boolean;
  /** What the control contains, said by the control. */
  label: string;
}>;

export type SessionIntegrityInput = Readonly<{
  history: Readonly<{
    status: "consistent" | "incomplete" | "suspect" | string;
    label: string;
    checkedEvents: number;
    totalEvents: number;
    turnCount: number;
  }>;
  receiptCount: number;
  lifecycle: Readonly<{ state: string; label: string }>;
  compatibility?: Readonly<{ action: string; label: string }>;
}>;

/**
 * Three full-width bands of agreement, reduced to one row of three words.
 *
 * `.session-library-health` + `.session-library-continuity` +
 * `.session-library-compatibility` measured 177px of a 620px detail column and,
 * in the healthy case, said "yes" three times. Every string in them survives
 * inside the expansion; what is collapsed is the *agreement*, and only while
 * everything agrees.
 */
export function sessionIntegrityRow(input: SessionIntegrityInput): SessionIntegrityRow {
  const structureState: SealState = input.history.status === "consistent"
    ? "verified"
    : input.history.status === "suspect" ? "failed" : "attention";
  const structure: SessionIntegrityPill = Object.freeze({
    key: "structure",
    state: structureState,
    label: input.history.status === "consistent" ? "Structure passed" : input.history.label,
    detail: `${input.history.checkedEvents} of ${input.history.totalEvents} events inspected · ${input.history.turnCount} turn${input.history.turnCount === 1 ? "" : "s"}`,
  });

  const resumeState: SealState = !input.compatibility
    ? "none"
    : input.compatibility.action === "resume"
      ? "verified"
      : input.compatibility.action === "blocked" ? "failed" : "attention";
  const resume: SessionIntegrityPill = Object.freeze({
    key: "resume",
    state: resumeState,
    label: input.compatibility?.label ?? "No active runtime",
    detail: input.lifecycle.label,
  });

  // A recovered receipt is a record that exists, not a record that was checked
  // here — so it is counted, never coloured as a verdict.
  const receipts: SessionIntegrityPill = Object.freeze({
    key: "receipts",
    state: "none",
    label: `${input.receiptCount} receipt${input.receiptCount === 1 ? "" : "s"}`,
    detail: "Structural linkage only · digests not recomputed · authenticity not proven",
  });

  const state = INTEGRITY_SEVERITY[structureState] >= INTEGRITY_SEVERITY[resumeState] ? structureState : resumeState;
  return Object.freeze({
    pills: Object.freeze([structure, resume, receipts]),
    state,
    autoExpanded: state !== "verified",
    label: `Session integrity. ${structure.label}. ${resume.label}. ${receipts.label}. Opens the inspected event counts, the runtime decision and its reasons, and the proof scope.`,
  });
}

/** The rename/fork title cap the journal already enforces. */
export const SESSION_TITLE_MAX = 240;

/**
 * The default title a fork is offered.
 *
 * `"{title} · fork"` sorted a fork immediately after its parent under a title
 * sort and read as a suffix on an unchanged name; `Fork of {title}` says which
 * of the two rows is the derivative before the eye reaches the lineage line.
 */
export function forkTitleFor(title: string): string {
  return `Fork of ${title}`.slice(0, SESSION_TITLE_MAX);
}

/**
 * The short form of a session id, kept identical to the detail pane's.
 *
 * Lineage is only navigable if the id on the card and the id in the runtime
 * record are recognisably the same string.
 */
export function shortSessionId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export type SessionLineage = Readonly<{
  /** What the row shows: the parent's title when it is loaded, else its id. */
  label: string;
  /** True when the parent is in the current page and can be selected. */
  navigable: boolean;
  parentId: string;
}>;

/**
 * The lineage line for a forked conversation.
 *
 * `sourceSessionId` ships on every list item and is even in the search
 * haystack, and no card rendered it — so the one property the route's own
 * description advertises ("a fork appears only when its meaning genuinely
 * changes") was invisible in the list that demonstrates it.
 */
export function sessionLineage(
  sourceSessionId: string | undefined,
  titleById: ReadonlyMap<string, string>,
): SessionLineage | undefined {
  if (!sourceSessionId) return undefined;
  const parentTitle = titleById.get(sourceSessionId);
  return Object.freeze({
    label: parentTitle ?? shortSessionId(sourceSessionId),
    navigable: parentTitle !== undefined,
    parentId: sourceSessionId,
  });
}

/**
 * What the search box searches, said where a zero result is read.
 *
 * `querySessionRecords` matches title, id, provider, model, profile and source
 * id — never transcript text. A placeholder reading "Search conversations"
 * promises the transcript and returns nothing, which reads as a broken index
 * rather than as a scope. Naming the scope in the placeholder and the absence
 * in the empty state costs two strings and makes a true statement.
 */
export const SESSION_SEARCH_PLACEHOLDER = "Search titles, models and profiles";
export const SESSION_SEARCH_SCOPE_NOTE = "Transcript text is not indexed in this build.";

export function sessionEmptyStateBody(input: Readonly<{ filtered: boolean; searched: boolean }>): readonly string[] {
  if (!input.filtered) return Object.freeze(["A conversation appears here after the journal creates it."]);
  const lines = ["Clear or widen the current filters."];
  if (input.searched) lines.push(SESSION_SEARCH_SCOPE_NOTE);
  return Object.freeze(lines);
}
