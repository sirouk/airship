import type { SessionRecord } from "../core/journal";
import { randomUuid } from "../core/id";
import type { EncryptedObjectJournalBackend } from "../storage/encrypted-object-journal";
import type { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { isReclaimableObjectStore, type ObjectReclamationReceipt, type ObjectStore } from "../storage/object-store";
import type { CiphertextCacheCapability } from "../storage/client-ciphertext-cache";
import type { EncryptedProfileCatalogStore } from "../profiles/persistence";
import type { VaultContextFabricPort } from "./context-fabric-port";
import type { GoogleDriveWorkspace } from "../storage/google-drive-workspace";
import type { S3CredentialProvider, S3ObjectStore } from "../storage/s3-object-store";
import {
  validateVaultS3Configuration,
  vaultProviderRequirements,
  type VaultProviderRequirements,
  type VaultS3Configuration,
  type VaultS3ConfigurationInput,
} from "./config";
import type { EncryptedObjectWorkspace } from "./encrypted-workspace";

export interface ResettableVaultCredentialProvider extends S3CredentialProvider {
  /** Drop temporary credentials and invalidate in-flight subject refreshes. */
  reset?(): void;
}

export type VaultDiagnostic = Readonly<{
  code:
    | "credential-denied"
    | "credential-throttled"
    | "storage-unreachable"
    | "storage-policy-denied"
    | "storage-conflict"
    | "storage-invalid-response"
    | "workspace-key-missing"
    | "conformance-failed"
    | "probe-aborted";
  severity: "warning" | "error";
  operation: "configure" | "probe" | "credentials" | "storage" | "encryption";
  publicMessage: string;
  retryable: boolean;
  commitState: "not-applicable" | "not-committed" | "unknown";
  requestId?: string;
  recordedAt: string;
}>;

export type VaultProbeEvidence = Readonly<{
  runId: string;
  logicalPrefix: string;
  startedAt: string;
  completedAt: string;
  checks: readonly Readonly<{ name: string; durationMs: number }>[];
  createdKeys: readonly string[];
  cleanup: Readonly<{
    deletionAvailableInRuntime: boolean;
    policy: "provider-lifecycle-or-out-of-band" | "runtime-reclaimed";
    warning: string;
    /** Provider-confirmed removals only. Absent when the store cannot reclaim. */
    reclaimedKeys?: readonly string[];
    /** Probe objects still resident and still needing out-of-band cleanup. */
    retainedKeys?: readonly string[];
  }>;
  readiness: Readonly<{
    conditionalCreate: "verified";
    compareAndSwap: "verified";
    exactRange: "verified";
    prefixList: "verified";
    readAfterWrite: "verified";
    encryptedJournal: "verified";
    encryptedWorkspace: "verified";
    dataSynchronization: "not-evaluated";
  }>;
}>;

export type VaultProbeResidueNotice = Readonly<{
  logicalPrefix: string;
  adjacentLogicalPrefix: string;
  inventory: "unknown-after-failed-probe";
  deletionAvailableInRuntime: false;
  cleanup: "provider-lifecycle-or-out-of-band";
}>;

type ConfiguredFields = Readonly<{
  config: VaultCloudConfiguration;
  requirements: VaultProviderRequirements;
  workspaceKey: "attached" | "missing";
}>;

export type VaultSnapshot =
  | Readonly<{
      phase: "disconnected";
      revision: number;
      message: "No cloud vault is configured.";
    }>
  | (ConfiguredFields & Readonly<{
      phase: "configured";
      revision: number;
      message: string;
    }>)
  | (ConfiguredFields & Readonly<{
      phase: "probing";
      revision: number;
      runId: string;
      startedAt: string;
      message: "Running destructive-in-the-small provider conformance checks.";
    }>)
  | (ConfiguredFields & Readonly<{
      phase: "ready";
      revision: number;
      evidence: VaultProbeEvidence;
      message: "Vault contract verified for this browser origin; synchronization has not been evaluated.";
    }>)
  | (ConfiguredFields & Readonly<{
      phase: "degraded";
      revision: number;
      diagnostic: VaultDiagnostic;
      previousEvidence?: VaultProbeEvidence;
      probeResidue?: VaultProbeResidueNotice;
      message: "Vault is not ready for strict cloud state.";
    }>);

export type DurableStateRuntime = Readonly<{
  store: ObjectStore;
  journal: EncryptedObjectJournalBackend;
  workspace: EncryptedObjectWorkspace;
  profiles: EncryptedProfileCatalogStore;
  /** Non-extracting facade; raw storage credentials and workspace key stay private to the coordinator pack. */
  contextFabric: VaultContextFabricPort;
}>;

export type ReadyVaultRuntime = DurableStateRuntime & Readonly<{
  /** Local acceleration only; provider remains authoritative for heads, listings, and CAS. */
  acceleration: CiphertextCacheCapability;
}>;

export type ConfigureVaultRequest = {
  configuration: VaultS3ConfigurationInput;
  credentialProvider: ResettableVaultCredentialProvider;
  workspaceKey?: WorkspaceRootKey;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
};

export type GoogleDriveVaultConfiguration = Readonly<{
  provider: "google-drive";
  endpoint: "https://www.googleapis.com";
  workspaceName: string;
  workspaceFolderId: string;
  webViewLink?: string;
  namespace: string;
  probePrefix: ".airship-probes/v1";
  credentialSource: Readonly<{
    kind: "google-identity-services";
    displayName: string;
    authorityOrigins: readonly string[];
  }>;
}>;

export type VaultCloudConfiguration = VaultS3Configuration | GoogleDriveVaultConfiguration;

export type ConfigureGoogleDriveVaultRequest = Readonly<{
  workspace: GoogleDriveWorkspace;
  store: ObjectStore;
  workspaceKey: WorkspaceRootKey;
  accountLabel: string;
  /** Explicit user-gesture renewal of the page-memory GIS access token. */
  reauthorize?(): Promise<void>;
  reset?(): void;
  now?: () => Date;
}>;

export type ProbeVaultRequest = {
  /** Required because the narrow ObjectStore intentionally has no delete. */
  acknowledgeImmutableProbeObjects: true;
  nonce?: string;
  signal?: AbortSignal;
};

type Listener = (snapshot: VaultSnapshot) => void;
type WithoutRevision<T> = T extends unknown ? Omit<T, "revision"> : never;
type VaultRuntimeModules = Readonly<{
  S3ObjectStore: typeof import("../storage/s3-object-store").S3ObjectStore;
  runObjectStoreConformance: typeof import("../storage/conformance").runObjectStoreConformance;
  EncryptedObjectJournalBackend: typeof import("../storage/encrypted-object-journal").EncryptedObjectJournalBackend;
  EncryptedProfileCatalogStore: typeof import("../profiles/persistence").EncryptedProfileCatalogStore;
  EncryptedObjectWorkspace: typeof import("./encrypted-workspace").EncryptedObjectWorkspace;
  VaultContextFabricPort: typeof import("./context-fabric-port").VaultContextFabricPort;
  createClientCiphertextCache: typeof import("../storage/client-ciphertext-cache").createClientCiphertextCache;
  CiphertextCachingObjectStore: typeof import("../storage/caching-object-store").CiphertextCachingObjectStore;
}>;

/**
 * Browser-native composition root for strict cloud state. It retains the
 * credential provider and non-extractable workspace key only in page memory;
 * snapshots and diagnostics never contain credential or key material.
 */
export class VaultCoordinator {
  private revision = 0;
  private generation = 0;
  private current: VaultSnapshot = disconnectedSnapshot(0);
  private config?: VaultCloudConfiguration;
  private requirements?: VaultProviderRequirements;
  private provider?: ResettableVaultCredentialProvider;
  private workspaceKey?: WorkspaceRootKey;
  private store?: ObjectStore;
  private directStore?: ObjectStore;
  private directReauthorize?: () => Promise<void>;
  private directReset?: () => void;
  private runtime?: ReadyVaultRuntime;
  private acceleratedStore?: import("../storage/caching-object-store").CiphertextCachingObjectStore;
  private fetchImplementation?: typeof fetch;
  private abortController?: AbortController;
  private now: () => Date = () => new Date();
  private listeners = new Set<Listener>();

  get snapshot(): VaultSnapshot {
    return this.current;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  configure(request: ConfigureVaultRequest): VaultSnapshot {
    const config = validateVaultS3Configuration(request.configuration);
    this.invalidateProbe("Vault configuration was replaced.");
    this.resetProvider();
    this.resetAcceleration();
    this.runtime = undefined;
    this.config = config;
    this.requirements = vaultProviderRequirements(config);
    this.provider = request.credentialProvider;
    this.workspaceKey = request.workspaceKey;
    this.fetchImplementation = request.fetchImplementation;
    this.now = request.now ?? (() => new Date());
    this.store = undefined;
    this.directStore = undefined;
    this.directReauthorize = undefined;
    this.directReset = undefined;
    return this.transition({
      phase: "configured",
      ...this.configuredFields(),
      message: this.workspaceKey
        ? "Configuration validated. Run the live provider probe before using strict cloud state."
        : "Configuration validated. Attach a memory-only workspace key before probing.",
    });
  }

  configureGoogleDrive(request: ConfigureGoogleDriveVaultRequest): VaultSnapshot {
    // Validate and copy every caller-controlled field before releasing the
    // currently mounted authority. A malformed replacement must not leave an
    // old `ready` snapshot pointing at a runtime whose token/cache was already
    // destroyed.
    const nextConfig = validatedGoogleDriveConfiguration(request);
    const nextRequirements = googleDriveRequirements(nextConfig, request.store);
    const nextReauthorize = request.reauthorize;
    const nextReset = request.reset;
    this.invalidateProbe("Vault configuration was replaced.");
    this.resetProvider();
    this.resetAcceleration();
    this.runtime = undefined;
    this.config = nextConfig;
    this.requirements = nextRequirements;
    this.provider = undefined;
    this.workspaceKey = request.workspaceKey;
    this.fetchImplementation = undefined;
    this.now = request.now ?? (() => new Date());
    this.store = request.store;
    this.directStore = request.store;
    this.directReauthorize = nextReauthorize;
    this.directReset = nextReset;
    return this.transition({
      phase: "configured",
      ...this.configuredFields(),
      message: "Google Drive connected in page memory. Run the live encrypted-object probe before adopting it.",
    });
  }

  attachWorkspaceKey(key: WorkspaceRootKey): VaultSnapshot {
    this.requireConfiguration();
    this.invalidateProbe("Workspace key changed.");
    this.workspaceKey = key;
    this.resetAcceleration();
    this.runtime = undefined;
    return this.transition({
      phase: "configured",
      ...this.configuredFields(),
      message: "Workspace key attached in memory. Run the live provider probe before use.",
    });
  }

  clearWorkspaceKey(): VaultSnapshot {
    this.requireConfiguration();
    this.invalidateProbe("Workspace key was cleared.");
    this.workspaceKey = undefined;
    this.resetAcceleration();
    this.runtime = undefined;
    return this.transition({
      phase: "configured",
      ...this.configuredFields(),
      message: "Workspace key cleared from the coordinator. Strict cloud state is unavailable.",
    });
  }

  cancelProbe(): VaultSnapshot {
    if (this.current.phase !== "probing") return this.current;
    this.invalidateProbe("Vault probe was cancelled.");
    return this.transition({
      phase: "configured",
      ...this.configuredFields(),
      message: "Probe cancelled. No readiness claim was retained.",
    });
  }

  disconnect(): VaultSnapshot {
    this.invalidateProbe("Vault disconnected.");
    this.resetProvider();
    this.resetAcceleration();
    this.runtime = undefined;
    this.store = undefined;
    this.directStore = undefined;
    this.directReauthorize = undefined;
    this.directReset = undefined;
    this.fetchImplementation = undefined;
    this.workspaceKey = undefined;
    this.provider = undefined;
    this.config = undefined;
    this.requirements = undefined;
    return this.transitionDisconnected();
  }

  /**
   * Renew a Google Drive grant from a click/tap without replacing the store,
   * workspace key, or verified runtime. No refresh token is retained.
   */
  async reauthorizeGoogleDrive(): Promise<void> {
    if (!this.config || !isGoogleDriveConfiguration(this.config) || !this.directStore) {
      throw new Error("Google Drive is not the configured vault provider.");
    }
    const reauthorize = this.directReauthorize;
    if (!reauthorize) throw new Error("This Google Drive connection cannot be renewed in place. Reconnect the vault.");
    await reauthorize();
  }

  readyRuntime(): ReadyVaultRuntime {
    if (this.current.phase !== "ready" || !this.runtime) {
      throw new Error("Vault runtime is unavailable until the live probe verifies the configured provider and encryption path.");
    }
    return this.runtime;
  }

  async probe(request: ProbeVaultRequest): Promise<VaultSnapshot> {
    if (request.acknowledgeImmutableProbeObjects !== true) {
      throw new Error("Vault probe requires explicit acknowledgement that immutable test objects need lifecycle cleanup.");
    }
    const { config, provider } = this.requireConfiguration();
    const key = this.workspaceKey;
    if (!key) {
      const diagnostic = this.diagnostic("workspace-key-missing", "encryption", false,
        "Attach the workspace root key in page memory before running the vault probe.");
      return this.transition({
        phase: "degraded",
        ...this.configuredFields(),
        diagnostic,
        message: "Vault is not ready for strict cloud state.",
      });
    }

    this.invalidateProbe("A newer vault probe superseded this run.");
    const generation = ++this.generation;
    const controller = new AbortController();
    this.abortController = controller;
    const detachExternalAbort = forwardAbort(request.signal, controller);
    const runId = request.nonce ?? randomNonce();
    const startedAt = this.now().toISOString();
    const previousEvidence = this.current.phase === "ready"
      ? this.current.evidence
      : this.current.phase === "degraded"
        ? this.current.previousEvidence
        : undefined;
    // A re-probe refreshes evidence for the already configured authority. The
    // adopted application runtime may still own these exact adapters while the
    // conformance checks run, so closing its acceleration here would strand
    // workspace reads and make a later disconnect unable to migrate state.
    // Configuration/key changes and disconnect remain the only operations that
    // destroy the runtime. Readiness still fails closed through `current.phase`:
    // `readyRuntime()` cannot expose a retained runtime while probing/degraded.
    const retainedRuntime = this.runtime;
    const retainedAcceleratedStore = this.acceleratedStore;
    this.transition({
      phase: "probing",
      ...this.configuredFields(),
      runId,
      startedAt,
      message: "Running destructive-in-the-small provider conformance checks.",
    });

    try {
      const modules = await loadVaultRuntimeModules();
      if (generation !== this.generation || controller.signal.aborted) throw abortReason(controller.signal);
      const store = this.directStore ?? this.store ?? (!isGoogleDriveConfiguration(config) && provider
        ? new modules.S3ObjectStore({
            endpoint: config.endpoint,
            region: config.region,
            bucket: config.bucket,
            prefix: config.namespace,
            forcePathStyle: config.forcePathStyle,
            credentialProvider: provider,
            fetchImplementation: this.fetchImplementation,
            now: this.now,
            allowPermanentCredentialsForDevelopment: config.mode === "local-development",
          })
        : undefined);
      if (!store) throw new Error("The selected vault object store is unavailable.");
      this.store = store;
      const conformance = await modules.runObjectStoreConformance({
        store,
        prefix: config.probePrefix,
        nonce: runId,
        signal: controller.signal,
      });
      const composition = await runEncryptedCompositionProbe({
        store,
        key,
        prefix: conformance.prefix,
        runId,
        now: this.now,
        signal: controller.signal,
        modules,
      });
      if (generation !== this.generation || controller.signal.aborted) throw abortReason(controller.signal);

      const allCreatedKeys = Object.freeze([...new Set([
        ...conformance.createdKeys,
        ...composition.createdKeys,
      ])].sort());
      // Probe litter is provably unreachable — nothing but this run ever
      // references those keys — so it is the one safe reclamation candidate that
      // needs no safety age. Anything unconfirmed keeps the original warning.
      const cleanup = await this.reclaimProbeObjects(store, allCreatedKeys, controller.signal);
      const evidence: VaultProbeEvidence = Object.freeze({
        runId,
        logicalPrefix: conformance.prefix,
        startedAt,
        completedAt: this.now().toISOString(),
        checks: Object.freeze([
          ...conformance.checks.map((check) => Object.freeze({ ...check })),
          ...composition.checks.map((check) => Object.freeze({ ...check })),
        ]),
        createdKeys: allCreatedKeys,
        cleanup,
        readiness: Object.freeze({
          conditionalCreate: "verified",
          compareAndSwap: "verified",
          exactRange: "verified",
          prefixList: "verified",
          readAfterWrite: "verified",
          encryptedJournal: "verified",
          encryptedWorkspace: "verified",
          dataSynchronization: "not-evaluated",
        }),
      });
      if (retainedRuntime && retainedAcceleratedStore) {
        // The configuration and key cannot change without first destroying the
        // retained runtime, so this is the same-authority lifecycle. Preserve
        // object identity: the app already adopted these adapters.
        this.runtime = retainedRuntime;
        this.acceleratedStore = retainedAcceleratedStore;
      } else {
        const cache = await modules.createClientCiphertextCache({ partition: vaultCachePartition(config) });
        if (generation !== this.generation || controller.signal.aborted) {
          cache.close();
          throw abortReason(controller.signal);
        }
        const acceleratedStore = new modules.CiphertextCachingObjectStore(store, cache);
        this.acceleratedStore = acceleratedStore;
        const journal = new modules.EncryptedObjectJournalBackend(acceleratedStore, key, "state/journal/v1");
        const workspace = new modules.EncryptedObjectWorkspace(acceleratedStore, key, "state/workspace/v1");
        this.runtime = Object.freeze({
          store: acceleratedStore,
          acceleration: acceleratedStore.acceleration,
          journal,
          workspace,
          profiles: new modules.EncryptedProfileCatalogStore(acceleratedStore, key, "state/profiles/v1"),
          contextFabric: new modules.VaultContextFabricPort(acceleratedStore, key, workspace),
        });
      }
      return this.transition({
        phase: "ready",
        ...this.configuredFields(),
        evidence,
        message: "Vault contract verified for this browser origin; synchronization has not been evaluated.",
      });
    } catch (error) {
      if (generation !== this.generation) throw abortReason(controller.signal);
      if (isAbort(error) || controller.signal.aborted) {
        if (!retainedRuntime) {
          this.resetAcceleration();
          this.runtime = undefined;
        }
        this.transition({
          phase: "configured",
          ...this.configuredFields(),
          message: "Probe cancelled. No readiness claim was retained.",
        });
        throw abortReason(controller.signal);
      }
      if (!retainedRuntime) {
        this.resetAcceleration();
        this.runtime = undefined;
      }
      const diagnostic = redactVaultError(error, this.now().toISOString());
      return this.transition({
        phase: "degraded",
        ...this.configuredFields(),
        diagnostic,
        previousEvidence,
        probeResidue: Object.freeze({
          logicalPrefix: `${config.probePrefix}/${runId}`,
          adjacentLogicalPrefix: `${config.probePrefix}/${runId}-adjacent`,
          inventory: "unknown-after-failed-probe",
          deletionAvailableInRuntime: false,
          cleanup: "provider-lifecycle-or-out-of-band",
        }),
        message: "Vault is not ready for strict cloud state.",
      });
    } finally {
      detachExternalAbort();
      if (generation === this.generation) this.abortController = undefined;
    }
  }

  private configuredFields(): ConfiguredFields {
    if (!this.config || !this.requirements) throw new Error("Cloud vault is not configured.");
    return {
      config: this.config,
      requirements: this.requirements,
      workspaceKey: this.workspaceKey ? "attached" : "missing",
    };
  }

  private requireConfiguration(): { config: VaultCloudConfiguration; provider?: ResettableVaultCredentialProvider } {
    if (!this.config || (!this.provider && !this.directStore)) throw new Error("Cloud vault is not configured.");
    return { config: this.config, provider: this.provider };
  }

  private invalidateProbe(reason: string): void {
    this.generation += 1;
    this.abortController?.abort(new DOMException(reason, "AbortError"));
    this.abortController = undefined;
  }

  private resetProvider(): void {
    try {
      this.provider?.reset?.();
    } catch {
      // Reset is best-effort cleanup; references are dropped regardless.
    }
    try {
      this.directReset?.();
    } catch {
      // Direct OAuth token holders are also best-effort page-memory cleanup.
    }
  }

  /**
   * Sweeps this run's probe objects when — and only when — the provider offers a
   * reclamation capability. Keys the provider did not confirm removed keep the
   * original out-of-band warning verbatim, so the notice never overstates what
   * actually happened.
   */
  private async reclaimProbeObjects(
    store: ObjectStore,
    createdKeys: readonly string[],
    signal: AbortSignal,
  ): Promise<VaultProbeEvidence["cleanup"]> {
    const retainedWarning = "Probe objects are immutable. Configure provider lifecycle expiry or remove the listed keys out-of-band.";
    if (!isReclaimableObjectStore(store) || !createdKeys.length) {
      return Object.freeze({
        deletionAvailableInRuntime: false,
        policy: "provider-lifecycle-or-out-of-band",
        warning: retainedWarning,
      });
    }
    let receipt: ObjectReclamationReceipt;
    try {
      receipt = await store.trash(createdKeys, signal);
    } catch {
      // A failed sweep must not degrade a verified probe, and must not claim a
      // removal it did not observe.
      return Object.freeze({
        deletionAvailableInRuntime: true,
        policy: "provider-lifecycle-or-out-of-band",
        warning: `Probe object reclamation did not complete. ${retainedWarning}`,
      });
    }
    const retained = Object.freeze([...receipt.retained].sort());
    /*
     * Having the verb is not the same as being allowed to use it.
     *
     * This reported `true` for any store carrying a `trash` method, which is a
     * claim about the adapter rather than about the deployment. Measured
     * against the local MinIO lab, whose credential policy grants Get/Put/List
     * and not Delete: every key came back refused with a 403 and the runtime
     * still declared deletion available. A sweep that reclaimed nothing is the
     * answer to "can this runtime delete", so it is reported as the answer.
     */
    return Object.freeze({
      deletionAvailableInRuntime: receipt.reclaimed.length > 0,
      policy: retained.length ? "provider-lifecycle-or-out-of-band" : "runtime-reclaimed",
      warning: retained.length
        ? `${retained.length} of ${receipt.requested} probe object(s) were not confirmed removed. ${retainedWarning}`
        : "Probe objects were moved to the provider's trash and confirmed removed from the live index.",
      reclaimedKeys: Object.freeze([...receipt.reclaimed].sort()),
      retainedKeys: retained,
    });
  }

  private resetAcceleration(): void {
    this.acceleratedStore?.closeAcceleration();
    this.acceleratedStore = undefined;
  }

  private diagnostic(
    code: VaultDiagnostic["code"],
    operation: VaultDiagnostic["operation"],
    retryable: boolean,
    publicMessage: string,
  ): VaultDiagnostic {
    return Object.freeze({
      code,
      severity: "error",
      operation,
      publicMessage,
      retryable,
      commitState: "not-applicable",
      recordedAt: this.now().toISOString(),
    });
  }

  private transition(next: WithoutRevision<Exclude<VaultSnapshot, { phase: "disconnected" }>>): VaultSnapshot {
    const snapshot = Object.freeze({ ...next, revision: ++this.revision }) as VaultSnapshot;
    this.current = snapshot;
    this.emit(snapshot);
    return snapshot;
  }

  private transitionDisconnected(): VaultSnapshot {
    const snapshot = disconnectedSnapshot(++this.revision);
    this.current = snapshot;
    this.emit(snapshot);
    return snapshot;
  }

  private emit(snapshot: VaultSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers do not control vault state transitions.
      }
    }
  }
}

function validatedGoogleDriveConfiguration(
  request: ConfigureGoogleDriveVaultRequest,
): GoogleDriveVaultConfiguration {
  const workspaceName = canonicalDisplayValue(
    request.workspace.workspaceName,
    "Google Drive workspace name",
    120,
  );
  const workspaceFolderId = googleDriveId(request.workspace.workspaceFolderId, "workspace folder ID");
  const rootFolderId = googleDriveId(request.workspace.rootFolderId, "root folder ID");
  const segmentsFolderId = googleDriveId(request.workspace.segmentsFolderId, "segments folder ID");
  if (new Set([workspaceFolderId, rootFolderId, segmentsFolderId]).size !== 3) {
    throw new Error("Google Drive workspace folder roles must refer to distinct folders.");
  }
  const namespace = request.workspace.namespaceId;
  if (!/^[A-Za-z0-9_-]{20,128}$/u.test(namespace)) {
    throw new Error("Google Drive workspace namespace is invalid.");
  }
  const accountLabel = canonicalDisplayValue(request.accountLabel, "Google account label", 320);
  const webViewLink = request.workspace.webViewLink === undefined
    ? undefined
    : googleDriveWebViewLink(request.workspace.webViewLink);
  return Object.freeze({
    provider: "google-drive",
    endpoint: "https://www.googleapis.com",
    workspaceName,
    workspaceFolderId,
    ...(webViewLink ? { webViewLink } : {}),
    namespace,
    probePrefix: ".airship-probes/v1",
    credentialSource: Object.freeze({
      kind: "google-identity-services",
      displayName: accountLabel,
      authorityOrigins: Object.freeze([
        "https://accounts.google.com",
        "https://openidconnect.googleapis.com",
        "https://www.googleapis.com",
      ]),
    }),
  });
}

function googleDriveId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{8,256}$/u.test(value)) {
    throw new Error(`Google Drive ${label} is invalid.`);
  }
  return value;
}

function googleDriveWebViewLink(value: string): string {
  if (value.length > 2_048 || /[\r\n]/u.test(value)) throw new Error("Google Drive workspace link is invalid.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Google Drive workspace link is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "drive.google.com" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Google Drive workspace link must use the pinned Drive HTTPS origin.");
  }
  return url.href;
}

function canonicalDisplayValue(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

export function isGoogleDriveConfiguration(config: VaultCloudConfiguration): config is GoogleDriveVaultConfiguration {
  return "provider" in config && config.provider === "google-drive";
}

function googleDriveRequirements(config: GoogleDriveVaultConfiguration, store: ObjectStore): VaultProviderRequirements {
  // GoogleDriveObjectStore implements `trash`, and reclaimProbeObjects sweeps
  // this run's probe objects when it does — but the store is caller-supplied,
  // so the capability is read off the object that was actually handed in rather
  // than assumed from the provider name.
  const reclaimable = isReclaimableObjectStore(store);
  return Object.freeze({
    directBrowserOnly: true,
    credentialContract: Object.freeze({
      productionRequiresExpiration: true,
      productionRequiresSessionToken: false,
      persistence: "memory-only" as const,
      resetEvents: Object.freeze(["logout", "account-switch", "vault-disconnect"] as const),
    }),
    cspConnectSrc: Object.freeze([...config.credentialSource.authorityOrigins]),
    cors: Object.freeze({
      allowedMethods: Object.freeze(["GET", "POST", "PATCH"]),
      allowedRequestHeaders: Object.freeze(["Authorization", "Content-Type", "If-Match", "Range"]),
      exposedResponseHeaders: Object.freeze(["Content-Length", "Content-Range", "ETag", "x-guploader-uploadid"]),
      credentialsMode: "omit" as const,
    }),
    authorization: Object.freeze({
      authenticatedSubjectRequired: true,
      listPrefix: config.workspaceName,
      objectPrefix: `${config.workspaceName}/root/segments`,
      forbiddenByBaseline: Object.freeze(["drive", "drive.readonly", "drive.metadata"]),
    }),
    probeLifecycle: Object.freeze({
      logicalPrefix: `${config.namespace}/${config.probePrefix}`,
      deletionAvailableInRuntime: reclaimable,
      // Even a reclaiming store keeps the out-of-band path: a sweep reports
      // only what the provider confirmed, and anything it did not confirm is
      // still resident.
      cleanup: reclaimable ? "runtime-reclaimed-then-out-of-band" as const : "provider-lifecycle-or-out-of-band" as const,
    }),
  });
}

let runtimeModulesPromise: Promise<VaultRuntimeModules> | undefined;

function loadVaultRuntimeModules(): Promise<VaultRuntimeModules> {
  runtimeModulesPromise ??= import("../load-deferred-capabilities")
    .then(({ loadDeferredCapabilities }) => loadDeferredCapabilities())
    .then((capabilities) => Object.freeze({
    S3ObjectStore: capabilities.S3ObjectStore,
    runObjectStoreConformance: capabilities.runObjectStoreConformance,
    EncryptedObjectJournalBackend: capabilities.EncryptedObjectJournalBackend,
    EncryptedProfileCatalogStore: capabilities.EncryptedProfileCatalogStore,
    EncryptedObjectWorkspace: capabilities.EncryptedObjectWorkspace,
    VaultContextFabricPort: capabilities.VaultContextFabricPort,
    createClientCiphertextCache: capabilities.createClientCiphertextCache,
    CiphertextCachingObjectStore: capabilities.CiphertextCachingObjectStore,
    }));
  return runtimeModulesPromise;
}

function vaultCachePartition(config: VaultCloudConfiguration): string {
  return isGoogleDriveConfiguration(config)
    ? `google-drive\0${config.workspaceFolderId}\0${config.namespace}`
    : `s3\0${config.endpoint}\0${config.bucket}\0${config.namespace}`;
}

async function runEncryptedCompositionProbe(args: {
  store: ObjectStore;
  key: WorkspaceRootKey;
  prefix: string;
  runId: string;
  now: () => Date;
  signal: AbortSignal;
  modules: VaultRuntimeModules;
}): Promise<{ checks: Array<{ name: string; durationMs: number }>; createdKeys: string[] }> {
  const checks: Array<{ name: string; durationMs: number }> = [];
  const measure = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      checks.push({ name, durationMs: Math.max(0, performance.now() - started) });
    }
  };
  throwIfAborted(args.signal);
  const journalPrefix = `${args.prefix}/encrypted-journal`;
  const journal = new args.modules.EncryptedObjectJournalBackend(args.store, args.key, journalPrefix);
  const timestamp = args.now().toISOString();
  const journalMarker = `airship-encrypted-journal-probe-${args.runId}`;
  const session: SessionRecord = {
    id: `probe-${args.runId}`,
    title: journalMarker,
    manifest: {
      protocolVersion: 1,
      systemPrompt: journalMarker,
      systemPromptDigest: "probe-system-digest",
      providerId: "airship-vault-probe",
      model: "none",
      toolManifestDigest: "probe-tool-digest",
      tools: [],
      workspaceId: `probe-${args.runId}`,
      capabilityTier: "web-baseline",
      createdAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    headSequence: 0,
    headDigest: "genesis",
  };
  await measure("encrypted journal create/read/list", async () => {
    throwIfAborted(args.signal);
    await journal.createSession(session);
    const [loaded, listed] = await Promise.all([journal.getSession(session.id), journal.listSessions()]);
    if (!loaded || loaded.id !== session.id || !listed.some((candidate) => candidate.id === session.id)) {
      throw new Error("Encrypted journal readiness read did not return the committed session.");
    }
  });

  const marker = `airship-encrypted-workspace-probe-${args.runId}`;
  const workspace = new args.modules.EncryptedObjectWorkspace(
    args.store,
    args.key,
    `${args.prefix}/encrypted-workspace`,
    () => timestamp,
    () => `revision-${args.runId}`,
  );
  await measure("encrypted workspace write/read/list/remove", async () => {
    throwIfAborted(args.signal);
    const written = await workspace.write("probe.txt", marker, { expectedRevision: null });
    const [read, listed] = await Promise.all([workspace.read("probe.txt"), workspace.list()]);
    if (!read || read.content !== marker || listed.length !== 1 || listed[0]?.revision !== written.revision) {
      throw new Error("Encrypted workspace readiness read did not return the committed file.");
    }
    await workspace.remove("probe.txt", { expectedRevision: written.revision });
    if ((await workspace.list()).length !== 0) throw new Error("Encrypted workspace manifest did not commit the removal.");
  });

  const createdKeys = await measure("encrypted object disclosure check", async () => {
    throwIfAborted(args.signal);
    const summaries = await args.store.list(`${args.prefix}/`, args.signal);
    for (const summary of summaries) {
      throwIfAborted(args.signal);
      const record = await args.store.get(summary.key, args.signal);
      if (!record) throw new Error("Encrypted probe object disappeared during disclosure verification.");
      const serialized = new TextDecoder().decode(record.bytes);
      if (serialized.includes(marker) || serialized.includes(journalMarker) || serialized.includes("/workspace/probe.txt")) {
        throw new Error("Encrypted vault probe detected plaintext journal or workspace material in object storage.");
      }
    }
    return summaries.map((summary) => summary.key);
  });
  return { checks, createdKeys };
}

function redactVaultError(error: unknown, recordedAt: string): VaultDiagnostic {
  if (error instanceof Error && error.name === "GoogleDriveAuthorizationRequiredError") {
    return Object.freeze({
      code: "credential-denied",
      severity: "error",
      operation: "credentials",
      publicMessage: "Google Drive authorization expired or was cleared. Reconnect Google from an explicit click, then verify the vault again.",
      retryable: true,
      commitState: "not-applicable",
      recordedAt,
    });
  }
  if (error instanceof Error && error.name === "GoogleDriveStorageError") {
    const status = /\((\d{3})\)/u.exec(error.message)?.[1];
    const denied = status === "401" || status === "403";
    const conflict = status === "409" || status === "412";
    return Object.freeze({
      code: denied ? "storage-policy-denied" : conflict ? "storage-conflict" : "storage-unreachable",
      severity: "error",
      operation: "storage",
      publicMessage: denied
        ? "Google Drive did not authorize the required app-owned file operation. Reconnect and retry."
        : conflict
          ? "Google Drive rejected a conditional vault update; no winning state was inferred."
          : "Google Drive did not complete the live encrypted-vault probe.",
      retryable: denied || conflict || (status !== undefined && Number(status) >= 500),
      commitState: conflict ? "not-committed" : "unknown",
      recordedAt,
    });
  }
  if (isCognitoIdentityError(error)) {
    const throttled = error.code === "TooManyRequestsException" || error.code === "InternalErrorException";
    return Object.freeze({
      code: throttled ? "credential-throttled" : "credential-denied",
      severity: "error",
      operation: "credentials",
      publicMessage: throttled
        ? "The temporary credential authority is busy; the vault remains unavailable."
        : "The temporary credential authority did not grant this browser a vault session.",
      retryable: error.retryable,
      commitState: "not-applicable",
      requestId: boundedIdentifier(error.requestId),
      recordedAt,
    });
  }
  if (isS3StorageError(error)) {
    const denied = error.details.status === 401 || error.details.status === 403;
    const conflict = error.details.status === 409 || error.details.status === 412;
    return Object.freeze({
      code: denied ? "storage-policy-denied" : conflict ? "storage-conflict" : "storage-unreachable",
      severity: "error",
      operation: "storage",
      publicMessage: denied
        ? "The S3 policy or credential scope did not permit the required vault operation."
        : conflict
          ? "The provider could not serialize a required conditional vault write."
          : "The S3-compatible provider did not complete the live vault probe.",
      retryable: error.details.retryable,
      commitState: error.details.commitState,
      requestId: boundedIdentifier(error.details.requestId),
      recordedAt,
    });
  }
  if (error instanceof Error && (
    error.message.startsWith("Production S3 vaults require") ||
    error.message.startsWith("S3 temporary credentials are expired")
  )) {
    return Object.freeze({
      code: "credential-denied",
      severity: "error",
      operation: "credentials",
      publicMessage: "The credential provider did not supply a sufficiently fresh, expiring S3 session.",
      retryable: true,
      commitState: "not-applicable",
      recordedAt,
    });
  }
  if (error instanceof Error && /(?:S3 provider|S3 object|S3 range|S3 list|S3 returned|ETag)/u.test(error.message)) {
    return Object.freeze({
      code: "storage-invalid-response",
      severity: "error",
      operation: "storage",
      publicMessage: "The S3-compatible provider returned a response that does not satisfy the strict vault contract.",
      retryable: false,
      commitState: "not-applicable",
      recordedAt,
    });
  }
  return Object.freeze({
    code: "conformance-failed",
    severity: "error",
    operation: "probe",
    publicMessage: "The provider or encrypted-state composition failed a required live conformance check.",
    retryable: false,
    commitState: "not-applicable",
    recordedAt,
  });
}

function isCognitoIdentityError(error: unknown): error is Error & {
  code: string;
  retryable: boolean;
  requestId?: string;
} {
  if (!(error instanceof Error) || error.name !== "CognitoIdentityError") return false;
  const value = error as Error & { code?: unknown; retryable?: unknown; requestId?: unknown };
  return typeof value.code === "string" &&
    typeof value.retryable === "boolean" &&
    (value.requestId === undefined || typeof value.requestId === "string");
}

function isS3StorageError(error: unknown): error is Error & {
  details: {
    status?: number;
    retryable: boolean;
    commitState: "not-applicable" | "not-committed" | "unknown";
    requestId?: string;
  };
} {
  if (!(error instanceof Error) || error.name !== "S3StorageError") return false;
  const value = error as Error & { details?: unknown };
  if (!value.details || typeof value.details !== "object" || Array.isArray(value.details)) return false;
  const details = value.details as Record<string, unknown>;
  return (details.status === undefined || typeof details.status === "number") &&
    typeof details.retryable === "boolean" &&
    (details.commitState === "not-applicable" || details.commitState === "not-committed" || details.commitState === "unknown") &&
    (details.requestId === undefined || typeof details.requestId === "string");
}

function boundedIdentifier(value: string | undefined): string | undefined {
  if (!value || value.length > 256 || !/^[A-Za-z0-9._:/=-]+$/u.test(value)) return undefined;
  return value;
}

function forwardAbort(signal: AbortSignal | undefined, target: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => target.abort(signal.reason ?? new DOMException("Vault probe was aborted.", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Vault probe was aborted.", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function randomNonce(): string {
  return randomUuid().replaceAll("-", "");
}

function disconnectedSnapshot(revision: number): VaultSnapshot {
  return Object.freeze({
    phase: "disconnected",
    revision,
    message: "No cloud vault is configured.",
  });
}
