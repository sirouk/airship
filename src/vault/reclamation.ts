import {
  hasUntrackedObjectSweep,
  isReclaimableObjectStore,
  type ObjectStore,
} from "../storage/object-store";
import type { EncryptedObjectWorkspace } from "./encrypted-workspace";
import type { ReclamationQueueEntry, VaultReclamationQueue } from "./reclamation-queue";

/**
 * The default grace between "a committed CAS made this revision unreachable"
 * and "the provider may be asked to trash it". It exists for one reader: the
 * page (or peer) still holding the pre-supersession authority root. Page
 * lifetimes are minutes, but a forgotten tab is not, and Drive's own trash
 * retains for thirty days behind this client-side bound — so the default is a
 * week, with a floor below which a caller is really just deleting inline.
 */
export const DEFAULT_RECLAMATION_SAFETY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_RECLAMATION_SAFETY_AGE_MS = 60 * 60 * 1000;
export const MAX_RECLAMATION_SAFETY_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const MAX_TRASH_BATCH = 500;
const MAX_UNTRACKED_PAGES = 200;
const MAX_UNTRACKED_TRASH_PER_RUN = 2_000;
const MAX_RECEIPT_KEYS = 1_000;

/** The receipt never names more offenders than it needs to be read. */
function boundedKeys(keys: readonly string[]): Readonly<{ keys: readonly string[]; truncated: boolean }> {
  if (keys.length <= MAX_RECEIPT_KEYS) return { keys, truncated: false };
  return { keys: keys.slice(0, MAX_RECEIPT_KEYS), truncated: true };
}

export type VaultReclamationQueueReport = Readonly<{
  /** Entries the durable queue held when the sweep started. */
  queued: number;
  /** Of those, past the safety age at run start. */
  aged: number;
  /** Too young to consider; never offered to the provider. */
  deferredYoung: number;
  /** Aged, but of a kind this run could not re-verify against a fresh root. */
  skippedUnverifiable: number;
  /**
   * Aged, but the fresh authority root still names them. The queue entry is
   * noise — a producer-side race the CAS order already resolved — so the
   * entry is dropped and nothing is offered to the provider. This count is
   * the queue correcting itself out loud.
   */
  reconciledReferenced: number;
  /** Aged, unreferenced, and actually offered to provider reclamation. */
  requested: number;
  /** Provider-confirmed removals. */
  reclaimed: number;
  /** Offered but not provider-confirmed; they remain queued for a later run. */
  retained: number;
  reclaimedKeys: readonly string[];
  retainedKeys: readonly string[];
  keysTruncated: boolean;
  confirmationCommitted: "committed" | "uncommitted" | "not-needed";
  /** False when the queue object could not be read; the phase is then a no-op. */
  queueReadable: boolean;
  note?: string;
}>;

export type VaultReclamationUntrackedReport =
  | Readonly<{ status: "unavailable" }>
  | Readonly<{
      status: "completed" | "truncated" | "failed";
      examined: number;
      agedCandidates: number;
      requested: number;
      reclaimed: number;
      retained: number;
      note?: string;
    }>;

export type VaultReclamationSweepReceipt = Readonly<{
  runId: string;
  startedAt: string;
  completedAt: string;
  safetyAgeMs: number;
  queue: VaultReclamationQueueReport;
  untracked: VaultReclamationUntrackedReport;
}>;

/**
 * The bounded reclamation job Drive release gate 3 asks for: the aged
 * candidate queue and the provider-side untracked enumeration, each with a
 * re-verification step in front of every removal request and a receipt that
 * never claims an unconfirmed removal.
 */
export async function runVaultReclamationSweep(args: {
  /**
   * The adopted store for key-addressed reclamation — the runtime facade, so
   * confirmed removals also drop acceleration cache pages. When it cannot
   * reclaim, the queue phase reports zero requested rather than pretending.
   */
  store: ObjectStore;
  /**
   * The direct provider store for untracked enumeration, when the runtime
   * facade does not forward those verbs. Untracked bodies were never read by
   * key, so no cache coherence depends on going through the facade.
   */
  authorityStore?: ObjectStore;
  workspace: EncryptedObjectWorkspace;
  queue: VaultReclamationQueue;
  /**
   * Fresh referenced-key sets for non-workspace candidate kinds. Returning
   * `undefined` marks that kind unverifiable this run — skipped, never trashed.
   */
  resolveReferences?: (
    kind: ReclamationQueueEntry["kind"],
  ) => Promise<ReadonlySet<string> | undefined>;
  now: () => Date;
  safetyAgeMs?: number;
  signal?: AbortSignal;
  runId: string;
}): Promise<VaultReclamationSweepReceipt> {
  const safetyAgeMs = args.safetyAgeMs ?? DEFAULT_RECLAMATION_SAFETY_AGE_MS;
  if (
    !Number.isSafeInteger(safetyAgeMs) ||
    safetyAgeMs < MIN_RECLAMATION_SAFETY_AGE_MS ||
    safetyAgeMs > MAX_RECLAMATION_SAFETY_AGE_MS
  ) {
    throw new Error(
      `Reclamation safety age must be between ${String(MIN_RECLAMATION_SAFETY_AGE_MS)} and ${String(MAX_RECLAMATION_SAFETY_AGE_MS)} milliseconds.`,
    );
  }
  const runId = validRunId(args.runId);
  const startedAt = args.now().toISOString();
  const agedBefore = args.now().getTime() - safetyAgeMs;

  args.signal?.throwIfAborted();
  const queue = await sweepQueue(args, agedBefore);
  args.signal?.throwIfAborted();
  const untracked = await sweepUntracked(args, agedBefore);

  return Object.freeze({
    runId,
    startedAt,
    completedAt: args.now().toISOString(),
    safetyAgeMs,
    queue,
    untracked,
  });
}

async function sweepQueue(
  args: Parameters<typeof runVaultReclamationSweep>[0],
  agedBefore: number,
): Promise<VaultReclamationQueueReport> {
  const empty = (overrides: Partial<VaultReclamationQueueReport>): VaultReclamationQueueReport =>
    Object.freeze({
      queued: 0, aged: 0, deferredYoung: 0, skippedUnverifiable: 0, reconciledReferenced: 0,
      requested: 0, reclaimed: 0, retained: 0,
      reclaimedKeys: Object.freeze([]), retainedKeys: Object.freeze([]), keysTruncated: false,
      confirmationCommitted: "not-needed", queueReadable: true, ...overrides,
    });

  let entries: readonly ReclamationQueueEntry[];
  try {
    entries = await args.queue.readEntries();
  } catch {
    // An unreadable encrypted root stops this phase, not the whole job: the
    // provider-side enumeration needs no key and still runs.
    return empty({ queueReadable: false, note: "The reclamation queue could not be decrypted or validated; nothing it names was touched." });
  }
  if (!entries.length) return empty({});

  const agedEntries = entries.filter((entry) => Date.parse(entry.supersededAt) <= agedBefore);
  const youngCount = entries.length - agedEntries.length;
  if (!agedEntries.length) return empty({ queued: entries.length, deferredYoung: youngCount });

  // Re-verification: fresh roots first, removals second. The workspace
  // manifest is loaded once here and is the authority for every decision in
  // this phase; the provider's own per-call fresh reloads back it up for the
  // untracked phase below.
  const workspaceReferences = new Set(await args.workspace.collectReferencedObjectKeys());
  args.signal?.throwIfAborted();
  const referencesByKind = new Map<string, ReadonlySet<string> | undefined>();
  for (const entry of agedEntries) {
    if (entry.kind === "workspace-file" || referencesByKind.has(entry.kind)) continue;
    referencesByKind.set(
      entry.kind,
      args.resolveReferences ? await args.resolveReferences(entry.kind).catch(() => undefined) : undefined,
    );
    args.signal?.throwIfAborted();
  }

  const referenceSetFor = (kind: ReclamationQueueEntry["kind"]): ReadonlySet<string> | undefined =>
    kind === "workspace-file" ? workspaceReferences : referencesByKind.get(kind);

  const candidates: string[] = [];
  const reconciled: string[] = [];
  let skippedUnverifiable = 0;
  for (const entry of agedEntries) {
    const references = referenceSetFor(entry.kind);
    if (!references) {
      skippedUnverifiable += 1;
      continue;
    }
    if (references.has(entry.cloudKey)) {
      reconciled.push(entry.cloudKey);
      continue;
    }
    candidates.push(entry.cloudKey);
  }

  if (!isReclaimableObjectStore(args.store)) {
    // Even without a trash verb the fresh-root pass did real work: reconcile
    // noise out of the queue so it never ages into a false removal request.
    let confirmationCommitted: VaultReclamationQueueReport["confirmationCommitted"] = "not-needed";
    if (reconciled.length) {
      confirmationCommitted = (await args.queue.confirmReclaimed(reconciled)) ? "committed" : "uncommitted";
    }
    return empty({
      queued: entries.length,
      aged: agedEntries.length,
      deferredYoung: youngCount,
      skippedUnverifiable,
      reconciledReferenced: reconciled.length,
      confirmationCommitted,
      note: reconciled.length
        ? `This Vault store cannot reclaim objects; aged candidates stay queued. ${String(reconciled.length)} self-corrected entries were dropped.`
        : "This Vault store cannot reclaim objects; aged candidates stay queued.",
    });
  }

  const reclaimed: string[] = [];
  const retained: string[] = [];
  for (let offset = 0; offset < candidates.length; offset += MAX_TRASH_BATCH) {
    const batch = candidates.slice(offset, offset + MAX_TRASH_BATCH);
    const receipt = await args.store.trash(batch, args.signal);
    reclaimed.push(...receipt.reclaimed);
    retained.push(...receipt.retained);
    args.signal?.throwIfAborted();
  }

  // Confirmed removals and self-correcting reconciles leave the queue together;
  // anything else stays for the next run. The receipt below is truth regardless
  // of this commit: it reports what the provider did, and says when the queue
  // could not be told about it.
  const settled = [...reclaimed, ...reconciled];
  const confirmationCommitted: VaultReclamationQueueReport["confirmationCommitted"] = settled.length
    ? (await args.queue.confirmReclaimed(settled)) ? "committed" : "uncommitted"
    : "not-needed";

  const boundedReclaimed = boundedKeys(reclaimed);
  const boundedRetained = boundedKeys(retained);
  return empty({
    queued: entries.length,
    aged: agedEntries.length,
    deferredYoung: youngCount,
    skippedUnverifiable,
    reconciledReferenced: reconciled.length,
    requested: candidates.length,
    reclaimed: reclaimed.length,
    retained: retained.length,
    reclaimedKeys: Object.freeze(boundedReclaimed.keys),
    retainedKeys: Object.freeze(boundedRetained.keys),
    keysTruncated: boundedReclaimed.truncated || boundedRetained.truncated,
    confirmationCommitted,
  });
}

async function sweepUntracked(
  args: Parameters<typeof runVaultReclamationSweep>[0],
  agedBefore: number,
): Promise<VaultReclamationUntrackedReport> {
  const authority = args.authorityStore ?? args.store;
  if (!hasUntrackedObjectSweep(authority)) return Object.freeze({ status: "unavailable" as const });

  let examined = 0;
  let requested = 0;
  let reclaimed = 0;
  let retained = 0;
  let agedCandidates = 0;
  let truncated = false;
  let pageToken: string | undefined;
  const agedIds: string[] = [];

  try {
    for (let pages = 0; pages < MAX_UNTRACKED_PAGES; pages += 1) {
      args.signal?.throwIfAborted();
      const page = await authority.listUntrackedProviderObjects({ pageToken, signal: args.signal });
      examined += page.objects.length;
      for (const object of page.objects) {
        // A provider that cannot date a body gets the conservative answer:
        // young until proven aged. The next sweep asks again.
        if (!object.createdAt || Date.parse(object.createdAt) > agedBefore) continue;
        agedCandidates += 1;
        agedIds.push(object.providerObjectId);
      }
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return Object.freeze({
      status: "failed" as const,
      examined, agedCandidates, requested, reclaimed, retained,
      note: "Provider-side enumeration did not complete; no trash was requested for unlisted bodies.",
    });
  }

  const budget = Math.min(agedIds.length, MAX_UNTRACKED_TRASH_PER_RUN);
  truncated = agedIds.length > budget;
  for (let offset = 0; offset < budget; offset += 100) {
    const batch = agedIds.slice(offset, Math.min(offset + 100, budget));
    const receipt = await authority.trashUntrackedProviderObjects(batch, args.signal);
    requested += receipt.requested;
    reclaimed += receipt.reclaimed.length;
    retained += receipt.retained.length;
    args.signal?.throwIfAborted();
  }

  return Object.freeze({
    status: truncated ? "truncated" as const : "completed" as const,
    examined, agedCandidates, requested, reclaimed, retained,
    ...(truncated ? { note: "More aged untracked bodies remain than this run's removal budget; a later sweep continues where this one stopped." } : {}),
  });
}

function validRunId(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(value)) throw new Error("Reclamation run identifier is invalid.");
  return value;
}
