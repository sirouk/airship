import { deepFreeze } from "../../core/freeze";
import {
  CONNECTION_CAPABILITIES,
  type ConnectionCapability,
  type ConnectionCapabilityEvidence,
  type EphemeralInferenceCredential,
  type InferenceAuthMethod,
  type InferenceConnectionHealth,
  type InferenceConnectionMetadata,
  type InferenceConnectionSnapshot,
  type PublicPkceAuthMethod,
} from "./contracts";
import type { InferenceProviderCatalog } from "./provider-catalog";
import {
  boundedText,
  canonicalTimestamp,
  credential,
  identifier,
  nonNegativeFinite,
  optionalCode,
  scopes,
} from "./validation";

type ApiKeyRecord = {
  kind: "api-key";
  metadata: InferenceConnectionMetadata;
  credential: string;
};

type OAuthRecord = {
  kind: "oauth-public-pkce";
  metadata: InferenceConnectionMetadata;
  accessToken: string;
  refreshToken?: string;
};

type LocalRecord = {
  kind: "local-none";
  metadata: InferenceConnectionMetadata;
};

type ConnectionRecord = ApiKeyRecord | OAuthRecord | LocalRecord;

export type ConnectApiKeyInput = Readonly<{
  id: string;
  providerId: string;
  authMethodId: string;
  label: string;
  apiKey: string;
  connectedAt?: string;
}>;

export type ConnectOAuthInput = Readonly<{
  id: string;
  providerId: string;
  authMethodId: string;
  label: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scopes: readonly string[];
  connectedAt?: string;
}>;

export type ConnectLocalInput = Readonly<{
  id: string;
  providerId: string;
  authMethodId: string;
  label: string;
  connectedAt?: string;
}>;

export type RotateOAuthInput = Readonly<{
  connectionId: string;
  expectedGeneration: number;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scopes: readonly string[];
}>;

export type CredentialUseRequest = Readonly<{
  /** Reject a reconnected account that reused the same connection ID. */
  expectedGeneration?: number;
  requiredCapabilities?: readonly ConnectionCapability[];
  signal?: AbortSignal;
}>;

/**
 * Page-memory credential authority for all inference providers.
 *
 * There is deliberately no export, serialization, persistence, or token
 * getter. A transport receives an ephemeral credential only for the duration
 * of a callback. JavaScript cannot prevent a malicious callback from retaining
 * a string, so transports passed here remain part of the trusted client TCB.
 */
export class InferenceConnectionRegistry {
  readonly #records = new Map<string, ConnectionRecord>();
  readonly #generations = new Map<string, number>();
  #revision = 0;

  constructor(
    readonly providers: InferenceProviderCatalog,
    readonly now: () => number = Date.now,
  ) {}

  connectApiKey(input: ConnectApiKeyInput): InferenceConnectionMetadata {
    const prepared = this.#prepareConnection(input, "api-key");
    const record: ApiKeyRecord = {
      kind: "api-key",
      metadata: prepared.metadata,
      credential: credential(input.apiKey, "Inference API key"),
    };
    return this.#replace(prepared.id, record);
  }

  connectOAuth(input: ConnectOAuthInput): InferenceConnectionMetadata {
    const prepared = this.#prepareConnection(input, "oauth-public-pkce");
    const method = prepared.method as PublicPkceAuthMethod;
    const grantedScopes = scopes(input.scopes, "Granted OAuth scopes");
    for (const scope of grantedScopes) {
      if (!method.scopes.includes(scope)) {
        throw new TypeError(`OAuth returned an unregistered scope: ${scope}.`);
      }
    }
    const expiresAt = canonicalTimestamp(input.expiresAt, "OAuth expiry");
    if (Date.parse(expiresAt) <= this.#readNow()) {
      throw new TypeError("An expired OAuth access token cannot be connected.");
    }
    const metadata = deepFreeze({
      ...prepared.metadata,
      expiresAt,
      scopes: grantedScopes,
      refreshable: input.refreshToken !== undefined,
    }) as InferenceConnectionMetadata;
    const record: OAuthRecord = {
      kind: "oauth-public-pkce",
      metadata,
      accessToken: credential(input.accessToken, "OAuth access token"),
      ...(input.refreshToken
        ? { refreshToken: credential(input.refreshToken, "OAuth refresh token") }
        : {}),
    };
    return this.#replace(prepared.id, record);
  }

  connectLocal(input: ConnectLocalInput): InferenceConnectionMetadata {
    const prepared = this.#prepareConnection(input, "local-none");
    return this.#replace(prepared.id, {
      kind: "local-none",
      metadata: prepared.metadata,
    });
  }

  /**
   * Rotate tokens for the same OAuth grant without changing the connection
   * generation pinned by an active session. Re-consent must use connectOAuth
   * instead and therefore creates a new generation.
   */
  rotateOAuth(input: RotateOAuthInput): InferenceConnectionMetadata {
    const record = this.#requireRecord(input.connectionId);
    if (record.kind !== "oauth-public-pkce") {
      throw new TypeError("Only a public-PKCE OAuth connection can rotate OAuth tokens.");
    }
    if (record.metadata.generation !== input.expectedGeneration) {
      throw new Error("The OAuth refresh result belongs to a stale connection generation.");
    }
    const provider = this.providers.require(record.metadata.providerId).provider;
    const method = provider.authMethods.find((candidate) =>
      candidate.id === record.metadata.authMethodId
    );
    if (method?.kind !== "oauth-public-pkce") {
      throw new Error("The pinned OAuth registration is no longer available.");
    }
    const grantedScopes = scopes(input.scopes, "Refreshed OAuth scopes");
    for (const scope of grantedScopes) {
      if (!method.scopes.includes(scope)) {
        throw new TypeError(`OAuth refresh returned an unregistered scope: ${scope}.`);
      }
    }
    const expiresAt = canonicalTimestamp(input.expiresAt, "OAuth expiry");
    if (Date.parse(expiresAt) <= this.#readNow()) {
      throw new TypeError("An expired OAuth access token cannot be installed.");
    }
    const refreshToken = input.refreshToken
      ? credential(input.refreshToken, "OAuth refresh token")
      : record.refreshToken;
    const metadata = deepFreeze({
      ...record.metadata,
      expiresAt,
      scopes: grantedScopes,
      refreshable: refreshToken !== undefined,
      health: { state: "unchecked" },
    }) as InferenceConnectionMetadata;
    this.#records.set(record.metadata.id, {
      kind: "oauth-public-pkce",
      metadata,
      accessToken: credential(input.accessToken, "OAuth access token"),
      ...(refreshToken ? { refreshToken } : {}),
    });
    this.#revision += 1;
    return metadata;
  }

  disconnect(connectionId: string): boolean {
    const id = identifier(connectionId, "Connection ID");
    const deleted = this.#records.delete(id);
    if (deleted) this.#revision += 1;
    return deleted;
  }

  clear(): void {
    if (this.#records.size === 0) return;
    this.#records.clear();
    this.#revision += 1;
  }

  nextGeneration(connectionId: string): number {
    const id = identifier(connectionId, "Connection ID");
    return (this.#generations.get(id) ?? 0) + 1;
  }

  get(connectionId: string): InferenceConnectionMetadata | undefined {
    const record = this.#records.get(connectionId);
    return record ? this.#liveMetadata(record.metadata) : undefined;
  }

  require(connectionId: string): InferenceConnectionMetadata {
    const metadata = this.get(connectionId);
    if (!metadata) throw new Error(`Inference connection ${connectionId} is not connected.`);
    return metadata;
  }

  snapshot(): InferenceConnectionSnapshot {
    return deepFreeze({
      version: 1,
      revision: this.#revision,
      connections: [...this.#records.values()]
        .map((record) => this.#liveMetadata(record.metadata))
        .sort((left, right) => left.id.localeCompare(right.id)),
    }) as InferenceConnectionSnapshot;
  }

  updateHealth(
    connectionId: string,
    rawHealth: InferenceConnectionHealth,
  ): InferenceConnectionMetadata {
    const record = this.#requireRecord(connectionId);
    const health = normalizeHealth(rawHealth);
    record.metadata = deepFreeze({ ...record.metadata, health }) as InferenceConnectionMetadata;
    this.#revision += 1;
    return this.#liveMetadata(record.metadata);
  }

  updateCapabilities(
    connectionId: string,
    updates: Readonly<Partial<Record<ConnectionCapability, ConnectionCapabilityEvidence>>>,
  ): InferenceConnectionMetadata {
    const record = this.#requireRecord(connectionId);
    const provider = this.providers.require(record.metadata.providerId).provider;
    const next = { ...record.metadata.capabilities };
    for (const [rawCapability, rawEvidence] of Object.entries(updates)) {
      if (!CONNECTION_CAPABILITIES.includes(rawCapability as ConnectionCapability) || !rawEvidence) {
        throw new TypeError("Connection capability update is invalid.");
      }
      const capability = rawCapability as ConnectionCapability;
      const evidence = normalizeCapabilityEvidence(rawEvidence);
      if (evidence.state === "available" && !provider.capabilities.includes(capability)) {
        throw new TypeError(`Provider ${provider.id} does not declare ${capability}.`);
      }
      next[capability] = evidence;
    }
    record.metadata = deepFreeze({
      ...record.metadata,
      capabilities: next,
    }) as InferenceConnectionMetadata;
    this.#revision += 1;
    return this.#liveMetadata(record.metadata);
  }

  async useCredential<T>(
    connectionId: string,
    request: CredentialUseRequest,
    use: (credential: EphemeralInferenceCredential) => T | Promise<T>,
  ): Promise<T> {
    request.signal?.throwIfAborted();
    const record = this.#requireRecord(connectionId);
    const metadata = this.#liveMetadata(record.metadata);
    if (
      request.expectedGeneration !== undefined
      && metadata.generation !== request.expectedGeneration
    ) {
      throw new Error(
        `Inference connection ${connectionId} no longer matches credential generation `
        + `${request.expectedGeneration}.`,
      );
    }
    if (metadata.health.state === "expired") {
      throw new Error(`Inference connection ${connectionId} has expired.`);
    }
    const required = new Set(request.requiredCapabilities ?? []);
    for (const capability of required) {
      if (!CONNECTION_CAPABILITIES.includes(capability)) {
        throw new TypeError(`Unknown inference capability: ${capability}.`);
      }
      if (metadata.capabilities[capability].state !== "available") {
        throw new Error(`Inference connection ${connectionId} has not proved ${capability}.`);
      }
    }
    request.signal?.throwIfAborted();
    const ephemeral: EphemeralInferenceCredential = record.kind === "api-key"
      ? deepFreeze({ kind: "api-key", value: record.credential })
      : record.kind === "oauth-public-pkce"
        ? deepFreeze({ kind: "oauth-access-token", value: record.accessToken })
        : deepFreeze({ kind: "local-none" });
    return await use(ephemeral);
  }

  #prepareConnection(
    input: ConnectApiKeyInput | ConnectOAuthInput | ConnectLocalInput,
    expectedKind: InferenceAuthMethod["kind"],
  ): Readonly<{
    id: string;
    method: InferenceAuthMethod;
    metadata: InferenceConnectionMetadata;
  }> {
    const id = identifier(input.id, "Connection ID");
    const providerId = identifier(input.providerId, "Provider ID");
    const provider = this.providers.require(providerId).provider;
    const authMethodId = identifier(input.authMethodId, "Authentication method ID");
    const method = provider.authMethods.find((candidate) => candidate.id === authMethodId);
    if (!method || method.kind !== expectedKind) {
      throw new TypeError(`${provider.label} does not expose ${expectedKind} as ${authMethodId}.`);
    }
    if (
      expectedKind === "oauth-public-pkce"
      && (
        provider.oauth.state !== "configured-public-pkce"
        || provider.oauth.authMethodId !== authMethodId
      )
    ) {
      throw new TypeError("OAuth connection requires configured reviewed public-PKCE metadata.");
    }
    const generation = (this.#generations.get(id) ?? 0) + 1;
    const connectedAt = canonicalTimestamp(
      input.connectedAt ?? new Date(this.#readNow()).toISOString(),
      "Connection timestamp",
    );
    const capabilities = initialCapabilities(provider.capabilities);
    const metadata = deepFreeze({
      version: 1,
      id,
      generation,
      providerId,
      label: boundedText(input.label, "Connection label", 128),
      authMethodId,
      authKind: expectedKind,
      connectedAt,
      scopes: Object.freeze([]),
      refreshable: false,
      health: deepFreeze({ state: "unchecked" }),
      capabilities,
    }) as InferenceConnectionMetadata;
    return deepFreeze({ id, method, metadata });
  }

  #replace(id: string, record: ConnectionRecord): InferenceConnectionMetadata {
    this.#records.set(id, record);
    this.#generations.set(id, record.metadata.generation);
    this.#revision += 1;
    return this.#liveMetadata(record.metadata);
  }

  #requireRecord(connectionId: string): ConnectionRecord {
    const id = identifier(connectionId, "Connection ID");
    const record = this.#records.get(id);
    if (!record) throw new Error(`Inference connection ${id} is not connected.`);
    return record;
  }

  #liveMetadata(metadata: InferenceConnectionMetadata): InferenceConnectionMetadata {
    if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= this.#readNow()) {
      return deepFreeze({
        ...metadata,
        health: {
          state: "expired",
          checkedAt: new Date(this.#readNow()).toISOString(),
          code: "oauth-token-expired",
        },
      }) as InferenceConnectionMetadata;
    }
    return metadata;
  }

  #readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) throw new Error("The connection clock is invalid.");
    return now;
  }
}

function initialCapabilities(
  declared: readonly ConnectionCapability[],
): Readonly<Record<ConnectionCapability, ConnectionCapabilityEvidence>> {
  return deepFreeze(Object.fromEntries(
    CONNECTION_CAPABILITIES.map((capability) => [
      capability,
      {
        state: declared.includes(capability) ? "unknown" : "unavailable",
        source: "provider-declared",
      },
    ]),
  )) as Readonly<Record<ConnectionCapability, ConnectionCapabilityEvidence>>;
}

function normalizeHealth(raw: InferenceConnectionHealth): InferenceConnectionHealth {
  const states = new Set(["unchecked", "ready", "degraded", "offline", "expired"]);
  if (!states.has(raw.state)) throw new TypeError("Connection health is invalid.");
  const checkedAt = raw.checkedAt
    ? canonicalTimestamp(raw.checkedAt, "Connection health timestamp")
    : undefined;
  if (raw.state !== "unchecked" && !checkedAt) {
    throw new TypeError("Checked connection health requires a timestamp.");
  }
  const latencyMs = raw.latencyMs === undefined
    ? undefined
    : nonNegativeFinite(raw.latencyMs, "Connection latency", 24 * 60 * 60_000);
  const code = optionalCode(raw.code, "Connection health code");
  return deepFreeze({
    state: raw.state,
    ...(checkedAt ? { checkedAt } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(code ? { code } : {}),
  });
}

function normalizeCapabilityEvidence(
  raw: ConnectionCapabilityEvidence,
): ConnectionCapabilityEvidence {
  const states = new Set(["available", "unavailable", "unknown"]);
  const sources = new Set(["provider-declared", "oauth-scope", "live-probe", "manual"]);
  if (!states.has(raw.state) || !sources.has(raw.source)) {
    throw new TypeError("Connection capability evidence is invalid.");
  }
  return deepFreeze({
    state: raw.state,
    source: raw.source,
    ...(raw.checkedAt
      ? { checkedAt: canonicalTimestamp(raw.checkedAt, "Capability check timestamp") }
      : {}),
  });
}
