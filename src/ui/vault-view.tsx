import { useRef, useState } from "preact/hooks";
import { isGoogleDriveConfiguration, type VaultSnapshot } from "../vault/coordinator";
import type { LocalDeviceVaultStatus } from "../vault/local-device";
import type { VaultBackend } from "./platform-shell";
import { MenuSelect } from "./menu-select";
import { Seal, type SealState } from "./seal";
import "./vault-view.css";

export type VaultViewProps = {
  snapshot: VaultSnapshot;
  runtimeAdopted?: boolean;
  /**
   * The runtime's own account of a failed or pending adoption.
   *
   * Contract verification and runtime adoption are two outcomes, and today the
   * second one's failure text renders only in the shell's status line on a
   * different route. This surface states both, and prints the runtime's exact
   * sentence when the caller has one. It never invents one.
   */
  adoptionNotice?: string;
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

export type ProviderFactKey = "survives" | "offline" | "reach" | "supply" | "keep" | "lose";

/**
 * The six dimensions that decide where a person's data lives.
 *
 * Every value here already shipped somewhere on this route — in a header
 * paragraph, a truth card, the eviction warning or a provider panel's subtitle.
 * They were just never comparable, because each provider stated its own facts
 * in its own words on its own screen. One matrix, identical rows, so the
 * columns line up and the choice can be read instead of reconstructed.
 */
export const PROVIDER_FACT_ROWS: readonly (readonly [ProviderFactKey, string])[] = Object.freeze([
  ["survives", "Survives closing the tab"],
  ["offline", "Works offline"],
  ["reach", "Reaches other devices"],
  ["supply", "You supply"],
  ["keep", "You keep"],
  ["lose", "What can lose it"],
] as const);

type ProviderProfile = Readonly<{
  id: VaultBackend;
  title: string;
  /** Verbatim option description; unchanged from the shipped selector. */
  description: string;
  /** Verbatim provider sentence, moved to the moment the choice is made. */
  note: string;
  facts: Readonly<Record<ProviderFactKey, string>>;
}>;

export const PROVIDER_PROFILES: readonly ProviderProfile[] = Object.freeze([
  Object.freeze({
    id: "local-device",
    title: "Local Device",
    description: "Encrypted, offline, and persistent in this browser profile",
    note: "Encrypted, offline, and private to this browser profile. Encrypted journal and workspace state remain in browser-managed storage on this device and work offline.",
    facts: Object.freeze({
      survives: "Yes · encrypted on this device",
      offline: "Yes",
      reach: "No",
      supply: "Nothing",
      keep: "A recovery key",
      lose: "Browser eviction · clearing site data",
    }),
  }),
  Object.freeze({
    id: "google-drive",
    title: "Google Drive",
    description: "Your encrypted cross-device Airship workspace folder",
    note: "Airship creates a visible folder in your Drive and stores only client-encrypted manifests and segments. Google never receives the workspace key.",
    facts: Object.freeze({
      survives: "Yes · encrypted in your Drive",
      offline: "No · needs Google",
      reach: "Yes",
      supply: "A Google account",
      keep: "A recovery key",
      lose: "Deleting the Drive folder",
    }),
  }),
  Object.freeze({
    id: "local-lab",
    title: "S3-compatible / MinIO",
    description: "Advanced provider or local development lab",
    note: "Encrypted journal and workspace state travel directly between this device and the selected storage provider. On a loopback lab endpoint nothing is cloud-synchronized.",
    facts: Object.freeze({
      survives: "Yes · encrypted in your bucket",
      offline: "No · needs the endpoint",
      reach: "Yes",
      supply: "Endpoint and keys",
      keep: "A recovery key",
      lose: "Deleting the bucket",
    }),
  }),
  Object.freeze({
    id: "ephemeral",
    title: "Ephemeral",
    description: "Page memory only; nothing synced",
    note: "Workspace and journal state remain only in this page-memory runtime. Nothing is synchronized, and closing the page releases it.",
    facts: Object.freeze({
      survives: "No · released with the page",
      offline: "Yes, until you close it",
      reach: "No",
      supply: "Nothing",
      keep: "Nothing to keep",
      lose: "Closing the page",
    }),
  }),
] as const);

/**
 * Build-time Drive availability, read from the same variable the Drive panel
 * reads. It is the one provider-availability fact this build actually
 * computes, so it is the only one this surface is allowed to state.
 */
function googleDriveConfiguredInBuild(): boolean {
  return ((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ?? "").length > 0;
}

/** Evidence-first vault status surface. It intentionally has no secret inputs. */
export function VaultView({
  snapshot,
  runtimeAdopted = false,
  adoptionNotice,
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
  const driveInBuild = googleDriveConfiguredInBuild();
  /**
   * Drive is the selected provider and this build cannot open it.
   *
   * `googleDrive` above is false here on purpose — it reads the *configuration*,
   * which does not exist while disconnected. This reads the preference, which is
   * what decides whether the route's primary action leads anywhere.
   */
  const driveUnavailable = provider === "google-drive" && !driveInBuild;
  const compare = useRef<HTMLDetailsElement>(null);
  const providerControl = useRef<HTMLDivElement>(null);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  // Open at the moment of choice where the six-by-four matrix is legible.
  // A phone renders it as 24 stacked blocks, so there it stays one tap away
  // behind a trigger that names every column it contains.
  const [compareDefault] = useState(() =>
    typeof window === "undefined" || window.matchMedia("(min-width: 681px)").matches);

  const state = vaultState({
    phase: snapshot.phase,
    localDevice,
    localDeviceOpened: Boolean(localDeviceStatus),
    ephemeral,
    runtimeAdopted,
  });

  function openChooser(): void {
    if (compare.current) compare.current.open = true;
    const trigger = providerControl.current?.querySelector<HTMLElement>("button");
    trigger?.scrollIntoView({ block: "center" });
    trigger?.focus();
  }

  return (
    <section class="vault-view" aria-labelledby="vault-heading">
      <div class="vault-view__bar">
        <h1 id="vault-heading" class="vault-view__title">Vault</h1>
        <p class="vault-view__scope">{localDevice
          ? "Private device state"
          : ephemeral
            ? "Private page state"
            : googleDrive
              ? "Private Drive state"
              : localObjectStore
                ? "Private local object state"
                : "Private object-store state"}</p>
        {/* One status family. The pill used to carry its own colour ramp keyed
            off `snapshot.phase` and a `data-adopted` flag, while the band 40px
            below coloured itself from `vaultState()` — two encodings of one
            state that could disagree. Both now read the same seal. */}
        <span class="vault-view__phase" role="status" aria-live="polite">
          <Seal
            state={sealForState(state)}
            label={vaultPhaseLabel({
              state,
              phase: snapshot.phase,
              phaseLabel: status.label,
              localDevice,
            })}
            density="chip"
          />
        </span>
      </div>

      <div class="vault-view__state" data-state={state}>
        <Seal state={sealForState(state)} label={SEAL_WORD[state]} density="dot" size={24} />
        <div class="vault-view__state-copy">
          <strong>{localDevice
            ? localDeviceStatus ? "Local Device · encrypted and offline" : "Local Device setup required"
            : ephemeral ? "Ephemeral · page memory only"
            : adoptedDrive ? "Google Drive · encrypted"
            : runtimeAdopted ? "Encrypted object store · runtime adopted"
            : snapshot.phase === "ready" ? "Storage contract verified · runtime not adopted"
            : status.headline}</strong>
          {/* When the probe has run, the two outcome cells below carry both
              sentences. Repeating one here would restate a claim 40px above
              the cell that owns it. */}
          {localDevice || ephemeral || runtimeAdopted || snapshot.phase !== "ready" ? (
            <p>{localDevice
              ? localDeviceStatus?.message ?? "Create or recover the device key below. No storage authority is created before the recovery value is acknowledged. Complete the crash-safe recovery ceremony below to activate encrypted offline persistence."
              : ephemeral
                ? "No cloud or device Vault is attached. Use this mode for disposable work, or select a durable provider before closing the page."
              : runtimeAdopted
              ? adoptedDrive
                ? "This browser is using the verified client-encrypted Google Drive workspace and journal adapters. Cross-device sync is not evaluated by this probe."
                : "The active browser runtime uses the verified encrypted workspace and journal adapters. Cross-device sync is not evaluated by this probe."
              : snapshot.message}</p>
          ) : null}
          {!localDevice && snapshot.phase === "disconnected"
            ? <p>No endpoint, credential authority, or workspace key is attached.</p>
            : null}
        </div>
        <div class="vault-view__state-actions">
          {localDevice && !localDeviceStatus ? (
            <>
              <button type="button" onClick={() => focusSetupControl(["[data-vault-create]"])}>Create a device Vault</button>
              <button type="button" class="vault-view__button--secondary" onClick={() => {
                const recover = document.querySelector<HTMLDetailsElement>("details.local-device-vault__recover");
                if (recover) recover.open = true;
                focusSetupControl([".local-device-vault__recover textarea"]);
              }}>Recover with a key</button>
            </>
          ) : null}
          {ephemeral ? (
            <button type="button" onClick={openChooser}>Choose a durable provider</button>
          ) : null}
          {/* The route's one brass action must lead somewhere that works. With
              Drive selected in a build that has no OAuth client, `Configure
              connection` promised a form that the panel below correctly refuses
              to render, so the loudest control on the screen was a dead end. */}
          {driveUnavailable && snapshot.phase === "disconnected" ? (
            <button type="button" onClick={openChooser}>Choose a provider this build can open</button>
          ) : !localDevice && !ephemeral && snapshot.phase === "disconnected" ? (
            <button type="button" onClick={() => {
              // The setup slot renders unconditionally for some providers, so a
              // blind toggle can be a no-op. Move to the fields when they are
              // already on screen; ask the shell for them only when they are not.
              if (!focusSetupControl([".vault-setup-slot input", ".vault-setup-slot textarea", ".vault-setup-slot button"])) onOpenSetup?.();
            }}>Configure connection</button>
          ) : null}
          {snapshot.phase === "probing" && onCancelProbe ? (
            <button type="button" class="vault-view__button--secondary" onClick={onCancelProbe}>Cancel probe</button>
          ) : null}
        </div>
        <details
          class="vault-view__attached"
          open={attachmentsOpen}
          onToggle={(event) => setAttachmentsOpen(event.currentTarget.open)}
        >
          <summary>{`What's attached (${attachedCount(snapshot, localDeviceStatus, localDevice)} of 3) — the device key, the object store and the recovery key`}</summary>
          <ul>
            {attachedRows(snapshot, localDeviceStatus, localDevice).map((row) => (
              <li key={row.label} data-attached={row.attached ? "true" : "false"}>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </li>
            ))}
          </ul>
        </details>
      </div>

      {snapshot.phase === "ready" ? (
        <ul class="vault-view__outcomes" aria-label="Vault outcomes">
          <li>
            <span>Storage contract</span>
            <Seal state="verified" label="Verified" density="dot" size={16} />
            <strong>Verified</strong>
            <p>{status.headline} — {snapshot.message}</p>
          </li>
          <li>
            <span>Runtime adoption</span>
            <Seal state={runtimeAdopted ? "verified" : "attention"} label={runtimeAdopted ? "Adopted" : "Not adopted"} density="dot" size={16} />
            <strong>{runtimeAdopted ? "Adopted" : "Not adopted"}</strong>
            <p>{runtimeAdopted
              ? "This browser runtime writes the workspace and journal through the verified encrypted adapters."
              : "The storage contract passed, but this active runtime is still page-memory until adoption completes. Anything you do now is ephemeral."}</p>
            {!runtimeAdopted && adoptionNotice ? <p class="vault-view__warning" role="alert">{adoptionNotice}</p> : null}
          </li>
        </ul>
      ) : null}

      <div class="vault-provider-selector" ref={providerControl}>
        <div><strong>Storage provider</strong><span>Keys and encryption stay client-owned in every mode.</span></div>
        <MenuSelect
          className="vault-provider-selector__menu"
          placement="down"
          ariaLabel="Vault storage provider"
          value={provider}
          disabled={providerSwitching}
          options={PROVIDER_PROFILES.map((profile) => ({
            value: profile.id,
            label: profile.title,
            description: profile.id === "google-drive" && !driveInBuild
              ? `${profile.description} — unavailable in this build`
              : profile.description,
          }))}
          onChange={(value) => onProviderChange(value as VaultBackend)}
        />
        {providerSwitching ? <span role="status">Moving the active runtime safely…</span> : null}
        <details class="vault-provider-compare" ref={compare} open={compareDefault && snapshot.phase === "disconnected" && !localDeviceStatus}>
          <summary>Compare all four storage options — what survives a closed tab, offline reach, cross-device reach, what you supply, what you keep, and what can lose it</summary>
          <table>
            <caption>Every provider answers the same six questions, so the columns can be read across.</caption>
            <thead>
              <tr>
                <th scope="col">Question</th>
                {PROVIDER_PROFILES.map((profile) => (
                  <th key={profile.id} scope="col" data-current={profile.id === provider ? "true" : "false"}>
                    {profile.title}
                    {profile.id === provider ? <small>Selected</small> : null}
                    {profile.id === "google-drive" && !driveInBuild ? <small>Unavailable in this build</small> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PROVIDER_FACT_ROWS.map(([key, label]) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  {PROVIDER_PROFILES.map((profile) => (
                    <td key={profile.id} data-provider={profile.title} data-current={profile.id === provider ? "true" : "false"}>{profile.facts[key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {/* The four provider sentences, verbatim, one rung down: they are
              paragraphs, and a paragraph in a comparison cell is unreadable in
              four columns. */}
          <details class="vault-provider-notes">
            <summary>How each of the four works, in the provider's own words</summary>
            <dl>
              {PROVIDER_PROFILES.map((profile) => (
                <div key={profile.id} data-current={profile.id === provider ? "true" : "false"}>
                  <dt>{profile.title}</dt>
                  <dd>{profile.note}</dd>
                </div>
              ))}
            </dl>
          </details>
        </details>
      </div>

      {localDevice ? (
        <>
          {localDeviceStatus ? (
            <>
              <dl class="vault-view__configuration">
                <div><dt>Provider</dt><dd>Local Device · {localDeviceStatus.readiness.backend === "opfs" ? "OPFS" : "IndexedDB"}<small>{localDeviceStatus.readiness.backend === "opfs" ? "Origin Private File System. IndexedDB is used when OPFS is unavailable." : "IndexedDB fallback. The Origin Private File System was unavailable in this browser profile."}</small></dd></div>
                <div><dt>Retention</dt><dd>{localDeviceStatus.readiness.persistence === "origin-private-persisted" ? "Persistent permission granted" : "Browser managed · backup recommended"}</dd></div>
                <div><dt>Reach</dt><dd>Device only · offline available</dd></div>
                <div><dt>Encryption</dt><dd>AES-256-GCM envelopes · non-extractable key handle</dd></div>
                <div><dt>Stored</dt><dd>{localDeviceUsage(localDeviceStatus)}</dd></div>
                <div><dt>Schema</dt><dd>v{localDeviceStatus.readiness.schema.current}{localDeviceStatus.readiness.schema.migratedFrom ? ` · migrated from v${localDeviceStatus.readiness.schema.migratedFrom}` : ""}</dd></div>
              </dl>
              {localDeviceStatus.readiness.warning
                ? <p class="vault-view__eviction vault-view__warning">{localDeviceStatus.readiness.warning}</p>
                : null}
            </>
          ) : null}
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
      ) : snapshot.phase === "disconnected" ? null : (
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
            <details class="vault-view__evidence" open>
              <summary class="vault-view__evidence-summary">
                <span class="vault-view__scope">Live evidence</span>
                <strong>Provider contract verified</strong>
                <span class="vault-view__evidence-count">{readinessTally(snapshot.evidence.readiness)}</span>
                <code>{snapshot.evidence.runId}</code>
              </summary>
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
            </details>
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
            <summary>Deployment requirements — authorization lifetime, CSP origins, CORS methods and the authorized object boundary</summary>
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
            {onOpenSetup && <button type="button" class="vault-view__button--secondary" onClick={() => {
              onOpenSetup();
              // The editor is a sibling the shell owns. Wait a frame so a slot
              // that was closed has mounted before the focus lands in it.
              requestAnimationFrame(() => focusSetupControl([".vault-setup-slot input", ".vault-setup-slot textarea", ".vault-setup-slot button"]));
            }}>Edit configuration</button>}
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
  const published = contextMode === "encrypted-ranged";
  return (
    <div class="vault-view__context" data-mode={contextMode ?? "local-fallback"}>
      <div>
        <p class="vault-view__scope">Context fabric</p>
        <strong>{published ? "Encrypted generation published" : "On-device index active"}</strong>
        {/* One consequence line. The retired second sentence said the same
            thing in blue directly beneath this one; both claims survive here. */}
        <span>{published
          ? localDevice
            ? "Matching turns retrieve authenticated ranges from encrypted device shards without a network request."
            : "Matching turns fetch routed, authenticated ranges. Newer workspace snapshots fall back locally until you explicitly update this generation."
          : localDevice
            ? "Turns use the on-device index. Publishing writes encrypted derived shards to this device Vault; source plaintext never leaves this browser."
            : "Turns use the on-device index. Publishing uploads encrypted derived shards; source plaintext never leaves this browser."}</span>
        {contextPublicationMessage && <small role="status" aria-live="polite">{contextPublicationMessage}</small>}
      </div>
      <button type="button" onClick={onPublishContext} disabled={contextPublishing} aria-busy={contextPublishing}>
        {contextPublishing
          ? "Publishing encrypted shards…"
          : published
            ? "Update encrypted index"
            : "Publish encrypted index"}
      </button>
    </div>
  );
}

function Readiness({ label, value }: { label: string; value: "verified" | "not-evaluated" }) {
  return <li data-value={value}><span>{label}</span><strong>{value === "verified" ? "Verified" : "Not evaluated"}</strong></li>;
}

export type VaultStateId = "ephemeral" | "unset" | "attached" | "probing" | "verified" | "adopted" | "blocked";

const SEAL_WORD: Readonly<Record<VaultStateId, string>> = Object.freeze({
  ephemeral: "Not checked",
  unset: "Attention",
  attached: "Asserted",
  probing: "Checking",
  verified: "Attention",
  adopted: "Verified",
  blocked: "Failed",
});

/**
 * The route bar's one-line answer to "where is my data", in the state's own
 * words.
 *
 * Every string here already shipped on this bar. The one change is the
 * local-device case: a Vault that has never been created was reporting
 * `Disconnected` — Airship's failure grammar — for what is a default. The word
 * itself is not retired; it still reports every provider that genuinely was
 * connected and is not (`google-drive-vault.spec.ts` pins that case), and the
 * itemised `What's attached (0 of 3)` rows below say which prerequisite is
 * missing, which is strictly more than the word did.
 */
export function vaultPhaseLabel(input: Readonly<{
  state: VaultStateId;
  phase: VaultSnapshot["phase"];
  /** `phaseCopy().label` — the provider-agnostic phase word. */
  phaseLabel: string;
  localDevice: boolean;
}>): string {
  if (input.state === "ephemeral") return "Page memory · by choice";
  if (input.state === "adopted") {
    return input.localDevice ? "Encrypted device Vault ready" : "Encrypted runtime active";
  }
  if (input.localDevice) {
    return input.state === "verified" ? "Encrypted device Vault ready" : "Not set up yet";
  }
  // A verified contract is not an adopted runtime. Saying only "Contract
  // verified" while the workspace is still in page memory is the overclaim
  // this product exists to avoid.
  if (input.phase === "ready") return "Contract verified · not adopted";
  return input.phaseLabel;
}

export function sealForState(state: VaultStateId): SealState {
  switch (state) {
    case "ephemeral": return "none";
    case "unset": return "attention";
    case "attached": return "asserted";
    case "probing": return "checking";
    // A verified contract without an adopted runtime is not a green state; it
    // is an incomplete one, and the seal has to say so before the copy does.
    case "verified": return "attention";
    case "adopted": return "verified";
    case "blocked": return "failed";
  }
}

export function vaultState(input: Readonly<{
  phase: VaultSnapshot["phase"];
  localDevice: boolean;
  localDeviceOpened: boolean;
  ephemeral: boolean;
  runtimeAdopted: boolean;
}>): VaultStateId {
  if (input.ephemeral) return "ephemeral";
  if (input.localDevice) return input.localDeviceOpened ? (input.runtimeAdopted ? "adopted" : "verified") : "unset";
  switch (input.phase) {
    case "disconnected": return "unset";
    case "configured": return "attached";
    case "probing": return "probing";
    case "degraded": return "blocked";
    case "ready": return input.runtimeAdopted ? "adopted" : "verified";
  }
}

type AttachedRow = Readonly<{ label: string; value: string; attached: boolean }>;

/**
 * The three prerequisites, itemised.
 *
 * "No endpoint, credential authority, or workspace key is attached." stays on
 * screen verbatim; this says which of the three are missing, which is strictly
 * more than the sentence did.
 */
export function attachedRows(
  snapshot: VaultSnapshot,
  localDeviceStatus: LocalDeviceVaultStatus | undefined,
  localDevice: boolean,
): readonly AttachedRow[] {
  if (localDevice) {
    const opened = Boolean(localDeviceStatus);
    return Object.freeze([
      Object.freeze({ label: "Device key", value: opened ? "Enrolled · non-extractable" : "Not enrolled", attached: opened }),
      Object.freeze({ label: "Encrypted object store", value: opened ? `Created · ${localDeviceStatus?.readiness.backend === "opfs" ? "OPFS" : "IndexedDB"}` : "Not created", attached: opened }),
      Object.freeze({ label: "Recovery key", value: opened ? "Saved by you · Airship holds no copy" : "Not saved", attached: opened }),
    ]);
  }
  if (snapshot.phase === "disconnected") {
    return Object.freeze([
      Object.freeze({ label: "Endpoint", value: "None", attached: false }),
      Object.freeze({ label: "Credential authority", value: "None", attached: false }),
      Object.freeze({ label: "Workspace key", value: "None", attached: false }),
    ]);
  }
  const keyAttached = snapshot.workspaceKey === "attached";
  return Object.freeze([
    Object.freeze({ label: "Endpoint", value: snapshot.config.endpoint, attached: true }),
    Object.freeze({ label: "Credential authority", value: snapshot.config.credentialSource.displayName, attached: true }),
    Object.freeze({ label: "Workspace key", value: keyAttached ? "In page memory" : "Missing", attached: keyAttached }),
  ]);
}

export function attachedCount(
  snapshot: VaultSnapshot,
  localDeviceStatus: LocalDeviceVaultStatus | undefined,
  localDevice: boolean,
): number {
  return attachedRows(snapshot, localDeviceStatus, localDevice).filter((row) => row.attached).length;
}

type VaultReadiness = Extract<VaultSnapshot, { phase: "ready" }>["evidence"]["readiness"];

/** Counted, never hard-coded. A check that was not evaluated is never "verified". */
export function readinessTally(readiness: VaultReadiness): string {
  const values: readonly string[] = Object.values(readiness);
  const verified = values.filter((value) => value === "verified").length;
  const pending = values.length - verified;
  return pending === 0
    ? `${verified} of ${values.length} checks verified`
    : `${verified} of ${values.length} checks verified · ${pending} not evaluated`;
}

function localDeviceUsage(status: LocalDeviceVaultStatus): string {
  const { usageBytes, quotaBytes } = status.readiness;
  if (usageBytes === undefined) return "Not reported";
  if (quotaBytes === undefined) return formatVaultBytes(usageBytes);
  return `${formatVaultBytes(usageBytes)} of ${formatVaultBytes(quotaBytes)}`;
}

function formatVaultBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "Unknown";
  if (value < 1024) return `${Math.floor(value)} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let amount = value / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index]!;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

/**
 * Move to a control the shell renders as a sibling of this view.
 *
 * The route's loudest button used to toggle a slot that was already open, so
 * it produced no visible change at all. Returning whether a target was found
 * lets the caller fall back to the slot toggle only when there is nothing on
 * screen to move to.
 */
function focusSetupControl(selectors: readonly string[]): boolean {
  if (typeof document === "undefined") return false;
  for (const selector of selectors) {
    const node = document.querySelector<HTMLElement>(selector);
    if (!node) continue;
    node.scrollIntoView({ block: "center" });
    node.focus();
    return true;
  }
  return false;
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
