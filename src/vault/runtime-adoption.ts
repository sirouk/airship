import type { JsonValue } from "../core/contracts";
import { stableStringify } from "../core/hash";
import type { EventJournal, JournalBackend, SessionRecord } from "../core/journal";
import { createBuiltInProfileCatalog, reconcileBuiltInSkills, reconcileBuiltInThemes } from "../profiles/catalog";
import {
  ProfileCatalogConflictError,
  type ProfileCatalogCheckpoint,
  type ProfileCatalogStore,
} from "../profiles/persistence";
import { isLegacyGitCheckpointPath, isWorkspaceControlPlanePath, type WorkspacePort } from "../workspace/contracts";
import { profileFacingWorkspacePath } from "../workspace/profile-scope";

/**
 * True for a storage path a person would recognize as their file.
 *
 * Storage paths all live under the reserved namespace, so the question has to
 * be asked of the path as its Profile presents it. Everything else — `.git`
 * object databases, the browser-Git repository catalog, evidence checkpoints —
 * is state the target owns and regenerates for itself.
 */
function carriesUserContent(storagePath: string): boolean {
  const facing = profileFacingWorkspacePath(storagePath);
  return !isWorkspaceControlPlanePath(facing ?? storagePath);
}

/**
 * How the source relates to the target it is being copied into.
 *
 * `seed` is a move: the target is blank, so it receives the workspace whole,
 * including the `.git` object databases that make its repositories real.
 *
 * `merge` is a join: the target already holds an authority of its own. Copying
 * a second repository's index and objects on top of it is both meaningless —
 * those objects describe a history the target does not have — and guaranteed to
 * fail, because a Git index embeds per-file revision identity and is never
 * byte-identical across two runtimes. Merge therefore carries user files only
 * and leaves them untracked in the target's repository, which is a state a
 * person can see and commit, rather than a conflict that aborts adoption.
 */
export type WorkspaceMigrationMode = "seed" | "merge";

/** Copy a stable workspace snapshot without overwriting divergent cloud state. */
export async function migrateWorkspaceState(
  source: WorkspacePort,
  target: WorkspacePort,
  mode: WorkspaceMigrationMode = "seed",
): Promise<void> {
  const entries = (await source.list())
    .filter((entry) => !isLegacyGitCheckpointPath(entry.path))
    .filter((entry) => mode === "seed" || carriesUserContent(entry.path));
  const snapshot = [];
  for (const entry of entries) {
    // Only the retired parallel semantic checkpoint is excluded. Conventional
    // repository `.git` files and the browser-Git registry are authoritative
    // workspace state and deliberately migrate through this same port.
    const file = await source.read(entry.path);
    if (!file) throw new Error(`Workspace file disappeared during vault migration: ${entry.path}.`);
    if (file.revision !== entry.revision) throw new Error(`Workspace changed during vault migration: ${entry.path}.`);
    snapshot.push(file);
  }
  const freshEntries = (await source.list())
    .filter((entry) => !isLegacyGitCheckpointPath(entry.path))
    .filter((entry) => mode === "seed" || carriesUserContent(entry.path));
  if (!sameWorkspaceSnapshot(entries, freshEntries)) {
    throw new Error("Workspace changed during vault migration; retry after writes settle.");
  }
  for (const file of snapshot) {
    const existing = await target.read(file.path);
    if (existing) {
      if (existing.content !== file.content) {
        throw new Error(`Encrypted vault already contains different content at ${file.path}.`);
      }
      continue;
    }
    await target.write(file.path, file.content, { expectedRevision: null });
  }
}

/** What a page-memory journal handed to a Vault, in facts read before the copy. */
export type AdoptionCarriedWork = Readonly<{
  conversations: number;
  /** The conversation the person was in, when the profile pointer named one. */
  activeTitle?: string;
}>;

/**
 * Read what this migration is about to carry, so the landing screen can say it.
 *
 * Lives beside the copy rather than in the shell for two reasons: it is a fact
 * about the migration, and the shell's first-paint chunk is a fixed budget that
 * a sentence only an adoption can produce has no business spending.
 */
export async function readAdoptionCarriedWork(
  source: EventJournal,
  profileId: string,
): Promise<AdoptionCarriedWork> {
  const conversations = (await source.listSessions()).length;
  try {
    const { resolveProfileActiveConversation } = await import("../sessions/profile-cockpit");
    const pointer = await resolveProfileActiveConversation(source, profileId);
    const activeTitle = pointer.state === "selected" ? pointer.session?.title : undefined;
    return Object.freeze({ conversations, ...(activeTitle ? { activeTitle } : {}) });
  } catch {
    // Naming the thread is a courtesy on the adoption path; failing to read the
    // pointer must never be what stops a Vault from being adopted.
    return Object.freeze({ conversations });
  }
}

/**
 * What adoption says about the work it just carried, and about the thread it
 * could not continue.
 *
 * Measured (J110): a person with a completed turn in `#chat/7ec47231…` turned
 * durability on and arrived at `#chat/40ec5b12…` — a different, empty
 * conversation titled "General · encrypted vault" — with the rail reading "No
 * messages yet" and no sentence anywhere about where the work had gone. It had
 * gone into the Vault: `migrateJournalState` copies every session verbatim, ids
 * and all. What it cannot carry is *continuity*, because a session manifest
 * pins the workspace it was composed against and adoption is precisely a change
 * of workspace authority — so every pre-Vault conversation reads "WORKSPACE
 * MISMATCH · Fork required" afterwards. That is a real consequence of the
 * choice; the silence around it was the defect.
 *
 * The two halves are one string because they must never come apart: "your
 * conversations came with you" is only honest beside "this is a new one, and
 * here is how to continue the old one".
 */
export function adoptionCarriedNote(carried: AdoptionCarriedWork | undefined): string {
  if (!carried || carried.conversations < 1) return "";
  const count = `${String(carried.conversations)} conversation${carried.conversations === 1 ? "" : "s"}`;
  const named = carried.activeTitle ? ` — including “${carried.activeTitle}”` : "";
  return ` ${count} from page memory${named} came with it and are listed in All conversations.`
    + " They continue with Fork to continue rather than in place: a conversation stays pinned to the storage it was started on, and this Vault is a different one.";
}

/** Preserve exact session IDs, event bytes, sequence numbers, and digest heads. */
export async function migrateJournalState(source: EventJournal, target: JournalBackend): Promise<void> {
  const sessions = await source.listSessions();
  for (const session of sessions) {
    const events = await source.readEvents(session.id);
    const fresh = await source.getSession(session.id);
    const eventHeadMatches = session.headSequence === 0
      ? events.length === 0 && session.headDigest === "genesis"
      : events.at(-1)?.sequence === session.headSequence
        && events.at(-1)?.digest === session.headDigest;
    if (
      !fresh ||
      fresh.headSequence !== session.headSequence ||
      fresh.headDigest !== session.headDigest ||
      !eventHeadMatches
    ) {
      throw new Error(`Session ${session.id} changed during vault migration; retry after the turn settles.`);
    }
    const existing = await target.getSession(session.id);
    if (existing) {
      // The digest head commits the event chain, not the mutable backend row
      // that indexes it. Never treat a matching head as permission to adopt a
      // different provider/model/workspace/profile binding, title, or time.
      // A Vault transition is an exact copy operation; accepting only a few
      // manifest digests here would let divergent session authority survive
      // under an otherwise valid event head (especially at genesis).
      if (!sameSessionRecord(existing, session)) {
        throw new Error(`Encrypted vault contains a conflicting session ${session.id}.`);
      }
      continue;
    }
    await target.createSession({
      ...structuredClone(session),
      updatedAt: session.createdAt,
      headSequence: 0,
      headDigest: "genesis",
    });
    let expectedHead = { sequence: 0, digest: "genesis" };
    for (let offset = 0; offset < events.length; offset += 4_096) {
      const segment = events.slice(offset, offset + 4_096);
      const updated = await target.append(session.id, expectedHead, segment);
      expectedHead = { sequence: updated.headSequence, digest: updated.headDigest };
    }
    if (expectedHead.sequence !== session.headSequence || expectedHead.digest !== session.headDigest) {
      throw new Error(`Session ${session.id} did not preserve its digest head during vault migration.`);
    }
  }
}

export type ProfileCatalogMigration = Readonly<{
  checkpoint: ProfileCatalogCheckpoint;
  disposition: "created" | "matched" | "adopted-existing";
}>;

/**
 * Move the catalog through the same provider-neutral authority boundary as
 * workspace and journal state. A deterministic first-page seed may yield to
 * an existing Vault catalog; real page edits never overwrite divergence.
 */
export async function migrateProfileCatalogState(
  source: ProfileCatalogCheckpoint,
  target: ProfileCatalogStore,
  options: Readonly<{ sourceIsBootstrap: boolean }>,
  signal?: AbortSignal,
): Promise<ProfileCatalogMigration> {
  const initial = await target.load(signal);
  if (!initial) {
    const initialized = await target.initialize(source.catalog, signal);
    if (initialized.disposition === "created") {
      return Object.freeze({ checkpoint: initialized.checkpoint, disposition: "created" });
    }
    return reconcileMigration(target, resolveExistingCatalog(source, initialized.checkpoint, options.sourceIsBootstrap), signal);
  }
  return reconcileMigration(target, resolveExistingCatalog(source, initial, options.sourceIsBootstrap), signal);
}

async function reconcileMigration(
  target: ProfileCatalogStore,
  migration: ProfileCatalogMigration,
  signal?: AbortSignal,
): Promise<ProfileCatalogMigration> {
  const checkpoint = await reconcileAdoptedProfileCatalog(target, migration.checkpoint, signal);
  return checkpoint === migration.checkpoint
    ? migration
    : Object.freeze({ checkpoint, disposition: migration.disposition });
}

/**
 * Bring an adopted catalog up to this release's built-in skills.
 *
 * An adopted catalog is authoritative for everything a person authored, but it
 * is not authoritative about which skills this build ships: nothing unions the
 * two, so a Vault written by an older release froze the skill set for every
 * later boot, and a skill added after adoption could never appear. The union is
 * committed as an ordinary generation bump so the digest/etag chain stays
 * valid and the change is as auditable as any other catalog revision.
 *
 * It is best-effort by design. A concurrent writer, an offline authority, or a
 * store that refuses the write leaves the reader with exactly what they had —
 * a missing skill card is not a reason to fail adoption and strand a workspace.
 */
export async function reconcileAdoptedProfileCatalog(
  target: ProfileCatalogStore,
  checkpoint: ProfileCatalogCheckpoint,
  signal?: AbortSignal,
): Promise<ProfileCatalogCheckpoint> {
  const builtIn = await createBuiltInProfileCatalog();
  const reconciled = reconcileBuiltInThemes(reconcileBuiltInSkills(checkpoint.catalog, builtIn), builtIn);
  if (reconciled === checkpoint.catalog) return checkpoint;
  try {
    return await target.commit(checkpoint, reconciled, signal);
  } catch {
    return checkpoint;
  }
}

function resolveExistingCatalog(
  source: ProfileCatalogCheckpoint,
  existing: ProfileCatalogCheckpoint,
  sourceIsBootstrap: boolean,
): ProfileCatalogMigration {
  if (source.digest === existing.digest) {
    return Object.freeze({ checkpoint: existing, disposition: "matched" });
  }
  if (sourceIsBootstrap) {
    return Object.freeze({ checkpoint: existing, disposition: "adopted-existing" });
  }
  throw new ProfileCatalogConflictError(
    "The selected Vault contains a different profile catalog. No profile, theme, or skill revision was overwritten.",
  );
}

function sameWorkspaceSnapshot(
  before: readonly { path: string; revision: string }[],
  after: readonly { path: string; revision: string }[],
): boolean {
  if (before.length !== after.length) return false;
  const revisions = new Map(before.map((entry) => [entry.path, entry.revision]));
  return after.every((entry) => revisions.get(entry.path) === entry.revision);
}

function sameSessionRecord(left: SessionRecord, right: SessionRecord): boolean {
  return stableStringify(left as unknown as JsonValue) === stableStringify(right as unknown as JsonValue);
}
