export const CONNECTION_CAPABILITIES = [
  "invoke",
  "models:list",
  "identity:read",
  "billing:read",
  "usage:read",
] as const;

export type ConnectionCapability = (typeof CONNECTION_CAPABILITIES)[number];

export const MODEL_CAPABILITIES = [
  "text-input",
  "text-output",
  "image-input",
  "audio-input",
  "audio-output",
  "tool-calling",
  "parallel-tool-calling",
  "reasoning",
  "embeddings",
  "structured-output",
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/*
 * Upper bounds every declared model limit has to fall under.
 *
 * Both numbers sit far above any published model, so they are typo and
 * overflow guards rather than a claim about what a vendor supports. They live
 * here, next to the descriptor they bound, because more than one layer has to
 * agree on them: `normalizeModel` refuses a declaration above the ceiling, and
 * `AnthropicBrowserTransport` revalidates the same declaration when it builds
 * the request. If those two ceilings ever diverged, a number the catalog
 * accepted would throw on the next turn and brick the model until it was
 * declared again.
 */
export const MAX_MODEL_CONTEXT_WINDOW_TOKENS = 100_000_000;
export const MAX_MODEL_OUTPUT_TOKENS = 8_000_000;

export type InferenceProtocol =
  | "chutes-e2ee-v1"
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "openai-compatible";

export type InferenceTransportBoundary =
  | "e2ee-attestable"
  | "provider-tls"
  | "loopback-local";

export type BrowserCredentialUse =
  | "reviewed-direct"
  | "dangerous-user-opt-in"
  | "direct-contract-unpublished"
  | "companion-required"
  | "loopback-only";

export type ProviderOAuthAvailability =
  | Readonly<{
      state: "configured-public-pkce";
      authMethodId: string;
      detail: string;
    }>
  | Readonly<{
      state: "configuration-required" | "first-party-only" | "not-documented";
      detail: string;
    }>;

export type ApiKeyAuthMethod = Readonly<{
  id: string;
  kind: "api-key";
  label: string;
  header: Readonly<{
    name: string;
    scheme: "bearer" | "raw";
  }>;
  browserUse: BrowserCredentialUse;
  warning: string;
}>;

/**
 * Reviewed metadata for an OAuth 2.0 Authorization Code + S256 PKCE public
 * client. The absence of `clientSecret` is a runtime invariant, not just a
 * TypeScript convention.
 */
export type PublicPkceAuthMethod = Readonly<{
  id: string;
  kind: "oauth-public-pkce";
  label: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
  tokenEndpointAuthMethod: "none";
  codeChallengeMethod: "S256";
  browserUse: "reviewed-direct";
  review: Readonly<{
    id: string;
    reviewedAt: string;
    sourceUrl: string;
  }>;
}>;

export type LocalNoAuthMethod = Readonly<{
  id: string;
  kind: "local-none";
  label: string;
  browserUse: "loopback-only";
}>;

export type InferenceAuthMethod =
  | ApiKeyAuthMethod
  | PublicPkceAuthMethod
  | LocalNoAuthMethod;

export type InferenceProviderDescriptor = Readonly<{
  version: 1;
  id: string;
  label: string;
  protocol: InferenceProtocol;
  transportBoundary: InferenceTransportBoundary;
  baseUrl: string;
  modelsUrl?: string;
  oauth: ProviderOAuthAvailability;
  authMethods: readonly InferenceAuthMethod[];
  capabilities: readonly ConnectionCapability[];
  documentationUrl?: string;
}>;

export type ProviderCatalogEntry = Readonly<{
  revision: number;
  provider: InferenceProviderDescriptor;
}>;

export type ProviderCatalogSnapshot = Readonly<{
  version: 1;
  revision: number;
  providers: readonly ProviderCatalogEntry[];
}>;

export type ModelCapabilityEvidence = Readonly<{
  state: "supported" | "unsupported" | "unknown";
  source: "provider-directory" | "live-probe" | "manual" | "local-discovery";
  observedAt?: string;
}>;

export type ModelAvailability = Readonly<{
  state: "available" | "unavailable" | "unknown";
  source: "provider-directory" | "live-probe" | "manual" | "local-discovery";
  observedAt?: string;
  code?: string;
}>;

export type InferenceModelDescriptor = Readonly<{
  version: 1;
  /** Connection whose credential produced or proved this exact model row. */
  connectionId: string;
  /** Immutable credential generation observed during model discovery. */
  connectionGeneration: number;
  providerId: string;
  id: string;
  label: string;
  capabilities: Readonly<Partial<Record<ModelCapability, ModelCapabilityEvidence>>>;
  availability: ModelAvailability;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  source: Readonly<{
    kind: "provider-directory" | "live-probe" | "manual" | "local-discovery";
    observedAt: string;
    sourceUrl?: string;
  }>;
}>;

export type ModelCatalogSnapshot = Readonly<{
  version: 1;
  revision: number;
  models: readonly InferenceModelDescriptor[];
}>;

export type ConnectionCapabilityEvidence = Readonly<{
  state: "available" | "unavailable" | "unknown";
  source: "provider-declared" | "oauth-scope" | "live-probe" | "manual";
  checkedAt?: string;
}>;

export type InferenceConnectionHealth = Readonly<{
  state: "unchecked" | "ready" | "degraded" | "offline" | "expired";
  checkedAt?: string;
  latencyMs?: number;
  code?: string;
}>;

export type InferenceConnectionMetadata = Readonly<{
  version: 1;
  id: string;
  generation: number;
  providerId: string;
  label: string;
  authMethodId: string;
  authKind: InferenceAuthMethod["kind"];
  connectedAt: string;
  expiresAt?: string;
  scopes: readonly string[];
  refreshable: boolean;
  health: InferenceConnectionHealth;
  capabilities: Readonly<Record<ConnectionCapability, ConnectionCapabilityEvidence>>;
}>;

export type InferenceConnectionSnapshot = Readonly<{
  version: 1;
  revision: number;
  connections: readonly InferenceConnectionMetadata[];
}>;

export type EphemeralInferenceCredential = Readonly<
  | { kind: "api-key"; value: string }
  | { kind: "oauth-access-token"; value: string }
  | { kind: "local-none" }
>;

export type SessionInferenceRoutePin = Readonly<{
  version: 1;
  pinnedAt: string;
  provider: Readonly<{
    id: string;
    revision: number;
    label: string;
    protocol: InferenceProtocol;
    transportBoundary: InferenceTransportBoundary;
  }>;
  connection: Readonly<{
    id: string;
    generation: number;
    authKind: InferenceAuthMethod["kind"];
  }>;
  model: InferenceModelDescriptor;
}>;

export type PinnedRouteResolution = Readonly<
  | {
      state: "ready";
      connection: InferenceConnectionMetadata;
      pin: SessionInferenceRoutePin;
      currentModelAvailability: ModelAvailability;
      modelMetadataChanged: boolean;
    }
  | {
      state:
        | "connection-missing"
        | "connection-replaced"
        | "connection-unavailable"
        | "provider-changed"
        | "provider-missing"
        | "model-unavailable";
      pin: SessionInferenceRoutePin;
      detail: string;
    }
>;

export type InferenceAvailabilityConnection = Readonly<{
  id: string;
  providerId: string;
  providerLabel: string;
  connectionLabel: string;
  authKind: InferenceAuthMethod["kind"];
  health: InferenceConnectionHealth["state"];
  canInvoke: boolean;
  availableCapabilities: readonly ConnectionCapability[];
  models: readonly Readonly<{
    id: string;
    label: string;
    availability: ModelAvailability["state"];
    supportedCapabilities: readonly ModelCapability[];
    /*
     * Both limits stay optional and are omitted rather than defaulted: a
     * provider directory that publishes no context window must reach the agent
     * as an absent field, never as a guessed number it could route on.
     */
    contextWindowTokens?: number;
    maxOutputTokens?: number;
  }>[];
  omittedModels: number;
}>;

/**
 * A bounded, credential-free view for a system prompt or read-only inspection
 * tool. It intentionally excludes tokens, scopes, endpoints, and refresh data.
 */
export type InferenceAvailabilitySnapshot = Readonly<{
  version: 1;
  capturedAt: string;
  connections: readonly InferenceAvailabilityConnection[];
  omittedConnections: number;
  activeSession?: Readonly<{
    providerId: string;
    connectionId: string;
    modelId: string;
    immutable: true;
    resolution: PinnedRouteResolution["state"];
  }>;
}>;

export type InferenceAvailabilityLimits = Readonly<{
  maxConnections: number;
  maxModelsPerConnection: number;
}>;
