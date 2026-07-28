/**
 * The page <-> bridge wire format.
 *
 * docs/EXTENSION_BRIDGE.md fixes the request envelope and the
 * `chunk`/`end`/`error` terminator rule but leaves the reply fields open. The
 * page side (src/inference/bridge/protocol.ts) states them exactly, and this
 * file matches that statement, because two independently invented reply shapes
 * would simply not connect. The additions over the prose contract are:
 *
 * - `from: "page" | "extension"`. `window.postMessage` delivers a page's own
 *   message back to the page, so without a direction marker a `hello` request
 *   and a `hello` reply are indistinguishable.
 * - `head` before any `chunk`, carrying status and headers, so the page can
 *   construct a `Response` before the body arrives.
 * - `chunk.data` is base64 of the body bytes, and `chunk.seq` starts at 1.
 *   Bytes rather than text means a chunk boundary can never split a UTF-8
 *   sequence.
 * - `end.seq` restates the chunk count, so a dropped chunk is detectable.
 * - `kind: "cancel"` from the page, which aborts the exchange.
 *
 * Nothing from the page is ever spread into a request. Every field is read,
 * checked and copied onto a freshly built object, so an unknown key can add
 * nothing to what the worker does.
 */

import {
  BRIDGE_LIMITS,
  BRIDGE_METHODS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_PROVIDERS,
  type BridgeLimits,
  type BridgeMethod,
  type BridgeProvider,
  type ProviderAvailability,
} from "./policy";

export type BridgeErrorCode =
  | "malformed-request"
  | "duplicate-request-id"
  | "too-many-requests"
  | "destination-refused"
  | "header-refused"
  | "user-agent-refused"
  | "request-too-large"
  | "response-too-large"
  | "too-many-chunks"
  | "redirect-refused"
  | "status-refused"
  | "deadline-exceeded"
  | "user-agent-override-unavailable"
  | "host-access-missing"
  | "network-error"
  | "bridge-disconnected"
  // A relay path that released its reservation without answering. Unreachable
  // by construction; it exists so that if one ever becomes reachable the page
  // is told, rather than left waiting on a terminator that will not arrive.
  | "internal-error";

export type BridgeHelloRequest = Readonly<{ kind: "hello"; id: string }>;
export type BridgeCancelRequest = Readonly<{ kind: "cancel"; id: string }>;

export type BridgeFetchRequest = Readonly<{
  kind: "fetch";
  id: string;
  provider: BridgeProvider;
  path: string;
  method: BridgeMethod;
  headers: Readonly<Record<string, string>>;
  body?: string;
  stream: boolean;
}>;

export type BridgeRequest = BridgeHelloRequest | BridgeCancelRequest | BridgeFetchRequest;

type ReplyBase = Readonly<{ airshipBridge: 1; from: "extension"; id: string }>;

export type BridgeHelloReply = ReplyBase & Readonly<{
  kind: "hello";
  version: string;
  providers: readonly BridgeProvider[];
  /** Named causes for every provider missing from `providers`. */
  unavailable: readonly Readonly<{ provider: BridgeProvider; reason: string }>[];
}>;

export type BridgeHeadReply = ReplyBase & Readonly<{
  kind: "head";
  status: number;
  headers: Readonly<Record<string, string>>;
}>;

export type BridgeChunkReply = ReplyBase & Readonly<{
  kind: "chunk";
  /** 1-based, contiguous. */
  seq: number;
  /** base64 of the body bytes. */
  data: string;
}>;

export type BridgeEndReply = ReplyBase & Readonly<{ kind: "end"; seq: number }>;

export type BridgeErrorReply = ReplyBase & Readonly<{ kind: "error"; reason: string }>;

export type BridgeReply =
  | BridgeHelloReply
  | BridgeHeadReply
  | BridgeChunkReply
  | BridgeEndReply
  | BridgeErrorReply;

export type ParsedRequest =
  | Readonly<{ ok: true; request: BridgeRequest }>
  | Readonly<{ ok: false; id: string; code: BridgeErrorCode; message: string }>;

const REQUEST_ID = /^[A-Za-z0-9._:-]+$/u;
const MAX_REASON_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function refuse(id: string, code: BridgeErrorCode, message: string): ParsedRequest {
  return Object.freeze({ ok: false, id, code, message });
}

/**
 * Parse an untrusted page message into a request the worker may act on.
 *
 * Unknown keys are ignored rather than refused — the envelope is version
 * tagged, every consumed field is validated here, and the request the worker
 * executes is rebuilt from scratch — but their *number* is bounded so a page
 * cannot make the worker walk an unbounded object.
 */
export function parseBridgeRequest(
  raw: unknown,
  limits: BridgeLimits = BRIDGE_LIMITS,
): ParsedRequest {
  if (!isRecord(raw)) return refuse("", "malformed-request", "The bridge message is not an object.");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (raw.airshipBridge !== BRIDGE_PROTOCOL_VERSION) {
    return refuse(id, "malformed-request", "Unsupported bridge protocol version.");
  }
  if (Object.keys(raw).length > limits.maxEnvelopeKeys) {
    return refuse(id, "malformed-request", "The bridge message carries too many fields.");
  }
  // A reply is never a request, whatever else it looks like.
  if (raw.from !== undefined && raw.from !== "page") {
    return refuse(id, "malformed-request", "Only a page may send a bridge request.");
  }
  if (!id || id.length > limits.maxRequestIdLength || !REQUEST_ID.test(id)) {
    return refuse("", "malformed-request", "The bridge message has no usable request id.");
  }
  if (raw.kind === "hello") return Object.freeze({ ok: true, request: Object.freeze({ kind: "hello", id }) });
  if (raw.kind === "cancel") return Object.freeze({ ok: true, request: Object.freeze({ kind: "cancel", id }) });
  if (raw.kind !== "fetch") return refuse(id, "malformed-request", "Unsupported bridge request kind.");

  const provider = raw.provider;
  if (typeof provider !== "string" || !BRIDGE_PROVIDERS.includes(provider as BridgeProvider)) {
    return refuse(id, "malformed-request", "A fetch request must name a supported provider.");
  }
  if (typeof raw.path !== "string") {
    return refuse(id, "malformed-request", "A fetch request must carry a destination URL.");
  }
  const method = raw.method === undefined ? "GET" : raw.method;
  if (typeof method !== "string" || !BRIDGE_METHODS.includes(method as BridgeMethod)) {
    return refuse(id, "malformed-request", "Only GET and POST are relayed.");
  }
  if (raw.headers !== undefined && !isRecord(raw.headers)) {
    return refuse(id, "malformed-request", "Request headers must be an object.");
  }
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") {
    return refuse(id, "malformed-request", "The stream flag must be a boolean.");
  }
  let body: string | undefined;
  if (raw.body !== undefined) {
    if (typeof raw.body !== "string") {
      return refuse(id, "malformed-request", "A request body must be a string.");
    }
    if (method !== "POST") {
      return refuse(id, "malformed-request", "Only POST requests may carry a body.");
    }
    // A UTF-8 code unit is at least one byte, so the cheap length check bounds
    // the work before the exact byte count allocates anything.
    if (raw.body.length > limits.maxRequestBodyBytes
      || new TextEncoder().encode(raw.body).byteLength > limits.maxRequestBodyBytes) {
      return refuse(
        id,
        "request-too-large",
        `A request body may not exceed ${limits.maxRequestBodyBytes} bytes.`,
      );
    }
    body = raw.body;
  }

  // The header cap is applied here, before anything walks the object, rather
  // than left to `selectRequestHeaders`: counting with an early exit means an
  // absurdly large header object costs the cap and not its own size.
  const rawHeaders = raw.headers ?? {};
  const headers: Record<string, string> = {};
  let count = 0;
  for (const name in rawHeaders) {
    if (!Object.prototype.hasOwnProperty.call(rawHeaders, name)) continue;
    count += 1;
    if (count > limits.maxHeaderEntries) {
      return refuse(
        id,
        "malformed-request",
        `A request may carry at most ${limits.maxHeaderEntries} headers.`,
      );
    }
    const value = (rawHeaders as Record<string, unknown>)[name];
    if (typeof value !== "string") {
      return refuse(id, "malformed-request", `Header ${name} must be a string.`);
    }
    headers[name] = value;
  }

  const request: BridgeFetchRequest = Object.freeze({
    kind: "fetch",
    id,
    provider: provider as BridgeProvider,
    path: raw.path,
    method: method as BridgeMethod,
    headers: Object.freeze(headers),
    ...(body === undefined ? {} : { body }),
    stream: raw.stream === true,
  });
  return Object.freeze({ ok: true, request });
}

function reply<T extends Readonly<Record<string, unknown>>>(id: string, fields: T): ReplyBase & T {
  return Object.freeze({
    airshipBridge: BRIDGE_PROTOCOL_VERSION,
    from: "extension" as const,
    id,
    ...fields,
  });
}

export function helloReply(
  id: string,
  availability: ProviderAvailability,
  version: string,
): BridgeHelloReply {
  return reply(id, {
    kind: "hello" as const,
    version,
    providers: availability.providers,
    unavailable: availability.unavailable,
  });
}

export function headReply(
  id: string,
  status: number,
  headers: Readonly<Record<string, string>>,
): BridgeHeadReply {
  return reply(id, { kind: "head" as const, status, headers });
}

export function chunkReply(id: string, seq: number, data: string): BridgeChunkReply {
  return reply(id, { kind: "chunk" as const, seq, data });
}

export function endReply(id: string, seq: number): BridgeEndReply {
  return reply(id, { kind: "end" as const, seq });
}

/**
 * The failure code travels inside `reason` because the page's reply parser
 * carries one free-text field. Keeping the code first means a user-visible
 * message still names which boundary refused, not just that one did.
 */
export function errorReply(id: string, code: BridgeErrorCode, message: string): BridgeErrorReply {
  const reason = `${code}: ${message}`
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .slice(0, MAX_REASON_LENGTH);
  return reply(id, { kind: "error" as const, reason });
}

/** A message the content script is willing to hand back to the page. */
export function isBridgeReply(value: unknown): value is BridgeReply {
  if (!isRecord(value)) return false;
  if (value.airshipBridge !== BRIDGE_PROTOCOL_VERSION) return false;
  if (value.from !== "extension") return false;
  if (typeof value.id !== "string") return false;
  return value.kind === "hello"
    || value.kind === "head"
    || value.kind === "chunk"
    || value.kind === "end"
    || value.kind === "error";
}

/** `hello`, `end` and `error` settle an exchange; `head` and `chunk` do not. */
export function isTerminalReply(value: BridgeReply): boolean {
  return value.kind === "hello" || value.kind === "end" || value.kind === "error";
}
