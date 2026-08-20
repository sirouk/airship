import { ownedArrayBuffer } from "../core/bytes";
import { sha256 } from "../core/hash";
import {
  pageCompanionClient,
  type PageCompanionClient,
} from "../inference/bridge/companion-client";

const CACHE_VERSION = 1;
const RECORD_MAGIC = "AIRCC01\0";
const RECORD_MAGIC_BYTES = new TextEncoder().encode(RECORD_MAGIC);
const HEADER_PREFIX_BYTES = RECORD_MAGIC_BYTES.byteLength + 4;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CIPHERTEXT_BYTES = 64 * 1024 * 1024;
const MAX_PERSISTED_RECORD_BYTES = HEADER_PREFIX_BYTES + MAX_HEADER_BYTES + MAX_CIPHERTEXT_BYTES;
const OPFS_ROOT = "airship-ciphertext-cache-v1";
const OPFS_START_TIMEOUT_MS = 5_000;
const CACHE_DATABASE_VERSION = 2;
const CACHE_STORE = "ciphertext-pages";
const WORKER_POLICY_NAME = "airship-opfs-worker";
/**
 * The cache is an acceleration layer, so its ceiling exists to protect the
 * origin's storage budget — the Local Device vault shares that budget and a
 * quota eviction takes the whole origin bucket, not just this cache.
 */
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
/**
 * The LRU index is rewritten whole, so an entry ceiling is as load-bearing as
 * the byte ceiling: a byte-only budget over small Git objects would mean tens of
 * thousands of entries and a multi-megabyte index rewrite per put.
 */
const MAX_CACHE_ENTRIES = 4_096;
/** Removal tombstones held between flushes; one per index row is sufficient. */
const MAX_DROPPED_KEYS = MAX_CACHE_ENTRIES;
/** Never claim more than this share of the origin quota for a cache. */
const MAX_CACHE_QUOTA_FRACTION = 0.25;
/** Read-path recency updates are coalesced so a hit never costs an index write. */
const INDEX_FLUSH_INTERVAL_MS = 1_000;
const INDEX_LOCK_TIMEOUT_MS = 5_000;
const INDEX_SOURCE = "airship/ciphertext-cache-index/v1";
const INDEX_VERSION = 1;
/**
 * Reconciliation must be able to see more pages than the entry ceiling allows,
 * otherwise orphans left by an older build could hide above the cutoff forever.
 */
const MAX_LISTED_PAGES = 4 * MAX_CACHE_ENTRIES;
/**
 * Web Lock naming a partition's cache directory. A live cache holds it shared;
 * a reclaiming worker must take it exclusively before deleting that directory,
 * which is the only way a worker can establish that a sibling partition is not
 * in use by another tab right now.
 */
const PARTITION_LOCK_PREFIX = "airship-ciphertext-cache-partition/";
/** Sibling directories examined per initialization; a ceiling, not a target. */
const MAX_SWEPT_PARTITIONS = 64;
/**
 * Deliberately shorter than the worker start deadline: an unavailable partition
 * lock must degrade to "reclaim nothing", never to a cache that fails to open.
 */
const PARTITION_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_COMPANION_RECORD_LIMIT = 4 * 1024 * 1024;

export type CiphertextCacheKind = "workspace" | "git-object" | "index-page";
export type CiphertextCacheBackend =
  | "extension-indexeddb"
  | "opfs-sync-worker"
  | "opfs-async-worker"
  | "indexeddb"
  | "memory";

export type CiphertextCacheCapability = Readonly<{
  version: 1;
  active: true;
  backend: CiphertextCacheBackend;
  durability: "extension-origin-persistent" | "origin-private-persistent" | "page-memory";
  persistenceBoundary: "ciphertext-only";
  authority: "vault-provider-remains-authoritative";
  syncAccessHandle: "active" | "unavailable";
  classes: readonly CiphertextCacheKind[];
}>;

export type CiphertextCacheAddress = Readonly<{
  objectKey: string;
  kind: CiphertextCacheKind;
  range?: Readonly<{ start: number; endExclusive: number }>;
}>;

export type CiphertextCacheValue = Readonly<{
  bytes: Uint8Array;
  etag: string;
  updatedAt?: string;
  totalSize?: number;
}>;

export type CiphertextPageSummary = Readonly<{ storageKey: string; bytes: number }>;

export interface CiphertextPageBackend {
  readonly backend: CiphertextCacheBackend;
  readonly durability: CiphertextCacheCapability["durability"];
  readonly syncAccessHandle: CiphertextCacheCapability["syncAccessHandle"];
  read(storageKey: string): Promise<Uint8Array | undefined>;
  write(storageKey: string, bytes: Uint8Array): Promise<void>;
  remove(storageKey: string): Promise<void>;
  /**
   * Enumerating stored pages is required, not optional: a lost or corrupt LRU
   * index would otherwise strand persisted files that no eviction pass could
   * ever reclaim, because nothing else knows their storage keys.
   */
  list(): Promise<readonly CiphertextPageSummary[]>;
  close(): void;
}

type CacheHeader = Readonly<{
  version: 1;
  kind: CiphertextCacheKind;
  etag: string;
  ciphertextDigest: string;
  updatedAt?: string;
  range?: Readonly<{ start: number; endExclusive: number }>;
  totalSize?: number;
}>;

export type ClientCiphertextCacheOptions = Readonly<{
  partition: string;
  openExtension?: (partitionKey: string) => Promise<CiphertextPageBackend>;
  openOpfs?: (partitionKey: string) => Promise<CiphertextPageBackend>;
  openIndexedDb?: (partitionKey: string) => Promise<CiphertextPageBackend>;
  budget?: ClientCiphertextCacheBudget;
}>;

export type ClientCiphertextCacheBudget = Readonly<{
  maxBytes?: number;
  maxEntries?: number;
  /** Web Lock name serializing index mutation across tabs on one partition. */
  lockName?: string;
  estimateStorage?: () => Promise<Readonly<{ quota?: number }>>;
  now?: () => number;
}>;

type IndexEntry = { bytes: number; lastUsedAt: number };

type CacheIndexState = {
  readonly storageKey: string;
  readonly entries: Map<string, IndexEntry>;
  readonly maxBytes: number;
  readonly maxEntries: number;
  totalBytes: number;
};

/**
 * An integrity-checking, ciphertext-only acceleration cache.
 *
 * The cache never receives a workspace key or plaintext. Callers pass the
 * already-enveloped bytes destined for a Vault ObjectStore. Persistent cache
 * corruption is a miss: the entry is removed and provider authority is used.
 *
 * Total residency is bounded by a persisted LRU index. Every index failure is a
 * refusal to cache rather than an unbounded cache: an acceleration layer that
 * grows without a ceiling can trigger a whole-origin quota eviction, which would
 * take the Local Device vault's own records with it.
 */
export class ClientCiphertextCache {
  readonly capability: CiphertextCacheCapability;
  readonly #budget: ClientCiphertextCacheBudget;
  readonly #now: () => number;
  /**
   * Pages this instance has provably removed since its last successful flush.
   * The merge below adopts unknown persisted rows, so without this a page this
   * tab just deleted would be resurrected as a phantom row by its own stale
   * index record. Bounded: at the cap the merge simply over-counts, which only
   * shrinks the cache.
   */
  readonly #dropped = new Set<string>();
  #index?: Promise<CacheIndexState | undefined>;
  #dirty = false;
  #lastFlushAt = 0;
  #flushing?: Promise<void>;

  constructor(private readonly pages: CiphertextPageBackend, budget: ClientCiphertextCacheBudget = {}) {
    this.#budget = budget;
    this.#now = budget.now ?? (() => Date.now());
    this.capability = Object.freeze({
      version: CACHE_VERSION,
      active: true,
      backend: pages.backend,
      durability: pages.durability,
      persistenceBoundary: "ciphertext-only",
      authority: "vault-provider-remains-authoritative",
      syncAccessHandle: pages.syncAccessHandle,
      classes: Object.freeze(["workspace", "git-object", "index-page"] as const),
    });
  }

  async get(address: CiphertextCacheAddress): Promise<CiphertextCacheValue | undefined> {
    validateAddress(address);
    const storageKey = await cacheStorageKey(address);
    let encoded: Uint8Array | undefined;
    try {
      encoded = await this.pages.read(storageKey);
    } catch {
      return undefined;
    }
    if (!encoded) return undefined;
    try {
      const record = decodeRecord(encoded);
      if (!headerMatches(record.header, address)) throw new Error("Ciphertext cache address mismatch.");
      if (await sha256(record.bytes) !== record.header.ciphertextDigest) {
        throw new Error("Ciphertext cache digest mismatch.");
      }
      await this.touch(storageKey, encoded.byteLength);
      return Object.freeze({
        bytes: record.bytes,
        etag: record.header.etag,
        ...(record.header.updatedAt ? { updatedAt: record.header.updatedAt } : {}),
        ...(record.header.totalSize !== undefined ? { totalSize: record.header.totalSize } : {}),
      });
    } catch {
      await this.forget(storageKey);
      return undefined;
    }
  }

  async put(address: CiphertextCacheAddress, value: CiphertextCacheValue): Promise<void> {
    validateAddress(address);
    validateValue(address, value);
    const header: CacheHeader = Object.freeze({
      version: CACHE_VERSION,
      kind: address.kind,
      etag: value.etag,
      ciphertextDigest: await sha256(value.bytes),
      ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
      ...(address.range ? { range: Object.freeze({ ...address.range }) } : {}),
      ...(value.totalSize !== undefined ? { totalSize: value.totalSize } : {}),
    });
    const storageKey = await cacheStorageKey(address);
    const encoded = encodeRecord(header, value.bytes);
    const index = await this.openIndex();
    // No index means no ceiling, and an uncapped acceleration cache is a
    // durability hazard for the whole origin. Refuse the write instead.
    if (!index) return;
    if (encoded.byteLength > index.maxBytes) return;
    await this.reserve(index, storageKey, encoded.byteLength);
    await this.pages.write(storageKey, encoded);
    this.record(index, storageKey, encoded.byteLength);
    await this.flushIfDue(index);
  }

  async remove(address: CiphertextCacheAddress): Promise<void> {
    validateAddress(address);
    await this.forget(await cacheStorageKey(address));
  }

  close(): void {
    this.pages.close();
  }

  /** Drops one page without needing its address; failures stay silent misses. */
  private async forget(storageKey: string): Promise<void> {
    await this.pages.remove(storageKey).catch(() => undefined);
    this.tombstone(storageKey);
    const index = await this.openIndex();
    if (!index) return;
    const existing = index.entries.get(storageKey);
    if (!existing) return;
    index.entries.delete(storageKey);
    index.totalBytes -= existing.bytes;
    this.#dirty = true;
    await this.flushIfDue(index);
  }

  private async touch(storageKey: string, bytes: number): Promise<void> {
    const index = await this.openIndex();
    if (!index) return;
    // Recency only moves in memory here. Persisting on every hit would put an
    // index rewrite on the read path; the open-time reconciliation repairs any
    // recency lost to a crash.
    this.record(index, storageKey, bytes);
  }

  private record(index: CacheIndexState, storageKey: string, bytes: number): void {
    const existing = index.entries.get(storageKey);
    if (existing) index.totalBytes -= existing.bytes;
    index.entries.set(storageKey, { bytes, lastUsedAt: this.#now() });
    index.totalBytes += bytes;
    this.#dirty = true;
  }

  /** Evicts least-recently-used pages until the incoming record fits. */
  private async reserve(index: CacheIndexState, storageKey: string, bytes: number): Promise<void> {
    const replacing = index.entries.get(storageKey)?.bytes ?? 0;
    const additionalEntries = index.entries.has(storageKey) ? 0 : 1;
    const order = [...index.entries.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    let evicted = false;
    for (const [candidate, entry] of order) {
      if (
        index.totalBytes - replacing + bytes <= index.maxBytes &&
        index.entries.size + additionalEntries <= index.maxEntries
      ) break;
      if (candidate === storageKey) continue;
      await this.pages.remove(candidate).catch(() => undefined);
      this.tombstone(candidate);
      index.entries.delete(candidate);
      index.totalBytes -= entry.bytes;
      evicted = true;
    }
    if (evicted) {
      this.#dirty = true;
      // A ceiling that only exists in page memory is not a ceiling: persist the
      // post-eviction inventory before the new record lands.
      await this.flush(index);
    }
  }

  private async flushIfDue(index: CacheIndexState): Promise<void> {
    if (!this.#dirty) return;
    if (this.#now() - this.#lastFlushAt < INDEX_FLUSH_INTERVAL_MS) return;
    await this.flush(index);
  }

  private async flush(index: CacheIndexState): Promise<void> {
    if (this.#flushing) return this.#flushing;
    const attempt = (async () => {
      try {
        await withCacheIndexLock(this.#budget.lockName, async () => {
          // Another tab shares this OPFS directory, so merge rather than clobber.
          const persisted = await this.readIndex(index.storageKey);
          if (persisted) mergeIndex(index, persisted, this.#dropped);
          // The merged view is the shared inventory for this partition, so the
          // ceiling is enforced over it before it is written. Without this a
          // merge could carry the index past the bound it exists to hold.
          await this.evictToBudget(index);
          await this.pages.write(index.storageKey, encodeIndex(index));
        });
        this.#dropped.clear();
        this.#dirty = false;
        this.#lastFlushAt = this.#now();
      } catch {
        // Never propagate: an index write failure degrades acceleration, and
        // the next open reconciles against the real page listing anyway.
      } finally {
        this.#flushing = undefined;
      }
    })();
    this.#flushing = attempt;
    return attempt;
  }

  private openIndex(): Promise<CacheIndexState | undefined> {
    this.#index ??= this.reconcile().catch(() => undefined);
    return this.#index;
  }

  /**
   * Adopts the real page listing as ground truth. Orphans from crashes, lost
   * index writes, or older builds are reclaimed here; without this an index loss
   * would strand persisted files forever.
   */
  private async reconcile(): Promise<CacheIndexState> {
    const storageKey = await cacheIndexStorageKey();
    const maxBytes = await this.resolveByteBudget();
    const maxEntries = boundedCount(this.#budget.maxEntries, MAX_CACHE_ENTRIES);
    const persisted = await this.readIndex(storageKey);
    const listed = await this.pages.list();
    const now = this.#now();
    const index: CacheIndexState = { storageKey, entries: new Map(), maxBytes, maxEntries, totalBytes: 0 };
    for (const page of listed) {
      if (page.storageKey === storageKey) continue;
      if (!isStorageKey(page.storageKey) || !Number.isSafeInteger(page.bytes) || page.bytes < 0) continue;
      const known = persisted?.get(page.storageKey);
      index.entries.set(page.storageKey, { bytes: page.bytes, lastUsedAt: known?.lastUsedAt ?? now });
      index.totalBytes += page.bytes;
    }
    // Index rows with no page behind them are dropped implicitly: only listed
    // pages are adopted above.
    await this.evictToBudget(index);
    await withCacheIndexLock(this.#budget.lockName, async () => {
      await this.pages.write(storageKey, encodeIndex(index));
    }).catch(() => undefined);
    this.#lastFlushAt = now;
    this.#dirty = false;
    return index;
  }

  private async evictToBudget(index: CacheIndexState): Promise<void> {
    const order = [...index.entries.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    for (const [candidate, entry] of order) {
      if (index.totalBytes <= index.maxBytes && index.entries.size <= index.maxEntries) break;
      await this.pages.remove(candidate).catch(() => undefined);
      this.tombstone(candidate);
      index.entries.delete(candidate);
      index.totalBytes -= entry.bytes;
    }
  }

  private tombstone(storageKey: string): void {
    if (this.#dropped.size >= MAX_DROPPED_KEYS) return;
    this.#dropped.add(storageKey);
  }

  private async readIndex(storageKey: string): Promise<Map<string, IndexEntry> | undefined> {
    let encoded: Uint8Array | undefined;
    try {
      encoded = await this.pages.read(storageKey);
    } catch {
      return undefined;
    }
    if (!encoded) return undefined;
    try {
      return decodeIndex(encoded);
    } catch {
      return undefined;
    }
  }

  private async resolveByteBudget(): Promise<number> {
    const requested = boundedCount(this.#budget.maxBytes, MAX_CACHE_BYTES);
    const estimate = this.#budget.estimateStorage ?? defaultStorageEstimate;
    try {
      const quota = (await estimate())?.quota;
      if (typeof quota === "number" && Number.isFinite(quota) && quota > 0) {
        return Math.max(1, Math.min(requested, Math.floor(quota * MAX_CACHE_QUOTA_FRACTION)));
      }
    } catch {
      // An absent or throwing estimate() only means the static budget applies.
    }
    return requested;
  }
}

function boundedCount(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

async function defaultStorageEstimate(): Promise<Readonly<{ quota?: number }>> {
  const estimate = typeof navigator === "undefined" ? undefined : navigator.storage?.estimate;
  if (typeof estimate !== "function") return {};
  return await navigator.storage.estimate();
}

async function withCacheIndexLock<T>(lockName: string | undefined, run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockName || typeof locks?.request !== "function") return run();
  // A held lock must never wedge the cache: an expired wait is a silent miss.
  const signal = AbortSignal.timeout(INDEX_LOCK_TIMEOUT_MS);
  return await locks.request(lockName, { mode: "exclusive", signal }, run) as T;
}

/**
 * Folds the persisted index into this tab's view before it is rewritten.
 *
 * A row this tab has never seen belongs to a page another tab wrote after this
 * one opened. Dropping it would erase a live page from the shared inventory, so
 * real residency for the partition could exceed the ceiling until the next
 * reconciliation; it is therefore adopted with its recorded size and recency.
 * The exception is a key this tab has provably removed since its last flush —
 * that page is gone, and re-adopting it would only inflate the count. Any other
 * row whose page has vanished is pruned by the next open-time reconciliation
 * against the real listing.
 */
function mergeIndex(index: CacheIndexState, persisted: Map<string, IndexEntry>, dropped: ReadonlySet<string>): void {
  for (const [storageKey, entry] of persisted) {
    const local = index.entries.get(storageKey);
    if (local) {
      // Keeping the newest recency prevents one tab from evicting another tab's
      // hot set on the next pass.
      if (entry.lastUsedAt > local.lastUsedAt) local.lastUsedAt = entry.lastUsedAt;
      continue;
    }
    if (dropped.has(storageKey)) continue;
    index.entries.set(storageKey, { bytes: entry.bytes, lastUsedAt: entry.lastUsedAt });
    index.totalBytes += entry.bytes;
  }
}

function encodeIndex(index: CacheIndexState): Uint8Array {
  const rows: Array<[string, number, number]> = [];
  for (const [storageKey, entry] of index.entries) rows.push([storageKey, entry.bytes, entry.lastUsedAt]);
  return new TextEncoder().encode(JSON.stringify({ version: INDEX_VERSION, entries: rows }));
}

function decodeIndex(encoded: Uint8Array): Map<string, IndexEntry> {
  if (encoded.byteLength > MAX_CACHE_ENTRIES * 128 + 64) throw new Error("Ciphertext cache index exceeds its limit.");
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Ciphertext cache index is invalid.");
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== INDEX_VERSION || !Array.isArray(candidate.entries)) throw new Error("Ciphertext cache index is invalid.");
  if (candidate.entries.length > MAX_CACHE_ENTRIES) throw new Error("Ciphertext cache index has too many entries.");
  const entries = new Map<string, IndexEntry>();
  for (const row of candidate.entries) {
    if (!Array.isArray(row) || row.length !== 3) throw new Error("Ciphertext cache index row is invalid.");
    const [storageKey, bytes, lastUsedAt] = row as [unknown, unknown, unknown];
    if (typeof storageKey !== "string" || !isStorageKey(storageKey)) throw new Error("Ciphertext cache index row is invalid.");
    if (!Number.isSafeInteger(bytes) || Number(bytes) < 0 || Number(bytes) > MAX_PERSISTED_RECORD_BYTES) {
      throw new Error("Ciphertext cache index row is invalid.");
    }
    if (!Number.isSafeInteger(lastUsedAt) || Number(lastUsedAt) < 0) throw new Error("Ciphertext cache index row is invalid.");
    entries.set(storageKey, { bytes: Number(bytes), lastUsedAt: Number(lastUsedAt) });
  }
  return entries;
}

let cacheIndexKey: Promise<string> | undefined;

/**
 * A reserved storage key with the same shape as a page key. It is derived from a
 * constant, so it can never collide with an address digest.
 */
function cacheIndexStorageKey(): Promise<string> {
  cacheIndexKey ??= sha256(INDEX_SOURCE).then((digest) => digest.slice("sha256:".length));
  return cacheIndexKey;
}

/** Selects the strongest honest cache path without making it authoritative. */
export async function createClientCiphertextCache(
  options: ClientCiphertextCacheOptions,
): Promise<ClientCiphertextCache> {
  const partition = options.partition.trim();
  if (!partition || new TextEncoder().encode(partition).byteLength > 4_096) {
    throw new Error("Ciphertext cache partition must be a bounded non-empty identifier.");
  }
  const partitionKey = (await sha256(partition)).slice("sha256:".length);
  const openExtension = options.openExtension ?? openExtensionCiphertextPageBackend;
  const openOpfs = options.openOpfs ?? openOpfsWorkerBackend;
  const openIndexedDb = options.openIndexedDb ?? openIndexedDbBackend;
  // Two tabs on one partition share one OPFS directory, so the LRU index lock
  // is named after the partition rather than the page or the backend.
  const budget: ClientCiphertextCacheBudget = Object.freeze({
    lockName: `airship-ciphertext-cache-index/${partitionKey}`,
    ...options.budget,
  });
  try {
    return new ClientCiphertextCache(await openExtension(partitionKey), Object.freeze({
      ...budget,
      estimateStorage: options.budget?.estimateStorage ?? (async () => ({})),
    }));
  } catch {
    try {
      return new ClientCiphertextCache(await openOpfs(partitionKey), budget);
    } catch {
      try {
        return new ClientCiphertextCache(await openIndexedDb(partitionKey), budget);
      } catch {
        return new ClientCiphertextCache(new MemoryCiphertextPageBackend(), budget);
      }
    }
  }
}

export class ExtensionCiphertextPageBackend implements CiphertextPageBackend {
  readonly backend = "extension-indexeddb" as const;
  readonly durability = "extension-origin-persistent" as const;
  readonly syncAccessHandle = "unavailable" as const;

  constructor(
    private readonly client: PageCompanionClient,
    private readonly namespace: string,
    private readonly maxRecordBytes = DEFAULT_COMPANION_RECORD_LIMIT,
  ) {}

  async read(storageKey: string): Promise<Uint8Array | undefined> {
    const result = await this.client.cacheGet(this.namespace, validateStorageKey(storageKey));
    if (!result.found) return undefined;
    const bytes = decodeBase64Bytes(result.data);
    if (bytes.byteLength !== result.bytes) throw new Error("Extension cache page size mismatch.");
    return bytes;
  }

  async write(storageKey: string, bytes: Uint8Array): Promise<void> {
    validateStorageKey(storageKey);
    validateEncodedRecordSize(bytes);
    if (bytes.byteLength > this.maxRecordBytes) {
      throw new Error("The ciphertext page exceeds this companion extension's record limit.");
    }
    await this.client.cachePut(this.namespace, storageKey, encodeBase64Bytes(bytes));
  }

  async remove(storageKey: string): Promise<void> {
    await this.client.cacheRemove(this.namespace, validateStorageKey(storageKey));
  }

  async list(): Promise<readonly CiphertextPageSummary[]> {
    const result = await this.client.cacheList(this.namespace);
    return result.pages.map((page) => Object.freeze({
      storageKey: validateStorageKey(page.key),
      bytes: page.bytes,
    }));
  }

  close(): void {
    // The page-scoped bridge client is shared by all extension-backed caches.
  }
}

async function openExtensionCiphertextPageBackend(partitionKey: string): Promise<CiphertextPageBackend> {
  const client = pageCompanionClient();
  if (!client) throw new Error("The Airship Companion is unavailable.");
  const handshake = await client.handshake();
  if (
    handshake.kind !== "answered"
    || handshake.capabilities.storage.state !== "available"
    || !handshake.capabilities.storage.enabled
  ) {
    throw new Error("The Airship Companion encrypted cache is not enabled.");
  }
  return new ExtensionCiphertextPageBackend(
    client,
    partitionKey,
    handshake.capabilities.storage.maxRecordBytes,
  );
}

export class MemoryCiphertextPageBackend implements CiphertextPageBackend {
  readonly backend = "memory" as const;
  readonly durability = "page-memory" as const;
  readonly syncAccessHandle = "unavailable" as const;
  private readonly pages = new Map<string, Uint8Array>();

  async read(storageKey: string): Promise<Uint8Array | undefined> {
    const bytes = this.pages.get(validateStorageKey(storageKey));
    return bytes?.slice();
  }

  async write(storageKey: string, bytes: Uint8Array): Promise<void> {
    validateStorageKey(storageKey);
    validateEncodedRecordSize(bytes);
    this.pages.set(storageKey, bytes.slice());
  }

  async remove(storageKey: string): Promise<void> {
    this.pages.delete(validateStorageKey(storageKey));
  }

  async list(): Promise<readonly CiphertextPageSummary[]> {
    return [...this.pages].map(([storageKey, bytes]) => Object.freeze({ storageKey, bytes: bytes.byteLength }));
  }

  close(): void {
    this.pages.clear();
  }
}

class IndexedDbCiphertextPageBackend implements CiphertextPageBackend {
  readonly backend = "indexeddb" as const;
  readonly durability = "origin-private-persistent" as const;
  readonly syncAccessHandle = "unavailable" as const;

  constructor(private readonly database: IDBDatabase) {}

  async read(storageKey: string): Promise<Uint8Array | undefined> {
    const transaction = this.database.transaction(CACHE_STORE, "readonly");
    const request = transaction.objectStore(CACHE_STORE).get(validateStorageKey(storageKey));
    const value = await idbRequest<IndexedDbPageRow | undefined>(request);
    await idbTransaction(transaction);
    return value?.bytes ? new Uint8Array(value.bytes) : undefined;
  }

  async write(storageKey: string, bytes: Uint8Array): Promise<void> {
    validateStorageKey(storageKey);
    validateEncodedRecordSize(bytes);
    const transaction = this.database.transaction(CACHE_STORE, "readwrite");
    // The byte length is stored alongside the body so eviction can size the
    // cache from an index scan instead of reading every record back.
    const row: IndexedDbPageRow = { bytes: ownedArrayBuffer(bytes), byteLength: bytes.byteLength };
    transaction.objectStore(CACHE_STORE).put(row, storageKey);
    await idbTransaction(transaction);
  }

  async remove(storageKey: string): Promise<void> {
    const transaction = this.database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).delete(validateStorageKey(storageKey));
    await idbTransaction(transaction);
  }

  async list(): Promise<readonly CiphertextPageSummary[]> {
    const transaction = this.database.transaction(CACHE_STORE, "readonly");
    const store = transaction.objectStore(CACHE_STORE);
    const keys = await idbRequest<IDBValidKey[]>(store.getAllKeys(undefined, MAX_LISTED_PAGES));
    const sizes = await idbRequest<Array<IndexedDbPageRow | undefined>>(store.getAll(undefined, MAX_LISTED_PAGES));
    await idbTransaction(transaction);
    const summaries: CiphertextPageSummary[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const storageKey = keys[index];
      const bytes = sizes[index]?.byteLength;
      if (typeof storageKey !== "string" || !isStorageKey(storageKey)) continue;
      if (!Number.isSafeInteger(bytes) || Number(bytes) < 0) continue;
      summaries.push(Object.freeze({ storageKey, bytes: Number(bytes) }));
    }
    return summaries;
  }

  close(): void {
    this.database.close();
  }
}

type IndexedDbPageRow = Readonly<{ bytes: ArrayBuffer; byteLength: number }>;

async function openIndexedDbBackend(partitionKey: string): Promise<CiphertextPageBackend> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable.");
  const request = indexedDB.open(`airship-ciphertext-cache-v1-${validateStorageKey(partitionKey)}`, CACHE_DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    // Version 1 stored bare ArrayBuffers with no recorded length, so eviction
    // could not size them. Dropping the store is always safe here: this is an
    // acceleration cache and the vault provider stays authoritative.
    if (request.result.objectStoreNames.contains(CACHE_STORE)) request.result.deleteObjectStore(CACHE_STORE);
    request.result.createObjectStore(CACHE_STORE);
  }, { once: true });
  const database = await idbRequest(request);
  return new IndexedDbCiphertextPageBackend(database);
}

export class OpfsWorkerCiphertextPageBackend implements CiphertextPageBackend {
  readonly durability = "origin-private-persistent" as const;
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<number, Readonly<{
    resolve(value: Uint8Array | undefined): void;
    reject(reason: unknown): void;
  }>>();

  constructor(
    private readonly worker: Worker,
    readonly backend: "opfs-sync-worker" | "opfs-async-worker",
  ) {
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (!response || response.type !== "result" || !Number.isSafeInteger(response.id)) return;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if (!response.ok) request.reject(new Error("OPFS ciphertext cache operation failed."));
      else request.resolve(response.bytes ? new Uint8Array(response.bytes) : undefined);
    });
    worker.addEventListener("error", () => this.stop());
    worker.addEventListener("messageerror", () => this.stop());
  }

  get syncAccessHandle(): "active" | "unavailable" {
    return this.backend === "opfs-sync-worker" ? "active" : "unavailable";
  }

  read(storageKey: string): Promise<Uint8Array | undefined> {
    return this.request("read", validateStorageKey(storageKey));
  }

  async write(storageKey: string, bytes: Uint8Array): Promise<void> {
    validateEncodedRecordSize(bytes);
    const payload = ownedArrayBuffer(bytes);
    await this.request("write", validateStorageKey(storageKey), payload);
  }

  async remove(storageKey: string): Promise<void> {
    await this.request("remove", validateStorageKey(storageKey));
  }

  async list(): Promise<readonly CiphertextPageSummary[]> {
    // The listing rides the existing byte channel as JSON so the worker protocol
    // stays a single request/response shape.
    const encoded = await this.request("list", LIST_STORAGE_KEY_PLACEHOLDER);
    if (!encoded) return [];
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown;
    if (!Array.isArray(parsed) || parsed.length > MAX_LISTED_PAGES) throw new Error("OPFS ciphertext cache listing is invalid.");
    const summaries: CiphertextPageSummary[] = [];
    for (const row of parsed) {
      if (!Array.isArray(row) || row.length !== 2) throw new Error("OPFS ciphertext cache listing is invalid.");
      const [storageKey, bytes] = row as [unknown, unknown];
      if (typeof storageKey !== "string" || !isStorageKey(storageKey)) continue;
      if (!Number.isSafeInteger(bytes) || Number(bytes) < 0) continue;
      summaries.push(Object.freeze({ storageKey, bytes: Number(bytes) }));
    }
    return summaries;
  }

  close(): void {
    this.stop();
  }

  private request(operation: WorkerOperation, storageKey: string, bytes?: ArrayBuffer): Promise<Uint8Array | undefined> {
    if (this.closed) return Promise.reject(workerStoppedError());
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: WorkerRequest = { type: "operation", id, operation, storageKey, ...(bytes ? { bytes } : {}) };
      try {
        this.worker.postMessage(message, bytes ? [bytes] : []);
      } catch {
        // Some engines throw after termination while others silently discard
        // the message. Either behavior permanently retires this backend.
        this.stop();
      }
    });
  }

  private stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending();
    this.worker.terminate();
  }

  private rejectPending(): void {
    for (const request of this.pending.values()) request.reject(workerStoppedError());
    this.pending.clear();
  }
}

function workerStoppedError(): Error {
  return new Error("OPFS ciphertext cache worker stopped.");
}

/** `list` carries no address; the worker ignores the key for that operation. */
const LIST_STORAGE_KEY_PLACEHOLDER = "A".repeat(43);

type WorkerOperation = "read" | "write" | "remove" | "list";
type WorkerRequest = Readonly<{
  type: "operation";
  id: number;
  operation: WorkerOperation;
  storageKey: string;
  bytes?: ArrayBuffer;
}>;
type WorkerResponse = Readonly<{
  type: "result";
  id: number;
  ok: boolean;
  bytes?: ArrayBuffer;
}>;

async function openOpfsWorkerBackend(partitionKey: string): Promise<CiphertextPageBackend> {
  const storage = typeof navigator === "undefined"
    ? undefined
    : (navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> } | undefined);
  if (!storage?.getDirectory || typeof Worker === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("OPFS worker storage is unavailable.");
  }
  const url = URL.createObjectURL(new Blob([opfsWorkerSource()], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(trustedOpfsWorkerUrl(url) as string, { name: "airship-ciphertext-opfs" });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  URL.revokeObjectURL(url);
  try {
    const backend = await waitForWorkerReady(worker, validateStorageKey(partitionKey));
    return new OpfsWorkerCiphertextPageBackend(worker, backend);
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

let opfsWorkerPolicy: Readonly<{ createScriptURL(value: string): unknown }> | undefined;

function trustedOpfsWorkerUrl(url: string): unknown {
  const factory = (globalThis as typeof globalThis & {
    trustedTypes?: {
      createPolicy(name: string, rules: { createScriptURL(value: string): string }): { createScriptURL(value: string): unknown };
    };
  }).trustedTypes;
  if (!factory) return url;
  opfsWorkerPolicy ??= factory.createPolicy(WORKER_POLICY_NAME, {
    createScriptURL(value) {
      if (!value.startsWith("blob:")) throw new TypeError("Airship OPFS workers require a fresh blob URL.");
      return value;
    },
  });
  return opfsWorkerPolicy.createScriptURL(url);
}

function waitForWorkerReady(
  worker: Worker,
  partitionKey: string,
): Promise<"opfs-sync-worker" | "opfs-async-worker"> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(() => reject(new Error("OPFS ciphertext cache worker did not start."))), OPFS_START_TIMEOUT_MS);
    const onMessage = (event: MessageEvent<unknown>) => {
      const value = event.data as { type?: unknown; backend?: unknown } | undefined;
      if (value?.type !== "ready") return;
      if (value.backend !== "opfs-sync-worker" && value.backend !== "opfs-async-worker") {
        finish(() => reject(new Error("OPFS ciphertext cache worker reported an invalid mode.")));
        return;
      }
      const backend = value.backend;
      finish(() => resolve(backend));
    };
    const onError = () => finish(() => reject(new Error("OPFS ciphertext cache worker failed to initialize.")));
    const finish = (action: () => void) => {
      clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onError);
      action();
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onError);
    worker.postMessage({ type: "initialize", partitionKey, rootName: OPFS_ROOT });
  });
}

function opfsWorkerSource(): string {
  // This Blob payload is opaque to the host minifier. Keep its source minified
  // so deferred users do not download formatting and comments as runtime data.
  return `"use strict";let directory,mode="opfs-async-worker",tail=Promise.resolve();const valid=t=>typeof t=="string"&&/^[A-Za-z0-9_-]{43}$/.test(t),partitionLock=t=>"${PARTITION_LOCK_PREFIX}"+t,filename=t=>"p-"+t+".bin",notFound=t=>t&&(t.name==="NotFoundError"||t.name==="TypeMismatchError");self.addEventListener("message",t=>{const e=t.data;if(e&&e.type==="initialize"){tail=tail.then(async()=>{if(!valid(e.partitionKey)||!/^[a-z0-9-]{1,64}$/.test(e.rootName))throw new Error("invalid cache partition");const a=await(await navigator.storage.getDirectory()).getDirectoryHandle(e.rootName,{create:!0});let n=!1;if(typeof navigator.locks?.request=="function"&&await new Promise(i=>{navigator.locks.request(partitionLock(e.partitionKey),{mode:"shared",signal:AbortSignal.timeout(${PARTITION_LOCK_TIMEOUT_MS})},()=>(n=!0,i(),new Promise(()=>{}))).catch(()=>i())}),directory=await a.getDirectoryHandle(e.partitionKey,{create:!0}),n&&typeof a.entries=="function")try{let i=0;for await(const[s,c]of a.entries()){if(++i>${MAX_SWEPT_PARTITIONS})break;s===e.partitionKey||c.kind!=="directory"||!valid(s)||await navigator.locks.request(partitionLock(s),{mode:"exclusive",ifAvailable:!0},async l=>{l&&await a.removeEntry(s,{recursive:!0}).catch(()=>{})})}}catch{}const o=await directory.getFileHandle(".sync-probe",{create:!0});if(typeof o.createSyncAccessHandle=="function")try{(await o.createSyncAccessHandle()).close(),mode="opfs-sync-worker"}catch{mode="opfs-async-worker"}await directory.removeEntry(".sync-probe").catch(()=>{}),self.postMessage({type:"ready",backend:mode})}).catch(()=>{throw new Error("OPFS initialization failed")});return}!e||e.type!=="operation"||(tail=tail.then(async()=>{if(!directory)throw new Error("invalid cache operation");let r;if(e.operation==="list")r=await list();else if(valid(e.storageKey))if(e.operation==="read")r=await read(e.storageKey);else if(e.operation==="write")await write(e.storageKey,e.bytes);else if(e.operation==="remove")await directory.removeEntry(filename(e.storageKey)).catch(n=>{if(!notFound(n))throw n});else throw new Error("invalid cache operation");else throw new Error("invalid cache operation");const a={type:"result",id:e.id,ok:!0,...r?{bytes:r}:{}};self.postMessage(a,r?[r]:[])}).catch(()=>self.postMessage({type:"result",id:e.id,ok:!1})))});async function list(){if(typeof directory.entries!="function")throw new Error("OPFS listing unavailable");const t=[];for await(const[e,r]of directory.entries()){if(t.length>=${MAX_LISTED_PAGES})break;r.kind!=="file"||!/^p-[A-Za-z0-9_-]{43}\\.bin$/.test(e)||t.push([e.slice(2,45),(await r.getFile()).size])}return new TextEncoder().encode(JSON.stringify(t)).buffer}async function read(t){let e;try{e=await directory.getFileHandle(filename(t))}catch(a){if(notFound(a))return;throw a}if(mode==="opfs-sync-worker"){const a=await e.createSyncAccessHandle();try{const n=a.getSize();if(n<1||n>${MAX_PERSISTED_RECORD_BYTES})throw new Error("invalid OPFS cache size");const o=new Uint8Array(n);let i=0;for(;i<o.byteLength;){const s=a.read(o.subarray(i),{at:i});if(!s)throw new Error("short OPFS read");i+=s}return o.buffer}finally{a.close()}}const r=await e.getFile();if(r.size<1||r.size>${MAX_PERSISTED_RECORD_BYTES})throw new Error("invalid OPFS cache size");return r.arrayBuffer()}async function write(t,e){if(!(e instanceof ArrayBuffer))throw new Error("invalid cache bytes");if(e.byteLength<1||e.byteLength>${MAX_PERSISTED_RECORD_BYTES})throw new Error("invalid cache bytes");const r=new Uint8Array(e),a=await directory.getFileHandle(filename(t),{create:!0});if(mode==="opfs-sync-worker"){const o=await a.createSyncAccessHandle();try{o.truncate(0);let i=0;for(;i<r.byteLength;){const s=o.write(r.subarray(i),{at:i});if(!s)throw new Error("short OPFS write");i+=s}o.flush()}finally{o.close()}return}const n=await a.createWritable();try{await n.write(r),await n.close()}catch(o){throw await n.abort().catch(()=>{}),o}}`;
}

function encodeRecord(header: CacheHeader, bytes: Uint8Array): Uint8Array {
  validateCiphertextSize(bytes);
  const encodedHeader = new TextEncoder().encode(JSON.stringify(header));
  if (encodedHeader.byteLength > MAX_HEADER_BYTES) throw new Error("Ciphertext cache metadata exceeds its limit.");
  const encoded = new Uint8Array(HEADER_PREFIX_BYTES + encodedHeader.byteLength + bytes.byteLength);
  encoded.set(RECORD_MAGIC_BYTES, 0);
  new DataView(encoded.buffer).setUint32(RECORD_MAGIC_BYTES.byteLength, encodedHeader.byteLength, false);
  encoded.set(encodedHeader, HEADER_PREFIX_BYTES);
  encoded.set(bytes, HEADER_PREFIX_BYTES + encodedHeader.byteLength);
  return encoded;
}

function decodeRecord(encoded: Uint8Array): Readonly<{ header: CacheHeader; bytes: Uint8Array }> {
  if (encoded.byteLength < HEADER_PREFIX_BYTES || encoded.byteLength > HEADER_PREFIX_BYTES + MAX_HEADER_BYTES + MAX_CIPHERTEXT_BYTES) {
    throw new Error("Ciphertext cache record has an invalid size.");
  }
  if (!RECORD_MAGIC_BYTES.every((byte, index) => encoded[index] === byte)) throw new Error("Ciphertext cache record has an invalid marker.");
  const headerLength = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    .getUint32(RECORD_MAGIC_BYTES.byteLength, false);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || HEADER_PREFIX_BYTES + headerLength > encoded.byteLength) {
    throw new Error("Ciphertext cache header has an invalid size.");
  }
  const headerBytes = encoded.slice(HEADER_PREFIX_BYTES, HEADER_PREFIX_BYTES + headerLength);
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes)) as unknown;
  const header = parseHeader(parsed);
  const bytes = encoded.slice(HEADER_PREFIX_BYTES + headerLength);
  validateCiphertextSize(bytes);
  return Object.freeze({ header, bytes });
}

function parseHeader(value: unknown): CacheHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ciphertext cache header is invalid.");
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== CACHE_VERSION || !isKind(candidate.kind) || !boundedText(candidate.etag, 4_096) ||
      typeof candidate.ciphertextDigest !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(candidate.ciphertextDigest)) {
    throw new Error("Ciphertext cache header is invalid.");
  }
  const updatedAt = candidate.updatedAt === undefined ? undefined : parseTimestamp(candidate.updatedAt);
  const range = candidate.range === undefined ? undefined : parseRange(candidate.range);
  const totalSize = candidate.totalSize === undefined ? undefined : parseSize(candidate.totalSize);
  return Object.freeze({
    version: CACHE_VERSION,
    kind: candidate.kind,
    etag: candidate.etag as string,
    ciphertextDigest: candidate.ciphertextDigest,
    ...(updatedAt ? { updatedAt } : {}),
    ...(range ? { range } : {}),
    ...(totalSize !== undefined ? { totalSize } : {}),
  });
}

function validateAddress(address: CiphertextCacheAddress): void {
  if (!boundedText(address.objectKey, 4_096) || !isKind(address.kind)) throw new Error("Ciphertext cache address is invalid.");
  if (address.range) parseRange(address.range);
}

function validateValue(address: CiphertextCacheAddress, value: CiphertextCacheValue): void {
  validateCiphertextSize(value.bytes);
  if (!boundedText(value.etag, 4_096)) throw new Error("Ciphertext cache ETag is invalid.");
  if (value.updatedAt !== undefined) parseTimestamp(value.updatedAt);
  if (value.totalSize !== undefined) {
    const total = parseSize(value.totalSize);
    if (address.range && total < address.range.endExclusive) throw new Error("Ciphertext cache total size is smaller than its range.");
  }
  if (address.range && value.bytes.byteLength !== address.range.endExclusive - address.range.start) {
    throw new Error("Ciphertext cache range length does not match its bytes.");
  }
}

function headerMatches(header: CacheHeader, address: CiphertextCacheAddress): boolean {
  return header.kind === address.kind &&
    (address.range
      ? header.range?.start === address.range.start && header.range.endExclusive === address.range.endExclusive
      : header.range === undefined);
}

async function cacheStorageKey(address: CiphertextCacheAddress): Promise<string> {
  const range = address.range ? `${address.range.start}:${address.range.endExclusive}` : "full";
  return (await sha256(`${address.kind}\0${address.objectKey}\0${range}`)).slice("sha256:".length);
}

function isStorageKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function validateStorageKey(value: string): string {
  if (!isStorageKey(value)) throw new Error("Ciphertext cache storage key is invalid.");
  return value;
}

function validateCiphertextSize(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_CIPHERTEXT_BYTES) {
    throw new Error("Ciphertext cache values require between 1 byte and 64 MiB.");
  }
}

function validateEncodedRecordSize(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_PREFIX_BYTES || bytes.byteLength > MAX_PERSISTED_RECORD_BYTES) {
    throw new Error("Ciphertext cache record has an invalid persisted size.");
  }
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Bytes(value: string): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(DEFAULT_COMPANION_RECORD_LIMIT * 4 / 3) + 8) {
    throw new Error("The extension cache page is invalid or too large.");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new Error("The extension cache page is not valid base64.", { cause: error });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
  return bytes;
}

function parseRange(value: unknown): Readonly<{ start: number; endExclusive: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ciphertext cache range is invalid.");
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.endExclusive) ||
      Number(candidate.start) < 0 || Number(candidate.endExclusive) <= Number(candidate.start)) {
    throw new Error("Ciphertext cache range is invalid.");
  }
  return Object.freeze({ start: Number(candidate.start), endExclusive: Number(candidate.endExclusive) });
}

function parseSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_CIPHERTEXT_BYTES) {
    throw new Error("Ciphertext cache size is invalid.");
  }
  return Number(value);
}

function parseTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) throw new Error("Ciphertext cache timestamp is invalid.");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error("Ciphertext cache timestamp is invalid.");
  return value;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= maxBytes;
}

function isKind(value: unknown): value is CiphertextCacheKind {
  return value === "workspace" || value === "git-object" || value === "index-page";
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("Ciphertext cache IndexedDB request failed.")), { once: true });
  });
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Ciphertext cache IndexedDB transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Ciphertext cache IndexedDB transaction failed.")), { once: true });
  });
}
