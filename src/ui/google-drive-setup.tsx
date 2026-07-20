import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { loadDeferredCapabilities } from "../load-deferred-capabilities";
import type { GoogleIdentityServicesAuthorizer, MemoryOnlyGoogleAccessTokenProvider } from "../storage/google-drive-auth";
import type { ConfigureGoogleDriveVaultRequest } from "../vault";
import type { LocalLabRecoveryMaterial } from "../vault/local-lab";
import "./google-drive-setup.css";

export function GoogleDriveSetup({ onConfigure }: Readonly<{
  onConfigure(request: ConfigureGoogleDriveVaultRequest): void;
}>) {
  const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ?? "";
  const [folderName, setFolderName] = useState("Airship Workspace");
  const [recovery, setRecovery] = useState<LocalLabRecoveryMaterial>();
  const [importedRecovery, setImportedRecovery] = useState("");
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
    }).catch((error) => current && setStatus(error instanceof Error ? error.message : "Google sign-in could not be prepared."));
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
    setRecovery(await capabilities.LocalLabRecoveryMaterial.generate());
    setImportedRecovery("");
    setSaved(false);
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
      const workspaceKey = recovery?.workspaceKey ?? await capabilities.importLocalLabRecoveryKey(importedRecovery);
      await preparedSession.authorizer.authorize({ selectAccount: true });
      setStatus("Opening the encrypted Airship workspace in Google Drive…");
      const identity = await capabilities.readGoogleAccountIdentity(preparedSession.provider);
      const manager = new capabilities.GoogleDriveWorkspaceManager(preparedSession.provider, workspaceKey);
      const workspace = await manager.connectOrCreate(folderName);
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
          reset: () => preparedSession.authorizer.reset(),
        }));
      } catch (error) {
        authorityHandedOff.current = false;
        throw error;
      }
      recovery?.clear();
      setRecovery(undefined);
      setImportedRecovery("");
      setStatus(`Connected ${identity.email}. Live storage verification is next.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Google Drive connection failed safely.");
    } finally {
      setBusy(false);
    }
  }

  return <section class="google-drive-setup" aria-labelledby="google-drive-setup-title">
    <header>
      <div><p class="vault-view__eyebrow">Recommended durability</p><h2 id="google-drive-setup-title">Connect your Google Drive</h2></div>
      <span>Browser → Drive</span>
    </header>
    <p>Airship creates a visible folder in your Drive and stores only client-encrypted manifests and segments. Google never receives the workspace key.</p>
    {!clientId ? <div class="google-drive-setup__notice" role="alert">
      Set <code>VITE_GOOGLE_CLIENT_ID</code> to a Google OAuth Web client ID, enable the Drive API, and allow this page origin.
    </div> : <>
      <label>Workspace folder<input value={folderName} maxLength={120} onInput={(event) => setFolderName(event.currentTarget.value)} /></label>
      <div class="google-drive-setup__key">
        <strong>Workspace recovery</strong>
        <p>This key—not your Google account—decrypts the vault. Save it once so another device can open the same workspace.</p>
        {recovery ? <>
          <output>{recovery.displayValue}</output>
          <label class="google-drive-setup__check"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.currentTarget.checked)} /> I saved this recovery key</label>
        </> : <textarea value={importedRecovery} onInput={(event) => setImportedRecovery(event.currentTarget.value)} placeholder="Paste an existing airship-wrk-v1… key, or generate a new one" rows={3} />}
        <button type="button" class="google-drive-setup__secondary" onClick={() => void generateRecovery()} disabled={busy}>{recovery ? "Generate a different key" : "Generate new recovery key"}</button>
      </div>
      <button type="button" onClick={() => void connect()} disabled={!prepared || busy}>{busy ? "Connecting…" : prepared ? "Continue with Google" : "Preparing Google sign-in…"}</button>
    </>}
    {status && <p class="google-drive-setup__status" role="status">{status}</p>}
    <small>OAuth tokens remain in page memory. Airship requests <code>drive.file</code>, not access to your whole Drive.</small>
  </section>;
}
