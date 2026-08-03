import type { SessionForkResult } from "../../sessions/library";

/**
 * What a branch actually carried, said by every surface that announces one.
 *
 * `SessionLibrary.fork` bounds the context it seeds a branch with and returns
 * the three numbers that describe the bound — carried messages, omitted
 * messages, omitted images — and until now nothing read them. The composer
 * notice was a fixed string ("with audited context through this answer") that
 * asserted completeness the seed does not guarantee, so a branch taken from a
 * long conversation announced a complete continuation and silently began as a
 * truncated one. The counts are the only thing that can tell those two apart,
 * so they are stated wherever a branch is announced.
 *
 * A pure function taking the counts, because the claim is checkable without a
 * browser and the three surfaces that make it must not drift.
 */
export type ForkContextCounts = Pick<
  SessionForkResult,
  "contextMessageCount" | "omittedContextMessages" | "omittedContextImages"
>;

/** Which branch was taken. Each opens on a different first action. */
export type ForkBranchKind = "fork-after-answer" | "fork-before-prompt" | "edit" | "retry";

const FORK_BRANCH_HEADLINES: Readonly<Record<ForkBranchKind, string>> = Object.freeze({
  // "with audited context through this answer" used to lead this sentence. It
  // is the unqualified completeness claim the bounded seed cannot back, so the
  // headline now states the boundary and the clause below states the reach.
  "fork-after-answer": "True fork created at the audited boundary after this answer. The source conversation remains unchanged.",
  "fork-before-prompt": "True fork created immediately before this user turn. The selected prompt was not copied; use Edit & branch when you want to revise it.",
  edit: "Edit branch created at the immutable pre-turn boundary. Review the prompt, then send when ready.",
  retry: "Clean retry branch created; regenerating without the prior answer in provider context.",
});

/**
 * The same claim, made *before* the click.
 *
 * Every headline above is post-hoc: it is read after a branch exists, when the
 * real counts are in hand. The Retry button's `title` is the one place the
 * product describes a branch in advance, and because it lived as a literal on
 * the button it drifted — it promised a "clean fork", i.e. a blank slate, while
 * the retry path forks at `turnStartPoint` and seals a bounded ancestor-context
 * seed exactly like every other branch. A pre-click sentence that contradicts
 * the post-click one is worse than no sentence, so it lives here, beside the
 * headlines it has to agree with, rather than in the view that renders it.
 *
 * No counts: the boundary is known before the click, the reach is not, and
 * inventing a reach here is precisely the completeness claim this module
 * exists to refuse.
 */
export const FORK_RETRY_TOOLTIP =
  "Regenerate on a new branch seeded with a bounded, digest-sealed copy of the conversation up to just before this turn. The prior answer is not carried into it and remains inspectable in the source conversation.";

/**
 * The reach of the bounded seed, as one clause.
 *
 * "none omitted" rather than "0 omitted": a fully carried branch is a
 * different fact from a truncated one, and a reader should not have to notice
 * a zero to learn which they have.
 */
export function forkContextClause(counts: ForkContextCounts): string {
  const carried = `Carrying ${String(counts.contextMessageCount)} ancestor ${plural(counts.contextMessageCount, "message")}`;
  const omitted: string[] = [];
  if (counts.omittedContextMessages > 0) {
    omitted.push(`${String(counts.omittedContextMessages)} earlier ${plural(counts.omittedContextMessages, "message")}`);
  }
  if (counts.omittedContextImages > 0) {
    omitted.push(`${String(counts.omittedContextImages)} ${plural(counts.omittedContextImages, "image")}`);
  }
  return omitted.length === 0
    ? `${carried}; none omitted.`
    : `${carried}; ${omitted.join(" and ")} fell outside the bounded seed and are not in this branch's context.`;
}

/** How long a branch title's leading excerpt may run before the action word. */
const BRANCH_TITLE_EXCERPT = 64;

/** The action words this module appends, and strips before appending again. */
const BRANCH_TITLE_SUFFIX: Readonly<Record<ForkBranchKind, string>> = Object.freeze({
  "fork-after-answer": "fork",
  "fork-before-prompt": "fork",
  edit: "edit",
  retry: "retry",
});

const TRAILING_ACTIONS = /(?:\s·\s(?:edit|retry|fork))+$/u;

/**
 * What a branch is called.
 *
 * Titles were built as `${source.title} · ${action}`, so a line of thought
 * turned into "Base question", "Base question · retry", "Base question · retry
 * · retry", "Base question · retry · retry · edit" — and two Edit & branches
 * taken from *different* turns of one conversation were both called "Q1 about
 * retrieval · edit". In the library column the title element rendered 119px of
 * 353px, so the only distinguishing part was exactly the part that was clipped.
 *
 * A branch is named for the turn it changed, with the action word last: the
 * distinguishing text is then the part that survives truncation, and two
 * branches from two different turns cannot collide. Concatenation is bounded by
 * construction — an ancestor's own trailing action words are stripped before
 * one is added — so a retry of a retry is still one action deep in its name.
 */
export function branchTitleFor(
  kind: ForkBranchKind,
  anchorText: string | undefined,
  sourceTitle: string,
): string {
  const action = BRANCH_TITLE_SUFFIX[kind];
  const lead = titleExcerpt(anchorText) || titleExcerpt(sourceTitle.replace(TRAILING_ACTIONS, "")) || "Branch";
  return `${lead} · ${action}`.slice(0, 240);
}

function titleExcerpt(value: string | undefined): string {
  const line = (value ?? "").replace(/\s+/gu, " ").trim();
  if (line.length <= BRANCH_TITLE_EXCERPT) return line;
  const cut = line.slice(0, BRANCH_TITLE_EXCERPT);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > BRANCH_TITLE_EXCERPT / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** The full sentence a branch announces, headline and reach together. */
export function forkBranchNotice(kind: ForkBranchKind, counts: ForkContextCounts): string {
  return `${FORK_BRANCH_HEADLINES[kind]} ${forkContextClause(counts)}`;
}

/** The library route's own announcement for the same event. */
export function forkLibraryAnnouncement(title: string, counts: ForkContextCounts): string {
  return `Created ${title} as a new session. Source history was not rewritten. ${forkContextClause(counts)}`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
