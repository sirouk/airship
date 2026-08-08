import type { InferenceRequest, InferenceTransport } from "./contracts";

/**
 * In-turn provider resilience.
 *
 * A turn used to be destroyed by one 429 or one dropped connection:
 * `collectInference` let the transport error out, `runTurn` wrote `turn.failed`,
 * and recovery was the human pressing Retry — after twenty steps that may
 * already have written files. This wraps the transport the turn was handed so a
 * *transient* refusal is redelivered inside the same step instead.
 *
 * Two independent bounds decide what "transient" means, and both fail closed.
 *
 * **The failure has to name itself.** All three transport families already do:
 * `ProviderTransportError` carries `code` plus an HTTP `status`,
 * `LocalProviderError` carries the same pair under `diagnostic`, and
 * `ChutesTransportError` carries the same pair spelled in its own
 * SCREAMING_SNAKE vocabulary. This module reads that shape structurally rather
 * than importing any of those classes, because
 * `src/core` must not depend on `src/inference` — and because a transport that
 * declines to name its failure then gets no retry at all, which is the right
 * default for an error nobody has classified. `inference-retry.test.ts` builds
 * all three real error classes and asserts they are read correctly, so the
 * structural read is checked against the real thing rather than assumed — and
 * so a family whose spellings this module has never heard of cannot go on
 * silently getting no retry at all, which is what happened to Chutes.
 *
 * **The attempt must not have been observed.** Once a single event has been
 * yielded downstream, the consumer has accumulated text or a tool call, and
 * replaying the request would duplicate it into the assistant message. So a
 * failure after the first event is always terminal, whatever its code says.
 *
 * What this deliberately does not do: it never redelivers a request whose
 * effects it cannot see. It also does not journal its attempts. `runTurn`
 * records one `inference.started` per logical request, bound to an
 * `idempotencyKey` that every attempt reuses; an attempt is a redelivery of
 * that request, not a second one, and inventing durable events for it would
 * make the journal disagree with the digest it already committed.
 */

export type InferenceRetryPolicy = Readonly<{
  /** Total attempts including the first. Anything below 2 disables retry. */
  maxAttempts: number;
  /** Floor of the first backoff window. */
  baseDelayMs: number;
  /**
   * Ceiling of any single wait — including one the provider asked for. A
   * `Retry-After` above this is not silently shortened; see `retryWaitMs`.
   */
  maxDelayMs: number;
}>;

/**
 * Three attempts across at most ~8s of waiting. Chosen against a turn, not a
 * background job: the user is watching a streaming response, and a fourth
 * attempt buys less than telling them the provider is refusing.
 */
export const DEFAULT_INFERENCE_RETRY_POLICY: InferenceRetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 8_000,
});

export type NamedTransportFailure = Readonly<{
  code: string;
  status?: number;
  retryAfter?: string;
}>;

/**
 * Codes that describe the *carriage* of the request rather than a verdict on
 * its content. `stream-truncated`/`stream-interrupted` are here because a body
 * that stopped arriving before any event is exactly the dropped connection this
 * exists for; one that stopped after an event is caught by the observed-attempt
 * bound instead.
 */
const RETRYABLE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "network-or-cors",
  "offline",
  "timeout",
  "stream-truncated",
  "stream-interrupted",
  // How the local providers spell `network-or-cors`. Both codes name the same
  // event — a `fetch` that rejected before any response existed — and neither
  // browser will say whether that was a refused preflight or a model server
  // that dropped the connection, which is why both names concede the
  // ambiguity. Only the cloud spelling was listed, so the identical dropped
  // socket destroyed a turn against Ollama or LM Studio while surviving it
  // against OpenAI. A CORS refusal really is permanent, and it now costs three
  // attempts inside the first couple of seconds before the same diagnostic
  // surfaces — the price the cloud lane has always paid for the same guess.
  "cors-or-private-network-access",
  // The same three carriage failures as the Chutes transport spells them. Its
  // `TIMEOUT` is deliberately absent: it is the 300s whole-request lifetime
  // (`transport.ts` `RequestLifetime`), not a socket that went quiet, so
  // redelivering it would hold the turn for a quarter of an hour before the
  // person is told anything — the observed-attempt bound does not shorten a
  // lifetime that has already expired once.
  "NETWORK_ERROR",
  "STREAM_TRUNCATED",
  "STREAM_STALLED",
]);

/**
 * The two spellings of "the provider answered with an HTTP status", which is
 * the one code whose retryability is decided by the status rather than by the
 * code alone. `ChutesTransportError` names it `HTTP_ERROR`; an `HTTP_ERROR`
 * raised before any request went out carries no status and stays terminal.
 */
const HTTP_FAILURE_CODES: ReadonlySet<string> = new Set(["http", "HTTP_ERROR"]);

export function withInferenceRetry(
  transport: InferenceTransport,
  policy: InferenceRetryPolicy | undefined = DEFAULT_INFERENCE_RETRY_POLICY,
): InferenceTransport {
  if (!(policy.maxAttempts > 1)) return transport;
  return {
    id: transport.id,
    posture: transport.posture,
    async *stream(request: InferenceRequest, signal: AbortSignal) {
      let previousDelayMs = 0;
      for (let attempt = 1; ; attempt += 1) {
        signal.throwIfAborted();
        let observed = false;
        try {
          for await (const event of transport.stream(request, signal)) {
            observed = true;
            yield event;
          }
          return;
        } catch (error) {
          // Cancellation is the caller's verdict, not the provider's.
          if (observed || signal.aborted || attempt >= policy.maxAttempts) throw error;
          const waitMs = retryWaitMs(error, policy, previousDelayMs);
          if (waitMs === undefined) throw error;
          previousDelayMs = waitMs;
          await abortableDelay(waitMs, signal);
        }
      }
    },
  };
}

/** Milliseconds to wait before redelivering, or undefined to give up now. */
export function retryWaitMs(
  error: unknown,
  policy: InferenceRetryPolicy,
  previousDelayMs: number,
  nowMs: number = Date.now(),
): number | undefined {
  const failure = namedTransportFailure(error);
  if (!failure || !isRetryableTransportFailure(failure)) return undefined;
  const requested = parseRetryAfterMs(failure.retryAfter, nowMs);
  if (requested === undefined) return decorrelatedJitterMs(policy, previousDelayMs);
  /*
   * A provider that scheduled the next acceptable moment has already answered
   * the question. Waiting less than it asked spends the remaining attempts on a
   * refusal it has committed to, so a `Retry-After` past the policy ceiling
   * stops the loop and lets the original refusal surface with its own status.
   */
  return requested > policy.maxDelayMs ? undefined : requested;
}

export function isRetryableTransportFailure(failure: NamedTransportFailure): boolean {
  if (!HTTP_FAILURE_CODES.has(failure.code)) return RETRYABLE_TRANSPORT_CODES.has(failure.code);
  const status = failure.status;
  if (status === undefined) return false;
  // 408 and 429 are the provider asking for the same request again; 5xx is the
  // provider failing to answer it. Every other 4xx is a verdict on the request
  // itself, and repeating it would only spend the user's quota.
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Read the `code`/`status` pair a transport put on its own error, from either
 * the error itself or a `diagnostic` sub-record. Nothing is inferred: an error
 * without a string code is simply not retryable.
 */
export function namedTransportFailure(error: unknown): NamedTransportFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const carrier = error as unknown as Record<string, unknown>;
  const named = typeof carrier.code === "string" ? carrier : plainRecord(carrier.diagnostic);
  const code = named?.code;
  if (typeof code !== "string") return undefined;
  const status = named?.status;
  const retryAfter = carrier.retryAfter;
  return Object.freeze({
    code,
    ...(typeof status === "number" && Number.isInteger(status) ? { status } : {}),
    ...(typeof retryAfter === "string" ? { retryAfter } : {}),
  });
}

/**
 * RFC 7231 `Retry-After`: either delay-seconds or an HTTP-date. The digit test
 * is exact rather than `Number()` so `1e3` is read as the malformed header it
 * is instead of as a thousand seconds.
 *
 * Undefined is the common case even when a provider sends the header:
 * `Retry-After` is not CORS-safelisted, so a page can only read it from a
 * provider that also sends `access-control-expose-headers: retry-after`. The
 * backoff below is what runs otherwise — never a guessed number.
 */
export function parseRetryAfterMs(value: string | undefined, nowMs: number): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d{1,9}$/u.test(raw)) return Number(raw) * 1_000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/**
 * Decorrelated jitter: each wait is drawn uniformly from `[base, previous * 3]`
 * and clamped to the ceiling. It grows like exponential backoff without the
 * property that makes exponential backoff dangerous here — every page that hit
 * the same 429 would otherwise return at the same instant.
 */
export function decorrelatedJitterMs(policy: InferenceRetryPolicy, previousDelayMs: number): number {
  const floor = Math.max(1, Math.min(policy.baseDelayMs, policy.maxDelayMs));
  const ceiling = Math.min(policy.maxDelayMs, Math.max(floor, previousDelayMs * 3));
  const span = Math.max(0, ceiling - floor);
  return Math.min(policy.maxDelayMs, floor + Math.floor(randomFraction() * (span + 1)));
}

function randomFraction(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      settle();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      settle();
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
