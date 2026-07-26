/**
 * The bridge's implementation of `ProviderOAuthTransport`.
 *
 * The OAuth flows never call `fetch` and never learn that an extension exists:
 * they call a transport, and this one relays through the page bridge. `carries`
 * is built from one live `hello` reply at construction, so a page with no
 * extension produces a transport that honestly carries nothing and
 * `requireTransportFor` refuses before any network call.
 *
 * Constructing this transport is therefore an observation, and it must be
 * constructed per page load rather than kept: an extension can be disabled
 * between loads, and a remembered `carries` would be a stale claim.
 */
import {
  MAX_OAUTH_REQUEST_BODY_BYTES,
  ProviderOAuthError,
} from "../../auth/provider-oauth/transport";
import type {
  OAuthHttpRequest,
  OAuthHttpResponse,
  ProviderOAuthTransport,
} from "../../auth/provider-oauth/transport";
import type { ProviderOAuthId } from "../../auth/provider-oauth/registrations";
import {
  ExtensionBridgeClient,
  absenceDetail,
  pageExtensionBridge,
} from "./client";
import {
  BRIDGE_PROVIDER_IDS,
  ExtensionBridgeError,
  bridgeRequestHeaders,
  isBridgeDestination,
  type BridgeHandshakeResult,
  type BridgeProviderId,
} from "./protocol";

export type ExtensionBridgeOAuthTransport = ProviderOAuthTransport & Readonly<{
  /** The handshake this transport was built from, so a surface can name the cause. */
  handshake: BridgeHandshakeResult;
}>;

export type ExtensionBridgeOAuthTransportOptions = Readonly<{
  /** Injectable for tests; defaults to the page's own relay when one exists. */
  client?: ExtensionBridgeClient;
  signal?: AbortSignal;
}>;

export async function createExtensionBridgeOAuthTransport(
  options: ExtensionBridgeOAuthTransportOptions = {},
): Promise<ExtensionBridgeOAuthTransport> {
  const client = options.client ?? pageExtensionBridge();
  if (!client) {
    return frozenTransport(
      Object.freeze({
        kind: "unsupported" as const,
        detail: "this runtime has no page window to relay one through",
      }),
      undefined,
    );
  }
  const handshake = await client.handshake(options.signal);
  return frozenTransport(handshake, client);
}

function frozenTransport(
  handshake: BridgeHandshakeResult,
  client: ExtensionBridgeClient | undefined,
): ExtensionBridgeOAuthTransport {
  // Only providers the extension itself named, intersected with the providers
  // this build knows how to address. Nothing is added on Airship's behalf.
  const carries: readonly ProviderOAuthId[] = handshake.kind === "answered" && client
    ? Object.freeze(handshake.providers.filter(
        (provider): provider is BridgeProviderId => BRIDGE_PROVIDER_IDS.includes(provider),
      ))
    : Object.freeze([]);
  return Object.freeze({
    id: "extension-bridge" as const,
    carries,
    handshake,
    request: async (request: OAuthHttpRequest): Promise<OAuthHttpResponse> => {
      // The caller declares whose exchange this is; the URL only has to agree.
      // Deriving the provider from the URL instead would let a mismatched pair
      // through under whichever identity the URL happened to suggest.
      const owner = bridgeProviderOfUrl(request.url);
      const provider = owner === request.provider ? owner : undefined;
      if (!client || carries.length === 0 || !provider || !carries.includes(provider)) {
        // When the extension named its own reason, that reason is what the
        // operator sees; nothing is invented on its behalf.
        const named = handshake.kind === "answered" && provider
          ? handshake.unavailable.find((entry) => entry.provider === provider)?.reason
          : undefined;
        throw new ProviderOAuthError({
          code: "transport-unavailable",
          provider: request.provider,
          message: `The extension bridge cannot carry this exchange. ${named ?? absenceDetail(handshake)}`,
        });
      }
      return await relay(client, provider, request);
    },
  });
}

async function relay(
  client: ExtensionBridgeClient,
  provider: BridgeProviderId,
  request: OAuthHttpRequest,
): Promise<OAuthHttpResponse> {
  // The OAuth package's own ceiling, imported rather than restated: two copies
  // of a bound drift apart silently, and the looser one wins.
  if (request.body !== undefined && request.body.length > MAX_OAUTH_REQUEST_BODY_BYTES) {
    throw new ProviderOAuthError({
      code: "configuration",
      provider,
      message: "The OAuth request body exceeded the browser safety limit.",
    });
  }
  const lifetime = requestLifetime(request.timeoutMs, request.signal);
  try {
    const response = await client.fetch({
      provider,
      url: request.url,
      method: request.method,
      headers: bridgeRequestHeaders(request.headers),
      ...(request.body === undefined ? {} : { body: request.body }),
      // OAuth exchanges are single small documents; nothing here is streamed.
      stream: false,
      signal: lifetime.signal,
    });
    const body = await readBoundedText(response, request.maxResponseBytes, provider);
    const contentType = response.headers.get("content-type") ?? undefined;
    return Object.freeze({
      status: response.status,
      ...(contentType ? { contentType } : {}),
      body,
    });
  } catch (error) {
    throw asOAuthError(error, provider, lifetime.didTimeout(), request.signal?.aborted === true);
  } finally {
    lifetime.dispose();
  }
}

function asOAuthError(
  error: unknown,
  provider: BridgeProviderId,
  timedOut: boolean,
  cancelled: boolean,
): ProviderOAuthError {
  if (error instanceof ProviderOAuthError) return error;
  if (timedOut) {
    return new ProviderOAuthError({
      code: "timeout",
      provider,
      message: "The bridged OAuth request timed out.",
    });
  }
  if (cancelled) {
    return new ProviderOAuthError({
      code: "cancelled",
      provider,
      message: "The bridged OAuth request was cancelled.",
    });
  }
  if (!(error instanceof ExtensionBridgeError)) {
    return new ProviderOAuthError({
      code: "invalid-response",
      provider,
      message: "The extension bridge failed the OAuth request in an unrecognized way.",
    });
  }
  switch (error.code) {
    case "bridge-unavailable":
    case "bridge-refused":
    case "bridge-busy":
      return new ProviderOAuthError({
        code: "transport-unavailable",
        provider,
        message: `The extension bridge did not carry the OAuth request: ${error.message}`,
      });
    case "bridge-error":
      return new ProviderOAuthError({
        code: "network",
        provider,
        message: "The extension bridge could not reach the provider.",
      });
    case "bridge-too-large":
      return new ProviderOAuthError({
        code: "response-too-large",
        provider,
        message: "The OAuth response exceeded the browser safety limit.",
      });
    case "bridge-timeout":
      return new ProviderOAuthError({
        code: "timeout",
        provider,
        message: "The bridged OAuth request timed out.",
      });
    case "bridge-cancelled":
      return new ProviderOAuthError({
        code: "cancelled",
        provider,
        message: "The bridged OAuth request was cancelled.",
      });
    default:
      return new ProviderOAuthError({
        code: "invalid-response",
        provider,
        message: "The extension bridge broke the OAuth exchange contract.",
      });
  }
}

/**
 * Which allowlisted provider owns a URL, or nothing.
 *
 * This is the page's own copy of the destination allowlist, so an endpoint the
 * contract does not carry is refused here rather than sent for the extension to
 * refuse. It delegates to `isBridgeDestination` rather than testing the
 * prefixes itself: an exported classifier that applied a *weaker* rule than the
 * one the client enforces would answer questions with a different allowlist
 * than the one that actually gates the request.
 */
export function bridgeProviderOfUrl(url: string): BridgeProviderId | undefined {
  for (const provider of BRIDGE_PROVIDER_IDS) {
    if (isBridgeDestination(provider, url)) return provider;
  }
  return undefined;
}

function requestLifetime(
  timeoutMs: number,
  parent?: AbortSignal,
): Readonly<{ signal: AbortSignal; didTimeout: () => boolean; dispose: () => void }> {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The bridged OAuth request timed out.", "TimeoutError"));
  }, timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", forwardAbort);
    },
  });
}

/** The caller's byte ceiling, enforced again here on top of the client's own. */
async function readBoundedText(
  response: Response,
  maxBytes: number,
  provider: BridgeProviderId,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
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
    try {
      reader.releaseLock();
    } catch {
      /* a cancelled reader may still hold a pending read */
    }
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
