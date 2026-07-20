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

export interface ObjectStore {
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

export class ObjectConflictError extends Error {
  constructor(message = "The cloud object changed before the conditional write completed.") {
    super(message);
    this.name = "ObjectConflictError";
  }
}
