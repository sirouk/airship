import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import type { GoogleIdentityServicesAuthorizer, MemoryOnlyGoogleAccessTokenProvider } from "../storage/google-drive-auth";
import type { ConfigureGoogleDriveVaultRequest } from "../vault";
import type { JSX } from "preact";
import type { WorkspaceRecoveryMaterial } from "../vault/recovery";
import "./google-drive-setup.css";

/**
 * The recovery key, grouped in fours so it can be transcribed and checked.
 *
 * Grouping is layout, never content: the spans carry no separator character,
 * so `output.textContent` is still the exact key a caller pastes back in.
 *
 * It lives here rather than in a shared module because the Local Device panel
 * is one of exactly five separately budgeted local-storage packs
 * (`scripts/release-gate.mjs:1088`); importing across that boundary would make
 * a Google Drive connection download the whole device-custody surface. The
 * loopback S3 panel ships in this same deferred pack, so it imports it.
 */
export function RecoveryKeyGroups({ value }: Readonly<{ value: string }>): JSX.Element {
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

export function GoogleDriveSetup({ onConfigure }: Readonly<{
  onConfigure(request: ConfigureGoogleDriveVaultRequest): void;
}>) {
  const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ?? "";
  const [folderName, setFolderName] = useState("Airship Workspace");
  const [recovery, setRecovery] = useState<WorkspaceRecoveryMaterial>();
  const [importedRecovery, setImportedRecovery] = useState("");
  const [showImportedRecovery, setShowImportedRecovery] = useState(false);
  const [saved, setSaved] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const authorityHandedOff = useRef(false);
  const session = useMemo(() => ({ current: undefined as undefined | {
    provider: MemoryOnlyGoogleAccessTokenProvider;
    authorizer: GoogleIdentityServicesAuthorizer;
  } }), []);

  useEffect(() => {
    if (!clientId) return;
    let current = true;
    void loadDeferredCapabilities().then(async (capabilities) => {
      const provider = new capabilities.MemoryOnlyGoogleAccessTokenProvider();
      const authorizer = new capabilities.GoogleIdentityServicesAuthorizer(clientId, provider);
      session.current = { provider, authorizer };
      await authorizer.prepare();
      if (current) setPrepared(true);
    }).catch(() => current && setStatus(
      "Google sign-in could not be prepared. Check this deployment’s Google client ID and script policy, then retry.",
    ));
    return () => {
      current = false;
      // After a successful handoff the coordinator owns credential cleanup.
      // Resetting here would revoke the page-memory token between configure
      // and the mandatory live probe as this setup surface unmounts.
      if (!authorityHandedOff.current) session.current?.authorizer.reset();
      session.current = undefined;
    };
  }, [clientId, session]);

  async function generateRecovery(): Promise<void> {
    recovery?.clear();
    const capabilities = await loadDeferredCapabilities();
    setRecovery(await capabilities.WorkspaceRecoveryMaterial.generate());
    setImportedRecovery("");
    setShowImportedRecovery(false);
    setSaved(false);
  }

  function recoverExisting(): void {
    recovery?.clear();
    setRecovery(undefined);
    setImportedRecovery("");
    setShowImportedRecovery(false);
    setSaved(false);
    setStatus(undefined);
  }

  async function connect(): Promise<void> {
    const preparedSession = session.current;
    if (!preparedSession || !prepared) { setStatus("Google sign-in is not ready yet."); return; }
    if (!recovery && !importedRecovery.trim()) { setStatus("Generate or import the workspace recovery key first."); return; }
    if (recovery && !saved) { setStatus("Confirm that the one-time recovery key is saved before connecting."); return; }
    setBusy(true);
    setStatus("Waiting for Google account consent…");
    try {
      const capabilities = await loadDeferredCapabilities();
      const workspaceKey = recovery?.workspaceKey ?? await capabilities.importWorkspaceRecoveryKey(importedRecovery);
      await preparedSession.authorizer.authorize({ selectAccount: true });
      setStatus("Opening the encrypted Airship workspace in Google Drive…");
      const identity = await capabilities.readGoogleAccountIdentity(preparedSession.provider);
      const manager = new capabilities.GoogleDriveWorkspaceManager(preparedSession.provider, workspaceKey);
      const workspace = recovery
        ? await manager.connectOrCreate(folderName)
        : await manager.connectExisting();
      const store = new capabilities.GoogleDriveObjectStore({
        tokenProvider: preparedSession.provider,
        workspace,
        workspaceKey,
      });
      authorityHandedOff.current = true;
      try {
        onConfigure(Object.freeze({
          workspace,
          store,
          workspaceKey,
          accountLabel: identity.email,
          // The coordinator retains this closure with the active direct store.
          // It invokes GIS only from a later Vault click/tap and replaces the
          // expiring access token in the same memory-only provider.
          reauthorize: async () => { await preparedSession.authorizer.reauthorize(); },
          reset: () => preparedSession.authorizer.reset(),
        }));
      } catch (error) {
        authorityHandedOff.current = false;
        throw error;
      }
      recovery?.clear();
      setRecovery(undefined);
      setImportedRecovery("");
      setShowImportedRecovery(false);
      setStatus(`Connected ${identity.email}. Live storage verification is next.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Google Drive connection failed safely.");
    } finally {
      setBusy(false);
    }
  }

  return <section class="google-drive-setup" data-available={clientId ? "true" : "false"} aria-labelledby="google-drive-setup-title">
    <header>
      <h2 id="google-drive-setup-title">Connect your Google Drive</h2>
      {clientId ? <p class="google-drive-setup__eyebrow">Recommended durability</p> : null}
      <span data-state={clientId ? "ready" : "unavailable"}>{clientId ? "Browser → Drive" : "Unavailable in this build"}</span>
    </header>
    {/* A build with no OAuth client cannot open a Drive folder, so it does not
        claim it can. The capability sentence renders only where it is true. */}
    {clientId
      ? <p>Airship creates a visible folder in your Drive and stores only client-encrypted manifests and segments. Google never receives the workspace key.</p>
      : <p>This deployment has no Google OAuth client ID, so Airship cannot open a Drive workspace. Your data is not affected: nothing has been sent to Google, and no vault state has changed.</p>}
    {!clientId ? <>
      <div class="google-drive-setup__actions">
        <button type="button" onClick={() => {
          const provider = document.querySelector<HTMLElement>(".vault-provider-selector button");
          provider?.scrollIntoView({ block: "center" });
          provider?.focus();
        }}>Choose another provider</button>
      </div>
      <details class="google-drive-setup__deploy">
        <summary>For the person deploying Airship — the exact build variable this needs</summary>
        <div class="google-drive-setup__notice" role="alert">
          Set <code>VITE_GOOGLE_CLIENT_ID</code> to a Google OAuth Web client ID, enable the Drive API, and allow this page origin.
        </div>
      </details>
    </> : <>
      {recovery ? <label>New workspace folder<input value={folderName} maxLength={120} onInput={(event) => setFolderName(event.currentTarget.value)} /></label> : <div class="google-drive-setup__notice">
        <strong>Recover an existing workspace</strong>
        <p>Airship discovers the app-created folder from the key after Google account selection. A wrong account or key fails closed and never creates a blank replacement.</p>
      </div>}
      <div class="google-drive-setup__key">
        <strong>Workspace recovery</strong>
        <p>This key—not your Google account—decrypts the vault. Save it once so another device can open the same workspace.</p>
        {/* Starting a new workspace is the first-run path, so its control leads
            the block rather than trailing the paste box as a grey afterthought. */}
        <div class="google-drive-setup__recovery-actions">
          <button type="button" onClick={() => void generateRecovery()} disabled={busy}>{recovery ? "Generate a different key" : "Create a new workspace"}</button>
          {recovery ? <button type="button" class="google-drive-setup__secondary" onClick={recoverExisting} disabled={busy}>Recover existing instead</button> : null}
        </div>
        {recovery ? <>
          <output><RecoveryKeyGroups value={recovery.displayValue} /></output>
          <label class="google-drive-setup__check"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.currentTarget.checked)} /> I saved this recovery key</label>
        </> : <>
          <textarea
            class={showImportedRecovery ? "" : "google-drive-setup__masked"}
            value={importedRecovery}
            onInput={(event) => setImportedRecovery(event.currentTarget.value.slice(0, 128))}
            placeholder="Paste an existing airship-wrk-v1… key"
            rows={3}
            maxLength={128}
            autoComplete="off"
            autoCapitalize="none"
            spellcheck={false}
            data-lpignore="true"
            data-1p-ignore="true"
            aria-label="Existing Airship recovery key"
          />
          <label class="google-drive-setup__check"><input type="checkbox" checked={showImportedRecovery} onChange={(event) => setShowImportedRecovery(event.currentTarget.checked)} /> Show imported recovery key</label>
        </>}
      </div>
      <div class="google-drive-setup__actions">
        <button type="button" onClick={() => void connect()} disabled={!prepared || busy}>{busy ? "Connecting…" : prepared ? recovery ? "Create with Google Drive" : "Recover with Google Drive" : "Preparing Google sign-in…"}</button>
      </div>
    </>}
    {status && <p class="google-drive-setup__status" role="status">{status}</p>}
    <small>OAuth tokens remain in page memory. Airship requests <code>drive.file</code>, not access to your whole Drive.</small>
  </section>;
}
