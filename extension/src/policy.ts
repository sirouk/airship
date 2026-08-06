/**
 * Everything the Airship bridge is allowed to do, compiled in.
 *
 * This module is the security boundary of the extension. An extension that
 * relayed caller-supplied hosts would be a general-purpose CORS-bypass weapon
 * for any page that could reach it, so nothing here is configurable at
 * runtime: no storage, no options page, no message can widen a list below.
 * Changing the boundary means editing this file and rebuilding, which is what
 * makes the boundary reviewable.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;
export const EXTENSION_VERSION = "1.1.1";

/** Port name used by the content script; the background worker accepts no other. */
export const BRIDGE_PORT_NAME = "airship-bridge/1";

/**
 * `User-Agent` is a forbidden header name for `fetch`, so neither the page nor
 * this worker's `fetch` call can set it. It is applied by a header-rewrite rule
 * bound to a URL prefix, which means the value must be compiled in per
 * destination rather than taken from the caller: a rule matches a URL, not a
 * request, so two concurrent requests to one destination could not be told
 * apart. A page that asks for a different value is refused rather than
 * silently sent this one — see `BRIDGE_DESTINATIONS`.
 */
export const ANTHROPIC_TOKEN_USER_AGENT = "axios/1.7.9";
export const ANTHROPIC_OAUTH_INFERENCE_USER_AGENT = "claude-code/1.0.0";

export type BridgeProvider = "xai" | "anthropic";
export type BridgeMethod = "GET" | "POST";
export type BridgeChannel = "release" | "development";

export const BRIDGE_PROVIDERS: readonly BridgeProvider[] = Object.freeze(["xai", "anthropic"]);
export const BRIDGE_METHODS: readonly BridgeMethod[] = Object.freeze(["GET", "POST"]);

export type BridgeLimits = Readonly<{
  maxRequestIdLength: number;
  maxEnvelopeKeys: number;
  maxUrlLength: number;
  maxRequestBodyBytes: number;
  maxHeaderEntries: number;
  maxHeaderNameLength: number;
  maxHeaderValueLength: number;
  maxResponseBytes: number;
  maxStreamResponseBytes: number;
  maxChunkBytes: number;
  maxChunks: number;
  maxConcurrentRequests: number;
  bufferedDeadlineMs: number;
  streamDeadlineMs: number;
  streamIdleDeadlineMs: number;
}>;

/**
 * Ceilings mirror the in-page runtime packs: a request that cannot be bounded
 * is a request the worker refuses. The streamed ceilings are larger than the
 * buffered ones because a chat completion arrives incrementally and is never
 * held whole, but both are finite and both are enforced while reading.
 */
export const BRIDGE_LIMITS: BridgeLimits = Object.freeze({
  maxRequestIdLength: 128,
  maxEnvelopeKeys: 16,
  maxUrlLength: 2_048,
  maxRequestBodyBytes: 256 * 1_024,
  maxHeaderEntries: 16,
  maxHeaderNameLength: 64,
  maxHeaderValueLength: 8_192,
  maxResponseBytes: 8 * 1_024 * 1_024,
  maxStreamResponseBytes: 16 * 1_024 * 1_024,
  maxChunkBytes: 32 * 1_024,
  maxChunks: 8_192,
  maxConcurrentRequests: 4,
  bufferedDeadlineMs: 60_000,
  streamDeadlineMs: 300_000,
  streamIdleDeadlineMs: 45_000,
});

export type BridgeDestination = Readonly<{
  provider: BridgeProvider;
  /** Absolute origin plus path prefix. A request URL must start with it exactly. */
  prefix: string;
  /**
   * The `User-Agent` this destination is fetched with, where the measured
   * vendor behaviour requires one a page cannot set. Absent means the browser's
   * own agent is used and no rewrite mechanism is needed.
   */
  userAgent?: string;
}>;

/** The only URLs this extension will ever fetch. */
export const BRIDGE_DESTINATIONS: readonly BridgeDestination[] = Object.freeze([
  Object.freeze({
    provider: "xai",
    prefix: "https://auth.x.ai/oauth2/",
  }),
  Object.freeze({
    provider: "xai",
    prefix: "https://api.x.ai/v1/",
  }),
  // Measured: the Anthropic token host answers 429 to `Mozilla/5.0` and reaches
  // code validation for `axios/1.7.9`.
  Object.freeze({
    provider: "anthropic",
    prefix: "https://claude.ai/oauth/",
    userAgent: ANTHROPIC_TOKEN_USER_AGENT,
  }),
  Object.freeze({
    provider: "anthropic",
    prefix: "https://platform.claude.com/v1/oauth/",
    userAgent: ANTHROPIC_TOKEN_USER_AGENT,
  }),
  // Anthropic's OAuth inference path is served to the Claude Code fingerprint.
  // An API-key Anthropic call never comes through the bridge, so this value
  // applies only to bridged OAuth inference.
  Object.freeze({
    provider: "anthropic",
    prefix: "https://api.anthropic.com/v1/",
    userAgent: ANTHROPIC_OAUTH_INFERENCE_USER_AGENT,
  }),
]);

export function destinationRequiresUserAgentOverride(destination: BridgeDestination): boolean {
  return typeof destination.userAgent === "string";
}

/**
 * Only the headers the two protocols actually require. Everything else the
 * page sends is dropped rather than forwarded, and reported back so a dropped
 * header can never look like a header that was honoured.
 */
export const FORWARDED_REQUEST_HEADERS: readonly string[] = Object.freeze([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "authorization",
  "content-type",
  "user-agent",
  "x-app",
]);

/**
 * Response headers handed back to the page. `set-cookie` is unreadable here
 * anyway, but the allowlist is positive so a new vendor header cannot start
 * flowing into the page without review.
 */
export const RETURNED_RESPONSE_HEADERS: readonly string[] = Object.freeze([
  "anthropic-request-id",
  "content-type",
  "request-id",
  "retry-after",
  "x-request-id",
]);

export type CallerOrigin = Readonly<{ origin: string; pathPrefix: string }>;

/**
 * The pages allowed to speak to the bridge. The content script is registered
 * for exactly these patterns *and* the background worker re-checks the sender,
 * because a content-script registration alone is a claim about where the code
 * runs, not a check on who is talking.
 */
export const RELEASE_CALLERS: readonly CallerOrigin[] = Object.freeze([
  Object.freeze({ origin: "https://sirouk.github.io", pathPrefix: "/airship/" }),
]);

/**
 * The development channel adds the loopback dev server. It is a separate build
 * so a shipped extension can never be reached by an unrelated page served from
 * a developer's own machine.
 *
 * It is a function rather than a constant so that a release bundle, whose
 * channel folds to a literal at build time, drops it entirely: the shipped
 * artifact does not merely refuse the loopback origins, it does not contain
 * them. `build.test.mjs` asserts that.
 */
export function developmentCallers(): readonly CallerOrigin[] {
  return Object.freeze([
    ...RELEASE_CALLERS,
    Object.freeze({ origin: "http://localhost:4173", pathPrefix: "/" }),
    Object.freeze({ origin: "http://127.0.0.1:4173", pathPrefix: "/" }),
    // The compose deployment uses 8080 for exactly the purpose this channel
    // exists for: running the real container locally at a loopback origin.
    // Both hosts are named because the compose healthcheck and a developer's
    // habit disagree about which one they typed.
    Object.freeze({ origin: "http://localhost:8080", pathPrefix: "/" }),
    Object.freeze({ origin: "http://127.0.0.1:8080", pathPrefix: "/" }),
  ]);
}

export function callerAllowlist(channel: BridgeChannel): readonly CallerOrigin[] {
  return channel === "development" ? developmentCallers() : RELEASE_CALLERS;
}

/** Match patterns for `content_scripts` and `host_permissions`, from the same lists. */
export function callerMatchPatterns(callers: readonly CallerOrigin[]): readonly string[] {
  return Object.freeze(callers.map((caller) => `${caller.origin}${caller.pathPrefix}*`));
}

export function destinationMatchPatterns(
  destinations: readonly BridgeDestination[] = BRIDGE_DESTINATIONS,
): readonly string[] {
  return Object.freeze(destinations.map((destination) => `${destination.prefix}*`));
}

export type DestinationResolution =
  | Readonly<{ ok: true; url: string; destination: BridgeDestination }>
  | Readonly<{ ok: false; message: string }>;

/**
 * The characters an allowlisted destination *path* may contain.
 *
 * `new URL` already resolves `.` and `..` segments — including their `%2e`
 * spellings, which the URL standard treats as dot segments — so the prefix
 * comparison below cannot be walked out of by a literal traversal. What it
 * does not resolve is a segment the origin server decodes or strips on its
 * own: `%2f`/`%5c` decode to separators, `%25` is one decoding round away from
 * spelling either of those (`%252e%252e` → `%2e%2e` → `..`), and a `;` path
 * parameter is stripped by routers that then route on the `..` left behind.
 *
 * All five allowlisted destinations are plain ASCII API paths, so the boundary
 * is drawn positively rather than as a list of known-bad shapes: anything
 * outside the unreserved set plus `/` is refused. Adding a destination whose
 * path needs an escape means widening this deliberately, in this file.
 *
 * The query is not covered. It cannot move the request off the path prefix,
 * and refusing it there would reject legitimate values — an OAuth
 * `redirect_uri` carries `%2F` by construction.
 */
const DESTINATION_PATH = /^[A-Za-z0-9\-._~/]*$/u;

/**
 * Resolve a caller-supplied absolute URL against the compiled-in allowlist.
 *
 * The declared provider must own the destination: an `xai` request may not
 * reach an Anthropic endpoint even though both are allowlisted, so a page bug
 * cannot send an Anthropic token to xAI.
 */
export function resolveDestination(
  provider: BridgeProvider,
  path: string,
  limits: BridgeLimits = BRIDGE_LIMITS,
  destinations: readonly BridgeDestination[] = BRIDGE_DESTINATIONS,
): DestinationResolution {
  if (typeof path !== "string" || path.length === 0) {
    return Object.freeze({ ok: false, message: "A destination URL is required." });
  }
  if (path.length > limits.maxUrlLength) {
    return Object.freeze({
      ok: false,
      message: `The destination URL exceeds the ${limits.maxUrlLength}-character limit.`,
    });
  }
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    return Object.freeze({ ok: false, message: "The destination URL is not absolute." });
  }
  if (url.protocol !== "https:") {
    return Object.freeze({ ok: false, message: "Only https destinations are relayed." });
  }
  if (url.username || url.password) {
    return Object.freeze({ ok: false, message: "The destination URL carries embedded credentials." });
  }
  if (url.hash) {
    return Object.freeze({ ok: false, message: "The destination URL carries a fragment." });
  }
  // Checked on the normalised path only, so a percent escape in the query is
  // left alone while one in the path — which a decoding router could resolve
  // off the prefix approved below — is refused. See `DESTINATION_PATH`.
  if (!DESTINATION_PATH.test(url.pathname)) {
    return Object.freeze({
      ok: false,
      message: "The destination URL path may contain only unreserved characters and \"/\";"
        + " percent escapes and path parameters are refused because the origin's router could"
        + " decode them back off the approved prefix.",
    });
  }
  // `url.href` is normalised, so the single prefix comparison covers scheme,
  // host, port and path at once and cannot be walked out of with `..`.
  const destination = destinations.find(
    (candidate) => candidate.provider === provider && url.href.startsWith(candidate.prefix),
  );
  if (!destination) {
    return Object.freeze({
      ok: false,
      message: `${url.origin}${url.pathname} is not an allowlisted ${provider} destination.`,
    });
  }
  return Object.freeze({ ok: true, url: url.href, destination });
}

export type HeaderSelection =
  | Readonly<{
    ok: true;
    forwarded: Readonly<Record<string, string>>;
    dropped: readonly string[];
    /** The `user-agent` the caller asked for, which `fetch` cannot carry. */
    userAgent?: string;
  }>
  | Readonly<{ ok: false; message: string }>;

const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/u;
// Visible ASCII plus space. Excludes CR and LF, which would be header injection.
const HEADER_VALUE = /^[\x20-\x7e]*$/u;

export function selectRequestHeaders(
  headers: Readonly<Record<string, string>>,
  limits: BridgeLimits = BRIDGE_LIMITS,
  allowlist: readonly string[] = FORWARDED_REQUEST_HEADERS,
): HeaderSelection {
  const entries = Object.entries(headers);
  if (entries.length > limits.maxHeaderEntries) {
    return Object.freeze({
      ok: false,
      message: `A request may carry at most ${limits.maxHeaderEntries} headers.`,
    });
  }
  const forwarded: Record<string, string> = {};
  const dropped: string[] = [];
  const seen = new Set<string>();
  let userAgent: string | undefined;
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (rawName.length > limits.maxHeaderNameLength || !HEADER_NAME.test(name)) {
      return Object.freeze({ ok: false, message: `Header name ${JSON.stringify(rawName)} is invalid.` });
    }
    if (typeof value !== "string" || value.length > limits.maxHeaderValueLength || !HEADER_VALUE.test(value)) {
      return Object.freeze({ ok: false, message: `Header ${name} has an invalid value.` });
    }
    if (seen.has(name)) {
      return Object.freeze({ ok: false, message: `Header ${name} is repeated.` });
    }
    seen.add(name);
    if (!allowlist.includes(name)) {
      dropped.push(name);
      continue;
    }
    // `fetch` silently ignores `user-agent`, so it is carried out separately
    // and checked against the destination's compiled-in value by the relay.
    if (name === "user-agent") {
      userAgent = value;
      continue;
    }
    forwarded[name] = value;
  }
  return Object.freeze({
    ok: true,
    forwarded: Object.freeze(forwarded),
    dropped: Object.freeze(dropped),
    ...(userAgent === undefined ? {} : { userAgent }),
  });
}

export type HeaderReader = Readonly<{ get(name: string): string | null }>;

export function selectResponseHeaders(
  headers: HeaderReader,
  limits: BridgeLimits = BRIDGE_LIMITS,
  allowlist: readonly string[] = RETURNED_RESPONSE_HEADERS,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const name of allowlist) {
    const value = headers.get(name);
    if (typeof value !== "string") continue;
    if (value.length > limits.maxHeaderValueLength) continue;
    selected[name] = value;
  }
  return Object.freeze(selected);
}

export type SenderLike = Readonly<{
  url?: string;
  origin?: string;
  frameId?: number;
  tab?: unknown;
}>;

export type SenderCheck =
  | Readonly<{ ok: true; origin: string }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Is this document URL one of the pages the bridge serves?
 *
 * This is the part of the caller check that can be made from a URL alone, which
 * is all the content script has: it runs *inside* the document and proves it is
 * the top frame with `window.top === window` rather than with a frame id. The
 * background worker uses `checkSender` instead, which adds the frame evidence
 * the browser reports about the sender.
 *
 * Note what the origin gives and what it does not. The browser enforces the
 * *origin*; the path prefix only narrows which documents the content script is
 * injected into. Any page on the same origin is same-origin with an Airship
 * page and can script it directly, so the effective trust boundary is the whole
 * origin, not the `/airship/` path. Serving Airship from an origin of its own is
 * the only thing that makes the path a boundary — see the README.
 */
export function checkCallerUrl(
  documentUrl: string | undefined,
  callers: readonly CallerOrigin[],
): SenderCheck {
  if (typeof documentUrl !== "string" || documentUrl.length === 0) {
    return Object.freeze({ ok: false, reason: "The sender reported no frame URL." });
  }
  let url: URL;
  try {
    url = new URL(documentUrl);
  } catch {
    return Object.freeze({ ok: false, reason: "The sender frame URL is unparseable." });
  }
  const caller = callers.find(
    (candidate) => url.origin === candidate.origin && url.pathname.startsWith(candidate.pathPrefix),
  );
  if (!caller) {
    return Object.freeze({ ok: false, reason: `${url.origin}${url.pathname} is not an Airship page.` });
  }
  return Object.freeze({ ok: true, origin: caller.origin });
}

/**
 * Re-check the caller in the background worker.
 *
 * The content-script registration decides where the code is injected; this
 * decides who the worker will answer. The frame URL, the reported origin where
 * the browser supplies one, and the frame id must all agree on an allowlisted
 * top-level Airship document, so an allowlisted page cannot be framed into
 * lending its bridge access to another document.
 *
 * A sender with no `frameId` is refused rather than accepted. A browser that
 * does not report one has told the worker nothing about which frame is talking,
 * and treating silence as "top frame" would quietly reduce this check to the
 * content script's own `window.top === window` guard — one defence where the
 * design calls for two.
 */
export function checkSender(
  sender: SenderLike | undefined,
  callers: readonly CallerOrigin[],
): SenderCheck {
  if (!sender) {
    return Object.freeze({ ok: false, reason: "The sender reported no frame URL." });
  }
  if (sender.frameId !== 0) {
    return Object.freeze({
      ok: false,
      reason: typeof sender.frameId === "number"
        ? "Only the top frame may use the bridge."
        : "The browser did not identify the sender's frame, so it cannot be shown to be the top frame.",
    });
  }
  const caller = checkCallerUrl(sender.url, callers);
  if (!caller.ok) return caller;
  if (typeof sender.origin === "string" && sender.origin !== caller.origin) {
    return Object.freeze({ ok: false, reason: "The sender origin and frame URL disagree." });
  }
  return caller;
}

export type UserAgentOverrideState = "live" | "unavailable";

/**
 * Firefox treats MV3 `host_permissions` as opt-in: an installed extension has
 * no host access until the user grants it. `unknown` means the browser gave
 * the worker no way to ask, which is distinct from having asked and been told
 * no.
 */
export type HostAccessState = "granted" | "missing" | "unknown";

export type BridgeRuntimeCapabilities = Readonly<{
  userAgentOverride: UserAgentOverrideState;
  hostAccess: HostAccessState;
}>;

export type ProviderAvailability = Readonly<{
  providers: readonly BridgeProvider[];
  unavailable: readonly Readonly<{ provider: BridgeProvider; reason: string }>[];
}>;

/**
 * What `hello` may claim, from what the worker actually observed.
 *
 * Anthropic's OAuth hosts reject a browser `User-Agent`, so without a live
 * rewrite mechanism the extension cannot carry an Anthropic connection at all
 * and says so, rather than letting the page advertise a provider that will
 * fail at the token exchange.
 */
export function describeProviderAvailability(
  capabilities: BridgeRuntimeCapabilities,
  destinations: readonly BridgeDestination[] = BRIDGE_DESTINATIONS,
): ProviderAvailability {
  const providers: BridgeProvider[] = [];
  const unavailable: Readonly<{ provider: BridgeProvider; reason: string }>[] = [];
  for (const provider of BRIDGE_PROVIDERS) {
    const owned = destinations.filter((destination) => destination.provider === provider);
    if (owned.length === 0) continue;
    if (capabilities.hostAccess === "missing") {
      unavailable.push(Object.freeze({
        provider,
        reason: "The extension is installed but has not been granted access to the provider hosts.",
      }));
      continue;
    }
    const blocked = owned.some(destinationRequiresUserAgentOverride)
      && capabilities.userAgentOverride !== "live";
    if (blocked) {
      unavailable.push(Object.freeze({
        provider,
        reason: "This browser gives the extension no way to set User-Agent, and the provider's"
          + " OAuth host rejects browser user agents.",
      }));
      continue;
    }
    providers.push(provider);
  }
  return Object.freeze({
    providers: Object.freeze(providers),
    unavailable: Object.freeze(unavailable),
  });
}
