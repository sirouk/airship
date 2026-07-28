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
  /**
   * True when the active runtime refused to replay this conversation.
   *
   * The compatibility verdict answers "do the manifest pins still match", and
   * that answer stays `resume` for a session whose transcript the renderer
   * could not rebuild — so the row went on showing a green "Ready to resume"
   * beside a disabled resume control, asserting a readiness the runtime had
   * just failed to deliver. The chain really did pass its audit; what did not
   * hold is the replay, and only the replay is restated here.
   */
  transcriptReplayFailed?: boolean;
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

  const resumeState: SealState = input.transcriptReplayFailed
    ? "attention"
    : !input.compatibility
      ? "none"
      : input.compatibility.action === "resume"
        ? "verified"
        : input.compatibility.action === "blocked" ? "failed" : "attention";
  const resume: SessionIntegrityPill = Object.freeze({
    key: "resume",
    state: resumeState,
    // `attention`, not `failed`: a failure verdict here would say the session is
    // damaged, and it is not — the audit verified the chain. The runtime pins
    // still match too, which is why the compatibility label alone was not
    // enough to tell the truth on this row.
    label: input.transcriptReplayFailed
      ? "Transcript cannot be replayed"
      : input.compatibility?.label ?? "No active runtime",
    detail: input.transcriptReplayFailed
      ? `History verified · ${input.lifecycle.label}`
      : input.lifecycle.label,
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

/**
 * Exactly the fields `querySessionRecords` compares a search term against.
 *
 * `src/sessions/domain.ts` matches title, session id, provider id, model,
 * profile id and source session id. Naming five of them and eliding the id —
 * which nobody types — is the shortest true sentence; naming fewer would make
 * a zero result look like a broken index rather than a scope.
 */
export const SESSION_SEARCH_SCOPE = "title, model, profile and fork source";

export type SessionEmptyState = Readonly<{
  heading: string;
  lines: readonly string[];
  /** True when there is a filter to clear — an empty state with a verb in it. */
  offersClear: boolean;
}>;

/**
 * What an empty conversation list says, and what it offers.
 *
 * "Clear or widen the current filters." is accurate and is a dead end: it
 * describes the user's own action back at them without naming what was
 * searched, how much was searched, or providing the control that would undo
 * it. Every line here is a fact the route already holds; the difference is that
 * the state now ends in something to press.
 */
export function sessionEmptyState(input: Readonly<{
  filtered: boolean;
  query: string;
  /** Conversations counted by the most recent unfiltered read, when there was one. */
  loadedTotal?: number;
}>): SessionEmptyState {
  if (!input.filtered) {
    return Object.freeze({
      heading: "No conversations yet",
      lines: Object.freeze(["A conversation appears here after the journal creates it."]),
      offersClear: false,
    });
  }
  const query = input.query.trim();
  const lines: string[] = [`Searched every conversation in this journal by ${SESSION_SEARCH_SCOPE}.`];
  // Stated as of the read that produced it. The library re-reads the journal on
  // every filter change, so a bare "25 conversations searched" would be a claim
  // about a number this render never saw.
  if (input.loadedTotal !== undefined) {
    lines.push(`${input.loadedTotal} conversation${input.loadedTotal === 1 ? "" : "s"} at the last unfiltered read.`);
  }
  if (query) lines.push(SESSION_SEARCH_SCOPE_NOTE);
  return Object.freeze({
    heading: query ? `No conversation matches “${query}”` : "No conversation matches these filters",
    lines: Object.freeze(lines),
    offersClear: true,
  });
}

export type TitleSegment = Readonly<{ text: string; matched: boolean }>;

/**
 * The title split around every occurrence of the search term.
 *
 * At forty conversations the title is the only discriminating pixel on a row,
 * and a filtered list that does not say *where* it matched makes the reader
 * re-run the search with their eyes. Marking is presentation only: the string
 * is reassembled character for character, so nothing is dropped or reordered.
 */
export function titleMatchSegments(title: string, query: string): readonly TitleSegment[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return Object.freeze([Object.freeze({ text: title, matched: false })]);
  const haystack = title.toLowerCase();
  const segments: TitleSegment[] = [];
  let cursor = 0;
  for (;;) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    if (index > cursor) segments.push(Object.freeze({ text: title.slice(cursor, index), matched: false }));
    segments.push(Object.freeze({ text: title.slice(index, index + needle.length), matched: true }));
    cursor = index + needle.length;
  }
  if (cursor < title.length) segments.push(Object.freeze({ text: title.slice(cursor), matched: false }));
  return Object.freeze(segments.length ? segments : [Object.freeze({ text: title, matched: false })]);
}

export type ForkRequirement = Readonly<{
  /** True when the runtime will not continue this conversation as it stands. */
  required: boolean;
  /** The verdict word the runtime itself produced. */
  label: string;
  /** The reasons that carry the requirement, worst first, verbatim. */
  reasons: readonly Readonly<{ code: string; severity: string; message: string }>[];
}>;

/**
 * Why this conversation needs a fork, said where the fork is decided.
 *
 * The route advertises that "a fork appears only when its meaning genuinely
 * changes" and then offers `Fork to continue` with no statement of what
 * changed — the reasons exist, and they were only readable inside a collapsed
 * integrity row several hundred pixels away. This re-presents them at the
 * moment of the decision; it does not move them out of the integrity row.
 */
export function forkRequirement(
  compatibility: Readonly<{
    action: string;
    label: string;
    reasons: readonly Readonly<{ code: string; severity: string; message: string }>[];
  }> | undefined,
  /** The assessment that produced `HISTORY_INCOMPLETE`, when there is one. */
  history?: Readonly<{ checkedEvents: number; totalEvents: number; issues: readonly Readonly<{ code: string }>[] }>,
): ForkRequirement {
  const rank = (item: Readonly<{ severity: string }>): number => INTEGRITY_SEVERITY[item.severity === "error" ? "failed" : item.severity === "warning" ? "attention" : "none"];
  const scope = (reason: Readonly<{ code: string; severity: string; message: string }>) =>
    reason.code === "HISTORY_INCOMPLETE" && history
      ? Object.freeze({ ...reason, message: historyIncompleteMessage(history) })
      : reason;
  return Object.freeze({
    required: Boolean(compatibility) && compatibility!.action !== "resume",
    label: compatibility?.label ?? "No active runtime supplied",
    reasons: Object.freeze(compatibility ? [...compatibility.reasons].sort((left, right) => rank(right) - rank(left)).map(scope) : []),
  });
}

/**
 * The disjunct that actually holds, instead of both of them.
 *
 * `decideSessionResume` raises `HISTORY_INCOMPLETE` for *any* non-fatal
 * observation and describes it with a fixed disjunction — "The session ended
 * mid-turn or was only partially inspected" — so a fully inspected session
 * whose sole observation was a timestamp drift was told both, beside its own
 * "8 of 8 events inspected · last turn completed" 60px above. Selecting the
 * true disjunct removes a false claim rather than adding one; when neither
 * disjunct holds, the real basis is named. The recommendation is unchanged.
 */
export function historyIncompleteMessage(history: Readonly<{
  checkedEvents: number;
  totalEvents: number;
  issues: readonly Readonly<{ code: string }>[];
}>): string {
  const basis = history.issues.some((issue) => issue.code === "TURN_INCOMPLETE")
    ? "The most recent turn has no durable terminal event"
    : history.checkedEvents < history.totalEvents
      ? `Only ${history.checkedEvents} of ${history.totalEvents} events were inspected`
      : `${history.issues.length} structural observation${history.issues.length === 1 ? "" : "s"} on a fully inspected history`;
  return `${basis}; fork before continuing.`;
}

/**
 * The strip shown when the selected conversation is outside the current filter.
 *
 * A stale detail pane beside "No matching conversations" is a correctness
 * hazard, not a cosmetic one: `Fork to continue` writes a new manifest, and
 * offering it, enabled, next to a list that has just declared the target out of
 * scope invites acting on the wrong conversation. The pane keeps every fact it
 * was rendering; only its mutating verbs are withdrawn, and the reason is said
 * where the buttons are.
 */
export const SESSION_OUT_OF_RESULTS_NOTICE = "Not in the current results. Showing the last conversation you opened.";
export const SESSION_OUT_OF_RESULTS_CAPTION = "Clear the filter to act on this conversation.";
