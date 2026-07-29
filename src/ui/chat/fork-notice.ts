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
