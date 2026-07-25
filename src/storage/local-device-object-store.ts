import { ownedArrayBuffer } from "../core/bytes";
import type { JsonValue } from "../core/contracts";
import { fromBase64Url, sha256, stableStringify, toBase64Url } from "../core/hash";
import { randomUuid } from "../core/id";
import type { WorkspaceRootKey } from "./encrypted-envelope";
import type {
  CompareAndSwapResult,
  ObjectRange,
  ObjectRecord,
  ObjectStore,
  ObjectStoreCapabilities,
  ObjectSummary,
  PutIfAbsentResult,
} from "./object-store";

const DATABASE_VERSION = 2;
const RECORD_STORE = "encrypted-objects";
const METADATA_STORE = "schema";
const DEVICE_SCHEMA_VERSION = 2;
const OPFS_ROOT = "airship-local-device-vault";
const OPFS_HEAD = ".authority.json";
const OPFS_RECORD_MAGIC = new TextEncoder().encode("AIRLDOR1");
const OPFS_RECORD_PREFIX_BYTES = OPFS_RECORD_MAGIC.byteLength + 4;
const MAX_OPFS_HEADER_BYTES = 16 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_KEY_BYTES = 4_096;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const BACKUP_FORMAT = "airship-local-device-vault-backup";
const IDENTITY_LOGICAL_KEY = ".airship/local-device-vault-identity-v1";
const IDENTITY_PAYLOAD = "airship-local-device-vault-identity/v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type LocalDevicePersistence = "origin-private-browser-managed" | "origin-private-persisted" | "page-memory";

export type LocalDeviceVaultCapability = Readonly<{
  version: 1;
  provider: "local-device";
  backend: "opfs" | "indexeddb" | "memory";
  persistence: LocalDevicePersistence;
  offline: true;
  cloudSynchronization: "none";
  encryptionAtRest: "AES-256-GCM/HKDF-SHA-256";
  keyCustody: "caller-supplied-non-extractable-workspace-key";
  backup: "manual-encrypted-export-and-verified-atomic-restore";
  evictionRisk: "browser-storage-policy";
  schema: Readonly<{
    current: 2;
    migratedFrom?: 1;
  }>;
}>;

export type LocalDeviceStorageReadiness = Readonly<{
  available: true;
  backend: "opfs" | "indexeddb";
  persistence: Exclude<LocalDevicePersistence, "page-memory">;
  persistedPermission: "granted" | "not-granted" | "unknown";
  quotaBytes?: number;
  usageBytes?: number;
  warning?: string;
  schema: Readonly<{
    current: 2;
    migratedFrom?: 1;
  }>;
}>;

type SealedLocalRecord = Readonly<{
  version: 1;
  id: string;
  revision: string;
  nonce: string;
  ciphertext: Uint8Array;
  ciphertextDigest: string;
  etag: string;
  updatedAt: string;
  plaintextSize: number;
}>;

type OpenLocalRecord = Readonly<{
  key: string;
  bytes: Uint8Array;
  etag: string;
  updatedAt: string;
}>;

export interface LocalDeviceRecordBackend {
  readonly kind: "opfs" | "indexeddb" | "memory";
  readonly persistence: LocalDevicePersistence;
  readonly migratedFrom?: 1;
  hasRecords(): Promise<boolean>;
  /**
   * Atomically installs the identity anchor only when the complete authority
   * is empty. This prevents an anchor-less/corrupt inventory from being
   * legitimized as a new Vault.
   */
  initializeIfEmpty(record: SealedLocalRecord): Promise<
    Readonly<{ initialized: true }> | Readonly<{ initialized: false }>
  >;
  get(id: string): Promise<SealedLocalRecord | undefined>;
  create(record: SealedLocalRecord): Promise<{ created: true } | { created: false; currentEtag: string }>;
  compareAndSwap(
    id: string,
    expectedEtag: string,
    record: SealedLocalRecord,
  ): Promise<{ updated: true } | { updated: false; currentEtag?: string; reason: "missing" | "precondition-failed" }>;
  list(): Promise<SealedLocalRecord[]>;
  replaceAll(records: readonly SealedLocalRecord[]): Promise<void>;
  close(): void;
}

export type LocalDeviceObjectStoreOptions = Readonly<{
  partition: string;
  key: WorkspaceRootKey;
  backend: LocalDeviceRecordBackend;
  now?: () => Date;
  revision?: () => string;
}>;

/**
 * Authoritative, offline ObjectStore backed by browser-owned device storage.
 *
 * Every logical key and value is inside an authenticated encryption boundary.
 * IndexedDB sees only opaque HMAC-derived IDs, ciphertext, integrity metadata,
 * timestamps, and sizes. Corruption is an error, never a cache miss or an
 * inferred empty vault.
 */
export class LocalDeviceObjectStore implements ObjectStore {
  readonly capabilities: ObjectStoreCapabilities = Object.freeze({
    version: 1,
    adapter: "local-device",
    rangeRead: Object.freeze({
      mode: "exact-or-fail",
      maxBytes: MAX_OBJECT_BYTES,
      providerEvidence: "in-process",
    }),
    conditionalWrite: Object.freeze({
      createIfAbsent: "atomic-or-fail",
      compareAndSwap: "atomic-or-fail",
      providerEvidence: "in-process",
    }),
    upload: Object.freeze({
      mode: "single-request",
      interruptionRecovery: "none",
      persistsResumeCapability: false,
    }),
  });

  readonly localCapability: LocalDeviceVaultCapability;
  private readonly partition: string;
  private readonly key: WorkspaceRootKey;
  private readonly backend: LocalDeviceRecordBackend;
  private readonly now: () => Date;
  private readonly revision: () => string;

  constructor(options: LocalDeviceObjectStoreOptions) {
    this.partition = validatePartition(options.partition);
    this.key = options.key;
    this.backend = options.backend;
    this.now = options.now ?? (() => new Date());
    this.revision = options.revision ?? randomUuid;
    this.localCapability = Object.freeze({
      version: 1,
      provider: "local-device",
      backend: options.backend.kind,
      persistence: options.backend.persistence,
      offline: true,
      cloudSynchronization: "none",
      encryptionAtRest: "AES-256-GCM/HKDF-SHA-256",
      keyCustody: "caller-supplied-non-extractable-workspace-key",
      backup: "manual-encrypted-export-and-verified-atomic-restore",
      evictionRisk: "browser-storage-policy",
      schema: Object.freeze({
        current: DEVICE_SCHEMA_VERSION,
        ...(options.backend.migratedFrom ? { migratedFrom: options.backend.migratedFrom } : {}),
      }),
    });
  }

  /**
   * Establishes or authenticates a partition identity anchor. Production
   * openers call this before returning the store, making a wrong recovery key
   * distinguishable from a genuinely empty vault without exposing object keys.
   */
  async verifyOrInitialize(
    disposition: "create-new" | "open-existing",
  ): Promise<"initialized" | "verified"> {
    const id = await this.identityId();
    const existing = await this.backend.get(id);
    if (existing) {
      await this.authenticateIdentity(existing, id);
      return "verified";
    }
    if (disposition === "open-existing") {
      if (await this.backend.hasRecords()) {
        throw new LocalDeviceVaultCorruptionError(
          "Local device vault contains records but its authenticated identity anchor is missing.",
        );
      }
      throw new LocalDeviceVaultNotFoundError();
    }

    const payload = encoder.encode(`${IDENTITY_PAYLOAD}\0${this.partition}`);
    const sealed = await this.seal(IDENTITY_LOGICAL_KEY, payload, id);
    const created = await this.backend.initializeIfEmpty(sealed);
    if (created.initialized) return "initialized";

    // A concurrent creator may have won. It is accepted only when the exact
    // authenticated identity payload matches; unrelated records remain a
    // corruption error and never acquire a new identity retroactively.
    const winner = await this.backend.get(id);
    if (!winner) {
      throw new LocalDeviceVaultCorruptionError(
        "Local device vault is non-empty but has no authenticated identity anchor.",
      );
    }
    await this.authenticateIdentity(winner, id);
    return "verified";
  }

  async get(key: string, signal?: AbortSignal): Promise<ObjectRecord | undefined> {
    signal?.throwIfAborted();
    const logicalKey = validateKey(key);
    rejectReservedLogicalKey(logicalKey);
    const id = await this.storageId(logicalKey);
    signal?.throwIfAborted();
    const sealed = await this.backend.get(id);
    signal?.throwIfAborted();
    if (!sealed) return undefined;
    const opened = await this.open(sealed, logicalKey);
    signal?.throwIfAborted();
    return { ...opened, bytes: opened.bytes.slice() };
  }

  async getRange(
    key: string,
    start: number,
    endExclusive: number,
    signal?: AbortSignal,
  ): Promise<ObjectRange | undefined> {
    validateRange(start, endExclusive);
    const record = await this.get(key, signal);
    if (!record) return undefined;
    if (endExclusive > record.bytes.byteLength) {
      throw new Error("Object range exceeds the stored object size.");
    }
    return {
      key: record.key,
      bytes: record.bytes.slice(start, endExclusive),
      etag: record.etag,
      start,
      endExclusive,
      totalSize: record.bytes.byteLength,
    };
  }

  async putIfAbsent(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<PutIfAbsentResult> {
    signal?.throwIfAborted();
    const logicalKey = validateKey(key);
    rejectReservedLogicalKey(logicalKey);
    validateObjectBytes(bytes);
    const sealed = await this.seal(logicalKey, bytes);
    signal?.throwIfAborted();
    const result = await this.backend.create(sealed);
    signal?.throwIfAborted();
    return result.created
      ? { created: true, etag: sealed.etag }
      : { created: false, currentEtag: result.currentEtag, reason: "exists" };
  }

  async compareAndSwap(
    key: string,
    expectedEtag: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<CompareAndSwapResult> {
    signal?.throwIfAborted();
    const logicalKey = validateKey(key);
    rejectReservedLogicalKey(logicalKey);
    validateExpectedEtag(expectedEtag);
    validateObjectBytes(bytes);
    const sealed = await this.seal(logicalKey, bytes);
    signal?.throwIfAborted();
    const result = await this.backend.compareAndSwap(sealed.id, expectedEtag, sealed);
    signal?.throwIfAborted();
    return result.updated
      ? { updated: true, etag: sealed.etag }
      : {
          updated: false,
          ...(result.currentEtag ? { currentEtag: result.currentEtag } : {}),
          reason: result.reason,
        };
  }

  async list(prefix: string, signal?: AbortSignal): Promise<ObjectSummary[]> {
    signal?.throwIfAborted();
    validatePrefix(prefix);
    const sealedRecords = await this.backend.list();
    const summaries: ObjectSummary[] = [];
    const identityId = await this.identityId();
    for (const sealed of sealedRecords) {
      signal?.throwIfAborted();
      const isIdentity = sealed.id === identityId;
      const opened = await this.open(
        sealed,
        isIdentity ? IDENTITY_LOGICAL_KEY : undefined,
        isIdentity ? identityId : undefined,
      );
      if (opened.key === IDENTITY_LOGICAL_KEY) {
        if (!isIdentity) {
          throw new LocalDeviceVaultCorruptionError(
            "A stored object illegally uses the reserved Vault identity key.",
          );
        }
        await this.authenticateIdentity(sealed, identityId);
        continue;
      }
      if (opened.key.startsWith(prefix)) {
        summaries.push({
          key: opened.key,
          etag: opened.etag,
          updatedAt: opened.updatedAt,
          size: opened.bytes.byteLength,
        });
      }
    }
    return summaries.sort((left, right) => left.key.localeCompare(right.key));
  }

  /**
   * Export contains encrypted records plus bounded format/integrity metadata.
   * It deliberately excludes the workspace recovery key and plaintext
   * partition name; a restore therefore proves possession of the same key.
   */
  async exportEncryptedBackup(exportedAt = this.now()): Promise<Uint8Array> {
    const records = (await this.backend.list())
      .map(backupRecord)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (records.length > MAX_OBJECTS) {
      throw new Error("Local device vault exceeds the encrypted backup object limit.");
    }
    const inventoryDigest = await sha256(encoder.encode(stableStringify(records as unknown as JsonValue)));
    const bytes = encoder.encode(stableStringify({
      format: BACKUP_FORMAT,
      version: 1,
      partitionDigest: await this.backupPartitionBinding(),
      exportedAt: exportedAt.toISOString(),
      inventoryDigest,
      records,
    } as unknown as JsonValue));
    if (bytes.byteLength > MAX_BACKUP_BYTES) {
      throw new Error("Local device vault exceeds the 256 MiB encrypted backup limit.");
    }
    return bytes;
  }

  /**
   * A restore authenticates every record with the caller's workspace key
   * before one atomic replacement. Wrong keys, truncation, duplicate IDs, and
   * modified ciphertext leave the existing vault untouched.
   */
  async restoreEncryptedBackup(bytes: Uint8Array, signal?: AbortSignal): Promise<{ restored: number }> {
    signal?.throwIfAborted();
    const backup = await decodeBackup(bytes, await this.backupPartitionBinding());
    const records = backup.records.map(storedRecord);
    const seen = new Set<string>();
    let identityRecords = 0;
    const identityId = await this.identityId();
    for (const record of records) {
      signal?.throwIfAborted();
      if (seen.has(record.id)) throw new LocalDeviceVaultCorruptionError("Backup contains a duplicate object identifier.");
      seen.add(record.id);
      const isIdentity = record.id === identityId;
      if (isIdentity) {
        await this.authenticateIdentity(record, identityId);
        identityRecords += 1;
        continue;
      }
      const opened = await this.open(record);
      if (opened.key === IDENTITY_LOGICAL_KEY) {
        throw new LocalDeviceVaultCorruptionError(
          "Encrypted backup contains a forged reserved identity object.",
        );
      }
    }
    if (identityRecords !== 1) {
      throw new LocalDeviceVaultCorruptionError("Encrypted backup does not contain exactly one authenticated identity anchor.");
    }
    signal?.throwIfAborted();
    await this.backend.replaceAll(records);
    // replaceAll is the commit point. Do not report a late abort as failure
    // after the new generation/transaction is already authoritative.
    return { restored: records.length - identityRecords };
  }

  close(): void {
    this.backend.close();
  }

  private storageId(logicalKey: string): Promise<string> {
    return this.key.opaqueObjectId(`local-device-object-store/v1\0${this.partition}\0${logicalKey}`);
  }

  private identityId(): Promise<string> {
    return this.key.opaqueObjectId(
      `airship/local-device-vault-identity-id/v1\0${this.partition}`,
    );
  }

  private backupPartitionBinding(): Promise<string> {
    return this.key.opaqueObjectId(
      `airship/local-device-backup-partition/v1\0${this.partition}`,
    );
  }

  private async authenticateIdentity(record: SealedLocalRecord, id: string): Promise<void> {
    const opened = await this.open(record, IDENTITY_LOGICAL_KEY, id);
    if (decoder.decode(opened.bytes) !== `${IDENTITY_PAYLOAD}\0${this.partition}`) {
      throw new LocalDeviceVaultCorruptionError("Local device vault identity anchor is invalid.");
    }
  }

  private async seal(logicalKey: string, bytes: Uint8Array, fixedId?: string): Promise<SealedLocalRecord> {
    const id = fixedId ?? await this.storageId(logicalKey);
    const revision = validateRevision(this.revision());
    const updatedAt = this.now().toISOString();
    const etag = await sha256(bytes);
    const plaintext = encodePlainRecord(logicalKey, bytes);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const aad = recordAad({ id, revision, etag, updatedAt, plaintextSize: bytes.byteLength });
    const contentKey = await this.key.objectEncryptionKey(id, revision);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad) },
      contentKey,
      ownedArrayBuffer(plaintext),
    ));
    return Object.freeze({
      version: 1,
      id,
      revision,
      nonce: toBase64Url(nonce),
      ciphertext,
      ciphertextDigest: await sha256(ciphertext),
      etag,
      updatedAt,
      plaintextSize: bytes.byteLength,
    });
  }

  private async open(record: SealedLocalRecord, expectedKey?: string, fixedId?: string): Promise<OpenLocalRecord> {
    validateSealedRecord(record);
    if (await sha256(record.ciphertext) !== record.ciphertextDigest) {
      throw new LocalDeviceVaultCorruptionError("Stored ciphertext digest does not match.");
    }
    const nonce = fromBase64Url(record.nonce);
    if (nonce.byteLength !== 12) throw new LocalDeviceVaultCorruptionError("Stored nonce is invalid.");
    const contentKey = await this.key.objectEncryptionKey(record.id, record.revision);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: ownedArrayBuffer(nonce),
          additionalData: encoder.encode(recordAad(record)),
        },
        contentKey,
        ownedArrayBuffer(record.ciphertext),
      );
    } catch {
      throw new LocalDeviceVaultCorruptionError("Stored object authentication failed.");
    }
    const opened = decodePlainRecord(new Uint8Array(plaintext));
    if (expectedKey !== undefined && opened.key !== expectedKey) {
      throw new LocalDeviceVaultCorruptionError("Stored object key does not match its lookup.");
    }
    const expectedId = fixedId ?? await this.storageId(opened.key);
    if (expectedId !== record.id) {
      throw new LocalDeviceVaultCorruptionError("Stored object identifier does not match its encrypted key.");
    }
    if (opened.bytes.byteLength !== record.plaintextSize || await sha256(opened.bytes) !== record.etag) {
      throw new LocalDeviceVaultCorruptionError("Stored object content integrity check failed.");
    }
    return Object.freeze({
      key: opened.key,
      bytes: opened.bytes,
      etag: record.etag,
      updatedAt: record.updatedAt,
    });
  }
}

export class LocalDeviceVaultCorruptionError extends Error {
  constructor(message = "Local device vault integrity verification failed.") {
    super(message);
    this.name = "LocalDeviceVaultCorruptionError";
  }
}

export class LocalDeviceVaultNotFoundError extends Error {
  constructor(message = "No existing local device Vault was found for this partition.") {
    super(message);
    this.name = "LocalDeviceVaultNotFoundError";
  }
}

export async function openLocalDeviceObjectStore(args: Readonly<{
  partition: string;
  key: WorkspaceRootKey;
  /**
   * `restore-empty` is a staging-only surface for
   * restoreLocalDeviceVaultBackup: it selects a proved-empty backend but does
   * not install an identity before the authenticated backup's atomic commit.
   */
  disposition: "create-new" | "open-existing" | "restore-empty";
  now?: () => Date;
}>): Promise<Readonly<{
  store: LocalDeviceObjectStore;
  readiness: LocalDeviceStorageReadiness;
}>> {
  const partition = validatePartition(args.partition);
  const databaseId = (await sha256(`airship-local-device-vault/v1\0${partition}`)).slice("sha256:".length);
  let opfs: LocalDeviceRecordBackend | undefined;
  let indexedDb: LocalDeviceRecordBackend | undefined;
  if (hasAtomicOpfsCapability()) {
    try {
      opfs = await OpfsLocalDeviceBackend.open(databaseId);
    } catch (error) {
      // Once the browser advertises the complete OPFS + Web Locks contract,
      // an access/quota/state failure is ambiguous: an existing authority may
      // be temporarily unreachable. Falling through to IndexedDB would fork
      // it, so only genuine feature absence is eligible for fallback.
      if (error instanceof LocalDeviceBackendUnavailableError) {
        throw new LocalDeviceBackendUnavailableError(
          `OPFS authority could not be inspected safely: ${error.message}`,
        );
      }
      throw error;
    }
  }
  try {
    indexedDb = await IndexedDbLocalDeviceBackend.open(`airship-local-device-vault-v1-${databaseId}`);
  } catch (error) {
    if (!(error instanceof LocalDeviceBackendUnavailableError)) {
      opfs?.close();
      throw error;
    }
  }
  if (!opfs && !indexedDb) throw new LocalDeviceBackendUnavailableError();
  let selected: LocalDeviceRecordBackend | undefined;
  try {
    const choose = async (): Promise<Readonly<{
      backend: LocalDeviceRecordBackend;
      store: LocalDeviceObjectStore;
      readiness: LocalDeviceStorageReadiness;
    }>> => {
      // Re-read both inventories while holding the origin-wide selection lock.
      // A browser gaining OPFS must resume its IndexedDB authority, never fork
      // into a preferred-but-empty backend.
      const [opfsHasRecords, indexedDbHasRecords] = await Promise.all([
        opfs?.hasRecords() ?? false,
        indexedDb?.hasRecords() ?? false,
      ]);
      if (opfsHasRecords && indexedDbHasRecords) {
        throw new LocalDeviceVaultCorruptionError(
          "Both OPFS and IndexedDB contain authority for this partition. Restore one explicit backup instead of guessing.",
        );
      }

      if (args.disposition === "open-existing" && !opfsHasRecords && !indexedDbHasRecords) {
        throw new LocalDeviceVaultNotFoundError();
      }
      if (args.disposition !== "open-existing" && (opfsHasRecords || indexedDbHasRecords)) {
        throw new LocalDeviceVaultCorruptionError(
          "A local device Vault already exists for this partition; open it instead of creating another authority.",
        );
      }

      selected = indexedDbHasRecords ? indexedDb! : opfsHasRecords ? opfs! : opfs ?? indexedDb!;
      const store = new LocalDeviceObjectStore({
        partition,
        key: args.key,
        backend: selected,
        now: args.now,
      });
      if (args.disposition !== "restore-empty") {
        await store.verifyOrInitialize(args.disposition);
      }
      return Object.freeze({
        backend: selected,
        store,
        readiness: await localDeviceReadiness(selected),
      });
    };
    const lockManager = typeof navigator === "undefined" ? undefined : navigator.locks;
    const opened = lockManager
      ? await lockManager.request(
          `airship:local-device-vault-selection:${databaseId}`,
          { mode: "exclusive" },
          choose,
        )
      : await choose();
    if (opened.backend !== opfs) opfs?.close();
    if (opened.backend !== indexedDb) indexedDb?.close();
    return Object.freeze({
      store: opened.store,
      readiness: opened.readiness,
    });
  } catch (error) {
    opfs?.close();
    indexedDb?.close();
    throw error;
  }
}

/** OPFS/IndexedDB absence is distinct from a corrupt existing local authority. */
export class LocalDeviceBackendUnavailableError extends Error {
  constructor(message = "Persistent local device storage is unavailable.") {
    super(message);
    this.name = "LocalDeviceBackendUnavailableError";
  }
}

function hasAtomicOpfsCapability(): boolean {
  if (typeof navigator === "undefined") return false;
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  return typeof storage?.getDirectory === "function" && typeof navigator.locks?.request === "function";
}

/** Explicit user action; opening a local vault never silently requests durable quota. */
export async function requestPersistentLocalDeviceStorage(): Promise<"granted" | "not-granted" | "unsupported"> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage?.persist) return "unsupported";
  return await storage.persist() ? "granted" : "not-granted";
}

export class MemoryLocalDeviceRecordBackend implements LocalDeviceRecordBackend {
  readonly kind = "memory" as const;
  readonly persistence = "page-memory" as const;
  readonly records = new Map<string, SealedLocalRecord>();

  async hasRecords(): Promise<boolean> {
    return this.records.size > 0;
  }

  async initializeIfEmpty(record: SealedLocalRecord): Promise<
    Readonly<{ initialized: true }> | Readonly<{ initialized: false }>
  > {
    if (this.records.size > 0) return Object.freeze({ initialized: false });
    this.records.set(record.id, cloneRecord(record));
    return Object.freeze({ initialized: true });
  }

  async get(id: string): Promise<SealedLocalRecord | undefined> {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  async create(record: SealedLocalRecord): Promise<{ created: true } | { created: false; currentEtag: string }> {
    const existing = this.records.get(record.id);
    if (existing) return { created: false, currentEtag: existing.etag };
    this.records.set(record.id, cloneRecord(record));
    return { created: true };
  }

  async compareAndSwap(
    id: string,
    expectedEtag: string,
    record: SealedLocalRecord,
  ): Promise<{ updated: true } | { updated: false; currentEtag?: string; reason: "missing" | "precondition-failed" }> {
    const existing = this.records.get(id);
    if (!existing) return { updated: false, reason: "missing" };
    if (existing.etag !== expectedEtag) {
      return { updated: false, currentEtag: existing.etag, reason: "precondition-failed" };
    }
    this.records.set(id, cloneRecord(record));
    return { updated: true };
  }

  async list(): Promise<SealedLocalRecord[]> {
    return [...this.records.values()].map(cloneRecord);
  }

  async replaceAll(records: readonly SealedLocalRecord[]): Promise<void> {
    const replacement = new Map(records.map((record) => [record.id, cloneRecord(record)]));
    this.records.clear();
    for (const [id, record] of replacement) this.records.set(id, record);
  }

  close(): void {
    this.records.clear();
  }
}

type OpfsAuthority = Readonly<{
  version: 2;
  generation: string;
}>;

type OpfsDirectoryIterator = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
};

/**
 * OPFS authority uses one immutable-ish generation directory and an atomically
 * replaced authority pointer. Ordinary writes are serialized by a
 * cross-document Web Lock; full backup restore builds a new generation before
 * switching the pointer, so interruption cannot expose a half-restored vault.
 */
class OpfsLocalDeviceBackend implements LocalDeviceRecordBackend {
  readonly kind = "opfs" as const;
  readonly persistence: Exclude<LocalDevicePersistence, "page-memory">;
  private closed = false;

  private constructor(
    private readonly directory: FileSystemDirectoryHandle,
    private readonly locks: LockManager,
    private readonly lockName: string,
    persisted: boolean | undefined,
    readonly migratedFrom?: 1,
  ) {
    this.persistence = persisted ? "origin-private-persisted" : "origin-private-browser-managed";
  }

  static async open(databaseId: string): Promise<OpfsLocalDeviceBackend> {
    if (typeof navigator === "undefined") {
      throw new LocalDeviceBackendUnavailableError();
    }
    const storage = navigator.storage as StorageManager & {
      getDirectory?: () => Promise<FileSystemDirectoryHandle>;
    };
    if (typeof storage?.getDirectory !== "function" || typeof navigator.locks?.request !== "function") {
      throw new LocalDeviceBackendUnavailableError("Atomic local OPFS requires OPFS and Web Locks.");
    }
    let root: FileSystemDirectoryHandle;
    try {
      root = await storage.getDirectory();
    } catch (error) {
      throw unavailableOpfs(error);
    }
    const partitionId = validateOpaqueId(databaseId, "OPFS partition");
    let base: FileSystemDirectoryHandle;
    try {
      const parent = await root.getDirectoryHandle(OPFS_ROOT, { create: true });
      base = await parent.getDirectoryHandle(partitionId, { create: true });
    } catch (error) {
      throw unavailableOpfs(error);
    }
    const lockName = `airship:local-device-vault:${partitionId}`;
    let migratedFrom: 1 | undefined;
    await navigator.locks.request(lockName, { mode: "exclusive" }, async () => {
      const authority = await readOpfsAuthority(base);
      if (!authority) {
        for await (const _handle of (base as OpfsDirectoryIterator).values()) {
          throw new LocalDeviceVaultCorruptionError(
            "Local device Vault has OPFS content but its authority pointer is missing.",
          );
        }
        const generation = newOpfsGeneration();
        await base.getDirectoryHandle(generation, { create: true });
        await writeOpfsAuthority(base, { version: DEVICE_SCHEMA_VERSION, generation });
        return;
      }
      try {
        await base.getDirectoryHandle(authority.generation);
      } catch (error) {
        if (isNotFound(error)) {
          throw new LocalDeviceVaultCorruptionError(
            "Local device Vault authority references a missing OPFS generation.",
          );
        }
        throw error;
      }
      if (authority.version === 1) {
        migratedFrom = 1;
        await writeOpfsAuthority(base, {
          version: DEVICE_SCHEMA_VERSION,
          generation: authority.generation,
        });
      }
    });
    let persisted: boolean | undefined;
    try {
      persisted = await storage.persisted?.();
    } catch {
      persisted = undefined;
    }
    return new OpfsLocalDeviceBackend(base, navigator.locks, lockName, persisted, migratedFrom);
  }

  get(id: string): Promise<SealedLocalRecord | undefined> {
    const objectId = validateOpaqueId(id, "local object");
    return this.withLock("shared", async () => {
      const generation = await this.activeGeneration();
      const handle = await opfsFile(generation, objectId);
      return handle ? readOpfsRecord(await handle.getFile(), objectId) : undefined;
    });
  }

  hasRecords(): Promise<boolean> {
    return this.withLock("shared", async () => {
      const generation = await this.activeGeneration();
      for await (const handle of (generation as OpfsDirectoryIterator).values()) {
        if (handle.kind !== "file" || !/^o-[A-Za-z0-9_-]{43}\.bin$/u.test(handle.name)) {
          throw new LocalDeviceVaultCorruptionError(
            "Local device Vault generation contains an unexpected OPFS entry.",
          );
        }
        return true;
      }
      return false;
    });
  }

  initializeIfEmpty(record: SealedLocalRecord): Promise<
    Readonly<{ initialized: true }> | Readonly<{ initialized: false }>
  > {
    validateSealedRecord(record);
    return this.withLock("exclusive", async () => {
      const generation = await this.activeGeneration();
      for await (const handle of (generation as OpfsDirectoryIterator).values()) {
        if (handle.kind !== "file" || !/^o-[A-Za-z0-9_-]{43}\.bin$/u.test(handle.name)) {
          throw new LocalDeviceVaultCorruptionError(
            "Local device Vault generation contains an unexpected OPFS entry.",
          );
        }
        return Object.freeze({ initialized: false as const });
      }
      await writeOpfsRecord(generation, record);
      return Object.freeze({ initialized: true as const });
    });
  }

  create(record: SealedLocalRecord): Promise<{ created: true } | { created: false; currentEtag: string }> {
    validateSealedRecord(record);
    return this.withLock("exclusive", async () => {
      const generation = await this.activeGeneration();
      const existing = await opfsFile(generation, record.id);
      if (existing) {
        const current = await readOpfsRecord(await existing.getFile(), record.id);
        return { created: false, currentEtag: current.etag };
      }
      await writeOpfsRecord(generation, record);
      return { created: true };
    });
  }

  compareAndSwap(
    id: string,
    expectedEtag: string,
    record: SealedLocalRecord,
  ): Promise<{ updated: true } | { updated: false; currentEtag?: string; reason: "missing" | "precondition-failed" }> {
    const objectId = validateOpaqueId(id, "local object");
    validateExpectedEtag(expectedEtag);
    validateSealedRecord(record);
    if (record.id !== objectId) throw new Error("Replacement object ID does not match.");
    return this.withLock("exclusive", async () => {
      const generation = await this.activeGeneration();
      const existing = await opfsFile(generation, objectId);
      if (!existing) return { updated: false, reason: "missing" };
      const current = await readOpfsRecord(await existing.getFile(), objectId);
      if (current.etag !== expectedEtag) {
        return { updated: false, currentEtag: current.etag, reason: "precondition-failed" };
      }
      await writeOpfsRecord(generation, record);
      return { updated: true };
    });
  }

  list(): Promise<SealedLocalRecord[]> {
    return this.withLock("shared", async () => {
      const generation = await this.activeGeneration();
      const records: SealedLocalRecord[] = [];
      for await (const handle of (generation as OpfsDirectoryIterator).values()) {
        if (handle.kind !== "file" || !/^o-[A-Za-z0-9_-]{43}\.bin$/u.test(handle.name)) {
          throw new LocalDeviceVaultCorruptionError(
            "Local device Vault generation contains an unexpected OPFS entry.",
          );
        }
        if (records.length >= MAX_OBJECTS) {
          throw new LocalDeviceVaultCorruptionError("Local device vault exceeds the object inventory limit.");
        }
        const expectedId = handle.name.slice(2, -4);
        records.push(await readOpfsRecord(await (handle as FileSystemFileHandle).getFile(), expectedId));
      }
      return records.sort((left, right) => left.id.localeCompare(right.id));
    });
  }

  replaceAll(records: readonly SealedLocalRecord[]): Promise<void> {
    if (records.length > MAX_OBJECTS) {
      throw new LocalDeviceVaultCorruptionError("Encrypted backup exceeds the local object inventory limit.");
    }
    const copies = records.map(cloneRecord);
    const ids = new Set<string>();
    for (const record of copies) {
      validateSealedRecord(record);
      if (ids.has(record.id)) throw new LocalDeviceVaultCorruptionError("Replacement contains duplicate object identifiers.");
      ids.add(record.id);
    }
    return this.withLock("exclusive", async () => {
      const current = await requiredOpfsAuthority(this.directory);
      const nextGeneration = newOpfsGeneration();
      const staging = await this.directory.getDirectoryHandle(nextGeneration, { create: true });
      try {
        for (const record of copies) await writeOpfsRecord(staging, record);
        await writeOpfsAuthority(this.directory, {
          version: DEVICE_SCHEMA_VERSION,
          generation: nextGeneration,
        });
      } catch (error) {
        await this.directory.removeEntry(nextGeneration, { recursive: true }).catch(() => undefined);
        throw error;
      }
      // The pointer already committed the replacement. Old generation cleanup
      // is best-effort and cannot roll back or fail the acknowledged restore.
      await this.directory.removeEntry(current.generation, { recursive: true }).catch(() => undefined);
      await removeUnreferencedOpfsGenerations(this.directory, nextGeneration).catch(() => undefined);
    });
  }

  close(): void {
    this.closed = true;
  }

  private async activeGeneration(): Promise<FileSystemDirectoryHandle> {
    const authority = await requiredOpfsAuthority(this.directory);
    try {
      return await this.directory.getDirectoryHandle(authority.generation);
    } catch (error) {
      if (isNotFound(error)) {
        throw new LocalDeviceVaultCorruptionError("Local device vault authority references a missing generation.");
      }
      throw error;
    }
  }

  private async withLock<T>(mode: "shared" | "exclusive", operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Local device vault is closed.");
    let completed = false;
    let result!: T;
    await this.locks.request<Promise<void>>(this.lockName, { mode }, async () => {
      if (this.closed) throw new Error("Local device vault is closed.");
      result = await operation();
      completed = true;
    });
    if (!completed) throw new Error("Local device vault lock completed without an operation result.");
    return result;
  }
}

class IndexedDbLocalDeviceBackend implements LocalDeviceRecordBackend {
  readonly kind = "indexeddb" as const;
  readonly persistence: Exclude<LocalDevicePersistence, "page-memory">;

  private constructor(
    private readonly database: IDBDatabase,
    persisted: boolean | undefined,
    readonly migratedFrom?: 1,
  ) {
    this.persistence = persisted ? "origin-private-persisted" : "origin-private-browser-managed";
  }

  static async open(databaseName: string): Promise<IndexedDbLocalDeviceBackend> {
    if (typeof indexedDB === "undefined") throw new LocalDeviceBackendUnavailableError();
    const request = indexedDB.open(databaseName, DATABASE_VERSION);
    let migratedFrom: 1 | undefined;
    request.addEventListener("upgradeneeded", (event) => {
      const previous = (event as IDBVersionChangeEvent).oldVersion;
      if (!request.result.objectStoreNames.contains(RECORD_STORE)) {
        request.result.createObjectStore(RECORD_STORE, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(METADATA_STORE)) {
        request.result.createObjectStore(METADATA_STORE);
      }
      request.transaction?.objectStore(METADATA_STORE).put(
        Object.freeze({ version: DEVICE_SCHEMA_VERSION }),
        "current",
      );
      if (previous === 1) migratedFrom = 1;
    }, { once: true });
    const database = await idbRequest(request);
    database.addEventListener("versionchange", () => database.close());
    let persisted: boolean | undefined;
    try {
      persisted = await navigator.storage?.persisted?.();
    } catch {
      persisted = undefined;
    }
    return new IndexedDbLocalDeviceBackend(database, persisted, migratedFrom);
  }

  async hasRecords(): Promise<boolean> {
    const transaction = this.database.transaction(RECORD_STORE, "readonly");
    const count = await idbRequest(transaction.objectStore(RECORD_STORE).count());
    await idbTransaction(transaction);
    return count > 0;
  }

  async initializeIfEmpty(record: SealedLocalRecord): Promise<
    Readonly<{ initialized: true }> | Readonly<{ initialized: false }>
  > {
    validateSealedRecord(record);
    const transaction = this.database.transaction(RECORD_STORE, "readwrite");
    const store = transaction.objectStore(RECORD_STORE);
    const count = await idbRequest(store.count());
    if (count > 0) {
      await idbTransaction(transaction);
      return Object.freeze({ initialized: false });
    }
    store.add(indexedDbRecord(record));
    await idbTransaction(transaction);
    return Object.freeze({ initialized: true });
  }

  async get(id: string): Promise<SealedLocalRecord | undefined> {
    const transaction = this.database.transaction(RECORD_STORE, "readonly");
    const result = await idbRequest<unknown>(transaction.objectStore(RECORD_STORE).get(id));
    await idbTransaction(transaction);
    return result === undefined ? undefined : storedRecord(result);
  }

  async create(record: SealedLocalRecord): Promise<{ created: true } | { created: false; currentEtag: string }> {
    const transaction = this.database.transaction(RECORD_STORE, "readwrite");
    const store = transaction.objectStore(RECORD_STORE);
    const existing = await idbRequest<unknown>(store.get(record.id));
    if (existing !== undefined) {
      const current = storedRecord(existing);
      await idbTransaction(transaction);
      return { created: false, currentEtag: current.etag };
    }
    store.add(indexedDbRecord(record));
    await idbTransaction(transaction);
    return { created: true };
  }

  async compareAndSwap(
    id: string,
    expectedEtag: string,
    record: SealedLocalRecord,
  ): Promise<{ updated: true } | { updated: false; currentEtag?: string; reason: "missing" | "precondition-failed" }> {
    const transaction = this.database.transaction(RECORD_STORE, "readwrite");
    const store = transaction.objectStore(RECORD_STORE);
    const existing = await idbRequest<unknown>(store.get(id));
    if (existing === undefined) {
      await idbTransaction(transaction);
      return { updated: false, reason: "missing" };
    }
    const current = storedRecord(existing);
    if (current.etag !== expectedEtag) {
      await idbTransaction(transaction);
      return { updated: false, currentEtag: current.etag, reason: "precondition-failed" };
    }
    store.put(indexedDbRecord(record));
    await idbTransaction(transaction);
    return { updated: true };
  }

  async list(): Promise<SealedLocalRecord[]> {
    const transaction = this.database.transaction(RECORD_STORE, "readonly");
    const values = await idbRequest<unknown[]>(transaction.objectStore(RECORD_STORE).getAll());
    await idbTransaction(transaction);
    if (values.length > MAX_OBJECTS) {
      throw new LocalDeviceVaultCorruptionError("Local device vault exceeds the object inventory limit.");
    }
    return values.map(storedRecord);
  }

  async replaceAll(records: readonly SealedLocalRecord[]): Promise<void> {
    if (records.length > MAX_OBJECTS) {
      throw new LocalDeviceVaultCorruptionError("Encrypted backup exceeds the local object inventory limit.");
    }
    const transaction = this.database.transaction(RECORD_STORE, "readwrite");
    const store = transaction.objectStore(RECORD_STORE);
    store.clear();
    for (const record of records) store.put(indexedDbRecord(record));
    await idbTransaction(transaction);
  }

  close(): void {
    this.database.close();
  }
}

type ReadOpfsAuthority = OpfsAuthority | Readonly<{ version: 1; generation: string }>;

async function readOpfsAuthority(
  directory: FileSystemDirectoryHandle,
): Promise<ReadOpfsAuthority | undefined> {
  let handle: FileSystemFileHandle;
  try {
    handle = await directory.getFileHandle(OPFS_HEAD);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const file = await handle.getFile();
  if (file.size < 2 || file.size > 4_096) {
    throw new LocalDeviceVaultCorruptionError("Local device vault authority pointer has an invalid size.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(await fileBytes(file)));
  } catch {
    throw new LocalDeviceVaultCorruptionError("Local device vault authority pointer is malformed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalDeviceVaultCorruptionError("Local device vault authority pointer is malformed.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    (candidate.version !== 1 && candidate.version !== DEVICE_SCHEMA_VERSION) ||
    typeof candidate.generation !== "string" ||
    !/^g-[a-f0-9]{32}$/u.test(candidate.generation)
  ) {
    throw new LocalDeviceVaultCorruptionError("Local device vault authority pointer uses an unsupported schema.");
  }
  return Object.freeze({
    version: candidate.version,
    generation: candidate.generation,
  }) as ReadOpfsAuthority;
}

async function requiredOpfsAuthority(directory: FileSystemDirectoryHandle): Promise<OpfsAuthority> {
  const authority = await readOpfsAuthority(directory);
  if (!authority) throw new LocalDeviceVaultCorruptionError("Local device vault authority pointer is missing.");
  if (authority.version !== DEVICE_SCHEMA_VERSION) {
    throw new LocalDeviceVaultCorruptionError("Local device vault authority migration did not complete.");
  }
  return authority;
}

async function writeOpfsAuthority(
  directory: FileSystemDirectoryHandle,
  authority: OpfsAuthority,
): Promise<void> {
  if (authority.version !== DEVICE_SCHEMA_VERSION || !/^g-[a-f0-9]{32}$/u.test(authority.generation)) {
    throw new LocalDeviceVaultCorruptionError("Local device vault authority pointer is invalid.");
  }
  const bytes = encoder.encode(stableStringify(authority as unknown as JsonValue));
  await writeOpfsFile(await directory.getFileHandle(OPFS_HEAD, { create: true }), bytes);
}

async function opfsFile(
  directory: FileSystemDirectoryHandle,
  id: string,
): Promise<FileSystemFileHandle | undefined> {
  const objectId = validateOpaqueId(id, "local object");
  try {
    return await directory.getFileHandle(`o-${objectId}.bin`);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeOpfsRecord(
  directory: FileSystemDirectoryHandle,
  record: SealedLocalRecord,
): Promise<void> {
  validateSealedRecord(record);
  const header = encoder.encode(stableStringify({
    version: record.version,
    id: record.id,
    revision: record.revision,
    nonce: record.nonce,
    ciphertextDigest: record.ciphertextDigest,
    etag: record.etag,
    updatedAt: record.updatedAt,
    plaintextSize: record.plaintextSize,
  } as JsonValue));
  if (header.byteLength < 2 || header.byteLength > MAX_OPFS_HEADER_BYTES) {
    throw new LocalDeviceVaultCorruptionError("Local device object metadata exceeds the OPFS limit.");
  }
  const encoded = new Uint8Array(OPFS_RECORD_PREFIX_BYTES + header.byteLength + record.ciphertext.byteLength);
  encoded.set(OPFS_RECORD_MAGIC, 0);
  new DataView(encoded.buffer).setUint32(OPFS_RECORD_MAGIC.byteLength, header.byteLength, false);
  encoded.set(header, OPFS_RECORD_PREFIX_BYTES);
  encoded.set(record.ciphertext, OPFS_RECORD_PREFIX_BYTES + header.byteLength);
  const handle = await directory.getFileHandle(`o-${record.id}.bin`, { create: true });
  await writeOpfsFile(handle, encoded);
}

async function readOpfsRecord(file: File, expectedId: string): Promise<SealedLocalRecord> {
  const objectId = validateOpaqueId(expectedId, "local object");
  const maximum = OPFS_RECORD_PREFIX_BYTES + MAX_OPFS_HEADER_BYTES + MAX_OBJECT_BYTES + MAX_KEY_BYTES + 20;
  if (file.size < OPFS_RECORD_PREFIX_BYTES + 16 || file.size > maximum) {
    throw new LocalDeviceVaultCorruptionError("Local device OPFS object has an invalid size.");
  }
  const prefix = await fileBytes(file.slice(0, OPFS_RECORD_PREFIX_BYTES));
  if (!OPFS_RECORD_MAGIC.every((byte, index) => prefix[index] === byte)) {
    throw new LocalDeviceVaultCorruptionError("Local device OPFS object marker is invalid.");
  }
  const headerLength = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength)
    .getUint32(OPFS_RECORD_MAGIC.byteLength, false);
  if (
    headerLength < 2 ||
    headerLength > MAX_OPFS_HEADER_BYTES ||
    OPFS_RECORD_PREFIX_BYTES + headerLength + 16 > file.size
  ) {
    throw new LocalDeviceVaultCorruptionError("Local device OPFS object header is invalid.");
  }
  let header: unknown;
  try {
    header = JSON.parse(decoder.decode(await fileBytes(file.slice(
      OPFS_RECORD_PREFIX_BYTES,
      OPFS_RECORD_PREFIX_BYTES + headerLength,
    ))));
  } catch {
    throw new LocalDeviceVaultCorruptionError("Local device OPFS object header is malformed.");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new LocalDeviceVaultCorruptionError("Local device OPFS object header is malformed.");
  }
  const ciphertext = await fileBytes(file.slice(OPFS_RECORD_PREFIX_BYTES + headerLength));
  const record = storedRecord({ ...(header as Record<string, unknown>), ciphertext });
  if (record.id !== objectId) {
    throw new LocalDeviceVaultCorruptionError("Local device OPFS filename does not match its authenticated object ID.");
  }
  return record;
}

async function writeOpfsFile(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(ownedArrayBuffer(bytes));
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function fileBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function newOpfsGeneration(): string {
  return `g-${crypto.randomUUID().replaceAll("-", "")}`;
}

async function removeUnreferencedOpfsGenerations(
  directory: FileSystemDirectoryHandle,
  activeGeneration: string,
): Promise<void> {
  const removals: Promise<void>[] = [];
  for await (const handle of (directory as OpfsDirectoryIterator).values()) {
    if (
      handle.kind === "directory" &&
      handle.name !== activeGeneration &&
      /^g-[a-f0-9]{32}$/u.test(handle.name)
    ) {
      removals.push(directory.removeEntry(handle.name, { recursive: true }).catch(() => undefined));
    }
  }
  await Promise.all(removals);
}

function unavailableOpfs(error: unknown): LocalDeviceBackendUnavailableError | LocalDeviceVaultCorruptionError {
  if (error instanceof LocalDeviceVaultCorruptionError) return error;
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  if (
    name === "SecurityError" ||
    name === "NotAllowedError" ||
    name === "NotSupportedError" ||
    name === "InvalidStateError" ||
    name === "QuotaExceededError"
  ) {
    return new LocalDeviceBackendUnavailableError(`OPFS local device storage is unavailable (${String(name)}).`);
  }
  return new LocalDeviceBackendUnavailableError("OPFS local device storage could not be opened.");
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (
    (error as { name?: unknown }).name === "NotFoundError" ||
    (error as { name?: unknown }).name === "TypeMismatchError"
  ));
}

function validateOpaqueId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new LocalDeviceVaultCorruptionError(`${label} identifier is invalid.`);
  }
  return value;
}

type BackupRecord = Readonly<{
  version: 1;
  id: string;
  revision: string;
  nonce: string;
  ciphertext: string;
  ciphertextDigest: string;
  etag: string;
  updatedAt: string;
  plaintextSize: number;
}>;

type LocalDeviceBackup = Readonly<{
  format: typeof BACKUP_FORMAT;
  version: 1;
  partitionDigest: string;
  exportedAt: string;
  inventoryDigest: string;
  records: readonly BackupRecord[];
}>;

function backupRecord(record: SealedLocalRecord): BackupRecord {
  validateSealedRecord(record);
  return Object.freeze({
    ...record,
    ciphertext: toBase64Url(record.ciphertext),
  });
}

function storedRecord(value: unknown): SealedLocalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalDeviceVaultCorruptionError("Stored record is malformed.");
  }
  const candidate = value as Record<string, unknown>;
  const ciphertext = typeof candidate.ciphertext === "string"
    ? fromBase64Url(candidate.ciphertext)
    : candidate.ciphertext instanceof Uint8Array
      ? candidate.ciphertext.slice()
      : candidate.ciphertext instanceof ArrayBuffer
        ? new Uint8Array(candidate.ciphertext)
        : undefined;
  if (!ciphertext) throw new LocalDeviceVaultCorruptionError("Stored record ciphertext is malformed.");
  const record = {
    version: candidate.version,
    id: candidate.id,
    revision: candidate.revision,
    nonce: candidate.nonce,
    ciphertext,
    ciphertextDigest: candidate.ciphertextDigest,
    etag: candidate.etag,
    updatedAt: candidate.updatedAt,
    plaintextSize: candidate.plaintextSize,
  } as SealedLocalRecord;
  validateSealedRecord(record);
  return record;
}

async function decodeBackup(bytes: Uint8Array, partitionBinding: string): Promise<LocalDeviceBackup> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BACKUP_BYTES) {
    throw new LocalDeviceVaultCorruptionError("Encrypted backup size is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new LocalDeviceVaultCorruptionError("Encrypted backup is not valid UTF-8 JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalDeviceVaultCorruptionError("Encrypted backup is malformed.");
  }
  const backup = parsed as Partial<LocalDeviceBackup>;
  if (
    backup.format !== BACKUP_FORMAT ||
    backup.version !== 1 ||
    backup.partitionDigest !== partitionBinding ||
    typeof backup.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(backup.exportedAt)) ||
    typeof backup.inventoryDigest !== "string" ||
    !Array.isArray(backup.records) ||
    backup.records.length > MAX_OBJECTS
  ) {
    throw new LocalDeviceVaultCorruptionError("Encrypted backup metadata is invalid or targets another vault.");
  }
  const records = backup.records.map((record) => backupRecord(storedRecord(record)));
  const digest = await sha256(encoder.encode(stableStringify(records as unknown as JsonValue)));
  if (digest !== backup.inventoryDigest) {
    throw new LocalDeviceVaultCorruptionError("Encrypted backup inventory digest does not match.");
  }
  return Object.freeze({ ...backup, records }) as LocalDeviceBackup;
}

function indexedDbRecord(record: SealedLocalRecord): Record<string, unknown> {
  validateSealedRecord(record);
  return {
    ...record,
    ciphertext: ownedArrayBuffer(record.ciphertext),
  };
}

function cloneRecord(record: SealedLocalRecord): SealedLocalRecord {
  return Object.freeze({ ...record, ciphertext: record.ciphertext.slice() });
}

function encodePlainRecord(key: string, bytes: Uint8Array): Uint8Array {
  const keyBytes = encoder.encode(key);
  const plaintext = new Uint8Array(4 + keyBytes.byteLength + bytes.byteLength);
  new DataView(plaintext.buffer).setUint32(0, keyBytes.byteLength, false);
  plaintext.set(keyBytes, 4);
  plaintext.set(bytes, 4 + keyBytes.byteLength);
  return plaintext;
}

function decodePlainRecord(plaintext: Uint8Array): { key: string; bytes: Uint8Array } {
  if (plaintext.byteLength < 4) throw new LocalDeviceVaultCorruptionError("Encrypted object frame is truncated.");
  const keyLength = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0, false);
  if (keyLength === 0 || keyLength > MAX_KEY_BYTES || 4 + keyLength > plaintext.byteLength) {
    throw new LocalDeviceVaultCorruptionError("Encrypted object key frame is invalid.");
  }
  let key: string;
  try {
    key = decoder.decode(plaintext.slice(4, 4 + keyLength));
  } catch {
    throw new LocalDeviceVaultCorruptionError("Encrypted object key is not valid UTF-8.");
  }
  validateKey(key);
  const bytes = plaintext.slice(4 + keyLength);
  validateObjectBytes(bytes);
  return { key, bytes };
}

function recordAad(record: Pick<SealedLocalRecord, "id" | "revision" | "etag" | "updatedAt" | "plaintextSize">): string {
  return stableStringify({
    format: "airship-local-device-object/v1",
    id: record.id,
    revision: record.revision,
    etag: record.etag,
    updatedAt: record.updatedAt,
    plaintextSize: record.plaintextSize,
  } as JsonValue);
}

function validateSealedRecord(record: SealedLocalRecord): void {
  if (
    record.version !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record.id) ||
    !/^[A-Za-z0-9_-]{8,128}$/u.test(record.revision) ||
    !/^[A-Za-z0-9_-]{16}$/u.test(record.nonce) ||
    !(record.ciphertext instanceof Uint8Array) ||
    record.ciphertext.byteLength < 16 ||
    record.ciphertext.byteLength > MAX_OBJECT_BYTES + MAX_KEY_BYTES + 20 ||
    !isSha256(record.ciphertextDigest) ||
    !isSha256(record.etag) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    !Number.isSafeInteger(record.plaintextSize) ||
    record.plaintextSize < 0 ||
    record.plaintextSize > MAX_OBJECT_BYTES
  ) {
    throw new LocalDeviceVaultCorruptionError("Stored record metadata is invalid.");
  }
}

function validatePartition(value: string): string {
  const partition = value.trim();
  if (!/^[A-Za-z0-9._:@/-]{1,256}$/u.test(partition) || partition.startsWith("/") || partition.endsWith("/")) {
    throw new Error("Local device vault partition is invalid.");
  }
  return partition;
}

function validateKey(value: string): string {
  const bytes = encoder.encode(value);
  if (!value || bytes.byteLength > MAX_KEY_BYTES || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith("/")) {
    throw new Error("Object key is invalid.");
  }
  return value;
}

function rejectReservedLogicalKey(value: string): void {
  if (value === IDENTITY_LOGICAL_KEY) {
    throw new Error("The local device Vault identity key is reserved.");
  }
}

function validatePrefix(value: string): void {
  if (encoder.encode(value).byteLength > MAX_KEY_BYTES || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith("/")) {
    throw new Error("Object prefix is invalid.");
  }
}

function validateObjectBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_OBJECT_BYTES) {
    throw new Error("Object exceeds the local device vault limit.");
  }
}

function validateRange(start: number, endExclusive: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endExclusive) ||
    start < 0 ||
    endExclusive <= start ||
    endExclusive - start > MAX_OBJECT_BYTES
  ) {
    throw new Error("Object ranges require bounded, non-negative, increasing integer offsets.");
  }
}

function validateRevision(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) throw new Error("Local device object revision is invalid.");
  return value;
}

function validateExpectedEtag(value: string): void {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Expected object ETag is invalid.");
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[A-Za-z0-9_-]{43}$/u.test(value);
}

async function localDeviceReadiness(
  backend: LocalDeviceRecordBackend,
): Promise<LocalDeviceStorageReadiness> {
  let persisted: boolean | undefined;
  let estimate: StorageEstimate | undefined;
  try {
    persisted = await navigator.storage?.persisted?.();
  } catch {
    persisted = undefined;
  }
  try {
    estimate = await navigator.storage?.estimate?.();
  } catch {
    estimate = undefined;
  }
  return Object.freeze({
    available: true,
    backend: backend.kind === "opfs" ? "opfs" : "indexeddb",
    persistence: persisted ? "origin-private-persisted" : "origin-private-browser-managed",
    persistedPermission: persisted === true ? "granted" : persisted === false ? "not-granted" : "unknown",
    ...(Number.isFinite(estimate?.quota) ? { quotaBytes: estimate!.quota } : {}),
    ...(Number.isFinite(estimate?.usage) ? { usageBytes: estimate!.usage } : {}),
    ...(!persisted
      ? { warning: "The browser may evict this origin under storage pressure; export an encrypted backup." }
      : {}),
    schema: Object.freeze({
      current: DEVICE_SCHEMA_VERSION,
      ...(backend.migratedFrom ? { migratedFrom: backend.migratedFrom } : {}),
    }),
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed.")), { once: true });
  });
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")), { once: true });
  });
}
