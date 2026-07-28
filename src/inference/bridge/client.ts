import { randomUuid } from "../../core/id";
import {
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  ExtensionBridgeError,
  bridgeReplyId,
  bridgeRequestHeaders,
  isBridgeDestination,
  parseBridgeReply,
  type BridgeHandshakeResult,
  type BridgeLimits,
  type BridgeProviderId,
  type BridgeReply,
  type BridgeRequestMessage,
  type BridgeRequestMethod,
} from "./protocol";

export type BridgeMessageEventLike = Readonly<{
  data: unknown;
  origin: string;
  source: unknown;
}>;

/**
 * The page's side of the relay, injectable so the protocol state machine can be
 * tested without a DOM. `expectedOrigin` and `expectedSource` are the two
 * identity checks every inbound message must pass before it is even parsed.
 */
export type BridgeMessageChannel = Readonly<{
  postMessage(message: BridgeRequestMessage): void;
  addEventListener(listener: (event: BridgeMessageEventLike) => void): void;
  removeEventListener(listener: (event: BridgeMessageEventLike) => void): void;
  expectedOrigin: string;
  expectedSource: unknown;
}>;

export type BridgeFetchRequest = Readonly<{
  provider: BridgeProviderId;
  url: string;
  method: BridgeRequestMethod;
  headers: Readonly<Record<string, string>>;
  body?: string;
  /** Whether the caller will read the body as a stream; the reply shape is identical. */
  stream: boolean;
  signal: AbortSignal;
}>;

export type ExtensionBridgeClientOptions = Readonly<{
  limits?: Partial<BridgeLimits>;
  now?: () => number;
  newRequestId?: () => string;
}>;

type PendingExchange = Readonly<{
  accept: (reply: BridgeReply) => void;
  fail: (error: ExtensionBridgeError) => void;
}>;

/**
 * Page-side bridge client.
 *
 * Every inbound message is treated as hostile input: it must arrive from the
 * page's own origin and window, carry the exact protocol version, name a
 * request id this client generated and has not yet settled, and arrive in the
 * one order the protocol permits (`head`, ordered `chunk`s, exactly one `end`
 * or `error`). Anything else either fails its exchange closed or, when it
 * correlates to nothing, is dropped without effect.
 *
 * Request ids are UUIDv4 from Web Crypto. A same-origin script shares this
 * realm and can therefore always interfere with the page in worse ways than
 * forging a reply; the unguessable id is what stops a *blind* injection from
 * landing in a pending exchange.
 */
export class ExtensionBridgeClient {
  readonly #channel: BridgeMessageChannel;
  readonly #limits: BridgeLimits;
  readonly #now: () => number;
  readonly #newRequestId: () => string;
  readonly #pending = new Map<string, PendingExchange>();
  readonly #onMessage = (event: BridgeMessageEventLike): void => this.#receive(event);
  #listening = false;
  /** Only relayed fetches count against the ceiling; a handshake is not traffic. */
  #activeFetches = 0;
  #presence?: Readonly<{ observedAt: number; result: BridgeHandshakeResult }>;
  #handshakeInFlight?: Promise<BridgeHandshakeResult>;

  constructor(channel: BridgeMessageChannel, options: ExtensionBridgeClientOptions = {}) {
    this.#channel = channel;
    this.#limits = Object.freeze({ ...BRIDGE_LIMITS, ...options.limits });
    this.#now = options.now ?? Date.now;
    this.#newRequestId = options.newRequestId ?? randomUuid;
  }

  /** In-flight exchanges, for the concurrency ceiling and for tests. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * One live `hello` exchange. This never consults a memo and never reads a
   * user agent: no reply inside the deadline is reported as `silent`, which is
   * the honest "no extension", and callers must not turn it into anything else.
   */
  async handshake(signal?: AbortSignal): Promise<BridgeHandshakeResult> {
    if (signal?.aborted) {
      throw new ExtensionBridgeError(
        "bridge-cancelled",
        "The extension bridge handshake was cancelled before it was sent.",
        { cause: signal.reason },
      );
    }
    const id = this.#newRequestId();
    const startedAt = this.#now();
    const result = await new Promise<BridgeHandshakeResult>((resolve, reject) => {
      let settled = false;
      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#release(id);
        act();
      };
      const onAbort = (): void =>
        finish(() =>
          reject(new ExtensionBridgeError(
            "bridge-cancelled",
            "The extension bridge handshake was cancelled.",
            { cause: signal?.reason },
          )));
      const timer = setTimeout(
        () => finish(() => resolve(Object.freeze({
          kind: "silent" as const,
          deadlineMs: this.#limits.helloTimeoutMs,
        }))),
        this.#limits.helloTimeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#register(id, {
        accept: (reply) => finish(() => {
          if (reply.kind !== "hello") {
            resolve(Object.freeze({
              kind: "malformed" as const,
              detail: `A bridge reply of kind ${reply.kind} answered the handshake.`,
            }));
            return;
          }
          resolve(Object.freeze({
            kind: "answered" as const,
            version: reply.version,
            providers: reply.providers,
            unavailable: reply.unavailable,
            elapsedMs: Math.max(0, this.#now() - startedAt),
          }));
        }),
        fail: (error) => finish(() => resolve(Object.freeze({
          kind: "malformed" as const,
          detail: error.message,
        }))),
      });
      try {
        this.#post({ airshipBridge: BRIDGE_PROTOCOL_VERSION, from: "page", id, kind: "hello" });
      } catch (error) {
        finish(() => reject(error));
      }
    });
    this.#presence = Object.freeze({ observedAt: this.#now(), result });
    return result;
  }

  /**
   * Perform one bridged exchange and hand back a `Response` the ordinary
   * provider code can read, streaming or not.
   *
   * Ceilings here are the page's own and are enforced regardless of what the
   * extension does: destination allowlist, request body size, concurrency,
   * per-chunk and total response bytes, and a wall-clock deadline.
   */
  async fetch(request: BridgeFetchRequest): Promise<Response> {
    if (request.signal.aborted) throw cancellation(request.signal);
    if (!isBridgeDestination(request.provider, request.url)) {
      throw new ExtensionBridgeError(
        "bridge-refused",
        `The extension bridge does not carry ${request.provider} requests to this destination.`,
      );
    }
    const headers = bridgeRequestHeaders(request.headers);
    if (
      request.body !== undefined
      && new TextEncoder().encode(request.body).byteLength > this.#limits.maxRequestBodyBytes
    ) {
      throw new ExtensionBridgeError(
        "bridge-too-large",
        "The request body exceeds the extension bridge limit.",
      );
    }
    // The slot is claimed here, synchronously, before the first `await`. A
    // check that straddles an await is not a ceiling: every caller entering in
    // the same tick reads the same pre-increment count and all of them pass.
    if (this.#activeFetches >= this.#limits.maxConcurrentRequests) {
      throw new ExtensionBridgeError(
        "bridge-busy",
        "Too many extension bridge requests are already in flight.",
      );
    }
    this.#activeFetches += 1;
    let handedOff = false;
    try {
      const presence = await this.#observePresence();
      if (presence.kind !== "answered") {
        throw new ExtensionBridgeError("bridge-unavailable", absenceDetail(presence));
      }
      if (!presence.providers.includes(request.provider)) {
        // The extension's own reason if it gave one; this side never invents a
        // cause for a refusal it did not make.
        const named = presence.unavailable.find((entry) => entry.provider === request.provider);
        throw new ExtensionBridgeError(
          "bridge-unavailable",
          named
            ? `The installed Airship extension ${presence.version} does not carry ${request.provider}: ${named.reason}`
            : `The installed Airship extension ${presence.version} does not carry ${request.provider}.`,
        );
      }
      // Re-checked after the presence await: a caller can cancel while the
      // handshake is in flight, and an already-aborted signal never fires again.
      if (request.signal.aborted) throw cancellation(request.signal);
      handedOff = true;
      return this.#exchange(request, headers);
    } finally {
      // Every path that never reached `#exchange` has to give the slot back.
      // From `#exchange` onward its own `close()` owns the decrement, which is
      // why this is a flag rather than an unconditional release.
      if (!handedOff) this.#activeFetches = Math.max(0, this.#activeFetches - 1);
    }
  }

  #exchange(
    request: BridgeFetchRequest,
    headers: Readonly<Record<string, string>>,
  ): Promise<Response> {
    // The concurrency slot was claimed by `fetch` before it awaited anything;
    // from here `close()` is the only thing that gives it back.
    const id = this.#newRequestId();
    return new Promise<Response>((resolve, reject) => {
      let phase: "head" | "body" | "done" = "head";
      let chunks = 0;
      let bytes = 0;
      let expectsBody = true;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const close = (): void => {
        phase = "done";
        this.#activeFetches = Math.max(0, this.#activeFetches - 1);
        clearTimeout(headTimer);
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        this.#release(id);
      };
      const failClosed = (error: ExtensionBridgeError, tellExtension: boolean): void => {
        if (phase === "done") return;
        close();
        if (tellExtension) this.#cancel(id);
        // Once the head resolved, the caller already holds the Response, so the
        // failure has to arrive through its body rather than the promise.
        if (controller) controller.error(error);
        else reject(error);
      };
      const onAbort = (): void => failClosed(cancellation(request.signal), true);
      const timer = setTimeout(
        () => failClosed(
          new ExtensionBridgeError(
            "bridge-timeout",
            "The extension bridge exchange exceeded the client deadline.",
          ),
          true,
        ),
        this.#limits.requestTimeoutMs,
      );
      // Armed separately from the wall clock above: an extension that accepts a
      // `fetch` and then says nothing would otherwise hold the exchange, and
      // the caller's slot, for the whole request deadline.
      const headTimer = setTimeout(
        () => failClosed(
          new ExtensionBridgeError(
            "bridge-timeout",
            "The extension bridge accepted the request but sent no response head before the first-byte deadline.",
          ),
          true,
        ),
        this.#limits.headTimeoutMs,
      );
      request.signal.addEventListener("abort", onAbort, { once: true });
      const violation = (detail: string): void =>
        failClosed(new ExtensionBridgeError("bridge-protocol", detail), true);

      this.#register(id, {
        fail: (error) => failClosed(error, true),
        accept: (reply) => {
          if (phase === "done") return;
          if (reply.kind === "hello") {
            violation("The extension bridge answered a fetch with a handshake reply.");
            return;
          }
          if (reply.kind === "error") {
            failClosed(
              new ExtensionBridgeError(
                "bridge-error",
                `The extension bridge could not complete the request: ${reply.reason}`,
              ),
              false,
            );
            return;
          }
          if (reply.kind === "head") {
            if (phase !== "head") {
              violation("The extension bridge sent a second response head.");
              return;
            }
            phase = "body";
            // First byte arrived; only the wall clock bounds the rest.
            clearTimeout(headTimer);
            // 204/205/304 cannot carry a body through the Response constructor,
            // so the stream is not created and any later chunk is a violation.
            expectsBody = reply.status !== 204 && reply.status !== 205 && reply.status !== 304;
            const body = expectsBody
              ? new ReadableStream<Uint8Array>({
                  start: (streamController) => {
                    controller = streamController;
                  },
                  cancel: () => {
                    // The reader gave up; stop the extension rather than let it
                    // keep streaming into a stream nobody will read.
                    if (phase === "done") return;
                    close();
                    this.#cancel(id);
                  },
                })
              : null;
            try {
              resolve(new Response(body, { status: reply.status, headers: { ...reply.headers } }));
            } catch (error) {
              // A head this parser accepted but the platform will not build a
              // Response from is still a bad message, not a client defect.
              controller = undefined;
              failClosed(
                new ExtensionBridgeError(
                  "bridge-protocol",
                  "The extension bridge sent a response head this browser cannot represent.",
                  { cause: error },
                ),
                true,
              );
            }
            return;
          }
          if (phase !== "body") {
            violation("The extension bridge sent response body data before a head.");
            return;
          }
          if (reply.kind === "chunk") {
            if (!expectsBody) {
              violation("The extension bridge sent a body for a body-less status.");
              return;
            }
            if (reply.seq !== chunks + 1) {
              violation("The extension bridge sent an out-of-order response chunk.");
              return;
            }
            const decoded = decodeBase64(reply.data);
            if (!decoded) {
              violation("The extension bridge sent a chunk that is not decodable base64.");
              return;
            }
            if (decoded.byteLength > this.#limits.maxChunkBytes) {
              failClosed(
                new ExtensionBridgeError(
                  "bridge-too-large",
                  "An extension bridge chunk exceeds the client limit.",
                ),
                true,
              );
              return;
            }
            bytes += decoded.byteLength;
            if (bytes > this.#limits.maxResponseBytes) {
              failClosed(
                new ExtensionBridgeError(
                  "bridge-too-large",
                  "The extension bridge response exceeds the client limit.",
                ),
                true,
              );
              return;
            }
            chunks = reply.seq;
            controller?.enqueue(decoded);
            return;
          }
          // `end` is the single terminator, and it restates the chunk count so a
          // dropped chunk is a truncation this side can detect.
          if (reply.seq !== chunks) {
            violation("The extension bridge ended a response with a mismatched chunk count.");
            return;
          }
          close();
          controller?.close();
        },
      });

      try {
        this.#post({
          airshipBridge: BRIDGE_PROTOCOL_VERSION,
          from: "page",
          id,
          kind: "fetch",
          provider: request.provider,
          path: request.url,
          method: request.method,
          headers,
          ...(request.body !== undefined ? { body: request.body } : {}),
          stream: request.stream,
        });
      } catch (error) {
        // Nothing can have settled yet: the post is synchronous with the
        // registration, so no reply, deadline, or abort has had a turn.
        close();
        reject(error);
      }
    });
  }

  /**
   * Presence used to gate a request. A page-lifetime memo with a short TTL: the
   * observation is still live and still per page load, it simply is not
   * re-proved on every single request. It is never persisted and never survives
   * a reload, and it is never what a capability record reports — `handshake()`
   * and `probeExtensionBridge()` always run a fresh exchange.
   *
   * Only an `answered` result is memoized, and the staleness it buys is bounded
   * in one direction only: a request admitted against a memo of an extension
   * that has since gone away still fails, at the first-byte deadline, as a
   * live timeout. Memoizing an absence would be the dishonest half — it would
   * refuse for up to `presenceTtlMs` on an observation no longer being made,
   * and would hide an extension installed mid-session for that whole window.
   */
  async #observePresence(): Promise<BridgeHandshakeResult> {
    const memo = this.#presence;
    if (
      memo
      && memo.result.kind === "answered"
      && this.#now() - memo.observedAt < this.#limits.presenceTtlMs
    ) {
      return memo.result;
    }
    // The shared probe deliberately carries no caller signal: one caller's
    // cancellation must not settle another caller's presence observation.
    this.#handshakeInFlight ??= this.handshake().finally(() => {
      this.#handshakeInFlight = undefined;
    });
    return this.#handshakeInFlight;
  }

  #receive(event: BridgeMessageEventLike): void {
    if (event.origin !== this.#channel.expectedOrigin) return;
    if (event.source !== this.#channel.expectedSource) return;
    const id = bridgeReplyId(event.data);
    if (!id) return;
    const pending = this.#pending.get(id);
    // Unsolicited, or addressed to an exchange that already settled. There is
    // nothing to fail closed, so it is dropped without effect.
    if (!pending) return;
    const reply = parseBridgeReply(event.data);
    if (!reply) {
      pending.fail(new ExtensionBridgeError(
        "bridge-protocol",
        "The extension bridge sent a malformed message.",
      ));
      return;
    }
    pending.accept(reply);
  }

  #register(id: string, exchange: PendingExchange): void {
    this.#pending.set(id, exchange);
    if (this.#listening) return;
    this.#channel.addEventListener(this.#onMessage);
    this.#listening = true;
  }

  #release(id: string): void {
    this.#pending.delete(id);
    if (this.#pending.size > 0 || !this.#listening) return;
    this.#channel.removeEventListener(this.#onMessage);
    this.#listening = false;
  }

  #cancel(id: string): void {
    try {
      this.#channel.postMessage(Object.freeze({
        airshipBridge: BRIDGE_PROTOCOL_VERSION,
        from: "page",
        id,
        kind: "cancel",
      }));
    } catch {
      // Cancellation is best-effort: the page has already stopped reading, and
      // its own ceilings do not depend on the extension hearing this.
    }
  }

  #post(message: BridgeRequestMessage): void {
    try {
      this.#channel.postMessage(Object.freeze(message));
    } catch (error) {
      throw new ExtensionBridgeError(
        "bridge-unavailable",
        "This page could not post to the extension bridge relay.",
        { cause: error },
      );
    }
  }
}

/**
 * The real relay: `window.postMessage` to the content script, with replies
 * arriving on the same window. Returns `undefined` where no such relay can
 * exist (no DOM, or an opaque origin that cannot be named as a postMessage
 * target) so callers report an honest absence instead of a broken client.
 */
export function pageBridgeChannel(): BridgeMessageChannel | undefined {
  if (typeof window === "undefined" || typeof window.postMessage !== "function") return undefined;
  const origin = window.location?.origin;
  if (!origin || origin === "null") return undefined;
  const wrapped = new WeakMap<(event: BridgeMessageEventLike) => void, EventListener>();
  return Object.freeze({
    postMessage: (message: BridgeRequestMessage) => {
      // The exact origin, never "*": a wildcard target would broadcast bearer
      // tokens to any frame that happens to be listening.
      window.postMessage(message, origin);
    },
    addEventListener: (listener: (event: BridgeMessageEventLike) => void) => {
      const bound: EventListener = (event) => {
        const message = event as MessageEvent<unknown>;
        listener({ data: message.data, origin: message.origin, source: message.source });
      };
      wrapped.set(listener, bound);
      window.addEventListener("message", bound);
    },
    removeEventListener: (listener: (event: BridgeMessageEventLike) => void) => {
      const bound = wrapped.get(listener);
      if (!bound) return;
      wrapped.delete(listener);
      window.removeEventListener("message", bound);
    },
    expectedOrigin: origin,
    expectedSource: window,
  });
}

let pageClient: ExtensionBridgeClient | undefined;
let pageClientResolved = false;

/**
 * The page's single bridge client. It is a client, not a claim: holding one
 * says nothing about whether an extension exists, which only `handshake()`
 * can answer.
 */
export function pageExtensionBridge(): ExtensionBridgeClient | undefined {
  if (!pageClientResolved) {
    pageClientResolved = true;
    const channel = pageBridgeChannel();
    pageClient = channel ? new ExtensionBridgeClient(channel) : undefined;
  }
  return pageClient;
}

/** Test seam: forget the page client so a suite cannot inherit another's channel. */
export function resetPageExtensionBridge(): void {
  pageClient = undefined;
  pageClientResolved = false;
}

/** One sentence naming why a bridged request cannot be made, for the caller to surface. */
export function absenceDetail(result: BridgeHandshakeResult): string {
  if (result.kind === "silent") {
    return `No Airship browser extension answered the bridge handshake within ${String(result.deadlineMs)} ms.`;
  }
  if (result.kind === "malformed") {
    return `The extension bridge handshake reply was rejected: ${result.detail}`;
  }
  if (result.kind === "unsupported") {
    return `No extension bridge handshake could be sent: ${result.detail}.`;
  }
  return `The Airship browser extension ${result.version} answered the bridge handshake.`;
}

function cancellation(signal: AbortSignal): ExtensionBridgeError {
  return new ExtensionBridgeError(
    "bridge-cancelled",
    "The extension bridge request was cancelled.",
    { cause: signal.reason },
  );
}

function decodeBase64(data: string): Uint8Array | undefined {
  if (!data) return new Uint8Array(0);
  if (typeof atob !== "function") return undefined;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index) & 0xff;
    }
    return bytes;
  } catch {
    return undefined;
  }
}
