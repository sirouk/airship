export type ObjectRecord = {
  key: string;
  bytes: Uint8Array;
  etag: string;
  updatedAt?: string;
};

export type ObjectSummary = Omit<ObjectRecord, "bytes"> & { size: number };

export type ObjectRange = {
  key: string;
  bytes: Uint8Array;
  etag: string;
  start: number;
  endExclusive: number;
  totalSize?: number;
};

export type PutIfAbsentResult =
  | { created: true; etag: string }
  | { created: false; currentEtag?: string; reason: "exists" };

export type CompareAndSwapResult =
  | { updated: true; etag: string }
  | { updated: false; currentEtag?: string; reason: "precondition-failed" | "missing" };

export type ObjectStoreCapabilities = Readonly<{
  version: 1;
  adapter: "memory" | "direct" | "s3" | "google-drive" | "local-device";
  rangeRead: Readonly<{
    mode: "exact-or-fail";
    maxBytes: number;
    /** Network adapters still require a live probe for the selected deployment. */
    providerEvidence: "in-process" | "live-conformance-required";
  }>;
  conditionalWrite: Readonly<{
    createIfAbsent: "atomic-or-fail";
    compareAndSwap: "atomic-or-fail";
    providerEvidence: "in-process" | "live-conformance-required";
  }>;
  upload: Readonly<{
    mode: "single-request" | "multipart-request" | "resumable-active-call";
    interruptionRecovery: "none" | "retry-immutable-shard" | "resume-current-call";
    /** False means no bearer-like resume URI survives a refresh or process loss. */
    persistsResumeCapability: false;
  }>;
}>;

export interface ObjectStore {
  readonly capabilities: ObjectStoreCapabilities;
  get(key: string, signal?: AbortSignal): Promise<ObjectRecord | undefined>;
  getRange(key: string, start: number, endExclusive: number, signal?: AbortSignal): Promise<ObjectRange | undefined>;
  putIfAbsent(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<PutIfAbsentResult>;
  compareAndSwap(
    key: string,
    expectedEtag: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<CompareAndSwapResult>;
  list(prefix: string, signal?: AbortSignal): Promise<ObjectSummary[]>;
}

export type ObjectReclamationOutcome =
  | Readonly<{ key: string; reclaimed: true }>
  | Readonly<{ key: string; reclaimed: false; reason: "not-indexed" | "refused" | "unconfirmed" }>;

export type ObjectReclamationReceipt = Readonly<{
  requested: number;
  /** Provider-confirmed removals only; every other key stays in `retained`. */
  reclaimed: readonly string[];
  retained: readonly string[];
  outcomes: readonly ObjectReclamationOutcome[];
}>;

/**
 * An optional capability, not part of `ObjectStore`.
 *
 * The base contract is deliberately delete-free so that a lost conditional write
 * can never destroy data. `trash` exists only for objects a caller can prove are
 * unreachable — probe litter and superseded revisions past a safety age. It
 * removes the index entry first and only then asks the provider to trash the
 * body: a crash between the two can leak an untracked file, which a later sweep
 * recovers, whereas the reverse order would leave an index entry whose `get()`
 * hard-fails. No cross-system atomicity is achievable here.
 *
 * This is index-addressed reclamation. Enumerating untracked provider-side
 * orphans (lost-race uploads) is a separate, not-yet-implemented job.
 */
export interface ReclaimableObjectStore extends ObjectStore {
  trash(keys: readonly string[], signal?: AbortSignal): Promise<ObjectReclamationReceipt>;
}

export function isReclaimableObjectStore(store: ObjectStore): store is ReclaimableObjectStore {
  return typeof (store as Partial<ReclaimableObjectStore>).trash === "function";
}

/**
 * A body the provider holds that no object index entry names, addressed by the
 * provider's own identifier because there is no logical key to address it by.
 * `createdAt` is whatever the provider recorded for the upload; a store that
 * cannot prove a creation time omits it and the caller treats the object as
 * too young for any age-gated reclamation.
 */
export type UntrackedProviderObject = Readonly<{
  providerObjectId: string;
  size: number;
  createdAt?: string;
}>;

export type UntrackedProviderObjectPage = Readonly<{
  objects: readonly UntrackedProviderObject[];
  nextPageToken?: string;
}>;

export type UntrackedReclamationOutcome =
  | Readonly<{ providerObjectId: string; reclaimed: true }>
  | Readonly<{ providerObjectId: string; reclaimed: false; reason: "became-tracked" | "refused" | "unconfirmed" }>;

export type UntrackedProviderReclamationReceipt = Readonly<{
  requested: number;
  /** Provider-confirmed removals only; every other identifier stays in `retained`. */
  reclaimed: readonly string[];
  retained: readonly string[];
  outcomes: readonly UntrackedReclamationOutcome[];
}>;

/**
 * An optional capability beyond `ReclaimableObjectStore`: enumeration of the
 * crash windows that index-addressed reclamation structurally cannot see —
 * uploads whose routing-index commit lost a race, and bodies whose index entry
 * removal committed before a failed trash call.
 *
 * The enumeration is computed against a fresh index. Provider pages hold
 * whatever the folder query matches, so any single page can legitimately
 * contain zero untracked bodies while a token remains — callers page to
 * exhaustion and treat the union across pages as the answer. The trash verb
 * re-loads a fresh index per call, so a body that became tracked between the
 * sweep's listing and its trash request is answered `became-tracked` and
 * never touched. The remaining race window — one network round-trip against an
 * upload that waited the whole safety age before its index commit — is the
 * documented bound of provider-side reclamation, and callers still apply a
 * safety age on top of it.
 */
export interface UntrackedObjectSweepStore extends ObjectStore {
  listUntrackedProviderObjects(options?: {
    pageSize?: number;
    pageToken?: string;
    signal?: AbortSignal;
  }): Promise<UntrackedProviderObjectPage>;
  trashUntrackedProviderObjects(
    providerObjectIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<UntrackedProviderReclamationReceipt>;
}

export function hasUntrackedObjectSweep(store: ObjectStore): store is UntrackedObjectSweepStore {
  const candidate = store as Partial<UntrackedObjectSweepStore>;
  return (
    typeof candidate.listUntrackedProviderObjects === "function" &&
    typeof candidate.trashUntrackedProviderObjects === "function"
  );
}

export class ObjectConflictError extends Error {
  constructor(message = "The cloud object changed before the conditional write completed.") {
    super(message);
    this.name = "ObjectConflictError";
  }
}
