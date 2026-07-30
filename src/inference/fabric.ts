import type {
  CanonicalMessage,
  InferenceRequest,
  InferenceTransport,
} from "../core/contracts";
import { randomUuid } from "../core/id";
import { connectLocalProvider } from "./local/catalog-adapter";
import {
  type BrowserLocalModelProvider,
  type LocalModelProviderKind,
  type LocalProviderOptions,
} from "./local/contracts";
import { createBrowserLocalModelProvider } from "./local/provider";
import {
  AnthropicBrowserTransport,
  OpenAiBrowserTransport,
  ProviderTransportError,
  XaiBrowserTransport,
} from "./providers/browser-cloud";
import { InferenceConnectionRegistry } from "./providers/connection-registry";
import {
  type InferenceAvailabilitySnapshot,
  type InferenceConnectionMetadata,
  type InferenceModelDescriptor,
  type InferenceProviderDescriptor,
  type PinnedRouteResolution,
  type SessionInferenceRoutePin,
} from "./providers/contracts";
import { InferenceModelCatalog } from "./providers/model-catalog";
import { OFFICIAL_CLOUD_PROVIDERS } from "./providers/official-providers";
import { InferenceProviderCatalog } from "./providers/provider-catalog";
import {
  createInferenceAvailabilitySnapshot,
  pinInferenceRoute,
  resolvePinnedInferenceRoute,
} from "./providers/session-route";

export type BrowserCloudProviderId = "openai" | "anthropic" | "xai";
export type BrowserFabricProviderId = BrowserCloudProviderId | LocalModelProviderKind;

export type BrowserInferenceConnection = Readonly<{
  connection: InferenceConnectionMetadata;
  provider: InferenceProviderDescriptor;
  models: readonly InferenceModelDescriptor[];
}>;

export type ActivatedInferenceRoute = Readonly<{
  pin: SessionInferenceRoutePin;
  transport: InferenceTransport;
  models: readonly InferenceModelDescriptor[];
}>;

export type BrowserCloudCatalogTransport = InferenceTransport & Readonly<{
  listModels(signal?: AbortSignal): Promise<readonly InferenceModelDescriptor[]>;
}>;

type Listener = () => void;

export type BrowserInferenceFabricOptions = Readonly<{
  cloudTransportFactory?: (
    providerId: BrowserCloudProviderId,
    options: ConstructorParameters<typeof OpenAiBrowserTransport>[0],
  ) => BrowserCloudCatalogTransport;
  localProviderFactory?: (
    kind: LocalModelProviderKind,
    options?: LocalProviderOptions,
  ) => BrowserLocalModelProvider;
  connectionIdFactory?: () => string;
  now?: () => number;
}>;

/**
 * Page-lifetime inference authority. Credentials remain inside the registry,
 * which has no serialization/export API. Route components can unmount without
 * dropping other connected providers or retargeting an active conversation.
 */
export class BrowserInferenceFabric {
  readonly providers: InferenceProviderCatalog;
  readonly connections: InferenceConnectionRegistry;
  readonly models: InferenceModelCatalog;
  readonly #transports = new Map<string, AuthorityBoundInferenceTransport>();
  readonly #listeners = new Set<Listener>();
  readonly #reservedConnectionIds = new Set<string>();
  readonly #cloudTransportFactory: NonNullable<BrowserInferenceFabricOptions["cloudTransportFactory"]>;
  readonly #localProviderFactory: NonNullable<BrowserInferenceFabricOptions["localProviderFactory"]>;
  readonly #connectionIdFactory: NonNullable<BrowserInferenceFabricOptions["connectionIdFactory"]>;
  readonly #now: () => number;

  constructor(options: BrowserInferenceFabricOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.providers = new InferenceProviderCatalog(OFFICIAL_CLOUD_PROVIDERS);
    this.connections = new InferenceConnectionRegistry(this.providers, this.#now);
    this.models = new InferenceModelCatalog(this.providers);
    this.#cloudTransportFactory = options.cloudTransportFactory ?? cloudTransport;
    this.#localProviderFactory = options.localProviderFactory ?? createBrowserLocalModelProvider;
    this.#connectionIdFactory = options.connectionIdFactory ?? randomUuid;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(): readonly BrowserInferenceConnection[] {
    return Object.freeze(this.connections.snapshot().connections.map((connection) =>
      Object.freeze({
        connection,
        provider: this.providers.require(connection.providerId).provider,
        models: this.models.forConnection(connection.id, connection.generation),
      })
    ));
  }

  availability(
    activeSession?: SessionInferenceRoutePin,
  ): InferenceAvailabilitySnapshot {
    return createInferenceAvailabilitySnapshot({
      providers: this.providers,
      connections: this.connections,
      models: this.models,
      ...(activeSession ? { activeSession } : {}),
    });
  }

  async connectCloud(args: Readonly<{
    providerId: BrowserCloudProviderId;
    connectionId?: string;
    label?: string;
    apiKey: string;
    acknowledgeDirectBrowserCredentialRisk: true;
    signal?: AbortSignal;
  }>): Promise<BrowserInferenceConnection> {
    args.signal?.throwIfAborted();
    const provider = this.providers.require(args.providerId).provider;
    const method = provider.authMethods.find((candidate) => candidate.kind === "api-key");
    if (!method || method.kind !== "api-key") {
      throw new Error(`${provider.label} has no configured API-key method.`);
    }
    if (!args.acknowledgeDirectBrowserCredentialRisk) {
      throw new Error("Direct browser credential use requires explicit acknowledgement.");
    }
    const connectionId = this.#reserveConnectionId(
      args.connectionId ?? this.#freshConnectionId(args.providerId),
    );
    const stagingConnections = new InferenceConnectionRegistry(this.providers, this.#now);
    try {
      /*
       * Discovery borrows the proposed key from an isolated page-memory
       * registry. The live registry is untouched until the candidate has
       * proved that it can enumerate at least one model.
       */
      const stagedConnection = stagingConnections.connectApiKey({
        id: connectionId,
        providerId: provider.id,
        authMethodId: method.id,
        label: args.label?.trim() || `${provider.label} · page memory`,
        apiKey: args.apiKey,
      });
      const stagedTransport = this.#cloudTransportFactory(args.providerId, {
        connectionId,
        connectionGeneration: stagedConnection.generation,
        connections: stagingConnections,
      });
      const discovered = await stagedTransport.listModels(args.signal);
      if (discovered.length === 0) {
        throw new Error(`${provider.label} returned no models to this credential.`);
      }
      args.signal?.throwIfAborted();
      const checkedAt = this.#nowIso();
      const stagingModels = new InferenceModelCatalog(this.providers);
      stagingModels.replaceConnectionModels(
        stagedConnection.id,
        stagedConnection.generation,
        provider.id,
        discovered,
      );

      const connection = this.connections.connectApiKey({
        id: connectionId,
        providerId: provider.id,
        authMethodId: method.id,
        label: args.label?.trim() || `${provider.label} · page memory`,
        apiKey: args.apiKey,
      });
      const committedModels = bindModels(discovered, connection, provider.id);
      this.models.replaceConnectionModels(
        connection.id,
        connection.generation,
        provider.id,
        committedModels,
      );
      this.connections.updateHealth(connection.id, {
        state: "ready",
        checkedAt,
      });
      this.connections.updateCapabilities(connection.id, {
        "models:list": {
          state: "available",
          source: "live-probe",
          checkedAt,
        },
        invoke: { state: "unknown", source: "live-probe", checkedAt },
      });
      const transport = this.#bindTransport(
        this.#cloudTransportFactory(args.providerId, {
          connectionId: connection.id,
          connectionGeneration: connection.generation,
          connections: this.connections,
          /*
           * The transport outlives every model selection, so a per-model
           * output ceiling can only be read at request time. It resolves
           * against the live catalog row for this exact credential
           * generation and stays undefined until something declares one.
           */
          maxOutputTokensForModel: (modelId) =>
            this.models.get(connection.id, connection.generation, modelId)?.maxOutputTokens,
        }),
        connection,
      );
      this.#transports.set(connection.id, transport);
      this.#emit();
      return this.#requireVisible(connection.id);
    } catch (error) {
      this.#rollbackCandidate(connectionId);
      throw error;
    } finally {
      /*
       * Clear the proposed secret on every path, including cancellation.
       * The committed registry independently owns only the successful key.
       */
      stagingConnections.clear();
      this.#reservedConnectionIds.delete(connectionId);
    }
  }

  async connectLocal(args: Readonly<{
    kind: LocalModelProviderKind;
    connectionId?: string;
    label?: string;
    options?: LocalProviderOptions;
    signal?: AbortSignal;
  }>): Promise<BrowserInferenceConnection> {
    args.signal?.throwIfAborted();
    /*
     * The current fabric contract registers local endpoints as `local-none`.
     * Passing a credential resolver through to the provider would therefore
     * make the transport authenticated while the connection metadata, session
     * pin, prompt roster, and UI all claimed that no credential existed.
     * Fail closed until authenticated-local custody has its own reviewed auth
     * method and generation-bound registry path.
     */
    if (args.options?.credential) {
      throw new Error(
        "Authenticated local-model endpoints require a dedicated page-memory authority; "
        + "this local-none connection accepts only an unauthenticated loopback service.",
      );
    }
    const provider = this.#localProviderFactory(args.kind, args.options);
    const descriptor = localProviderDescriptor(
      args.kind,
      provider.endpoint,
      localProviderId(args.kind, provider.endpoint),
    );
    const connectionId = this.#reserveConnectionId(
      args.connectionId ?? this.#freshConnectionId(args.kind),
    );
    try {
      /*
       * Probe and normalize into isolated catalogs first. A failed endpoint,
       * empty directory, invalid model row, or cancellation therefore cannot
       * revise a live provider or replace a working connection.
       */
      const stagingProviders = new InferenceProviderCatalog([descriptor]);
      const stagingConnections = new InferenceConnectionRegistry(stagingProviders, this.#now);
      const stagedConnection = stagingConnections.connectLocal({
        id: connectionId,
        providerId: descriptor.id,
        authMethodId: `${args.kind}-loopback`,
        label: args.label?.trim() || `${descriptor.label} · ${provider.endpoint.origin}`,
      });
      const health = await provider.probeHealth(args.signal);
      const connected = await connectLocalProvider(provider, {
        connectionId,
        connectionGeneration: stagedConnection.generation,
        providerId: descriptor.id,
      }, args.signal);
      if (connected.models.length === 0) {
        throw new Error(`${descriptor.label} is reachable but has no installed models.`);
      }
      const stagingModels = new InferenceModelCatalog(stagingProviders);
      stagingModels.replaceConnectionModels(
        stagedConnection.id,
        stagedConnection.generation,
        descriptor.id,
        connected.models,
      );
      stagingConnections.updateHealth(stagedConnection.id, {
        state: "ready",
        checkedAt: health.checkedAt,
      });
      stagingConnections.updateCapabilities(stagedConnection.id, {
        "models:list": {
          state: "available",
          source: "live-probe",
          checkedAt: health.checkedAt,
        },
        invoke: {
          state: "unknown",
          source: "live-probe",
          checkedAt: health.checkedAt,
        },
      });
      args.signal?.throwIfAborted();

      this.#ensureProvider(descriptor);
      const connection = this.connections.connectLocal({
        id: connectionId,
        providerId: descriptor.id,
        authMethodId: `${args.kind}-loopback`,
        label: args.label?.trim() || `${descriptor.label} · ${provider.endpoint.origin}`,
      });
      const committedModels = bindModels(connected.models, connection, descriptor.id);
      this.models.replaceConnectionModels(
        connection.id,
        connection.generation,
        descriptor.id,
        committedModels,
      );
      this.connections.updateHealth(connection.id, {
        state: "ready",
        checkedAt: health.checkedAt,
      });
      this.connections.updateCapabilities(connection.id, {
        "models:list": {
          state: "available",
          source: "live-probe",
          checkedAt: health.checkedAt,
        },
        invoke: { state: "unknown", source: "live-probe", checkedAt: health.checkedAt },
      });
      this.#transports.set(
        connection.id,
        this.#bindTransport(connected.transport, connection),
      );
      this.#emit();
      return this.#requireVisible(connection.id);
    } catch (error) {
      this.#rollbackCandidate(connectionId);
      throw error;
    } finally {
      this.#reservedConnectionIds.delete(connectionId);
    }
  }

  /**
   * A protected, deliberately tiny inference proves that the selected model
   * can actually invoke through this exact credential generation. Catalog
   * visibility alone is never promoted to invoke authorization.
   */
  async activate(
    connectionId: string,
    modelId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ActivatedInferenceRoute> {
    const connection = this.connections.require(connectionId);
    const provider = this.providers.require(connection.providerId);
    const transport = this.#transports.get(connection.id);
    if (!transport) throw new Error("The selected inference transport is no longer in page memory.");
    const model = this.models.require(connection.id, connection.generation, modelId);
    try {
      await verifyInvocation(transport, modelId, signal);
    } catch (error) {
      /*
       * A 400 from the invocation probe is the provider judging the model,
       * not the network: a directory row that can never answer this endpoint
       * (embedding, image and moderation listings share the model directory)
       * would otherwise stay selectable and burn a doomed probe on every
       * press. Record the verdict back onto the row in the exact vocabulary
       * the success path uses, so the catalog renders it as observed
       * unavailable. Every other failure — 5xx, timeouts, refusals to
       * connect — stays retryable and leaves the row untouched.
       */
      if (
        error instanceof ProviderTransportError
        && error.code === "http"
        && error.status === 400
        && this.models.get(connection.id, connection.generation, modelId) === model
        && this.#transports.get(connection.id) === transport
      ) {
        this.#markProbeVerdict(connection, modelId);
      }
      throw error;
    }
    /*
     * The protected request is asynchronous. A disconnect/reconnect or public
     * catalog revision can occur while it is in flight. Never apply the old
     * probe result to a replacement credential, revised provider endpoint, or
     * changed model row merely because it reused the same visible IDs.
     */
    const currentConnection = this.connections.get(connection.id);
    const currentProvider = this.providers.get(connection.providerId);
    const currentModel = this.models.get(connection.id, connection.generation, modelId);
    if (
      !currentConnection
      || currentConnection.generation !== connection.generation
      || currentProvider?.revision !== provider.revision
      || currentModel !== model
      || this.#transports.get(connection.id) !== transport
    ) {
      throw new Error(
        "The inference authority changed while model invocation was being checked. Retry against the current connection.",
      );
    }
    const checkedAt = this.#nowIso();
    this.connections.updateHealth(connection.id, { state: "ready", checkedAt });
    this.connections.updateCapabilities(connection.id, {
      invoke: { state: "available", source: "live-probe", checkedAt },
    });
    const currentModels = this.models.forConnection(connection.id, connection.generation);
    this.models.replaceConnectionModels(
      connection.id,
      connection.generation,
      connection.providerId,
      currentModels.map((model) => model.id === modelId
        ? Object.freeze({
            ...model,
            availability: Object.freeze({
              state: "available" as const,
              source: "live-probe" as const,
              observedAt: checkedAt,
            }),
          })
        : model),
    );
    const pin = pinInferenceRoute(this.providers, this.connections, this.models, {
      connectionId: connection.id,
      modelId,
      pinnedAt: checkedAt,
    });
    this.#emit();
    return Object.freeze({
      pin,
      transport,
      models: this.models.forConnection(connection.id, connection.generation),
    });
  }

  /**
   * Record an operator-declared context window / output ceiling for one model
   * row.
   *
   * OpenAI's and Anthropic's model directories publish neither number, and
   * Airship refuses to infer them from a model-name table, so a declaration is
   * the only honest way a cloud route can obtain context compression or a
   * correct Anthropic `max_tokens`. The row is relabelled `manual` because the
   * numbers were asserted by a person, not observed from the provider.
   */
  declareModelMetadata(
    connectionId: string,
    modelId: string,
    declaration: Readonly<{ contextWindowTokens?: number; maxOutputTokens?: number }>,
  ): InferenceModelDescriptor {
    const connection = this.connections.require(connectionId);
    const model = this.models.require(connection.id, connection.generation, modelId);
    if (
      declaration.contextWindowTokens === undefined
      && declaration.maxOutputTokens === undefined
    ) {
      throw new Error("A model metadata declaration must carry a context window or output ceiling.");
    }
    const observedAt = this.#nowIso();
    const declared: InferenceModelDescriptor = Object.freeze({
      ...model,
      ...(declaration.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: declaration.contextWindowTokens }),
      ...(declaration.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: declaration.maxOutputTokens }),
      source: Object.freeze({ kind: "manual" as const, observedAt }),
    });
    this.models.replaceConnectionModels(
      connection.id,
      connection.generation,
      connection.providerId,
      this.models
        .forConnection(connection.id, connection.generation)
        .map((row) => (row.id === modelId ? declared : row)),
    );
    this.#emit();
    return this.models.require(connection.id, connection.generation, modelId);
  }

  /**
   * Read-only resolution of an immutable session route. Reconnecting the same
   * provider creates another connection ID, so this result cannot silently
   * retarget a conversation to a different credential.
   */
  resolve(pin: SessionInferenceRoutePin): PinnedRouteResolution {
    return resolvePinnedInferenceRoute(this.providers, this.connections, this.models, pin);
  }

  /**
   * Fail-closed route readiness check performed before a turn. This does not
   * invoke the provider or borrow its credential.
   */
  preflight(pin: SessionInferenceRoutePin): ActivatedInferenceRoute {
    const resolution = this.resolve(pin);
    if (resolution.state !== "ready") {
      throw new Error(`Inference route preflight failed: ${resolution.detail}`);
    }
    const transport = this.#transports.get(pin.connection.id);
    if (!transport) {
      throw new Error("Inference route preflight failed: transport is no longer in page memory.");
    }
    return Object.freeze({
      pin,
      transport,
      models: this.models.forConnection(pin.connection.id, pin.connection.generation),
    });
  }

  disconnect(connectionId: string): boolean {
    if (!this.connections.get(connectionId)) return false;
    this.#transports.get(connectionId)?.revoke(
      new DOMException("Inference connection was disconnected.", "AbortError"),
    );
    this.#transports.delete(connectionId);
    this.models.clearConnection(connectionId);
    const disconnected = this.connections.disconnect(connectionId);
    if (disconnected) this.#emit();
    return disconnected;
  }

  /*
   * Write an authoritative probe refusal onto the catalog row it is about.
   *
   * Deliberately only the availability row, mirroring what `activate` writes
   * on success rather than inventing a second vocabulary: the picker and the
   * availability snapshot already render `unavailable` as not-selectable, and
   * the row's `source` still describes the directory listing that produced
   * the model's id and label — a request refusal is not that listing.
   */
  #markProbeVerdict(
    connection: InferenceConnectionMetadata,
    modelId: string,
  ): void {
    const observedAt = this.#nowIso();
    this.models.replaceConnectionModels(
      connection.id,
      connection.generation,
      connection.providerId,
      this.models.forConnection(connection.id, connection.generation).map((model) =>
        model.id === modelId
          ? Object.freeze({
              ...model,
              availability: Object.freeze({
                state: "unavailable" as const,
                source: "live-probe" as const,
                observedAt,
              }),
            })
          : model),
    );
    this.#emit();
  }

  #reserveConnectionId(baseValue: string): string {
    const base = assertIdentifier(baseValue, "Connection ID");
    if (!this.connections.get(base) && !this.#reservedConnectionIds.has(base)) {
      this.#reservedConnectionIds.add(base);
      return base;
    }
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const token = safeIdentifierToken(this.#connectionIdFactory()) || String(attempt + 1);
      const suffix = `-next-${token.slice(0, 32)}`;
      const candidate = `${base.slice(0, 128 - suffix.length)}${suffix}`;
      if (!this.connections.get(candidate) && !this.#reservedConnectionIds.has(candidate)) {
        this.#reservedConnectionIds.add(candidate);
        return candidate;
      }
    }
    throw new Error("Could not allocate a unique inference connection ID.");
  }

  /**
   * A credential generation must not be reproducible in a fresh page runtime.
   * Stable defaults such as `openai-primary:generation-1` could otherwise make
   * a durable pin created with one key collide with a different key after a
   * reload. Explicit IDs remain available to deterministic tests/integrators.
   */
  #freshConnectionId(providerId: string): string {
    const token = safeIdentifierToken(this.#connectionIdFactory())
      || safeIdentifierToken(randomUuid());
    return `${providerId}-${token.slice(0, 64)}`;
  }

  #ensureProvider(descriptor: InferenceProviderDescriptor): void {
    const current = this.providers.get(descriptor.id);
    if (!current) {
      this.providers.register(descriptor);
      return;
    }
    if (providerSemantics(current.provider) !== providerSemantics(descriptor)) {
      throw new Error(
        `Inference provider ${descriptor.id} is already bound to another endpoint.`,
      );
    }
  }

  #rollbackCandidate(connectionId: string): void {
    if (!this.connections.get(connectionId)) return;
    this.#transports.get(connectionId)?.revoke(
      new DOMException("Inference connection candidate was rolled back.", "AbortError"),
    );
    this.#transports.delete(connectionId);
    this.models.clearConnection(connectionId);
    this.connections.disconnect(connectionId);
  }

  #nowIso(): string {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("The inference fabric clock is invalid.");
    }
    return new Date(value).toISOString();
  }

  #bindTransport(
    transport: InferenceTransport,
    connection: InferenceConnectionMetadata,
  ): AuthorityBoundInferenceTransport {
    const provider = this.providers.require(connection.providerId);
    return new AuthorityBoundInferenceTransport({
      delegate: transport,
      providers: this.providers,
      connections: this.connections,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      providerId: connection.providerId,
      providerRevision: provider.revision,
    });
  }

  #requireVisible(connectionId: string): BrowserInferenceConnection {
    const result = this.list().find((candidate) => candidate.connection.id === connectionId);
    if (!result) throw new Error("The new inference connection was not committed.");
    return result;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

type AuthorityBoundTransportOptions = Readonly<{
  delegate: InferenceTransport;
  providers: InferenceProviderCatalog;
  connections: InferenceConnectionRegistry;
  connectionId: string;
  connectionGeneration: number;
  providerId: string;
  providerRevision: number;
}>;

/**
 * Defense in depth for callers that retain an activated route object.
 *
 * UI preflight remains required, but a raw local transport must never remain
 * usable after its page-memory authority is disconnected or replaced. Cloud
 * adapters already gate credential borrowing by generation; this wrapper
 * applies the same lifecycle invariant to every transport and aborts work that
 * is still in flight when the authority is released.
 */
class AuthorityBoundInferenceTransport implements InferenceTransport {
  readonly id: string;
  readonly posture: InferenceTransport["posture"];
  readonly #revocation = new AbortController();

  constructor(private readonly options: AuthorityBoundTransportOptions) {
    this.id = options.delegate.id;
    this.posture = options.delegate.posture;
  }

  revoke(reason: unknown): void {
    if (!this.#revocation.signal.aborted) this.#revocation.abort(reason);
  }

  async *stream(
    request: InferenceRequest,
    callerSignal: AbortSignal,
  ) {
    this.#assertAuthority();
    callerSignal.throwIfAborted();
    this.#revocation.signal.throwIfAborted();
    const operation = new AbortController();
    const abortFromCaller = () => operation.abort(
      callerSignal.reason ?? new DOMException("Inference request was cancelled.", "AbortError"),
    );
    const abortFromRevocation = () => operation.abort(
      this.#revocation.signal.reason
        ?? new DOMException("Inference authority was released.", "AbortError"),
    );
    callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    this.#revocation.signal.addEventListener("abort", abortFromRevocation, { once: true });
    if (callerSignal.aborted) abortFromCaller();
    if (this.#revocation.signal.aborted) abortFromRevocation();
    try {
      this.#assertAuthority();
      for await (const event of this.options.delegate.stream(request, operation.signal)) {
        operation.signal.throwIfAborted();
        this.#assertAuthority();
        yield event;
      }
      operation.signal.throwIfAborted();
      this.#assertAuthority();
    } finally {
      callerSignal.removeEventListener("abort", abortFromCaller);
      this.#revocation.signal.removeEventListener("abort", abortFromRevocation);
    }
  }

  #assertAuthority(): void {
    const connection = this.options.connections.get(this.options.connectionId);
    const provider = this.options.providers.get(this.options.providerId);
    if (
      !connection
      || connection.generation !== this.options.connectionGeneration
      || connection.providerId !== this.options.providerId
      || provider?.revision !== this.options.providerRevision
    ) {
      throw new Error(
        "The inference transport's exact connection authority is no longer active.",
      );
    }
  }
}

type CloudCatalogTransport =
  | OpenAiBrowserTransport
  | AnthropicBrowserTransport
  | XaiBrowserTransport;

function cloudTransport(
  providerId: BrowserCloudProviderId,
  options: ConstructorParameters<typeof OpenAiBrowserTransport>[0],
): CloudCatalogTransport {
  switch (providerId) {
    case "openai": return new OpenAiBrowserTransport(options);
    case "anthropic": return new AnthropicBrowserTransport(options);
    case "xai": return new XaiBrowserTransport(options);
  }
}

function localProviderDescriptor(
  kind: LocalModelProviderKind,
  endpoint: URL,
  id: string,
): InferenceProviderDescriptor {
  const label = kind === "ollama" ? "Ollama" : "LM Studio";
  const descriptor: InferenceProviderDescriptor = {
    version: 1,
    id,
    label,
    protocol: "openai-compatible",
    transportBoundary: "loopback-local",
    baseUrl: new URL("v1/", endpoint).toString(),
    modelsUrl: new URL(
      kind === "ollama" ? "api/tags" : "api/v1/models",
      endpoint,
    ).toString(),
    oauth: {
      state: "not-documented",
      detail: "This browser-local provider uses an exact approved endpoint rather than a remote account.",
    },
    authMethods: [{
      id: `${kind}-loopback`,
      kind: "local-none",
      label: "Local endpoint",
      browserUse: "loopback-only",
    }],
    capabilities: ["invoke", "models:list"],
    documentationUrl: kind === "ollama"
      ? "https://docs.ollama.com/api/introduction"
      : "https://lmstudio.ai/docs/developer/core/server",
  };
  return Object.freeze(descriptor);
}

function localProviderId(
  kind: LocalModelProviderKind,
  endpoint: URL,
): string {
  const defaultOrigin = kind === "ollama"
    ? "http://127.0.0.1:11434"
    : "http://127.0.0.1:1234";
  if (endpoint.origin === defaultOrigin) return kind;
  const host = safeIdentifierToken(endpoint.hostname) || "local";
  const port = endpoint.port || (endpoint.protocol === "https:" ? "443" : "80");
  const hash = fnv1a(endpoint.origin);
  return assertIdentifier(
    `${kind}-${host.slice(0, 48)}-${port}-${hash}`,
    "Local provider ID",
  );
}

function bindModels(
  models: readonly InferenceModelDescriptor[],
  connection: InferenceConnectionMetadata,
  providerId: string,
): readonly InferenceModelDescriptor[] {
  if (connection.providerId !== providerId) {
    throw new Error("A model roster cannot be bound to another provider's connection.");
  }
  return Object.freeze(models.map((model) => {
    /*
     * A transport is allowed to discover a roster under a short-lived staging
     * connection, so the connection ID and generation are deliberately
     * rebound at commit. The provider identity is not staging metadata: a
     * mismatched row would cross an inference authority boundary and must fail
     * closed instead of being silently relabelled.
     */
    if (model.providerId !== providerId) {
      throw new Error("A model roster cannot contain another provider's models.");
    }
    return Object.freeze({
      ...model,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      providerId,
    });
  }));
}

function providerSemantics(provider: InferenceProviderDescriptor): string {
  return JSON.stringify({
    id: provider.id,
    protocol: provider.protocol,
    transportBoundary: provider.transportBoundary,
    baseUrl: provider.baseUrl,
    modelsUrl: provider.modelsUrl,
    oauth: provider.oauth,
    authMethods: provider.authMethods,
    capabilities: provider.capabilities,
    documentationUrl: provider.documentationUrl,
  });
}

function assertIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string"
    || !/^[a-z0-9][a-z0-9._:/-]{0,127}$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function safeIdentifierToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

async function verifyInvocation(
  transport: InferenceTransport,
  model: string,
  signal: AbortSignal,
): Promise<void> {
  const requestId = randomUuid();
  const message: CanonicalMessage = {
    role: "user",
    content: "Reply with OK.",
  };
  const request: InferenceRequest = {
    requestId,
    sessionId: `connection-probe-${requestId}`,
    turnId: `turn-${requestId}`,
    model,
    systemPrompt: "This is a bounded Airship connection check. Reply only with OK.",
    messages: [message],
    tools: [],
    idempotencyKey: `airship-connection-probe-${requestId}`,
  };
  let completed = false;
  for await (const event of transport.stream(request, signal)) {
    if (event.type === "completed") completed = true;
  }
  if (!completed) throw new Error("The provider ended the authorization probe without completing it.");
}

export const browserInferenceFabric = new BrowserInferenceFabric();
