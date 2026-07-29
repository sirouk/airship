/*
 * The rail's Recent group, read as lineage rather than as a flat recency list.
 *
 * Every Edit & branch and every Retry produces a peer session, and the
 * shortcut ranked them by `updatedAt` alone — so three retries of one question
 * took three of the ten rows and pushed three unrelated conversations out of
 * the only navigation surface most people ever use. The manifest has carried
 * `lineage.sourceSessionId` since branching shipped, but it was only ever
 * walked upward to render one "Forked from" line; nothing grouped by it.
 *
 * Pure, and separated from the loader, because the claim being made here is
 * arithmetic about a set of rows — which lineage a session belongs to, which
 * member survives collapse, and how many members it stands for — and that is
 * checkable without a journal or a browser.
 */

/** The two fields collapse needs from a session list item. */
export type LineageRow = Readonly<{
  id: string;
  updatedAt: string;
  sourceSessionId?: string;
}>;

export type CollapsedLineageRow<T extends LineageRow> = Readonly<{
  item: T;
  /** How many candidates share this row's lineage root, this row included. */
  branchCount: number;
  /**
   * How many of them this collapse withdrew from the list. The row has to
   * state this number: a hidden branch that is not counted is a conversation
   * the shortcut silently lost, which is the defect collapsing would otherwise
   * trade the flooding for.
   */
  hiddenBranchCount: number;
}>;

/**
 * The furthest ancestor reachable from `id` inside `sourceById`.
 *
 * Bounded by the map's own size and by a visited set: a manifest is
 * user-influenced data, and a lineage cycle must degrade to "this session is
 * its own root" rather than hang the rail.
 */
export function lineageRootId(id: string, sourceById: ReadonlyMap<string, string | undefined>): string {
  const seen = new Set<string>([id]);
  let current = id;
  for (;;) {
    const parent = sourceById.get(current);
    // An unknown parent stops the walk here rather than inventing a root: a
    // branch whose source is outside the loaded page groups under itself,
    // which costs a row and never merges two unrelated lineages.
    if (!parent || !sourceById.has(parent)) return current;
    // A cycle has no topmost member, so the whole ring answers with one id
    // every entry point agrees on. Picking the walk's own stopping point
    // instead would give the ring's members two different roots and split a
    // malformed lineage back into the flood this exists to collapse.
    if (seen.has(parent)) return [...seen].sort()[0]!;
    seen.add(parent);
    current = parent;
  }
}

/**
 * One row per lineage, in the order the candidates were given.
 *
 * `pinned` ids always survive — the active conversation and every favorite,
 * because withdrawing the row a person is currently reading, or the one they
 * explicitly starred, is a worse defect than the flooding this fixes.
 */
export function collapseLineageBranches<T extends LineageRow>(
  candidates: readonly T[],
  sourceById: ReadonlyMap<string, string | undefined>,
  pinned: ReadonlySet<string> = new Set(),
): readonly CollapsedLineageRow<T>[] {
  const rootById = new Map<string, string>();
  const members = new Map<string, T[]>();
  for (const candidate of candidates) {
    const root = lineageRootId(candidate.id, sourceById);
    rootById.set(candidate.id, root);
    const group = members.get(root);
    if (group) group.push(candidate);
    else members.set(root, [candidate]);
  }
  const kept = new Set<string>();
  for (const [, group] of members) {
    for (const member of group) if (pinned.has(member.id)) kept.add(member.id);
    // The representative is the most recently updated member, resolved by id
    // so an identical timestamp never makes the shortcut order unstable.
    const representative = group.reduce((best, member) => {
      const delta = timestamp(member.updatedAt) - timestamp(best.updatedAt);
      return delta > 0 || (delta === 0 && member.id < best.id) ? member : best;
    });
    if (!group.some((member) => kept.has(member.id))) kept.add(representative.id);
  }
  return Object.freeze(candidates
    .filter((candidate) => kept.has(candidate.id))
    .map((candidate) => {
      const group = members.get(rootById.get(candidate.id)!) ?? [candidate];
      const shown = group.filter((member) => kept.has(member.id)).length;
      return Object.freeze({
        item: candidate,
        branchCount: group.length,
        hiddenBranchCount: group.length - shown,
      });
    }));
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
