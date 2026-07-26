import { WorkspaceRootKey } from "./encrypted-envelope";
import type { GoogleDriveWorkspace } from "./google-drive-workspace";

/**
 * A separate database from `airship-local-device-keyring-v1` on purpose: this
 * is a cross-provider convenience cache, and bumping the local-device keyring's
 * version would force a migration of existing device enrollments for no benefit.
 */
const DATABASE = "airship-workspace-key-handles-v1";
const DATABASE_VERSION = 1;
const STORE = "workspace-key-handles";
const KEY_EQUIVALENCE_CONTEXT = "airship/local-device-key-equivalence/v1";
/** One browser profile cannot plausibly hold more than this many vaults. */
const MAX_RECORDS = 64;
const MAX_PARTITION_BYTES = 256;
const MAX_LABEL_LENGTH = 320;
const encoder = new TextEncoder();

/**
 * Non-secret descriptor of the remote hierarchy a cached key belongs to. It is
 * a lookup hint only: adoption always re-discovers the hierarchy live and
 * compares it against these values, so a tampered descriptor cannot redirect a
 * key at a different workspace.
 */
export type WorkspaceKeyLocation = Readonly<{
  provider: "google-drive";
  workspace: GoogleDriveWorkspace;
  /** Account label shown on the reconnect affordance. Never an authority. */
  accountLabel: string;
}>;

export type PersistedWorkspaceKeyHandle = Readonly<{
  version: 1;
  partition: string;
  handle: CryptoKey;
  location: WorkspaceKeyLocation;
  createdAt: string;
}>;

export interface WorkspaceKeyHandleStore {
  load(partition: string): Promise<PersistedWorkspaceKeyHandle | undefined>;
  /** Enumerates cached vaults so a reconnect affordance can render before any click. */
  list(): Promise<readonly PersistedWorkspaceKeyHandle[]>;
  putIfAbsent(record: PersistedWorkspaceKeyHandle): Promise<
    | Readonly<{ created: true }>
    | Readonly<{ created: false; record: PersistedWorkspaceKeyHandle }>
  >;
  remove(partition: string): Promise<void>;
  close(): void;
}

/**
 * Partition key for a Drive workspace cached in this browser profile.
 *
 * Keyed by Google subject alone, deliberately: the workspace folder id is not
 * known until after authorization, so a folder-scoped key could never be looked
 * up in time to render the reconnect affordance.
 */
export function googleDriveKeyPartition(googleSubject: string): string {
  const subject = googleSubject.trim();
  if (!/^[A-Za-z0-9_-]{6,256}$/u.test(subject)) throw new Error("Google account subject is invalid.");
  return `google-drive:${subject}`;
}

/**
 * Two `WorkspaceRootKey` values are equivalent when they derive the same opaque
 * commitment for one partition. Neither key is extractable, so this derivation
 * is the only available comparison.
 */
export async function equivalentWorkspaceKeys(
  left: WorkspaceRootKey,
  right: WorkspaceRootKey,
  partition: string,
): Promise<boolean> {
  const logicalId = `${KEY_EQUIVALENCE_CONTEXT}\0${partition}`;
  const [leftCommitment, rightCommitment] = await Promise.all([
    left.opaqueObjectId(logicalId),
    right.opaqueObjectId(logicalId),
  ]);
  return leftCommitment === rightCommitment;
}

/**
 * Rehydrates a cached key and proves it still opens the recorded hierarchy.
 *
 * `rediscover` must perform a live `connectExisting()`-style lookup with the
 * rehydrated key. Trusting the cached descriptor alone would let a stale or
 * tampered record point a live key at the wrong folder, so the rediscovered
 * workspace identity is the adoption gate, not the stored one.
 */
export async function adoptCachedWorkspaceKey(args: Readonly<{
  partition: string;
  store?: WorkspaceKeyHandleStore;
  rediscover(key: WorkspaceRootKey, record: PersistedWorkspaceKeyHandle): Promise<GoogleDriveWorkspace>;
}>): Promise<Readonly<{ key: WorkspaceRootKey; workspace: GoogleDriveWorkspace; record: PersistedWorkspaceKeyHandle }> | undefined> {
  const partition = keyPartition(args.partition);
  const record = await withHandleStore(args.store, (store) => store.load(partition));
  if (!record) return undefined;
  const key = WorkspaceRootKey.fromPersistedHandle(record.handle);
  const rediscovered = await args.rediscover(key, record);
  if (
    rediscovered.workspaceFolderId !== record.location.workspace.workspaceFolderId ||
    rediscovered.rootFolderId !== record.location.workspace.rootFolderId ||
    rediscovered.segmentsFolderId !== record.location.workspace.segmentsFolderId ||
    rediscovered.namespaceId !== record.location.workspace.namespaceId
  ) {
    throw new Error("The cached workspace key no longer matches this account's Airship folder.");
  }
  return Object.freeze({ key, workspace: rediscovered, record });
}

/**
 * Caches a non-extractable handle after a connect ceremony already proved the
 * key opens this hierarchy. A conflicting existing record for the same account
 * is only accepted when it is provably the same key.
 */
export async function rememberWorkspaceKey(args: Readonly<{
  partition: string;
  key: WorkspaceRootKey;
  location: WorkspaceKeyLocation;
  store?: WorkspaceKeyHandleStore;
  now?: () => Date;
}>): Promise<Readonly<{ created: boolean }>> {
  const partition = keyPartition(args.partition);
  const candidate = Object.freeze({
    version: 1,
    partition,
    handle: args.key.persistedHandle(),
    location: keyLocation(args.location),
    createdAt: validCreatedAt((args.now ?? (() => new Date()))()),
  } satisfies PersistedWorkspaceKeyHandle);
  const result = await withHandleStore(args.store, (store) => store.putIfAbsent(candidate));
  if (result.created) return Object.freeze({ created: true });
  const existing = WorkspaceRootKey.fromPersistedHandle(result.record.handle);
  if (!await equivalentWorkspaceKeys(args.key, existing, partition)) {
    throw new Error("A different workspace key is already cached for this account in this browser profile.");
  }
  return Object.freeze({ created: false });
}

export class MemoryWorkspaceKeyHandleStore implements WorkspaceKeyHandleStore {
  private readonly records = new Map<string, PersistedWorkspaceKeyHandle>();

  async load(partition: string): Promise<PersistedWorkspaceKeyHandle | undefined> {
    return this.records.get(partition);
  }

  async list(): Promise<readonly PersistedWorkspaceKeyHandle[]> {
    return [...this.records.values()].slice(0, MAX_RECORDS);
  }

  async putIfAbsent(record: PersistedWorkspaceKeyHandle) {
    const existing = this.records.get(record.partition);
    if (existing) return Object.freeze({ created: false as const, record: existing });
    if (this.records.size >= MAX_RECORDS) throw new Error("This browser profile already caches its limit of workspace keys.");
    this.records.set(record.partition, record);
    return Object.freeze({ created: true as const });
  }

  async remove(partition: string): Promise<void> {
    this.records.delete(partition);
  }

  close(): void {}
}

class IndexedDbWorkspaceKeyHandleStore implements WorkspaceKeyHandleStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<IndexedDbWorkspaceKeyHandleStore> {
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
    return new IndexedDbWorkspaceKeyHandleStore(database);
  }

  async load(partition: string): Promise<PersistedWorkspaceKeyHandle | undefined> {
    const transaction = this.database.transaction(STORE, "readonly");
    const value = await idbRequest<unknown>(transaction.objectStore(STORE).get(partition));
    await idbTransaction(transaction);
    return value === undefined ? undefined : handleRecord(value, partition);
  }

  async list(): Promise<readonly PersistedWorkspaceKeyHandle[]> {
    const transaction = this.database.transaction(STORE, "readonly");
    const values = await idbRequest<unknown[]>(transaction.objectStore(STORE).getAll(undefined, MAX_RECORDS));
    await idbTransaction(transaction);
    const records: PersistedWorkspaceKeyHandle[] = [];
    for (const value of values) {
      // One corrupt row must not hide every other cached vault; it simply
      // cannot be offered as a reconnect target.
      const partition = (value as { partition?: unknown }).partition;
      if (typeof partition !== "string") continue;
      try {
        records.push(handleRecord(value, partition));
      } catch {
        continue;
      }
    }
    return Object.freeze(records);
  }

  async putIfAbsent(record: PersistedWorkspaceKeyHandle): Promise<
    | Readonly<{ created: true }>
    | Readonly<{ created: false; record: PersistedWorkspaceKeyHandle }>
  > {
    const transaction = this.database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const existing = await idbRequest<unknown>(store.get(record.partition));
    if (existing !== undefined) {
      const parsed = handleRecord(existing, record.partition);
      await idbTransaction(transaction);
      return Object.freeze({ created: false, record: parsed });
    }
    const count = await idbRequest<number>(store.count());
    if (count >= MAX_RECORDS) {
      await idbTransaction(transaction).catch(() => undefined);
      throw new Error("This browser profile already caches its limit of workspace keys.");
    }
    // CryptoKey structured cloning is the custody boundary. Browsers that
    // cannot persist it fail; persisting raw key bytes is never a fallback.
    store.add(record);
    await idbTransaction(transaction);
    return Object.freeze({ created: true });
  }

  async remove(partition: string): Promise<void> {
    const transaction = this.database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(partition);
    await idbTransaction(transaction);
  }

  close(): void {
    this.database.close();
  }
}

export function openWorkspaceKeyHandleStore(): Promise<WorkspaceKeyHandleStore> {
  return IndexedDbWorkspaceKeyHandleStore.open();
}

async function withHandleStore<T>(
  provided: WorkspaceKeyHandleStore | undefined,
  operation: (store: WorkspaceKeyHandleStore) => Promise<T>,
): Promise<T> {
  const store = provided ?? await IndexedDbWorkspaceKeyHandleStore.open();
  try {
    return await operation(store);
  } finally {
    if (!provided) store.close();
  }
}

/**
 * The local-device keyring's validator silently drops unknown fields, which
 * would discard the descriptor entirely. This one parses and bounds every field
 * it keeps and rejects anything else.
 */
function handleRecord(value: unknown, expectedPartition: string): PersistedWorkspaceKeyHandle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted workspace key handle is malformed.");
  }
  const candidate = value as Partial<PersistedWorkspaceKeyHandle>;
  if (
    candidate.version !== 1 ||
    candidate.partition !== expectedPartition ||
    !(candidate.handle instanceof CryptoKey) ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt))
  ) {
    throw new Error("Persisted workspace key handle is invalid.");
  }
  WorkspaceRootKey.fromPersistedHandle(candidate.handle);
  return Object.freeze({
    version: 1,
    partition: keyPartition(expectedPartition),
    handle: candidate.handle,
    location: keyLocation(candidate.location),
    createdAt: candidate.createdAt,
  });
}

function keyLocation(value: unknown): WorkspaceKeyLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted workspace key location is invalid.");
  }
  const candidate = value as Partial<WorkspaceKeyLocation>;
  if (candidate.provider !== "google-drive") throw new Error("Persisted workspace key provider is unsupported.");
  const workspace = candidate.workspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
    throw new Error("Persisted workspace key location is invalid.");
  }
  return Object.freeze({
    provider: "google-drive",
    workspace: Object.freeze({
      workspaceFolderId: driveId(workspace.workspaceFolderId, "workspace folder id"),
      workspaceName: boundedLabel(workspace.workspaceName, "workspace name"),
      rootFolderId: driveId(workspace.rootFolderId, "root folder id"),
      segmentsFolderId: driveId(workspace.segmentsFolderId, "segments folder id"),
      namespaceId: opaqueNamespace(workspace.namespaceId),
      ...(workspace.webViewLink === undefined ? {} : { webViewLink: httpsLink(workspace.webViewLink) }),
    }),
    accountLabel: boundedLabel(candidate.accountLabel, "account label"),
  });
}

function driveId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(value)) throw new Error(`Persisted Drive ${label} is invalid.`);
  return value;
}

function opaqueNamespace(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,256}$/u.test(value)) throw new Error("Persisted Drive namespace is invalid.");
  return value;
}

function boundedLabel(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length || value.length > MAX_LABEL_LENGTH || /[\r\n]/u.test(value)) {
    throw new Error(`Persisted Drive ${label} is invalid.`);
  }
  return value;
}

function httpsLink(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("Persisted Drive link is invalid.");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Persisted Drive link is invalid.");
  return url.toString();
}

function keyPartition(value: string): string {
  const partition = value.trim();
  if (
    encoder.encode(partition).byteLength > MAX_PARTITION_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(partition) ||
    partition.endsWith("/")
  ) {
    throw new Error("Workspace key partition is invalid.");
  }
  return partition;
}

function validCreatedAt(value: Date): string {
  const createdAt = value.toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Workspace key creation time is invalid.");
  return createdAt;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("Workspace key custody request failed.")), { once: true });
  });
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Workspace key custody transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Workspace key custody transaction failed.")), { once: true });
  });
}
