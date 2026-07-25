import { useRef, useState } from "preact/hooks";
import {
  ANTHROPIC_PROVIDER,
  OPENAI_PROVIDER,
  XAI_PROVIDER,
  type InferenceAvailabilityConnection,
  type InferenceAvailabilitySnapshot,
  type InferenceProviderDescriptor,
  type ModelCapability,
} from "../inference/providers";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";
import "./provider-fabric-panel.css";

export type CloudCompatibilityProviderId = "openai" | "anthropic" | "xai";
export type LocalInferenceProviderId = "ollama" | "lm-studio";

export type ProviderConnectDraft =
  | Readonly<{
      kind: "cloud-api-key";
      providerId: CloudCompatibilityProviderId;
      apiKey: string;
    }>
  | Readonly<{
      kind: "local-service";
      providerId: LocalInferenceProviderId;
      endpoint: string;
    }>;

export type ChutesConnectionAction = Readonly<{
  /**
   * This is a navigation action into Airship's reviewed Chutes connection
   * surface. The provider panel never manufactures an OAuth flow itself.
   */
  onOpen(): void;
  oauthState: "configured-public-pkce" | "configuration-required";
}>;

export type ProviderFabricPanelProps = Readonly<{
  snapshot: InferenceAvailabilitySnapshot;
  activeConnectionId?: string;
  activeModelId?: string;
  chutes?: ChutesConnectionAction;
  busy?: boolean;
  online: boolean;
  onConnect(draft: ProviderConnectDraft): Promise<void>;
  onDisconnect(connectionId: string): Promise<void>;
  /**
   * The host must preserve session immutability. A different route creates or
   * forks a model-pinned conversation; it must never rewrite an existing pin.
   */
  onActivate(connectionId: string, modelId: string): Promise<void>;
}>;

type CloudProvider = Readonly<{
  descriptor: InferenceProviderDescriptor;
  id: CloudCompatibilityProviderId;
  placeholder: string;
}>;

const CLOUD = Object.freeze([
  { descriptor: OPENAI_PROVIDER, id: "openai", placeholder: "sk-…" },
  { descriptor: ANTHROPIC_PROVIDER, id: "anthropic", placeholder: "sk-ant-…" },
  { descriptor: XAI_PROVIDER, id: "xai", placeholder: "xai-…" },
] satisfies readonly CloudProvider[]);

const LOCAL = Object.freeze([
  { id: "ollama", label: "Ollama", endpoint: "http://127.0.0.1:11434" },
  { id: "lm-studio", label: "LM Studio", endpoint: "http://127.0.0.1:1234" },
] as const);

export function ProviderFabricPanel({
  snapshot,
  activeConnectionId = snapshot.activeSession?.connectionId,
  activeModelId = snapshot.activeSession?.modelId,
  chutes,
  busy = false,
  online,
  onConnect,
  onDisconnect,
  onActivate,
}: ProviderFabricPanelProps) {
  const secrets = useRef(new Map<string, HTMLInputElement>());
  const [riskAccepted, setRiskAccepted] = useState<Record<string, boolean>>({});
  const [localEndpoints, setLocalEndpoints] = useState<Record<string, string>>(
    Object.fromEntries(LOCAL.map((provider) => [provider.id, provider.endpoint])),
  );
  const [stagedModels, setStagedModels] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const controlsDisabled = busy || working !== undefined;

  async function run(
    operationId: string,
    successNotice: string,
    operation: () => Promise<void>,
  ) {
    setWorking(operationId);
    setNotice(undefined);
    setError(undefined);
    try {
      await operation();
      setNotice(successNotice);
    } catch {
      // Provider and browser errors are not copied into the DOM because a
      // third-party client can accidentally include a credential in its error.
      setError("The connection failed safely. Recheck the provider, browser access policy, endpoint, and credential.");
    } finally {
      setWorking(undefined);
    }
  }

  function connectCloud(provider: CloudProvider) {
    const input = secrets.current.get(provider.id);
    const apiKey = input?.value.trim() ?? "";
    if (!apiKey) {
      setNotice(undefined);
      setError(`Enter a ${provider.descriptor.label} API key before probing.`);
      input?.focus();
      return;
    }
    if (input) input.value = "";
    void run(
      `connect:${provider.id}`,
      `${provider.descriptor.label} connected. The credential remains in this page's memory.`,
      async () => {
        await onConnect({ kind: "cloud-api-key", providerId: provider.id, apiKey });
        setRiskAccepted((current) => ({ ...current, [provider.id]: false }));
      },
    );
  }

  return (
    <section class="provider-fabric" aria-labelledby="provider-fabric-title">
      <header class="provider-fabric__heading">
        <div>
          <span>Inference fabric</span>
          <h2 id="provider-fabric-title">Ready together. Routed explicitly.</h2>
          <p>
            Keep several provider authorities available at once. A route change
            starts a newly pinned conversation; Airship never retargets a
            conversation already in progress.
          </p>
        </div>
        <span class="provider-fabric__count">
          {formatConnectionCount(snapshot.connections.length)}
        </span>
      </header>

      <p class="provider-fabric__custody">
        Connection metadata and model capabilities are credential-free. OAuth
        grants and API keys remain in page memory and are cleared on reload.
      </p>

      {snapshot.connections.length ? (
        <div class="provider-connections" aria-label="Connected inference providers">
          {snapshot.connections.map((connection) => (
            <ProviderConnectionCard
              key={connection.id}
              connection={connection}
              activeConnectionId={activeConnectionId}
              activeModelId={activeModelId}
              stagedModelId={stagedModels[connection.id]}
              disabled={controlsDisabled}
              onStage={(modelId) => {
                setStagedModels((current) => ({ ...current, [connection.id]: modelId }));
              }}
              onActivate={(modelId) => void run(
                `activate:${connection.id}`,
                `${connection.providerLabel} · ${modelLabel(connection, modelId)} is active in a new model-pinned conversation.`,
                () => onActivate(connection.id, modelId),
              )}
              onDisconnect={() => void run(
                `disconnect:${connection.id}`,
                `${connection.connectionLabel} disconnected. Other inference connections remain available.`,
                () => onDisconnect(connection.id),
              )}
            />
          ))}
        </div>
      ) : (
        <div class="provider-fabric__empty">
          <Icon name="model" size={18} />
          <span>
            <strong>No inference route connected</strong>
            <small>Local tools still work. Connect Chutes, a compatibility provider, or a model service on this machine.</small>
          </span>
        </div>
      )}

      <div class="provider-fabric__catalog">
        <section aria-labelledby="provider-cloud-heading">
          <div class="provider-catalog-heading">
            <span id="provider-cloud-heading">Cloud providers</span>
            <strong>Independent connections</strong>
          </div>

          <details class="provider-entry">
            <summary>
              <ProviderEntrySummary
                label="Chutes"
                connected={providerConnectionCount(snapshot, "chutes")}
                fallback="OAuth or page-memory key"
              />
            </summary>
            <div class="provider-entry__body">
              <p>
                Chutes is Airship&apos;s reviewed E2EE path. Its dedicated
                connection screen handles Authorization Code + S256 PKCE when a
                Browser/native public client is configured, plus the explicit
                page-memory key alternative.
              </p>
              <p class="provider-auth-fact" data-state={chutes?.oauthState ?? "configuration-required"}>
                <span aria-hidden="true" />
                {chutes?.oauthState === "configured-public-pkce"
                  ? "Public-client PKCE is configured for this Airship origin."
                  : "This build has not reported a configured public-client PKCE registration here."}
              </p>
              <button type="button" disabled={controlsDisabled || !chutes} onClick={() => chutes?.onOpen()}>
                {providerConnectionCount(snapshot, "chutes") ? "Manage Chutes" : "Open Chutes connection"}
              </button>
            </div>
          </details>

          {CLOUD.map((provider) => {
            const count = providerConnectionCount(snapshot, provider.id);
            const apiKeyMethod = provider.descriptor.authMethods.find((method) => method.kind === "api-key");
            return (
              <details class="provider-entry" key={provider.id}>
                <summary>
                  <ProviderEntrySummary
                    label={provider.descriptor.label}
                    connected={count}
                    fallback="Page-memory compatibility"
                  />
                </summary>
                <div class="provider-entry__body">
                  <p>{provider.descriptor.oauth.detail}</p>
                  {apiKeyMethod ? <p class="provider-key-warning">{apiKeyMethod.warning}</p> : null}
                  <label>
                    <span>{provider.descriptor.label} API key</span>
                    <input
                      ref={(element) => {
                        if (element) secrets.current.set(provider.id, element);
                        else secrets.current.delete(provider.id);
                      }}
                      type="password"
                      name={`${provider.id}-page-memory-key`}
                      autoComplete="off"
                      autoCapitalize="none"
                      data-1p-ignore
                      data-lpignore="true"
                      spellcheck={false}
                      placeholder={provider.placeholder}
                      disabled={controlsDisabled}
                    />
                  </label>
                  <label class="provider-risk-consent">
                    <input
                      type="checkbox"
                      checked={riskAccepted[provider.id] ?? false}
                      disabled={controlsDisabled}
                      onChange={(event) => setRiskAccepted((current) => ({
                        ...current,
                        [provider.id]: event.currentTarget.checked,
                      }))}
                    />
                    <span>
                      I understand this is a direct-browser compatibility path,
                      not a provider-published third-party OAuth grant. The key
                      stays only in this page&apos;s memory.
                    </span>
                  </label>
                  <button
                    type="button"
                    disabled={!online || controlsDisabled || !riskAccepted[provider.id]}
                    onClick={() => connectCloud(provider)}
                  >
                    {count ? "Add another connection" : "Probe and connect"}
                  </button>
                  {!online ? <small class="provider-entry__offline">Cloud probing resumes when the browser is online.</small> : null}
                </div>
              </details>
            );
          })}
        </section>

        <section aria-labelledby="provider-local-heading">
          <div class="provider-catalog-heading">
            <span id="provider-local-heading">On this machine</span>
            <strong>Browser → local service</strong>
          </div>
          {LOCAL.map((provider) => {
            const count = providerConnectionCount(snapshot, provider.id);
            const endpoint = localEndpoints[provider.id] ?? provider.endpoint;
            return (
              <details class="provider-entry" key={provider.id}>
                <summary>
                  <ProviderEntrySummary
                    label={provider.label}
                    connected={count}
                    fallback="Live discovery"
                  />
                </summary>
                <div class="provider-entry__body">
                  <p>
                    Airship probes this endpoint directly and reports only
                    capabilities returned by its live model directory. The
                    service must allow requests from this page&apos;s origin.
                  </p>
                  <label>
                    <span>Endpoint</span>
                    <input
                      type="url"
                      inputMode="url"
                      autoCapitalize="none"
                      spellcheck={false}
                      value={endpoint}
                      disabled={controlsDisabled}
                      onInput={(event) => setLocalEndpoints((current) => ({
                        ...current,
                        [provider.id]: event.currentTarget.value,
                      }))}
                    />
                  </label>
                  <p>
                    Only the exact loopback origins shipped in Airship&apos;s
                    allowlist and CSP are accepted. Private-LAN hosts and
                    custom ports are not enabled by this control.
                  </p>
                  <button
                    type="button"
                    disabled={controlsDisabled || !endpoint.trim()}
                    onClick={() => void run(
                      `connect:${provider.id}`,
                      `${provider.label} connected from a live browser probe. Discovered models are now available.`,
                      () => onConnect({
                        kind: "local-service",
                        providerId: provider.id,
                        endpoint,
                      }),
                    )}
                  >
                    {count ? "Discover another endpoint" : "Discover local models"}
                  </button>
                </div>
              </details>
            );
          })}
        </section>
      </div>

      {snapshot.omittedConnections > 0 ? (
        <p class="provider-fabric__bounded">
          {snapshot.omittedConnections} additional connection{snapshot.omittedConnections === 1 ? "" : "s"} omitted from this bounded view.
        </p>
      ) : null}
      {notice ? <p class="provider-fabric__notice" role="status"><span />{notice}</p> : null}
      {error ? <p class="provider-fabric__error" role="alert"><Icon name="warning" size={16} />{error}</p> : null}
    </section>
  );
}

function ProviderConnectionCard({
  connection,
  activeConnectionId,
  activeModelId,
  stagedModelId,
  disabled,
  onStage,
  onActivate,
  onDisconnect,
}: Readonly<{
  connection: InferenceAvailabilityConnection;
  activeConnectionId?: string;
  activeModelId?: string;
  stagedModelId?: string;
  disabled: boolean;
  onStage(modelId: string): void;
  onActivate(modelId: string): void;
  onDisconnect(): void;
}>) {
  const isActiveConnection = connection.id === activeConnectionId;
  const availableModel = connection.models.find((model) => model.availability === "available");
  const activeModel = isActiveConnection
    ? connection.models.find((model) => model.id === activeModelId)
    : undefined;
  const selectedModelId = stagedModelId ?? activeModel?.id ?? availableModel?.id ?? connection.models[0]?.id;
  const isActiveRoute = isActiveConnection && selectedModelId === activeModelId;
  const canActivate = (
    Boolean(selectedModelId)
    && connection.canInvoke
    && connection.models.some((model) =>
      model.id === selectedModelId && model.availability === "available"
    )
  );

  return (
    <article class={isActiveConnection ? "provider-connection active" : "provider-connection"}>
      <div class="provider-connection__title">
        <span class="provider-connection__mark"><Icon name="model" size={16} /></span>
        <div>
          <strong>{connection.providerLabel}</strong>
          <small title={connection.connectionLabel}>{connection.connectionLabel}</small>
        </div>
        <span class="provider-health" data-health={connection.health}>
          <i aria-hidden="true" />
          {healthLabel(connection)}
        </span>
      </div>

      <div class="provider-connection__capabilities" aria-label="Proved connection capabilities">
        {connection.availableCapabilities.length
          ? connection.availableCapabilities.map((capability) => <span key={capability}>{capabilityLabel(capability)}</span>)
          : <span data-empty>No proved capabilities</span>}
      </div>

      <div class="provider-connection__model">
        {connection.models.length && selectedModelId ? (
          <MenuSelect
            placement="down"
            ariaLabel={`${connection.providerLabel} discovered model`}
            value={selectedModelId}
            disabled={disabled}
            options={connection.models.map((model) => ({
              value: model.id,
              label: model.label,
              description: modelDescription(model),
              disabled: model.availability !== "available",
            }))}
            onChange={onStage}
          />
        ) : (
          <span class="provider-connection__no-model">No model was returned by this connection&apos;s live directory.</span>
        )}
        {connection.omittedModels > 0 ? (
          <small>{connection.omittedModels} additional model{connection.omittedModels === 1 ? "" : "s"} omitted from this bounded view.</small>
        ) : null}
      </div>

      <div class="provider-connection__actions">
        <button
          type="button"
          class="provider-route-action"
          disabled={disabled || !canActivate || isActiveRoute}
          onClick={() => selectedModelId && onActivate(selectedModelId)}
        >
          {isActiveRoute ? "Active in this thread" : "Use in new thread"}
        </button>
        <button
          type="button"
          class="provider-disconnect-action"
          disabled={disabled}
          aria-label={`Disconnect ${connection.connectionLabel}`}
          onClick={onDisconnect}
        >
          Disconnect
        </button>
      </div>

      <footer>
        <span>{authKindLabel(connection.authKind)}</span>
        <span>{connection.models.length} discovered model{connection.models.length === 1 ? "" : "s"}</span>
      </footer>
    </article>
  );
}

function ProviderEntrySummary({
  label,
  connected,
  fallback,
}: Readonly<{ label: string; connected: number; fallback: string }>) {
  return (
    <>
      <span>
        <strong>{label}</strong>
        <small>{connected ? formatConnectionCount(connected) : fallback}</small>
      </span>
      <span>{connected ? "Ready" : "Configure"}</span>
    </>
  );
}

export function providerConnectionCount(
  snapshot: Pick<InferenceAvailabilitySnapshot, "connections">,
  providerId: string,
): number {
  return snapshot.connections.filter((connection) => connection.providerId === providerId).length;
}

export function modelDescription(
  model: InferenceAvailabilityConnection["models"][number],
): string {
  return [
    availabilityLabel(model.availability),
    ...model.supportedCapabilities.map(capabilityLabel),
  ].join(" · ");
}

export function capabilityLabel(value: string): string {
  const labels: Readonly<Partial<Record<ModelCapability | string, string>>> = {
    "image-input": "Vision",
    "text-input": "Text in",
    "text-output": "Text out",
    "audio-input": "Audio in",
    "audio-output": "Audio out",
    "tool-calling": "Tools",
    "parallel-tool-calling": "Parallel tools",
    "structured-output": "Structured output",
    "models:list": "Models",
    "identity:read": "Identity",
    "billing:read": "Billing",
    "usage:read": "Usage",
    invoke: "Invoke",
    reasoning: "Reasoning",
    embeddings: "Embeddings",
  };
  return labels[value] ?? value.replaceAll("-", " ");
}

function availabilityLabel(value: InferenceAvailabilityConnection["models"][number]["availability"]): string {
  if (value === "available") return "Available";
  if (value === "unavailable") return "Unavailable";
  return "Not yet proved";
}

function healthLabel(connection: InferenceAvailabilityConnection): string {
  if (connection.canInvoke && connection.health === "ready") return "Ready";
  if (connection.canInvoke && connection.health === "degraded") return "Degraded";
  if (connection.health === "expired") return "Expired";
  if (connection.health === "offline") return "Offline";
  if (connection.health === "degraded") return "Degraded";
  return "Unchecked";
}

function authKindLabel(value: InferenceAvailabilityConnection["authKind"]): string {
  if (value === "local-none") return "Local service · no credential";
  if (value === "oauth-public-pkce") return "OAuth · page memory";
  return "API key · page memory";
}

function modelLabel(connection: InferenceAvailabilityConnection, modelId: string): string {
  return connection.models.find((model) => model.id === modelId)?.label ?? modelId;
}

function formatConnectionCount(count: number): string {
  return `${count} connection${count === 1 ? "" : "s"}`;
}
