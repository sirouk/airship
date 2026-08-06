import { useId, useRef, useState } from "preact/hooks";
import { isDeployableGoogleOAuthClientId } from "../storage/google-drive-configuration";
import { EPHEMERAL_RETENTION_DISCLOSURE } from "./chat/return-ledger";
import { isGoogleDriveConfiguration, type VaultSnapshot } from "../vault/coordinator";
import type { LocalDeviceVaultStatus } from "../vault/local-device";
import { vaultBackendUnavailableReason, type VaultBackend } from "./platform-shell";
import { BrandLogo } from "./brand-icons";
import { ConfirmDialog } from "./confirm-dialog";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import { Seal, type SealState } from "./seal";
import "./vault-view.css";

/**
 * What the connected Vault is holding, in facts the store itself reported.
 *
 * Every field is optional because honesty here is per-adapter: a page-memory
 * runtime cannot price its own heap, and an encrypted cloud store can be
 * listed. A missing field renders as absent, never as zero.
 */
export type VaultUsageFacts = Readonly<{
  /** Objects under the Vault's namespace, when the store can enumerate them. */
  objects?: number;
  /** Bytes those objects occupy — ciphertext for encrypted stores. */
  bytes?: number;
  /** Quota the environment grants, when the browser reports one. */
  quotaBytes?: number;
  /** Provider-specific measured facts, e.g. which backend the browser chose. */
  notes?: readonly string[];
}>;

export type VaultViewProps = {
  snapshot: VaultSnapshot;
  runtimeAdopted?: boolean;
  /**
   * Live usage facts for the attached destination. The route renders them at
   * the top only while something is actually connected — a selector on a
   * disconnected route has nothing to count.
   */
  usage?: VaultUsageFacts;
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
  /**
   * The danger zone. Renderable only when something is actually held to
   * wipe — the route decides, per provider, whether "purge everything this
   * destination holds" is a promise this build can keep.
   */
  wipeAvailable?: boolean;
  wipeBusy?: boolean;
  onWipeStorage?: () => void;
  /** Erases the ephemeral posture's return-ledger witness, and nothing else. */
  onEraseContinuityRecord?: () => void;
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
    id: "ephemeral",
    title: "Ephemeral",
    description: "Page memory only; nothing synced",
    /*
     * The retention sentence is appended from the module that implements it.
     *
     * "Closing the page releases it" is true of everything a person writes and
     * was not true of everything Airship keeps: the return ledger persists an
     * opaque id, a message count and a clock in `localStorage` so a returning
     * person can be told that something was not kept. Stating that here, at the
     * moment this option is chosen, is what makes the row honest — and reading
     * it from `EPHEMERAL_RETENTION_DISCLOSURE` is what stops the claim and the
     * implementation drifting apart.
     */
    note: `Workspace and journal state remain only in this page-memory runtime. Nothing is synchronized, and closing the page releases it. ${EPHEMERAL_RETENTION_DISCLOSURE}`,
    facts: Object.freeze({
      survives: "No · released with the page",
      offline: "Yes, until you close it",
      reach: "No",
      supply: "Nothing",
      keep: "Nothing to keep",
      lose: "Closing the page",
    }),
  }),
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
      /*
       * The row has to answer the row below it.
       *
       * "A recovery key" read as the antidote to "Browser eviction · clearing
       * site data", and the Atlas drove that reading to its end: a fresh
       * browser profile plus the correct key returns "The recovery key did not
       * authenticate this Local Device Vault. No existing local device Vault
       * was found for this partition." The key authenticates a Vault; the
       * ciphertext is in this profile's storage. Both artifacts, or neither.
       */
      keep: "A recovery key and an encrypted backup file — the key alone cannot rebuild an evicted store",
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
    // This rung used to describe the S3 adapter's theoretical capability — "in
    // your bucket", "Reaches other devices: Yes" — but `createLocalLabConfigureRequest`
    // can only build `mode: "local-development"`, which `validateVaultS3Configuration`
    // confines to a loopback hostname and `changeVaultProvider` to a loopback
    // page. There is no shippable configuration behind the promise, so the row
    // answers for the one mode this build can construct.
    description: "Loopback development lab",
    note: "On a loopback lab endpoint nothing is cloud-synchronized. Encrypted journal and workspace state travel directly between this device and the selected storage provider.",
    facts: Object.freeze({
      survives: "Yes · encrypted in your loopback lab",
      offline: "No · needs the endpoint",
      reach: "No · loopback only",
      supply: "A loopback endpoint and disposable keys",
      keep: "A recovery key",
      lose: "Deleting the lab bucket",
    }),
  }),
] as const);

/**
 * Build-time Drive availability, decided by the product's one availability
 * predicate rather than by a second reading of the same variable.
 *
 * Raw truthiness answered "available" for any non-empty string, so a malformed
 * client ID printed a live connect route while `availableVaultBackend` — which
 * uses the strict predicate — silently rewrote the stored preference and the
 * authorizer threw at construction. One fact, one implementation.
 */
export function googleDriveAvailableInBuild(clientId: string | undefined): boolean {
  return isDeployableGoogleOAuthClientId(clientId);
}

/**
 * One mark per destination, recognisable before its name is read.
 *
 * Google Drive is a vendor's own product, so it carries the vendor's mark
 * from `brand-icons`; the other three are destinations, not brands, and stay
 * in the stroke set. Ephemeral is a dashed ring — present while you look at
 * it, nothing when you let it go.
 */
function VaultBackendMark({ backend, size = 16 }: Readonly<{ backend: VaultBackend; size?: number }>) {
  if (backend === "google-drive") return <BrandLogo name="google-drive" size={size} />;
  if (backend === "local-device") return <Icon name="storage-device" size={size} />;
  if (backend === "ephemeral") return <Icon name="storage-ephemeral" size={size} />;
  return <Icon name="storage-s3" size={size} />;
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
  usage,
  wipeAvailable = false,
  wipeBusy = false,
  onWipeStorage,
  onEraseContinuityRecord,
}: VaultViewProps) {
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false);
  const [continuityErased, setContinuityErased] = useState(false);
  const status = phaseCopy(snapshot);
  const localDevice = provider === "local-device";
  const ephemeral = provider === "ephemeral";
  // Computed once: the summary's denominator and enumeration are derived from
  // these exact rows, so they cannot drift from the list underneath them.
  const prerequisites = attachedRows(snapshot, localDeviceStatus, localDevice);
  const googleDrive = snapshot.phase !== "disconnected" && isGoogleDriveConfiguration(snapshot.config);
  const s3Configuration = snapshot.phase !== "disconnected"
    && !isGoogleDriveConfiguration(snapshot.config)
    ? snapshot.config
    : undefined;
  const localObjectStore = s3Configuration?.mode === "local-development";
  const adoptedDrive = runtimeAdopted && googleDrive;
  const driveInBuild = googleDriveAvailableInBuild(import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined);
  /**
   * Drive is the selected provider and this build cannot open it.
   *
   * `googleDrive` above is false here on purpose — it reads the *configuration*,
   * which does not exist while disconnected. This reads the preference, which is
   * what decides whether the route's primary action leads anywhere.
   */
  const driveUnavailable = provider === "google-drive" && !driveInBuild;
  /**
   * Why this build cannot open a destination, in the one place that decides it.
   *
   * The same predicate answers for Preferences' Durability row and for
   * `changeVaultProvider`'s precondition, so the selector cannot offer a
   * destination the shell would then refuse — or, worse, detach the adopted
   * Vault for.
   */
  const providerUnopenableReason = (backend: VaultBackend): string | undefined =>
    vaultBackendUnavailableReason(
      backend,
      import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined,
      typeof window === "undefined" ? undefined : window.location,
    );
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

      {usage ? (
        <dl class="vault-usage" data-connected="true" aria-label={`${PROVIDER_PROFILES.find((profile) => profile.id === provider)?.title ?? provider} usage`}>
          <div class="vault-usage__cell">
            <dt><VaultBackendMark backend={provider} size={16} /> Stored</dt>
            <dd>{usage.bytes !== undefined
              ? usage.quotaBytes !== undefined
                ? `${formatVaultBytes(usage.bytes)} of ${formatVaultBytes(usage.quotaBytes)}`
                : formatVaultBytes(usage.bytes)
              : usage.quotaBytes !== undefined
                ? `Of ${formatVaultBytes(usage.quotaBytes)}`
                : "Not measurable"}</dd>
          </div>
          <div class="vault-usage__cell">
            <dt>Objects</dt>
            <dd>{usage.objects !== undefined ? usage.objects.toLocaleString() : "Not enumerable"}</dd>
          </div>
          {(usage.notes ?? []).map((note) => (
            <div class="vault-usage__cell" key={note}><dt>State</dt><dd>{note}</dd></div>
          ))}
        </dl>
      ) : null}

      <div class="vault-view__state" data-state={state}>
        <Seal state={sealForState(state)} label={SEAL_WORD[state]} density="dot" size={24} />
        <div class="vault-view__state-copy">
          {/* A requirement in the failure register was the first thing a person read
              after pressing "Keep future conversations" on the loss report —
              a requirement, in the failure register, in answer to an intent
              (J132). The heading answers the intent instead, and the sentence
              below states what the step costs and what it does not do. */}
          <strong>{localDevice
            ? localDeviceStatus ? "Local Device · encrypted and offline" : "Keep this browser’s work on this device"
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
              ? localDeviceStatus?.message ?? "Creating it takes one step: Airship generates a recovery key, you save it, and the encrypted store opens. Nothing is enrolled until you save that key, and cancelling changes nothing. Conversations already in this tab are copied into the Vault when it opens; each one stays pinned to the storage it was started on, so they are continued from All conversations with Fork to continue rather than in place."
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
          <summary>{attachedSummary(prerequisites)}</summary>
          <ul>
            {prerequisites.map((row) => (
              /* Three states, not two: `"unknown"` must not paint an advisory
                 row in the caution colour reserved for a real shortfall. */
              <li key={row.label} data-attached={row.attached === "unknown" ? "unknown" : String(row.attached)}>
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
          leading={(option) => <span class="vault-provider-selector__mark" aria-hidden="true"><VaultBackendMark backend={option.value as VaultBackend} size={16} /></span>}
          options={PROVIDER_PROFILES.map((profile) => {
            // Availability is a selectability fact, not a description suffix.
            // Rendered as prose only, Drive stayed choosable on a build with no
            // client ID — and choosing it released the attached Vault before
            // anything asked whether the destination could be opened.
            const unopenable = providerUnopenableReason(profile.id);
            return {
              value: profile.id,
              label: profile.title,
              description: unopenable ?? profile.description,
              ...(unopenable ? { disabled: true } : {}),
            };
          })}
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
                    <span class="vault-provider-compare__heading"><VaultBackendMark backend={profile.id} size={15} />{profile.title}</span>
                    {profile.id === provider ? <small>Selected</small> : null}
                    {providerUnopenableReason(profile.id) ? <small>Unavailable here</small> : null}
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
          {runtimeAdopted && onDisconnect ? <VaultReleaseAction provider={provider} onDisconnect={onDisconnect} /> : null}
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
          </div>
          {onDisconnect ? <VaultReleaseAction provider={provider} onDisconnect={onDisconnect} /> : null}
        </>
      )}

      {provider === "ephemeral" && onEraseContinuityRecord ? (
        /*
         * The witness is a choice, not a condition.
         *
         * Ephemeral keeps one line per conversation in this browser so a return
         * can say "something was not kept" rather than showing a blank screen
         * that looks like a first visit. That is a real change to the contract a
         * privacy-first reader chose this posture for, so it is disclosed in
         * full above and erasable here, on the route where the posture lives,
         * without wiping anything else.
         */
        <section class="vault-danger" aria-label="Continuity record">
          <div class="vault-danger__copy">
            <strong>Continuity record</strong>
            <span>{EPHEMERAL_RETENTION_DISCLOSURE}</span>
          </div>
          <button
            class="vault-danger__action"
            type="button"
            onClick={() => { onEraseContinuityRecord(); setContinuityErased(true); }}
          >{continuityErased ? "Erased" : "Erase continuity record"}</button>
        </section>
      ) : null}

      {wipeAvailable && onWipeStorage ? (
        <section class="vault-danger" aria-label="Storage danger zone">
          <div class="vault-danger__copy">
            <strong>Wipe {PROVIDER_PROFILES.find((profile) => profile.id === provider)?.title ?? provider}</strong>
            <span>{wipeStorageNote(provider)}</span>
          </div>
          <button
            class="vault-danger__action"
            type="button"
            disabled={wipeBusy}
            aria-busy={wipeBusy || undefined}
            onClick={() => setWipeConfirmOpen(true)}
          >{wipeBusy ? "Wiping…" : "Wipe storage"}</button>
          {wipeConfirmOpen ? (
            <ConfirmDialog
              title={`Wipe ${PROVIDER_PROFILES.find((profile) => profile.id === provider)?.title ?? provider}?`}
              titleDetail={PROVIDER_PROFILES.find((profile) => profile.id === provider)?.description ?? ""}
              confirmLabel="Yes, wipe it"
              confirmDisabled={wipeBusy}
              destructive
              onCancel={() => setWipeConfirmOpen(false)}
              onConfirm={() => { setWipeConfirmOpen(false); onWipeStorage(); }}
            >
              <p>{wipeStorageConfirmNote(provider)}</p>
              <p>This cannot be undone.</p>
            </ConfirmDialog>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

/**
 * One handler, one name.
 *
 * `onDisconnect` is a single host callback — the shell passes exactly one
 * `disconnectVaultSafely` — and this route printed it as "Switch to ephemeral ·
 * keep a page copy" on Local Device and, 102 lines later, as "Disconnect ·
 * continue locally" on every other provider. Someone who learned the first went
 * looking for it on Drive and found a different verb for the same act, in the
 * failure grammar `vaultPhaseLabel` below deliberately reserves for a provider
 * that genuinely dropped. Neither label said what survives, so nobody could
 * tell whether "keep a page copy" also meant the Drive copy was gone. The
 * button carries the act; the provider-specific fact is the sentence beside it,
 * bound to the control by `aria-describedby` so a screen reader gets both.
 */
export const VAULT_RELEASE_ACTION_LABEL = "Switch to ephemeral · keep a page copy";

/** What actually survives the release, named per provider rather than per label. */
export function vaultReleaseNote(provider: VaultBackend): string {
  const page = "This page keeps working in memory until you close the tab.";
  const profile = PROVIDER_PROFILES.find((candidate) => candidate.id === provider);
  // A provider switch can leave the preference on `ephemeral` for a frame while
  // the old snapshot still renders. "Your encrypted Ephemeral data" would be a
  // sentence about a store that does not exist.
  return profile && provider !== "ephemeral"
    ? `${page} Your encrypted ${profile.title} data is left exactly where it is, and this route re-attaches it whenever you choose that provider again.`
    : `${page} No durable store is attached to release.`;
}

/*
 * The danger zone's language, one answer per destination, in the same order
 * this route always names things: what leaves, where from, what survives.
 */
function wipeStorageNote(provider: VaultBackend): string {
  if (provider === "ephemeral") {
    return "Forget everything held in this page's memory and reload it. Nothing is stored anywhere else — the page itself is the whole vault.";
  }
  if (provider === "local-device") {
    return "Delete every object in this device vault — conversations, workspace files, memories and profile state — from this browser only. Recovery key and re-enrollment stay with you.";
  }
  if (provider === "google-drive") {
    return "Empty the Airship namespace in the Google Drive folder that this vault profile owns — the Drive folder and permission stay, the vault contents go.";
  }
  return "Empty the Airship namespace in the bucket or store this vault profile owns — the endpoint and credentials stay, the vault contents go.";
}

function wipeStorageConfirmNote(provider: VaultBackend): string {
  if (provider === "ephemeral") {
    return "Reloading this page forgets every conversation, draft and intermediate state held in page memory right now. The page keeps no copy anywhere to come back to.";
  }
  if (provider === "local-device" || provider === "google-drive") {
    return "Every vault object is deleted for good. Airship keeps no recovery copies and this destination never exposed one either — the recovery you earlier exported is the only way any of this could come back.";
  }
  return "Every vault object is deleted for good. Nothing on this provider restores it afterwards, and Airship keeps no recovery copies.";
}

function VaultReleaseAction({ provider, onDisconnect }: Readonly<{ provider: VaultBackend; onDisconnect(): void }>) {
  const noteId = useId();
  return (
    <div class="vault-view__actions">
      <button type="button" class="vault-view__button--quiet" aria-describedby={noteId} onClick={onDisconnect}>
        {VAULT_RELEASE_ACTION_LABEL}
      </button>
      <small id={noteId}>{vaultReleaseNote(provider)}</small>
    </div>
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
 * itemised `What's attached (0 of 2)` rows below say which prerequisite is
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

/**
 * One prerequisite row.
 *
 * `attached` is three-valued because one prerequisite is not observable from
 * here: `"unknown"` means Airship cannot prove either way, so the row is
 * reported but never counted. A boolean forced that row to render as unmet
 * forever, which is the one thing this list must not do — see `attachedSummary`.
 */
export type AttachedRow = Readonly<{ label: string; value: string; attached: boolean | "unknown" }>;

/**
 * The prerequisites, itemised.
 *
 * "No endpoint, credential authority, or workspace key is attached." stays on
 * screen verbatim; this says which of them are missing, which is strictly
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
      // Custody of the one-time recovery value was never recorded, so an open
      // vault cannot certify "saved by you": the acknowledgement that hid the
      // key is page state, gone with the tab. `"unknown"`, not `false`: an
      // unprovable fact reported as unmet made a fully set-up device Vault sit
      // at a permanent shortfall, so a genuinely missing prerequisite would
      // have looked identical to the one that can never be satisfied.
      Object.freeze({
        label: "Recovery key",
        value: opened
          ? "Airship holds no copy — loss cannot be detected; confirm you can still find it"
          : "Shown once when you create the Vault, then never again",
        attached: "unknown" as const,
      }),
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
  return attachedRows(snapshot, localDeviceStatus, localDevice).filter((row) => row.attached === true).length;
}

/** "a, b and c" — no Oxford comma, matching the prerequisite sentence it replaced. */
function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]!}`;
}

/**
 * The disclosure's summary, phrased from the rows themselves.
 *
 * It was a literal: `(n of 3) — the device key, the object store and the
 * recovery key`. Two lies in one string. A Drive Vault itemises the endpoint,
 * the credential authority and the workspace key, so the enumeration named
 * three things that surface does not have; and the recovery key's custody is
 * unknowable, so a device Vault with everything enrolled was stuck at `2 of 3`,
 * naming a shortfall that can never close. A panel whose whole job is to say
 * which prerequisite is missing cannot carry a permanent one, or a real gap
 * reads the same as the standing one.
 *
 * So: the denominator is the countable rows, the enumeration is their labels,
 * and an unprovable row is named after the count as the advisory it is.
 */
export function attachedSummary(rows: readonly AttachedRow[]): string {
  const counted = rows.filter((row) => row.attached !== "unknown");
  const attached = counted.filter((row) => row.attached === true).length;
  const advisory = rows.filter((row) => row.attached === "unknown");
  const head = `What's attached (${attached} of ${counted.length}) — ${joinPhrases(counted.map((row) => `the ${row.label.toLowerCase()}`))}`;
  if (advisory.length === 0) return head;
  return `${head}; ${joinPhrases(advisory.map((row) => `the ${row.label.toLowerCase()}`))} only you can confirm`;
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
