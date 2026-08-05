import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import type { SessionManifest } from "../core/contracts";
import {
  browserInferenceFabric,
  type ActivatedInferenceRoute,
  type BrowserCloudProviderId,
  type BrowserInferenceConnection,
} from "../inference/fabric";
import {
  DEFAULT_LOCAL_MODEL_ORIGINS,
  LM_STUDIO_DEFAULT_ENDPOINT,
  OLLAMA_DEFAULT_ENDPOINT,
  type LocalModelProviderKind,
} from "../inference/local";
import type {
  InferenceModelDescriptor,
  InferenceProviderDescriptor,
  ModelCapability,
} from "../inference/providers";
import { providerBoundaryLabel } from "../inference/transport-boundary-label";
import {
  accessLaneForProvider,
  reconnectRouteDisposition,
  type AccessReconnectIntent,
  type ConnectLaneId,
  type ReconnectRouteDisposition,
} from "./access-intent";
import { BrandLogo, type BrandLogoName } from "./brand-icons";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import "./provider-connections-view.css";

/* This route's boundary sentence moved to a leaf module so the top bar — which
   must not import a deferred route chunk — states the same one. Re-exported at
   its original address so nothing that already asks here has to move. */
export { providerBoundaryLabel };

export type ProviderConnectionsViewProps = Readonly<{
  online: boolean;
  activeBinding?: SessionManifest["inferenceBinding"];
  reconnectIntent?: AccessReconnectIntent;
  onAbandonReconnect(): void;
  onActivate(route: ActivatedInferenceRoute, signal: AbortSignal): Promise<void>;
  onDisconnect(connectionId: string): Promise<void>;
}>;

type ProviderOperationError = Readonly<{
  connectionId: string;
  message: string;
  placement: "connection" | "setup" | "surface";
}>;

const CLOUD_PROVIDER_IDS = Object.freeze([
  "openai",
  "anthropic",
  "xai",
] as const satisfies readonly BrowserCloudProviderId[]);

const PROVIDER_FABRIC_RECONNECT_LANES: ReadonlySet<ConnectLaneId> = new Set([
  "codex",
  "claude",
  "grok",
  "local",
]);

/** Leaves Chutes and companion returns to the surfaces that own those lanes. */
export function providerFabricReconnectIntent(
  intent?: AccessReconnectIntent,
): AccessReconnectIntent | undefined {
  return intent && PROVIDER_FABRIC_RECONNECT_LANES.has(intent.lane) ? intent : undefined;
}

/**
 * The two loopback services, each with the port its own installer uses.
 *
 * The endpoints were retyped here as string literals beside the modules that
 * already export them, and the detail sentence was retyped twice, character for
 * character. The defaults now come from the adapters, so moving a default port
 * cannot leave this card pointing at the old one.
 */
const LOCAL_PROVIDERS: readonly Readonly<{
  kind: LocalModelProviderKind;
  label: string;
  defaultEndpoint: string;
}>[] = Object.freeze([
  Object.freeze({ kind: "ollama" as const, label: "Ollama", defaultEndpoint: OLLAMA_DEFAULT_ENDPOINT }),
  Object.freeze({ kind: "lm-studio" as const, label: "LM Studio", defaultEndpoint: LM_STUDIO_DEFAULT_ENDPOINT }),
]);

const LOCAL_PROVIDER_DETAIL = "Reads the service's live model catalog and only displays capabilities supported by returned evidence.";

/* Cloud setup cards carry the vendor's own mark, the same one the connect
   lanes and the Account tab show, so a person meets one picture per company. */
const CLOUD_PROVIDER_BRANDS: Readonly<Record<(typeof CLOUD_PROVIDER_IDS)[number], BrandLogoName>> = Object.freeze({
  openai: "openai",
  anthropic: "anthropic",
  xai: "xai",
});

const MODEL_CAPABILITY_LABELS: Readonly<Record<ModelCapability, string>> = Object.freeze({
  "text-input": "Text input",
  "text-output": "Text output",
  "image-input": "Vision",
  "audio-input": "Audio input",
  "audio-output": "Audio output",
  "tool-calling": "Tools",
  "parallel-tool-calling": "Parallel tools",
  reasoning: "Reasoning",
  embeddings: "Embeddings",
  "structured-output": "Structured output",
});

export function ProviderConnectionsView({
  online,
  activeBinding,
  reconnectIntent,
  onAbandonReconnect,
  onActivate,
  onDisconnect,
}: ProviderConnectionsViewProps) {
  const [revision, setRevision] = useState(0);
  const [busyConnection, setBusyConnection] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<ProviderOperationError>();
  const abort = useRef<AbortController>();
  const focusNoticeAfterRemoval = useRef(false);
  const noticeElement = useRef<HTMLDivElement>(null);
  const connections = useMemo(() => browserInferenceFabric.list(), [revision]);
  const cloudProviders = useMemo(
    () => CLOUD_PROVIDER_IDS.map((id) => browserInferenceFabric.providers.require(id).provider),
    [],
  );
  const fabricReconnectIntent = providerFabricReconnectIntent(reconnectIntent);
  const reconnectDispositions = reconnectIntent
    ? new Map(connections.map((entry) => [
        entry.connection.id,
        providerReconnectDisposition(reconnectIntent, entry),
      ] as const))
    : undefined;
  const exactReconnectHeld = reconnectDispositions
    ? [...reconnectDispositions.values()].some((disposition) => disposition === "exact")
    : false;

  useEffect(() => browserInferenceFabric.subscribe(() => setRevision((value) => value + 1)), []);
  useEffect(() => () => abort.current?.abort(new DOMException("Connection view closed.", "AbortError")), []);
  useEffect(() => {
    if (!focusNoticeAfterRemoval.current || !notice) return;
    focusNoticeAfterRemoval.current = false;
    const frame = requestAnimationFrame(() => noticeElement.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [notice, revision]);

  async function run(
    id: string,
    work: (signal: AbortSignal) => Promise<void>,
    requiresInternet = true,
    errorPlacement: ProviderOperationError["placement"] = "surface",
  ): Promise<boolean> {
    /*
     * Route activation crosses the provider probe and the App's immutable
     * session commit. It is not safe to supersede that transaction merely by
     * aborting its discovery signal: the session commit may already be in
     * progress. Use a synchronous admission fence in addition to rendered
     * disabled state so two click events in one frame cannot overlap.
     */
    if (abort.current) return false;
    const controller = new AbortController();
    abort.current = controller;
    setBusyConnection(id);
    setNotice(undefined);
    setError(undefined);
    try {
      await work(controller.signal);
      return true;
    } catch (caught) {
      if (!controller.signal.aborted) {
        setNotice(undefined);
        setError({
          connectionId: id,
          message: safeProviderErrorMessage(caught, requiresInternet ? online : true),
          placement: errorPlacement,
        });
      }
      return false;
    } finally {
      if (abort.current === controller) {
        abort.current = undefined;
        setBusyConnection(undefined);
      }
    }
  }

  return (
    <section
      class="provider-fabric"
      aria-labelledby="provider-fabric-title"
      aria-busy={Boolean(busyConnection)}
    >
      <header class="provider-fabric__heading">
        <div>
          <span>Provider fabric</span>
          <h2 id="provider-fabric-title">Cloud and local models</h2>
          <p>Keep multiple providers in page memory. Every conversation remains pinned to the exact connection generation and model that created it.</p>
        </div>
        <span class="provider-fabric__count">{providerConnectionCountLabel(connections.length)}</span>
      </header>

      {fabricReconnectIntent ? (
        <div
          class={`provider-fabric__notice provider-fabric__return provider-fabric__return--${exactReconnectHeld ? "exact" : "blocked"}`}
          role="status"
        >
          <span aria-hidden="true" />
          <p>{exactReconnectHeld
            ? "The exact pinned connection is still held in this page. Only that route can continue the requested conversation."
            : "Exact connection no longer held. A replacement provider credential or generation cannot continue the requested conversation, so it remains unchanged."}</p>
          {busyConnection
            ? <span class="provider-fabric__return-pending" aria-disabled="true">Connection change in progress</span>
            : <button class="provider-fabric__return-abandon" type="button" onClick={onAbandonReconnect}>Abandon return request</button>}
        </div>
      ) : null}

      {connections.length ? (
        <div class="provider-fabric__connections" role="group" aria-label="Connected inference providers">
          {connections.map((entry) => {
            const active = isActiveConnection(entry, activeBinding);
            const reconnectDisposition = reconnectDispositions?.get(entry.connection.id);
            const reconnects = fabricReconnectIntent && reconnectDisposition === "exact"
              ? fabricReconnectIntent
              : undefined;
            const targetAvailable = fabricReconnectIntent
              && accessLaneForProvider(entry.provider.id) === fabricReconnectIntent.lane
              && entry.models.some((model) => model.id === fabricReconnectIntent.model);
            return (
              <ConnectedProvider
                key={`${entry.connection.id}:${entry.connection.generation}`}
                entry={entry}
                activeBinding={activeBinding}
                targetModelId={targetAvailable ? fabricReconnectIntent.model : undefined}
                returningToConversation={Boolean(reconnects)}
                reconnectDisposition={reconnectDisposition}
                activationError={reconnects
                  && error?.placement === "connection"
                  && error.connectionId === entry.connection.id
                  ? error.message
                  : undefined}
                busy={busyConnection === entry.connection.id}
                disabled={Boolean(busyConnection)}
                onActivate={(modelId) => run(entry.connection.id, async (signal) => {
                  setNotice(`Checking ${entry.provider.label}/${modelId} through this exact connection…`);
                  const route = await browserInferenceFabric.activate(entry.connection.id, modelId, signal);
                  await onActivate(route, signal);
                  signal.throwIfAborted();
                  setNotice(reconnects
                    ? `${entry.provider.label}/${modelId} restored the requested conversation's exact inference route.`
                    : `${entry.provider.label}/${modelId} is active in a new pinned conversation.`);
                }, entry.provider.transportBoundary !== "loopback-local", reconnects ? "connection" : "surface")}
                onDisconnect={() => run(entry.connection.id, async () => {
                  await onDisconnect(entry.connection.id);
                  focusNoticeAfterRemoval.current = true;
                  setError(undefined);
                  setNotice(active
                    ? `${entry.provider.label} was released from page memory. This conversation remains readable and permanently pinned to that released generation; another connection starts a new conversation.`
                    : `${entry.provider.label} was released from page memory. Existing conversations were not rewritten.`);
                }, false)}
              />
            );
          })}
        </div>
      ) : (
        <p class="provider-fabric__empty">No additional provider is connected. Chutes connection controls remain available above.</p>
      )}

      <div class="provider-fabric__setup">
        <section aria-labelledby="cloud-provider-setup-title">
          <div class="provider-fabric__subheading">
            <div><span>Remote</span><h3 id="cloud-provider-setup-title">Cloud providers</h3></div>
            <small>API-key methods · page memory</small>
          </div>
          <details class="provider-fabric__cloud-disclosure" open>
            <summary>
              <span>Configure cloud API keys</span>
              <small>{cloudProviders.length} provider adapters · credentials stay in page memory</small>
            </summary>
            <div class="provider-fabric__cloud-grid">
              {cloudProviders.map((provider) => {
                const connected = connections.some((entry) => entry.provider.id === provider.id);
                return (
                  <CloudProviderCard
                    key={provider.id}
                    cardId={`provider-setup-${provider.id}`}
                    provider={provider}
                    online={online}
                    connected={connected}
                    busy={busyConnection === provider.id}
                    disabled={Boolean(busyConnection)}
                    connectionError={error?.placement === "setup" && error.connectionId === provider.id
                      ? error.message
                      : undefined}
                    onConnect={(apiKey) => run(provider.id, async (signal) => {
                      setNotice(`Reading the live ${provider.label} model catalog…`);
                      await browserInferenceFabric.connectCloud({
                        providerId: provider.id as BrowserCloudProviderId,
                        apiKey,
                        acknowledgeDirectBrowserCredentialRisk: true,
                        signal,
                      });
                      setNotice(`${provider.label} is connected in page memory. Select a model to check invocation and create a pinned conversation.`);
                    }, true, "setup")}
                  />
                );
              })}
            </div>
          </details>
        </section>

        <section aria-labelledby="local-provider-setup-title">
          <div class="provider-fabric__subheading">
            <div><span>On this machine</span><h3 id="local-provider-setup-title">Local model servers</h3></div>
            <small>No remote account</small>
          </div>
          <div class="provider-fabric__local-grid">
            {LOCAL_PROVIDERS.map((provider) => (
              <LocalProviderCard
                key={provider.kind}
                id={provider.kind}
                label={provider.label}
                defaultEndpoint={provider.defaultEndpoint}
                detail={LOCAL_PROVIDER_DETAIL}
                connected={connections.some((entry) => entry.provider.id === provider.kind)}
                busy={busyConnection === provider.kind}
                disabled={Boolean(busyConnection)}
                onConnect={(endpoint) => run(provider.kind, async (signal) => {
                  setNotice(`Checking ${provider.label} at ${endpoint} and reading its installed-model evidence…`);
                  const connected = await browserInferenceFabric.connectLocal({ kind: provider.kind, options: { endpoint }, signal });
                  const firstModel = connected.models[0];
                  if (!firstModel) throw new Error(`${provider.label} answered but published no selectable models.`);
                  const route = await browserInferenceFabric.activate(connected.connection.id, firstModel.id, signal);
                  await onActivate(route, signal);
                  setNotice(`${provider.label}/${firstModel.label} is active directly over this machine's loopback interface at ${endpoint}.`);
                }, false)}
              />
            ))}
          </div>
          <details class="provider-fabric__local-requirements">
            <summary>Local connection requirements</summary>
            {/* This said "Airship checks only the exact loopback defaults shown
                here", and the card offered no way to change them — so the one
                configuration `DEFAULT_LOCAL_MODEL_ORIGINS` went out of its way
                to permit, a second Ollama on `OLLAMA_HOST=:11435`, was
                unreachable from the product that ships its origin in the CSP.
                The list is rendered from that constant rather than retyped:
                twelve origins also appear as exact `connect-src` sources in
                index.html and public/_headers, and a prose copy of an
                allowlist is a copy that goes stale silently. */}
            <p><Icon name="lock" size={15} />Airship connects only to the loopback origins in its shipped allowlist. Any other host, including a private-LAN address, is refused before a request leaves the page. Your browser and local service must still allow this Airship origin through CORS and browser local-network access.</p>
            <p>{DEFAULT_LOCAL_MODEL_ORIGINS.join(" · ")}</p>
            <p><strong>LM Studio Local Server:</strong> load a model (Developer tab), start the Local Server on port <code>1234</code>, and in Server Settings turn on <strong>Serve on Local Network</strong> and <strong>Enable CORS</strong>. The model then answers on the loopback origin listed above.</p>
          </details>
        </section>
      </div>

      {notice ? (
        <div ref={noticeElement} class="provider-fabric__notice" role="status" aria-live="polite" tabIndex={-1}>
          <span aria-hidden="true" />
          <p>{notice}</p>
        </div>
      ) : null}
      {error?.placement === "surface"
        ? <p class="provider-fabric__error" role="alert"><Icon name="warning" size={16} />{error.message}</p>
        : null}
    </section>
  );
}

function ConnectedProvider({
  entry,
  activeBinding,
  targetModelId,
  returningToConversation,
  reconnectDisposition,
  activationError,
  busy,
  disabled,
  onActivate,
  onDisconnect,
}: Readonly<{
  entry: BrowserInferenceConnection;
  activeBinding?: SessionManifest["inferenceBinding"];
  targetModelId?: string;
  returningToConversation: boolean;
  reconnectDisposition?: ReconnectRouteDisposition;
  activationError?: string;
  busy: boolean;
  disabled: boolean;
  onActivate(modelId: string): Promise<unknown>;
  onDisconnect(): Promise<unknown>;
}>) {
  const titleId = useId();
  const disconnectNoticeId = useId();
  const returnProtectionId = useId();
  const activationErrorId = useId();
  const activeModel = isActiveConnection(entry, activeBinding) ? activeBinding?.modelId : undefined;
  const [modelId, setModelId] = useState(
    targetModelId ?? activeModel ?? entry.models[0]?.id ?? "",
  );
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const continuesRequestedConversation = returningToConversation && modelId === targetModelId;
  const returnBlocked = reconnectDisposition !== undefined && reconnectDisposition !== "exact";
  const protectsReturn = reconnectDisposition === "exact";
  const selected = entry.models.find((model) => model.id === modelId);
  const supported = selected ? supportedModelCapabilityLabels(selected) : [];

  useEffect(() => {
    setModelId((current) => {
      if (targetModelId && entry.models.some((model) => model.id === targetModelId)) return targetModelId;
      if (activeModel && entry.models.some((model) => model.id === activeModel)) return activeModel;
      return entry.models.some((model) => model.id === current) ? current : entry.models[0]?.id ?? "";
    });
    setDisconnectArmed(false);
  }, [activeModel, entry.connection.generation, entry.models, targetModelId]);

  return (
    <article
      class={activeModel ? "provider-connection active" : "provider-connection"}
      aria-labelledby={titleId}
    >
      <header>
        <div>
          <span>{entry.provider.transportBoundary === "loopback-local" ? "Local" : "Cloud"}</span>
          <h3 id={titleId}>{entry.provider.label}</h3>
        </div>
        <span class={`provider-health ${entry.connection.health.state}`}>
          {connectionHealthLabel(entry.connection.health.state)}
        </span>
      </header>
      <dl>
        <div><dt>Connection</dt><dd>{entry.connection.label}</dd></div>
        <div><dt>Credential</dt><dd>{entry.connection.authKind === "local-none" ? "None · loopback" : "Page memory only"}</dd></div>
        <div><dt>Boundary</dt><dd>{providerBoundaryLabel(entry.provider.transportBoundary)}</dd></div>
      </dl>
      <MenuSelect
        ariaLabel={`${entry.provider.label} model for ${returningToConversation ? "the requested conversation" : "a new pinned conversation"}`}
        value={modelId}
        placement="down"
        disabled={disabled || reconnectDisposition !== undefined || entry.models.length === 0}
        options={entry.models.map((model) => ({
          value: model.id,
          label: model.label,
          description: modelOptionDescription(model),
        }))}
        onChange={(nextModel) => {
          setDisconnectArmed(false);
          setModelId(nextModel);
        }}
      />
      <div class="provider-capabilities" role="group" aria-label="Capabilities supported by source evidence for the selected model">
        {supported.length
          ? supported.slice(0, 6).map((capability) => <span key={capability}>{capability}</span>)
          : <span>No capabilities confirmed by source evidence</span>}
        {supported.length > 6 ? <span>+{supported.length - 6} more</span> : null}
      </div>
      {protectsReturn ? (
        <p id={returnProtectionId} class="provider-disconnect-warning" role="status">
          This exact connection is held for the requested conversation. Abandon the return request before disconnecting it.
        </p>
      ) : disconnectArmed ? (
        <p id={disconnectNoticeId} class="provider-disconnect-warning" role="status">
          This conversation stays readable and permanently pinned to this generation. Another connection starts a new conversation.
        </p>
      ) : null}
      <footer>
        <button
          type="button"
          disabled={!modelId || disabled || returnBlocked || (activeModel === modelId && !continuesRequestedConversation)}
          aria-current={activeModel === modelId && !continuesRequestedConversation ? "true" : undefined}
          aria-describedby={activationError ? activationErrorId : undefined}
          onClick={() => void onActivate(modelId)}
        >
          {busy
            ? "Checking invocation…"
            : reconnectDisposition === "replacement"
              ? "Exact connection no longer held"
              : reconnectDisposition === "unrelated"
                ? "Return request active"
            : continuesRequestedConversation
              ? "Continue requested conversation"
              : activeModel === modelId
                ? "Current conversation"
                : "Use in new conversation"}
        </button>
        <button
          type="button"
          class={disconnectArmed ? "danger" : "quiet"}
          disabled={disabled || protectsReturn}
          aria-describedby={protectsReturn ? returnProtectionId : disconnectArmed ? disconnectNoticeId : undefined}
          onClick={() => {
            if (activeModel && !disconnectArmed) {
              setDisconnectArmed(true);
              return;
            }
            void onDisconnect();
          }}
        >
          {protectsReturn ? "Connection held for requested return" : disconnectArmed ? "Confirm disconnect" : "Disconnect"}
        </button>
      </footer>
      {activationError ? (
        <p id={activationErrorId} class="provider-fabric__error provider-connection__activation-error" role="alert">
          <Icon name="warning" size={16} />{activationError}
        </p>
      ) : null}
    </article>
  );
}

export function providerReconnectDisposition(
  intent: AccessReconnectIntent,
  entry: BrowserInferenceConnection,
): ReconnectRouteDisposition {
  const targetAvailable = entry.models.some((model) => model.id === intent.model);
  return reconnectRouteDisposition(intent, {
    lane: accessLaneForProvider(entry.provider.id),
    method: entry.connection.authKind === "oauth-public-pkce"
      ? "oauth-pkce"
      : entry.connection.authKind,
    model: targetAvailable ? intent.model : "",
    connectionId: entry.connection.id,
    connectionGeneration: entry.connection.generation,
  });
}

function CloudProviderCard({
  cardId,
  provider,
  online,
  connected,
  busy,
  disabled,
  connectionError,
  onConnect,
}: Readonly<{
  cardId: string;
  provider: InferenceProviderDescriptor;
  online: boolean;
  connected: boolean;
  busy: boolean;
  disabled: boolean;
  connectionError?: string;
  onConnect(apiKey: string): Promise<boolean>;
}>) {
  const inputId = useId();
  const riskId = useId();
  const errorId = useId();
  const keyInput = useRef<HTMLInputElement>(null);
  const [hasKey, setHasKey] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const apiKeyMethod = provider.authMethods.find((method) => method.kind === "api-key");

  if (!apiKeyMethod || apiKeyMethod.kind !== "api-key") return null;

  return (
    <article id={cardId} class="provider-setup-card" tabIndex={-1}>
      <header>
        {provider.id in CLOUD_PROVIDER_BRANDS
          ? <BrandLogo name={CLOUD_PROVIDER_BRANDS[provider.id as (typeof CLOUD_PROVIDER_IDS)[number]]} size={18} />
          : <Icon name="model" size={18} />}
        <div><h4>{provider.label}</h4><span>API key · page memory</span></div>
      </header>
      <details class="provider-auth-contract">
        <summary>Why API key instead of OAuth?</summary>
        <p>{provider.oauth.detail}</p>
      </details>
      <label class="provider-key-field" for={inputId}>
        <span>{apiKeyMethod.label} · page memory only</span>
        <input
          ref={keyInput}
          id={inputId}
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          inputMode="text"
          spellcheck={false}
          aria-describedby={connectionError ? `${riskId} ${errorId}` : riskId}
          disabled={connected || disabled}
          onInput={(event) => setHasKey(Boolean(event.currentTarget.value.trim()))}
          placeholder="Paste credential"
        />
      </label>
      <label class="provider-risk-check" id={riskId}>
        <input
          type="checkbox"
          checked={accepted}
          disabled={connected || disabled}
          onChange={(event) => setAccepted(event.currentTarget.checked)}
        />
        <span>I accept this browser-direct credential boundary. {apiKeyMethod.warning}</span>
      </label>
      <button
        type="button"
        disabled={connected || !online || disabled || !accepted || !hasKey}
        aria-describedby={connectionError ? errorId : undefined}
        onClick={() => {
          const key = keyInput.current?.value ?? "";
          void onConnect(key).then((succeeded) => {
            if (!succeeded) {
              keyInput.current?.focus();
              return;
            }
            if (keyInput.current) keyInput.current.value = "";
            setHasKey(false);
            setAccepted(false);
          });
        }}
      >
        {connected ? "Connected above" : busy ? "Connecting…" : `Connect ${provider.label}`}
      </button>
      {connectionError ? (
        <p id={errorId} class="provider-fabric__error provider-setup-card__error" role="alert">
          <Icon name="warning" size={16} />
          <span>{connectionError} Your credential and acknowledgement were kept. Correct the problem, then try again.</span>
        </p>
      ) : null}
    </article>
  );
}

/**
 * The endpoint is a field, not a printed constant.
 *
 * This card rendered the default origin in a `<code>` and dialled it, so the
 * connection was hard-pinned to 2 of the 12 loopback origins this build ships
 * and permits in its CSP. A developer running a second Ollama on
 * `OLLAMA_HOST=:11435` — the single configuration `DEFAULT_LOCAL_MODEL_ORIGINS`
 * names as the reason it enumerates ports at all — had no field, no slash
 * command and no preference anywhere in the product to reach it.
 *
 * The value is free text with the allowlist offered as suggestions rather than
 * a picker of twelve: `resolveLocalEndpoint` already fails closed and names the
 * origin it refused, so a typed private-LAN host produces that diagnostic,
 * which teaches the boundary. A picker could only hide it.
 */
function LocalProviderCard({
  id,
  label,
  defaultEndpoint,
  detail,
  connected,
  busy,
  disabled,
  onConnect,
}: Readonly<{
  id: string;
  label: string;
  defaultEndpoint: string;
  detail: string;
  connected: boolean;
  busy: boolean;
  disabled: boolean;
  onConnect(endpoint: string): Promise<unknown>;
}>) {
  const endpointId = useId();
  const originsId = useId();
  const [endpoint, setEndpoint] = useState(defaultEndpoint);

  return (
    <article class="provider-setup-card local" data-provider={id}>
      <header><Icon name="terminal" size={18} /><div><h4>{label}</h4></div></header>
      <p>{detail}</p>
      {/* `.provider-key-field` is the cloud card's field layout: one caption
          over one full-width control at `--density-control` height. Reused
          rather than reinvented so the two setup cards do not grow two answers
          to "how tall is a field on a phone". */}
      <label class="provider-key-field" for={endpointId}>
        <span>Endpoint · loopback allowlist only</span>
        <input
          id={endpointId}
          type="url"
          list={originsId}
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellcheck={false}
          value={endpoint}
          disabled={connected || disabled}
          onInput={(event) => setEndpoint(event.currentTarget.value)}
        />
      </label>
      <datalist id={originsId}>
        {DEFAULT_LOCAL_MODEL_ORIGINS.map((origin) => <option key={origin} value={origin} />)}
      </datalist>
      <button
        type="button"
        disabled={connected || disabled || !endpoint.trim()}
        onClick={() => void onConnect(endpoint.trim())}
      >
        {connected ? "Connected above" : busy ? "Checking…" : `Check ${label}`}
      </button>
    </article>
  );
}

export function providerConnectionCountLabel(count: number): string {
  return `${count} connection${count === 1 ? "" : "s"}`;
}

export function supportedModelCapabilityLabels(
  model: Pick<InferenceModelDescriptor, "capabilities">,
): readonly string[] {
  return Object.entries(model.capabilities)
    .filter((entry): entry is [ModelCapability, NonNullable<(typeof entry)[1]>] =>
      entry[1]?.state === "supported" && entry[0] in MODEL_CAPABILITY_LABELS)
    .map(([capability]) => MODEL_CAPABILITY_LABELS[capability]);
}

export function modelOptionDescription(
  model: Pick<InferenceModelDescriptor, "capabilities" | "availability" | "source">,
): string {
  const capabilities = supportedModelCapabilityLabels(model);
  const evidence = modelSourceLabel(model.source.kind);
  const availability = model.availability.state === "available"
    ? "available"
    : model.availability.state === "unavailable"
      ? "unavailable"
      : "availability unknown";
  return capabilities.length
    ? `${evidence} · ${availability} · ${capabilities.join(" · ")}`
    : `${evidence} · ${availability} · no capabilities confirmed by source evidence`;
}

export function safeProviderErrorMessage(error: unknown, online: boolean): string {
  if (!online) return "Offline · remote provider checks are paused; local state was kept.";
  const raw = error instanceof Error ? error.message : "";
  if (!raw) return "The connection operation failed safely. No remote success was assumed.";
  const redacted = raw
    .replace(/\bBearer\s+\S+/giu, "Bearer [credential]")
    .replace(/\b(?:c[ap]k|sk|xai|api)[_-][A-Za-z0-9._-]{8,}/giu, "[credential]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!redacted) return "The connection operation failed safely. No remote success was assumed.";
  return redacted.length > 320 ? `${redacted.slice(0, 317)}…` : redacted;
}

function isActiveConnection(
  entry: BrowserInferenceConnection,
  activeBinding?: SessionManifest["inferenceBinding"],
): boolean {
  return activeBinding?.connectionId === entry.connection.id
    && activeBinding.connectionGeneration === entry.connection.generation;
}

function connectionHealthLabel(
  health: BrowserInferenceConnection["connection"]["health"]["state"],
): string {
  switch (health) {
    case "ready": return "Ready";
    case "degraded": return "Degraded";
    case "offline": return "Offline";
    case "expired": return "Expired";
    case "unchecked": return "Unchecked";
  }
}

function modelSourceLabel(source: InferenceModelDescriptor["source"]["kind"]): string {
  switch (source) {
    case "provider-directory": return "Provider directory";
    case "local-discovery": return "Local discovery";
    case "live-probe": return "Live probe";
    case "manual": return "Manual metadata";
  }
}
