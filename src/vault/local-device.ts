import { sha256 } from "../core/hash";
import { EncryptedProfileCatalogStore } from "../profiles/persistence";
import { EncryptedObjectJournalBackend } from "../storage/encrypted-object-journal";
import type { WorkspaceRootKey } from "../storage/encrypted-envelope";
import {
  LocalDeviceObjectStore,
  MemoryLocalDeviceRecordBackend,
  openLocalDeviceObjectStore,
  requestPersistentLocalDeviceStorage,
  type LocalDeviceStorageReadiness,
} from "../storage/local-device-object-store";
import type { ObjectStore } from "../storage/object-store";
import type { ReadyVaultRuntime } from "./coordinator";
import { VaultContextFabricPort } from "./context-fabric-port";
import { EncryptedObjectWorkspace } from "./encrypted-workspace";

export const LOCAL_DEVICE_RUNTIME_NAMESPACES = Object.freeze({
  journal: "state/journal/v1",
  workspace: "state/workspace/v1",
  profiles: "state/profiles/v1",
} as const);

export type LocalDeviceVaultConfiguration = Readonly<{
  provider: "local-device";
  partition: string;
  displayName: string;
  authority: "this-browser-origin";
  offline: true;
  synchronization: "device-only";
  recovery: "workspace-recovery-key";
  backup: "manual-encrypted-export";
}>;

export type LocalDeviceNativeStorageCapability = Readonly<{
  version: 1;
  active: true;
  mode: "provider-native";
  backend: "opfs" | "indexeddb";
  authority: "local-device";
  offline: true;
  ciphertextCaching: "not-required";
  persistence: LocalDeviceStorageReadiness["persistence"];
}>;

/**
 * Same operative contracts and exact namespaces as cloud ReadyVaultRuntime.
 * The runtime receives only the narrow ObjectStore interface; backup/restore
 * authority remains on the closed-runtime control surface.
 */
export type ReadyLocalDeviceVaultRuntime = Readonly<
  Omit<ReadyVaultRuntime, "acceleration"> & {
    acceleration: LocalDeviceNativeStorageCapability;
  }
>;

export type LocalDeviceVaultStatus = Readonly<{
  phase: "ready";
  configuration: LocalDeviceVaultConfiguration;
  readiness: LocalDeviceStorageReadiness;
  message: "Encrypted device Vault ready for offline use.";
}>;

export type LocalDeviceVaultHandle = Readonly<{
  runtime: ReadyLocalDeviceVaultRuntime;
  status: LocalDeviceVaultStatus;
  exportEncryptedBackup(exportedAt?: Date): Promise<Uint8Array>;
  requestPersistentStorage(): Promise<"granted" | "not-granted" | "unsupported">;
  close(): void;
  closeAndWait(): Promise<void>;
}>;

export class LocalDeviceVaultInUseError extends Error {
  constructor(message = "Close every adopted runtime for this local device Vault before restoring a backup.") {
    super(message);
    this.name = "LocalDeviceVaultInUseError";
  }
}

export class LocalDeviceRestoreUnavailableError extends Error {
  constructor(message = "Safe local-device restore requires browser Web Locks support.") {
    super(message);
    this.name = "LocalDeviceRestoreUnavailableError";
  }
}

/**
 * Opens one complete device-authoritative Airship runtime and holds a shared
 * adoption lease until close(). A restore takes the corresponding exclusive
 * lease and therefore can never replace records beneath a live runtime.
 */
export async function openLocalDeviceVault(args: Readonly<{
  partition: string;
  workspaceKey: WorkspaceRootKey;
  disposition: "create-new" | "open-existing";
  displayName?: string;
  now?: () => Date;
}>): Promise<LocalDeviceVaultHandle> {
  const partition = args.partition.trim();
  const displayName = boundedDisplayName(args.displayName ?? "On this device");
  const lease = await acquireRuntimeLease(partition);
  let opened: Awaited<ReturnType<typeof openLocalDeviceObjectStore>>;
  try {
    opened = await openLocalDeviceObjectStore({
      partition,
      key: args.workspaceKey,
      disposition: args.disposition,
      now: args.now,
    });
  } catch (error) {
    lease.release();
    throw error;
  }

  const store = opened.store;
  const runtimeStore = objectStoreFacade(store);
  const workspace = new EncryptedObjectWorkspace(
    runtimeStore,
    args.workspaceKey,
    LOCAL_DEVICE_RUNTIME_NAMESPACES.workspace,
  );
  const runtime: ReadyLocalDeviceVaultRuntime = Object.freeze({
    store: runtimeStore,
    acceleration: Object.freeze({
      version: 1,
      active: true,
      mode: "provider-native",
      backend: opened.readiness.backend,
      authority: "local-device",
      offline: true,
      ciphertextCaching: "not-required",
      persistence: opened.readiness.persistence,
    }),
    journal: new EncryptedObjectJournalBackend(
      runtimeStore,
      args.workspaceKey,
      LOCAL_DEVICE_RUNTIME_NAMESPACES.journal,
    ),
    workspace,
    profiles: new EncryptedProfileCatalogStore(
      runtimeStore,
      args.workspaceKey,
      LOCAL_DEVICE_RUNTIME_NAMESPACES.profiles,
    ),
    contextFabric: new VaultContextFabricPort(runtimeStore, args.workspaceKey, workspace),
  });
  const configuration: LocalDeviceVaultConfiguration = Object.freeze({
    provider: "local-device",
    partition,
    displayName,
    authority: "this-browser-origin",
    offline: true,
    synchronization: "device-only",
    recovery: "workspace-recovery-key",
    backup: "manual-encrypted-export",
  });
  const status: LocalDeviceVaultStatus = Object.freeze({
    phase: "ready",
    configuration,
    readiness: opened.readiness,
    message: "Encrypted device Vault ready for offline use.",
  });

  let closed = false;
  const requireOpen = () => {
    if (closed) throw new Error("Local device Vault is closed.");
  };
  return Object.freeze({
    runtime,
    status,
    async exportEncryptedBackup(exportedAt?: Date) {
      requireOpen();
      return store.exportEncryptedBackup(exportedAt);
    },
    requestPersistentStorage() {
      requireOpen();
      return requestPersistentLocalDeviceStorage();
    },
    close() {
      if (closed) return;
      closed = true;
      store.close();
      lease.release();
    },
    async closeAndWait() {
      if (!closed) {
        closed = true;
        store.close();
        lease.release();
      }
      await lease.released;
    },
  });
}

/**
 * Authenticates the complete backup before touching persistent state, then
 * acquires an exclusive cross-tab lease and atomically replaces the selected
 * authority. It never operates through an adopted runtime.
 */
export async function restoreLocalDeviceVaultBackup(args: Readonly<{
  partition: string;
  workspaceKey: WorkspaceRootKey;
  disposition: "create-new" | "open-existing";
  backup: Uint8Array;
  signal?: AbortSignal;
  now?: () => Date;
}>): Promise<{ restored: number }> {
  const partition = args.partition.trim();
  args.signal?.throwIfAborted();

  // Authenticate and bound the complete inventory before a create-new restore
  // can even establish a target identity anchor.
  const verifier = new LocalDeviceObjectStore({
    partition,
    key: args.workspaceKey,
    backend: new MemoryLocalDeviceRecordBackend(),
    now: args.now,
  });
  try {
    await verifier.restoreEncryptedBackup(args.backup, args.signal);
  } finally {
    verifier.close();
  }

  return withExclusiveRestoreLease(partition, async () => {
    args.signal?.throwIfAborted();
    const opened = await openLocalDeviceObjectStore({
      partition,
      key: args.workspaceKey,
      disposition: args.disposition === "create-new" ? "restore-empty" : "open-existing",
      now: args.now,
    });
    try {
      // restoreEncryptedBackup authenticates the complete inventory and exact
      // identity anchor before its single replacement commit. Do not perform
      // fallible I/O after that commit: a rejected restore must always mean the
      // prior authority remains authoritative.
      return await opened.store.restoreEncryptedBackup(args.backup, args.signal);
    } finally {
      opened.store.close();
    }
  });
}

function objectStoreFacade(store: LocalDeviceObjectStore): ObjectStore {
  return Object.freeze({
    capabilities: store.capabilities,
    get: store.get.bind(store),
    getRange: store.getRange.bind(store),
    putIfAbsent: store.putIfAbsent.bind(store),
    compareAndSwap: store.compareAndSwap.bind(store),
    list: store.list.bind(store),
    // `trash` is optional on ObjectStore and required for conversation
    // deletion, which is exactly why it must travel the facade rather than be
    // rediscovered downstream: this tier shipped the verb in pass 2, and the
    // junction that forgot to fuse it meant a "delete" answered "This Vault
    // cannot delete objects" on the one tier that can.
    trash: store.trash.bind(store),
  });
}

type RuntimeLease = Readonly<{
  release(): void;
  released: Promise<void>;
}>;
const processRuntimeLeases = new Map<string, number>();

async function acquireRuntimeLease(partition: string): Promise<RuntimeLease> {
  const lockName = await runtimeLockName(partition);
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  let releaseHeldLock: (() => void) | undefined;
  let heldRequest: Promise<unknown> | undefined;

  if (locks) {
    let acquired!: () => void;
    let failed!: (reason: unknown) => void;
    const acquiredPromise = new Promise<void>((resolve, reject) => {
      acquired = resolve;
      failed = reject;
    });
    const releasePromise = new Promise<void>((resolve) => {
      releaseHeldLock = resolve;
    });
    heldRequest = locks.request(lockName, { mode: "shared" }, async () => {
      acquired();
      await releasePromise;
    });
    heldRequest.catch(failed);
    await acquiredPromise;
  }

  processRuntimeLeases.set(lockName, (processRuntimeLeases.get(lockName) ?? 0) + 1);
  let released = false;
  const releaseSettled = heldRequest
    ? heldRequest.then(() => undefined, () => undefined)
    : Promise.resolve();
  return Object.freeze({
    released: releaseSettled,
    release() {
      if (released) return;
      released = true;
      const remaining = (processRuntimeLeases.get(lockName) ?? 1) - 1;
      if (remaining > 0) processRuntimeLeases.set(lockName, remaining);
      else processRuntimeLeases.delete(lockName);
      releaseHeldLock?.();
      void heldRequest?.catch(() => undefined);
    },
  });
}

async function withExclusiveRestoreLease<T>(
  partition: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockName = await runtimeLockName(partition);
  if ((processRuntimeLeases.get(lockName) ?? 0) > 0) {
    throw new LocalDeviceVaultInUseError();
  }
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) throw new LocalDeviceRestoreUnavailableError();

  const result = await locks.request(
    lockName,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => lock ? Object.freeze({ acquired: true as const, value: await operation() }) : undefined,
  );
  if (!result) throw new LocalDeviceVaultInUseError();
  return result.value;
}

async function runtimeLockName(partition: string): Promise<string> {
  const digest = (await sha256(`airship/local-device-runtime-lease/v1\0${partition}`))
    .slice("sha256:".length);
  return `airship:local-device-runtime:${digest}`;
}

function boundedDisplayName(value: string): string {
  const name = value.trim();
  if (!name || new TextEncoder().encode(name).byteLength > 256 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("Local device Vault display name is invalid.");
  }
  return name;
}
