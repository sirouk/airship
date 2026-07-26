/**
 * Reviewed OAuth registrations for the non-Chutes providers.
 *
 * These are data only: no network, no crypto, no flow logic. `official-providers.ts`
 * imports this module to build its descriptor metadata, so anything added here lands
 * in the first-paint bundle. Flow code lives in sibling modules that stay behind a
 * dynamic import.
 *
 * Every field records something observed, not something assumed. `transport` in
 * particular is a measured reachability fact (see docs/EXTENSION_BRIDGE.md), which is
 * why the reason string travels with it — an unavailable provider must always be able
 * to name its cause.
 */

export const PROVIDER_OAUTH_IDS = ["openai", "xai", "anthropic"] as const;

export type ProviderOAuthId = (typeof PROVIDER_OAUTH_IDS)[number];

export type ProviderOAuthTransportRequirement = Readonly<
  | {
      kind: "direct-from-page";
      /** What was measured that makes an in-page exchange legal. */
      evidence: string;
    }
  | {
      kind: "extension-bridge";
      /** Why the browser cannot make this exchange from the page. */
      blockedBy: "cors" | "forbidden-user-agent-header";
      evidence: string;
    }
>;

type ProviderOAuthRegistrationBase = Readonly<{
  provider: ProviderOAuthId;
  /**
   * The name the user sees. OpenAI's connection is presented as "Codex" because the
   * approved client is OpenAI's own Codex client, not a generic OpenAI API client.
   */
  displayName: string;
  issuer: string;
  clientId: string;
  /**
   * Ordered token endpoints. The first is the live host; later entries are tried only
   * when an earlier one is unreachable or answers 5xx/404, never when it answers with
   * a real OAuth decision (a 400 has already validated the code).
   *
   * Every entry must be reachable by the transport the registration declares — a direct
   * registration's endpoints through `isDirectFetchDestination`, a bridge registration's
   * through `isBridgeDestination`. No shipped registration lists more than one today;
   * `token-set.test.ts` pins both facts so an unreachable entry cannot be added quietly.
   */
  tokenEndpoints: readonly string[];
  scopes: readonly string[];
  /**
   * Extra headers the token endpoint requires beyond `content-type` and `accept`.
   *
   * Only the bridge can honour these: the one entry that exists is a `user-agent`,
   * which the Fetch Standard forbids page script from setting. A direct transport
   * therefore never sends them, which is consistent — the only registration that
   * needs one is also the only one that cannot be exchanged from the page.
   */
  tokenRequestHeaders: Readonly<Record<string, string>>;
  transport: ProviderOAuthTransportRequirement;
}>;

export type AuthorizationCodePkceRegistration = ProviderOAuthRegistrationBase & Readonly<{
  grant: "authorization-code-pkce";
  authorizationEndpoint: string;
  redirectUri: string;
  /** Extra authorize-URL parameters this provider requires beyond RFC 6749 + PKCE. */
  authorizationParameters: Readonly<Record<string, string>>;
  /**
   * How the code reaches the user. Neither redirect is served by Airship: one lands on
   * a browser connection error with the code in the address bar, the other renders the
   * code on the provider's own page. Both end with the user pasting it back.
   */
  codeDelivery: "connection-error-address-bar" | "displayed-by-provider";
  /** Anthropic returns `code#state` and expects `state` echoed in the token request. */
  echoStateInTokenRequest: boolean;
}>;

export type DeviceCodeRegistration = ProviderOAuthRegistrationBase & Readonly<{
  grant: "device-code";
  deviceAuthorizationEndpoint: string;
}>;

export type ProviderOAuthRegistration =
  | AuthorizationCodePkceRegistration
  | DeviceCodeRegistration;

/**
 * OpenAI, presented as Codex.
 *
 * Measured: a cross-origin POST to the token endpoint answers with
 * `access-control-allow-origin: *`, so the exchange runs in the page. The discovery
 * document advertises `authorization_code` and `refresh_token` only — there is no
 * device flow to fall back to. `http://localhost:1455/auth/callback` is the registered
 * redirect and nothing serves it, so the browser stops on a connection error with the
 * code still in the address bar.
 */
export const OPENAI_CODEX_OAUTH: AuthorizationCodePkceRegistration = Object.freeze({
  provider: "openai",
  grant: "authorization-code-pkce",
  displayName: "Codex",
  issuer: "https://auth.openai.com",
  authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoints: Object.freeze(["https://auth.openai.com/oauth/token"]),
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  scopes: Object.freeze(["openid", "profile", "email", "offline_access"]),
  authorizationParameters: Object.freeze({}),
  codeDelivery: "connection-error-address-bar",
  echoStateInTokenRequest: false,
  tokenRequestHeaders: Object.freeze({}),
  transport: Object.freeze({
    kind: "direct-from-page",
    evidence: "A live cross-origin POST to https://auth.openai.com/oauth/token returned access-control-allow-origin: *.",
  }),
});

/**
 * Anthropic, using the Claude Code client.
 *
 * Measured: the token host rejects browser-shaped requests by `User-Agent`
 * (`Mozilla/5.0` → 429). `User-Agent` is a forbidden header name in the Fetch
 * Standard, so no page script can satisfy it and the exchange has to be relayed.
 * The console callback renders the code as `code#state`.
 */
export const ANTHROPIC_OAUTH: AuthorizationCodePkceRegistration = Object.freeze({
  provider: "anthropic",
  grant: "authorization-code-pkce",
  displayName: "Anthropic",
  issuer: "https://claude.ai",
  authorizationEndpoint: "https://claude.ai/oauth/authorize",
  /*
   * One endpoint, deliberately. `https://console.anthropic.com/v1/oauth/token`
   * was listed here as a fallback, but Anthropic is bridge-only and the bridge
   * destination allowlist (docs/EXTENSION_BRIDGE.md, src/inference/bridge/
   * protocol.ts) does not carry that host — so the fallback could never run in
   * production, and the test that "proved" it only did so against a stub that
   * skipped the allowlist. A listed endpoint that cannot be reached is a claim
   * this build does not honour, so it is removed rather than left as decoration.
   * Adding it back means adding it to the extension's allowlist first.
   */
  tokenEndpoints: Object.freeze(["https://platform.claude.com/v1/oauth/token"]),
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scopes: Object.freeze(["org:create_api_key", "user:profile", "user:inference"]),
  // The console callback only renders the code when the request declares it wants the
  // code shown rather than handed to a local listener.
  authorizationParameters: Object.freeze({ code: "true" }),
  codeDelivery: "displayed-by-provider",
  echoStateInTokenRequest: true,
  // Measured: `Mozilla/5.0` is answered with 429 and `axios/1.7.9` reaches code
  // validation. This is the client string the endpoint was observed to accept; it is
  // carried by the extension because page script cannot set `user-agent` at all.
  tokenRequestHeaders: Object.freeze({ "user-agent": "axios/1.7.9" }),
  transport: Object.freeze({
    kind: "extension-bridge",
    blockedBy: "forbidden-user-agent-header",
    evidence: "https://platform.claude.com/v1/oauth/token answered 429 for a Mozilla/5.0 User-Agent and 400 for axios/1.7.9; User-Agent cannot be set from a page.",
  }),
});

/**
 * xAI, RFC 8628 device code.
 *
 * Measured: the device endpoint answers 200 but sends no
 * `access-control-allow-origin`, so a page issues the request and cannot read the
 * reply. Its discovery advertises the device grant, which is why this is the only
 * provider here that never needs a pasted code.
 */
export const XAI_OAUTH: DeviceCodeRegistration = Object.freeze({
  provider: "xai",
  grant: "device-code",
  displayName: "xAI",
  issuer: "https://auth.x.ai",
  deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/code",
  tokenEndpoints: Object.freeze(["https://auth.x.ai/oauth2/token"]),
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scopes: Object.freeze([
    "openid",
    "profile",
    "email",
    "offline_access",
    "grok-cli:access",
    "api:access",
  ]),
  tokenRequestHeaders: Object.freeze({}),
  transport: Object.freeze({
    kind: "extension-bridge",
    blockedBy: "cors",
    evidence: "https://auth.x.ai/oauth2/device/code returned 200 with no access-control-allow-origin header; an in-page fetch reads an opaque response.",
  }),
});

export const PROVIDER_OAUTH_REGISTRATIONS: readonly ProviderOAuthRegistration[] = Object.freeze([
  OPENAI_CODEX_OAUTH,
  ANTHROPIC_OAUTH,
  XAI_OAUTH,
]);

export function providerOAuthRegistration(
  provider: ProviderOAuthId,
): ProviderOAuthRegistration {
  const registration = PROVIDER_OAUTH_REGISTRATIONS.find(
    (candidate) => candidate.provider === provider,
  );
  if (!registration) throw new TypeError(`No OAuth registration exists for ${provider}.`);
  return registration;
}
