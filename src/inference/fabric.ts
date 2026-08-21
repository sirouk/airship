import type {
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
  OpenAiCompatibleBrowserTransport,
  ResponsesBrowserTransport,
  type BrowserCloudTransportOptions,
} from "./providers/browser-cloud";
import { InferenceConnectionRegistry } from "./providers/connection-registry";
import {
  type InferenceAvailabilitySnapshot,
  type InferenceAuthMethod,
  type InferenceConnectionMetadata,
  type InferenceModelDescriptor,
  type InferenceProviderDescriptor,
  type PinnedRouteResolution,
  type SessionInferenceRoutePin,
} from "./providers/contracts";
import { InferenceModelCatalog } from "./providers/model-catalog";
import { createOpenAiCompatibleProvider, type OpenAiCompatibleProviderInput } from "./providers/openai-compatible-provider";
import { OFFICIAL_CLOUD_PROVIDERS } from "./providers/official-providers";
import { InferenceProviderCatalog, normalizeProvider } from "./providers/provider-catalog";
import { boundedText, credential } from "./providers/validation";
import {
  createInferenceAvailabilitySnapshot,
  pinInferenceRoute,
  resolvePinnedInferenceRoute,
} from "./providers/session-route";

export type BrowserCloudProviderId = "openai" | "anthropic" | "xai" | "chutes";
export type BrowserFabricProviderId = string;

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
    provider: InferenceProviderDescriptor,
    options: BrowserCloudTransportOptions,
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
    providerId: string;
    /** A user-owned descriptor staged transactionally with its first connection. */
    provider?: InferenceProviderDescriptor;
    connectionId?: string;
    label?: string;
    apiKey: string;
    acknowledgeDirectBrowserCredentialRisk: true;
    signal?: AbortSignal;
  }>): Promise<BrowserInferenceConnection> {
    /*
     * `args` belongs to the caller and may be a proxy or expose accessors. Read
     * every field once before any asynchronous boundary, then validate and use
     * only these local values for both discovery and promotion. This prevents a
     * getter from offering one credential/provider/signal to discovery and a
     * different one to the committed authority.
     */
    const rawProviderId = args.providerId;
    const rawProvider = args.provider;
    const rawConnectionId = args.connectionId;
    const rawLabel = args.label;
    const rawApiKey = args.apiKey;
    const acknowledged = args.acknowledgeDirectBrowserCredentialRisk;
    const rawSignal = args.signal;

    const providerId = assertIdentifier(rawProviderId, "Provider ID");
    const requestedConnectionId = rawConnectionId === undefined
      ? undefined
      : assertIdentifier(rawConnectionId, "Connection ID");
    const requestedLabel = optionalConnectionLabel(rawLabel);
    const apiKey = credential(rawApiKey, "Inference API key");
    if (acknowledged !== true) {
      throw new Error("Direct browser credential use requires explicit acknowledgement.");
    }
    const signal = optionalAbortSignal(rawSignal);
    signal?.throwIfAborted();

    const provider = rawProvider === undefined
      ? this.providers.require(providerId).provider
      : snapshotProviderDescriptor(rawProvider);
    if (provider.id !== providerId) {
      throw new TypeError("The custom provider descriptor does not match its provider ID.");
    }
    const stagingProviders = new InferenceProviderCatalog([provider]);
    const currentProvider = this.providers.get(provider.id);
    if (currentProvider && providerSemantics(currentProvider.provider) !== providerSemantics(provider)) {
      throw new Error(`Inference provider ${provider.id} is already bound to another endpoint.`);
    }
    const method = provider.authMethods.find((candidate) => candidate.kind === "api-key");
    if (!method || method.kind !== "api-key") {
      throw new Error(`${provider.label} has no configured API-key method.`);
    }
    const connectionLabel = requestedLabel || `${provider.label} · page memory`;
    // Validate the derived default before the staging registry reads it.
    boundedText(connectionLabel, "Connection label", 128);
    const connectionId = this.#reserveConnectionId(
      requestedConnectionId ?? this.#freshConnectionId(providerId),
    );
    const stagingConnections = new InferenceConnectionRegistry(stagingProviders, this.#now);
    let providerRegistration: Readonly<{ created: boolean; revision: number }> | undefined;
    try {
      /*
       * Discovery borrows the proposed key from isolated page-memory catalogs.
       * The live provider, connection, and model authorities stay untouched
       * until the endpoint returns a valid non-empty model roster.
       */
      const stagedConnection = stagingConnections.connectApiKey({
        id: connectionId,
        providerId: provider.id,
        authMethodId: method.id,
        label: connectionLabel,
        apiKey,
      });
      const stagedTransport = this.#cloudTransportFactory(provider, {
        connectionId,
        connectionGeneration: stagedConnection.generation,
        connections: stagingConnections,
      });
      const discovered = await stagedTransport.listModels(signal);
      if (discovered.length === 0) {
        throw new Error(`${provider.label} returned no models to this credential.`);
      }
      signal?.throwIfAborted();
      const checkedAt = this.#nowIso();
      const stagingModels = new InferenceModelCatalog(stagingProviders);
      stagingModels.replaceConnectionModels(
        stagedConnection.id,
        stagedConnection.generation,
        provider.id,
        discovered,
      );

      /*
       * Construct the long-lived transport before publishing any live
       * authority. A factory/configuration failure must not even revise the
       * provider catalog; the transport does not lease the credential until a
       * later request.
       */
      const promotedGeneration = this.connections.nextGeneration(connectionId);
      const committedTransport = this.#cloudTransportFactory(provider, {
        connectionId,
        connectionGeneration: promotedGeneration,
        connections: this.connections,
        maxOutputTokensForModel: (modelId) =>
          this.models.get(connectionId, promotedGeneration, modelId)?.maxOutputTokens,
      });
      providerRegistration = this.#ensureProvider(provider);
      const connection = this.connections.connectApiKey({
        id: connectionId,
        providerId: provider.id,
        authMethodId: method.id,
        label: connectionLabel,
        apiKey,
      });
      if (connection.generation !== promotedGeneration) {
        throw new Error("The reserved inference generation changed during promotion.");
      }
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
        // The descriptor exposes an inference route. Access is exercised by
        // the person's first turn, never by a hidden billable prompt.
        invoke: { state: "available", source: "provider-declared" },
      });
      const transport = this.#bindTransport(committedTransport, connection);
      this.#transports.set(connection.id, transport);
      this.#emit();
      return this.#requireVisible(connection.id);
    } catch (error) {
      this.#rollbackCandidate(connectionId);
      if (
        providerRegistration?.created
        && !this.connections.snapshot().connections.some((entry) => entry.providerId === provider.id)
      ) {
        this.providers.unregister(provider.id, providerRegistration.revision);
      }
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

  async connectOpenAiCompatible(args: Readonly<{
    provider: OpenAiCompatibleProviderInput;
    connectionId?: string;
    connectionLabel?: string;
    apiKey: string;
    acknowledgeDirectBrowserCredentialRisk: true;
    signal?: AbortSignal;
  }>): Promise<BrowserInferenceConnection> {
    // Snapshot this entry point independently. `createOpenAiCompatibleProvider`
    // must await SHA-256, so no caller-owned accessor may remain to be read
    // after that digest starts.
    const rawProvider = args.provider;
    const rawConnectionId = args.connectionId;
    const rawConnectionLabel = args.connectionLabel;
    const rawApiKey = args.apiKey;
    const acknowledged = args.acknowledgeDirectBrowserCredentialRisk;
    const rawSignal = args.signal;

    const requestedConnectionId = rawConnectionId === undefined
      ? undefined
      : assertIdentifier(rawConnectionId, "Connection ID");
    const connectionLabel = optionalConnectionLabel(rawConnectionLabel);
    const apiKey = credential(rawApiKey, "Inference API key");
    if (acknowledged !== true) {
      throw new Error("Direct browser credential use requires explicit acknowledgement.");
    }
    const signal = optionalAbortSignal(rawSignal);
    signal?.throwIfAborted();
    // The creator reads and validates all nested provider fields synchronously
    // before returning this digest promise.
    const providerPromise = createOpenAiCompatibleProvider(rawProvider);
    const provider = await providerPromise;
    signal?.throwIfAborted();
    return await this.connectCloud({
      providerId: provider.id,
      provider,
      ...(requestedConnectionId === undefined
        ? {}
        : { connectionId: requestedConnectionId }),
      ...(connectionLabel === undefined ? {} : { label: connectionLabel }),
      apiKey,
      acknowledgeDirectBrowserCredentialRisk: true,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async connectLocal(args: Readonly<{
    kind: LocalModelProviderKind;
    connectionId?: string;
    label?: string;
    options?: LocalProviderOptions;
    signal?: AbortSignal;
  }>): Promise<BrowserInferenceConnection> {
    /*
     * `args` and `args.options` belong to the caller. Snapshot every supported
     * field before invoking a factory or crossing the discovery await. The
     * frozen copy prevents accessors or later mutation from giving discovery
     * one local authority and promotion another.
     */
    const rawKind = args.kind;
    const rawConnectionId = args.connectionId;
    const rawLabel = args.label;
    const rawOptions = args.options;
    const rawSignal = args.signal;
    // Read all nested option accessors before validating or using any field.
    const options = snapshotLocalProviderOptions(rawOptions);
    const snapshot = Object.freeze({
      kind: assertLocalProviderKind(rawKind),
      connectionId: rawConnectionId === undefined
        ? undefined
        : assertIdentifier(rawConnectionId, "Connection ID"),
      label: optionalConnectionLabel(rawLabel),
      options,
      signal: optionalAbortSignal(rawSignal),
    });
    snapshot.signal?.throwIfAborted();

    /*
     * The current fabric contract registers local endpoints as `local-none`.
     * Passing a credential resolver through to the provider would therefore
     * make the transport authenticated while the connection metadata, session
     * pin, prompt roster, and UI all claimed that no credential existed.
     * Fail closed until authenticated-local custody has its own reviewed auth
     * method and generation-bound registry path.
     */
    if (snapshot.options?.credential) {
      throw new Error(
        "Authenticated local-model endpoints require a dedicated page-memory authority; "
        + "this local-none connection accepts only an unauthenticated loopback service.",
      );
    }
    // Keep the injectable provider seam, but give it only the immutable copy.
    const provider = this.#localProviderFactory(snapshot.kind, snapshot.options);
    // A provider may expose its URL through a getter or a mutable URL object.
    // Copy it once so descriptor, identifier, and both registry stages agree.
    const endpoint = snapshotLocalProviderEndpoint(provider.endpoint);
    const descriptor = localProviderDescriptor(
      snapshot.kind,
      endpoint,
      localProviderId(snapshot.kind, endpoint),
    );
    const authMethodId = `${snapshot.kind}-loopback`;
    const connectionLabel = snapshot.label
      ?? `${descriptor.label} · ${endpoint.origin}`;
    boundedText(connectionLabel, "Connection label", 128);
    const connectionId = this.#reserveConnectionId(
      snapshot.connectionId ?? this.#freshConnectionId(snapshot.kind),
    );
    try {
      /*
       * Discover and normalize into isolated catalogs first. Successful model
       * discovery is the readiness check; a second health request here would
       * hit the endpoint twice before promotion. A failed endpoint, empty
       * directory, invalid model row, or cancellation therefore cannot revise
       * a live provider or replace a working connection.
       */
      const stagingProviders = new InferenceProviderCatalog([descriptor]);
      const stagingConnections = new InferenceConnectionRegistry(stagingProviders, this.#now);
      const stagedConnection = stagingConnections.connectLocal({
        id: connectionId,
        providerId: descriptor.id,
        authMethodId,
        label: connectionLabel,
      });
      const connected = await connectLocalProvider(provider, {
        connectionId,
        connectionGeneration: stagedConnection.generation,
        providerId: descriptor.id,
      }, snapshot.signal);
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
        checkedAt: connected.discovery.fetchedAt,
      });
      stagingConnections.updateCapabilities(stagedConnection.id, {
        "models:list": {
          state: "available",
          source: "live-probe",
          checkedAt: connected.discovery.fetchedAt,
        },
        invoke: {
          state: "unknown",
          source: "live-probe",
          checkedAt: connected.discovery.fetchedAt,
        },
      });
      snapshot.signal?.throwIfAborted();

      this.#ensureProvider(descriptor);
      const connection = this.connections.connectLocal({
        id: connectionId,
        providerId: descriptor.id,
        authMethodId,
        label: connectionLabel,
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
        checkedAt: connected.discovery.fetchedAt,
      });
      this.connections.updateCapabilities(connection.id, {
        "models:list": {
          state: "available",
          source: "live-probe",
          checkedAt: connected.discovery.fetchedAt,
        },
        invoke: { state: "available", source: "provider-declared" },
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
   * Select a model without sending a hidden provider request.
   *
   * Model discovery already checked the configured catalog path. The first
   * user turn exercises inference access and may consume provider quota; model
   * selection itself is local and only pins the exact authority generation.
   */
  async activate(
    connectionId: string,
    modelId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ActivatedInferenceRoute> {
    signal.throwIfAborted();
    const connection = this.connections.require(connectionId);
    const provider = this.providers.require(connection.providerId);
    const transport = this.#transports.get(connection.id);
    if (!transport) throw new Error("The selected inference transport is no longer in page memory.");
    const model = this.models.require(connection.id, connection.generation, modelId);
    const currentConnection = this.connections.get(connection.id);
    const currentProvider = this.providers.get(connection.providerId);
    if (
      !currentConnection
      || currentConnection.generation !== connection.generation
      || currentProvider?.revision !== provider.revision
      || this.models.get(connection.id, connection.generation, modelId) !== model
      || this.#transports.get(connection.id) !== transport
    ) {
      throw new Error("The inference authority changed while the model was being selected. Retry against the current connection.");
    }
    const pin = pinInferenceRoute(this.providers, this.connections, this.models, {
      connectionId: connection.id,
      modelId,
      pinnedAt: this.#nowIso(),
    });
    signal.throwIfAborted();
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

  #ensureProvider(descriptor: InferenceProviderDescriptor): Readonly<{ created: boolean; revision: number }> {
    const current = this.providers.get(descriptor.id);
    if (!current) {
      const registered = this.providers.register(descriptor);
      return Object.freeze({ created: true, revision: registered.revision });
    }
    if (providerSemantics(current.provider) !== providerSemantics(descriptor)) {
      throw new Error(
        `Inference provider ${descriptor.id} is already bound to another endpoint.`,
      );
    }
    return Object.freeze({ created: false, revision: current.revision });
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
  | ResponsesBrowserTransport
  | AnthropicBrowserTransport
  | OpenAiCompatibleBrowserTransport;

/**
 * The wire a descriptor declares decides the transport. Nothing here reads a
 * provider ID.
 *
 * This used to `switch (provider.id)` over openai/anthropic/xai, which made
 * three names the only ones the canonical seam could serve: `normalizeProvider`
 * accepted a user descriptor declaring `openai-responses` or
 * `anthropic-messages`, and then this function refused it. Each transport now
 * reads its origin, catalog and wire details from the descriptor it is given,
 * so a reviewed first-party provider and a descriptor someone wrote this
 * morning take the identical path.
 */
function cloudTransport(
  provider: InferenceProviderDescriptor,
  options: BrowserCloudTransportOptions,
): CloudCatalogTransport {
  if (provider.transportBoundary !== "provider-tls") {
    throw new Error(`${provider.label} has no browser-cloud transport.`);
  }
  switch (provider.protocol) {
    case "openai-responses": return new ResponsesBrowserTransport(provider, options);
    case "anthropic-messages": return new AnthropicBrowserTransport(provider, options);
    case "openai-compatible":
    case "openai-chat-completions": return new OpenAiCompatibleBrowserTransport(provider, options);
  }
  throw new Error(`${provider.label} has no browser-cloud transport.`);
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

function assertLocalProviderKind(value: LocalModelProviderKind): LocalModelProviderKind {
  if (value !== "ollama" && value !== "lm-studio") {
    throw new TypeError("Local inference provider kind is invalid.");
  }
  return value;
}

/**
 * Copy every supported option out of a caller-owned object exactly once. The
 * stock providers may revisit fields while applying endpoint and HTTP policy;
 * they must only ever revisit this plain frozen copy.
 */
function snapshotLocalProviderOptions(
  raw: LocalProviderOptions | undefined,
): LocalProviderOptions | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || (typeof raw !== "object" && typeof raw !== "function")) {
    throw new TypeError("Local inference provider options are invalid.");
  }
  const pageUrl = raw.pageUrl;
  const endpoint = raw.endpoint;
  const credentialResolver = raw.credential;
  const fetchImpl = raw.fetch;
  const timeoutMs = raw.timeoutMs;
  const maxResponseBytes = raw.maxResponseBytes;
  const maxModels = raw.maxModels;
  return Object.freeze({
    ...(pageUrl === undefined ? {} : { pageUrl }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(credentialResolver === undefined ? {} : { credential: credentialResolver }),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    ...(maxModels === undefined ? {} : { maxModels }),
  });
}

function snapshotLocalProviderEndpoint(value: URL): URL {
  if (!value || typeof value !== "object") {
    throw new TypeError("Local inference provider endpoint is invalid.");
  }
  const href = value.href;
  if (typeof href !== "string") {
    throw new TypeError("Local inference provider endpoint is invalid.");
  }
  return new URL(href);
}

function optionalConnectionLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("Connection label is invalid.");
  const trimmed = value.trim();
  return trimmed ? boundedText(trimmed, "Connection label", 128) : undefined;
}

function optionalAbortSignal(value: AbortSignal | undefined): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) {
    throw new TypeError("Inference cancellation signal is invalid.");
  }
  return value;
}

/**
 * Copy a caller-owned descriptor into plain arrays, objects, and primitives
 * before catalog normalization. `normalizeProvider` legitimately revisits
 * fields while checking cross-field invariants; doing that against accessors
 * would allow the descriptor to change meaning during one connection attempt.
 */
function snapshotProviderDescriptor(
  raw: InferenceProviderDescriptor,
): InferenceProviderDescriptor {
  if (!raw || typeof raw !== "object") {
    throw new TypeError("Inference provider metadata is invalid.");
  }
  const version = raw.version;
  const id = raw.id;
  const label = raw.label;
  const protocol = raw.protocol;
  const transportBoundary = raw.transportBoundary;
  const baseUrl = raw.baseUrl;
  const modelsUrl = raw.modelsUrl;
  const rawOauth = raw.oauth;
  const rawAuthMethods = raw.authMethods;
  const rawCapabilities = raw.capabilities;
  const documentationUrl = raw.documentationUrl;

  if (!Array.isArray(rawAuthMethods)) {
    throw new TypeError("Provider authentication methods are invalid.");
  }
  if (!Array.isArray(rawCapabilities)) {
    throw new TypeError("Provider capabilities are invalid.");
  }
  const authMethods = Array.from(rawAuthMethods, snapshotAuthMethod);
  const capabilities = Array.from(rawCapabilities);
  return normalizeProvider({
    version,
    id,
    label,
    protocol,
    transportBoundary,
    baseUrl,
    ...(modelsUrl === undefined ? {} : { modelsUrl }),
    oauth: snapshotProviderOauth(rawOauth),
    authMethods,
    capabilities,
    ...(documentationUrl === undefined ? {} : { documentationUrl }),
  });
}

function snapshotProviderOauth(
  raw: InferenceProviderDescriptor["oauth"],
): InferenceProviderDescriptor["oauth"] {
  if (!raw || typeof raw !== "object") {
    throw new TypeError("Provider OAuth availability is required.");
  }
  const state = raw.state;
  const detail = raw.detail;
  if (state === "configured-public-pkce") {
    const authMethodId = raw.authMethodId;
    return { state, authMethodId, detail };
  }
  return { state, detail };
}

const FORBIDDEN_PUBLIC_OAUTH_FIELDS = new Set([
  "clientsecret",
  "client_secret",
  "client-secret",
  "tokenendpointauthsecret",
]);

function snapshotAuthMethod(raw: InferenceAuthMethod): InferenceAuthMethod {
  if (!raw || typeof raw !== "object") {
    throw new TypeError("Provider authentication method is invalid.");
  }
  const id = raw.id;
  const kind = raw.kind;
  const label = raw.label;
  const browserUse = raw.browserUse;
  if (kind === "api-key") {
    const apiKey = raw as Extract<InferenceAuthMethod, { kind: "api-key" }>;
    const rawHeader = apiKey.header;
    const warning = apiKey.warning;
    if (!rawHeader || typeof rawHeader !== "object") {
      throw new TypeError("Provider API-key header is invalid.");
    }
    const name = rawHeader.name;
    const scheme = rawHeader.scheme;
    return {
      id,
      kind,
      label,
      header: { name, scheme },
      browserUse: browserUse as Extract<InferenceAuthMethod, { kind: "api-key" }>["browserUse"],
      warning,
    };
  }
  if (kind === "oauth-public-pkce") {
    for (const key of Object.keys(raw)) {
      if (FORBIDDEN_PUBLIC_OAUTH_FIELDS.has(key.toLowerCase())) {
        throw new TypeError("Public PKCE metadata cannot contain a client secret.");
      }
    }
    const oauth = raw as Extract<InferenceAuthMethod, { kind: "oauth-public-pkce" }>;
    const authorizationEndpoint = oauth.authorizationEndpoint;
    const tokenEndpoint = oauth.tokenEndpoint;
    const clientId = oauth.clientId;
    const rawRedirectUris = oauth.redirectUris;
    const rawScopes = oauth.scopes;
    const tokenEndpointAuthMethod = oauth.tokenEndpointAuthMethod;
    const codeChallengeMethod = oauth.codeChallengeMethod;
    const rawReview = oauth.review;
    if (!Array.isArray(rawRedirectUris) || !Array.isArray(rawScopes)) {
      throw new TypeError("OAuth lists are invalid.");
    }
    if (!rawReview || typeof rawReview !== "object") {
      throw new TypeError("OAuth review metadata is invalid.");
    }
    const reviewId = rawReview.id;
    const reviewedAt = rawReview.reviewedAt;
    const sourceUrl = rawReview.sourceUrl;
    return {
      id,
      kind,
      label,
      authorizationEndpoint,
      tokenEndpoint,
      clientId,
      redirectUris: Array.from(rawRedirectUris),
      scopes: Array.from(rawScopes),
      tokenEndpointAuthMethod,
      codeChallengeMethod,
      browserUse: browserUse as Extract<
        InferenceAuthMethod,
        { kind: "oauth-public-pkce" }
      >["browserUse"],
      review: { id: reviewId, reviewedAt, sourceUrl },
    };
  }
  if (kind === "local-none") {
    return {
      id,
      kind,
      label,
      browserUse: browserUse as Extract<
        InferenceAuthMethod,
        { kind: "local-none" }
      >["browserUse"],
    };
  }
  // Preserve an invalid discriminant for the catalog's canonical validator.
  return { id, kind, label, browserUse } as InferenceAuthMethod;
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

export const browserInferenceFabric = new BrowserInferenceFabric();
