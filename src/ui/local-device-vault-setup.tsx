import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { WorkspaceRootKey } from "../storage/encrypted-envelope";
import {
  importLocalDeviceWorkspaceRecoveryKey,
  openLocalDeviceWorkspaceKey,
  prepareLocalDeviceWorkspaceKeyEnrollment,
  type LocalDeviceWorkspaceKey,
  type LocalDeviceWorkspaceKeyEnrollment,
} from "../storage/local-device-keyring";
import { requestPersistentLocalDeviceStorage } from "../storage/local-device-object-store";
import type { LocalDeviceVaultStatus } from "../vault/local-device";
import { importWorkspaceRecoveryKey } from "../vault/recovery";
import { downloadBytes } from "./file-download";
import { Seal, type SealState } from "./seal";
import "./local-device-vault-setup.css";

export const LOCAL_DEVICE_BACKUP_MAX_FILE_BYTES = 256 * 1024 * 1024;

/** Whether the one-time key has left Airship, by the only two routes that exist. */
export type RecoveryCustody = "none" | "copied" | "downloaded";

/**
 * The custody line, in the one status family.
 *
 * Same three sentences as before. What changes is their weight: "Not copied or
 * downloaded yet." was `--ink-faint` micro text sitting directly above the one
 * control on this route that destroys a value permanently, which made the
 * quietest thing on screen the most consequential. `attention` is the honest
 * state for a one-time secret that has not left the page yet, and the seal puts
 * a mark and a colour behind the words rather than replacing them.
 */
export function recoveryCustodyStatus(custody: RecoveryCustody): Readonly<{ state: SealState; label: string }> {
  if (custody === "copied") return Object.freeze({ state: "verified" as SealState, label: "Copied to your clipboard." });
  if (custody === "downloaded") return Object.freeze({ state: "verified" as SealState, label: "Download requested." });
  return Object.freeze({ state: "attention" as SealState, label: "Not copied or downloaded yet." });
}

export type LocalDeviceActivationReason =
  | "opened"
  | "created"
  | "recovered"
  | "restored";

export type LocalDeviceAtomicRestoreRequest = Readonly<{
  partition: string;
  fileName: string;
  backup: Uint8Array;
  workspaceKey: WorkspaceRootKey;
  disposition: "open-existing" | "create-new";
  signal: AbortSignal;
}>;

export type LocalDeviceVaultSetupOperations = Readonly<{
  openExisting(partition: string): Promise<LocalDeviceWorkspaceKey | undefined>;
  beginEnrollment(partition: string): Promise<LocalDeviceWorkspaceKeyEnrollment>;
  importRecovery(partition: string, recoveryKey: string): Promise<LocalDeviceWorkspaceKey>;
  importRecoveryKey(recoveryKey: string): Promise<WorkspaceRootKey>;
  requestPersistentStorage(): Promise<"granted" | "not-granted" | "unsupported">;
}>;

export type LocalDeviceVaultSetupProps = Readonly<{
  partition: string;
  status?: LocalDeviceVaultStatus;
  /**
   * Adopts the opened runtime. No recovery string is passed through this
   * boundary; callers receive only a non-extractable workspace-key handle.
   */
  onActivate(
    key: LocalDeviceWorkspaceKey,
    reason: LocalDeviceActivationReason,
  ): void | Promise<void>;
  /**
   * Must close the adopted runtime, invoke restoreLocalDeviceVaultBackup, and
   * leave the target closed until this component calls onActivate.
   */
  onRestoreEncryptedBackup?(
    request: LocalDeviceAtomicRestoreRequest,
  ): Promise<Readonly<{ restored: number }>>;
  /** Returns ciphertext-only backup bytes from the currently open handle. */
  onExportEncryptedBackup?(): Promise<Uint8Array>;
  /**
   * Optional handle-bound persistence request. When omitted, the browser
   * StorageManager request is used directly from the button gesture.
   */
  onRequestPersistentStorage?(): Promise<"granted" | "not-granted" | "unsupported">;
  operations?: LocalDeviceVaultSetupOperations;
  backupFileName?: string;
  maxBackupFileBytes?: number;
}>;

type Operation =
  | "opening"
  | "preparing"
  | "creating"
  | "recovering"
  | "persisting"
  | "exporting"
  | "restoring";

type Notice = Readonly<{
  kind: "error" | "success" | "info";
  message: string;
}>;

const DEFAULT_OPERATIONS: LocalDeviceVaultSetupOperations = Object.freeze({
  openExisting: (partition) => openLocalDeviceWorkspaceKey({ partition }),
  beginEnrollment: (partition) => prepareLocalDeviceWorkspaceKeyEnrollment({ partition }),
  importRecovery: (partition, recoveryKey) =>
    importLocalDeviceWorkspaceRecoveryKey({ partition, recoveryKey }),
  importRecoveryKey: (recoveryKey) => importWorkspaceRecoveryKey(recoveryKey),
  requestPersistentStorage: () => requestPersistentLocalDeviceStorage(),
});

/**
 * Complete local-device custody and durability surface.
 *
 * Generated recovery material lives only inside LocalDeviceWorkspaceKeyEnrollment.
 * Imported material lives only in an uncontrolled, masked textarea and the
 * currently executing call frame. Neither value is placed in component state,
 * diagnostics, storage, or callback metadata.
 */
export function LocalDeviceVaultSetup({
  partition,
  status,
  onActivate,
  onRestoreEncryptedBackup,
  onExportEncryptedBackup,
  onRequestPersistentStorage,
  operations = DEFAULT_OPERATIONS,
  backupFileName,
  maxBackupFileBytes = LOCAL_DEVICE_BACKUP_MAX_FILE_BYTES,
}: LocalDeviceVaultSetupProps) {
  const enrollment = useRef<LocalDeviceWorkspaceKeyEnrollment>();
  const enrollmentGeneration = useRef(0);
  const mounted = useRef(true);
  const recoveryOutput = useRef<HTMLOutputElement>(null);
  const recoveryInput = useRef<HTMLTextAreaElement>(null);
  const restoreRecoveryInput = useRef<HTMLTextAreaElement>(null);
  const restoreFileInput = useRef<HTMLInputElement>(null);
  const restoreAbort = useRef<AbortController>();

  const ceremonyRegion = useRef<HTMLDivElement>(null);
  const commitButton = useRef<HTMLButtonElement>(null);

  const [operation, setOperation] = useState<Operation>();
  const [notice, setNotice] = useState<Notice>();
  const [ceremony, setCeremony] = useState<"idle" | "revealed" | "acknowledged">("idle");
  /**
   * Whether this key has left Airship yet, by the only two routes that exist.
   * It gates nothing — the acknowledgement is the user's to make — but a
   * one-time secret should never sit on screen next to a silent checkbox.
   */
  const [custody, setCustody] = useState<RecoveryCustody>("none");
  const [recoveryInputReady, setRecoveryInputReady] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File>();
  const [restoreRecoveryReady, setRestoreRecoveryReady] = useState(false);
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false);
  const [restoreDisposition, setRestoreDisposition] =
    useState<"open-existing" | "create-new">("open-existing");
  const busy = operation !== undefined;

  useEffect(() => () => {
    mounted.current = false;
    enrollmentGeneration.current += 1;
    restoreAbort.current?.abort(new DOMException("Local device Vault view closed.", "AbortError"));
    try {
      enrollment.current?.cancel();
    } catch {
      // A committing enrollment owns its crash-safe cleanup.
    }
    enrollment.current = undefined;
    clearSecretInput(recoveryInput.current);
    clearSecretInput(restoreRecoveryInput.current);
  }, []);

  // A one-time secret that renders 22px below a 900px fold has not been shown.
  // The measured defect was that the ceremony landed at y=922 with no scroll,
  // no focus move and no page-level signal, so the only visible change was the
  // button relabelling itself.
  useEffect(() => {
    if (ceremony === "revealed") {
      const region = ceremonyRegion.current;
      if (!region) return;
      region.scrollIntoView({ block: "center" });
      region.focus();
      return;
    }
    if (ceremony === "acknowledged") {
      // The checkbox that had focus unmounts with the revealed panel; without
      // a handoff focus drops to the document body mid-ceremony.
      commitButton.current?.focus();
    }
  }, [ceremony]);

  function finishOperation(): void {
    if (mounted.current) setOperation(undefined);
  }

  async function copyGeneratedRecovery(): Promise<void> {
    const prepared = enrollment.current;
    if (!prepared || ceremony !== "revealed") return;
    try {
      await navigator.clipboard.writeText(prepared.recoveryKey);
      setCustody("copied");
      setNotice({
        kind: "info",
        message: "Recovery key copied. Clipboard contents are outside Airship's control; paste it somewhere you keep, then acknowledge below.",
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message: publicError(error, "This browser refused clipboard access. Use Download recovery key, or select the value and copy it manually."),
      });
    }
  }

  function cancelEnrollment(): void {
    enrollmentGeneration.current += 1;
    try {
      enrollment.current?.cancel();
    } catch {
      // Commit has already crossed into the keyring and cannot be cancelled.
    }
    enrollment.current = undefined;
    setCeremony("idle");
    setCustody("none");
  }

  async function openExisting(): Promise<void> {
    if (busy) return;
    setOperation("opening");
    setNotice(undefined);
    try {
      const key = await operations.openExisting(partition);
      if (!key) {
        setNotice({
          kind: "info",
          message: "No browser-profile key is enrolled for this Vault. Create it once or recover it with the saved key.",
        });
        return;
      }
      await onActivate(key, "opened");
      if (mounted.current) {
        setNotice({ kind: "success", message: "Encrypted Local Device Vault opened." });
      }
    } catch (error) {
      if (mounted.current) setNotice({ kind: "error", message: publicError(error, "The Local Device Vault could not be opened.") });
    } finally {
      finishOperation();
    }
  }

  async function beginEnrollment(): Promise<void> {
    if (busy) return;
    cancelEnrollment();
    const generation = ++enrollmentGeneration.current;
    setOperation("preparing");
    setNotice(undefined);
    try {
      const prepared = await operations.beginEnrollment(partition);
      if (!mounted.current || generation !== enrollmentGeneration.current) {
        prepared.cancel();
        return;
      }
      enrollment.current = prepared;
      setCeremony("revealed");
    } catch (error) {
      if (mounted.current) setNotice({ kind: "error", message: publicError(error, "A recovery key could not be generated safely.") });
    } finally {
      finishOperation();
    }
  }

  function acknowledgeGeneratedRecovery(): void {
    if (!enrollment.current || ceremony !== "revealed") return;
    // Clear the live node before updating view state. There is no UI path that
    // reveals this material again.
    if (recoveryOutput.current) recoveryOutput.current.textContent = "";
    setCeremony("acknowledged");
    setNotice({
      kind: "info",
      message: "Recovery key hidden. Finish creation to enroll this browser profile.",
    });
  }

  async function commitEnrollment(): Promise<void> {
    const prepared = enrollment.current;
    if (!prepared || ceremony !== "acknowledged" || busy) return;
    setOperation("creating");
    setNotice(undefined);
    let committed = false;
    try {
      const key = await prepared.commit({ recoveryKeySavedAcknowledged: true });
      committed = true;
      enrollment.current = undefined;
      if (mounted.current) setCeremony("idle");
      await onActivate(key, "created");
      if (mounted.current) {
        setNotice({ kind: "success", message: "Encrypted Local Device Vault created and ready offline." });
      }
    } catch (error) {
      enrollment.current = undefined;
      if (mounted.current) {
        setCeremony("idle");
        setNotice({
          kind: "error",
          message: publicError(
            error,
            committed
              ? "The Vault was enrolled, but its runtime could not be activated. Open it again."
              : "Creation did not finish. Keep the recovery key you saved and try Recover existing before starting a different ceremony.",
          ),
        });
      }
    } finally {
      finishOperation();
    }
  }

  async function recoverExisting(): Promise<void> {
    if (busy) return;
    const input = recoveryInput.current;
    const recoveryKey = input?.value.trim() ?? "";
    clearSecretInput(input);
    setRecoveryInputReady(false);
    if (!recoveryKey) {
      setNotice({ kind: "error", message: "Paste the saved Airship recovery key first." });
      return;
    }
    setOperation("recovering");
    setNotice(undefined);
    try {
      const key = await operations.importRecovery(partition, recoveryKey);
      await onActivate(key, "recovered");
      if (mounted.current) {
        setNotice({ kind: "success", message: "Recovery key authenticated. This browser profile is enrolled." });
      }
    } catch (error) {
      if (mounted.current) {
        setNotice({
          kind: "error",
          message: publicError(error, "The recovery key did not authenticate this Local Device Vault."),
        });
      }
    } finally {
      finishOperation();
    }
  }

  async function requestPersistence(): Promise<void> {
    if (busy) return;
    setOperation("persisting");
    setNotice(undefined);
    try {
      const result = await (onRequestPersistentStorage ?? operations.requestPersistentStorage)();
      if (!mounted.current) return;
      setNotice({
        kind: result === "granted" ? "success" : "info",
        message: persistenceCopy(result),
      });
    } catch (error) {
      if (mounted.current) setNotice({ kind: "error", message: publicError(error, "Persistent-storage permission could not be requested.") });
    } finally {
      finishOperation();
    }
  }

  async function exportBackup(): Promise<void> {
    if (busy || !onExportEncryptedBackup) return;
    setOperation("exporting");
    setNotice(undefined);
    let bytes: Uint8Array | undefined;
    try {
      bytes = await onExportEncryptedBackup();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new Error("The active Vault returned an empty encrypted backup.");
      }
      downloadBytes(bytes, safeBackupFileName(backupFileName), "application/vnd.airship.vault-backup+json");
      if (mounted.current) {
        setNotice({
          kind: "success",
          message: `Encrypted backup prepared (${formatLocalDeviceBytes(bytes.byteLength)}). The recovery key is not inside it.`,
        });
      }
    } catch (error) {
      if (mounted.current) setNotice({ kind: "error", message: publicError(error, "The encrypted backup could not be exported.") });
    } finally {
      bytes?.fill(0);
      finishOperation();
    }
  }

  async function downloadGeneratedRecovery(): Promise<void> {
    const prepared = enrollment.current;
    if (!prepared || ceremony !== "revealed" || busy) return;
    const bytes = new TextEncoder().encode(`${prepared.recoveryKey}\n`);
    try {
      downloadBytes(bytes, "airship-local-device-recovery-key.txt", "text/plain;charset=utf-8");
      setCustody("downloaded");
      setNotice({
        kind: "info",
        message: "Recovery key download requested. Verify that you saved it, then acknowledge below.",
      });
    } catch (error) {
      setNotice({ kind: "error", message: publicError(error, "The recovery key download could not be started.") });
    } finally {
      bytes.fill(0);
    }
  }

  async function restoreBackup(): Promise<void> {
    if (
      busy
      || !onRestoreEncryptedBackup
      || !restoreFile
      || !restoreAcknowledged
    ) return;
    const input = restoreRecoveryInput.current;
    const recoveryKey = input?.value.trim() ?? "";
    clearSecretInput(input);
    setRestoreRecoveryReady(false);
    if (!recoveryKey) {
      setNotice({ kind: "error", message: "Paste the recovery key for this encrypted backup first." });
      return;
    }

    const file = restoreFile;
    const disposition = restoreDisposition;
    setRestoreFile(undefined);
    setRestoreAcknowledged(false);
    if (restoreFileInput.current) restoreFileInput.current.value = "";
    const controller = new AbortController();
    restoreAbort.current = controller;
    setOperation("restoring");
    setNotice(undefined);
    let backup: Uint8Array | undefined;
    let restoreCommitted = false;

    try {
      let key: LocalDeviceWorkspaceKey | undefined;
      let workspaceKey: WorkspaceRootKey;
      if (disposition === "open-existing") {
        // Authenticate the current authority and install/compare the key handle
        // before the destructive callback is allowed to run.
        key = await operations.importRecovery(partition, recoveryKey);
        workspaceKey = key.key;
      } else {
        const existing = await operations.openExisting(partition);
        const imported = await operations.importRecoveryKey(recoveryKey);
        if (existing && !await equivalentWorkspaceKeys(existing.key, imported, partition)) {
          throw new Error("The recovery key conflicts with this browser profile's enrolled key.");
        }
        // Object storage can be evicted independently of the non-extractable
        // keyring handle. Reuse a proved-equivalent handle so an empty-authority
        // restore remains possible without weakening key authentication.
        key = existing;
        workspaceKey = existing?.key ?? imported;
      }

      backup = await readBoundedLocalDeviceBackup(file, maxBackupFileBytes, controller.signal);
      const result = await onRestoreEncryptedBackup({
        partition,
        fileName: boundedFileName(file.name),
        backup,
        workspaceKey,
        disposition,
        signal: controller.signal,
      });
      restoreCommitted = true;

      // A fresh-origin restore installs the non-extractable browser-profile
      // handle only after the backup authenticated and committed atomically.
      key ??= await operations.importRecovery(partition, recoveryKey);
      await onActivate(key, "restored");
      if (mounted.current) {
        setNotice({
          kind: "success",
          message: `Atomic restore verified ${result.restored.toLocaleString()} encrypted object${result.restored === 1 ? "" : "s"}.`,
        });
      }
    } catch (error) {
      if (mounted.current) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        setNotice({
          kind: restoreCommitted ? "error" : aborted ? "info" : "error",
          message: restoreCommitted
            ? `The encrypted backup was restored, but browser key custody or runtime activation did not finish. ${
                publicError(error, "Keep the recovery key and open the Vault again.")
              }`
            : aborted
            ? "Restore cancelled before completion."
            : publicError(error, "The backup failed authentication. The existing Vault was not replaced."),
        });
      }
    } finally {
      backup?.fill(0);
      if (restoreAbort.current === controller) restoreAbort.current = undefined;
      finishOperation();
    }
  }

  return (
    <section class="local-device-vault" aria-labelledby="local-device-vault-title">
      {/* One row, not a second title block. The eyebrow and the subtitle
          sentence moved to the provider comparison on this same route, where
          they are read at the moment the provider is chosen rather than after
          it. `Device-owned durability` survives as this row's qualifier. */}
      <header class="local-device-vault__header">
        <h2 id="local-device-vault-title">Local Device Vault</h2>
        <p class="local-device-vault__eyebrow">Device-owned durability</p>
        <span data-ready={status ? "true" : "false"}>{status ? "Ready" : "Not opened"}</span>
      </header>

      {ceremony === "revealed" ? (
        <p class="local-device-vault__ceremony-alert" role="status">
          A one-time recovery key is on screen — save it before leaving this page.
        </p>
      ) : null}

      {status ? null : (
        <div class="local-device-vault__setup">
          <div class="local-device-vault__choice">
            <div>
              <strong>Open this browser’s Vault</strong>
              <span>Use the enrolled non-extractable key. No prompt or secret is required.</span>
            </div>
            <button type="button" onClick={() => void openExisting()} disabled={busy}>
              {operation === "opening" ? "Opening…" : "Open existing"}
            </button>
          </div>

          <div class="local-device-vault__choice">
            <div>
              <strong>Create a new Vault</strong>
              <span>Generate one recovery key before the first encrypted object is committed.</span>
            </div>
            <button type="button" class="local-device-vault__secondary" data-vault-create onClick={() => void beginEnrollment()} disabled={busy}>
              {operation === "preparing" ? "Preparing…" : ceremony === "idle" ? "Create new" : "Replace ceremony"}
            </button>
          </div>

          {ceremony !== "idle" ? (
            <div
              class="local-device-vault__ceremony"
              data-state={ceremony}
              ref={ceremonyRegion}
              tabIndex={-1}
              /* Focus is moved here when the ceremony opens, so this element's
                 own name is what gets announced — and a name on a generic div
                 is dropped. `group` is the smallest role that keeps it. */
              role="group"
              aria-labelledby="local-device-ceremony-title"
            >
              <div>
                <p class="local-device-vault__eyebrow">One-time recovery</p>
                <strong id="local-device-ceremony-title">{ceremony === "revealed" ? "Save this key now" : "Recovery key hidden"}</strong>
              </div>
              {ceremony === "revealed" && enrollment.current ? (
                <>
                  {/* The value is one string; the groups are spans with a
                      layout gap, so it stays transcribable in fours without a
                      separator character entering its text content. */}
                  <output
                    ref={recoveryOutput}
                    aria-label="One-time Local Device recovery key"
                    aria-describedby="local-device-recovery-warning"
                  >
                    <RecoveryKeyGroups value={enrollment.current.recoveryKey} />
                  </output>
                  <p id="local-device-recovery-warning">
                    Airship does not upload or persist this value. Losing both it and this browser profile means losing the Vault.
                  </p>
                  <div class="local-device-vault__actions">
                    <button type="button" onClick={() => void copyGeneratedRecovery()}>
                      Copy key
                    </button>
                    <button type="button" class="local-device-vault__secondary" onClick={() => void downloadGeneratedRecovery()}>
                      Download recovery key
                    </button>
                    <button type="button" class="local-device-vault__quiet" onClick={cancelEnrollment}>
                      Cancel
                    </button>
                  </div>
                  <p class="local-device-vault__custody" data-custody={custody}>
                    <Seal {...recoveryCustodyStatus(custody)} density="chip" />
                  </p>
                  <label class="local-device-vault__check">
                    <input type="checkbox" onChange={(event) => {
                      if (event.currentTarget.checked) acknowledgeGeneratedRecovery();
                    }} />
                    <span>I saved this recovery key outside Airship and understand it cannot be shown again.</span>
                  </label>
                </>
              ) : (
                <>
                  <p>The recovery value is no longer rendered. Creation is the only remaining step.</p>
                  {/* The one screen where a misunderstanding loses data
                      permanently, and until now its last words were "the only
                      remaining step" — which reads as "there is no way back"
                      to the person who ticked the box before saving the key.
                      There is a way back, right here, and it is only safe
                      while nothing has been enrolled. Say so. */}
                  <p class="local-device-vault__escape">
                    Did not save it? Cancel. Nothing is enrolled until you create, and a new ceremony issues a different key.
                  </p>
                  <div class="local-device-vault__actions">
                    <button type="button" ref={commitButton} onClick={() => void commitEnrollment()} disabled={busy}>
                      {operation === "creating" ? "Creating…" : "Create encrypted Vault"}
                    </button>
                    <button type="button" class="local-device-vault__quiet" onClick={cancelEnrollment} disabled={busy}>
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          <details class="local-device-vault__recover">
            <summary>Recover an existing Vault</summary>
            <div>
              <p>Recovery authenticates the Vault before enrolling this browser profile.</p>
              <textarea
                ref={recoveryInput}
                class="local-device-vault__secret"
                rows={3}
                maxLength={128}
                placeholder="Paste airship-wrk-v1.…"
                aria-label="Local Device Vault recovery key"
                autoComplete="off"
                autoCapitalize="none"
                spellcheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                onInput={(event) => setRecoveryInputReady(event.currentTarget.value.trim().length > 0)}
              />
              <button type="button" onClick={() => void recoverExisting()} disabled={busy || !recoveryInputReady}>
                {operation === "recovering" ? "Authenticating…" : "Recover and open"}
              </button>
            </div>
          </details>
        </div>
      )}

      {status ? (
        <div class="local-device-vault__durability">
          <article>
            <div>
              <p class="local-device-vault__eyebrow">Browser retention</p>
              <strong>Reduce eviction risk</strong>
              <span>Permission is requested only from this click. Browser policy remains authoritative.</span>
            </div>
            <button type="button" class="local-device-vault__secondary" onClick={() => void requestPersistence()} disabled={busy}>
              {operation === "persisting" ? "Requesting…" : "Request persistent storage"}
            </button>
          </article>

          {onExportEncryptedBackup ? (
            <article>
              <div>
                <p class="local-device-vault__eyebrow">Portable ciphertext</p>
                <strong>Download encrypted backup</strong>
                <span>Includes the encrypted object inventory, never the recovery key.</span>
              </div>
              <button type="button" class="local-device-vault__secondary" onClick={() => void exportBackup()} disabled={busy}>
                {operation === "exporting" ? "Preparing…" : "Download backup"}
              </button>
            </article>
          ) : null}
        </div>
      ) : null}

      {onRestoreEncryptedBackup ? (
        <details class="local-device-vault__restore">
          <summary>Restore encrypted backup</summary>
          <div>
            <div class="local-device-vault__restore-intro">
              <strong>Verified atomic replacement</strong>
              <p>The complete file and recovery key must authenticate before the selected Vault can be replaced.</p>
            </div>
            <label>
              <span>Encrypted Airship backup</span>
              <input
                ref={restoreFileInput}
                type="file"
                accept=".airship-vault,.json,application/vnd.airship.vault-backup+json"
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.item(0) ?? undefined;
                  setRestoreFile(file);
                  setRestoreAcknowledged(false);
                }}
              />
              <small>Maximum {formatLocalDeviceBytes(maxBackupFileBytes)}. Files are bounded before parsing.</small>
            </label>
            <label>
              <span>Recovery key for this backup</span>
              <textarea
                ref={restoreRecoveryInput}
                class="local-device-vault__secret"
                rows={3}
                maxLength={128}
                placeholder="Paste airship-wrk-v1.…"
                autoComplete="off"
                autoCapitalize="none"
                spellcheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                disabled={busy}
                onInput={(event) => {
                  setRestoreRecoveryReady(event.currentTarget.value.trim().length > 0);
                  setRestoreAcknowledged(false);
                }}
              />
            </label>
            <fieldset>
              <legend>Restore target</legend>
              <label>
                <input
                  type="radio"
                  name="local-device-restore-target"
                  value="open-existing"
                  checked={restoreDisposition === "open-existing"}
                  disabled={busy}
                  onChange={() => {
                    setRestoreDisposition("open-existing");
                    setRestoreAcknowledged(false);
                  }}
                />
                <span><strong>Replace current Vault</strong><small>The recovery key must authenticate its existing identity.</small></span>
              </label>
              <label>
                <input
                  type="radio"
                  name="local-device-restore-target"
                  value="create-new"
                  checked={restoreDisposition === "create-new"}
                  disabled={busy}
                  onChange={() => {
                    setRestoreDisposition("create-new");
                    setRestoreAcknowledged(false);
                  }}
                />
                <span><strong>Restore into empty browser storage</strong><small>Fails if this profile has a different enrolled key or any existing object authority; an enrolled key matching this backup is reused.</small></span>
              </label>
            </fieldset>
            <label class="local-device-vault__check local-device-vault__restore-ack">
              <input
                type="checkbox"
                checked={restoreAcknowledged}
                disabled={busy || !restoreFile || !restoreRecoveryReady}
                onChange={(event) => setRestoreAcknowledged(event.currentTarget.checked)}
              />
              <span>I understand a successful restore atomically replaces every encrypted object in the selected Local Device Vault.</span>
            </label>
            <div class="local-device-vault__actions">
              <button
                type="button"
                onClick={() => void restoreBackup()}
                disabled={busy || !restoreFile || !restoreRecoveryReady || !restoreAcknowledged}
              >
                {operation === "restoring" ? "Verifying and restoring…" : "Verify and restore"}
              </button>
              {operation === "restoring" ? (
                <button
                  type="button"
                  class="local-device-vault__quiet"
                  onClick={() => restoreAbort.current?.abort(new DOMException("Restore cancelled by user.", "AbortError"))}
                >
                  Cancel restore
                </button>
              ) : null}
            </div>
          </div>
        </details>
      ) : null}

      {notice ? (
        <p class={`local-device-vault__notice local-device-vault__notice--${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} aria-live="polite">
          {notice.message}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The recovery key, grouped in fours so it can be transcribed and checked.
 *
 * Grouping is layout, never content: the spans carry no separator character,
 * so `output.textContent` is still the exact key a caller pastes back in.
 *
 * The Drive and loopback panels render the identical markup from their own
 * deferred pack. This file is one of exactly five separately budgeted
 * local-storage packs (`scripts/release-gate.mjs:1088`), so importing across
 * that boundary would pull device custody into every Drive connection.
 */
function RecoveryKeyGroups({ value }: Readonly<{ value: string }>): JSX.Element {
  const separator = value.indexOf(".");
  const prefix = separator >= 0 ? value.slice(0, separator + 1) : "";
  const body = separator >= 0 ? value.slice(separator + 1) : value;
  const groups: string[] = [];
  for (let index = 0; index < body.length; index += 4) groups.push(body.slice(index, index + 4));
  return (
    <>
      {prefix ? <span class="recovery-key__prefix">{prefix}</span> : null}
      {groups.map((group, index) => <span class="recovery-key__group" key={`${index}:${group}`}>{group}</span>)}
    </>
  );
}

export async function readBoundedLocalDeviceBackup(
  file: Blob,
  maxBytes = LOCAL_DEVICE_BACKUP_MAX_FILE_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Local Device backup byte limit is invalid.");
  }
  if (file.size <= 0) throw new Error("The selected encrypted backup is empty.");
  if (file.size > maxBytes) {
    throw new Error(`The selected encrypted backup exceeds ${formatLocalDeviceBytes(maxBytes)}.`);
  }
  signal?.throwIfAborted();
  const output = new Uint8Array(file.size);
  const reader = file.stream().getReader();
  let offset = 0;
  const abort = () => { void reader.cancel(signal?.reason); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > output.byteLength) {
        throw new Error("The selected encrypted backup changed while it was being read.");
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
    signal?.throwIfAborted();
    if (offset !== output.byteLength) {
      throw new Error("The selected encrypted backup was truncated while it was being read.");
    }
    return output;
  } catch (error) {
    output.fill(0);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function formatLocalDeviceBytes(value: number): string {
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

function persistenceCopy(result: "granted" | "not-granted" | "unsupported"): string {
  switch (result) {
    case "granted":
      return "Persistent storage granted for this origin.";
    case "not-granted":
      return "The browser kept storage under its normal eviction policy. Encrypted backup remains recommended.";
    case "unsupported":
      return "This browser does not expose a persistent-storage request. Encrypted backup remains available.";
  }
}

function clearSecretInput(input: HTMLTextAreaElement | null): void {
  if (!input) return;
  input.value = "";
}

function safeBackupFileName(value: string | undefined): string {
  const supplied = value?.trim();
  if (
    supplied
    && supplied.length <= 120
    && !/[\\/\u0000-\u001f\u007f]/u.test(supplied)
  ) {
    return supplied.endsWith(".airship-vault") ? supplied : `${supplied}.airship-vault`;
  }
  return `airship-local-device-${new Date().toISOString().slice(0, 10)}.airship-vault`;
}

function boundedFileName(value: string): string {
  const name = value.trim();
  if (!name) return "encrypted-backup.airship-vault";
  return name.slice(0, 240).replace(/[\u0000-\u001f\u007f]/gu, "\uFFFD");
}

function publicError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  return message && message.length <= 500 && !/airship-wrk-v1\./iu.test(message)
    ? message
    : fallback;
}

async function equivalentWorkspaceKeys(
  left: WorkspaceRootKey,
  right: WorkspaceRootKey,
  partition: string,
): Promise<boolean> {
  const context = `airship/local-device-restore-key-equivalence/v1\0${partition}`;
  const [leftCommitment, rightCommitment] = await Promise.all([
    left.opaqueObjectId(context),
    right.opaqueObjectId(context),
  ]);
  return leftCommitment === rightCommitment;
}
