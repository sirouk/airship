import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { chutesOAuthLocationState } from "../auth/chutes-oauth";
import {
  CHUTES_CAPABILITY_MATRIX,
  connectionCapabilities,
  connectionLabel,
  createChutesConnection,
  isChutesConnected,
  parseChutesCredential,
  type ActiveChutesConnection,
  type ChutesConnection,
  type ChutesCredentialKind,
  type EphemeralChutesCredential,
} from "../auth/connection";
import {
  CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY,
  ChutesInferenceTransport,
  createChutesAttestationGate,
  type ChutesInvocationTelemetry,
} from "../inference/chutes";
import {
  ModelCatalogClient,
  filterModels,
  selectModel,
  type AirshipModel,
  type ModelCatalogIssue,
  type ModelSourceState,
} from "../models";
import { Icon } from "./icons";
import { mapUnknownRequestFailure } from "./request-state";
import { ModelPicker } from "./model-picker";
import { OFFLINE_INLINE_REASON } from "./connectivity";
import "./access-view.css";

export type AccessConnectRequest = Readonly<{
  connection: ActiveChutesConnection;
  credential: string;
  transport: ChutesInferenceTransport;
  model: AirshipModel;
  models: readonly AirshipModel[];
}>;

export type AccessViewProps = Readonly<{
  connection: ChutesConnection;
  online: boolean;
  onConnect: (request: AccessConnectRequest) => Promise<void>;
  onDisconnect: () => Promise<void>;
  models?: readonly AirshipModel[];
  onSelectModel?: (modelId: string) => Promise<void>;
  connectionActive?: boolean;
  onUseConnection?: () => Promise<void>;
  onInvocationTelemetry?: (telemetry: ChutesInvocationTelemetry) => void;
  oauthNotice?: Readonly<{
    tone: "neutral" | "warning" | "error";
    message: string;
  }>;
  oauthDiagnostic?: Readonly<{
    homepageUrl: string;
    callbackUrl: string;
    scopes: readonly string[];
    exchangeMode: "local-confidential-bridge" | "public-pkce";
    configurationError?: string;
    onRun: () => Promise<void>;
  }>;
  oauthBootstrap?: Readonly<{
    revision: number;
    takeCredential: () => string | undefined;
    getBearerToken: () => string | Promise<string>;
  }>;
  /** Lazily loaded provider-neutral cloud and local inference connections. */
  additionalProviders?: ComponentChildren;
}>;

type Candidate = Readonly<{
  credentialKind: ChutesCredentialKind;
  models: readonly AirshipModel[];
  fetchedAt: string;
  sourceComplete: boolean;
  managementState: ModelSourceState;
  issues: readonly ModelCatalogIssue[];
  recommendedModelId?: string;
}>;

export function AccessView({
  connection,
  online,
  onConnect,
  onDisconnect,
  models = [],
  onSelectModel,
  connectionActive = false,
  onUseConnection,
  onInvocationTelemetry,
  oauthNotice,
  oauthDiagnostic,
  oauthBootstrap,
  additionalProviders,
}: AccessViewProps) {
  const localOAuthBridge = oauthDiagnostic?.exchangeMode === "local-confidential-bridge";
  const credentialInput = useRef<HTMLInputElement>(null);
  const ephemeralCredential = useRef<EphemeralChutesCredential>();
  const ephemeralTokenSource = useRef<(() => string | Promise<string>)>();
  const candidateTransport = useRef<ChutesInferenceTransport>();
  const discoveryAbort = useRef<AbortController>();
  const [candidate, setCandidate] = useState<Candidate>();
  const [modelId, setModelId] = useState("");
  const [detectedKind, setDetectedKind] = useState<ChutesCredentialKind>();
  const [strictProof, setStrictProof] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [oauthDiagnosticError, setOauthDiagnosticError] = useState<string>();

  function clearEphemeral() {
    discoveryAbort.current?.abort(new DOMException("Model discovery was cleared.", "AbortError"));
    discoveryAbort.current = undefined;
    candidateTransport.current?.revokeCredential(
      new DOMException("Candidate Chutes credential was cleared.", "AbortError"),
    );
    ephemeralCredential.current = undefined;
    ephemeralTokenSource.current = undefined;
    candidateTransport.current = undefined;
  }

  useEffect(() => () => clearEphemeral(), []);

  useEffect(() => {
    if (!isChutesConnected(connection)) return;
    clearEphemeral();
    setCandidate(undefined);
    setDetectedKind(undefined);
    setStrictProof(false);
  }, [connection.kind]);

  function inspectInput() {
    const value = credentialInput.current?.value ?? "";
    if (!value.trim()) {
      setDetectedKind(undefined);
      return;
    }
    try {
      setDetectedKind(parseChutesCredential(value).kind);
    } catch {
      setDetectedKind(undefined);
    }
  }

  async function discoverCredential(
    rawCredential: string,
    tokenSource?: () => string | Promise<string>,
  ) {
    if (!online) {
      setStatus(undefined);
      setError(OFFLINE_INLINE_REASON);
      return;
    }
    const input = credentialInput.current;
    setBusy(true);
    setStatus("Discovering encrypted-inference models available to this connection…");
    setError(undefined);
    setCandidate(undefined);
    clearEphemeral();
    const controller = new AbortController();
    discoveryAbort.current = controller;
    try {
      const credential = parseChutesCredential(rawCredential);
      if (credential.kind === "oauth-user-token" && !tokenSource) {
        throw new Error("Use Chutes sign-in for a scoped user session. The advanced field accepts only an optional cpk_ inference key.");
      }
      const catalogClient = new ModelCatalogClient({ includeManagement: true, timeoutMs: 20_000 });
      const snapshot = await catalogClient.load({ signal: controller.signal, forceRefresh: true });
      const compatibleModels = filterModels(snapshot.models, {
        confidentialCompute: "required",
        requireE2eeCandidate: true,
        inputModalities: ["text"],
        outputModalities: ["text"],
      });
      if (compatibleModels.length === 0) {
        throw new Error("Chutes returned no text-in/text-out models explicitly eligible for encrypted confidential-compute invocation.");
      }
      const selection = selectModel(snapshot.models);
      const transport = new ChutesInferenceTransport({
        apiKey: tokenSource ?? credential.value,
        // Evidence is always acquired and evaluated. Ordinary encrypted chat
        // remains available when one independent verifier can only establish a
        // partial claim; the receipt—not this connection setting—decides which
        // per-turn TEE claims may be promoted.
        attestationMode: "optional",
        attestationGate: createChutesAttestationGate({
          getBearerToken: async () => (tokenSource ? await tokenSource() : credential.value),
        }),
        onInvocationTelemetry,
      });
      ephemeralCredential.current = credential;
      ephemeralTokenSource.current = tokenSource;
      candidateTransport.current = transport;
      if (input) input.value = "";
      setCandidate(Object.freeze({
        credentialKind: credential.kind,
        models: compatibleModels,
        fetchedAt: snapshot.fetchedAt,
        sourceComplete: snapshot.complete,
        managementState: snapshot.sources.management,
        issues: snapshot.issues,
        ...(selection.model ? { recommendedModelId: selection.model.id } : {}),
      }));
      setModelId(selection.model?.id ?? compatibleModels[0]!.id);
      setDetectedKind(credential.kind);
      setStrictProof(false);
      setStatus(`${compatibleModels.length} encrypted-inference candidate${compatibleModels.length === 1 ? "" : "s"} found. Catalog metadata is not proof. Finish verifies selected-model authorization and arms fresh per-turn evidence collection.`);
    } catch (caught) {
      clearEphemeral();
      if (input) input.value = "";
      setDetectedKind(undefined);
      setStatus(undefined);
      setError(mapUnknownRequestFailure(caught, online).message);
      if (input) requestAnimationFrame(() => input.focus());
    } finally {
      if (discoveryAbort.current === controller) discoveryAbort.current = undefined;
      setBusy(false);
    }
  }

  async function discover() {
    const input = credentialInput.current;
    if (!input) return;
    await discoverCredential(input.value);
  }

  useEffect(() => {
    if (!online || !oauthBootstrap || isChutesConnected(connection)) return;
    const credential = oauthBootstrap.takeCredential();
    if (!credential) return;
    void discoverCredential(credential, oauthBootstrap.getBearerToken);
  }, [oauthBootstrap?.revision, connection.kind, online]);

  async function activate() {
    const credential = ephemeralCredential.current;
    const discoveryTransport = candidateTransport.current;
    const tokenSource = ephemeralTokenSource.current;
    const model = candidate?.models.find((item) => item.id === modelId);
    if (!credential || !discoveryTransport || !candidate || !model) return;
    setBusy(true);
    const controller = new AbortController();
    discoveryAbort.current = controller;
    setStatus("Verifying chutes:invoke access and encrypted endpoint availability…");
    setError(undefined);
    try {
      await discoveryTransport.verifyModelAccess(model.id, controller.signal);
      const transport = strictProof
        ? new ChutesInferenceTransport({
            apiKey: tokenSource ?? credential.value,
            attestationMode: "required",
            attestationGate: createChutesAttestationGate({
              getBearerToken: async () => (tokenSource ? await tokenSource() : credential.value),
            }),
            onInvocationTelemetry,
          })
        : discoveryTransport;
      if (transport !== discoveryTransport) {
        discoveryTransport.revokeCredential(
          new DOMException("The strict-proof Chutes transport replaced discovery.", "AbortError"),
        );
        candidateTransport.current = transport;
      }
      const nextConnection = createChutesConnection({
        credentialKind: credential.kind,
        model: model.id,
        posture: transport.posture,
      });
      await onConnect({
        connection: nextConnection,
        credential: credential.value,
        transport,
        model,
        models: candidate.models,
      });
      // Ownership moved into App. Do not let candidate cleanup revoke the
      // committed authority.
      candidateTransport.current = undefined;
      clearEphemeral();
      setCandidate(undefined);
      setDetectedKind(undefined);
      setStrictProof(false);
      setStatus(undefined);
    } catch (caught) {
      clearEphemeral();
      setCandidate(undefined);
      setDetectedKind(undefined);
      setStrictProof(false);
      setStatus(undefined);
      setError(mapUnknownRequestFailure(caught, online).message);
      requestAnimationFrame(() => credentialInput.current?.focus());
    } finally {
      if (discoveryAbort.current === controller) discoveryAbort.current = undefined;
      setBusy(false);
    }
  }

  async function enrichCatalog() {
    if (!candidate || busy || !online) return;
    const prior = candidate;
    const controller = new AbortController();
    discoveryAbort.current?.abort(new DOMException("A newer catalog request started.", "AbortError"));
    discoveryAbort.current = controller;
    setBusy(true);
    setStatus("Loading optional Chutes availability and TEE deployment metadata…");
    setError(undefined);
    try {
      const snapshot = await new ModelCatalogClient({ includeManagement: true, timeoutMs: 25_000 }).load({
        signal: controller.signal,
        forceRefresh: true,
      });
      const models = filterModels(snapshot.models, {
        confidentialCompute: "required",
        requireE2eeCandidate: true,
        inputModalities: ["text"],
        outputModalities: ["text"],
      });
      if (models.length === 0) throw new Error("The enriched catalog contained no compatible encrypted text-generation candidates.");
      const selection = selectModel(snapshot.models);
      setCandidate(Object.freeze({
        ...prior,
        models,
        fetchedAt: snapshot.fetchedAt,
        sourceComplete: snapshot.complete,
        managementState: snapshot.sources.management,
        issues: snapshot.issues,
        ...(selection.model ? { recommendedModelId: selection.model.id } : {}),
      }));
      if (!models.some((model) => model.id === modelId)) setModelId(selection.model?.id ?? models[0]!.id);
      setStatus(snapshot.sources.management === "fresh"
        ? "Live availability and TEE deployment claims loaded. These remain metadata, not attestation proof."
        : "The fast inference catalog remains usable; optional management enrichment was unavailable.");
    } catch (caught) {
      setStatus(undefined);
      setError(mapUnknownRequestFailure(caught, online).message);
    } finally {
      if (discoveryAbort.current === controller) discoveryAbort.current = undefined;
      setBusy(false);
    }
  }

  function chooseDifferentCredential() {
    clearEphemeral();
    setCandidate(undefined);
    setDetectedKind(undefined);
    setStrictProof(false);
    setStatus(undefined);
    setError(undefined);
    requestAnimationFrame(() => credentialInput.current?.focus());
  }

  async function clearConnection(focusInput: boolean) {
    setBusy(true);
    setStatus(focusInput ? "Clearing the active connection before switching…" : "Clearing the active connection…");
    setError(undefined);
    try {
      await onDisconnect();
      clearEphemeral();
      setStatus(undefined);
      if (focusInput) requestAnimationFrame(() => credentialInput.current?.focus());
    } catch (caught) {
      setStatus(undefined);
      setError(mapUnknownRequestFailure(caught, online).message);
    } finally {
      setBusy(false);
    }
  }

  async function selectActiveModel(modelId: string) {
    if (!onSelectModel) return;
    setBusy(true);
    setStatus("Creating a new model-pinned session…");
    setError(undefined);
    try {
      await onSelectModel(modelId);
      setStatus("Model changed in a new pinned session; prior history remains intact.");
    } catch (caught) {
      setStatus(undefined);
      setError(mapUnknownRequestFailure(caught, online).message);
    } finally {
      setBusy(false);
    }
  }

  async function useConnectedChutes() {
    if (!onUseConnection) return;
    setBusy(true);
    setStatus("Creating a new Chutes-pinned conversation…");
    setError(undefined);
    try {
      await onUseConnection();
      setStatus("Chutes is active in a new pinned conversation; prior history remains intact.");
    } catch (caught) {
      setStatus(undefined);
      setError(mapUnknownRequestFailure(caught, online).message);
    } finally {
      setBusy(false);
    }
  }

  const capabilities = connectionCapabilities(connection);
  const selectedCandidateModel = candidate?.models.find((model) => model.id === modelId);
  const oauthOrigin = oauthDiagnostic
    ? oauthDiagnostic.configurationError
      ? { available: false, reason: oauthDiagnostic.configurationError }
      : oauthOriginState(oauthDiagnostic.homepageUrl, typeof window === "undefined" ? "" : window.location.href)
    : { available: false, reason: "OAuth registration details are unavailable in this build." };

  return (
    <section class="access-connection-view" aria-labelledby="access-connection-title">
      <header class="access-connection-heading">
        <span>Inference connections</span>
        <h1 id="access-connection-title">Connect models</h1>
        <p>Use Chutes for application-encrypted inference, or connect browser-direct cloud and local models below. Credentials remain in page memory.</p>
        <nav class="access-provider-jump" aria-label="Choose an inference provider">
          <a href="#chutes-connection-card"><Icon name="lock" size={15} />Chutes · encrypted</a>
          {additionalProviders ? <a href="#additional-inference-providers"><Icon name="model" size={15} />Other cloud &amp; local models</a> : null}
        </nav>
      </header>

      <div class="access-connection-layout">
        <section id="chutes-connection-card" class="access-connection-card" aria-labelledby="active-connection-title">
          <div class="access-section-heading">
            <div>
              <span>Chutes connection</span>
              <h2 id="active-connection-title">{connectionLabel(connection)}</h2>
            </div>
            <ConnectionBadge connection={connection} />
          </div>

          {!online ? (
            <p class="access-network-pause" role="status" aria-live="polite">
              <Icon name="warning" size={16} />{OFFLINE_INLINE_REASON}
            </p>
          ) : null}

          {isChutesConnected(connection) ? (
            <div class="active-connection-summary">
              <dl>
                <div><dt>Credential class</dt><dd>{connection.kind === "chutes-oauth" ? "Chutes sign-in · scoped user session" : "Chutes API key · direct session"}</dd></div>
                <div>
                  <dt>Model</dt>
                  <dd>
                    {models.length > 0 && onSelectModel ? (
                      <ModelPicker
                        value={connection.model}
                        models={models}
                        disabled={busy || models.length < 2}
                        onSelect={(modelId) => void selectActiveModel(modelId)}
                      />
                    ) : connection.model}
                  </dd>
                </div>
                <div><dt>Proof policy</dt><dd>{connection.posture === "encrypted-attested" ? "Strict · block unless every required endpoint claim verifies" : "Verify and record fresh evidence · keep unverified claims explicit"}</dd></div>
                <div><dt>Inference authorization</dt><dd>{connection.invokeAuthorization === "verified" ? `Verified by protected request${connection.lastInvokeAt ? ` · ${formatCatalogTime(connection.lastInvokeAt)}` : ""}` : "Not tested yet"}</dd></div>
                <div><dt>Credential lifetime</dt><dd>Not introspected</dd></div>
                <div><dt>Storage</dt><dd>Page memory only</dd></div>
              </dl>
              <p class="model-pinning-note"><Icon name="proof" size={15} />Changing a model creates a new session manifest. Airship never rewrites the provider or model bound to prior turns.</p>
              <div class="active-connection-actions">
                {!connectionActive && onUseConnection ? (
                  <button class="primary" type="button" onClick={() => void useConnectedChutes()} disabled={busy}>
                    Use Chutes in new conversation
                  </button>
                ) : null}
                <button type="button" onClick={() => void clearConnection(true)} disabled={busy}>Switch credential</button>
                <button class="danger" type="button" onClick={() => void clearConnection(false)} disabled={busy}>Clear connection</button>
              </div>
            </div>
          ) : candidate ? (
            <div class="connection-candidate">
              {candidate.credentialKind === "oauth-user-token" ? (
                <div class="oauth-finish-banner" role="status" aria-live="polite">
                  <Icon name="proof" size={18} />
                  <div>
                    <strong>Chutes sign-in complete · finish connection</strong>
                    <span>Choose the session model and finish. No second credential or attestation waiver is required.</span>
                  </div>
                </div>
              ) : null}
              <div class="credential-kind-result" role="status">
                <Icon name={candidate.credentialKind === "oauth-user-token" ? "access" : "lock"} size={20} />
                <div>
                  <strong>{credentialKindLabel(candidate.credentialKind)}</strong>
                  <span>{credentialKindDetail(candidate.credentialKind)}</span>
                </div>
              </div>
              <label>
                <span>Model {modelId === candidate.recommendedModelId ? "· privacy-first recommendation" : ""}</span>
                <ModelPicker value={modelId} models={candidate.models} onSelect={setModelId} disabled={busy} />
              </label>
              {selectedCandidateModel ? <ModelCandidateSummary model={selectedCandidateModel} /> : null}
              <div class="catalog-provenance">
                <span><Icon name="proof" size={14} />Catalog read {formatCatalogTime(candidate.fetchedAt)}</span>
                <span class={candidate.sourceComplete ? "complete" : "partial"}>{candidate.managementState === "fresh" ? "Inference + management metadata loaded" : candidate.sourceComplete ? "Authoritative inference catalog · management enrichment deferred" : "Partial provider metadata"}</span>
                {candidate.managementState === "disabled" ? <button type="button" onClick={() => void enrichCatalog()} disabled={busy || !online}>Load live availability metadata</button> : null}
                {candidate.issues.length > 0 ? (
                  <details><summary>{candidate.issues.length} catalog notice{candidate.issues.length === 1 ? "" : "s"}</summary>{candidate.issues.map((issue, index) => <p key={`${issue.source}-${issue.code}-${index}`}>{issue.source}: {issue.message}</p>)}</details>
                ) : null}
              </div>
              <fieldset class="proof-policy-consent">
                <legend>Turn proof policy</legend>
                <button type="button" class={!strictProof ? "selected" : ""} aria-pressed={!strictProof} onClick={() => setStrictProof(false)}>
                  <span><strong>Verify &amp; record</strong><small>Recommended. Evaluate still-current endpoint evidence before every turn and refresh it when needed; leave incomplete CPU or GPU claims visibly unverified without breaking encrypted chat.</small></span>
                </button>
                <button
                  type="button"
                  class={strictProof ? "selected" : ""}
                  aria-pressed={strictProof}
                  disabled={!CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available}
                  title={CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.reason}
                  onClick={() => {
                    if (CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available) setStrictProof(true);
                  }}
                >
                  <span>
                    <strong>Strict fail-closed · unavailable</strong>
                    <small>{CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.reason} Verify &amp; record still evaluates current evidence before every turn and refreshes it when needed.</small>
                  </span>
                </button>
                <p>This policy is not proof. Completed receipts record only what the browser actually verified.</p>
              </fieldset>
              <div class="candidate-actions">
                <button type="button" onClick={chooseDifferentCredential} disabled={busy}>Use a different credential</button>
                <button class="primary" type="button" onClick={() => void activate()} disabled={busy}>Finish: verify &amp; connect</button>
              </div>
            </div>
          ) : (
            <div class="connection-entry-stack">
              <section class="oauth-primary-entry" aria-labelledby="oauth-primary-title">
                <Icon name="access" size={22} />
                <div>
                  <strong id="oauth-primary-title">Chutes sign-in · scoped user session</strong>
                  <p>{localOAuthBridge
                    ? "Recommended for this local lab. The browser creates the S256 PKCE request; the same-origin loopback bridge completes the registered confidential exchange. Its client secret never enters browser JavaScript."
                    : "Recommended. Connect profile, billing, and inference through Authorization Code + S256 PKCE with a Chutes app registered for public-client token exchange."}</p>
                  <button
                    class="primary"
                    type="button"
                    disabled={busy || !oauthDiagnostic || !online || !oauthOrigin.available}
                    onClick={() => {
                      setOauthDiagnosticError(undefined);
                      void oauthDiagnostic?.onRun().catch((caught) => setOauthDiagnosticError(errorMessage(caught)));
                    }}
                  >
                    Continue to Chutes
                  </button>
                  {!oauthOrigin.available ? <p class="oauth-primary-reason" role="status">{oauthOrigin.reason}</p> : null}
                  {oauthDiagnosticError ? <p class="oauth-boundary-status error" role="alert">{oauthDiagnosticError}</p> : null}
                  {oauthNotice?.tone === "error" ? <p class="oauth-boundary-status error" role="alert">{oauthNotice.message}</p> : null}
                </div>
              </section>

              <details class="api-key-alternative">
                <summary>Advanced: use a Chutes API key instead</summary>
                <form class="credential-entry" onSubmit={(event) => { event.preventDefault(); void discover(); }}>
                  <div class="credential-types" aria-label="Optional Chutes API-key connection">
                    <CredentialTypeCard prefix="cpk_" title="Chutes API key" detail="Direct models, inference, profile, and account reads when Chutes authorizes them." active={detectedKind === "inference-api-key"} />
                  </div>
                  <label for="chutes-credential-input">
                    <span>Chutes API key</span>
                    <input
                      ref={credentialInput}
                      id="chutes-credential-input"
                      name="chutes-api-key"
                      type="password"
                      inputMode="text"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellcheck={false}
                      placeholder="cpk_…"
                      aria-describedby="chutes-credential-help"
                      onInput={inspectInput}
                      disabled={busy}
                    />
                  </label>
                  <p id="chutes-credential-help">Held only in page memory. Airship uses the key directly for models, inference, profile, and account reads that Chutes authorizes. Never paste a client secret or administrator credential.</p>
                  <button type="submit" disabled={busy || !online}>Discover models with key</button>
                </form>
              </details>
            </div>
          )}

          {status ? <p class="access-live-status" role="status" aria-live="polite"><span />{status}</p> : null}
          {error ? <p class="access-live-error" role="alert"><Icon name="warning" size={16} />{error}</p> : null}
        </section>

        <details class="access-connection-card capability-card">
          <summary><span>Connection methods</span><strong id="capability-matrix-title">Compare capabilities</strong></summary>
          <div class="capability-table-wrap">
            <table>
              <thead><tr><th scope="col">Capability</th><th scope="col">Sign-in eligible</th><th scope="col">Key eligible</th><th scope="col">Active method</th></tr></thead>
              <tbody>
                {CHUTES_CAPABILITY_MATRIX.map((row) => (
                  <tr key={row.capability}>
                    <th scope="row"><strong>{row.label}</strong><span>{row.detail}</span></th>
                    <td><CapabilityMark available={row.oauth} /></td>
                    <td><CapabilityMark available={row.apiKey} /></td>
                    <td><CapabilityMark available={capabilities[row.capability]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="capability-caveat"><Icon name="proof" size={16} />These are credential-class eligibility rules, not observed grants. Protected invocation and account reads report their own provider-authoritative result.</p>
        </details>
      </div>

      <aside class="oauth-browser-boundary">
        <Icon name="lock" size={19} />
        <div>
          <strong>{localOAuthBridge ? "Local OAuth bridge boundary" : "Public-client OAuth boundary"}</strong>
          <p>{localOAuthBridge
            ? "The localhost bridge is only a development token handler. It receives the one-time authorization code and PKCE verifier, adds the process-held client secret, and returns the provider token response without persisting it. Access and rotating refresh tokens remain in this page's memory."
            : "The client ID is public. A one-time PKCE verifier survives only the authorization redirect; access and rotating refresh tokens remain in this page's memory. Directory visibility is a separate provider setting."}</p>
          {oauthNotice ? <p class={`oauth-boundary-status ${oauthNotice.tone}`} role={oauthNotice.tone === "error" ? "alert" : "status"}>{oauthNotice.message}</p> : null}
          {oauthDiagnostic ? (
            <details class="oauth-diagnostic">
              <summary>Registration details</summary>
              <p>{localOAuthBridge
                ? <>The registered callback must match exactly. This localhost app remains a confidential <code>client_secret_post</code> registration; only the loopback bridge performs the exchange.</>
                : <>The registered callback must match exactly, and the Chutes app must be a Browser/native PKCE client with token endpoint authentication set to <code>none</code>.</>}</p>
              <dl>
                <div><dt>Homepage</dt><dd>{oauthDiagnostic.homepageUrl}</dd></div>
                <div><dt>Callback</dt><dd>{oauthDiagnostic.callbackUrl}</dd></div>
                <div><dt>Scopes</dt><dd>{oauthDiagnostic.scopes.join(" · ")}</dd></div>
              </dl>
              <button
                type="button"
                disabled={!online}
                onClick={() => {
                  setOauthDiagnosticError(undefined);
                  void oauthDiagnostic.onRun().catch((caught) => setOauthDiagnosticError(errorMessage(caught)));
                }}
              >
                Start sign-in again
              </button>
            </details>
          ) : null}
        </div>
      </aside>
      {additionalProviders ? (
        <div id="additional-inference-providers" class="access-additional-providers" aria-label="Additional cloud and local inference providers">
          {additionalProviders}
        </div>
      ) : null}
    </section>
  );
}

function ConnectionBadge({ connection }: { connection: ChutesConnection }) {
  const active = isChutesConnected(connection);
  const label = !active ? "Disconnected" : connection.invokeAuthorization === "verified" ? "Invocation verified" : "Configured";
  return <span class={active ? "connection-badge active" : "connection-badge"}><span />{label}</span>;
}

function CredentialTypeCard({
  prefix,
  title,
  detail,
  active,
}: {
    prefix: "cpk_";
  title: string;
  detail: string;
  active: boolean;
}) {
  return <div class={active ? "credential-type active" : "credential-type"}><code>{prefix}</code><strong>{title}</strong><span>{detail}</span></div>;
}

function CapabilityMark({ available }: { available: boolean }) {
  return <span class={available ? "capability-mark available" : "capability-mark"} aria-label={available ? "Available" : "Unavailable"}>{available ? "✓" : "—"}</span>;
}

function credentialKindLabel(kind: ChutesCredentialKind): string {
  return kind === "oauth-user-token" ? "Chutes sign-in · scoped user session" : "Chutes API key · direct session";
}

function credentialKindDetail(kind: ChutesCredentialKind): string {
  return kind === "oauth-user-token"
    ? "Account and read-only billing surfaces can be requested in addition to inference."
    : "Profile, billing, and inference are read directly; Chutes remains authoritative.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Chutes connection could not be established.";
}

export function oauthOriginState(homepageUrl: string, currentOrigin: string): Readonly<{ available: boolean; reason?: string }> {
  return chutesOAuthLocationState(homepageUrl, currentOrigin);
}

function ModelCandidateSummary({ model }: { model: AirshipModel }) {
  const context = model.contextTokens ?? model.maxModelTokens;
  return (
    <div class="model-candidate-summary">
      <div><span>Availability</span><strong>{model.availability}</strong><small>{model.provenance.availability === "unavailable" ? "live status unavailable" : "provider management snapshot"}</small></div>
      <div><span>Context</span><strong>{context ? formatCompactNumber(context) : "unknown"}</strong><small>{model.maxOutputTokens ? `${formatCompactNumber(model.maxOutputTokens)} max output` : "output limit unavailable"}</small></div>
      <div><span>Input / output</span><strong>{formatModelPrice(model.pricing.input.usdPerMillion)} / {formatModelPrice(model.pricing.output.usdPerMillion)}</strong><small>USD per million tokens</small></div>
      <div><span>Trust readiness</span><strong>{model.trust.consistency === "conflict" ? "metadata conflict" : "evidence candidate"}</strong><small>verification remains {model.trust.verification}</small></div>
    </div>
  );
}

function modelOptionLabel(model: AirshipModel, recommendedModelId?: string): string {
  const markers = [
    model.id === recommendedModelId ? "recommended" : undefined,
    model.availability === "hot" ? "hot" : undefined,
    model.contextTokens ? `${formatCompactNumber(model.contextTokens)} ctx` : undefined,
  ].filter((value): value is string => Boolean(value));
  return markers.length > 0 ? `${model.id} — ${markers.join(" · ")}` : model.id;
}

function formatModelPrice(value: number | undefined): string {
  if (value === undefined) return "unknown";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatCatalogTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "time unavailable";
}
