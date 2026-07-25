import type {
  CompareAndSwapResult,
  ObjectRange,
  ObjectRecord,
  ObjectStore,
  ObjectSummary,
  PutIfAbsentResult,
} from "./object-store";
import {
  ClientCiphertextCache,
  type CiphertextCacheAddress,
  type CiphertextCacheCapability,
  type CiphertextCacheKind,
} from "./client-ciphertext-cache";

export type ImmutableCiphertextClassifier = (key: string) => CiphertextCacheKind | undefined;

/**
 * Caches only explicitly immutable encrypted objects. Provider reads remain
 * authoritative for mutable heads, listing, create-if-absent, and every CAS.
 */
export class CiphertextCachingObjectStore implements ObjectStore {
  readonly capabilities;
  readonly acceleration: CiphertextCacheCapability;

  constructor(
    private readonly authority: ObjectStore,
    private readonly cache: ClientCiphertextCache,
    private readonly classifyImmutable: ImmutableCiphertextClassifier = classifyVaultImmutableCiphertext,
  ) {
    this.capabilities = authority.capabilities;
    this.acceleration = cache.capability;
  }

  async get(key: string, signal?: AbortSignal): Promise<ObjectRecord | undefined> {
    signal?.throwIfAborted();
    const kind = this.classifyImmutable(key);
    if (kind) {
      const cached = await this.cache.get({ objectKey: key, kind });
      signal?.throwIfAborted();
      if (cached) {
        return {
          key,
          bytes: cached.bytes,
          etag: cached.etag,
          ...(cached.updatedAt ? { updatedAt: cached.updatedAt } : {}),
        };
      }
    }
    const record = await this.authority.get(key, signal);
    signal?.throwIfAborted();
    if (record && kind) await this.writeCache({ objectKey: key, kind }, record);
    return record;
  }

  async getRange(
    key: string,
    start: number,
    endExclusive: number,
    signal?: AbortSignal,
  ): Promise<ObjectRange | undefined> {
    validateRange(start, endExclusive, this.authority.capabilities.rangeRead.maxBytes);
    signal?.throwIfAborted();
    const kind = this.classifyImmutable(key);
    if (kind) {
      const address: CiphertextCacheAddress = { objectKey: key, kind, range: { start, endExclusive } };
      const cachedRange = await this.cache.get(address);
      signal?.throwIfAborted();
      if (cachedRange) {
        return {
          key,
          bytes: cachedRange.bytes,
          etag: cachedRange.etag,
          start,
          endExclusive,
          ...(cachedRange.totalSize !== undefined ? { totalSize: cachedRange.totalSize } : {}),
        };
      }
      const cachedFull = await this.cache.get({ objectKey: key, kind });
      signal?.throwIfAborted();
      if (cachedFull) {
        if (endExclusive > cachedFull.bytes.byteLength) throw new Error("Object range exceeds the cached immutable object size.");
        return {
          key,
          bytes: cachedFull.bytes.slice(start, endExclusive),
          etag: cachedFull.etag,
          start,
          endExclusive,
          totalSize: cachedFull.bytes.byteLength,
        };
      }
    }
    const range = await this.authority.getRange(key, start, endExclusive, signal);
    signal?.throwIfAborted();
    if (range && kind) {
      await this.writeCache(
        { objectKey: key, kind, range: { start, endExclusive } },
        { bytes: range.bytes, etag: range.etag, totalSize: range.totalSize },
      );
    }
    return range;
  }

  async putIfAbsent(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<PutIfAbsentResult> {
    const result = await this.authority.putIfAbsent(key, bytes, signal);
    signal?.throwIfAborted();
    const kind = this.classifyImmutable(key);
    if (result.created && kind) {
      await this.writeCache({ objectKey: key, kind }, { bytes, etag: result.etag });
    }
    return result;
  }

  async compareAndSwap(
    key: string,
    expectedEtag: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<CompareAndSwapResult> {
    // Never satisfy or decide a compare-and-swap from local state.
    const result = await this.authority.compareAndSwap(key, expectedEtag, bytes, signal);
    signal?.throwIfAborted();
    const kind = this.classifyImmutable(key);
    if (kind) await this.cache.remove({ objectKey: key, kind }).catch(() => undefined);
    return result;
  }

  list(prefix: string, signal?: AbortSignal): Promise<ObjectSummary[]> {
    // A cache inventory cannot establish provider presence or current heads.
    return this.authority.list(prefix, signal);
  }

  closeAcceleration(): void {
    this.cache.close();
  }

  private async writeCache(
    address: CiphertextCacheAddress,
    value: Readonly<{ bytes: Uint8Array; etag: string; updatedAt?: string; totalSize?: number }>,
  ): Promise<void> {
    // Quota, eviction, worker failure, and cache corruption must never turn a
    // committed provider operation into an application failure.
    await this.cache.put(address, value).catch(() => undefined);
  }
}

/**
 * These key families are immutable by their producing protocol. Mutable
 * workspace/session/profile heads deliberately do not match.
 */
export function classifyVaultImmutableCiphertext(key: string): CiphertextCacheKind | undefined {
  if (!key || key.length > 4_096) return undefined;
  if (key.startsWith("context/segments/")) return "index-page";
  if (/^(?:[A-Za-z0-9._:@=+-]+\/)*state\/workspace\/v1\/files\/[A-Za-z0-9_-]+$/u.test(key)) {
    // Conventional Git object/index/ref files use this same encrypted
    // workspace family. Logical paths are hidden inside the client envelope.
    return "workspace";
  }
  return undefined;
}

function validateRange(start: number, endExclusive: number, maxBytes: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive <= start) {
    throw new Error("Object ranges require non-negative, increasing integer offsets.");
  }
  if (endExclusive - start > maxBytes) throw new Error("Object range exceeds the authoritative provider limit.");
}
