import type { DeviceCodeRegistration } from "./registrations";
import {
  normalizeProviderTokenSet,
  parseOAuthJson,
  postProviderTokenRequest,
  providerTokenError,
  readProviderErrorCode,
  type ProviderTokenSet,
} from "./token-set";
import {
  MAX_OAUTH_RESPONSE_BYTES,
  OAUTH_REQUEST_TIMEOUT_MS,
  ProviderOAuthError,
  requireTransportFor,
  type ProviderOAuthTransport,
} from "./transport";

/**
 * RFC 8628 device authorization grant.
 *
 * The user never pastes anything here: the provider shows a code, the user approves it
 * elsewhere, and the page polls. Every bound the RFC leaves to the client is fixed
 * here — poll interval floor and ceiling, total attempts, and a wall-clock deadline —
 * so a provider that answers `authorization_pending` forever cannot turn into an
 * unbounded loop in a browser tab.
 */

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 60_000;
/** RFC 8628 §3.5: a `slow_down` adds five seconds to the interval. */
const SLOW_DOWN_INCREMENT_MS = 5_000;
const MIN_EXPIRY_SECONDS = 30;
const MAX_EXPIRY_SECONDS = 30 * 60;
const MAX_POLL_ATTEMPTS = 360;
const USER_CODE_PATTERN = /^[\u0020-\u007e]{4,64}$/u;

export type DeviceAuthorization = Readonly<{
  provider: DeviceCodeRegistration["provider"];
  /** Bearer-equivalent for the pending grant: never rendered, never logged. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalMs: number;
  expiresAt: number;
}>;

export type DeviceCodePollProgress = Readonly<
  | { state: "pending"; attempt: number; nextDelayMs: number }
  | { state: "slow-down"; attempt: number; nextDelayMs: number }
>;

export type DeviceSleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

/** Ask the provider for a device code and the URL the user has to visit. */
export async function requestDeviceAuthorization(args: Readonly<{
  registration: DeviceCodeRegistration;
  transport: ProviderOAuthTransport;
  now?: number;
  signal?: AbortSignal;
}>): Promise<DeviceAuthorization> {
  const registration = args.registration;
  requireTransportFor(args.transport, registration);
  const now = args.now ?? Date.now();
  const response = await args.transport.request({
    provider: registration.provider,
    url: registration.deviceAuthorizationEndpoint,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...registration.tokenRequestHeaders,
    },
    body: new URLSearchParams({
      client_id: registration.clientId,
      scope: registration.scopes.join(" "),
    }).toString(),
    maxResponseBytes: MAX_OAUTH_RESPONSE_BYTES,
    timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const payload = parseOAuthJson(response, registration.provider);
  if (response.status < 200 || response.status >= 300) {
    throw providerTokenError(registration, Object.freeze({
      status: response.status,
      payload,
      endpoint: registration.deviceAuthorizationEndpoint,
    }));
  }
  return normalizeDeviceAuthorization(payload, registration, now);
}

/**
 * Poll until the user approves, the grant is refused, or the device code expires.
 *
 * `sleep` is injected so the deadline logic is testable without real time; the
 * default is a plain, abortable timer.
 */
export async function pollDeviceAccessToken(args: Readonly<{
  registration: DeviceCodeRegistration;
  authorization: DeviceAuthorization;
  transport: ProviderOAuthTransport;
  now?: () => number;
  sleep?: DeviceSleep;
  signal?: AbortSignal;
  onProgress?: (progress: DeviceCodePollProgress) => void;
}>): Promise<ProviderTokenSet> {
  const registration = args.registration;
  const authorization = args.authorization;
  if (authorization.provider !== registration.provider) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider: registration.provider,
      message: "The device authorization belongs to a different provider.",
    });
  }
  const readNow = args.now ?? (() => Date.now());
  const sleep = args.sleep ?? defaultSleep;
  let intervalMs = authorization.intervalMs;

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    if (args.signal?.aborted) {
      throw new ProviderOAuthError({
        code: "cancelled",
        provider: registration.provider,
        message: `${registration.displayName} sign-in was cancelled.`,
      });
    }
    if (readNow() >= authorization.expiresAt) throw deviceExpired(registration);
    await sleep(intervalMs, args.signal);
    if (readNow() >= authorization.expiresAt) throw deviceExpired(registration);

    const result = await postProviderTokenRequest({
      registration,
      form: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: authorization.deviceCode,
        client_id: registration.clientId,
      },
      transport: args.transport,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (result.status >= 200 && result.status < 300) {
      return normalizeProviderTokenSet(result.payload, {
        provider: registration.provider,
        now: readNow(),
      });
    }
    const providerCode = readProviderErrorCode(result.payload);
    if (providerCode === "authorization_pending") {
      args.onProgress?.(Object.freeze({ state: "pending" as const, attempt, nextDelayMs: intervalMs }));
      continue;
    }
    if (providerCode === "slow_down") {
      intervalMs = Math.min(intervalMs + SLOW_DOWN_INCREMENT_MS, MAX_INTERVAL_MS);
      args.onProgress?.(Object.freeze({ state: "slow-down" as const, attempt, nextDelayMs: intervalMs }));
      continue;
    }
    if (providerCode === "expired_token") throw deviceExpired(registration);
    if (providerCode === "access_denied") {
      throw new ProviderOAuthError({
        code: "authorization-denied",
        provider: registration.provider,
        message: `${registration.displayName} sign-in was refused.`,
        status: result.status,
        providerCode,
      });
    }
    // Anything else is terminal. Retrying an unknown error would be a silent
    // fallback, and the RFC only defines the four codes handled above.
    throw providerTokenError(registration, result);
  }
  throw new ProviderOAuthError({
    code: "authorization-expired",
    provider: registration.provider,
    message: `${registration.displayName} sign-in was still not approved after ${MAX_POLL_ATTEMPTS} checks.`,
  });
}

function normalizeDeviceAuthorization(
  payload: Readonly<Record<string, unknown>>,
  registration: DeviceCodeRegistration,
  now: number,
): DeviceAuthorization {
  const deviceCode = requireOpaque(payload.device_code, registration, "device code");
  const userCode = payload.user_code;
  if (typeof userCode !== "string" || !USER_CODE_PATTERN.test(userCode)) {
    throw invalidDeviceResponse(registration, "user code");
  }
  const verificationUri = requireHttpsUrl(payload.verification_uri, registration, "verification URL");
  const verificationUriComplete = payload.verification_uri_complete === undefined
    ? undefined
    : requireHttpsUrl(payload.verification_uri_complete, registration, "verification URL");
  const expiresIn = payload.expires_in;
  if (
    !Number.isSafeInteger(expiresIn)
    || (expiresIn as number) < MIN_EXPIRY_SECONDS
    || (expiresIn as number) > MAX_EXPIRY_SECONDS
  ) {
    throw invalidDeviceResponse(registration, "expiry");
  }
  const rawInterval = payload.interval;
  const intervalMs = rawInterval === undefined || rawInterval === null
    ? DEFAULT_INTERVAL_MS
    : Number.isSafeInteger(rawInterval) && (rawInterval as number) > 0
      ? Math.min(Math.max((rawInterval as number) * 1_000, MIN_INTERVAL_MS), MAX_INTERVAL_MS)
      : invalidInterval(registration);
  return Object.freeze({
    provider: registration.provider,
    deviceCode,
    userCode,
    verificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    intervalMs,
    expiresAt: now + (expiresIn as number) * 1_000,
  });
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requireOpaque(
  value: unknown,
  registration: DeviceCodeRegistration,
  label: string,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4 * 1_024
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw invalidDeviceResponse(registration, label);
  }
  return value;
}

function requireHttpsUrl(
  value: unknown,
  registration: DeviceCodeRegistration,
  label: string,
): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw invalidDeviceResponse(registration, label);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidDeviceResponse(registration, label);
  }
  // The user is about to be sent here, so a device response is not allowed to point
  // anywhere it likes. The bound is the issuer's own registrable domain: providers do
  // host the approval page on a sibling host (`auth.x.ai` issuing an `x.ai` URL), but
  // never on someone else's domain.
  if (url.protocol !== "https:" || !isIssuerDomain(url.hostname, registration.issuer)) {
    throw invalidDeviceResponse(registration, label);
  }
  return url.href;
}

function isIssuerDomain(hostname: string, issuer: string): boolean {
  const issuerHost = new URL(issuer).hostname;
  if (hostname === issuerHost) return true;
  const labels = issuerHost.split(".");
  // Only one label is dropped, so `auth.x.ai` admits `x.ai` and `*.x.ai` and nothing
  // shorter; a two-label issuer admits only itself and its own subdomains.
  const parent = labels.length > 2 ? labels.slice(1).join(".") : issuerHost;
  return hostname === parent || hostname.endsWith(`.${parent}`);
}

function invalidInterval(registration: DeviceCodeRegistration): never {
  throw invalidDeviceResponse(registration, "poll interval");
}

function invalidDeviceResponse(
  registration: DeviceCodeRegistration,
  label: string,
): ProviderOAuthError {
  return new ProviderOAuthError({
    code: "invalid-response",
    provider: registration.provider,
    message: `${registration.displayName} returned an invalid device ${label}.`,
  });
}

function deviceExpired(registration: DeviceCodeRegistration): ProviderOAuthError {
  return new ProviderOAuthError({
    code: "authorization-expired",
    provider: registration.provider,
    message: `The ${registration.displayName} device code expired before it was approved.`,
  });
}
