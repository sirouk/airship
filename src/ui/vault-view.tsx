import { isGoogleDriveConfiguration, type VaultSnapshot } from "../vault/coordinator";
import type { LocalDeviceVaultStatus } from "../vault/local-device";
import type { VaultBackend } from "./platform-shell";
import { MenuSelect } from "./menu-select";
import "./vault-view.css";

export type VaultViewProps = {
  snapshot: VaultSnapshot;
  runtimeAdopted?: boolean;
  contextMode?: "memory-only" | "encrypted-ranged" | "local-fallback";
  contextPublishing?: boolean;
  contextPublicationMessage?: string;
  onPublishContext?: () => void;
  onOpenSetup?: () => void;
  onProbe?: () => void;
  onCancelProbe?: () => void;
  onReauthorize?: () => void;
  reauthorizing?: boolean;
  onDisconnect?: () => void;
  provider: VaultBackend;
  providerSwitching?: boolean;
  onProviderChange(provider: VaultBackend): void;
  localDeviceStatus?: LocalDeviceVaultStatus;
};

/** Evidence-first vault status surface. It intentionally has no secret inputs. */
export function VaultView({
  snapshot,
  runtimeAdopted = false,
  contextMode,
  contextPublishing = false,
  contextPublicationMessage,
  onPublishContext,
  onOpenSetup,
  onProbe,
  onCancelProbe,
  onReauthorize,
  reauthorizing = false,
  onDisconnect,
  provider,
  providerSwitching = false,
  onProviderChange,
  localDeviceStatus,
}: VaultViewProps) {
  const status = phaseCopy(snapshot);
  const localDevice = provider === "local-device";
  const ephemeral = provider === "ephemeral";
  const googleDrive = snapshot.phase !== "disconnected" && isGoogleDriveConfiguration(snapshot.config);
  const s3Configuration = snapshot.phase !== "disconnected"
    && !isGoogleDriveConfiguration(snapshot.config)
    ? snapshot.config
    : undefined;
  const localObjectStore = s3Configuration?.mode === "local-development";
  const adoptedDrive = runtimeAdopted && googleDrive;
  return (
    <section class="vault-view" aria-labelledby="vault-heading">
      <header class="vault-view__header">
        <div>
          <p class="vault-view__eyebrow">{localDevice
            ? "Private device state"
            : ephemeral
              ? "Private page state"
              : googleDrive
                ? "Private Drive state"
                : localObjectStore
                  ? "Private local object state"
                  : "Private object-store state"}</p>
          <h1 id="vault-heading">Vault</h1>
          <p>{localDevice
            ? "Encrypted journal and workspace state remain in browser-managed storage on this device and work offline."
            : ephemeral
              ? "Workspace and journal state remain only in this page-memory runtime. Nothing is synchronized, and closing the page releases it."
              : localObjectStore
                ? "Encrypted journal and workspace state move directly between this page and the selected loopback S3-compatible store. Nothing is cloud-synchronized."
                : "Encrypted journal and workspace state travel directly between this device and the selected storage provider."}</p>
        </div>
        <span class={`vault-view__phase vault-view__phase--${snapshot.phase}`} role="status" aria-live="polite">
          {localDevice && localDeviceStatus
            ? "Encrypted device Vault ready"
            : runtimeAdopted
              ? "Encrypted runtime active"
              : status.label}
        </span>
      </header>

      <div class="vault-provider-selector">
        <div><strong>Storage provider</strong><span>Keys and encryption stay client-owned in every mode.</span></div>
        <MenuSelect
          className="vault-provider-selector__menu"
          placement="down"
          ariaLabel="Vault storage provider"
          value={provider}
          disabled={providerSwitching}
          options={[
            { value: "local-device", label: "Local Device", description: "Encrypted, offline, and persistent in this browser profile" },
            { value: "google-drive", label: "Google Drive", description: "Your encrypted cross-device Airship workspace folder" },
            { value: "local-lab", label: "S3-compatible / MinIO", description: "Advanced provider or local development lab" },
            { value: "ephemeral", label: "Ephemeral", description: "Page memory only; nothing synced" },
          ]}
          onChange={(value) => onProviderChange(value as VaultBackend)}
        />
        {providerSwitching ? <span role="status">Moving the active runtime safely…</span> : null}
      </div>

      <div class="vault-view__truth" data-phase={snapshot.phase}>
        <strong>{localDevice
          ? localDeviceStatus ? "Local Device · encrypted and offline" : "Local Device setup required"
          : ephemeral ? "Ephemeral · page memory only"
          : adoptedDrive ? "Google Drive · encrypted" : status.headline}</strong>
        <span>{localDevice
          ? localDeviceStatus?.message ?? "Create or recover the device key below. No storage authority is created before the recovery value is acknowledged."
          : ephemeral
            ? "No cloud or device Vault is attached. Use this mode for disposable work, or select a durable provider before closing the page."
          : runtimeAdopted
          ? adoptedDrive
            ? "This browser is using the verified client-encrypted Google Drive workspace and journal adapters. Cross-device sync is not evaluated by this probe."
            : "The active browser runtime uses the verified encrypted workspace and journal adapters. Cross-device sync is not evaluated by this probe."
          : snapshot.message}</span>
      </div>

      {localDevice ? (
        <>
          {localDeviceStatus ? (
            <dl class="vault-view__configuration">
              <div><dt>Provider</dt><dd>Local Device</dd></div>
              <div><dt>Storage engine</dt><dd>{localDeviceStatus.readiness.backend === "opfs" ? "Origin Private File System" : "IndexedDB fallback"}</dd></div>
              <div><dt>Retention</dt><dd>{localDeviceStatus.readiness.persistence === "origin-private-persisted" ? "Persistent permission granted" : "Browser managed · backup recommended"}</dd></div>
              <div><dt>Synchronization</dt><dd>Device only · offline available</dd></div>
              <div><dt>Encryption</dt><dd>AES-256-GCM envelopes · non-extractable key handle</dd></div>
              <div><dt>Schema</dt><dd>v{localDeviceStatus.readiness.schema.current}{localDeviceStatus.readiness.schema.migratedFrom ? ` · migrated from v${localDeviceStatus.readiness.schema.migratedFrom}` : ""}</dd></div>
            </dl>
          ) : (
            <div class="vault-view__empty">
              <p>Complete the crash-safe recovery ceremony below to activate encrypted offline persistence.</p>
              {onOpenSetup ? <button type="button" onClick={onOpenSetup}>Open Local Device setup</button> : null}
            </div>
          )}
          {runtimeAdopted && onPublishContext ? <ContextFabricPanel
            contextMode={contextMode}
            contextPublishing={contextPublishing}
            contextPublicationMessage={contextPublicationMessage}
            localDevice
            onPublishContext={onPublishContext}
          /> : null}
          {runtimeAdopted && onDisconnect ? (
            <div class="vault-view__actions">
              <button type="button" class="vault-view__button--quiet" onClick={onDisconnect}>Switch to ephemeral · keep a page copy</button>
            </div>
          ) : null}
        </>
      ) : snapshot.phase === "disconnected" ? (
        <div class="vault-view__empty">
          <p>No endpoint, credential authority, or workspace key is attached.</p>
          {onOpenSetup && <button type="button" onClick={onOpenSetup}>Configure vault</button>}
        </div>
      ) : (
        <>
          <dl class="vault-view__configuration">
            <div><dt>Provider</dt><dd>{isGoogleDriveConfiguration(snapshot.config) ? "Google Drive" : "S3-compatible"}</dd></div>
            <div><dt>Endpoint</dt><dd>{snapshot.config.endpoint}</dd></div>
            {isGoogleDriveConfiguration(snapshot.config) ? <>
              <div><dt>Workspace</dt><dd>{snapshot.config.webViewLink ? <a href={snapshot.config.webViewLink} target="_blank" rel="noreferrer">{snapshot.config.workspaceName}</a> : snapshot.config.workspaceName}</dd></div>
              <div><dt>Folder ID</dt><dd><code>{snapshot.config.workspaceFolderId}</code></dd></div>
            </> : <>
              <div><dt>Bucket</dt><dd>{snapshot.config.bucket}</dd></div>
              <div><dt>Region</dt><dd>{snapshot.config.region}</dd></div>
            </>}
            <div><dt>Opaque namespace</dt><dd>{snapshot.config.namespace}</dd></div>
            <div><dt>Credential path</dt><dd>{snapshot.config.credentialSource.displayName}</dd></div>
            <div><dt>Workspace key</dt><dd>{snapshot.workspaceKey === "attached" ? "In page memory" : "Missing"}</dd></div>
          </dl>

          {snapshot.phase === "ready" && (
            <div class="vault-view__evidence">
              <div class="vault-view__evidence-heading">
                <div>
                  <p class="vault-view__eyebrow">Live evidence</p>
                  <h3>Provider contract verified</h3>
                </div>
                <code>{snapshot.evidence.runId}</code>
              </div>
              <ul class="vault-view__readiness" aria-label="Verified vault capabilities">
                <Readiness label="Conditional create" value={snapshot.evidence.readiness.conditionalCreate} />
                <Readiness label="Compare and swap" value={snapshot.evidence.readiness.compareAndSwap} />
                <Readiness label="Exact ranges" value={snapshot.evidence.readiness.exactRange} />
                <Readiness label="Prefix listing" value={snapshot.evidence.readiness.prefixList} />
                <Readiness label="Read after write" value={snapshot.evidence.readiness.readAfterWrite} />
                <Readiness label="Encrypted journal" value={snapshot.evidence.readiness.encryptedJournal} />
                <Readiness label="Encrypted workspace" value={snapshot.evidence.readiness.encryptedWorkspace} />
                <Readiness label="Data synchronization" value={snapshot.evidence.readiness.dataSynchronization} />
              </ul>
              <details>
                <summary>Probe timings and immutable objects</summary>
                <div class="vault-view__details">
                  <p><strong>Prefix:</strong> <code>{snapshot.evidence.logicalPrefix}</code></p>
                  <ul>
                    {snapshot.evidence.checks.map((check) => (
                      <li key={check.name}><span>{check.name}</span><time>{check.durationMs.toFixed(1)} ms</time></li>
                    ))}
                  </ul>
                  <p class="vault-view__warning">{snapshot.evidence.cleanup.warning}</p>
                  <p>{snapshot.evidence.createdKeys.length} immutable probe object keys are available in the machine-readable evidence.</p>
                </div>
              </details>
            </div>
          )}

          {snapshot.phase === "degraded" && (
            <div class="vault-view__diagnostic" role="alert">
              <div><strong>{snapshot.diagnostic.code}</strong><span>{snapshot.diagnostic.retryable ? "Retryable" : "Review required"}</span></div>
              <p>{snapshot.diagnostic.publicMessage}</p>
              {snapshot.diagnostic.requestId && <p>Provider request: <code>{snapshot.diagnostic.requestId}</code></p>}
              <p>No raw provider response, credential, token, or workspace key is retained in this diagnostic.</p>
              {snapshot.probeResidue && (
                <p class="vault-view__warning">
                  The failed run may have immutable objects under <code>{snapshot.probeResidue.logicalPrefix}</code> and its adjacent test prefix. Inventory is unknown; lifecycle or out-of-band cleanup is required.
                </p>
              )}
            </div>
          )}

          {snapshot.phase === "ready" && runtimeAdopted && onPublishContext ? <ContextFabricPanel
            contextMode={contextMode}
            contextPublishing={contextPublishing}
            contextPublicationMessage={contextPublicationMessage}
            onPublishContext={onPublishContext}
          /> : null}

          <details class="vault-view__requirements">
            <summary>Deployment requirements</summary>
            <div class="vault-view__details">
              <p>Authorization is expiring and memory-only; it is reset on logout, account switch, and disconnect.</p>
              <p>CSP <code>connect-src</code> origins:</p>
              <ul>{snapshot.requirements.cspConnectSrc.map((origin) => <li key={origin}><code>{origin}</code></li>)}</ul>
              <p>Direct browser requests must support {snapshot.requirements.cors.allowedMethods.join("/")} and expose ETag, range, and length headers used by the verified contract.</p>
              <p>Authorized object boundary: <code>{snapshot.requirements.authorization.objectPrefix}</code></p>
            </div>
          </details>

          <div class="vault-view__actions">
            {snapshot.phase === "probing"
              ? onCancelProbe && <button type="button" onClick={onCancelProbe}>Cancel probe</button>
              : onProbe && <button type="button" onClick={onProbe} disabled={snapshot.workspaceKey !== "attached"}>
                  {snapshot.phase === "ready" ? "Verify again" : "Run live probe"}
                </button>}
            {googleDrive && onReauthorize && <button type="button" class="vault-view__button--secondary" onClick={onReauthorize} disabled={reauthorizing}>
              {reauthorizing ? "Renewing Google access…" : "Renew Google access"}
            </button>}
            {onOpenSetup && <button type="button" class="vault-view__button--secondary" onClick={onOpenSetup}>Edit configuration</button>}
            {onDisconnect && <button type="button" class="vault-view__button--quiet" onClick={onDisconnect}>Disconnect · continue locally</button>}
          </div>
        </>
      )}
    </section>
  );
}

function ContextFabricPanel({
  contextMode,
  contextPublishing,
  contextPublicationMessage,
  localDevice = false,
  onPublishContext,
}: Readonly<{
  contextMode?: "memory-only" | "encrypted-ranged" | "local-fallback";
  contextPublishing: boolean;
  contextPublicationMessage?: string;
  localDevice?: boolean;
  onPublishContext(): void;
}>) {
  return (
    <div class="vault-view__context" data-mode={contextMode ?? "local-fallback"}>
      <div>
        <p class="vault-view__eyebrow">Context fabric</p>
        <strong>{contextMode === "encrypted-ranged" ? "Encrypted generation published" : "On-device index active"}</strong>
        <span>{contextMode === "encrypted-ranged"
          ? localDevice
            ? "Matching turns retrieve authenticated ranges from encrypted device shards without a network request."
            : "Matching turns fetch routed, authenticated ranges. Newer workspace snapshots fall back locally until you explicitly update this generation."
          : localDevice
            ? "Publishing writes encrypted derived shards to this device Vault; source plaintext never leaves this browser."
            : "No matching encrypted generation is active. Publishing uploads encrypted derived shards; source plaintext never leaves this browser."}</span>
        {contextPublicationMessage && <small role="status" aria-live="polite">{contextPublicationMessage}</small>}
      </div>
      <button type="button" onClick={onPublishContext} disabled={contextPublishing} aria-busy={contextPublishing}>
        {contextPublishing
          ? "Publishing encrypted shards…"
          : contextMode === "encrypted-ranged"
            ? "Update encrypted index"
            : "Publish encrypted index"}
      </button>
    </div>
  );
}

function Readiness({ label, value }: { label: string; value: "verified" | "not-evaluated" }) {
  return <li data-value={value}><span>{label}</span><strong>{value === "verified" ? "Verified" : "Not evaluated"}</strong></li>;
}

function phaseCopy(snapshot: VaultSnapshot): { label: string; headline: string } {
  switch (snapshot.phase) {
    case "disconnected": return { label: "Disconnected", headline: "No vault claim" };
    case "configured": return { label: "Configured", headline: "Configuration only" };
    case "probing": return { label: "Testing", headline: "Live checks in progress" };
    case "ready": return { label: "Contract verified", headline: "Browser storage contract passed" };
    case "degraded": return { label: "Not ready", headline: "Strict mode blocked" };
  }
}
