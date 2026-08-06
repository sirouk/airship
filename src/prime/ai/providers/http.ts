import type { ProviderResponse } from "../types";

/**
 * Browser-safe HTTP layer shared by the ported providers. The prime-agent
 * upstream delegates retries, timeouts, and aborts to the Anthropic/OpenAI
 * SDKs; this port owns that lifecycle directly so it can honor
 * StreamOptions.maxRetries, StreamOptions.maxRetryDelayMs, and
 * StreamOptions.timeoutMs. The caller's AbortSignal is composed into each
 * attempt, never replaced: replacing it would make a per-attempt timeout
 * indistinguishable from a caller abort and would break the "aborted" vs
 * "error" stop-reason contract the stream protocol depends on.
 *
 * Retry semantics deliberately mirror the Anthropic SDK (the strictest of
 * the upstream clients): `x-should-retry` overrides everything, then 408,
 * 409, 429, and any 5xx are retried; `retry-after-ms` and `retry-after`
 * (seconds or HTTP-date) are obeyed verbatim, otherwise exponential backoff
 * (500ms * 2^n, up to 25% downward jitter) applies. All delays are capped by
 * maxRetryDelayMs (default 8000, matching the SDK's MAX_RETRY_DELAY).
 */

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_RETRY_DELAY_MS = 8000;
const INITIAL_RETRY_DELAY_MS = 500;
const RETRY_JITTER_FRACTION = 0.25;
const ABORTED_MESSAGE = "Request was aborted";

export function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}

/**
 * Non-2xx terminal response. Shaped like the provider SDK errors so the
 * stream-failure classifier can extract status, nested body type/message,
 * and the request id through its generic (SDK-agnostic) path.
 */
export class HttpResponseError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
  /** Parsed JSON error body when the server sent one; undefined otherwise. */
  readonly error: unknown;
  readonly requestID: string | undefined;

  constructor(response: ProviderResponse, bodyText: string) {
    super(bodyText.length > 0 ? `${response.status} ${bodyText}` : `${response.status} (no body)`);
    this.name = "HttpResponseError";
    this.status = response.status;
    this.headers = response.headers;
    this.bodyText = bodyText;
    this.error = tryParseJson(bodyText);
    this.requestID = response.headers["request-id"] ?? response.headers["x-request-id"];
  }
}

function tryParseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface ProviderHttpRequest {
  url: string;
  headers: Record<string, string>;
  /** Serialized verbatim as the JSON request body. */
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}

interface AttemptScope {
  signal: AbortSignal;
  readonly timedOut: boolean;
  dispose(): void;
}

/**
 * Compose the caller signal with a per-attempt timeout. The caller's signal
 * stays attached so aborts always surface through the composed signal, while
 * the timeout sets its own flag so the retry loop can tell the two apart.
 * The timeout is per attempt, matching SDK semantics: a retry resets it.
 */
function createAttemptScope(caller: AbortSignal | undefined, timeoutMs: number | undefined): AttemptScope {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) {
      controller.abort();
    } else {
      caller.addEventListener("abort", onCallerAbort, { once: true });
    }
  }
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function shouldRetryResponse(response: Response): boolean {
  // Non-standard but supported by the SDKs: let the server decide.
  const override = response.headers.get("x-should-retry");
  if (override === "true") return true;
  if (override === "false") return false;
  if (response.status === 408) return true;
  if (response.status === 409) return true;
  if (response.status === 429) return true;
  return response.status >= 500;
}

function parseRetryAfterMs(response: Response): number | undefined {
  const retryAfterMs = response.headers.get("retry-after-ms");
  if (retryAfterMs) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(seconds)) return seconds * 1000;
    const dateMs = Date.parse(retryAfter) - Date.now();
    if (!Number.isNaN(dateMs)) return dateMs;
  }
  return undefined;
}

function defaultRetryDelayMs(completedRetries: number, maxRetryDelayMs: number): number {
  const exponential = INITIAL_RETRY_DELAY_MS * 2 ** completedRetries;
  const capped = Math.min(exponential, maxRetryDelayMs);
  const jitter = 1 - Math.random() * RETRY_JITTER_FRACTION;
  return capped * jitter;
}

function retryDelayMs(response: Response | undefined, completedRetries: number, maxRetryDelayMs: number): number {
  if (response) {
    const serverDelay = parseRetryAfterMs(response);
    if (serverDelay !== undefined) {
      // The server asked explicitly; honor it, only bounded by the caller's cap.
      return Math.max(0, Math.min(serverDelay, maxRetryDelayMs));
    }
  }
  return defaultRetryDelayMs(completedRetries, maxRetryDelayMs);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(ABORTED_MESSAGE));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(ABORTED_MESSAGE));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * POST a JSON body and return the streaming response. Never returns non-2xx:
 * failed attempts either retry (within the retry budget) or throw an
 * HttpResponseError whose parsed body and request id survive for the
 * stream-failure classifier. A caller abort always throws
 * `Error("Request was aborted")` — providers pattern-match on that message
 * and their own signal check to emit stopReason "aborted".
 */
export async function fetchWithRetry(request: ProviderHttpRequest): Promise<Response> {
  const maxRetries = request.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRetryDelayMs = request.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const body = JSON.stringify(request.body);
  let completedRetries = 0;

  for (;;) {
    const scope = createAttemptScope(request.signal, request.timeoutMs);
    let response: Response | undefined;
    let networkError: unknown;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body,
        signal: scope.signal,
      });
    } catch (error) {
      networkError = error;
    } finally {
      scope.dispose();
    }

    // A caller abort outranks every other classification, including a
    // response that arrived concurrently with the abort.
    if (request.signal?.aborted) {
      throw new Error(ABORTED_MESSAGE);
    }

    if (response === undefined) {
      // fetch rejected: per-attempt timeout (scope.timedOut) or a network
      // failure. Both are retryable, mirroring the SDKs the port replaces.
      if (completedRetries < maxRetries) {
        await abortableSleep(retryDelayMs(undefined, completedRetries, maxRetryDelayMs), request.signal);
        completedRetries += 1;
        continue;
      }
      if (scope.timedOut && request.timeoutMs !== undefined) {
        throw new Error(`Request timed out after ${request.timeoutMs}ms`);
      }
      if (networkError instanceof Error) throw networkError;
      throw new Error(String(networkError));
    }

    if (response.ok) return response;

    if (shouldRetryResponse(response) && completedRetries < maxRetries) {
      await abortableSleep(retryDelayMs(response, completedRetries, maxRetryDelayMs), request.signal);
      completedRetries += 1;
      continue;
    }

    const bodyText = await response.text();
    throw new HttpResponseError(
      { status: response.status, headers: headersToRecord(response.headers) },
      bodyText,
    );
  }
}
