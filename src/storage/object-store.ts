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

export class ObjectConflictError extends Error {
  constructor(message = "The cloud object changed before the conditional write completed.") {
    super(message);
    this.name = "ObjectConflictError";
  }
}
