import {
  WorkspaceRecoveryMaterial,
  importWorkspaceRecoveryKey,
} from "../vault/recovery";
import { WorkspaceRootKey } from "./encrypted-envelope";
import { openLocalDeviceObjectStore } from "./local-device-object-store";
// One derivation context, one implementation: a second copy could drift and
// silently start accepting a different key as equivalent.
import { equivalentWorkspaceKeys } from "./workspace-key-handle-store";

const DATABASE = "airship-local-device-keyring-v1";
const DATABASE_VERSION = 1;
const STORE = "workspace-keys";

export type PersistedWorkspaceKeyRecord = Readonly<{
  version: 1;
  partition: string;
  handle: CryptoKey;
  createdAt: string;
}>;

export interface LocalDeviceKeyHandleStore {
  load(partition: string): Promise<PersistedWorkspaceKeyRecord | undefined>;
  putIfAbsent(record: PersistedWorkspaceKeyRecord): Promise<
    | Readonly<{ created: true }>
    | Readonly<{ created: false; record: PersistedWorkspaceKeyRecord }>
  >;
  close(): void;
}

export type LocalDeviceWorkspaceKey = Readonly<{
  key: WorkspaceRootKey;
  /** Enrollment/import already authenticated the authority identity. */
  vaultDisposition: "open-existing";
  /** Whether this call installed the browser-profile handle. */
  created: boolean;
  custody: "origin-private-non-extractable";
}>;

export type LocalDeviceWorkspaceKeyEnrollment = Readonly<{
  state: "recovery-save-required";
  /**
   * Display/download once. The value is not persisted by this module and is
   * cleared from the enrollment object after commit or cancellation.
   */
  recoveryKey: string;
  commit(request: Readonly<{
    recoveryKeySavedAcknowledged: true;
  }>): Promise<LocalDeviceWorkspaceKey>;
  cancel(): void;
  toJSON(): Readonly<{
    kind: "local-device-key-enrollment";
    state: "recovery-save-required" | "cleared";
    recoveryValueSerialized: false;
  }>;
}>;

type KeyAuthorityInitializer = (
  key: WorkspaceRootKey,
  partition: string,
) => Promise<void>;

type KeyAuthorityAuthenticator = (
  key: WorkspaceRootKey,
  partition: string,
) => Promise<void>;

/**
 * Reopens an already-enrolled same-browser key. Missing is an ordinary result:
 * callers must enter the explicit enrollment or recovery-import ceremony.
 */
export async function openLocalDeviceWorkspaceKey(args: Readonly<{
  partition: string;
  store?: LocalDeviceKeyHandleStore;
}>): Promise<LocalDeviceWorkspaceKey | undefined> {
  const partition = localKeyPartition(args.partition);
  return withKeyStore(args.store, async (store) => {
    const existing = await store.load(partition);
    return existing ? reopened(existing, false) : undefined;
  });
}

/**
 * Begins crash-safe enrollment without committing any key handle or Vault
 * object. Commit is impossible until the caller explicitly acknowledges that
 * the one-time recovery value was saved.
 *
 * Commit order is deliberate:
 *   1. recovery was already acknowledged;
 *   2. initialize/authenticate the encrypted Vault identity;
 *   3. persist only a non-extractable CryptoKey handle.
 *
 * A crash after (2) still leaves the user-held recovery value able to
 * authenticate and reinstall the handle. A crash before acknowledgement
 * leaves no durable authority behind.
 */
export async function prepareLocalDeviceWorkspaceKeyEnrollment(args: Readonly<{
  partition: string;
  store?: LocalDeviceKeyHandleStore;
  now?: () => Date;
  /** Deterministic test seam; production always initializes the real Vault. */
  initializeAuthority?: KeyAuthorityInitializer;
}>): Promise<LocalDeviceWorkspaceKeyEnrollment> {
  const partition = localKeyPartition(args.partition);
  const existing = await withKeyStore(args.store, (store) => store.load(partition));
  if (existing) {
    throw new Error("This local device Vault is already enrolled; open its existing browser-profile key.");
  }

  const material = await WorkspaceRecoveryMaterial.generate();
  let cleared = false;
  let commitPromise: Promise<LocalDeviceWorkspaceKey> | undefined;

  const clear = () => {
    if (cleared) return;
    cleared = true;
    material.clear();
  };

  const enrollment: LocalDeviceWorkspaceKeyEnrollment = {
    state: "recovery-save-required",
    get recoveryKey() {
      return material.displayValue;
    },
    commit(request) {
      if (request?.recoveryKeySavedAcknowledged !== true) {
        return Promise.reject(new Error(
          "Confirm that the generated recovery key was saved before enrolling this device Vault.",
        ));
      }
      if (commitPromise) return commitPromise;
      if (cleared) {
        return Promise.reject(new DOMException("Key enrollment was cleared.", "InvalidStateError"));
      }

      const key = material.workspaceKey;
      commitPromise = (async () => {
        try {
          await (args.initializeAuthority ?? initializeLocalAuthority)(key, partition);
          const candidate = Object.freeze({
            version: 1,
            partition,
            handle: key.persistedHandle(),
            createdAt: validCreatedAt((args.now ?? (() => new Date()))()),
          } satisfies PersistedWorkspaceKeyRecord);
          const result = await withKeyStore(args.store, (store) => store.putIfAbsent(candidate));
          if (result.created) {
            return Object.freeze({
              key,
              vaultDisposition: "open-existing",
              created: true,
              custody: "origin-private-non-extractable",
            });
          }
          const winner = reopened(result.record, false);
          if (!await equivalentWorkspaceKeys(key, winner.key, partition)) {
            throw new Error("Another workspace key was enrolled for this local device Vault.");
          }
          return winner;
        } finally {
          clear();
        }
      })();
      return commitPromise;
    },
    cancel() {
      if (commitPromise) {
        throw new DOMException("Key enrollment is already committing.", "InvalidStateError");
      }
      clear();
    },
    toJSON() {
      return Object.freeze({
        kind: "local-device-key-enrollment",
        state: cleared ? "cleared" : "recovery-save-required",
        recoveryValueSerialized: false,
      });
    },
  };
  return Object.freeze(enrollment);
}

/**
 * Installs a saved recovery key only after it authenticates the existing
 * partition identity. A wrong value can never become the browser-profile key
 * for an empty or unrelated Vault.
 */
export async function importLocalDeviceWorkspaceRecoveryKey(args: Readonly<{
  partition: string;
  recoveryKey: string;
  store?: LocalDeviceKeyHandleStore;
  now?: () => Date;
  /** Deterministic test seam; production authenticates the real Vault. */
  authenticateAuthority?: KeyAuthorityAuthenticator;
}>): Promise<LocalDeviceWorkspaceKey> {
  const partition = localKeyPartition(args.partition);
  const key = await importWorkspaceRecoveryKey(args.recoveryKey);
  await (args.authenticateAuthority ?? authenticateLocalAuthority)(key, partition);

  const candidate = Object.freeze({
    version: 1,
    partition,
    handle: key.persistedHandle(),
    createdAt: validCreatedAt((args.now ?? (() => new Date()))()),
  } satisfies PersistedWorkspaceKeyRecord);
  const result = await withKeyStore(args.store, (store) => store.putIfAbsent(candidate));
  if (result.created) {
    return Object.freeze({
      key,
      vaultDisposition: "open-existing",
      created: true,
      custody: "origin-private-non-extractable",
    });
  }
  const winner = reopened(result.record, false);
  if (!await equivalentWorkspaceKeys(key, winner.key, partition)) {
    throw new Error("The authenticated recovery key conflicts with this browser profile's enrolled key.");
  }
  return winner;
}

export class MemoryLocalDeviceKeyHandleStore implements LocalDeviceKeyHandleStore {
  private readonly records = new Map<string, PersistedWorkspaceKeyRecord>();

  async load(partition: string): Promise<PersistedWorkspaceKeyRecord | undefined> {
    return this.records.get(partition);
  }

  async putIfAbsent(record: PersistedWorkspaceKeyRecord) {
    const existing = this.records.get(record.partition);
    if (existing) return Object.freeze({ created: false as const, record: existing });
    this.records.set(record.partition, record);
    return Object.freeze({ created: true as const });
  }

  close(): void {}
}

class IndexedDbLocalDeviceKeyHandleStore implements LocalDeviceKeyHandleStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<IndexedDbLocalDeviceKeyHandleStore> {
    if (typeof indexedDB === "undefined") {
      throw new Error("Origin-private key custody is unavailable in this browser.");
    }
    const request = indexedDB.open(DATABASE, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "partition" });
      }
    }, { once: true });
    const database = await idbRequest(request);
    database.addEventListener("versionchange", () => database.close());
    return new IndexedDbLocalDeviceKeyHandleStore(database);
  }

  async load(partition: string): Promise<PersistedWorkspaceKeyRecord | undefined> {
    const transaction = this.database.transaction(STORE, "readonly");
    const value = await idbRequest<unknown>(transaction.objectStore(STORE).get(partition));
    await idbTransaction(transaction);
    return value === undefined ? undefined : keyRecord(value, partition);
  }

  async putIfAbsent(record: PersistedWorkspaceKeyRecord): Promise<
    | Readonly<{ created: true }>
    | Readonly<{ created: false; record: PersistedWorkspaceKeyRecord }>
  > {
    const transaction = this.database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const existing = await idbRequest<unknown>(store.get(record.partition));
    if (existing !== undefined) {
      const parsed = keyRecord(existing, record.partition);
      await idbTransaction(transaction);
      return Object.freeze({ created: false, record: parsed });
    }
    // CryptoKey structured cloning is the custody boundary. Browsers that
    // cannot persist it fail; persisting raw key bytes is never a fallback.
    store.add(record);
    await idbTransaction(transaction);
    return Object.freeze({ created: true });
  }

  close(): void {
    this.database.close();
  }
}

async function initializeLocalAuthority(
  key: WorkspaceRootKey,
  partition: string,
): Promise<void> {
  const opened = await openLocalDeviceObjectStore({
    partition,
    key,
    disposition: "create-new",
  });
  opened.store.close();
}

async function authenticateLocalAuthority(
  key: WorkspaceRootKey,
  partition: string,
): Promise<void> {
  const opened = await openLocalDeviceObjectStore({
    partition,
    key,
    disposition: "open-existing",
  });
  opened.store.close();
}

function reopened(record: PersistedWorkspaceKeyRecord, created: boolean): LocalDeviceWorkspaceKey {
  return Object.freeze({
    key: WorkspaceRootKey.fromPersistedHandle(record.handle),
    vaultDisposition: "open-existing",
    created,
    custody: "origin-private-non-extractable",
  });
}

function keyRecord(value: unknown, expectedPartition: string): PersistedWorkspaceKeyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted workspace key record is malformed.");
  }
  const candidate = value as Partial<PersistedWorkspaceKeyRecord>;
  if (
    candidate.version !== 1 ||
    candidate.partition !== expectedPartition ||
    !(candidate.handle instanceof CryptoKey) ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt))
  ) {
    throw new Error("Persisted workspace key record is invalid.");
  }
  WorkspaceRootKey.fromPersistedHandle(candidate.handle);
  return Object.freeze({
    version: 1,
    partition: expectedPartition,
    handle: candidate.handle,
    createdAt: candidate.createdAt,
  });
}

async function withKeyStore<T>(
  provided: LocalDeviceKeyHandleStore | undefined,
  operation: (store: LocalDeviceKeyHandleStore) => Promise<T>,
): Promise<T> {
  const store = provided ?? await IndexedDbLocalDeviceKeyHandleStore.open();
  try {
    return await operation(store);
  } finally {
    if (!provided) store.close();
  }
}

function validCreatedAt(value: Date): string {
  const createdAt = value.toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Local device key creation time is invalid.");
  return createdAt;
}

function localKeyPartition(value: string): string {
  const partition = value.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(partition) ||
    partition.endsWith("/")
  ) {
    throw new Error("Local device key partition is invalid.");
  }
  return partition;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("Local key custody request failed.")), { once: true });
  });
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Local key custody transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Local key custody transaction failed.")), { once: true });
  });
}
