import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import type { SessionManifest } from "../core/contracts";
import {
  browserInferenceFabric,
  type ActivatedInferenceRoute,
  type BrowserCloudProviderId,
  type BrowserInferenceConnection,
} from "../inference/fabric";
import type {
  InferenceModelDescriptor,
  InferenceProviderDescriptor,
  ModelCapability,
} from "../inference/providers";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import "./provider-connections-view.css";

export type ProviderConnectionsViewProps = Readonly<{
  online: boolean;
  activeBinding?: SessionManifest["inferenceBinding"];
  onActivate(route: ActivatedInferenceRoute): Promise<void>;
  onDisconnect(connectionId: string): Promise<void>;
}>;

const CLOUD_PROVIDER_IDS = Object.freeze([
  "openai",
  "anthropic",
  "xai",
] as const satisfies readonly BrowserCloudProviderId[]);

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
  onActivate,
  onDisconnect,
}: ProviderConnectionsViewProps) {
  const [revision, setRevision] = useState(0);
  const [busyConnection, setBusyConnection] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController>();
  const focusNoticeAfterRemoval = useRef(false);
  const noticeElement = useRef<HTMLDivElement>(null);
  const connections = useMemo(() => browserInferenceFabric.list(), [revision]);
  const cloudProviders = useMemo(
    () => CLOUD_PROVIDER_IDS.map((id) => browserInferenceFabric.providers.require(id).provider),
    [],
  );

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
  ) {
    /*
     * Route activation crosses the provider probe and the App's immutable
     * session commit. It is not safe to supersede that transaction merely by
     * aborting its discovery signal: the session commit may already be in
     * progress. Use a synchronous admission fence in addition to rendered
     * disabled state so two click events in one frame cannot overlap.
     */
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusyConnection(id);
    setNotice(undefined);
    setError(undefined);
    try {
      await work(controller.signal);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setNotice(undefined);
        setError(safeProviderErrorMessage(caught, requiresInternet ? online : true));
      }
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

      {connections.length ? (
        <div class="provider-fabric__connections" role="group" aria-label="Connected inference providers">
          {connections.map((entry) => {
            const active = isActiveConnection(entry, activeBinding);
            return (
              <ConnectedProvider
                key={`${entry.connection.id}:${entry.connection.generation}`}
                entry={entry}
                activeBinding={activeBinding}
                busy={busyConnection === entry.connection.id}
                disabled={Boolean(busyConnection)}
                onActivate={(modelId) => run(entry.connection.id, async (signal) => {
                  setNotice(`Checking ${entry.provider.label}/${modelId} through this exact connection…`);
                  const route = await browserInferenceFabric.activate(entry.connection.id, modelId, signal);
                  await onActivate(route);
                  signal.throwIfAborted();
                  setNotice(`${entry.provider.label}/${modelId} is active in a new pinned conversation.`);
                }, entry.provider.transportBoundary !== "loopback-local")}
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
                    onConnect={(apiKey) => run(provider.id, async (signal) => {
                      setNotice(`Reading the live ${provider.label} model catalog…`);
                      await browserInferenceFabric.connectCloud({
                        providerId: provider.id as BrowserCloudProviderId,
                        apiKey,
                        acknowledgeDirectBrowserCredentialRisk: true,
                        signal,
                      });
                      setNotice(`${provider.label} is connected in page memory. Select a model to check invocation and create a pinned conversation.`);
                    })}
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
            <LocalProviderCard
              id="ollama"
              label="Ollama"
              endpoint="http://127.0.0.1:11434"
              detail="Reads the service's live model catalog and only displays capabilities supported by returned evidence."
              connected={connections.some((entry) => entry.provider.id === "ollama")}
              busy={busyConnection === "ollama"}
              disabled={Boolean(busyConnection)}
              onConnect={() => run("ollama", async (signal) => {
                setNotice("Checking Ollama and reading its installed-model evidence…");
                await browserInferenceFabric.connectLocal({ kind: "ollama", signal });
                setNotice("Ollama is connected directly over this machine's loopback interface.");
              }, false)}
            />
            <LocalProviderCard
              id="lm-studio"
              label="LM Studio"
              endpoint="http://127.0.0.1:1234"
              detail="Reads the service's live model catalog and only displays capabilities supported by returned evidence."
              connected={connections.some((entry) => entry.provider.id === "lm-studio")}
              busy={busyConnection === "lm-studio"}
              disabled={Boolean(busyConnection)}
              onConnect={() => run("lm-studio", async (signal) => {
                setNotice("Checking LM Studio and reading its installed-model evidence…");
                await browserInferenceFabric.connectLocal({ kind: "lm-studio", signal });
                setNotice("LM Studio is connected directly over this machine's loopback interface.");
              }, false)}
            />
          </div>
          <details class="provider-fabric__local-requirements">
            <summary>Local connection requirements</summary>
            <p><Icon name="lock" size={15} />Airship checks only the exact loopback defaults shown here. Your browser and local service must allow this Airship origin through CORS and browser local-network access. Private-LAN hosts are not enabled in this build.</p>
          </details>
        </section>
      </div>

      {notice ? (
        <div ref={noticeElement} class="provider-fabric__notice" role="status" aria-live="polite" tabIndex={-1}>
          <span aria-hidden="true" />
          <p>{notice}</p>
        </div>
      ) : null}
      {error ? <p class="provider-fabric__error" role="alert"><Icon name="warning" size={16} />{error}</p> : null}
    </section>
  );
}

function ConnectedProvider({
  entry,
  activeBinding,
  busy,
  disabled,
  onActivate,
  onDisconnect,
}: Readonly<{
  entry: BrowserInferenceConnection;
  activeBinding?: SessionManifest["inferenceBinding"];
  busy: boolean;
  disabled: boolean;
  onActivate(modelId: string): Promise<void>;
  onDisconnect(): Promise<void>;
}>) {
  const titleId = useId();
  const disconnectNoticeId = useId();
  const activeModel = isActiveConnection(entry, activeBinding) ? activeBinding?.modelId : undefined;
  const [modelId, setModelId] = useState(activeModel ?? entry.models[0]?.id ?? "");
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const selected = entry.models.find((model) => model.id === modelId);
  const supported = selected ? supportedModelCapabilityLabels(selected) : [];

  useEffect(() => {
    setModelId((current) => {
      if (activeModel && entry.models.some((model) => model.id === activeModel)) return activeModel;
      return entry.models.some((model) => model.id === current) ? current : entry.models[0]?.id ?? "";
    });
    setDisconnectArmed(false);
  }, [activeModel, entry.connection.generation, entry.models]);

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
        ariaLabel={`${entry.provider.label} model for a new pinned conversation`}
        value={modelId}
        placement="down"
        disabled={disabled || entry.models.length === 0}
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
      {disconnectArmed ? (
        <p id={disconnectNoticeId} class="provider-disconnect-warning" role="status">
          This conversation stays readable and permanently pinned to this generation. Another connection starts a new conversation.
        </p>
      ) : null}
      <footer>
        <button
          type="button"
          disabled={!modelId || disabled || activeModel === modelId}
          aria-current={activeModel === modelId ? "true" : undefined}
          onClick={() => void onActivate(modelId)}
        >
          {busy ? "Checking invocation…" : activeModel === modelId ? "Current conversation" : "Use in new conversation"}
        </button>
        <button
          type="button"
          class={disconnectArmed ? "danger" : "quiet"}
          disabled={disabled}
          aria-describedby={disconnectArmed ? disconnectNoticeId : undefined}
          onClick={() => {
            if (activeModel && !disconnectArmed) {
              setDisconnectArmed(true);
              return;
            }
            void onDisconnect();
          }}
        >
          {disconnectArmed ? "Confirm disconnect" : "Disconnect"}
        </button>
      </footer>
    </article>
  );
}

function CloudProviderCard({
  cardId,
  provider,
  online,
  connected,
  busy,
  disabled,
  onConnect,
}: Readonly<{
  cardId: string;
  provider: InferenceProviderDescriptor;
  online: boolean;
  connected: boolean;
  busy: boolean;
  disabled: boolean;
  onConnect(apiKey: string): Promise<void>;
}>) {
  const inputId = useId();
  const riskId = useId();
  const keyInput = useRef<HTMLInputElement>(null);
  const [hasKey, setHasKey] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const apiKeyMethod = provider.authMethods.find((method) => method.kind === "api-key");

  if (!apiKeyMethod || apiKeyMethod.kind !== "api-key") return null;

  return (
    <article id={cardId} class="provider-setup-card" tabIndex={-1}>
      <header>
        <Icon name="model" size={18} />
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
          aria-describedby={riskId}
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
        onClick={() => {
          const key = keyInput.current?.value ?? "";
          if (keyInput.current) keyInput.current.value = "";
          setHasKey(false);
          setAccepted(false);
          void onConnect(key);
        }}
      >
        {connected ? "Connected above" : busy ? "Connecting…" : `Connect ${provider.label}`}
      </button>
    </article>
  );
}

function LocalProviderCard({
  id,
  label,
  endpoint,
  detail,
  connected,
  busy,
  disabled,
  onConnect,
}: Readonly<{
  id: string;
  label: string;
  endpoint: string;
  detail: string;
  connected: boolean;
  busy: boolean;
  disabled: boolean;
  onConnect(): Promise<void>;
}>) {
  return (
    <article class="provider-setup-card local" data-provider={id}>
      <header><Icon name="terminal" size={18} /><div><h4>{label}</h4><code>{endpoint}</code></div></header>
      <p>{detail}</p>
      <button type="button" disabled={connected || disabled} onClick={() => void onConnect()}>
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

export function providerBoundaryLabel(
  boundary: BrowserInferenceConnection["provider"]["transportBoundary"],
): string {
  switch (boundary) {
    case "e2ee-attestable": return "Application E2EE · evidence evaluated separately";
    case "provider-tls": return "Provider TLS · browser direct";
    case "loopback-local": return "This machine · loopback";
  }
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
