import type { ProviderOAuthId, ProviderOAuthRegistration } from "./registrations";

/**
 * The one seam every provider OAuth exchange goes through.
 *
 * Flow logic never calls `fetch`. It calls a transport, so the same
 * authorization-code and device-code code paths run unchanged whether the exchange
 * leaves the page directly (OpenAI) or is relayed by the extension bridge (xAI,
 * Anthropic). The bridge package implements this interface; nothing else about the
 * flows has to know it exists.
 */

/** Token and device responses are small; anything larger is a defect or an attack. */
export const MAX_OAUTH_RESPONSE_BYTES = 32 * 1_024;
/** Form bodies carry a code, a verifier, and identifiers. Nothing legitimate is big. */
export const MAX_OAUTH_REQUEST_BODY_BYTES = 8 * 1_024;
export const OAUTH_REQUEST_TIMEOUT_MS = 20_000;

export type ProviderOAuthTransportId = "direct-fetch" | "extension-bridge";

export type OAuthHttpRequest = Readonly<{
  /**
   * Whose exchange this is. Declared by the caller rather than guessed from the
   * URL: a transport that infers the provider has to invent an answer for a URL
   * it does not recognise, and would then report a failure against a provider
   * that was never addressed. It is also what binds a destination to a
   * provider, exactly as the bridge binds one.
   */
  provider: ProviderOAuthId;
  url: string;
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: string;
  maxResponseBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export type OAuthHttpResponse = Readonly<{
  status: number;
  contentType?: string;
  /** Decoded UTF-8, already bounded by `maxResponseBytes`. */
  body: string;
}>;

export type ProviderOAuthTransport = Readonly<{
  id: ProviderOAuthTransportId;
  /**
   * Providers this transport will actually carry, as observed for this page load.
   * The bridge implementation derives it from a live `hello` reply, never from a
   * cached value, so an empty list is the honest answer when no extension answered.
   */
  carries: readonly ProviderOAuthId[];
  request: (request: OAuthHttpRequest) => Promise<OAuthHttpResponse>;
}>;

export type ProviderOAuthErrorCode =
  | "configuration"
  | "invalid-input"
  | "state-mismatch"
  | "transport-unavailable"
  | "network"
  | "timeout"
  | "cancelled"
  | "response-too-large"
  | "invalid-response"
  | "provider-error"
  | "authorization-pending"
  | "slow-down"
  | "authorization-expired"
  | "authorization-denied";

/**
 * A named failure. There is no silent fallback anywhere in this package: every path
 * that cannot complete throws one of these with the cause in `code`.
 *
 * Messages are assembled from fixed text plus a whitelisted provider error code. A
 * provider's `error_description` is deliberately dropped: it is attacker- and
 * provider-controlled free text that can echo the submitted code back at us, and this
 * package must never surface a credential in a message, a log, or a UI string.
 */
export class ProviderOAuthError extends Error {
  readonly code: ProviderOAuthErrorCode;
  readonly provider: ProviderOAuthId;
  readonly status?: number;
  readonly providerCode?: string;

  constructor(input: Readonly<{
    code: ProviderOAuthErrorCode;
    provider: ProviderOAuthId;
    message: string;
    status?: number;
    providerCode?: string;
  }>) {
    super(input.message);
    this.name = "ProviderOAuthError";
    this.code = input.code;
    this.provider = input.provider;
    if (input.status !== undefined) this.status = input.status;
    if (input.providerCode !== undefined) this.providerCode = input.providerCode;
  }
}

export function isProviderOAuthError(value: unknown): value is ProviderOAuthError {
  return value instanceof ProviderOAuthError;
}

/**
 * Providers whose OAuth endpoints were measured to answer a cross-origin page.
 * This list is fixed on purpose: a caller cannot widen it and thereby claim a
 * reachability that was never observed.
 */
const DIRECTLY_REACHABLE_PROVIDERS: readonly ProviderOAuthId[] = Object.freeze(["openai"]);

/**
 * The direct transport's compiled-in destination allowlist, the same kind of bound the
 * bridge transport has had from the start (`BRIDGE_DESTINATIONS`).
 *
 * Gating by provider alone is not a bound on where bytes go: `requireTransportFor`
 * answers "may this transport carry OpenAI?", not "is this an OpenAI endpoint?". Without
 * this table a caller that passed any URL would have it fetched, with only the deployed
 * page's CSP standing in the way — and a CSP is a deployment fact, not a property of
 * this module. The prefixes are stated here rather than read from `registrations.ts` so
 * that adding an endpoint to a registration cannot silently widen what may be fetched.
 */
const DIRECT_FETCH_DESTINATIONS: Readonly<Record<ProviderOAuthId, readonly string[]>> =
  Object.freeze({
    openai: Object.freeze(["https://auth.openai.com/oauth/"]),
    // Bridge-only providers: `carries` already refuses them, and an empty list
    // means no URL can be reached for them even if that gate were bypassed.
    xai: Object.freeze([]),
    anthropic: Object.freeze([]),
  });

/** Unreserved characters plus `/`; see `isDirectFetchDestination`. */
const DIRECT_DESTINATION_PATH = /^[A-Za-z0-9\-._~/]*$/u;

/**
 * A URL is an allowlisted direct destination only for the provider that owns it.
 *
 * Matching is on the normalized `URL.href`, never on the caller's raw text: a prefix
 * test on raw bytes accepts `https://auth.openai.com/oauth/../../evil`, which resolves
 * somewhere the prefix never approved. The path charset is the same positive rule the
 * bridge and the extension apply — `new URL` resolves `..`, but it does not resolve an
 * escape the origin's own router decodes (`%2f`, `%25`, a `;` path parameter). The
 * query is not covered: it cannot move a request off the path prefix.
 */
export function isDirectFetchDestination(provider: ProviderOAuthId, url: string): boolean {
  if (typeof url !== "string" || url.length > 2_048) return false;
  // Printable ASCII only. The URL parser below silently strips or percent-encodes
  // whitespace and control characters, so refusing them here is how a caller learns it
  // built a URL it did not mean to build instead of having one quietly repaired.
  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password || parsed.hash) return false;
  if (!DIRECT_DESTINATION_PATH.test(parsed.pathname)) return false;
  return DIRECT_FETCH_DESTINATIONS[provider].some((prefix) => parsed.href.startsWith(prefix));
}

/**
 * The in-page transport. Sends no cookies, follows no redirects, bounds the response,
 * and refuses providers the browser cannot reach rather than letting the network stack
 * fail with an opaque `TypeError`.
 */
export function createDirectFetchTransport(options: Readonly<{
  fetch?: typeof globalThis.fetch;
}> = {}): ProviderOAuthTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return Object.freeze({
    id: "direct-fetch" as const,
    carries: DIRECTLY_REACHABLE_PROVIDERS,
    request: async (request: OAuthHttpRequest): Promise<OAuthHttpResponse> => {
      if (!fetchImpl) {
        throw new ProviderOAuthError({
          code: "transport-unavailable",
          provider: request.provider,
          message: "Fetch is unavailable, so no OAuth exchange can be made from this page.",
        });
      }
      return await directFetch(fetchImpl, request);
    },
  });
}

async function directFetch(
  fetchImpl: typeof globalThis.fetch,
  request: OAuthHttpRequest,
): Promise<OAuthHttpResponse> {
  const provider = request.provider;
  // Checked before anything is spent on the request: an endpoint outside the
  // compiled-in list is a defect or an attack, not a provider that happened to
  // fail, so it must not become a network call at all.
  if (!isDirectFetchDestination(provider, request.url)) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider,
      message: `That address is not a compiled-in ${provider} OAuth endpoint, so this page will not fetch it.`,
    });
  }
  if (request.body !== undefined && request.body.length > MAX_OAUTH_REQUEST_BODY_BYTES) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider,
      message: "The OAuth request body exceeded the browser safety limit.",
    });
  }
  const lifetime = createRequestLifetime(request.timeoutMs, request.signal);
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      mode: "cors",
      signal: lifetime.signal,
    });
    const body = await readBoundedText(response, request.maxResponseBytes, provider, lifetime.signal);
    const contentType = response.headers.get("content-type") ?? undefined;
    return Object.freeze({
      status: response.status,
      ...(contentType ? { contentType } : {}),
      body,
    });
  } catch (error) {
    if (error instanceof ProviderOAuthError) throw error;
    if (lifetime.didTimeout()) {
      throw new ProviderOAuthError({
        code: "timeout",
        provider,
        message: "The OAuth request timed out.",
      });
    }
    if (request.signal?.aborted) {
      throw new ProviderOAuthError({
        code: "cancelled",
        provider,
        message: "The OAuth request was cancelled.",
      });
    }
    throw new ProviderOAuthError({
      code: "network",
      provider,
      message: "The OAuth request could not reach the provider from this page.",
    });
  } finally {
    lifetime.dispose();
  }
}

/** Refuse before any network call when the transport cannot carry this provider. */
export function requireTransportFor(
  transport: ProviderOAuthTransport,
  registration: ProviderOAuthRegistration,
): void {
  if (transport.carries.includes(registration.provider)) return;
  const cause = registration.transport.kind === "extension-bridge"
    ? `${registration.displayName} sign-in needs the Airship browser extension: ${registration.transport.evidence}`
    : `${registration.displayName} sign-in is not carried by the ${transport.id} transport.`;
  throw new ProviderOAuthError({
    code: "transport-unavailable",
    provider: registration.provider,
    message: cause,
  });
}

export function createRequestLifetime(
  timeoutMs: number,
  parent?: AbortSignal,
): Readonly<{ signal: AbortSignal; didTimeout: () => boolean; dispose: () => void }> {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener("abort", forwardAbort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The OAuth request timed out.", "TimeoutError"));
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

async function readBoundedText(
  response: Response,
  maxBytes: number,
  provider: ProviderOAuthId,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes) {
      throw new ProviderOAuthError({
        code: "response-too-large",
        provider,
        message: "The OAuth response exceeded the browser safety limit.",
        status: response.status,
      });
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ProviderOAuthError({
          code: "response-too-large",
          provider,
          message: "The OAuth response exceeded the browser safety limit.",
          status: response.status,
        });
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* a cancelled reader may retain a pending read */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProviderOAuthError({
      code: "invalid-response",
      provider,
      message: "The OAuth response was not valid UTF-8.",
      status: response.status,
    });
  }
}
