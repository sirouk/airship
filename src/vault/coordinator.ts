import type { SessionRecord } from "../core/journal";
import { randomUuid } from "../core/id";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import type { EncryptedObjectJournalBackend } from "../storage/encrypted-object-journal";
import type { WorkspaceRootKey } from "../storage/encrypted-envelope";
import type { ObjectStore } from "../storage/object-store";
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
    deletionAvailableInRuntime: false;
    policy: "provider-lifecycle-or-out-of-band";
    warning: string;
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

export type ReadyVaultRuntime = Readonly<{
  store: ObjectStore;
  journal: EncryptedObjectJournalBackend;
  workspace: EncryptedObjectWorkspace;
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
  EncryptedObjectWorkspace: typeof import("./encrypted-workspace").EncryptedObjectWorkspace;
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
  private directReset?: () => void;
  private runtime?: ReadyVaultRuntime;
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
    this.runtime = undefined;
    this.config = config;
    this.requirements = vaultProviderRequirements(config);
    this.provider = request.credentialProvider;
    this.workspaceKey = request.workspaceKey;
    this.fetchImplementation = request.fetchImplementation;
    this.now = request.now ?? (() => new Date());
    this.store = undefined;
    this.directStore = undefined;
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
    this.invalidateProbe("Vault configuration was replaced.");
    this.resetProvider();
    this.runtime = undefined;
    const workspaceName = request.workspace.workspaceName.trim();
    if (!workspaceName || workspaceName.length > 120) throw new Error("Google Drive workspace name is invalid.");
    this.config = Object.freeze({
      provider: "google-drive",
      endpoint: "https://www.googleapis.com",
      workspaceName,
      workspaceFolderId: request.workspace.workspaceFolderId,
      webViewLink: request.workspace.webViewLink,
      namespace: request.workspace.namespaceId,
      probePrefix: ".airship-probes/v1",
      credentialSource: Object.freeze({
        kind: "google-identity-services",
        displayName: request.accountLabel,
        authorityOrigins: Object.freeze([
          "https://accounts.google.com",
          "https://openidconnect.googleapis.com",
          "https://www.googleapis.com",
        ]),
      }),
    });
    this.requirements = googleDriveRequirements(this.config);
    this.provider = undefined;
    this.workspaceKey = request.workspaceKey;
    this.fetchImplementation = undefined;
    this.now = request.now ?? (() => new Date());
    this.store = request.store;
    this.directStore = request.store;
    this.directReset = request.reset;
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
    this.runtime = undefined;
    this.store = undefined;
    this.directStore = undefined;
    this.directReset = undefined;
    this.fetchImplementation = undefined;
    this.workspaceKey = undefined;
    this.provider = undefined;
    this.config = undefined;
    this.requirements = undefined;
    return this.transitionDisconnected();
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
    this.runtime = undefined;
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
        cleanup: Object.freeze({
          deletionAvailableInRuntime: false,
          policy: "provider-lifecycle-or-out-of-band",
          warning: "Probe objects are immutable. Configure provider lifecycle expiry or remove the listed keys out-of-band.",
        }),
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
      this.runtime = Object.freeze({
        store,
        journal: new modules.EncryptedObjectJournalBackend(store, key, "state/journal/v1"),
        workspace: new modules.EncryptedObjectWorkspace(store, key, "state/workspace/v1"),
      });
      return this.transition({
        phase: "ready",
        ...this.configuredFields(),
        evidence,
        message: "Vault contract verified for this browser origin; synchronization has not been evaluated.",
      });
    } catch (error) {
      if (generation !== this.generation) throw abortReason(controller.signal);
      if (isAbort(error) || controller.signal.aborted) {
        this.runtime = undefined;
        this.transition({
          phase: "configured",
          ...this.configuredFields(),
          message: "Probe cancelled. No readiness claim was retained.",
        });
        throw abortReason(controller.signal);
      }
      this.runtime = undefined;
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

export function isGoogleDriveConfiguration(config: VaultCloudConfiguration): config is GoogleDriveVaultConfiguration {
  return "provider" in config && config.provider === "google-drive";
}

function googleDriveRequirements(config: GoogleDriveVaultConfiguration): VaultProviderRequirements {
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
      deletionAvailableInRuntime: false as const,
      cleanup: "provider-lifecycle-or-out-of-band" as const,
    }),
  });
}

let runtimeModulesPromise: Promise<VaultRuntimeModules> | undefined;

function loadVaultRuntimeModules(): Promise<VaultRuntimeModules> {
  runtimeModulesPromise ??= loadDeferredCapabilities().then((capabilities) => Object.freeze({
    S3ObjectStore: capabilities.S3ObjectStore,
    runObjectStoreConformance: capabilities.runObjectStoreConformance,
    EncryptedObjectJournalBackend: capabilities.EncryptedObjectJournalBackend,
    EncryptedObjectWorkspace: capabilities.EncryptedObjectWorkspace,
  }));
  return runtimeModulesPromise;
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
