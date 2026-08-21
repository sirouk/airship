/**
 * Wire contract for the Airship browser-extension bridge
 * (docs/EXTENSION_BRIDGE.md), stated once so the page enforces it
 * independently of whatever the extension happens to enforce.
 *
 * The extension is untrusted input. So is every other script on this origin:
 * the relay is `window.postMessage`, which any same-origin script can also
 * post. Nothing here can restore isolation JavaScript does not have, so the
 * boundary is instead: an unguessable per-request id, a single-use correlation
 * table, an exact protocol version, ordered sequence numbers, and exactly one
 * terminator. Anything else is unsolicited and is dropped without effect.
 */
import { isRecord } from "../../core/records";

export const BRIDGE_PROTOCOL_VERSION = 1;

export type BridgeProviderId = "xai" | "anthropic";

export const BRIDGE_PROVIDER_IDS: readonly BridgeProviderId[] = Object.freeze([
  "anthropic",
  "xai",
]);

/**
 * The compiled-in destination allowlist from the contract, split by the
 * provider that may name it. The extension enforces its own copy; the page
 * refuses to *send* anything outside it so a caller bug can never become a
 * request the extension has to refuse.
 *
 * Prefixes are matched against a normalized URL, never the raw string — see
 * `isBridgeDestination`. A raw prefix test would accept
 * `https://api.anthropic.com/v1/../../evil`, which the extension then refuses;
 * that would make the extension's check load-bearing instead of redundant, and
 * the sentence above would be false.
 */
export const BRIDGE_DESTINATIONS: Readonly<Record<BridgeProviderId, readonly string[]>> =
  Object.freeze({
    xai: Object.freeze(["https://auth.x.ai/oauth2/", "https://api.x.ai/v1/"]),
    anthropic: Object.freeze([
      "https://claude.ai/oauth/",
      "https://platform.claude.com/v1/oauth/",
      "https://api.anthropic.com/v1/",
    ]),
  });

/** Header allowlist from the contract. Unknown headers are refused, not dropped. */
export const BRIDGE_HEADER_ALLOWLIST: readonly string[] = Object.freeze([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "authorization",
  "content-type",
  "user-agent",
  "x-app",
]);

/**
 * Anthropic's OAuth *inference* path is only served to the Claude Code CLI
 * fingerprint: a `user-agent` starting `claude-code/` plus `x-app: cli`.
 * `User-Agent` is a forbidden header name in JavaScript, so this set is
 * reachable only through the bridge — it is the reason Anthropic OAuth
 * inference is `unavailable` without the extension rather than merely slower.
 *
 * The version segment is Airship's own; the requirement measured by the lead is
 * the `claude-code/` prefix, and Airship must not impersonate a build number it
 * is not. No Anthropic OAuth token exists in this repository, so this header set
 * has never been observed completing a request from here: it is the documented
 * fingerprint, not an observation.
 */
export const ANTHROPIC_OAUTH_INFERENCE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "user-agent": "claude-code/1.0.0",
  "x-app": "cli",
  "anthropic-beta": "oauth-2025-04-20",
});

export type BridgeLimits = Readonly<{
  /** No reply inside this window means no extension. */
  helloTimeoutMs: number;
  /**
   * First byte: how long an extension that accepted a `fetch` may say nothing
   * at all. Separate from `requestTimeoutMs` because a long *answer* is normal
   * and a long *silence* is not.
   */
  headTimeoutMs: number;
  /** Wall clock for one bridged exchange, head through terminator. */
  requestTimeoutMs: number;
  maxRequestBodyBytes: number;
  maxResponseBytes: number;
  maxChunkBytes: number;
  maxConcurrentRequests: number;
  maxHeaderCount: number;
  maxHeaderValueChars: number;
  maxUrlChars: number;
  /** How long a presence observation may gate a request before re-probing. */
  presenceTtlMs: number;
}>;

/**
 * Page-side ceilings. They are deliberately the page's own numbers rather than
 * anything the extension advertises: an extension that raised its limits must
 * not be able to raise Airship's.
 */
export const BRIDGE_LIMITS: BridgeLimits = Object.freeze({
  helloTimeoutMs: 1_500,
  // Generous enough for a cold provider working through a long prompt before
  // the first token, and still twentyfold tighter than holding the exchange for
  // the whole `requestTimeoutMs` on an extension that answered nothing.
  headTimeoutMs: 60_000,
  requestTimeoutMs: 300_000,
  maxRequestBodyBytes: 4 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxChunkBytes: 1 * 1024 * 1024,
  maxConcurrentRequests: 8,
  maxHeaderCount: 16,
  maxHeaderValueChars: 8 * 1024,
  maxUrlChars: 2_048,
  presenceTtlMs: 30_000,
});

export type BridgeRequestMethod = "GET" | "POST";

/**
 * Outbound envelope. `from` is not in the prose contract but is mandatory:
 * `window.postMessage` delivers a page's own messages back to the page, so
 * without a direction marker Airship's `hello` request is indistinguishable
 * from an extension's `hello` reply and the handshake cannot be implemented.
 */
export type BridgeRequestMessage = Readonly<{
  airshipBridge: 1;
  from: "page";
  id: string;
  kind: "hello" | "fetch" | "cancel";
  provider?: BridgeProviderId;
  path?: string;
  method?: BridgeRequestMethod;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  stream?: boolean;
}>;

/** A provider the extension names as one it will not carry, and why. */
export type BridgeProviderUnavailability = Readonly<{
  provider: BridgeProviderId;
  reason: string;
}>;

export type BridgeHelloReply = Readonly<{
  airshipBridge: 1;
  from: "extension";
  id: string;
  kind: "hello";
  version: string;
  providers: readonly BridgeProviderId[];
  /**
   * Optional in the wire contract, carried through when present: it is the only
   * way an installed-but-limited extension can name its own cause, and a page
   * that dropped it would have to invent one.
   */
  unavailable: readonly BridgeProviderUnavailability[];
}>;

export type BridgeHeadReply = Readonly<{
  airshipBridge: 1;
  from: "extension";
  id: string;
  kind: "head";
  status: number;
  headers: Readonly<Record<string, string>>;
}>;

/** Body bytes, base64, so a chunk boundary can never split a UTF-8 sequence. */
export type BridgeChunkReply = Readonly<{
  airshipBridge: 1;
  from: "extension";
  id: string;
  kind: "chunk";
  seq: number;
  data: string;
}>;

/** `seq` is the total chunk count, so a dropped chunk is a detectable truncation. */
export type BridgeEndReply = Readonly<{
  airshipBridge: 1;
  from: "extension";
  id: string;
  kind: "end";
  seq: number;
}>;

export type BridgeErrorReply = Readonly<{
  airshipBridge: 1;
  from: "extension";
  id: string;
  kind: "error";
  reason: string;
}>;

export type BridgeReply =
  | BridgeHelloReply
  | BridgeHeadReply
  | BridgeChunkReply
  | BridgeEndReply
  | BridgeErrorReply;

export type ExtensionBridgeErrorCode =
  /** No extension answered, or it will not carry this provider. */
  | "bridge-unavailable"
  /** The page's own allowlist refused to send this exchange. */
  | "bridge-refused"
  /** The extension answered `error`: it tried and could not complete. */
  | "bridge-error"
  | "bridge-protocol"
  | "bridge-too-large"
  | "bridge-busy"
  | "bridge-timeout"
  | "bridge-cancelled";

export class ExtensionBridgeError extends Error {
  constructor(
    readonly code: ExtensionBridgeErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ExtensionBridgeError";
  }
}

/**
 * One live handshake outcome. `silent` is the fail-closed answer — no reply
 * inside the deadline is "no extension", never "probably present".
 * `unsupported` is the separate case where no handshake could even be sent
 * (no page window to relay through), which must not be reported as a failure
 * of an extension that was never asked.
 */
export type BridgeHandshakeResult = Readonly<
  | {
      kind: "answered";
      version: string;
      providers: readonly BridgeProviderId[];
      /** Causes the extension named for providers missing from `providers`. */
      unavailable: readonly BridgeProviderUnavailability[];
      elapsedMs: number;
    }
  | { kind: "silent"; deadlineMs: number }
  | { kind: "unsupported"; detail: string }
  | { kind: "malformed"; detail: string }
>;

/**
 * Recover only the correlation id of a message that could be an extension
 * reply. A message that fails this is not addressed to any pending exchange and
 * is dropped in silence; a message that passes it is then parsed strictly, and
 * failing *that* fails the exchange closed.
 */
export function bridgeReplyId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.airshipBridge !== BRIDGE_PROTOCOL_VERSION) return undefined;
  if (value.from !== "extension") return undefined;
  return boundedToken(value.id, 128);
}

/** Strict inbound parse. `undefined` means malformed, which callers fail closed on. */
export function parseBridgeReply(value: unknown): BridgeReply | undefined {
  const id = bridgeReplyId(value);
  if (!id || !isRecord(value)) return undefined;
  const base = { airshipBridge: 1 as const, from: "extension" as const, id };
  switch (value.kind) {
    case "hello": {
      const version = boundedText(value.version, 64);
      const providers = parseProviders(value.providers);
      const unavailable = parseUnavailable(value.unavailable);
      if (!version || !providers || !unavailable) return undefined;
      return Object.freeze({ ...base, kind: "hello" as const, version, providers, unavailable });
    }
    case "head": {
      const status = value.status;
      if (!Number.isSafeInteger(status) || (status as number) < 200 || (status as number) > 599) {
        return undefined;
      }
      const headers = parseReplyHeaders(value.headers);
      if (!headers) return undefined;
      return Object.freeze({ ...base, kind: "head" as const, status: status as number, headers });
    }
    case "chunk": {
      const seq = sequence(value.seq);
      const data = value.data;
      if (seq === undefined || typeof data !== "string") return undefined;
      // Validated before decoding: atob throws on anything else, and a throw
      // here would be reported as a client defect rather than a bad message.
      if (data.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return undefined;
      return Object.freeze({ ...base, kind: "chunk" as const, seq, data });
    }
    case "end": {
      const seq = value.seq === 0 ? 0 : sequence(value.seq);
      if (seq === undefined) return undefined;
      return Object.freeze({ ...base, kind: "end" as const, seq });
    }
    case "error": {
      const reason = boundedText(value.reason, 512);
      if (!reason) return undefined;
      return Object.freeze({ ...base, kind: "error" as const, reason });
    }
    default:
      return undefined;
  }
}

/**
 * Characters an allowlisted destination *path* may contain, mirroring
 * `DESTINATION_PATH` in extension/src/policy.ts.
 *
 * `new URL` resolves `.` and `..` segments, so a literal traversal cannot walk
 * out of the prefix compared below. What it does not resolve is an escape the
 * origin server decodes itself: `%2f`/`%5c` decode to separators, `%25` is one
 * decode away from spelling either, and a `;` path parameter is stripped by
 * routers that then route on what is left. All five destinations are plain
 * ASCII API paths, so the boundary is drawn positively rather than as a list of
 * known-bad shapes.
 *
 * The query is deliberately not covered: it cannot move a request off the path
 * prefix, and an OAuth `redirect_uri` carries `%2F` by construction.
 */
const BRIDGE_DESTINATION_PATH = /^[A-Za-z0-9\-._~/]*$/u;

/**
 * The page's own copy of the destination allowlist. A URL is accepted only when
 * the provider that named it is allowed to reach it, so an xAI credential can
 * never be sent to an Anthropic host even though both are allowlisted.
 *
 * The comparison is made against `URL.href`, which folds scheme case, host
 * case, the default port and `.`/`..` segments into one canonical string. A
 * prefix test on the caller's own bytes would let `…/v1/../../evil` sit inside
 * an approved prefix and land on `/evil`. These are the same rules the
 * extension applies, restated here so the page's own refusal never depends on
 * the extension having made the stricter check — the page must be able to say
 * truthfully that it never sends a request the extension has to refuse.
 */
export function isBridgeDestination(provider: BridgeProviderId, url: string): boolean {
  if (typeof url !== "string" || url.length > BRIDGE_LIMITS.maxUrlChars) return false;
  if (/[\u0000-\u0020\u007f]/u.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  // Embedded credentials would be sent to the host, and a fragment is never
  // transmitted — either one means the caller built a URL it did not intend.
  if (parsed.username || parsed.password || parsed.hash) return false;
  if (!BRIDGE_DESTINATION_PATH.test(parsed.pathname)) return false;
  return BRIDGE_DESTINATIONS[provider].some((prefix) => parsed.href.startsWith(prefix));
}

/**
 * Normalize outbound headers, refusing anything the contract's allowlist does
 * not carry. Dropping silently would let a caller believe a header was sent.
 */
export function bridgeRequestHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(headers);
  if (entries.length > BRIDGE_LIMITS.maxHeaderCount) {
    throw new ExtensionBridgeError(
      "bridge-protocol",
      "A bridged request declares more headers than the client allows.",
    );
  }
  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!BRIDGE_HEADER_ALLOWLIST.includes(name)) {
      throw new ExtensionBridgeError(
        "bridge-protocol",
        `The extension bridge does not carry the ${name} header.`,
      );
    }
    if (
      typeof rawValue !== "string"
      || rawValue.length > BRIDGE_LIMITS.maxHeaderValueChars
      || /[\u0000-\u001f\u007f]/u.test(rawValue)
    ) {
      throw new ExtensionBridgeError(
        "bridge-protocol",
        `The ${name} header value is not a valid bridged header.`,
      );
    }
    normalized[name] = rawValue;
  }
  return Object.freeze(normalized);
}

function parseProviders(value: unknown): readonly BridgeProviderId[] | undefined {
  if (!Array.isArray(value) || value.length > BRIDGE_PROVIDER_IDS.length) return undefined;
  const providers: BridgeProviderId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !BRIDGE_PROVIDER_IDS.includes(entry as BridgeProviderId)) {
      return undefined;
    }
    if (!providers.includes(entry as BridgeProviderId)) providers.push(entry as BridgeProviderId);
  }
  return Object.freeze(providers);
}

/**
 * Absent means "the extension said nothing about this", which is an empty list.
 * Present but malformed is a protocol violation and rejects the whole reply:
 * a half-read cause list would let a bad entry disappear silently.
 */
function parseUnavailable(value: unknown): readonly BridgeProviderUnavailability[] | undefined {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > BRIDGE_PROVIDER_IDS.length) return undefined;
  const entries: BridgeProviderUnavailability[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const provider = typeof entry.provider === "string"
      && BRIDGE_PROVIDER_IDS.includes(entry.provider as BridgeProviderId)
      ? entry.provider as BridgeProviderId
      : undefined;
    const reason = boundedText(entry.reason, 512);
    if (!provider || !reason) return undefined;
    entries.push(Object.freeze({ provider, reason }));
  }
  return Object.freeze(entries);
}

function parseReplyHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 64) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(name.toLowerCase())) return undefined;
    if (
      typeof headerValue !== "string"
      || headerValue.length > BRIDGE_LIMITS.maxHeaderValueChars
      || /[\u0000-\u001f\u007f]/u.test(headerValue)
    ) {
      return undefined;
    }
    headers[name.toLowerCase()] = headerValue;
  }
  return Object.freeze(headers);
}

function sequence(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000
    ? value as number
    : undefined;
}

function boundedToken(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && /^[A-Za-z0-9._:-]+$/u.test(value)
    ? value
    : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return clean ? clean.slice(0, maximum) : undefined;
}

