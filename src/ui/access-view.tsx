import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
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
import { probeExtensionBridge, type ExtensionBridgeObservation } from "../capabilities/extension-bridge";
import { ConnectSurface, type LocalProviderProbeResult } from "./connect/connect-surface";
import {
  connectLaneCountLabel,
  connectLaneCountSeal,
  describeConnectLanes,
  type ConnectLaneInput,
} from "./connect/connect-lanes";
import { observeHostExtensionSupport } from "./connect/extension-bridge-presence";
import { Popover } from "./popover";
import { RouteHeader } from "./route-header";
import { Seal } from "./seal";
import "./access-view.css";

/**
 * The page paragraph, verbatim, with the one word the layout falsified.
 *
 * It said "below", and after the jump nav and the second heading block were
 * removed there is no below — the lanes are here. Moving a sentence one rung
 * down the ladder is allowed; leaving it pointing at something that no longer
 * exists is not.
 */
const CONNECT_ROUTE_DESCRIPTION = "Use Chutes for application-encrypted inference, or connect browser-direct cloud and local models here. Credentials remain in page memory.";
/** The Providers paragraph, verbatim, from the heading block this replaces. */
const CONNECT_PROVIDERS_NOTE = "Everything else in Airship — workspace, editor, terminal and Git — already works without this. Only chat needs a model, and connecting one never closes the others.";
/** The `ONE, OR SEVERAL AT ONCE` eyebrow, as the sentence its own count proves. */
const CONNECT_COUNT_NOTE = "Connect one, or several at once. Connecting one never closes the others.";

/** Where a Chutes personal key is created. Named on every key surface. */
export const CHUTES_ACCOUNT_URL = "https://chutes.ai/app";

/** Loopback providers whose fabric ids the connect surface names in plain words. */
const LOCAL_PROVIDER_LABELS: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze(["ollama", "Ollama"] as const),
  Object.freeze(["lm-studio", "LM Studio"] as const),
]);

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
  /**
   * How this view observes the extension bridge. It runs once per mount and
   * the lanes render only what it returns, so presence is consumed rather than
   * assumed: the default is the bridge package's own `hello` exchange, and the
   * seam exists so a harness can supply a different observer, never so a caller
   * can supply a *result*. Nothing is remembered across page loads.
   */
  observeExtensionBridge?: () => Promise<ExtensionBridgeObservation>;
  /**
   * Issues the real Ollama/LM Studio loopback probe for the Local lane. Passed
   * in because reading the provider fabric here would merge its transports into
   * this chunk and dissolve a release-gate pack boundary.
   */
  onCheckLocalProviders?: () => Promise<readonly LocalProviderProbeResult[]>;
  /** Codex (OpenAI) sign-in, when this build wires the paste-back exchange. */
  codexSignIn?: Readonly<{
    /** Opens the vendor tab. Resolves when the tab opened, not when signed in. */
    onStart: () => Promise<void>;
    /** Exchanges the code the person pasted back. */
    onSubmitCode: (code: string, state?: string) => Promise<void>;
  }>;
  /** Published extension install page, when this build has one. */
  extensionInstallUrl?: string;
  /**
   * Provider ids holding a live page-memory connection right now, read from the
   * inference fabric by the host.
   *
   * Passed in rather than read here so this view keeps no static dependency on
   * the fabric module: that import merges the fabric's provider transports into
   * the deferred-capabilities chunk and dissolves a release-gate pack boundary.
   * An absent list is an empty list, which can only under-claim.
   */
  connectedProviderIds?: readonly string[];
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
  observeExtensionBridge = probeExtensionBridge,
  onCheckLocalProviders,
  codexSignIn,
  extensionInstallUrl,
  connectedProviderIds = [],
}: AccessViewProps) {
  const publishedExtensionInstallUrl = extensionInstallUrl
    ?? (import.meta.env.VITE_AIRSHIP_EXTENSION_INSTALL_URL as string | undefined)?.trim()
    ?? `${import.meta.env.BASE_URL}extension/index.html`;
  const localOAuthHandler = oauthDiagnostic?.exchangeMode === "local-confidential-bridge";
  const oauthNoticeMessage = oauthNotice ? presentOAuthNotice(oauthNotice.message) : "";
  const credentialInput = useRef<HTMLInputElement>(null);
  const ephemeralCredential = useRef<EphemeralChutesCredential>();
  const ephemeralTokenSource = useRef<(() => string | Promise<string>)>();
  const candidateTransport = useRef<ChutesInferenceTransport>();
  const discoveryAbort = useRef<AbortController>();
  const [candidate, setCandidate] = useState<Candidate>();
  const [modelId, setModelId] = useState("");
  const [detectedKind, setDetectedKind] = useState<ChutesCredentialKind>();
  const [strictProof, setStrictProof] = useState(false);
  const [chutesMethod, setChutesMethod] = useState<"oauth" | "api-key">("oauth");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [oauthDiagnosticError, setOauthDiagnosticError] = useState<string>();
  // `undefined` until the handshake settles. There is no "last known" arm, so
  // an unfinished observation can only render as "checking" — never as absence,
  // and never as a presence carried over from an earlier load.
  const [bridge, setBridge] = useState<ExtensionBridgeObservation>();
  // Recomputed from the host's live list on every render, so a lane can never
  // claim a connection that was released.
  const connectedProviders = useMemo(
    () => new Set(connectedProviderIds),
    [connectedProviderIds.join("\u0000")],
  );

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

  async function beginChutesSignIn(): Promise<void> {
    if (!oauthDiagnostic) return;
    if (localOAuthHandler) {
      let response: Response;
      try {
        response = await fetch("/__airship/chutes/oauth/token", {
          method: "GET",
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        throw new Error("The local Chutes OAuth handler is unavailable. Restart the Airship lab with its OAuth registration configured.");
      }
      if (response.status === 503) {
        throw new Error("The local Chutes OAuth handler is not configured. Restart the Airship lab with its process-held client secret.");
      }
      if (response.status !== 204) {
        throw new Error(`The local Chutes OAuth handler readiness check failed with HTTP ${response.status}.`);
      }
    }
    await oauthDiagnostic.onRun();
  }

  function startChutesSignIn(): void {
    setOauthDiagnosticError(undefined);
    void beginChutesSignIn().catch((caught) => setOauthDiagnosticError(errorMessage(caught)));
  }

  useEffect(() => () => clearEphemeral(), []);

  /*
   * Ask an extension whether it is there, once, when this surface opens. The
   * observer captured here is the one this view mounted with: re-running on a
   * changed prop identity would re-probe on every render, and an extension can
   * be installed, disabled or removed between page loads anyway, so a fresh
   * `hello` per mount is the only reading that is true when it is rendered.
   * `probeExtensionBridge` resolves a named failure rather than rejecting, so
   * there is no silent-catch path here to hide one.
   */
  useEffect(() => {
    let live = true;
    void observeExtensionBridge().then(
      (observation) => {
        if (live) setBridge(observation);
      },
      // An observer that throws is a failed observation with a named cause,
      // never a quiet return to "no extension here".
      (caught: unknown) => {
        if (live) setBridge(Object.freeze({
          state: "failed" as const,
          evidence: "probe-failed" as const,
          detail: `The extension-bridge observation could not be made: ${caught instanceof Error ? caught.message : "the observer failed without naming a cause"}.`,
          providers: Object.freeze([]),
          unavailable: Object.freeze([]),
        }));
      },
    );
    return () => {
      live = false;
    };
  }, []);

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
      // The answer lands where the question was asked. Previously the panel
      // appeared and the confirmation rendered 340px *below* the button that
      // caused it, after four other lanes.
      requestAnimationFrame(() => focusConnectSurface());
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
      // Ownership must leave this view before `onConnect` is awaited, not
      // after. That call navigates to the conversation, so this view can
      // unmount while the promise is still pending; an unmount cleanup that
      // still saw the candidate reference would revoke the authority App just
      // committed and cancel every later turn before its first request. A
      // rejected handoff is released explicitly instead.
      candidateTransport.current = undefined;
      try {
        await onConnect({
          connection: nextConnection,
          credential: credential.value,
          transport,
          model,
          models: candidate.models,
        });
      } catch (caught) {
        transport.revokeCredential(
          new DOMException("The Chutes connection was not committed.", "AbortError"),
        );
        throw caught;
      }
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
  const chutesSignInAvailable = Boolean(oauthDiagnostic) && oauthOrigin.available;
  const activeChutesMethod = chutesSignInAvailable ? chutesMethod : "api-key";

  /**
   * Moves to the browser-direct provider list without touching `location.hash`,
   * which is the router: the anchors this replaced navigated to `#chat` and
   * ejected people out of the connection route entirely.
   *
   * This remains a scroll rather than an in-lane render because the cloud and
   * local key cards live in `provider-connections-view.tsx`, which this package
   * does not own. Lifting them into each lane's `api-key` tabpanel is the one
   * remaining half of the fabric merge.
   */
  function focusDirectProviders(provider?: "openai" | "anthropic" | "xai") {
    const target = typeof document === "undefined"
      ? null
      : document.getElementById(provider ? `provider-setup-${provider}` : "additional-inference-providers");
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.focus({ preventScroll: true });
  }

  function focusConnectSurface() {
    const target = typeof document === "undefined" ? null : document.getElementById("connect-surface-card");
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.focus({ preventScroll: true });
  }

  const laneInput: ConnectLaneInput = {
    online,
    chutes: {
      connected: isChutesConnected(connection),
      signInAvailable: chutesSignInAvailable,
      // Deliberately not `oauthOrigin.reason`: that string is addressed to an
      // operator restarting a companion process. The person reading this needs
      // the next step, and the operator detail stays in the boundary card.
      ...(chutesSignInAvailable ? {} : { signInUnavailableReason: "Chutes sign-in isn’t available in this build." }),
    },
    codex: {
      connected: connectedProviders.has("openai"),
      available: Boolean(codexSignIn),
      ...(codexSignIn ? {} : {
        unavailableReason: "Codex sign-in is not wired into this build. An OpenAI API key connection is listed with the browser-direct providers below.",
      }),
    },
    claude: { connected: connectedProviders.has("anthropic"), signInAvailable: false },
    grok: { connected: connectedProviders.has("xai"), signInAvailable: false },
    bridge,
    host: observeHostExtensionSupport(typeof navigator === "undefined" ? "" : navigator.userAgent),
    ...(publishedExtensionInstallUrl ? { extensionInstallUrl: publishedExtensionInstallUrl } : {}),
    local: {
      connected: LOCAL_PROVIDER_LABELS
        .filter(([id]) => connectedProviders.has(id))
        .map(([, label]) => label),
    },
  };

  const lanes = describeConnectLanes(laneInput);

  return (
    <section class="access-connection-view" aria-labelledby="access-connection-title">
      {/*
        Six levels of chrome — eyebrow, 45.9px H1, paragraph, two scroll anchors
        dressed as tabs, a second eyebrow, a second H2 and a second paragraph —
        become one 44px row. Not one word is dropped: the eyebrow is the ⓘ
        panel's heading, both paragraphs are its body, and `ONE, OR SEVERAL AT
        ONCE` is the count chip's own sentence, beside a number that proves it.
      */}
      <RouteHeader
        routeId="access"
        density="tool"
        title="Connect models"
        eyebrow="Inference connections"
        description={CONNECT_ROUTE_DESCRIPTION}
        headingId="access-connection-title"
        notes={<p class="access-route-note">{CONNECT_PROVIDERS_NOTE}</p>}
        status={
          <Popover
            class="access-count-popover"
            triggerClass="access-count-chip"
            label={`${connectLaneCountLabel(lanes)}. ${CONNECT_COUNT_NOTE}`}
            heading="Connections held in this tab"
            trigger={<Seal state={connectLaneCountSeal(lanes)} density="chip" label={connectLaneCountLabel(lanes)} />}
          >
            <p>{CONNECT_COUNT_NOTE}</p>
            <ul class="access-count-list">
              {lanes.map((lane) => (
                <li key={lane.id}><strong>{lane.title}</strong> — {lane.status.label}</li>
              ))}
            </ul>
          </Popover>
        }
      />

      <div class="access-connection-layout">
        {/*
          The whole surface, always. It used to be replaced by the Chutes
          summary the moment Chutes connected, which left a connected person
          with no way to add a second provider — and made the connected lane
          state unreachable. Chutes state now decides only what sits inside the
          Chutes lane.
        */}
        <section id="connect-surface-card" class="access-connection-card" aria-labelledby="connect-surface-title" tabIndex={-1}>
          {!online ? (
            <p class="access-network-pause" role="status" aria-live="polite">
              <Icon name="warning" size={16} />{OFFLINE_INLINE_REASON}
            </p>
          ) : null}
          {/*
            Above the lanes, not below them. These two lines answer the button a
            person just pressed, and they used to render after every remaining
            lane — 340px past the control, which is not an answer.
          */}
          {status ? <p class="access-live-status" role="status" aria-live="polite"><span />{status}</p> : null}
          {error ? <p class="access-live-error" role="alert"><Icon name="warning" size={16} />{error}</p> : null}

          <ConnectSurface
            input={laneInput}
            onOpenDirectProviders={additionalProviders ? focusDirectProviders : undefined}
            {...(onCheckLocalProviders ? { onCheckLocalProviders } : {})}
            {...(codexSignIn ? { onStartCodexSignIn: codexSignIn.onStart, onSubmitCodexCode: codexSignIn.onSubmitCode } : {})}
            {...(publishedExtensionInstallUrl ? { extensionInstallUrl: publishedExtensionInstallUrl } : {})}
            chutesPanel={<>
            {/*
              The OAuth notice, at lane level and in every tone, never behind a
              disclosure. It used to render only inside the page-level boundary
              aside (all tones) and inside the sign-in card (error only), so the
              in-flight and completion messages had a single home on a card that
              no longer exists.
            */}
            {oauthNotice ? <p class={`oauth-boundary-status ${oauthNotice.tone}`} role={oauthNotice.tone === "error" ? "alert" : "status"}>{oauthNoticeMessage}</p> : null}
            {isChutesConnected(connection) ? (
            <div class="active-connection-summary">
              <div class="access-section-heading">
                <div>
                  <span>Chutes connection</span>
                  <strong>{connectionLabel(connection)}</strong>
                </div>
                <ConnectionBadge connection={connection} />
              </div>
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
              {/*
                Row 1: who you are connecting as, and when the catalogue was
                read. The credential class's second sentence and the whole
                58px provenance band are one gesture away, verbatim.
              */}
              <div class="candidate-identity">
                <p class="credential-kind-result" role="status">
                  <Icon name={candidate.credentialKind === "oauth-user-token" ? "access" : "lock"} size={18} />
                  <strong>{credentialKindLabel(candidate.credentialKind)}</strong>
                </p>
                <Popover
                  class="candidate-help"
                  triggerClass="candidate-help__trigger"
                  label={`About this credential class. ${credentialKindDetail(candidate.credentialKind)}`}
                  heading={credentialKindLabel(candidate.credentialKind)}
                  trigger={<span aria-hidden="true">?</span>}
                >
                  <p>{credentialKindDetail(candidate.credentialKind)}</p>
                </Popover>
                <Popover
                  class="catalog-provenance-popover"
                  triggerClass="catalog-provenance-chip"
                  label={`Catalog read ${formatCatalogTime(candidate.fetchedAt)}. Freshness, optional enrichment${candidate.issues.length > 0 ? `, and ${String(candidate.issues.length)} catalog notice${candidate.issues.length === 1 ? "" : "s"}` : ""}.`}
                  heading="Catalog read"
                  trigger={<><Icon name="proof" size={14} />Catalog read {formatCatalogTime(candidate.fetchedAt)}</>}
                >
                  <p class={candidate.sourceComplete ? "complete" : "partial"}>{candidate.managementState === "fresh" ? "Inference + management metadata loaded" : candidate.sourceComplete ? "Authoritative inference catalog · management enrichment deferred" : "Partial provider metadata"}</p>
                  {candidate.managementState === "disabled" ? <button type="button" onClick={() => void enrichCatalog()} disabled={busy || !online}>Load live availability metadata</button> : null}
                  {candidate.issues.length > 0 ? (
                    <details><summary>{candidate.issues.length} catalog notice{candidate.issues.length === 1 ? "" : "s"}</summary>{candidate.issues.map((issue, index) => <p key={`${issue.source}-${issue.code}-${index}`}>{issue.source}: {issue.message}</p>)}</details>
                  ) : null}
                </Popover>
              </div>
              {/*
                Row 2: the task. `Model · privacy-first recommendation` was a
                22px label floating above the control; the recommendation now
                travels inside the trigger, with the model it describes.
              */}
              <label class="candidate-model">
                <span>Model</span>
                <ModelPicker
                  value={modelId}
                  models={candidate.models}
                  onSelect={setModelId}
                  disabled={busy}
                  {...(candidate.recommendedModelId ? { recommendedModelId: candidate.recommendedModelId } : {})}
                />
              </label>
              <div class="candidate-decision">
                {selectedCandidateModel ? <ModelCandidateSummary model={selectedCandidateModel} /> : null}
                <ProofPolicyControl strict={strictProof} onChange={setStrictProof} />
              </div>
              {/*
                The honesty line. Always visible, outside every disclosure, at
                lane altitude — it is the sentence the whole fieldset exists to
                qualify, and it does not get progressive-disclosed.
              */}
              <p class="proof-policy__caveat">This policy is not proof. Completed receipts record only what the browser actually verified.</p>
              <div class="candidate-actions">
                <button type="button" onClick={chooseDifferentCredential} disabled={busy}>Use a different credential</button>
                <button class="primary" type="button" onClick={() => void activate()} disabled={busy}>Finish: verify &amp; connect</button>
              </div>
            </div>
          ) : (
                <div class="connection-entry-stack">
                  <div class="connect-method__switch" role="tablist" aria-label="Chutes connection method">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeChutesMethod === "oauth"}
                      disabled={!chutesSignInAvailable}
                      onClick={() => setChutesMethod("oauth")}
                    >
                      <span>OAuth</span>
                      <small>{chutesSignInAvailable ? "Primary" : "Unavailable"}</small>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeChutesMethod === "api-key"}
                      onClick={() => setChutesMethod("api-key")}
                    >
                      <span>API key</span>
                      <small>Page memory</small>
                    </button>
                  </div>
                  {activeChutesMethod === "oauth" ? (
                    <section class="oauth-primary-entry" aria-labelledby="oauth-primary-title">
                      <Icon name="access" size={22} />
                      <div>
                        <strong id="oauth-primary-title">Sign in to Chutes</strong>
                        <p>{localOAuthHandler
                          ? "Your password never touches Airship. The app secret stays in the localhost process, outside browser JavaScript."
                          : "Your password never touches Airship, and no client secret is used."}</p>
                        {/*
                          Every word about Chutes OAuth now lives inside Chutes
                          OAuth. The 168px/240px page-level boundary aside used
                          to sit between the lane list and the provider fabric,
                          where it was read by people who will never touch this
                          flow. Its summary names the second half of what it
                          holds, so the disclosure states its own contents.
                        */}
                        <details class="oauth-mechanism">
                          <summary>How this works · what the handler can see</summary>
                          <p>{localOAuthHandler
                            ? "The browser creates the Authorization Code + S256 PKCE request. The same-origin localhost handler adds the registered app secret only during token exchange; it never stores tokens or exposes the secret to the page."
                            : "Profile, billing, and inference connect through Authorization Code + S256 PKCE with a Chutes app registered for public-client token exchange."}</p>
                          <strong>{localOAuthHandler ? "Local token-handler boundary" : "Public-client OAuth boundary"}</strong>
                          <p>{localOAuthHandler
                            ? "The localhost handler receives only the one-time code, PKCE verifier, and memory-only token requests. It adds its process-held app secret and returns the provider response without persisting it. Access and rotating refresh tokens remain in this page's memory."
                            : "The client ID is public. A one-time PKCE verifier survives only the authorization redirect; access and rotating refresh tokens remain in this page's memory. Directory visibility is a separate provider setting."}</p>
                          {/*
                            The operator-addressed cause sits with the boundary
                            it explains, and outside the registration block —
                            that block renders only when a diagnostic exists,
                            which is precisely the case where this sentence is
                            not needed. Gating the explanation on availability
                            made the one string that says WHY sign-in is
                            unavailable renderable only when it was available.
                          */}
                          {!chutesSignInAvailable ? (
                            <p class="oauth-boundary-status warning" role="status">Deployment detail: {oauthOrigin.reason}</p>
                          ) : null}
                          {oauthDiagnostic ? (
                            <details class="oauth-diagnostic">
                              <summary>Registration details</summary>
                              <p>{localOAuthHandler
                                ? <>The callback must match exactly. This localhost registration uses <code>client_secret_post</code>; only the same-origin handler performs token operations.</>
                                : <>The callback must match exactly, and the Chutes app must be a Browser/native PKCE client with token endpoint authentication set to <code>none</code>.</>}</p>
                              <dl>
                                <div><dt>Homepage</dt><dd>{oauthDiagnostic.homepageUrl}</dd></div>
                                <div><dt>Callback</dt><dd>{oauthDiagnostic.callbackUrl}</dd></div>
                                <div><dt>Scopes</dt><dd>{oauthDiagnostic.scopes.join(" · ")}</dd></div>
                              </dl>
                              <button
                                type="button"
                                disabled={!online || !chutesSignInAvailable}
                                onClick={startChutesSignIn}
                              >
                                Start sign-in again
                              </button>
                            </details>
                          ) : null}
                        </details>
                        <button
                          class="primary"
                          type="button"
                          // The explanation above is now reachable whether or
                          // not this deployment can start the flow; the control
                          // that would fail is the only part still gated.
                          disabled={busy || !online || !chutesSignInAvailable}
                          onClick={startChutesSignIn}
                        >
                          Sign in to Chutes
                        </button>
                        {oauthDiagnosticError ? <p class="oauth-boundary-status error" role="alert">{oauthDiagnosticError}</p> : null}
                      </div>
                    </section>
                  ) : null}

                  {/*
                    When the sign-in exchange is not configured, sign-in is not
                    offered at all and the key panel opens by itself. A primary
                    "Recommended" control that returns a developer-facing error
                    is what took cold-visitor conversion to roughly zero.
                  */}
                  {activeChutesMethod === "api-key" ? (
                  <section class="api-key-alternative" aria-labelledby="chutes-api-key-title">
                    <strong id="chutes-api-key-title">Connect with a Chutes API key</strong>
                    <form class="credential-entry" onSubmit={(event) => { event.preventDefault(); void discover(); }}>
                      <div class="credential-types" aria-label="Optional Chutes API-key connection">
                        <CredentialTypeCard prefix="cpk_" title="Chutes API key" detail="Chutes personal keys start with cpk_. They read models, inference, profile, and account when Chutes authorizes them." active={detectedKind === "inference-api-key"} />
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
                      <p id="chutes-credential-help">
                        Held only in page memory. Don’t have one?{" "}
                        <a href={CHUTES_ACCOUNT_URL} target="_blank" rel="noreferrer">Create a key at chutes.ai → API keys ↗</a>{" "}
                        Never paste a client secret or administrator credential.
                      </p>
                      <button type="submit" disabled={busy || !online}>Discover models with key</button>
                    </form>
                  </section>
                  ) : null}
                </div>
          )}
          </>}
          />
        </section>

        <details class="access-connection-card capability-card">
          {/*
            `CONNECTION METHODS` was a category label for a one-item category,
            so it merges into the summary the row already needed. The four
            headers, four rows, twelve marks and the eligibility caveat below
            are untouched.
          */}
          <summary><strong id="capability-matrix-title">Compare what each method can do</strong></summary>
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

      {additionalProviders ? (
        <div id="additional-inference-providers" class="access-additional-providers" aria-label="Additional cloud and local inference providers" tabIndex={-1}>
          {additionalProviders}
        </div>
      ) : null}
    </section>
  );
}

/** The recommended option's full description, verbatim, at either altitude. */
const VERIFY_AND_RECORD_DETAIL = "Recommended. Evaluate still-current endpoint evidence before every turn and refresh it when needed; leave incomplete CPU or GPU claims visibly unverified without breaking encrypted chat.";
const STRICT_UNAVAILABLE_DETAIL = `${CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.reason} Verify & record still evaluates current evidence before every turn and refreshes it when needed.`;

/**
 * Turn proof policy, keyed on capability rather than on taste.
 *
 * When strict fail-closed is unavailable in this build — always, today — a
 * 465×108px tile of grey prose for a permanently `disabled` control is 28% of
 * the panel spent on a choice with one option. So the choice collapses to the
 * option that exists plus a disclosure that says exactly what is inside it, and
 * both option descriptions live there verbatim. The moment the capability flips
 * to `true` the full two-tile fieldset returns with no design change, because
 * the branch is the capability record itself.
 */
function ProofPolicyControl({
  strict,
  onChange,
}: Readonly<{ strict: boolean; onChange: (value: boolean) => void }>) {
  if (!CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available) {
    return (
      <div class="proof-policy">
        <p class="proof-policy__legend">Turn proof policy</p>
        <p class="proof-policy__selected">
          <Icon name="check" size={15} />
          <strong>Verify &amp; record</strong>
          <span>recommended</span>
        </p>
        <details class="proof-policy__why">
          <summary>Strict fail-closed is unavailable in this build. Why, and what each policy does</summary>
          <p><strong>Verify &amp; record.</strong> {VERIFY_AND_RECORD_DETAIL}</p>
          <p><strong>Strict fail-closed · unavailable.</strong> {STRICT_UNAVAILABLE_DETAIL}</p>
        </details>
      </div>
    );
  }
  return (
    <fieldset class="proof-policy-consent">
      <legend>Turn proof policy</legend>
      <button type="button" class={!strict ? "selected" : ""} aria-pressed={!strict} onClick={() => onChange(false)}>
        <span><strong>Verify &amp; record</strong><small>{VERIFY_AND_RECORD_DETAIL}</small></span>
      </button>
      <button
        type="button"
        class={strict ? "selected" : ""}
        aria-pressed={strict}
        disabled={!CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available}
        title={CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.reason}
        onClick={() => {
          if (CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY.available) onChange(true);
        }}
      >
        <span>
          <strong>Strict fail-closed</strong>
          <small>Block the turn unless every required endpoint claim verifies first.</small>
        </span>
      </button>
    </fieldset>
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

function presentOAuthNotice(message: string): string {
  if (message === "oauth:exchange-local") return "Exchanging the code through the localhost handler…";
  if (message === "oauth:exchange-public") return "Exchanging the code with Chutes…";
  if (message === "oauth:complete-local") {
    return "Chutes sign-in complete with S256 PKCE through the localhost handler. Choose a model, then finish the connection.";
  }
  if (message === "oauth:complete-public") {
    return "Chutes sign-in complete with S256 PKCE. Choose a model, then finish the connection.";
  }
  if (message === "oauth:invalid-local") {
    return "Chutes rejected the localhost app credentials. Restart the lab with its registered process credentials, then sign in again.";
  }
  if (message === "oauth:invalid-public") {
    return "Chutes rejected this Browser/native registration. Its token authentication must be “none”; update it, then sign in again.";
  }
  return message;
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
      {/*
        The caveat attaches to the model rather than living in a paragraph
        somewhere else on the page: "evidence candidate" is a catalogue claim,
        and this is the tile that says so.
      */}
      <div><span>Trust readiness</span><strong>{model.trust.consistency === "conflict" ? "metadata conflict" : "evidence candidate"}</strong><small>verification remains {model.trust.verification}</small><small>catalog metadata is not proof</small></div>
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
