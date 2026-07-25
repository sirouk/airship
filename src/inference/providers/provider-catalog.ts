import {
  CONNECTION_CAPABILITIES,
  type InferenceAuthMethod,
  type InferenceProviderDescriptor,
  type ProviderCatalogEntry,
  type ProviderCatalogSnapshot,
  type PublicPkceAuthMethod,
} from "./contracts";
import {
  boundedText,
  canonicalTimestamp,
  deepFreeze,
  headerName,
  httpsUrl,
  identifier,
  providerBaseUrl,
  redirectUri,
  rejectOAuthSecrets,
  scopes,
} from "./validation";

const CAPABILITY_SET = new Set(CONNECTION_CAPABILITIES);

/**
 * Runtime provider metadata. Revisions are provider-local so an unrelated
 * catalog update never invalidates an already pinned session.
 */
export class InferenceProviderCatalog {
  readonly #providers = new Map<string, ProviderCatalogEntry>();
  #revision = 0;

  constructor(providers: readonly InferenceProviderDescriptor[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(rawProvider: InferenceProviderDescriptor): ProviderCatalogEntry {
    const provider = normalizeProvider(rawProvider);
    const previous = this.#providers.get(provider.id);
    const entry = deepFreeze({
      revision: (previous?.revision ?? 0) + 1,
      provider,
    }) as ProviderCatalogEntry;
    this.#providers.set(provider.id, entry);
    this.#revision += 1;
    return entry;
  }

  get(providerId: string): ProviderCatalogEntry | undefined {
    return this.#providers.get(providerId);
  }

  require(providerId: string): ProviderCatalogEntry {
    const entry = this.get(providerId);
    if (!entry) throw new Error(`Inference provider ${providerId} is not registered.`);
    return entry;
  }

  snapshot(): ProviderCatalogSnapshot {
    return deepFreeze({
      version: 1,
      revision: this.#revision,
      providers: [...this.#providers.values()].sort((left, right) =>
        left.provider.id.localeCompare(right.provider.id)
      ),
    }) as ProviderCatalogSnapshot;
  }
}

export function normalizeProvider(raw: InferenceProviderDescriptor): InferenceProviderDescriptor {
  if (!raw || typeof raw !== "object" || raw.version !== 1) {
    throw new TypeError("Inference provider metadata has an unsupported version.");
  }
  const id = identifier(raw.id, "Provider ID");
  const label = boundedText(raw.label, "Provider label", 128);
  const boundary = raw.transportBoundary;
  if (
    boundary !== "e2ee-attestable"
    && boundary !== "provider-tls"
    && boundary !== "loopback-local"
  ) {
    throw new TypeError("The inference transport boundary is invalid.");
  }
  const protocols = new Set([
    "chutes-e2ee-v1",
    "openai-responses",
    "openai-chat-completions",
    "anthropic-messages",
    "openai-compatible",
  ]);
  if (!protocols.has(raw.protocol)) throw new TypeError("The inference protocol is invalid.");
  const baseUrl = providerBaseUrl(raw.baseUrl, "Provider base URL", boundary);
  const modelsUrl = raw.modelsUrl
    ? providerBaseUrl(raw.modelsUrl, "Provider models URL", boundary)
    : undefined;
  const authMethods = normalizeAuthMethods(raw.authMethods, boundary);
  const oauth = normalizeOAuthAvailability(raw.oauth, authMethods);
  const capabilitySet = new Set<string>();
  for (const capability of raw.capabilities) {
    if (!CAPABILITY_SET.has(capability) || capabilitySet.has(capability)) {
      throw new TypeError("Provider capabilities are invalid.");
    }
    capabilitySet.add(capability);
  }

  return deepFreeze({
    version: 1,
    id,
    label,
    protocol: raw.protocol,
    transportBoundary: boundary,
    baseUrl,
    ...(modelsUrl ? { modelsUrl } : {}),
    oauth,
    authMethods,
    capabilities: [...capabilitySet],
    documentationUrl: httpsUrl(raw.documentationUrl, "Provider documentation URL"),
  }) as InferenceProviderDescriptor;
}

function normalizeAuthMethods(
  methods: readonly InferenceAuthMethod[],
  boundary: InferenceProviderDescriptor["transportBoundary"],
): readonly InferenceAuthMethod[] {
  if (!Array.isArray(methods) || methods.length > 8) {
    throw new TypeError("Provider authentication methods are invalid.");
  }
  const ids = new Set<string>();
  const normalized: InferenceAuthMethod[] = [];
  for (const method of methods) {
    if (!method || typeof method !== "object") {
      throw new TypeError("Provider authentication method is invalid.");
    }
    const id = identifier(method.id, "Authentication method ID");
    if (ids.has(id)) throw new TypeError("Authentication method IDs must be unique.");
    ids.add(id);
    const label = boundedText(method.label, "Authentication method label", 128);
    if (method.kind === "api-key") {
      if (
        method.browserUse !== "reviewed-direct"
        && method.browserUse !== "dangerous-user-opt-in"
        && method.browserUse !== "direct-contract-unpublished"
        && method.browserUse !== "companion-required"
      ) {
        throw new TypeError("The API-key browser policy is invalid.");
      }
      normalized.push(deepFreeze({
        id,
        kind: method.kind,
        label,
        header: {
          name: headerName(method.header.name),
          scheme: method.header.scheme === "bearer" || method.header.scheme === "raw"
            ? method.header.scheme
            : invalidScheme(),
        },
        browserUse: method.browserUse,
        warning: boundedText(method.warning, "API-key warning", 1_024),
      }) as InferenceAuthMethod);
      continue;
    }
    if (method.kind === "oauth-public-pkce") {
      normalized.push(normalizePublicPkce(method, id, label));
      continue;
    }
    if (method.kind === "local-none") {
      if (boundary !== "loopback-local" || method.browserUse !== "loopback-only") {
        throw new TypeError("Unauthenticated inference is restricted to loopback providers.");
      }
      normalized.push(deepFreeze({ id, kind: method.kind, label, browserUse: method.browserUse }));
      continue;
    }
    throw new TypeError("Provider authentication method is invalid.");
  }
  return Object.freeze(normalized);
}

function normalizePublicPkce(
  raw: PublicPkceAuthMethod,
  id: string,
  label: string,
): PublicPkceAuthMethod {
  rejectOAuthSecrets(raw);
  if (
    raw.tokenEndpointAuthMethod !== "none"
    || raw.codeChallengeMethod !== "S256"
    || raw.browserUse !== "reviewed-direct"
  ) {
    throw new TypeError("OAuth must be a public S256 PKCE client with no token-endpoint authentication.");
  }
  if (!Array.isArray(raw.redirectUris) || raw.redirectUris.length === 0 || raw.redirectUris.length > 32) {
    throw new TypeError("OAuth redirect URIs are invalid.");
  }
  const redirectUris = raw.redirectUris.map(redirectUri);
  if (new Set(redirectUris).size !== redirectUris.length) {
    throw new TypeError("OAuth redirect URIs must be unique.");
  }
  return deepFreeze({
    id,
    kind: raw.kind,
    label,
    authorizationEndpoint: httpsUrl(raw.authorizationEndpoint, "OAuth authorization endpoint"),
    tokenEndpoint: httpsUrl(raw.tokenEndpoint, "OAuth token endpoint"),
    clientId: boundedText(raw.clientId, "OAuth client ID", 512),
    redirectUris,
    scopes: scopes(raw.scopes, "OAuth scopes"),
    tokenEndpointAuthMethod: raw.tokenEndpointAuthMethod,
    codeChallengeMethod: raw.codeChallengeMethod,
    browserUse: raw.browserUse,
    review: {
      id: identifier(raw.review.id, "OAuth review ID"),
      reviewedAt: canonicalTimestamp(raw.review.reviewedAt, "OAuth review timestamp"),
      sourceUrl: httpsUrl(raw.review.sourceUrl, "OAuth review source URL"),
    },
  }) as PublicPkceAuthMethod;
}

function normalizeOAuthAvailability(
  raw: InferenceProviderDescriptor["oauth"],
  methods: readonly InferenceAuthMethod[],
): InferenceProviderDescriptor["oauth"] {
  if (!raw || typeof raw !== "object") throw new TypeError("Provider OAuth availability is required.");
  const detail = boundedText(raw.detail, "Provider OAuth detail", 1_024);
  if (raw.state === "configured-public-pkce") {
    const authMethodId = identifier(raw.authMethodId, "OAuth authentication method ID");
    const method = methods.find((candidate) => candidate.id === authMethodId);
    if (method?.kind !== "oauth-public-pkce") {
      throw new TypeError("Configured OAuth must reference reviewed public-PKCE metadata.");
    }
    return deepFreeze({ state: raw.state, authMethodId, detail });
  }
  if (
    raw.state !== "configuration-required"
    && raw.state !== "first-party-only"
    && raw.state !== "not-documented"
  ) {
    throw new TypeError("Provider OAuth availability is invalid.");
  }
  if (methods.some((method) => method.kind === "oauth-public-pkce")) {
    throw new TypeError("Public-PKCE metadata requires configured OAuth availability.");
  }
  return deepFreeze({ state: raw.state, detail });
}

function invalidScheme(): never {
  throw new TypeError("The API-key authorization scheme is invalid.");
}
