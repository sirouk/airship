/**
 * The bridge relay: one state machine per connected Airship page.
 *
 * Everything the worker needs from the platform — `fetch`, the clock, the
 * outbound channel, the observed runtime capabilities — is injected, so the
 * whole boundary is exercised in plain vitest without a browser. The background
 * entry does nothing but supply the real implementations.
 *
 * Every exchange emits exactly one `head` followed by zero or more `chunk`
 * messages and exactly one terminator (`end` or `error`), or an `error` alone
 * if it never got as far as a response.
 */

import {
  BRIDGE_DESTINATIONS,
  BRIDGE_LIMITS,
  EXTENSION_VERSION,
  type BridgeDestination,
  type BridgeLimits,
  type BridgeMethod,
  type BridgeRuntimeCapabilities,
  type HeaderReader,
  describeProviderAvailability,
  destinationRequiresUserAgentOverride,
  resolveDestination,
  selectRequestHeaders,
  selectResponseHeaders,
} from "./policy";
import {
  type BridgeErrorCode,
  type BridgeFetchRequest,
  type BridgeHelloRequest,
  type BridgeReply,
  chunkReply,
  endReply,
  errorReply,
  headReply,
  helloReply,
  parseBridgeRequest,
} from "./protocol";

/** Exactly the request fields the relay is allowed to set. */
export type RelayRequestInit = Readonly<{
  method: BridgeMethod;
  headers: Readonly<Record<string, string>>;
  body?: string;
  // Without `omit` the extension would ride the user's logged-in claude.ai
  // cookies; the bridge carries only credentials the page supplied.
  credentials: "omit";
  cache: "no-store";
  mode: "cors";
  // The allowlist is checked before the request, so a redirect is a
  // destination the allowlist never saw. The relay refuses instead of
  // following, on any origin.
  redirect: "manual";
  referrerPolicy: "no-referrer";
  keepalive: false;
  signal: AbortSignal;
}>;

export type RelayResponse = Readonly<{
  status: number;
  ok: boolean;
  type?: string;
  redirected?: boolean;
  headers: HeaderReader;
  body: ReadableStream<Uint8Array> | null;
}>;

export type RelayFetch = (url: string, init: RelayRequestInit) => Promise<RelayResponse>;

export type BridgeClock = Readonly<{
  now(): number;
  /** Schedule `fn` and return its canceller. */
  setTimer(delayMs: number, fn: () => void): () => void;
}>;

export type BridgeRelayOptions = Readonly<{
  fetchImpl: RelayFetch;
  clock: BridgeClock;
  send: (message: BridgeReply) => void;
  /** Observed, never assumed: what this browser actually let the worker install. */
  resolveCapabilities: () => Promise<BridgeRuntimeCapabilities>;
  limits?: BridgeLimits;
  destinations?: readonly BridgeDestination[];
  version?: string;
}>;

export type BridgeRelay = Readonly<{
  handle(raw: unknown): Promise<void>;
  /** Relayed exchanges currently holding a slot. Handshakes are not counted. */
  inflight(): number;
  dispose(): void;
}>;

/**
 * Which budget a reservation draws on.
 *
 * `hello` has a budget of its own rather than sharing the request cap. A page
 * cannot tell a refused handshake from an absent extension, so a `hello`
 * rejected because four inference calls happened to be in flight would make a
 * present bridge report itself missing — the one claim this package exists to
 * get right.
 */
type ReservationKind = "hello" | "fetch";

type Inflight = {
  readonly kind: ReservationKind;
  readonly controller: AbortController;
  terminated: boolean;
  cancelDeadline: () => void;
  cancelIdle: () => void;
};

/** Reported alongside the response headers so a dropped header is never silent. */
export const DROPPED_HEADER_NOTICE = "x-airship-bridge-dropped";
export const USER_AGENT_NOTICE = "x-airship-bridge-user-agent";

export function createBridgeRelay(options: BridgeRelayOptions): BridgeRelay {
  const limits = options.limits ?? BRIDGE_LIMITS;
  const destinations = options.destinations ?? BRIDGE_DESTINATIONS;
  const version = options.version ?? EXTENSION_VERSION;
  const inflight = new Map<string, Inflight>();
  let disposed = false;

  function emit(message: BridgeReply): void {
    if (disposed) return;
    options.send(message);
  }

  /** Send the one terminal message a request is allowed, and release it. */
  function terminate(id: string, entry: Inflight, message: BridgeReply | undefined): void {
    if (entry.terminated) return;
    entry.terminated = true;
    entry.cancelDeadline();
    entry.cancelIdle();
    inflight.delete(id);
    if (message) emit(message);
  }

  function fail(id: string, entry: Inflight, code: BridgeErrorCode, message: string): void {
    terminate(id, entry, errorReply(id, code, message));
    entry.controller.abort();
  }

  /**
   * How many reservations of one kind are open.
   *
   * Derived from the map rather than kept in a parallel counter: the map is
   * bounded by the two caps, so the scan is a handful of entries, and a count
   * that is derived cannot drift out of step with the thing it counts.
   */
  function reserved(kind: ReservationKind): number {
    let count = 0;
    for (const entry of inflight.values()) {
      if (entry.kind === kind) count += 1;
    }
    return count;
  }

  /** Report only the observed availability; the handshake takes no network. */
  async function runHello(request: BridgeHelloRequest, entry: Inflight): Promise<void> {
    const availability = describeProviderAvailability(await options.resolveCapabilities(), destinations);
    if (entry.terminated) return;
    terminate(request.id, entry, helloReply(request.id, availability, version));
  }

  async function runFetch(request: BridgeFetchRequest, entry: Inflight): Promise<void> {
    const destination = resolveDestination(request.provider, request.path, limits, destinations);
    if (!destination.ok) {
      fail(request.id, entry, "destination-refused", destination.message);
      return;
    }
    const capabilities = await options.resolveCapabilities();
    if (entry.terminated) return;
    if (capabilities.hostAccess === "missing") {
      fail(
        request.id,
        entry,
        "host-access-missing",
        "The extension has not been granted access to the provider hosts.",
      );
      return;
    }
    const overrideNeeded = destinationRequiresUserAgentOverride(destination.destination);
    if (overrideNeeded && capabilities.userAgentOverride !== "live") {
      fail(
        request.id,
        entry,
        "user-agent-override-unavailable",
        `${destination.destination.prefix} requires a User-Agent this browser gives the extension`
        + " no way to set.",
      );
      return;
    }
    const headers = selectRequestHeaders(request.headers, limits);
    if (!headers.ok) {
      fail(request.id, entry, "header-refused", headers.message);
      return;
    }
    // The rewrite rule is bound to a URL prefix, so the agent on the wire is
    // this destination's compiled-in value. A caller that asked for a different
    // one is refused rather than sent a value it did not choose.
    if (headers.userAgent !== undefined && headers.userAgent !== destination.destination.userAgent) {
      fail(
        request.id,
        entry,
        "user-agent-refused",
        `This build sends ${destination.destination.userAgent ?? "the browser's own agent"} to`
        + ` ${destination.destination.prefix} and will not substitute ${headers.userAgent}.`,
      );
      return;
    }

    const init: RelayRequestInit = Object.freeze({
      method: request.method,
      headers: headers.forwarded,
      ...(request.body === undefined ? {} : { body: request.body }),
      credentials: "omit",
      cache: "no-store",
      mode: "cors",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      keepalive: false,
      signal: entry.controller.signal,
    });

    try {
      const response = await options.fetchImpl(destination.url, init);
      if (entry.terminated) return;
      if (isRedirect(response)) {
        fail(
          request.id,
          entry,
          "redirect-refused",
          `The destination answered with redirect status ${response.status}; the bridge never follows`
          + " redirects, because a redirect target is a destination the allowlist never approved.",
        );
        return;
      }
      // The page builds a Response from this status, which cannot be 0 or 6xx.
      if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 599) {
        fail(request.id, entry, "status-refused", `The destination answered with status ${response.status}.`);
        return;
      }
      const notices: Record<string, string> = {};
      if (headers.dropped.length > 0) notices[DROPPED_HEADER_NOTICE] = headers.dropped.join(", ");
      if (destination.destination.userAgent) {
        notices[USER_AGENT_NOTICE] = destination.destination.userAgent;
      }
      emit(headReply(request.id, response.status, Object.freeze({
        ...selectResponseHeaders(response.headers, limits),
        ...notices,
      })));
      const chunks = await streamBody(request, response, entry);
      if (entry.terminated) return;
      terminate(request.id, entry, endReply(request.id, chunks));
    } catch (error) {
      // A terminated request has already reported its own cause; the abort it
      // raised here must never overwrite that with a network error.
      if (entry.terminated) return;
      if (error instanceof RelayBoundError) {
        fail(request.id, entry, error.code, error.message);
        return;
      }
      fail(request.id, entry, "network-error", describeError(error));
    }
  }

  async function streamBody(
    request: BridgeFetchRequest,
    response: RelayResponse,
    entry: Inflight,
  ): Promise<number> {
    // A body-less status cannot carry one through the page's Response, so no
    // chunk is emitted for it at all.
    if (!response.body || BODY_LESS_STATUSES.has(response.status)) return 0;
    const ceiling = request.stream ? limits.maxStreamResponseBytes : limits.maxResponseBytes;
    const reader = response.body.getReader();
    let bytes = 0;
    let seq = 0;
    try {
      for (;;) {
        entry.cancelIdle();
        entry.cancelIdle = options.clock.setTimer(limits.streamIdleDeadlineMs, () => {
          fail(request.id, entry, "deadline-exceeded", `The response was idle for ${limits.streamIdleDeadlineMs}ms.`);
        });
        const { value, done } = await reader.read();
        if (entry.terminated) return seq;
        if (done) break;
        bytes += value.byteLength;
        if (bytes > ceiling) {
          throw new RelayBoundError(
            "response-too-large",
            `The response exceeded the ${ceiling}-byte ceiling.`,
          );
        }
        seq = emitChunks(request.id, value, seq, entry);
      }
      return seq;
    } finally {
      entry.cancelIdle();
      entry.cancelIdle = () => undefined;
      await reader.cancel().catch(() => undefined);
    }
  }

  function emitChunks(id: string, value: Uint8Array, seq: number, entry: Inflight): number {
    let next = seq;
    for (let offset = 0; offset < value.byteLength; offset += limits.maxChunkBytes) {
      if (next >= limits.maxChunks) {
        throw new RelayBoundError(
          "too-many-chunks",
          `A response may not exceed ${limits.maxChunks} chunks.`,
        );
      }
      if (entry.terminated) return next;
      next += 1;
      emit(chunkReply(id, next, base64(value.subarray(offset, offset + limits.maxChunkBytes))));
    }
    return next;
  }

  return Object.freeze({
    async handle(raw: unknown): Promise<void> {
      if (disposed) return;
      const parsed = parseBridgeRequest(raw, limits);
      if (!parsed.ok) {
        emit(errorReply(parsed.id, parsed.code, parsed.message));
        return;
      }
      const request = parsed.request;
      if (request.kind === "cancel") {
        // The page has stopped listening for this id, so cancellation is
        // silent: it releases the request rather than answering it.
        const entry = inflight.get(request.id);
        if (entry) {
          terminate(request.id, entry, undefined);
          entry.controller.abort();
        }
        return;
      }
      // Admission and reservation are one synchronous step, deliberately.
      //
      // `handle` is invoked once per inbound message and every branch below it
      // awaits — the capability observation alone is a real `permissions`
      // round trip on worker wake and at each capability-TTL boundary. A check
      // whose result is acted on *after* an await is not a check: the worker
      // would have admitted every message the page had already queued before
      // the first of them registered anything. Taking the id and the slot here,
      // before the first `await`, is what makes both bounds hold.
      if (inflight.has(request.id)) {
        // Reusing an in-flight id would let a second request steal the first
        // one's terminal message, so the newcomer is refused and the original
        // is left untouched.
        emit(errorReply(request.id, "duplicate-request-id", "That request id is already in flight."));
        return;
      }
      const cap = limits.maxConcurrentRequests;
      if (reserved(request.kind) >= cap) {
        emit(errorReply(
          request.id,
          "too-many-requests",
          request.kind === "hello"
            ? `At most ${cap} bridge handshakes may be in flight.`
            : `At most ${cap} bridge requests may be in flight.`,
        ));
        return;
      }
      const entry: Inflight = {
        kind: request.kind,
        controller: new AbortController(),
        terminated: false,
        cancelDeadline: () => undefined,
        cancelIdle: () => undefined,
      };
      inflight.set(request.id, entry);
      // The deadline is armed with the reservation, so it covers the capability
      // observation too: a probe that never settles would otherwise hold its
      // slot and its id for the life of the worker.
      const deadlineMs = request.kind === "fetch" && request.stream
        ? limits.streamDeadlineMs
        : limits.bufferedDeadlineMs;
      entry.cancelDeadline = options.clock.setTimer(deadlineMs, () => {
        fail(request.id, entry, "deadline-exceeded", `The request exceeded its ${deadlineMs}ms deadline.`);
      });
      try {
        if (request.kind === "hello") await runHello(request, entry);
        else await runFetch(request, entry);
      } catch (error) {
        // Nothing in here is expected to throw — `runFetch` reports its own
        // transport failures as `network-error`. An escape is a defect, and a
        // defect still owes the page an answer: the worker dispatches with
        // `void relay.handle(...)`, so a rejection nobody catches would leave
        // the request holding its slot and the page waiting for a terminator
        // that is never coming.
        fail(request.id, entry, "internal-error", describeError(error));
      } finally {
        // Unreachable today: every path above ends in `terminate` or in the
        // catch. It stands so that a future path which forgets cannot hold its
        // reservation for ever — and it answers rather than releasing silently,
        // because a silent release strands the page just as badly.
        if (!entry.terminated) {
          fail(request.id, entry, "internal-error", "The bridge released the request without answering it.");
        }
      }
    },
    inflight(): number {
      return reserved("fetch");
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [, entry] of inflight) {
        entry.terminated = true;
        entry.cancelDeadline();
        entry.cancelIdle();
        entry.controller.abort();
      }
      inflight.clear();
    },
  });
}

/** Statuses the page cannot attach a body to, so the relay must not send one. */
const BODY_LESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * A redirect is refused three ways: the filtered opaque response `redirect:
 * "manual"` produces, an implementation that followed one anyway, and a plain
 * 3xx status. Only one of these can be true in a conforming browser; the other
 * two exist so a non-conforming one cannot leave the allowlist quietly.
 */
export function isRedirect(response: RelayResponse): boolean {
  if (response.type === "opaqueredirect") return true;
  if (response.redirected === true) return true;
  return response.status >= 300 && response.status < 400 && response.status !== 304;
}

/**
 * Base64 without a data copy per byte. The page decodes with `atob`, so bytes
 * cross the boundary intact and a chunk edge can never split a UTF-8 sequence.
 */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  const window = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += window) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + window));
  }
  return btoa(binary);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200) || "The relayed request failed.";
}

export class RelayBoundError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "RelayBoundError";
    this.code = code;
  }
}
