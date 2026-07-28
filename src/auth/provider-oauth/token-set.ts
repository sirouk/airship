import type { ProviderOAuthId, ProviderOAuthRegistration } from "./registrations";
import {
  MAX_OAUTH_RESPONSE_BYTES,
  OAUTH_REQUEST_TIMEOUT_MS,
  ProviderOAuthError,
  requireTransportFor,
  type OAuthHttpResponse,
  type ProviderOAuthTransport,
} from "./transport";

/**
 * Token normalization, expiry honesty, and the one place a token request is made.
 *
 * Nothing here writes to storage. A `ProviderTokenSet` is a page-memory value the
 * caller holds in a variable or a ref; this module never serializes one, never logs
 * one, and never puts one in an error message.
 */

const MAX_TOKEN_BYTES = 8 * 1_024;
/** Thirty days. Above this a provider is misreporting, not being generous. */
const MAX_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const MAX_SCOPES = 64;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/u;
const PROVIDER_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/u;

/** Refresh ahead of expiry so an in-flight request never crosses the boundary. */
export const DEFAULT_REFRESH_SKEW_MS = 120_000;

export type ProviderTokenSet = Readonly<{
  provider: ProviderOAuthId;
  accessToken: string;
  refreshToken?: string;
  tokenType: "Bearer";
  /** Scopes the provider said it granted. An unparseable scope is never claimed. */
  scopes: readonly string[];
  obtainedAt: number;
  /** Absent when the provider declared no lifetime — that is `unknown`, not forever. */
  expiresAt?: number;
  /** Whether an `id_token` came back. The value itself is deliberately discarded. */
  identityTokenPresent: boolean;
}>;

export type ProviderTokenExpiry = Readonly<
  | { state: "valid"; expiresInMs: number }
  | { state: "refresh-due"; expiresInMs: number }
  | { state: "expired"; expiredForMs: number }
  | { state: "unknown" }
>;

/**
 * Report expiry as observed. A provider that returned no `expires_in` yields
 * `unknown`; guessing a lifetime would let the UI claim a validity nobody measured.
 */
export function providerTokenExpiry(
  tokenSet: ProviderTokenSet,
  now: number,
  skewMs: number = DEFAULT_REFRESH_SKEW_MS,
): ProviderTokenExpiry {
  if (tokenSet.expiresAt === undefined) return Object.freeze({ state: "unknown" as const });
  const remaining = tokenSet.expiresAt - now;
  if (remaining <= 0) {
    return Object.freeze({ state: "expired" as const, expiredForMs: -remaining });
  }
  if (remaining <= skewMs) {
    return Object.freeze({ state: "refresh-due" as const, expiresInMs: remaining });
  }
  return Object.freeze({ state: "valid" as const, expiresInMs: remaining });
}

/**
 * True only when expiry is known and inside the skew. An `unknown` expiry answers
 * false: the caller refreshes on a real 401 rather than on a guess.
 */
export function shouldRefreshProviderToken(
  tokenSet: ProviderTokenSet,
  now: number,
  skewMs: number = DEFAULT_REFRESH_SKEW_MS,
): boolean {
  if (!tokenSet.refreshToken) return false;
  const expiry = providerTokenExpiry(tokenSet, now, skewMs);
  return expiry.state === "refresh-due" || expiry.state === "expired";
}

export type ProviderTokenRequestResult = Readonly<{
  status: number;
  payload: Readonly<Record<string, unknown>>;
  endpoint: string;
}>;

/**
 * POST a form to the provider's token endpoint through the injected transport and
 * return the parsed body for any status.
 *
 * The device-code poll has to read `error` out of a 400 without treating it as
 * terminal, so status interpretation belongs to the caller, not here.
 *
 * Registrations may list more than one token host. A later host is tried only when an
 * earlier one could not be reached or answered 404/5xx: a 400 means the request
 * reached code validation, and retrying a one-time code elsewhere would burn it.
 */
export async function postProviderTokenRequest(args: Readonly<{
  registration: ProviderOAuthRegistration;
  form: Readonly<Record<string, string>>;
  transport: ProviderOAuthTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
}>): Promise<ProviderTokenRequestResult> {
  requireTransportFor(args.transport, args.registration);
  const body = new URLSearchParams(args.form).toString();
  const endpoints = args.registration.tokenEndpoints;
  if (endpoints.length === 0) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider: args.registration.provider,
      message: `${args.registration.displayName} has no token endpoint configured.`,
    });
  }
  let lastError: unknown;
  for (const [index, endpoint] of endpoints.entries()) {
    const isLast = index === endpoints.length - 1;
    let response: OAuthHttpResponse;
    try {
      response = await args.transport.request({
        provider: args.registration.provider,
        url: endpoint,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          ...args.registration.tokenRequestHeaders,
        },
        body,
        maxResponseBytes: MAX_OAUTH_RESPONSE_BYTES,
        timeoutMs: args.timeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS,
        ...(args.signal ? { signal: args.signal } : {}),
      });
    } catch (error) {
      lastError = error;
      if (isLast || !isRetriableTransportError(error)) throw error;
      continue;
    }
    if (!isLast && (response.status === 404 || response.status >= 500)) {
      lastError = new ProviderOAuthError({
        code: "provider-error",
        provider: args.registration.provider,
        message: `${args.registration.displayName} token endpoint answered HTTP ${response.status}.`,
        status: response.status,
      });
      continue;
    }
    return Object.freeze({
      status: response.status,
      payload: parseOAuthJson(response, args.registration.provider),
      endpoint,
    });
  }
  /* Unreachable: the final iteration either returns or throws. */
  throw lastError ?? new ProviderOAuthError({
    code: "network",
    provider: args.registration.provider,
    message: `${args.registration.displayName} token endpoint could not be reached.`,
  });
}

/** Exchange a form for a token set, failing closed on any non-2xx answer. */
export async function exchangeProviderTokenForm(args: Readonly<{
  registration: ProviderOAuthRegistration;
  form: Readonly<Record<string, string>>;
  transport: ProviderOAuthTransport;
  now?: number;
  signal?: AbortSignal;
  /** Carried forward when a refresh response omits a rotated refresh token. */
  previousRefreshToken?: string;
}>): Promise<ProviderTokenSet> {
  const result = await postProviderTokenRequest({
    registration: args.registration,
    form: args.form,
    transport: args.transport,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (result.status < 200 || result.status >= 300) {
    throw providerTokenError(args.registration, result);
  }
  return normalizeProviderTokenSet(result.payload, {
    provider: args.registration.provider,
    now: args.now ?? Date.now(),
    ...(args.previousRefreshToken ? { previousRefreshToken: args.previousRefreshToken } : {}),
  });
}

/**
 * Rotate an access token. The refresh token is the caller's page-memory value; a
 * provider that does not return a new one keeps the old one valid (RFC 6749 §6), so
 * it is carried forward rather than dropped, which would strand the connection.
 */
export async function refreshProviderToken(args: Readonly<{
  registration: ProviderOAuthRegistration;
  refreshToken: string;
  transport: ProviderOAuthTransport;
  now?: number;
  signal?: AbortSignal;
}>): Promise<ProviderTokenSet> {
  const refreshToken = requireOpaqueValue(
    args.refreshToken,
    args.registration.provider,
    "refresh token",
  );
  return await exchangeProviderTokenForm({
    registration: args.registration,
    form: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: args.registration.clientId,
    },
    transport: args.transport,
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.signal ? { signal: args.signal } : {}),
    previousRefreshToken: refreshToken,
  });
}

export function normalizeProviderTokenSet(
  payload: Readonly<Record<string, unknown>>,
  context: Readonly<{ provider: ProviderOAuthId; now: number; previousRefreshToken?: string }>,
): ProviderTokenSet {
  const accessToken = requireOpaqueValue(payload.access_token, context.provider, "access token");
  const tokenType = payload.token_type;
  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
    throw new ProviderOAuthError({
      code: "invalid-response",
      provider: context.provider,
      message: "The OAuth token response used an unsupported token type.",
    });
  }
  const expiresIn = payload.expires_in;
  let expiresAt: number | undefined;
  if (expiresIn !== undefined && expiresIn !== null) {
    if (
      !Number.isSafeInteger(expiresIn)
      || (expiresIn as number) < 1
      || (expiresIn as number) > MAX_TOKEN_LIFETIME_SECONDS
    ) {
      throw new ProviderOAuthError({
        code: "invalid-response",
        provider: context.provider,
        message: "The OAuth token response declared an invalid lifetime.",
      });
    }
    expiresAt = context.now + (expiresIn as number) * 1_000;
  }
  const refreshToken = payload.refresh_token === undefined || payload.refresh_token === null
    ? context.previousRefreshToken
    : requireOpaqueValue(payload.refresh_token, context.provider, "refresh token");
  return Object.freeze({
    provider: context.provider,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    tokenType: "Bearer" as const,
    scopes: normalizeScopes(payload.scope),
    obtainedAt: context.now,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    identityTokenPresent: typeof payload.id_token === "string" && payload.id_token.length > 0,
  });
}

/**
 * Turn a non-2xx token response into a named failure.
 *
 * Only the machine-readable `error` code is carried. `error_description` is provider
 * free text that has been observed to echo request parameters, so it never reaches a
 * message that could be logged or rendered.
 */
export function providerTokenError(
  registration: ProviderOAuthRegistration,
  result: ProviderTokenRequestResult,
): ProviderOAuthError {
  const providerCode = readProviderErrorCode(result.payload);
  return new ProviderOAuthError({
    code: "provider-error",
    provider: registration.provider,
    message: `${registration.displayName} rejected the OAuth request with HTTP ${result.status}${providerCode ? ` (${providerCode})` : ""}.`,
    status: result.status,
    ...(providerCode ? { providerCode } : {}),
  });
}

export function readProviderErrorCode(
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = payload.error;
  if (typeof value === "string" && PROVIDER_ERROR_CODE_PATTERN.test(value)) return value;
  return undefined;
}

export function parseOAuthJson(
  response: OAuthHttpResponse,
  provider: ProviderOAuthId,
): Readonly<Record<string, unknown>> {
  if (response.body.length > MAX_OAUTH_RESPONSE_BYTES) {
    throw new ProviderOAuthError({
      code: "response-too-large",
      provider,
      message: "The OAuth response exceeded the browser safety limit.",
      status: response.status,
    });
  }
  try {
    const parsed: unknown = JSON.parse(response.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return Object.freeze(parsed as Record<string, unknown>);
  } catch {
    throw new ProviderOAuthError({
      code: "invalid-response",
      provider,
      message: `The OAuth response was not a JSON object (HTTP ${response.status}).`,
      status: response.status,
    });
  }
}

/**
 * A scope Airship cannot validate is dropped rather than recorded. Understating a
 * grant costs a capability; overstating one would put a claim in the capability
 * record that nothing observed.
 */
function normalizeScopes(value: unknown): readonly string[] {
  if (typeof value !== "string") return Object.freeze([]);
  const unique = new Set<string>();
  for (const candidate of value.split(/\s+/u)) {
    if (unique.size >= MAX_SCOPES) break;
    if (SCOPE_PATTERN.test(candidate)) unique.add(candidate);
  }
  return Object.freeze([...unique]);
}

function requireOpaqueValue(
  value: unknown,
  provider: ProviderOAuthId,
  label: string,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TOKEN_BYTES
    // Whitespace and control characters cannot occur in an opaque OAuth value and are
    // exactly the shapes that would smuggle a line break into anything downstream.
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new ProviderOAuthError({
      code: "invalid-response",
      provider,
      message: `The OAuth ${label} was missing or malformed.`,
    });
  }
  return value;
}

function isRetriableTransportError(error: unknown): boolean {
  return error instanceof ProviderOAuthError
    && (error.code === "network" || error.code === "timeout");
}
