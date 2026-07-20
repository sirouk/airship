import type { EventJournal, JournalBackend } from "../core/journal";
import { isGitWorkspaceControlPlanePath, type WorkspacePort } from "../workspace/contracts";

/** Copy a stable workspace snapshot without overwriting divergent cloud state. */
export async function migrateWorkspaceState(source: WorkspacePort, target: WorkspacePort): Promise<void> {
  const entries = (await source.list()).filter((entry) => !isGitWorkspaceControlPlanePath(entry.path));
  const snapshot = [];
  for (const entry of entries) {
    // Git checkpoints have their own object-integrity and fenced-head protocol.
    // Copying them as ordinary files would bypass reconciliation or surface a
    // misleading generic workspace conflict during a durability-mode switch.
    const file = await source.read(entry.path);
    if (!file) throw new Error(`Workspace file disappeared during vault migration: ${entry.path}.`);
    if (file.revision !== entry.revision) throw new Error(`Workspace changed during vault migration: ${entry.path}.`);
    snapshot.push(file);
  }
  const freshEntries = (await source.list()).filter((entry) => !isGitWorkspaceControlPlanePath(entry.path));
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
    if (
      !fresh ||
      fresh.headSequence !== session.headSequence ||
      fresh.headDigest !== session.headDigest ||
      events.at(-1)?.sequence !== session.headSequence ||
      events.at(-1)?.digest !== session.headDigest
    ) {
      throw new Error(`Session ${session.id} changed during vault migration; retry after the turn settles.`);
    }
    const existing = await target.getSession(session.id);
    if (existing) {
      if (
        existing.headSequence !== session.headSequence ||
        existing.headDigest !== session.headDigest ||
        existing.manifest.systemPromptDigest !== session.manifest.systemPromptDigest ||
        existing.manifest.toolManifestDigest !== session.manifest.toolManifestDigest
      ) {
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

function sameWorkspaceSnapshot(
  before: readonly { path: string; revision: string }[],
  after: readonly { path: string; revision: string }[],
): boolean {
  if (before.length !== after.length) return false;
  const revisions = new Map(before.map((entry) => [entry.path, entry.revision]));
  return after.every((entry) => revisions.get(entry.path) === entry.revision);
}
