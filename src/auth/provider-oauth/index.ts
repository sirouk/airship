/**
 * Provider-agnostic OAuth core.
 *
 * Three grant shapes (authorization code with a pasted-back code, RFC 8628 device
 * code, and refresh) over one injectable transport, so a provider that has to be
 * relayed by the extension bridge runs the same flow code as one that does not.
 *
 * Import this barrel from a dynamically loaded module only: nothing here is needed at
 * first paint. `registrations.ts` is the exception — it is plain data and is imported
 * directly by the provider registry.
 */
export {
  consumeProviderAuthorizationCode,
  createProviderAuthorizationRequest,
  exchangeProviderAuthorizationCode,
  parsePastedAuthorizationCode,
  MAX_AUTHORIZATION_ATTEMPT_AGE_MS,
  type PastedAuthorizationCode,
  type ProviderAuthorizationCode,
  type ProviderPkceAttempt,
} from "./authorization-code";
export {
  pollDeviceAccessToken,
  requestDeviceAuthorization,
  type DeviceAuthorization,
  type DeviceCodePollProgress,
  type DeviceSleep,
} from "./device-code";
export {
  constantTimeEqual,
  createOAuthState,
  createPkceChallenge,
  type CryptoSource,
  type PkceChallenge,
} from "./pkce";
export {
  ANTHROPIC_OAUTH,
  OPENAI_CODEX_OAUTH,
  PROVIDER_OAUTH_IDS,
  PROVIDER_OAUTH_REGISTRATIONS,
  providerOAuthRegistration,
  XAI_OAUTH,
  type AuthorizationCodePkceRegistration,
  type DeviceCodeRegistration,
  type ProviderOAuthId,
  type ProviderOAuthRegistration,
  type ProviderOAuthTransportRequirement,
} from "./registrations";
export {
  DEFAULT_REFRESH_SKEW_MS,
  normalizeProviderTokenSet,
  providerTokenExpiry,
  refreshProviderToken,
  shouldRefreshProviderToken,
  type ProviderTokenExpiry,
  type ProviderTokenSet,
} from "./token-set";
export {
  createDirectFetchTransport,
  isDirectFetchDestination,
  isProviderOAuthError,
  MAX_OAUTH_RESPONSE_BYTES,
  OAUTH_REQUEST_TIMEOUT_MS,
  ProviderOAuthError,
  requireTransportFor,
  type OAuthHttpRequest,
  type OAuthHttpResponse,
  type ProviderOAuthErrorCode,
  type ProviderOAuthTransport,
  type ProviderOAuthTransportId,
} from "./transport";
