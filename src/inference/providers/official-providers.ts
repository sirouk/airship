import { OPENAI_CODEX_OAUTH } from "../../auth/provider-oauth/registrations";
import type {
  InferenceProviderDescriptor,
  PublicPkceAuthMethod,
} from "./contracts";
import { deepFreeze } from "./validation";

export type BuiltinLocalProviderId = "ollama" | "lm-studio";

/**
 * Provider declarations intentionally contain no model list. Models are
 * connection-scoped runtime data acquired from each provider's own directory.
 */
export const OPENAI_PROVIDER = provider({
  version: 1,
  id: "openai",
  label: "OpenAI",
  protocol: "openai-responses",
  transportBoundary: "provider-tls",
  baseUrl: "https://api.openai.com/v1/",
  modelsUrl: "https://api.openai.com/v1/models",
  oauth: {
    state: "configured-public-pkce",
    authMethodId: "openai-codex-oauth",
    detail: "Airship ships OpenAI's own Codex client with product-owner approval. It is a secretless S256 PKCE client and its token endpoint was measured returning access-control-allow-origin: *, so the exchange completes in the page with no Airship backend.",
  },
  authMethods: [
    codexOAuthMethod(),
    {
      id: "openai-api-key",
      kind: "api-key",
      label: "OpenAI API key",
      header: { name: "Authorization", scheme: "bearer" },
      browserUse: "dangerous-user-opt-in",
      warning: "OpenAI says standard API keys must not be exposed in browser or app client code. A user-supplied page-memory key is therefore an explicit compatibility risk, not the preferred production path.",
    },
  ],
  capabilities: ["invoke", "models:list"],
  documentationUrl: "https://developers.openai.com/api/reference/overview/",
});

/**
 * Reviewed metadata for the connection users see as "Codex".
 *
 * The endpoints, client, redirect, and scopes are read from the single OAuth
 * registration rather than restated, so the descriptor the UI renders and the request
 * the flow actually sends cannot drift apart.
 */
function codexOAuthMethod(): PublicPkceAuthMethod {
  return {
    id: "openai-codex-oauth",
    kind: "oauth-public-pkce",
    label: "Codex",
    authorizationEndpoint: OPENAI_CODEX_OAUTH.authorizationEndpoint,
    tokenEndpoint: OPENAI_CODEX_OAUTH.tokenEndpoints[0] ?? "",
    clientId: OPENAI_CODEX_OAUTH.clientId,
    redirectUris: OPENAI_CODEX_OAUTH.redirectUri ? [OPENAI_CODEX_OAUTH.redirectUri] : [],
    scopes: OPENAI_CODEX_OAUTH.scopes,
    tokenEndpointAuthMethod: "none",
    codeChallengeMethod: "S256",
    browserUse: "reviewed-direct",
    review: {
      id: "openai-codex-live-cors-2026-07",
      reviewedAt: "2026-07-25T00:00:00.000Z",
      sourceUrl: "https://auth.openai.com/.well-known/oauth-authorization-server",
    },
  };
}

export const ANTHROPIC_PROVIDER = provider({
  version: 1,
  id: "anthropic",
  label: "Anthropic",
  protocol: "anthropic-messages",
  transportBoundary: "provider-tls",
  baseUrl: "https://api.anthropic.com/v1/",
  modelsUrl: "https://api.anthropic.com/v1/models",
  oauth: {
    // Still first-party-only: the grant exists, but no page can run it. The token host
    // answers 429 to a browser User-Agent and User-Agent is a forbidden header name,
    // so this stays unconfigured here and is carried by the extension bridge instead.
    state: "first-party-only",
    detail: "Anthropic documents account OAuth inside Claude Code, not a reviewed third-party public-PKCE inference registration for Airship. Its token host rejects browser-shaped requests by User-Agent, so Airship can only complete that grant through the optional browser extension; without the extension this provider stays on API keys.",
  },
  authMethods: [{
    id: "anthropic-api-key",
    kind: "api-key",
    label: "Anthropic API key",
    header: { name: "x-api-key", scheme: "raw" },
    browserUse: "dangerous-user-opt-in",
    warning: "Anthropic's TypeScript SDK disables browsers by default to avoid exposing API credentials and requires an explicit dangerouslyAllowBrowser opt-in.",
  }],
  capabilities: ["invoke", "models:list"],
  documentationUrl: "https://platform.claude.com/docs/en/api/",
});

export const XAI_PROVIDER = provider({
  version: 1,
  id: "xai",
  label: "xAI",
  protocol: "openai-responses",
  transportBoundary: "provider-tls",
  baseUrl: "https://api.x.ai/v1/",
  modelsUrl: "https://api.x.ai/v1/language-models",
  oauth: {
    // xAI advertises the RFC 8628 device grant, which is not the public-PKCE shape
    // this field describes, and its device endpoint sends no CORS header at all. Both
    // reasons keep it unconfigured for the page.
    state: "not-documented",
    detail: "xAI's inference documentation specifies bearer API keys and does not publish a third-party public-PKCE inference login contract. Its discovery does advertise the RFC 8628 device grant, but the device endpoint returns no access-control-allow-origin header, so a page cannot read the reply and Airship can only run that grant through the optional browser extension.",
  },
  authMethods: [{
    id: "xai-api-key",
    kind: "api-key",
    label: "xAI API key",
    header: { name: "Authorization", scheme: "bearer" },
    browserUse: "direct-contract-unpublished",
    warning: "xAI documents API keys as secrets and browser-safe ephemeral tokens only for Realtime after a server mints them. Airship can probe direct general inference, but must not call it provider-supported until the live browser/CORS path succeeds.",
  }],
  capabilities: ["invoke", "models:list"],
  documentationUrl: "https://docs.x.ai/developers/rest-api-reference/inference",
});

export const OFFICIAL_CLOUD_PROVIDERS = deepFreeze([
  OPENAI_PROVIDER,
  ANTHROPIC_PROVIDER,
  XAI_PROVIDER,
]) as readonly InferenceProviderDescriptor[];

/**
 * Browser-local services are connection authorities, not Airship backends.
 * Their exact endpoint remains page-memory connection state; this descriptor
 * only declares the reviewed loopback protocol and authentication contract.
 */
export const OFFICIAL_LOCAL_PROVIDERS = deepFreeze([
  localProvider({
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/",
    modelsUrl: "http://127.0.0.1:11434/api/tags",
    documentationUrl: "https://ollama.com/",
  }),
  localProvider({
    id: "lm-studio",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/",
    modelsUrl: "http://127.0.0.1:1234/api/v1/models",
    documentationUrl: "https://lmstudio.ai/docs/",
  }),
]) as readonly InferenceProviderDescriptor[];

export type BuiltinProviderCompatibility = Readonly<{
  providerId: "chutes" | "openai" | "anthropic" | "xai";
  oauth:
    | "published-third-party-pkce"
    /** A vendor's own product client that Airship ships with owner approval. */
    | "first-party-client-shipped"
    | "first-party-product-only"
    | "not-documented";
  apiKey: "available";
  browserKeyPolicy:
    | "reviewed-e2ee"
    | "dangerous-user-opt-in"
    | "direct-contract-unpublished";
  recommendedCustody:
    | "page-memory-e2ee"
    | "page-memory-oauth"
    | "user-side-companion";
}>;

export const BUILTIN_PROVIDER_COMPATIBILITY = deepFreeze([
  {
    providerId: "chutes",
    oauth: "published-third-party-pkce",
    apiKey: "available",
    browserKeyPolicy: "reviewed-e2ee",
    recommendedCustody: "page-memory-e2ee",
  },
  {
    providerId: "openai",
    oauth: "first-party-client-shipped",
    apiKey: "available",
    browserKeyPolicy: "dangerous-user-opt-in",
    // OAuth removes the need for a user-held key here: the token never leaves page
    // memory and is not written to the Vault, IndexedDB, or the workspace.
    recommendedCustody: "page-memory-oauth",
  },
  {
    providerId: "anthropic",
    oauth: "first-party-product-only",
    apiKey: "available",
    browserKeyPolicy: "dangerous-user-opt-in",
    recommendedCustody: "user-side-companion",
  },
  {
    providerId: "xai",
    oauth: "not-documented",
    apiKey: "available",
    browserKeyPolicy: "direct-contract-unpublished",
    recommendedCustody: "user-side-companion",
  },
]) as readonly BuiltinProviderCompatibility[];

/**
 * What Airship can actually run today for each provider's OAuth, as measured.
 *
 * `tokenExchange` is a reachability fact about the browser's network stack, not a
 * preference: `extension-bridge` means the exchange is impossible from a page and the
 * provider is honestly unavailable until a bridge answers `hello` on this page load.
 * `blockedBy` names the cause so no surface has to invent one.
 */
export type BuiltinProviderOAuthReachability = Readonly<{
  providerId: "openai" | "anthropic" | "xai";
  grant: "authorization-code-pkce" | "device-code";
  codeDelivery: "pasted-back" | "device-approval";
  tokenExchange: "direct-from-page" | "extension-bridge";
  blockedBy?: "cors" | "forbidden-user-agent-header";
  evidence: string;
}>;

export const BUILTIN_PROVIDER_OAUTH_REACHABILITY = deepFreeze([
  {
    providerId: "openai",
    grant: "authorization-code-pkce",
    codeDelivery: "pasted-back",
    tokenExchange: "direct-from-page",
    evidence: "A live cross-origin POST to https://auth.openai.com/oauth/token returned access-control-allow-origin: *; discovery advertises authorization_code and refresh_token only.",
  },
  {
    providerId: "anthropic",
    grant: "authorization-code-pkce",
    codeDelivery: "pasted-back",
    tokenExchange: "extension-bridge",
    blockedBy: "forbidden-user-agent-header",
    evidence: "https://platform.claude.com/v1/oauth/token answered 429 for a Mozilla/5.0 User-Agent and 400 for axios/1.7.9; User-Agent is a forbidden header name in the page.",
  },
  {
    providerId: "xai",
    grant: "device-code",
    codeDelivery: "device-approval",
    tokenExchange: "extension-bridge",
    blockedBy: "cors",
    evidence: "https://auth.x.ai/oauth2/device/code returned 200 with no access-control-allow-origin header; an in-page fetch reads only an opaque response.",
  },
]) as readonly BuiltinProviderOAuthReachability[];

export function createChutesProviderDescriptor(
  oauthMethod?: PublicPkceAuthMethod,
): InferenceProviderDescriptor {
  return provider({
    version: 1,
    id: "chutes",
    label: "Chutes",
    protocol: "chutes-e2ee-v1",
    transportBoundary: "e2ee-attestable",
    baseUrl: "https://llm.chutes.ai/v1/",
    modelsUrl: "https://llm.chutes.ai/v1/models",
    oauth: oauthMethod
      ? {
          state: "configured-public-pkce",
          authMethodId: oauthMethod.id,
          detail: "This deployment supplied reviewed Browser/native S256 PKCE metadata with token endpoint authentication set to none.",
        }
      : {
          state: "configuration-required",
          detail: "Chutes OAuth remains disabled in this registry until the deployment supplies reviewed public-client PKCE metadata. Existing Airship development bridge behavior is separate and unchanged.",
        },
    authMethods: [
      ...(oauthMethod ? [oauthMethod] : []),
      {
        id: "chutes-api-key",
        kind: "api-key",
        label: "Chutes inference API key",
        header: { name: "Authorization", scheme: "bearer" },
        browserUse: "reviewed-direct",
        warning: "The credential remains only in page memory and is used by Airship's Chutes E2EE transport.",
      },
    ],
    capabilities: ["invoke", "models:list", "identity:read", "billing:read", "usage:read"],
    documentationUrl: "https://chutes.ai/",
  });
}

function provider(value: InferenceProviderDescriptor): InferenceProviderDescriptor {
  return deepFreeze(value) as InferenceProviderDescriptor;
}

function localProvider(input: Readonly<{
  id: BuiltinLocalProviderId;
  label: string;
  baseUrl: string;
  modelsUrl: string;
  documentationUrl: string;
}>): InferenceProviderDescriptor {
  return provider({
    version: 1,
    id: input.id,
    label: input.label,
    protocol: "openai-compatible",
    transportBoundary: "loopback-local",
    baseUrl: input.baseUrl,
    modelsUrl: input.modelsUrl,
    oauth: {
      state: "not-documented",
      detail: "A browser-local model service uses no remote account or Airship backend.",
    },
    authMethods: [{
      id: `${input.id}-loopback`,
      kind: "local-none",
      label: "This machine",
      browserUse: "loopback-only",
    }],
    capabilities: ["invoke", "models:list"],
    documentationUrl: input.documentationUrl,
  });
}
