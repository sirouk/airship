import type { JsonValue } from "../core/contracts";
import { stableStringify } from "../core/hash";
import type { EventJournal, JournalBackend, SessionRecord } from "../core/journal";
import {
  ProfileCatalogConflictError,
  type ProfileCatalogCheckpoint,
  type ProfileCatalogStore,
} from "../profiles/persistence";
import { isLegacyGitCheckpointPath, type WorkspacePort } from "../workspace/contracts";

/** Copy a stable workspace snapshot without overwriting divergent cloud state. */
export async function migrateWorkspaceState(source: WorkspacePort, target: WorkspacePort): Promise<void> {
  const entries = (await source.list()).filter((entry) => !isLegacyGitCheckpointPath(entry.path));
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
  const freshEntries = (await source.list()).filter((entry) => !isLegacyGitCheckpointPath(entry.path));
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
    return resolveExistingCatalog(source, initialized.checkpoint, options.sourceIsBootstrap);
  }
  return resolveExistingCatalog(source, initial, options.sourceIsBootstrap);
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
