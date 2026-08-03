/**
 * The one witness that outlives a reload of this tab.
 *
 * Measured: commit "docs: persist marker", confirm it in History, reload. The
 * commit is gone, History is back to a freshly-seeded "Initial browser
 * workspace" under a brand-new hash, README.md is 845 B again — and the
 * Workspace route says nothing at all. Chat has had a sentence for exactly this
 * event for as long as it has had page-memory conversations, and Memory has the
 * same sentence for records; source control, which loses the most, had none.
 *
 * Everything the workbench reads after a reload — the workspace, the Git object
 * database, the journal — is a *new* page-memory authority, so there is nothing
 * left to compare against and the loss reads as an ordinary cold start.
 * `sessionStorage` has exactly the right lifetime: it survives the reload and
 * dies with the tab, which is the lifetime of the claim "the work you did *here*
 * is gone". Nothing is recorded while the workspace is durable, and adopting a
 * Vault clears the witness, because at that moment the work has been copied
 * into it and there is no longer anything to warn about.
 *
 * Scoped by workbench authority — workspace identity and profile — because
 * profiles are real silos: a commit dropped from General is not a fact about
 * Research.
 */
export const WORKSPACE_WITNESS_KEY_PREFIX = "airship.workspace.page-witness.";

/** Enough to name the work honestly without turning session storage into a log. */
export const WORKSPACE_WITNESS_LIMIT = 32;

/** How many are named in the sentence itself before it says "and N more". */
export const WORKSPACE_WITNESS_NAMED = 3;

export type WorkspaceLostWork = Readonly<{ commits: readonly string[]; savedPaths: readonly string[] }>;

export type WorkspacePageWitness = Readonly<{
  /** The page load that made this work. */
  loadId: string;
  /** Commit subjects landed by this load, oldest first. */
  commits: readonly string[];
  /** Workspace paths this load saved through the workbench, oldest first. */
  savedPaths: readonly string[];
  /**
   * What a previous load of this tab made and this one cannot reach.
   *
   * Stored rather than held in a component: the workbench unmounts on every
   * route change, and a loss that disappears because the reader looked at Chat
   * is the same silence this whole module exists to end. It is retired only by
   * the reader dismissing it, or by a Vault making the claim untrue.
   */
  lost?: WorkspaceLostWork;
}>;

/** This page load's identity. Module scope: a reload makes a new module. */
export const WORKSPACE_PAGE_LOAD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function key(scope: string): string {
  return `${WORKSPACE_WITNESS_KEY_PREFIX}${scope}`;
}

function bounded(values: readonly unknown[] | undefined): readonly string[] {
  if (!Array.isArray(values)) return Object.freeze([]);
  return Object.freeze(values.filter((value): value is string => typeof value === "string" && value.length > 0).slice(-WORKSPACE_WITNESS_LIMIT));
}

export function readWorkspaceWitness(storage: Pick<Storage, "getItem"> | undefined, scope: string): WorkspacePageWitness | undefined {
  try {
    const raw = storage?.getItem(key(scope));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as Partial<WorkspacePageWitness>;
    if (typeof value.loadId !== "string") return undefined;
    const lost = value.lost && typeof value.lost === "object"
      ? Object.freeze({ commits: bounded(value.lost.commits), savedPaths: bounded(value.lost.savedPaths) })
      : undefined;
    return Object.freeze({
      loadId: value.loadId,
      commits: bounded(value.commits),
      savedPaths: bounded(value.savedPaths),
      ...(lost && (lost.commits.length > 0 || lost.savedPaths.length > 0) ? { lost } : {}),
    });
  } catch {
    return undefined;
  }
}

export function writeWorkspaceWitness(storage: Pick<Storage, "setItem"> | undefined, scope: string, witness: WorkspacePageWitness): void {
  try {
    storage?.setItem(key(scope), JSON.stringify(witness));
  } catch {
    // A witness that cannot be stored simply produces no notice. It must never
    // take the workbench down: this is a claim about durability, not a
    // dependency of editing.
  }
}

export function clearWorkspaceWitness(storage: Pick<Storage, "removeItem"> | undefined, scope: string): void {
  try {
    storage?.removeItem(key(scope));
  } catch { /* Same reasoning as `writeWorkspaceWitness`. */ }
}

/**
 * What this load starts from, and what the load before it could not keep.
 *
 * A stored witness whose `loadId` is not this page's belongs to the load before
 * the reload, and it was only ever written while the workspace was page memory,
 * so its commits and saves are provably unreachable. Adoption resets the record
 * to this load and carries the previous one forward as `lost`, where it stays
 * until the reader dismisses it: the workbench unmounts on every route change,
 * and a claim that only the first mount could make is a claim nobody is
 * guaranteed to read. Idempotent, so a remount neither loses it nor re-loses
 * work already accounted for.
 */
export function adoptWorkspaceWitness(
  stored: WorkspacePageWitness | undefined,
  loadId: string,
): WorkspacePageWitness {
  const empty = Object.freeze([]) as readonly string[];
  if (!stored) return Object.freeze({ loadId, commits: empty, savedPaths: empty });
  if (stored.loadId === loadId) return stored;
  const lost = Object.freeze({
    commits: bounded([...(stored.lost?.commits ?? []), ...stored.commits]),
    savedPaths: bounded([...(stored.lost?.savedPaths ?? []), ...stored.savedPaths]),
  });
  return Object.freeze({
    loadId,
    commits: empty,
    savedPaths: empty,
    ...(lost.commits.length > 0 || lost.savedPaths.length > 0 ? { lost } : {}),
  });
}

/** The reader has read it; it never comes back. Keeps this load's own record. */
export function dismissWorkspaceLoss(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  scope: string,
): void {
  const current = readWorkspaceWitness(storage, scope);
  if (!current?.lost) return;
  writeWorkspaceWitness(storage, scope, Object.freeze({
    loadId: current.loadId,
    commits: current.commits,
    savedPaths: current.savedPaths,
  }));
}

/** Append one landed commit subject or one saved path, bounded, idempotently stored. */
export function recordWorkspaceWork(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  scope: string,
  work: Readonly<{ commit?: string; savedPath?: string }>,
): void {
  const commit = work.commit?.trim();
  const savedPath = work.savedPath?.trim();
  if (!commit && !savedPath) return;
  // Adopted rather than rebased by hand: a record written by a previous load
  // must become `lost` here too, or the first commit after a reload would
  // quietly delete the evidence of what that reload destroyed.
  const base = adoptWorkspaceWitness(readWorkspaceWitness(storage, scope), WORKSPACE_PAGE_LOAD_ID);
  writeWorkspaceWitness(storage, scope, Object.freeze({
    loadId: WORKSPACE_PAGE_LOAD_ID,
    ...(base.lost ? { lost: base.lost } : {}),
    commits: bounded(commit ? [...base.commits, commit] : base.commits),
    // A file saved twice is one file at risk, not two.
    savedPaths: bounded(savedPath && !base.savedPaths.includes(savedPath) ? [...base.savedPaths, savedPath] : base.savedPaths),
  }));
}

/**
 * The loss, in the words Chat and Memory already use for the same event.
 *
 * It names the work rather than counting it: "1 commit" is a number a person
 * has to reconcile against their own memory, and the whole failure being fixed
 * is that nobody was told which work went.
 */
export function lostWorkspaceWorkNotice(lost: WorkspaceLostWork | undefined): string | undefined {
  if (!lost) return undefined;
  const commits = lost.commits.length;
  const files = lost.savedPaths.length;
  if (commits === 0 && files === 0) return undefined;
  const summary = [
    commits ? `${String(commits)} commit${commits === 1 ? "" : "s"}` : "",
    files ? `${String(files)} saved file${files === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");
  const named = [
    ...lost.commits.slice(-WORKSPACE_WITNESS_NAMED).reverse().map((subject) => `“${subject}”`),
    ...lost.savedPaths.slice(-WORKSPACE_WITNESS_NAMED).reverse().map((path) => path.replace("/workspace/", "")),
  ];
  const unnamed = commits + files - named.length;
  const detail = `${named.join(", ")}${unnamed > 0 ? `, and ${String(unnamed)} more` : ""}`;
  const plural = commits + files > 1;
  return `${summary} this tab made existed only in page memory and did not survive the reload: ${detail}. ${plural ? "They are" : "It is"} not recoverable.`;
}
