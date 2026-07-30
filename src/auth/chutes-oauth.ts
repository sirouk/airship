import {
  CHUTES_LOCAL_REGISTRATION,
  chutesOAuthExchangeMode,
  type ChutesOAuthRegistration,
} from "./chutes-oauth-registration";

export {
  CHUTES_ACTIVE_REGISTRATION,
  CHUTES_LOCAL_REGISTRATION,
  chutesOAuthExchangeMode,
  chutesOAuthLocationState,
  resolveChutesOAuthRegistration,
  type ChutesOAuthExchangeMode,
  type ChutesOAuthRegistration,
} from "./chutes-oauth-registration";

const CHUTES_AUTHORIZE_ENDPOINT = "https://api.chutes.ai/idp/authorize";
const CHUTES_PUBLIC_TOKEN_ENDPOINT = "https://api.chutes.ai/idp/token";
const CHUTES_PUBLIC_REVOCATION_ENDPOINT = "https://api.chutes.ai/idp/token/revoke";
const CHUTES_LOCAL_TOKEN_ENDPOINT = "/__airship/chutes/oauth/token";
const CHUTES_LOCAL_REVOCATION_ENDPOINT = "/__airship/chutes/oauth/revoke";
const MAX_TOKEN_RESPONSE_BYTES = 32 * 1024;
const MAX_OAUTH_TOKEN_BYTES = 4 * 1024;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;
/*
 * Sign-out must not wait on the network. Revocation is fired detached from
 * teardown and given a short deadline of its own.
 */
const REVOCATION_TIMEOUT_MS = 5_000;
export type ChutesPkceAttempt = {
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
};

/** Parse only the exact tab-local PKCE attempt shape Airship writes. */
export function parseChutesPkceAttempt(value: string): ChutesPkceAttempt {
  if (value.length > 8_192) throw new Error("The saved Chutes authorization attempt exceeded its safety limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The saved Chutes authorization attempt is invalid.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("The saved Chutes authorization attempt is invalid.");
  const candidate = parsed as Record<string, unknown>;
  if (
    Object.keys(candidate).some((key) => !["state", "verifier", "redirectUri", "createdAt"].includes(key)) ||
    typeof candidate.state !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(candidate.state) ||
    typeof candidate.verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/u.test(candidate.verifier) ||
    typeof candidate.redirectUri !== "string" ||
    candidate.redirectUri.length > 2_048 ||
    !Number.isSafeInteger(candidate.createdAt) ||
    (candidate.createdAt as number) < 0
  ) {
    throw new Error("The saved Chutes authorization attempt is incomplete.");
  }
  return {
    state: candidate.state,
    verifier: candidate.verifier,
    redirectUri: candidate.redirectUri,
    createdAt: candidate.createdAt as number,
  };
}

export function describeChutesOAuthExchangeError(
  error: unknown,
  exchangeMode: "local-confidential-bridge" | "public-pkce",
): string {
  const message = error instanceof Error ? error.message : "Chutes sign-in could not be completed.";
  if (message.includes("invalid_client")) {
    return exchangeMode === "local-confidential-bridge" ? "oauth:invalid-local" : "oauth:invalid-public";
  }
  if (message.includes("HTTP 502")) {
    return "Chutes identity gateway returned 502. Retry sign-in in a fresh browser window.";
  }
  return message.length <= 320 ? message : "Chutes sign-in failed without changing the active connection.";
}

export type ChutesAuthorizationCallback = {
  code: string;
  verifier: string;
  redirectUri: string;
};

/**
 * The token endpoint's authoritative refusal of a grant (RFC 6749 §5.2 carried
 * on HTTP 400/401: `invalid_grant`, `invalid_client`).
 *
 * Split off from every other token-request failure because the two demand
 * opposite teardown: a refused refresh token is already dead at the provider,
 * so keeping the connection is keeping nothing, while a refused fetch, a
 * timeout or a 5xx says nothing about the grant and retrying can succeed. The
 * message stays identical to the plain `Error` these cases threw before, so
 * message-level consumers (`describeChutesOAuthExchangeError`, surface copy)
 * read exactly what they read before.
 */
export class ChutesOAuthProviderRejectionError extends Error {
  readonly providerRejected = true as const;
}

/**
 * Duck-typed on purpose: an error re-thrown across two copies of this module
 * (host page and deferred chunk) still classifies, where `instanceof` would not.
 */
export function isChutesOAuthProviderRejection(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { providerRejected?: unknown }).providerRejected === true;
}

export type ChutesOAuthTokenSet = Readonly<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: readonly string[];
}>;

type ChutesTokenResponse = Readonly<{
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
}>;

export async function createChutesAuthorizationRequest(args: {
  clientId: string;
  redirectUri?: string;
  registration?: ChutesOAuthRegistration;
  now?: number;
  crypto?: Pick<Crypto, "getRandomValues" | "subtle">;
}): Promise<{ url: URL; attempt: ChutesPkceAttempt }> {
  const registration = args.registration ?? CHUTES_LOCAL_REGISTRATION;
  if (!registration.configured) throw new Error(registration.configurationError ?? "Chutes OAuth is not configured.");
  const clientId = validateRegistrationClientId(args.clientId, registration);
  chutesOAuthExchangeMode(registration);
  const redirectUri = validateRedirectUri(
    args.redirectUri ?? registration.redirectUris[0] ?? "",
    registration.redirectUris,
  );
  const cryptoSource = args.crypto ?? globalThis.crypto;
  if (!cryptoSource?.getRandomValues || !cryptoSource.subtle) {
    throw new Error("Web Crypto is required to start Sign in with Chutes.");
  }

  const verifier = randomBase64Url(48, cryptoSource);
  const state = randomBase64Url(32, cryptoSource);
  const challengeBytes = await cryptoSource.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = bytesToBase64Url(new Uint8Array(challengeBytes));
  const url = new URL(CHUTES_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", registration.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return {
    url,
    attempt: { state, verifier, redirectUri, createdAt: args.now ?? Date.now() },
  };
}

export function consumeChutesAuthorizationCallback(args: {
  search: string | URLSearchParams;
  attempt: ChutesPkceAttempt;
  now?: number;
  maxAgeMs?: number;
}): ChutesAuthorizationCallback {
  const parameters = typeof args.search === "string" ? new URLSearchParams(args.search) : args.search;
  const oauthError = parameters.get("error");
  if (oauthError) {
    const safeCode = /^[a-z_]{3,40}$/u.test(oauthError) ? oauthError : "provider_error";
    throw new Error(`Chutes authorization failed (${safeCode}).`);
  }
  const now = args.now ?? Date.now();
  const maxAgeMs = args.maxAgeMs ?? 10 * 60 * 1_000;
  if (now < args.attempt.createdAt || now - args.attempt.createdAt > maxAgeMs) {
    throw new Error("The Chutes authorization attempt expired. Start sign-in again.");
  }
  const returnedState = parameters.get("state");
  if (!returnedState || !constantTimeEqual(returnedState, args.attempt.state)) {
    throw new Error("The Chutes authorization state did not match.");
  }
  const code = parameters.get("code")?.trim();
  if (!code) throw new Error("Chutes returned no authorization code.");
  return { code, verifier: args.attempt.verifier, redirectUri: args.attempt.redirectUri };
}

/**
 * Exchange a one-time authorization code with PKCE. Browser/native
 * registrations call Chutes directly. The checked-in confidential localhost
 * registration calls its same-origin process handler; every other confidential
 * registration fails closed. Returned tokens remain page-memory values.
 */
export async function exchangeChutesAuthorizationCode(args: {
  callback: ChutesAuthorizationCallback;
  clientId: string;
  signal?: AbortSignal;
  now?: number;
  fetch?: typeof globalThis.fetch;
  registration?: ChutesOAuthRegistration;
}): Promise<ChutesOAuthTokenSet> {
  const registration = args.registration ?? CHUTES_LOCAL_REGISTRATION;
  if (!registration.configured) throw new Error(registration.configurationError ?? "Chutes OAuth is not configured.");
  const clientId = validateRegistrationClientId(args.clientId, registration);
  const code = validateOpaqueValue(args.callback.code, "authorization code", 4 * 1024);
  const verifier = validatePkceVerifier(args.callback.verifier);
  const redirectUri = validateRedirectUri(args.callback.redirectUri, registration.redirectUris);
  const tokenSet = await requestTokenSet({
    form: {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    },
    signal: args.signal,
    now: args.now,
    fetch: args.fetch,
    registration,
  });
  requireGrantedScopes(tokenSet.scopes, registration.registrationScopes);
  return tokenSet;
}

/** Rotate a memory-only refresh token through the registration's token boundary. */
export async function refreshChutesOAuthToken(args: {
  refreshToken: string;
  clientId: string;
  signal?: AbortSignal;
  now?: number;
  fetch?: typeof globalThis.fetch;
  registration?: ChutesOAuthRegistration;
}): Promise<ChutesOAuthTokenSet> {
  const registration = args.registration ?? CHUTES_LOCAL_REGISTRATION;
  if (!registration.configured) throw new Error(registration.configurationError ?? "Chutes OAuth is not configured.");
  const clientId = validateRegistrationClientId(args.clientId, registration);
  const refreshToken = validateToken(args.refreshToken, "crt_", "refresh token");
  const refreshed = await requestTokenSet({
    form: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    },
    signal: args.signal,
    now: args.now,
    fetch: args.fetch,
    registration,
  });
  if (!refreshed.refreshToken || refreshed.refreshToken === refreshToken) {
    throw new Error("Chutes OAuth refresh did not rotate the one-time refresh token.");
  }
  requireGrantedScopes(refreshed.scopes, registration.registrationScopes);
  return refreshed;
}

/**
 * Outcome of an RFC 7009 revocation attempt.
 *
 * `accepted` means the provider accepted the request, NOT that a session is
 * proven destroyed: the Chutes IdP answers 200 for tokens it never issued, so
 * nothing downstream may promote this to "the provider session is gone".
 */
export type ChutesTokenRevocationResult = Readonly<
  | { state: "accepted"; status: number }
  | { state: "rejected"; status: number }
  | { state: "unreachable"; reason: "network" | "timeout" | "cancelled" }
>;

/**
 * Ask the Chutes IdP to invalidate one memory-only token.
 *
 * Clearing page memory ends Airship's use of a credential but leaves a leaked
 * refresh token valid at the provider for the rest of its lifetime, so sign-out
 * asks the published revocation endpoint to drop it too. A malformed value is
 * never transmitted; transport failures are reported, not thrown, because the
 * caller is a best-effort detached teardown step.
 */
export async function revokeChutesToken(args: {
  token: string;
  tokenTypeHint: "refresh_token" | "access_token";
  clientId: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  registration?: ChutesOAuthRegistration;
}): Promise<ChutesTokenRevocationResult> {
  const registration = args.registration ?? CHUTES_LOCAL_REGISTRATION;
  if (!registration.configured) throw new Error(registration.configurationError ?? "Chutes OAuth is not configured.");
  const clientId = validateRegistrationClientId(args.clientId, registration);
  const token = validateToken(
    args.token,
    args.tokenTypeHint === "refresh_token" ? "crt_" : "cak_",
    args.tokenTypeHint === "refresh_token" ? "refresh token" : "access token",
  );
  const fetchImpl = args.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("Fetch is required to revoke a Chutes token.");
  const lifetime = createTokenRequestLifetime(args.signal, REVOCATION_TIMEOUT_MS);
  const endpoint = chutesOAuthExchangeMode(registration) === "local-confidential-bridge"
    ? CHUTES_LOCAL_REVOCATION_ENDPOINT
    : CHUTES_PUBLIC_REVOCATION_ENDPOINT;
  try {
    const response = await abortable(fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        token_type_hint: args.tokenTypeHint,
        client_id: clientId,
      }).toString(),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: lifetime.signal,
    }), lifetime.signal);
    // The body carries no authority for this decision and may be unbounded.
    void response.body?.cancel().catch(() => undefined);
    return Object.freeze(
      response.ok
        ? { state: "accepted" as const, status: response.status }
        : { state: "rejected" as const, status: response.status },
    );
  } catch {
    return Object.freeze({
      state: "unreachable" as const,
      reason: lifetime.didTimeout()
        ? "timeout" as const
        : args.signal?.aborted
          ? "cancelled" as const
          : "network" as const,
    });
  } finally {
    lifetime.dispose();
  }
}

async function requestTokenSet(args: {
  form: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  now?: number;
  fetch?: typeof globalThis.fetch;
  registration: ChutesOAuthRegistration;
}): Promise<ChutesOAuthTokenSet> {
  const fetchImpl = args.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("Fetch is required to complete Sign in with Chutes.");
  const lifetime = createTokenRequestLifetime(args.signal);
  const endpoint = chutesOAuthExchangeMode(args.registration) === "local-confidential-bridge"
    ? CHUTES_LOCAL_TOKEN_ENDPOINT
    : CHUTES_PUBLIC_TOKEN_ENDPOINT;
  try {
    const response = await abortable(fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(args.form).toString(),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: lifetime.signal,
    }), lifetime.signal);
    if (!response.ok && !response.headers.get("content-type")?.includes("json")) {
      throw new Error(`Chutes OAuth token request failed with HTTP ${response.status}.`);
    }
    const payload = await readBoundedJson(response, MAX_TOKEN_RESPONSE_BYTES, lifetime.signal);
    if (!response.ok) {
      const providerCode = typeof payload.error === "string" && /^[a-z_]{3,40}$/u.test(payload.error)
        ? ` (${payload.error})`
        : "";
      const message = `Chutes OAuth token request failed with HTTP ${response.status}${providerCode}.`;
      // 400/401 is the endpoint judging the grant itself; anything higher is
      // infrastructure between this page and that judgement and says nothing
      // about whether the token still works.
      if (response.status === 400 || response.status === 401) {
        throw new ChutesOAuthProviderRejectionError(message);
      }
      throw new Error(message);
    }
    return normalizeTokenSet(payload, args.now ?? Date.now());
  } catch (error) {
    if (lifetime.didTimeout()) {
      throw new Error("Chutes OAuth token request timed out.");
    }
    throw error;
  } finally {
    lifetime.dispose();
  }
}

function validateRegistrationClientId(
  value: string,
  registration: ChutesOAuthRegistration,
): string {
  const clientId = validateClientId(value);
  if (clientId !== registration.clientId) {
    throw new Error("The Chutes OAuth client ID does not match the active registration.");
  }
  return clientId;
}

function createTokenRequestLifetime(
  parent?: AbortSignal,
  timeoutMs: number = TOKEN_REQUEST_TIMEOUT_MS,
): Readonly<{
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
}> {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener("abort", forwardAbort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Chutes OAuth token request timed out.", "TimeoutError"));
  }, timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      globalThis.clearTimeout(timer);
      parent?.removeEventListener("abort", forwardAbort);
    },
  });
}

async function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      throw new Error("Chutes OAuth token response declared an invalid length.");
    }
    const contentLength = Number(declaredLength);
    if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
      throw new Error("Chutes OAuth token response exceeded the browser safety limit.");
    }
  }
  if (!response.body) throw new Error("Chutes OAuth token response was empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error("Chutes OAuth token response exceeded the browser safety limit.");
      }
      chunks.push(value);
    }
  } finally {
    if (signal.aborted) void reader.cancel(signal.reason).catch(() => undefined);
    try { reader.releaseLock(); } catch { /* cancellation may retain a pending read */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Chutes OAuth token response was not valid JSON.");
  }
}

function normalizeTokenSet(payload: ChutesTokenResponse, now: number): ChutesOAuthTokenSet {
  const accessToken = validateToken(payload.access_token, "cak_", "access token");
  if (typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer") {
    throw new Error("Chutes OAuth token response used an unsupported token type.");
  }
  if (!Number.isSafeInteger(payload.expires_in) || (payload.expires_in as number) < 1 || (payload.expires_in as number) > 86_400) {
    throw new Error("Chutes OAuth token response contained an invalid lifetime.");
  }
  const refreshToken = payload.refresh_token === undefined
    ? undefined
    : validateToken(payload.refresh_token, "crt_", "refresh token");
  const scopes = typeof payload.scope === "string"
    ? [...new Set(payload.scope.split(/\s+/u).filter((scope) => /^[a-z][a-z0-9:_-]{0,63}$/u.test(scope)))]
    : [];
  return Object.freeze({
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: now + (payload.expires_in as number) * 1_000,
    scopes: Object.freeze(scopes),
  });
}

function requireGrantedScopes(granted: readonly string[], required: readonly string[]): void {
  const grantedSet = new Set(granted);
  const missing = required.filter((scope) => !grantedSet.has(scope));
  if (missing.length > 0) {
    throw new Error(`Chutes OAuth grant is missing required Airship scopes: ${missing.join(", ")}.`);
  }
}

function validateRedirectUri(value: string, allowedRedirectUris: readonly string[]): string {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && url.hostname === "localhost";
  if (url.protocol !== "https:" && !localHttp) {
    throw new TypeError("OAuth redirects must use HTTPS, except for http://localhost development.");
  }
  if (url.username || url.password || url.hash) {
    throw new TypeError("OAuth redirects cannot contain credentials or fragments.");
  }
  const canonical = url.href;
  if (!allowedRedirectUris.includes(canonical)) {
    throw new TypeError("The OAuth redirect is not an exact registered Airship callback.");
  }
  return canonical;
}

function validateClientId(value: string): string {
  const clientId = value.trim();
  if (!/^cid_[A-Za-z0-9._~-]{3,256}$/u.test(clientId)) {
    throw new TypeError("The Chutes OAuth client ID is invalid.");
  }
  return clientId;
}

function validatePkceVerifier(value: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(value)) {
    throw new TypeError("The Chutes PKCE verifier is invalid.");
  }
  return value;
}

function validateOpaqueValue(value: string, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError(`The Chutes ${label} is invalid.`);
  }
  return value;
}

function validateToken(value: unknown, prefix: "cak_" | "crt_", label: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.length <= prefix.length ||
    value.length > MAX_OAUTH_TOKEN_BYTES ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new Error(`Chutes OAuth returned an invalid ${label}.`);
  }
  return value;
}

function randomBase64Url(length: number, cryptoSource: Pick<Crypto, "getRandomValues">): string {
  const bytes = new Uint8Array(length);
  cryptoSource.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
