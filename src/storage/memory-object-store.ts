import { sha256 } from "../core/hash";
import type {
  CompareAndSwapResult,
  ObjectRange,
  ObjectRecord,
  ObjectStore,
  ObjectSummary,
  PutIfAbsentResult,
  ObjectStoreCapabilities,
} from "./object-store";

export class MemoryObjectStore implements ObjectStore {
  readonly capabilities: ObjectStoreCapabilities = Object.freeze({
    version: 1,
    adapter: "memory",
    rangeRead: Object.freeze({ mode: "exact-or-fail", maxBytes: Number.MAX_SAFE_INTEGER, providerEvidence: "in-process" }),
    conditionalWrite: Object.freeze({ createIfAbsent: "atomic-or-fail", compareAndSwap: "atomic-or-fail", providerEvidence: "in-process" }),
    upload: Object.freeze({ mode: "single-request", interruptionRecovery: "none", persistsResumeCapability: false }),
  });
  private readonly objects = new Map<string, ObjectRecord>();

  async get(key: string): Promise<ObjectRecord | undefined> {
    const object = this.objects.get(key);
    return object ? { ...object, bytes: object.bytes.slice() } : undefined;
  }

  async getRange(key: string, start: number, endExclusive: number): Promise<ObjectRange | undefined> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive <= start) {
      throw new Error("Object ranges require non-negative, increasing integer offsets.");
    }
    const object = this.objects.get(key);
    if (!object) return undefined;
    if (endExclusive > object.bytes.byteLength) throw new Error("Object range exceeds the stored object size.");
    return {
      key,
      bytes: object.bytes.slice(start, endExclusive),
      etag: object.etag,
      start,
      endExclusive,
      totalSize: object.bytes.byteLength,
    };
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<PutIfAbsentResult> {
    const etag = await sha256(bytes);
    const existing = this.objects.get(key);
    if (existing) return { currentEtag: existing.etag, created: false, reason: "exists" };
    this.objects.set(key, { key, bytes: bytes.slice(), etag, updatedAt: new Date().toISOString() });
    return { etag, created: true };
  }

  async compareAndSwap(
    key: string,
    expectedEtag: string,
    bytes: Uint8Array,
  ): Promise<CompareAndSwapResult> {
    // Hash before the linearization point. Once execution resumes, the current
    // ETag check and Map update are synchronous, so concurrent writers cannot
    // both win with the same expected version.
    const etag = await sha256(bytes);
    const existing = this.objects.get(key);
    if (!existing || existing.etag !== expectedEtag) {
      return {
        currentEtag: existing?.etag,
        updated: false,
        reason: existing ? "precondition-failed" : "missing",
      };
    }
    this.objects.set(key, { key, bytes: bytes.slice(), etag, updatedAt: new Date().toISOString() });
    return { etag, updated: true };
  }

  async list(prefix: string): Promise<ObjectSummary[]> {
    return [...this.objects.values()]
      .filter((object) => object.key.startsWith(prefix))
      .map(({ bytes, ...object }) => ({ ...object, size: bytes.byteLength }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}
