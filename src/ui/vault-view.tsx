import { isGoogleDriveConfiguration, type VaultSnapshot } from "../vault/coordinator";
import "./vault-view.css";

export type VaultViewProps = {
  snapshot: VaultSnapshot;
  runtimeAdopted?: boolean;
  onOpenSetup?: () => void;
  onProbe?: () => void;
  onCancelProbe?: () => void;
  onDisconnect?: () => void;
};

/** Evidence-first vault status surface. It intentionally has no secret inputs. */
export function VaultView({
  snapshot,
  runtimeAdopted = false,
  onOpenSetup,
  onProbe,
  onCancelProbe,
  onDisconnect,
}: VaultViewProps) {
  const status = phaseCopy(snapshot);
  return (
    <section class="vault-view" aria-labelledby="vault-heading">
      <header class="vault-view__header">
        <div>
          <p class="vault-view__eyebrow">Private cloud state</p>
          <h1 id="vault-heading">Vault</h1>
          <p>Encrypted journal and workspace state travel directly between this device and the selected object store.</p>
        </div>
        <span class={`vault-view__phase vault-view__phase--${snapshot.phase}`} role="status" aria-live="polite">
          {runtimeAdopted ? "Encrypted runtime active" : status.label}
        </span>
      </header>

      <div class="vault-view__truth" data-phase={snapshot.phase}>
        <strong>{status.headline}</strong>
        <span>{runtimeAdopted
          ? "This page has adopted the verified client-encrypted workspace and journal adapters. Cross-device convergence remains outside the provider probe and is not certified."
          : snapshot.message}</span>
      </div>

      {snapshot.phase === "disconnected" ? (
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
            {onOpenSetup && <button type="button" class="vault-view__button--secondary" onClick={onOpenSetup}>Edit configuration</button>}
            {onDisconnect && <button type="button" class="vault-view__button--quiet" onClick={onDisconnect}>Disconnect and clear memory</button>}
          </div>
        </>
      )}
    </section>
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
    case "ready": return { label: "Contract verified", headline: "Storage and encryption path ready" };
    case "degraded": return { label: "Not ready", headline: "Strict mode blocked" };
  }
}
