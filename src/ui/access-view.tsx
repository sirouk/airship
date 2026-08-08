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
import { reconnectMethodTab, type AccessReconnectIntent } from "./access-intent";
import { formatInstant } from "./instant-format";
import { mapUnknownRequestFailure } from "./request-state";
import { ModelPicker } from "./model-picker";
import { OFFLINE_INLINE_REASON } from "./connectivity";
import { probeExtensionBridge, type ExtensionBridgeObservation } from "../capabilities/extension-bridge";
import { ConnectSurface, type LocalProviderProbeResult } from "./connect/connect-surface";
import {
  connectLaneCountLabel,
  connectLaneCountSeal,
  describeConnectLanes,
  // The panel below and the lane row state one consequence. It is declared
  // beside the lane that renders it so the two cannot be reworded apart.
  SIGN_IN_UNAVAILABLE,
  type ConnectLaneInput,
} from "./connect/connect-lanes";
import { observeHostExtensionSupport } from "./connect/extension-bridge-presence";
import { probeChutesSignInHandler, type ChutesSignInReadiness } from "./connect/chutes-signin-readiness";
import { verifyChutesKey } from "./connect/chutes-key-authorization";
import { EgressPanel } from "./connect/egress-panel";
import { egressRecorder, lastCredentialEgress } from "./connect/egress-record";
import { CHUTES_DISCOVERY_PREFLIGHT } from "./connect/egress-preflight";
import type { ChutesEmbeddingModel } from "../indexing/chutes-embedding-catalog";
import { destinationLabel } from "./navigation-model";
import { Popover } from "./popover";
import { RouteHeader } from "./route-header";
import { Seal } from "./seal";
import { nextTabId } from "./tabs";
import "./access-view.css";

/** The Chutes switch's two tabs, in strip order, for the shared movement rule. */
const CHUTES_METHOD_TABS = Object.freeze([
  Object.freeze({ id: "oauth", label: "OAuth" }),
  Object.freeze({ id: "api-key", label: "API key" }),
]);

/**
 * The page paragraph, verbatim, with the one word the layout falsified.
 *
 * It said "below", and after the jump nav and the second heading block were
 * removed there is no below — the lanes are here. Moving a sentence one rung
 * down the ladder is allowed; leaving it pointing at something that no longer
 * exists is not.
 */
const CONNECT_ROUTE_DESCRIPTION = "Use Chutes for application-encrypted inference, or connect browser-direct cloud and local models here. Credentials remain in page memory.";
/**
 * The heading's own words, kept — one rung down.
 *
 * The `<h1>` read `Connect models` while the rail row, the command palette and
 * the More sheet that all lead here read `Connection`: a person tapped a word
 * and arrived somewhere that did not contain it. The title now comes from
 * `destinationLabel("access")`, and `Connect models` joins the eyebrow rather
 * than being deleted — it is the one place on this route that states the task
 * in a verb, and the eyebrow is where a route's second line already lives.
 */
const CONNECT_ROUTE_EYEBROW = "Connect models · inference connections";
/** The Providers paragraph, verbatim, from the heading block this replaces. */
const CONNECT_PROVIDERS_NOTE = "Everything else in Airship — workspace, editor, terminal and Git — already works without this. Only chat needs a model, and connecting one never closes the others.";
/**
 * The `ONE, OR SEVERAL AT ONCE` eyebrow, as the sentence its own count proves.
 *
 * It carried a second sentence that is a verbatim clause of
 * `CONNECT_PROVIDERS_NOTE` above — the never-closes-the-others promise. Two
 * disclosures on the same 44px row were making that promise in the same words,
 * which is how a reader learns to stop reading either. The promise is not
 * dropped: it stays verbatim in the route paragraph, and this chip's number is
 * the thing that demonstrates it.
 */
const CONNECT_COUNT_NOTE = "Connect one, or several at once.";

/**
 * The in-flight reading, said once. Both the lane row and the panel print it,
 * and two spellings of "we have not asked yet" is exactly the sprawl this
 * package exists to remove.
 */
const SIGN_IN_CHECKING = "Airship is checking whether this build can exchange a sign-in code";

/** Where a Chutes personal key is created. Named on every key surface. */
export const CHUTES_ACCOUNT_URL = "https://chutes.ai/app";

/** The account page that lists and issues personal API keys. */
export const CHUTES_API_KEYS_URL = "https://chutes.ai/app/settings/api-keys";

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
  reconnectIntent?: AccessReconnectIntent;
  chutesReconnectExact?: boolean;
  onAbandonReconnect(): void;
  onConnect: (request: AccessConnectRequest) => Promise<void>;
  onDisconnect: () => Promise<void>;
  models?: readonly AirshipModel[];
  onSelectModel?: (modelId: string) => Promise<"in-place" | "forked" | "confirming-compression" | void>;
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
    /**
     * Reads the completed exchange without consuming it, so a remount of this
     * conditionally-mounted view can re-enter discovery instead of stranding a
     * credential the user already round-tripped for. The host clears it on
     * commit or release.
     */
    readCredential: () => string | undefined;
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

/**
 * What Chutes can embed with — and therefore whether there is anything to ask.
 *
 * Connecting used to be an interview: paste a key, then pick a chat model to
 * finish. The chat model is selectable in the chat header, so that question was
 * being asked in the one place it could not be reconsidered cheaply. What is
 * left here is the single question a connection genuinely settles, and only
 * when it is genuinely a question — which is a count, read from Chutes, not a
 * number written into this file.
 *
 * `none` is not a failure and `unasked` is not either. A build that cannot see
 * an embedding chute keeps the local engine, which is a working product; making
 * that an error on the connection route would block a chat connection over an
 * index setting.
 */
type EmbeddingOffer =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "adopted"; model: ChutesEmbeddingModel }>
  | Readonly<{ state: "choose"; models: readonly ChutesEmbeddingModel[] }>
  | Readonly<{ state: "unasked" }>;

/**
 * Ask Chutes which chutes embed, and never reject.
 *
 * Imported dynamically for the same reason the provider fabric is passed in as
 * a prop: a static import would merge the indexing graph into this route's
 * chunk. The catalog read is anonymous — discovering *what exists* does not
 * spend a credential — so it can run beside the model catalog on the same
 * press without lengthening the journey.
 */
async function askEmbeddingOffer(signal: AbortSignal): Promise<EmbeddingOffer> {
  try {
    const { discoverChutesEmbeddingModels } = await import("../indexing/chutes-embedding-catalog");
    const catalog = await discoverChutesEmbeddingModels({ signal });
    if (catalog.models.length === 0) return Object.freeze({ state: "none" as const });
    if (catalog.models.length === 1) return Object.freeze({ state: "adopted" as const, model: catalog.models[0]! });
    return Object.freeze({ state: "choose" as const, models: catalog.models });
  } catch {
    /*
     * Deliberately silent, and deliberately not `none`.
     *
     * "Chutes lists no embedding chutes" and "Airship could not ask" are
     * different facts — the discovery module is careful to keep them apart —
     * but neither of them is a reason to interrupt someone connecting a chat
     * model. The confidential engine states its own refusal on the Context
     * route, where it is chosen; here it produces no step at all.
     */
    return Object.freeze({ state: "unasked" as const });
  }
}

type Candidate = Readonly<{
  credentialKind: ChutesCredentialKind;
  models: readonly AirshipModel[];
  fetchedAt: string;
  sourceComplete: boolean;
  managementState: ModelSourceState;
  issues: readonly ModelCatalogIssue[];
}>;

export function AccessView({
  connection,
  online,
  reconnectIntent,
  chutesReconnectExact = false,
  onAbandonReconnect,
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
  /*
   * Set by every accepted credential, whichever door it came through.
   *
   * It used to be set only by the returning OAuth redirect, and the comment
   * here said a pasted key "still discovers and stops, because choosing the
   * model is the reason that lane has a panel". That reason does not survive
   * inspection: the chat model is a control in the chat header, changeable per
   * conversation, so making it a gate on connecting asked for a decision at the
   * one moment the person has the least information and the most friction. Both
   * doors now carry through to chat. The panel is still there — it is where
   * verification reports itself, and where the one question a connection really
   * does settle is asked when it is really a question.
   */
  const autoConnectAfterDiscovery = useRef(false);
  const [candidate, setCandidate] = useState<Candidate>();
  const [modelId, setModelId] = useState("");
  /*
   * What Chutes can embed with, read on the same press that reads the model
   * catalog. `undefined` means the question has not been answered yet, which is
   * why the automatic connect leg waits for it: connecting past an unanswered
   * count would decide by racing.
   */
  const [embeddingOffer, setEmbeddingOffer] = useState<EmbeddingOffer>();
  /** The embedding deployment this connection will index against, when asked. */
  const [embeddingModelId, setEmbeddingModelId] = useState("");
  const [detectedKind, setDetectedKind] = useState<ChutesCredentialKind>();
  // Whether anything has been typed at all, kept separate from what it parsed
  // as: without it, "nothing entered" and "entered and not recognised" collapse
  // into one silent state, and the only signal for the second was the *absence*
  // of a highlight — a negative nobody can read.
  const [credentialTyped, setCredentialTyped] = useState(false);
  const [strictProof, setStrictProof] = useState(false);
  // `undefined` means "follow what can actually work". A hardcoded initial
  // method made the tab a statement about the build rather than about a choice.
  const [chutesMethod, setChutesMethod] = useState<"oauth" | "api-key" | undefined>(() =>
    reconnectIntent?.lane === "chutes" ? reconnectMethodTab(reconnectIntent.method) : undefined
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [connectionReleaseConfirmation, setConnectionReleaseConfirmation] = useState<"switch" | "clear">();
  const connectionReleaseCancel = useRef<HTMLButtonElement>(null);
  const switchCredentialButton = useRef<HTMLButtonElement>(null);
  const clearConnectionButton = useRef<HTMLButtonElement>(null);
  const [oauthDiagnosticError, setOauthDiagnosticError] = useState<string>();
  // `undefined` until the handshake settles. There is no "last known" arm, so
  // an unfinished observation can only render as "checking" — never as absence,
  // and never as a presence carried over from an earlier load.
  const [bridge, setBridge] = useState<ExtensionBridgeObservation>();
  /*
   * `undefined` until the localhost handler answers, and never a stand-in for
   * either arm. The lane may not print "Primary" on a route it has not yet
   * established can be taken, and it may not print "unavailable in this build"
   * on a route it has not yet established cannot be.
   */
  const [handlerReadiness, setHandlerReadiness] = useState<ChutesSignInReadiness>();
  // The key that was refused, held open so it can be corrected rather than
  // retyped. See `activate()`.
  /*
   * `stage` because the two refusals are different facts. The key check runs
   * before the catalog is read; the model authorization runs after a model is
   * chosen. One sentence for both told a person whose key was rejected at the
   * first step that "listing models succeeded" — about a listing that never
   * happened.
   */
  const [keyRefusal, setKeyRefusal] = useState<Readonly<{
    stage: "key-check" | "model-authorization";
    providerResponse: string;
  }>>();
  /*
   * What the last attempt did with the key that is still in the field.
   *
   * Driven on this build with chutes.ai unreachable, the field caption read
   * "Not read as a Chutes credential. Chutes personal keys start with cpk_."
   * about `cpk_myrealkeypastedcarefully000000000` — because the failure path
   * emptied the input and cleared `detectedKind`, so the caption was reading an
   * empty field and reporting it as a malformed key. The key now survives the
   * request and this says what actually happened to it, including whether it
   * left the device at all, read from the egress record rather than assumed.
   */
  const [lastAttempt, setLastAttempt] = useState<CredentialAttempt>(NO_CREDENTIAL_ATTEMPT);
  /*
   * Set by a failed OAuth-kind connect leg: the completed exchange survived
   * (the host holds the pending credential read-only), so the failure gets a
   * retry control instead of a dead end whose only exit was a second full
   * authorization round trip. `oauthBootstrapRetryNonce` re-runs the bootstrap
   * effect below, which discovers and verifies again from exactly this state.
   */
  const [oauthConnectRetry, setOauthConnectRetry] = useState(false);
  const [oauthBootstrapRetryNonce, setOauthBootstrapRetryNonce] = useState(0);
  const oauthRetryButton = useRef<HTMLButtonElement>(null);
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

  /*
   * The press-time check and the load-time probe read the same endpoint through
   * the same function, so the sentence a person gets after pressing cannot
   * differ from the one the tab was labelled with. `fetch("…")` used to be
   * spelled out here with its three failure sentences inline, which is how the
   * lane came to advertise a route only the press could discover was closed.
   */
  async function beginChutesSignIn(): Promise<void> {
    if (!oauthDiagnostic) return;
    if (localOAuthHandler) {
      const readiness = await probeChutesSignInHandler();
      setHandlerReadiness(readiness);
      if (readiness.state === "blocked") throw new Error(readiness.reason);
    }
    await oauthDiagnostic.onRun();
  }

  function startChutesSignIn(): void {
    setOauthDiagnosticError(undefined);
    void beginChutesSignIn().catch((caught) => {
      // Stay on the tab the person is standing on. A failed press flips
      // `chutesSignInAvailable` to false, and without this the OAuth panel —
      // which is where the consequence, the cause and the way out all render —
      // would unmount in the same frame as the failure that produced them.
      setChutesMethod("oauth");
      setOauthDiagnosticError(errorMessage(caught));
    });
  }

  /*
   * Ask the localhost handler whether it can exchange a code, once, at load.
   *
   * Only this build shape has a handler to ask: a public-PKCE deployment has no
   * same-origin endpoint, so probing one would be inventing a check. That arm
   * keeps `oauthOrigin` as its only availability source, exactly as before.
   */
  useEffect(() => {
    if (!localOAuthHandler) return;
    let live = true;
    void probeChutesSignInHandler().then((readiness) => {
      if (live) setHandlerReadiness(readiness);
    });
    return () => {
      live = false;
    };
  }, [localOAuthHandler]);

  useEffect(() => () => clearEphemeral(), []);

  useEffect(() => {
    const requested = reconnectIntent?.lane === "chutes"
      ? reconnectMethodTab(reconnectIntent.method)
      : undefined;
    if (requested) setChutesMethod(requested);
  }, [reconnectIntent?.lane, reconnectIntent?.method, reconnectIntent?.returnSessionId]);

  useEffect(() => {
    if (reconnectIntent?.lane !== "chutes" || !chutesReconnectExact) {
      setConnectionReleaseConfirmation(undefined);
    }
  }, [chutesReconnectExact, reconnectIntent?.lane, reconnectIntent?.returnSessionId]);

  useEffect(() => {
    if (!connectionReleaseConfirmation) return;
    const frame = requestAnimationFrame(() => connectionReleaseCancel.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [connectionReleaseConfirmation]);

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
    setEmbeddingOffer(undefined);
    setDetectedKind(undefined);
    setStrictProof(false);
  }, [connection.kind]);

  function inspectInput() {
    const value = credentialInput.current?.value ?? "";
    // The refusal was about the key that was in this field. Editing it makes
    // the verdict stale, so it stops being shown before it can be read as a
    // verdict about the new one. The same is true of what the last attempt did
    // with the old value.
    setKeyRefusal(undefined);
    setLastAttempt(NO_CREDENTIAL_ATTEMPT);
    setCredentialTyped(Boolean(value.trim()));
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

  /**
   * Give a pasted secret back to the person who pasted it.
   *
   * Written once because two failure branches need it and one of them used to
   * do it by hand while the other silently dropped the key. The tab has to move
   * before the frame in which the field is focused — the entry field only
   * mounts on the API-key tab, and focusing an unmounted input drops focus to
   * the document body, which is the ordering `clearConnection` also documents.
   */
  function returnCredentialToField(credential: EphemeralChutesCredential) {
    setDetectedKind(credential.kind);
    setCredentialTyped(true);
    setChutesMethod("api-key");
    requestAnimationFrame(() => {
      const field = credentialInput.current;
      if (!field) return;
      // Left masked and filled: a key that was one character wrong is
      // corrected, not retyped — on a phone, retyping means an app switch.
      field.value = credential.value;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }

  /**
   * Record what the embedding catalog answered without inventing a deployment.
   * One live deployment is unambiguous. With several, an earlier choice may be
   * reused only if that exact id is still in the fresh catalog; otherwise the
   * person chooses from the returned rows.
   */
  async function adoptEmbeddingOffer(offer: EmbeddingOffer): Promise<void> {
    setEmbeddingOffer(offer);
    if (offer.state === "adopted") {
      setEmbeddingModelId(offer.model.id);
      await recordEmbeddingChoice(offer.model.id);
      return;
    }
    if (offer.state !== "choose") {
      setEmbeddingModelId("");
      return;
    }
    const { readConfidentialEmbeddingChoice, writeConfidentialEmbeddingChoice } =
      await import("../indexing/confidential-embedding-choice");
    const saved = readConfidentialEmbeddingChoice();
    if (saved && offer.models.some((model) => model.id === saved)) {
      setEmbeddingModelId(saved);
      return;
    }
    // A retired saved id must not silently turn into a different deployment.
    writeConfidentialEmbeddingChoice(undefined);
    setEmbeddingModelId("");
  }

  /** Hand the indexing side the id, so what is shown is what an index uses. */
  async function recordEmbeddingChoice(id: string): Promise<void> {
    const { writeConfidentialEmbeddingChoice } = await import("../indexing/confidential-embedding-choice");
    writeConfidentialEmbeddingChoice(id);
  }

  function chooseEmbeddingModel(id: string): void {
    setEmbeddingModelId(id);
    void recordEmbeddingChoice(id);
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
    setStatus("Checking the key with Chutes, then reading the catalog…");
    setError(undefined);
    setKeyRefusal(undefined);
    setLastAttempt(NO_CREDENTIAL_ATTEMPT);
    setOauthConnectRetry(false);
    setCandidate(undefined);
    setEmbeddingOffer(undefined);
    clearEphemeral();
    // Where this attempt starts in the egress record, so a failure can report
    // what *this* press sent rather than what some earlier press did.
    const attemptFrom = Date.now();
    const controller = new AbortController();
    discoveryAbort.current = controller;
    try {
      const credential = parseChutesCredential(rawCredential);
      if (credential.kind === "oauth-user-token" && !tokenSource) {
        throw new Error("Use Chutes sign-in for a scoped user session. The advanced field accepts only an optional cpk_ inference key.");
      }
      /*
       * The key is offered to Chutes before anything that implies Chutes took
       * it. `cpk_notarealkey000000` used to reach a priced model card with an
       * availability reading and a recommendation badge, because the catalog
       * that produced them is readable by anyone — the credential was not
       * checked until Finish, ten seconds later. A rejected key now stops here,
       * in the field it was typed into, at ~100ms.
       *
       * Only the pasted-key lane. A token from the sign-in exchange is already
       * a completed authorization, and its scopes need not include the account
       * read this endpoint answers — failing it would invent a refusal.
       */
      if (credential.kind === "inference-api-key" && !tokenSource) {
        const verdict = await verifyChutesKey(credential.value, controller.signal);
        if (verdict.state === "refused") {
          setStatus(undefined);
          setKeyRefusal(Object.freeze({ stage: "key-check", providerResponse: verdict.providerResponse }));
          setLastAttempt(attemptOutcome(attemptFrom));
          returnCredentialToField(credential);
          return;
        }
        if (verdict.state === "unreachable") {
          // Unchecked is not accepted. The picker is a claim about the key, so
          // a check that never answered may not produce one.
          throw new Error(`The key could not be checked with Chutes, so nothing below it is shown. ${verdict.detail}`);
        }
      }
      setStatus("Chutes accepted the key. Discovering encrypted-inference models available to this connection…");
      const catalogClient = new ModelCatalogClient({ includeManagement: true, timeoutMs: 20_000 });
      /*
       * Both catalogs on one press. The embedding read is anonymous and
       * independent, so pairing it here costs the journey nothing and means the
       * connect leg never has to guess whether there is a choice to offer.
       */
      const [snapshot, offer] = await Promise.all([
        catalogClient.load({ signal: controller.signal, forceRefresh: true }),
        askEmbeddingOffer(controller.signal),
      ]);
      await adoptEmbeddingOffer(offer);
      const compatibleModels = filterModels(snapshot.models, {
        confidentialCompute: "required",
        requireE2eeCandidate: true,
        inputModalities: ["text"],
        outputModalities: ["text"],
      });
      if (compatibleModels.length === 0) {
        throw new Error("Chutes returned no text-in/text-out models explicitly eligible for encrypted confidential-compute invocation.");
      }
      // `compatibleModels` is already the live, privacy-filtered set. Passing
      // an empty policy keeps the ranking deterministic without reapplying the
      // stricter agent defaults or falling back to an arbitrary first row.
      const selection = selectModel(compatibleModels, { requirements: {} }).model!;
      const requestedModel = reconnectIntent?.lane === "chutes"
        ? compatibleModels.find((candidate) => candidate.id === reconnectIntent.model)
        : undefined;
      if (reconnectIntent?.lane === "chutes" && !requestedModel) {
        throw new Error(`This Chutes connection does not offer the pinned model ${reconnectIntent.model}. The conversation was left unchanged.`);
      }
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
      // Cleared only now that the value is held elsewhere and the form is about
      // to be replaced by the chooser. Every failure path below returns it to
      // the field instead — see `returnCredentialToField`.
      //
      // `credentialTyped` moves with it: it is the reason the reading renders
      // at all, and leaving it set made "Use a different credential" remount an
      // empty field under "Not read as a Chutes credential." — the same verdict
      // about nothing that the failure path used to produce.
      if (input) input.value = "";
      setCredentialTyped(false);
      setCandidate(Object.freeze({
        credentialKind: credential.kind,
        models: compatibleModels,
        fetchedAt: snapshot.fetchedAt,
        sourceComplete: snapshot.complete,
        managementState: snapshot.sources.management,
        issues: snapshot.issues,
      }));
      setModelId(requestedModel?.id ?? selection.id);
      setDetectedKind(credential.kind);
      setStrictProof(false);
      setStatus(`${compatibleModels.length} encrypted-inference candidate${compatibleModels.length === 1 ? "" : "s"} found. Catalog metadata is not proof. Finish verifies selected-model authorization and arms fresh per-turn evidence collection.`);
      // The answer lands where the question was asked. Previously the panel
      // appeared and the confirmation rendered 340px *below* the button that
      // caused it, after four other lanes.
      requestAnimationFrame(() => focusConnectSurface());
    } catch (caught) {
      clearEphemeral();
      // A discovery that produced no candidate can never be auto-connected, and
      // a stale flag would silently connect the next credential someone typed.
      autoConnectAfterDiscovery.current = false;
      /*
       * The field keeps its value and the reading keeps its verdict.
       *
       * Both were destroyed here: the input was emptied 500 ms into a request
       * that had produced nothing, and `setDetectedKind(undefined)` then made
       * the caption diagnose the (now empty) field as "Not read as a Chutes
       * credential" — about a well-formed cpk_ the user had just pasted. On a
       * phone that costs an app switch to a password manager for every dropout,
       * and the banner beside it was meanwhile claiming "Local state was kept".
       */
      setLastAttempt(attemptOutcome(attemptFrom));
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
    // A pasted key is a decision already made, exactly like a returning
    // redirect: the person went and got a credential and typed it in. What
    // follows is verification, not choice, so it carries itself through.
    autoConnectAfterDiscovery.current = true;
    await discoverCredential(input.value);
  }

  useEffect(() => {
    if (!online || !oauthBootstrap || isChutesConnected(connection)) return;
    const credential = oauthBootstrap.readCredential();
    if (!credential) return;
    // A returning redirect is a decision already made: the person asked to
    // connect, authorized Chutes, and came back. Everything after that is
    // verification, not choice, so the sign-in journey carries itself through
    // to a verified connection. The model and proof policy remain editable on
    // the connected summary, where they are corrections rather than gates.
    autoConnectAfterDiscovery.current = true;
    void discoverCredential(credential, oauthBootstrap.getBearerToken);
    // The nonce is the retry control's wire back in: a failed OAuth connect
    // leg left the exchange intact, so pressing Retry re-enters this same
    // leg rather than paying a second authorization round trip.
  }, [oauthBootstrap?.revision, connection.kind, online, oauthBootstrapRetryNonce]);

  /*
   * The credential is only verified by `activate()`, and `activate()` reads the
   * candidate and the pre-selected model from state, so the automatic leg has
   * to wait for that state to land rather than calling straight out of
   * discovery. One effect, one flag, cleared before the call so a failed
   * verification falls back to the manual panel instead of retrying forever.
   */
  useEffect(() => {
    if (!autoConnectAfterDiscovery.current) return;
    if (busy || !candidate || !modelId) return;
    /*
     * The one thing that may stop a connection short of chat: a real choice.
     *
     * Two or more usable embedding deployments means the index needs an id
     * from the current catalog. A previously saved id may carry the user's
     * earlier decision forward; without one, the explicit buttons below are
     * the only way this leg proceeds.
     */
    if (!embeddingOffer) return;
    if (embeddingOffer.state === "choose" && !embeddingModelId) return;
    autoConnectAfterDiscovery.current = false;
    void activate();
  }, [candidate, modelId, busy, embeddingOffer, embeddingModelId]);

  async function activate() {
    const credential = ephemeralCredential.current;
    const discoveryTransport = candidateTransport.current;
    const tokenSource = ephemeralTokenSource.current;
    const model = candidate?.models.find((item) => item.id === modelId);
    if (!credential || !discoveryTransport || !candidate || !model) return;
    setBusy(true);
    const controller = new AbortController();
    discoveryAbort.current = controller;
    // This leg is the one that actually puts the credential on the wire, as a
    // bearer token to api.chutes.ai. The mark scopes the reading below to it.
    const attemptFrom = Date.now();
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
      setStrictProof(false);
      setStatus(undefined);
      /*
       * A refused key is a verdict about the key, not a networking noun.
       *
       * `mapRequestFailure` returns `credential` for 401/403 on the connect
       * leg, and the sentence it hands back — "Endpoint discovery denied.
       * Reconnect with chutes:invoke or an API key." — told a person who had
       * just pasted an API key to reconnect with an API key, and named an OAuth
       * scope that appears nowhere else in the product. It is not deleted: it
       * is the provider's own words and stays verbatim under a disclosure that
       * says so.
       */
      const failure = mapUnknownRequestFailure(caught, online);
      if (failure.kind === "credential" && credential.kind === "inference-api-key") {
        setKeyRefusal(Object.freeze({ stage: "model-authorization", providerResponse: failure.message }));
        setError(undefined);
        returnCredentialToField(credential);
      } else {
        setError(failure.message);
        if (credential.kind === "inference-api-key") {
          // A verification that failed on the network is not a verdict about
          // the key, so the key comes back to the field it was typed into and
          // the caption says whether it left — the same custody rule the
          // refused-key branch above proves, applied to the branch that used to
          // drop it. `returnCredentialToField` also owns the focus.
          returnCredentialToField(credential);
          setLastAttempt(attemptOutcome(attemptFrom));
        } else {
          setDetectedKind(undefined);
          if (credential.kind === "oauth-user-token" && oauthBootstrap) {
            /*
             * An OAuth-kind candidate can only have come from the bootstrap
             * leg, and that exchange is not consumed by failing here — the
             * host holds the pending credential read-only until commit or
             * release. Offer the leg again instead of stranding a completed
             * sign-in behind a full re-authorization.
             */
            setOauthConnectRetry(true);
            requestAnimationFrame(() => oauthRetryButton.current?.focus());
          } else if (credentialInput.current) {
            // The entry field only mounts on the API-key tab; focus it only
            // when it is actually there.
            requestAnimationFrame(() => credentialInput.current?.focus());
          } else {
            focusConnectSurface();
          }
        }
      }
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
      const selection = selectModel(models, { requirements: {} }).model!;
      const requestedModel = reconnectIntent?.lane === "chutes"
        ? models.find((candidate) => candidate.id === reconnectIntent.model)
        : undefined;
      if (reconnectIntent?.lane === "chutes" && !requestedModel) {
        throw new Error(`The refreshed Chutes catalog no longer offers the pinned model ${reconnectIntent.model}. The conversation was left unchanged.`);
      }
      setCandidate(Object.freeze({
        ...prior,
        models,
        fetchedAt: snapshot.fetchedAt,
        sourceComplete: snapshot.complete,
        managementState: snapshot.sources.management,
        issues: snapshot.issues,
      }));
      if (!models.some((model) => model.id === modelId)) {
        setModelId(requestedModel?.id ?? selection.id);
      }
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
    setEmbeddingOffer(undefined);
    setDetectedKind(undefined);
    setStrictProof(false);
    setStatus(undefined);
    setError(undefined);
    setKeyRefusal(undefined);
    requestAnimationFrame(() => credentialInput.current?.focus());
  }

  async function clearConnection(focusInput: boolean, abandonExactReturn = false) {
    setBusy(true);
    setStatus(focusInput ? "Clearing the active connection before switching…" : "Clearing the active connection…");
    setError(undefined);
    setOauthConnectRetry(false);
    try {
      await onDisconnect();
      clearEphemeral();
      if (abandonExactReturn) {
        setConnectionReleaseConfirmation(undefined);
        onAbandonReconnect();
      }
      setStatus(undefined);
      if (focusInput) {
        /*
         * The entry field only mounts on the API-key tab, so the tab has to
         * move before the focus RAF runs — the same ordering the refused-key
         * path in `activate()` proves. Focusing against the OAuth tab landed
         * on an unmounted input and the focus fell to the document body.
         */
        setChutesMethod("api-key");
        requestAnimationFrame(() => credentialInput.current?.focus());
      }
    } catch (caught) {
      setStatus(undefined);
      setError(mapUnknownRequestFailure(caught, online).message);
    } finally {
      setBusy(false);
    }
  }

  function requestConnectionRelease(action: "switch" | "clear"): void {
    if (reconnectIntent?.lane === "chutes" && chutesReconnectExact) {
      setStatus(undefined);
      setError(undefined);
      setConnectionReleaseConfirmation(action);
      return;
    }
    void clearConnection(action === "switch");
  }

  function cancelConnectionRelease(): void {
    const trigger = connectionReleaseConfirmation === "switch"
      ? switchCredentialButton.current
      : clearConnectionButton.current;
    setConnectionReleaseConfirmation(undefined);
    requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
  }

  /*
   * Re-run a failed OAuth connect leg with the exchange the host still holds.
   * The nonce is in the bootstrap effect's dependency list, so this button
   * alone carries the sign-in journey through discovery and verification
   * again — the credential is never re-typed and Chutes is never re-asked.
   */
  function retryOAuthConnect() {
    setOauthConnectRetry(false);
    setStatus(undefined);
    setError(undefined);
    setOauthBootstrapRetryNonce((value) => value + 1);
  }

  async function selectActiveModel(modelId: string) {
    if (!onSelectModel) return;
    setBusy(true);
    const returning = reconnectIntent?.lane === "chutes"
      && reconnectIntent.model === modelId;
    setStatus(returning
      ? "Verifying the requested conversation against this exact Chutes route…"
      : "Changing to the selected model…");
    setError(undefined);
    try {
      const outcome = await onSelectModel(modelId);
      setStatus(returning
        ? "The requested audited conversation is active."
        : outcome === "in-place"
          ? "Model changed for this conversation in place; the profile default is unchanged."
          : outcome === "confirming-compression"
            ? "Review the compression choice before the model finishes changing."
            : "Model changed in a new pinned session; prior history remains intact.");
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
    const returning = reconnectIntent?.lane === "chutes";
    setStatus(returning
      ? "Verifying the requested conversation against this exact Chutes route…"
      : "Creating a new Chutes-pinned conversation…");
    setError(undefined);
    try {
      await onUseConnection();
      setStatus(returning
        ? "The requested audited conversation is active."
        : "Chutes is active in a new pinned conversation; prior history remains intact.");
    } catch (caught) {
      setStatus(undefined);
      setError(mapUnknownRequestFailure(caught, online).message);
    } finally {
      setBusy(false);
    }
  }

  const capabilities = connectionCapabilities(connection);
  const oauthOrigin = oauthDiagnostic
    ? oauthDiagnostic.configurationError
      ? { available: false, reason: oauthDiagnostic.configurationError }
      : oauthOriginState(oauthDiagnostic.homepageUrl, typeof window === "undefined" ? "" : window.location.href)
    : { available: false, reason: "OAuth registration details are unavailable in this build." };
  /*
   * Sign-in is available only when the registration allows it *and*, where a
   * localhost handler is the exchange, that handler has said it can run. While
   * the probe is in flight neither claim is established, so this reads false
   * and the tab says "Checking" rather than "Primary".
   */
  const handlerBlocked = localOAuthHandler && handlerReadiness?.state === "blocked" ? handlerReadiness.reason : undefined;
  const signInChecking = localOAuthHandler && !handlerReadiness;
  const chutesSignInAvailable = Boolean(oauthDiagnostic)
    && oauthOrigin.available
    && (!localOAuthHandler || handlerReadiness?.state === "ready");
  /**
   * Which sentence names the cause, when there is one.
   *
   * Registration first: a callback that cannot match is true of every build of
   * this origin, while a handler that is not configured is true only of this
   * process. Both are provenance and neither is deleted — the one that applies
   * is the one rendered.
   */
  const signInBlockedReason = oauthOrigin.available ? handlerBlocked : oauthOrigin.reason;
  /*
   * The default is the method that works; the other one stays selectable.
   *
   * This mirrors `initialConnectMethod()` in the connect package, and it is the
   * fix for a lane that could not say why it could not work: the OAuth tab was
   * `disabled` whenever sign-in was unavailable, and the OAuth panel — the only
   * surface that renders `oauthOrigin.reason`, the sentence naming the cause —
   * was therefore unreachable in exactly the deployments that needed it.
   */
  const activeChutesMethod = chutesMethod ?? (chutesSignInAvailable ? "oauth" : "api-key");

  /**
   * The keyboard half of `role="tab"`, which the switch below declared and did
   * not implement. The movement rule is `tabs.tsx`'s `nextTabId`, so there is
   * still exactly one implementation of the tablist contract in the app —
   * `tablist-contract.test.ts` holds that as a fact by requiring every
   * hand-rolled strip to route its keys through `nextTabId`, because the claim
   * was once made in this comment while a fourth strip quietly had its own.
   */
  const moveChutesMethod = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const next = nextTabId(CHUTES_METHOD_TABS, activeChutesMethod, event.key);
    if (next === undefined) return;
    event.preventDefault();
    setChutesMethod(next === "oauth" ? "oauth" : "api-key");
    const tabs = event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    tabs[CHUTES_METHOD_TABS.findIndex((item) => item.id === next)]?.focus();
  };

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
      // Deliberately not the operator sentence: that string is addressed to
      // whoever restarts a companion process. The person reading this needs the
      // next step, and the operator detail stays in the lane's own disclosure.
      ...(chutesSignInAvailable ? {} : { signInUnavailableReason: signInChecking ? `${SIGN_IN_CHECKING}.` : SIGN_IN_UNAVAILABLE }),
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

  /*
   * The notice reports the exchange, and one state falsifies it: a committed
   * connection, after which there is nothing left to say about a handoff that
   * has already become the summary above. Everything else survives — including
   * a failed discovery, because "the sign-in itself worked" is precisely what
   * locates such a failure downstream of Chutes rather than in it.
   *
   * It deliberately does NOT depend on `candidate`. Gating the sentence on the
   * chooser silenced the only confirmation a returning redirect produces for
   * the whole discovery window, and permanently whenever discovery failed; the
   * instruction that made the chooser load-bearing is gone from this copy and
   * now lives once, in `.oauth-finish-banner`, beside the chooser it names.
   */
  const oauthNoticeVisible = oauthNotice !== undefined && !isChutesConnected(connection);
  const chutesReturnRequested = reconnectIntent?.lane === "chutes";
  const chutesReturnBlocked = Boolean(reconnectIntent) && !chutesReconnectExact;

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
        /* The hash without its `#`, which `RouteHeaderProps` asks for and this
           route was the one place not giving: the router emits `#connection`,
           so `access` keyed the ⓘ memory and the `route-…-eyebrow` ids by a
           third name for a destination that already had two. */
        routeId="connection"
        density="tool"
        title={destinationLabel("access")}
        eyebrow={CONNECT_ROUTE_EYEBROW}
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
          {chutesReturnRequested ? (
            <p class={chutesReconnectExact ? "access-reconnect-intent exact" : "access-reconnect-intent blocked"} role="status">
              <Icon name={chutesReconnectExact ? "proof" : "warning"} size={16} />
              <span>{chutesReconnectExact
                ? "The exact pinned Chutes connection is still held in this page. It must pass the conversation audit before continuation."
                : "Exact Chutes connection no longer held. A replacement credential or generation cannot continue the requested conversation, so it remains unchanged."}</span>
              {busy
                ? <span class="access-reconnect-intent__pending" aria-disabled="true">Connection change in progress</span>
                : <button class="access-reconnect-intent__abandon" type="button" onClick={onAbandonReconnect}>Abandon return request</button>}
            </p>
          ) : null}
          {/*
            Above the lanes, not below them. These two lines answer the button a
            person just pressed, and they used to render after every remaining
            lane — 340px past the control, which is not an answer.
          */}
          {status ? <p class="access-live-status" role="status" aria-live="polite"><span />{status}</p> : null}
          {error ? <p class="access-live-error" role="alert"><Icon name="warning" size={16} />{error}</p> : null}
          {/*
            The answer lands where the question failed. A failed OAuth connect
            leg kept its completed exchange, so the recovery is a retry of the
            same leg — not the "Sign in to Chutes" round trip the OAuth panel
            would charge for a credential that already exists.
          */}
          {oauthConnectRetry && error && oauthBootstrap ? (
            <button
              ref={oauthRetryButton}
              type="button"
              disabled={busy || !online}
              onClick={retryOAuthConnect}
            >
              Retry connection
            </button>
          ) : null}

          <ConnectSurface
            input={laneInput}
            reconnectIntent={reconnectIntent}
            onOpenDirectProviders={additionalProviders ? focusDirectProviders : undefined}
            {...(onCheckLocalProviders ? { onCheckLocalProviders } : {})}
            {...(codexSignIn ? { onStartCodexSignIn: codexSignIn.onStart, onSubmitCodexCode: codexSignIn.onSubmitCode } : {})}
            {...(publishedExtensionInstallUrl ? { extensionInstallUrl: publishedExtensionInstallUrl } : {})}
            chutesPanel={chutesReturnBlocked ? null : <>
            {/*
              The OAuth notice, at lane level and in every tone, never behind a
              disclosure. It used to render only inside the page-level boundary
              aside (all tones) and inside the sign-in card (error only), so the
              in-flight and completion messages had a single home on a card that
              no longer exists.
            */}
            {oauthNotice && oauthNoticeVisible ? <p class={`oauth-boundary-status ${oauthNotice.tone}`} role={oauthNotice.tone === "error" ? "alert" : "status"}>{oauthNoticeMessage}</p> : null}
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
                        disabled={busy || Boolean(reconnectIntent) || models.length < 2}
                        onSelect={(modelId) => void selectActiveModel(modelId)}
                      />
                    ) : connection.model}
                  </dd>
                </div>
                <div><dt>Proof policy</dt><dd>{connection.posture === "encrypted-attested" ? "Strict · block unless every required endpoint claim verifies" : "Verify and record fresh evidence · keep unverified claims explicit"}</dd></div>
                <div><dt>Inference authorization</dt><dd>{connection.invokeAuthorization === "verified" ? `Verified by protected request${connection.lastInvokeAt ? ` · ${formatInstant(connection.lastInvokeAt, "minute")}` : ""}` : "Not tested yet"}</dd></div>
                <div><dt>Credential lifetime</dt><dd>Not introspected</dd></div>
                <div><dt>Storage</dt><dd>Page memory only</dd></div>
              </dl>
              <p class="model-pinning-note"><Icon name="proof" size={15} />Changing a model creates a new session manifest. Airship never rewrites the provider or model bound to prior turns.</p>
              <div class="active-connection-actions">
                {onUseConnection && (
                  chutesReturnRequested
                    ? chutesReconnectExact
                    : !reconnectIntent && !connectionActive
                ) ? (
                  <button class="primary" type="button" onClick={() => void useConnectedChutes()} disabled={busy}>
                    {chutesReturnRequested
                      ? "Continue requested conversation"
                      : "Use Chutes in new conversation"}
                  </button>
                ) : null}
                <button
                  ref={switchCredentialButton}
                  type="button"
                  onClick={() => requestConnectionRelease("switch")}
                  disabled={busy || Boolean(connectionReleaseConfirmation)}
                >Switch credential</button>
                <button
                  ref={clearConnectionButton}
                  class="danger"
                  type="button"
                  onClick={() => requestConnectionRelease("clear")}
                  disabled={busy || Boolean(connectionReleaseConfirmation)}
                >Clear connection</button>
              </div>
              {connectionReleaseConfirmation && chutesReturnRequested && chutesReconnectExact ? (
                <div class="access-connection-release-confirmation" role="alert">
                  <span>
                    <strong>{connectionReleaseConfirmation === "switch"
                      ? "Switching would release this exact return route"
                      : "Clearing would release this exact return route"}</strong>
                    <small>The requested conversation stays readable, but this exact Chutes generation cannot be recovered after release. Confirming also abandons the return request.</small>
                  </span>
                  <div>
                    <button ref={connectionReleaseCancel} type="button" onClick={cancelConnectionRelease} disabled={busy}>Keep exact connection</button>
                    <button
                      class="danger"
                      type="button"
                      onClick={() => void clearConnection(connectionReleaseConfirmation === "switch", true)}
                      disabled={busy}
                    >{connectionReleaseConfirmation === "switch" ? "Confirm switch credential" : "Confirm clear connection"}</button>
                  </div>
                </div>
              ) : null}
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
                {/*
                  A padlock and the words "direct session" for a credential
                  nothing has checked.

                  Driven with `cpk_notarealkey…`: the catalog reads are
                  unauthenticated, so a fabricated key reached this row, and the
                  row wore the same lock and the same sentence the *connected*
                  summary uses — while the key itself was refused ten seconds
                  later at Finish with a 401. The candidate says what the
                  candidate is: a credential class read from a prefix, with a
                  seal in the product's own register for asserted-not-verified.
                */}
                <p class="credential-kind-result" role="status">
                  <Seal state="asserted" density="chip" label={candidateCredentialLabel(candidate.credentialKind)} />
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
                  label={`Catalog read ${formatInstant(candidate.fetchedAt, "minute")}. Freshness, optional enrichment${candidate.issues.length > 0 ? `, and ${String(candidate.issues.length)} catalog notice${candidate.issues.length === 1 ? "" : "s"}` : ""}.`}
                  heading="Catalog read"
                  trigger={<><Icon name="proof" size={14} />Catalog read {formatInstant(candidate.fetchedAt, "minute")}</>}
                >
                  <p class={candidate.sourceComplete ? "complete" : "partial"}>{candidate.managementState === "fresh" ? "Inference + management metadata loaded" : candidate.sourceComplete ? "Authoritative inference catalog · management enrichment deferred" : "Partial provider metadata"}</p>
                  {/* The retry is offered for every management state that is
                      not `fresh`. Gating it on `disabled` alone made it
                      unreachable: this view always loads with
                      `includeManagement: true`, so a management read that a
                      person could actually retry lands as `failed`, and the one
                      state the old gate named is the one this route never
                      produces. */}
                  {candidate.managementState !== "fresh" ? <button type="button" onClick={() => void enrichCatalog()} disabled={busy || !online}>Load live availability metadata</button> : null}
                  {candidate.issues.length > 0 ? (
                    <details><summary>{candidate.issues.length} catalog notice{candidate.issues.length === 1 ? "" : "s"}</summary>{candidate.issues.map((issue, index) => <p key={`${issue.source}-${issue.code}-${index}`}>{issue.source}: {issue.message}</p>)}</details>
                  ) : null}
                </Popover>
              </div>
              {/*
                Row 2: the one question a connection actually settles, and only
                when it is a question.

                What stood here was a chat-model picker — `Model`, with the
                whole catalogue's availability, context, modality and trust
                facts attached — as a gate on finishing the connection. The chat
                model is a control in the chat header, changeable per
                conversation and reversible in one press, so requiring it here
                asked for a decision at the moment a person knows least and is
                paying the most friction, and the same control 340px lower in
                the connected summary could already correct it. The picker is
                not deleted; it is where it belongs, and this route stops
                interviewing people on the way to a chat.

                What replaces it appears only when Chutes publishes two or more
                usable embedding deployments. That number is read from Chutes on
                the same press as the model catalogue — it is not written down
                here, and it changes without this repository being touched.
              */}
              {embeddingOffer?.state === "choose" ? (
                <fieldset class="candidate-embedding">
                  <legend>Embedding model</legend>
                  <p class="candidate-embedding__why">
                    Chutes publishes {embeddingOffer.models.length} embedding deployments this build can
                    use, so this one is a choice rather than a fact. It is the model your workspace
                    index is built against if you turn on confidential embeddings — the chat model is
                    chosen in the chat header, not here.
                  </p>
                  <div class="candidate-embedding__options" role="group" aria-label="Chutes embedding deployment">
                    {embeddingOffer.models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        class={embeddingModelId === model.id ? "selected" : ""}
                        aria-pressed={embeddingModelId === model.id}
                        disabled={busy}
                        onClick={() => chooseEmbeddingModel(model.id)}
                      >
                        <strong>{model.id}</strong>
                        {/* Warm or cold is live catalog context for this choice. */}
                        <small>{model.hot ? "Running now" : "Cold · the first request pays a scale-up"}</small>
                      </button>
                    ))}
                  </div>
                  {!embeddingModelId ? <p class="candidate-embedding__required" role="status">Choose one deployment to finish connecting. Airship will use the id returned by Chutes; it will not substitute another one.</p> : null}
                </fieldset>
              ) : null}
              <div class="candidate-decision">
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
                <button class="primary" type="button" onClick={() => void activate()} disabled={busy || (embeddingOffer?.state === "choose" && !embeddingModelId)}>Finish: verify &amp; connect</button>
              </div>
            </div>
          ) : (
                <div class="connection-entry-stack">
                  {/* `role="tab"` obliges the whole widget contract: one tab in
                      the tab order, ←/→/Home/End moving selection and focus,
                      and a panel each tab actually points at. The movement rule
                      is `tabs.tsx`'s, so it is not reimplemented here. */}
                  <div class="connect-method__switch" role="tablist" aria-label="Chutes connection method" onKeyDown={moveChutesMethod}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeChutesMethod === "oauth"}
                      aria-controls="chutes-method-panel-oauth"
                      tabIndex={activeChutesMethod === "oauth" ? 0 : -1}
                      onClick={() => setChutesMethod("oauth")}
                    >
                      <span>OAuth</span>
                      {/*
                        "Primary" is a promise, and it may only be made where
                        the exchange has answered that it can run. Until it
                        does, the tab says it is still asking.
                      */}
                      <small>{chutesSignInAvailable ? "Primary" : signInChecking ? "Checking" : "Unavailable in this build"}</small>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeChutesMethod === "api-key"}
                      aria-controls="chutes-method-panel-api-key"
                      tabIndex={activeChutesMethod === "api-key" ? 0 : -1}
                      onClick={() => setChutesMethod("api-key")}
                    >
                      <span>API key</span>
                      <small>Page memory</small>
                    </button>
                  </div>
                  {activeChutesMethod === "oauth" ? (
                    <section class="oauth-primary-entry" id="chutes-method-panel-oauth" role="tabpanel" aria-labelledby="oauth-primary-title">
                      <Icon name="access" size={22} />
                      <div>
                        <strong id="oauth-primary-title">Sign in to Chutes</strong>
                        <p>{localOAuthHandler
                          ? "Your password never touches Airship. The app secret stays in the localhost process, outside browser JavaScript."
                          : "Your password never touches Airship, and no client secret is used."}</p>
                        {/*
                          The cause, at lane altitude, never behind a disclosure.
                          It used to render only inside the closed
                          `.oauth-mechanism` — and only when the OAuth tab was
                          selected, which was impossible while the tab was
                          `disabled`. A lane that cannot work has to say why
                          where the person is standing, and the way out is a
                          control rather than an instruction.
                        */}
                        {signInChecking ? (
                          <p class="oauth-primary-reason" role="status">{SIGN_IN_CHECKING}…</p>
                        ) : !chutesSignInAvailable ? (
                          <div class="connect-method__blocked" role="alert">
                            {/*
                              The consequence and the route that works, at lane
                              altitude and outside every disclosure. What used
                              to be here instead was the operator's sentence —
                              a restart instruction addressed to whoever runs
                              the lab, given to a person who has just arrived.
                              That sentence is not deleted; it is one rung down
                              in a disclosure that names what it holds.
                            */}
                            <p>
                              <Icon name="warning" size={16} />
                              <span><strong>{SIGN_IN_UNAVAILABLE}</strong> Paste a Chutes API key instead — it works now and stays in page memory.</span>
                            </p>
                            <details class="connect-method__cause">
                              <summary>Why this build cannot sign in</summary>
                              <p>Deployment detail: {signInBlockedReason}</p>
                            </details>
                            {/*
                          Switching to the key lane without moving focus strands
                          the person mid-air: the tab changed, their hands did
                          not follow, and the next Tab stop walked the rest of
                          the blocked panel first. The recovery verb and the
                          field it serves are one motion.
                        */}
                        {/*
                          The panel to focus is the one this button switches
                          *to*, which is a sibling — so `closest()` was the
                          wrong direction even before the attribute it looked
                          for turned out to exist nowhere in the tree, leaving
                          `panel` null and the focus move silently dead. The
                          key lane already has a stable id, and this button's
                          own tab already names it through `aria-controls`.
                        */}
                        <button type="button" onClick={() => {
                          setChutesMethod("api-key");
                          requestAnimationFrame(() => document
                            .getElementById("chutes-method-panel-api-key")
                            ?.querySelector<HTMLInputElement>('input[type="password"], input[type="text"]')
                            ?.focus());
                        }}>Use an API key</button>
                          </div>
                        ) : null}
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
                          // The explanation above is now genuinely reachable —
                          // the tab beside this panel is no longer `disabled`,
                          // so this branch can be rendered rather than only
                          // written. The control that would fail stays gated,
                          // and the route that works is a button above it.
                          disabled={busy || !online || !chutesSignInAvailable}
                          onClick={startChutesSignIn}
                        >
                          Sign in to Chutes
                        </button>
                        {/*
                          Only when the failure is not already the cause the
                          blocked block above is stating. A press that the
                          readiness probe explains renders one consequence and
                          one cause, not two copies of each.
                        */}
                        {oauthDiagnosticError && oauthDiagnosticError !== signInBlockedReason ? <p class="oauth-boundary-status error" role="alert">{oauthDiagnosticError}</p> : null}
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
                  /*
                    Two boxes and three headings used to stand between the tab
                    and the field. `Connect with a Chutes API key` is the tab's
                    own label beside the lane's own title, so it becomes this
                    region's accessible name rather than a fourth rendering of
                    the same three words; the panel's own border is gone because
                    it sat inside the lane card, inside the route card. What is
                    left before the input is the tab you just pressed.
                  */
                  <section class="api-key-alternative" aria-label="Connect with a Chutes API key" id="chutes-method-panel-api-key" role="tabpanel">
                    <form class="credential-entry" onSubmit={(event) => { event.preventDefault(); void discover(); }}>
                      {/*
                        The verdict lands on the field it is about, above the
                        control that has to change. It used to render as a
                        networking banner 400px away while this field silently
                        emptied itself and showed its at-rest format hint —
                        describing a problem the person did not have.
                      */}
                      {keyRefusal ? (
                        <div class="key-refusal" role="alert">
                          <p>
                            <Icon name="warning" size={16} />
                            <span><strong>Chutes did not accept this key.</strong>{" "}
                              {keyRefusal.stage === "key-check"
                                ? "Nothing was listed and no model was shown: the key was offered to Chutes first, and Chutes refused it."
                                : "The catalog is readable without a key, so listing models succeeded; access to the selected model is checked when you connect, and it failed."}{" "}
                              Check the key at <a href={CHUTES_API_KEYS_URL} target="_blank" rel="noreferrer">chutes.ai → API keys ↗</a>, or paste a different one.</span>
                          </p>
                          {/*
                            The provider's own words, verbatim and including the
                            scope name. Not the headline — it answers "what
                            exactly came back", which is a second question.
                          */}
                          <details>
                            <summary>Provider response</summary>
                            <p>{keyRefusal.providerResponse}</p>
                          </details>
                        </div>
                      ) : null}
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
                      {/*
                        The credential class moves below the field it describes,
                        where it is also the live reading of what was typed. Its
                        words are unchanged; it is no longer an 88px bordered
                        tile above the control, and its negative arm is now
                        stated rather than implied by an absent highlight.
                      */}
                      {/*
                        Suppressed while a refusal is showing. This block reads
                        what the *prefix* parsed as, which is a question the
                        provider has already answered more authoritatively — and
                        "Chutes personal keys start with cpk_" beside a
                        well-formed cpk_ that Chutes refused describes a problem
                        the person does not have. It returns the moment the
                        field is edited.
                      */}
                      {keyRefusal ? null : (
                      <div class="credential-types" role="group" aria-label="Optional Chutes API-key connection">
                        <CredentialTypeCard prefix="cpk_" title="Chutes API key" detail="Chutes personal keys start with cpk_. They read models, inference, profile, and account when Chutes authorizes them." active={detectedKind === "inference-api-key"} />
                        {credentialTyped ? (
                          <p class="credential-reading" role="status">{credentialReading(detectedKind, busy, lastAttempt)}</p>
                        ) : null}
                      </div>
                      )}
                      {/*
                        The consequence of "page memory", beside the link that
                        sends someone away to obtain a key.

                        "Held only in page memory" was accurate and was read as
                        a security reassurance rather than as the thing it also
                        is: you will paste this again every time. A novice
                        arrives having been told no account is needed, leaves to
                        make one, comes back, and only discovers the lifetime on
                        the second visit. There is no durable alternative to
                        offer — the Vault deliberately never stores a provider
                        credential — so the honest move is to say so here rather
                        than let the absence read as an oversight.
                      */}
                      <p id="chutes-credential-help">
                        Held only in page memory: a reload or a new tab starts with an empty field
                        and you paste it again. The Vault stores your work and never a provider
                        credential, so there is no durable alternative to choose.{" "}
                        Don’t have one?{" "}
                        <a href={CHUTES_API_KEYS_URL} target="_blank" rel="noreferrer">Create a key at chutes.ai → API keys ↗</a>{" "}
                        Never paste a client secret or administrator credential.
                      </p>
                      {/*
                        The hosts this button reaches, named before it is
                        pressed. Measured from one press on this build: three
                        unauthenticated catalog reads at t=28ms and one logo
                        image per model card at t=4.8s — and the page named none
                        of them anywhere. It is the button's own description, so
                        a screen reader hears it before activating rather than
                        after.
                      */}
                      <p class="credential-preflight" id="chutes-discovery-preflight">
                        <Icon name="cloud" size={16} />{CHUTES_DISCOVERY_PREFLIGHT}
                      </p>
                      <button type="submit" aria-describedby="chutes-discovery-preflight" disabled={busy || !online}>Discover models with key</button>
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

        {/*
          The answer to "what left this device?", which nothing in Airship could
          give. It sits on this route because this is where a person decides
          what to trust with a credential — and because it is the route that
          causes most of the egress it reports.
        */}
        <EgressPanel />
      </div>

      {additionalProviders ? (
        <div id="additional-inference-providers" class="access-additional-providers" role="group" aria-label="Additional cloud and local inference providers" tabIndex={-1}>
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

/*
 * Each sentence states only what its own step established.
 *
 * The completion messages used to append an instruction to pick a model and
 * finish the connection — a sentence about a control this paragraph does not
 * contain, is not adjacent to, and cannot promise exists: discovery runs after
 * the exchange and may fail, and a returning redirect now finishes itself. That
 * next step is stated once, by `.oauth-finish-banner`, which renders only with
 * the chooser it is about. What is left here is the fact of the exchange, which
 * no later step can retract.
 */
function presentOAuthNotice(message: string): string {
  if (message === "oauth:exchange-local") return "Exchanging the code through the localhost handler…";
  if (message === "oauth:exchange-public") return "Exchanging the code with Chutes…";
  if (message === "oauth:complete-local") {
    return "Chutes sign-in complete with S256 PKCE through the localhost handler.";
  }
  if (message === "oauth:complete-public") {
    return "Chutes sign-in complete with S256 PKCE.";
  }
  if (message === "oauth:invalid-local") {
    return "Chutes rejected the localhost app credentials. Restart the lab with its registered process credentials, then sign in again.";
  }
  if (message === "oauth:invalid-public") {
    return "Chutes rejected this Browser/native registration. Its token authentication must be “none”; update it, then sign in again.";
  }
  return message;
}

/*
 * The only text in this cell is a tick or a dash, so the name has to survive.
 *
 * `aria-label` on a bare `<span>` is discarded — ARIA forbids naming an element
 * whose computed role is generic — which left the whole eligibility matrix
 * announcing "✓" and "—". `role="img"` is the smallest role that permits a name
 * and does not claim the mark is interactive; the glyph beneath it is decoration
 * once the word is carried, and the extra element is a no-op inside the
 * `inline-grid` centring `.capability-mark` already applies.
 */
function CapabilityMark({ available }: { available: boolean }) {
  return (
    <span class={available ? "capability-mark available" : "capability-mark"} role="img" aria-label={available ? "Available" : "Unavailable"}>
      <span aria-hidden="true">{available ? "✓" : "—"}</span>
    </span>
  );
}

function credentialKindLabel(kind: ChutesCredentialKind): string {
  return kind === "oauth-user-token" ? "Chutes sign-in · scoped user session" : "Chutes API key · direct session";
}

/**
 * The same credential class, at the altitude where nothing has been proven.
 *
 * `credentialKindLabel` is the *connected* summary's sentence and stays exactly
 * that. A pasted key reaches the chooser without Chutes having been asked about
 * it even once — the catalog is readable unauthenticated — so the chooser may
 * name what was read and must not name a session.
 *
 * The sign-in arm keeps its wording: that exchange did complete, and its own
 * banner says so. What neither arm has yet is invoke authorization, which is
 * why both wear the `asserted` seal until Finish returns.
 */
function candidateCredentialLabel(kind: ChutesCredentialKind): string {
  return kind === "oauth-user-token"
    ? credentialKindLabel(kind)
    : "Chutes API key · not authorized yet";
}

/**
 * What the last attempt did with the key that is still in the field.
 *
 * `sentTo` is read from the egress record — the host a request actually carried
 * this credential to — rather than inferred from which function failed, because
 * "did my key leave?" is the one question this line may not guess at.
 */
export type CredentialAttempt =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "failed"; sentTo?: string }>;

export const NO_CREDENTIAL_ATTEMPT: CredentialAttempt = Object.freeze({ state: "none" });

/** A failed leg, described by what the egress record says it sent. */
function attemptOutcome(since: number): CredentialAttempt {
  const sent = lastCredentialEgress(egressRecorder()?.read() ?? [], since);
  return Object.freeze(sent ? { state: "failed", sentTo: sent.host } : { state: "failed" });
}

/** The prefix verdict alone: the whole of what `parseChutesCredential` reads. */
function credentialPrefixReading(kind: ChutesCredentialKind | undefined): string {
  if (kind === "inference-api-key") return "Read as a Chutes personal key (cpk_).";
  if (kind === "oauth-user-token") return "Read as a Chutes sign-in token (cak_).";
  return "Not read as a Chutes credential. Chutes personal keys start with cpk_.";
}

/**
 * What Airship has read from the field, and what has happened to it since.
 *
 * The prefix is all `parseChutesCredential` inspects, so this may never say
 * "valid": nothing has been offered to Chutes at that point, and a reading that
 * implied acceptance would claim more than the code establishes.
 *
 * `sending` exists because the second half of that sentence stopped being true
 * the moment someone pressed the button: a single click put three requests on
 * the wire at t=28ms to llm.chutes.ai and api.chutes.ai while "Nothing has been
 * sent yet." was still on screen at t=4,384ms. But the requests it names carry
 * `auth=no` — measured on this build, the whole discovery leg is unauthenticated
 * catalog reads and the key goes nowhere until "Finish: verify & connect". So
 * the in-flight arm states both halves: something left, and it was not the key.
 * Under-claiming egress and over-claiming it are the same defect.
 *
 * `attempt` is the third state, and the one the failure path used to lie in.
 * With chutes.ai unreachable this line read "Not read as a Chutes credential.
 * Chutes personal keys start with cpk_." about `cpk_myrealkeypastedcarefully…`,
 * because the failure had emptied the field the line was describing. The field
 * now keeps its value, so the verdict keeps its subject, and the attempt clause
 * names where the key went from the egress record rather than from assumption.
 */
export function credentialReading(
  kind: ChutesCredentialKind | undefined,
  sending = false,
  attempt: CredentialAttempt = NO_CREDENTIAL_ATTEMPT,
): string {
  if (sending) {
    // Names what left, because a reader watching this line is asking about
    // their secret. The key leg now goes first, so this says so: the earlier
    // wording ("your key is not attached to that request") was true of the
    // catalog read and would be false of the request that precedes it.
    return kind === "oauth-user-token"
      ? "Reading the Chutes catalog now; your sign-in token is not attached to that request. Waiting for Chutes to answer."
      : "Your key is on its way to api.chutes.ai now, to ask whether Chutes accepts it. Waiting for Chutes to answer.";
  }
  const prefix = credentialPrefixReading(kind);
  // A key that never parsed has no custody story to tell, and the negative arm
  // is already the whole verdict.
  if (attempt.state === "failed" && kind !== undefined) {
    return attempt.sentTo
      ? `${prefix} It was sent to ${attempt.sentTo} and that attempt failed. It is still in this field.`
      : `${prefix} The last attempt failed before your key was used — it has not left this device, and it is still in this field.`;
  }
  return kind === undefined ? prefix : `${prefix} Nothing has been sent yet.`;
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
