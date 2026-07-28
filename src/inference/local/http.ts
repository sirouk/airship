import type { MemoryCredential } from "./contracts";
import {
  LocalProviderError,
  directFetchDiagnostic,
  providerDiagnostic,
} from "./endpoint-policy";

export type BoundedFetchOptions = Readonly<{
  fetchImpl: typeof fetch;
  credential?: MemoryCredential;
  timeoutMs: number;
  maxResponseBytes: number;
}>;

export async function boundedJson(
  url: URL,
  init: RequestInit,
  options: BoundedFetchOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  const lifetime = timeoutSignal(signal, options.timeoutMs);
  try {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    const credential = await resolveCredential(options.credential, lifetime.signal);
    if (credential) headers.set("Authorization", `Bearer ${credential}`);
    const response = await options.fetchImpl(url, {
      ...init,
      headers,
      mode: "cors",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: lifetime.signal,
    });
    if (!response.ok) {
      throw new LocalProviderError(providerDiagnostic(
        "http",
        `The local model endpoint returned HTTP ${response.status}.`,
        { status: response.status },
      ));
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.includes("json")) {
      throw new LocalProviderError(providerDiagnostic(
        "invalid-content-type",
        "The local model endpoint did not return JSON.",
      ));
    }
    const text = await readBoundedBody(response.body, options.maxResponseBytes, lifetime.signal);
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new LocalProviderError(providerDiagnostic(
        "invalid-json",
        "The local model endpoint returned malformed JSON.",
      ), { cause });
    }
  } catch (error) {
    if (error instanceof LocalProviderError) throw error;
    throw new LocalProviderError(directFetchDiagnostic(error), { cause: error });
  } finally {
    lifetime.dispose();
  }
}

export async function resolveCredential(
  source: MemoryCredential | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!source) return undefined;
  if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled.", "AbortError");
  const value = await source();
  if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled.", "AbortError");
  const normalized = value?.trim() ?? "";
  if (normalized && (normalized.length > 8_192 || !/^[\x21-\x7e]+$/u.test(normalized))) {
    throw new LocalProviderError(providerDiagnostic(
      "credential-invalid",
      "The page-memory local-provider credential has an invalid format.",
    ));
  }
  return normalized || undefined;
}

export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled.", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        throw new LocalProviderError(providerDiagnostic(
          "response-too-large",
          `The local model response exceeded the ${limit}-byte safety limit.`,
        ));
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new DOMException("Cancelled.", "AbortError"));
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = globalThis.setTimeout(
    () => controller.abort(new DOMException("Local model request timed out.", "AbortError")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      globalThis.clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function boundedOptions(options: {
  fetch?: typeof fetch;
  credential?: MemoryCredential;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): BoundedFetchOptions {
  return Object.freeze({
    fetchImpl: options.fetch ?? globalThis.fetch.bind(globalThis),
    credential: options.credential,
    timeoutMs: boundedInteger(options.timeoutMs, 30_000, 1_000, 300_000),
    maxResponseBytes: boundedInteger(options.maxResponseBytes, 2 * 1024 * 1024, 1_024, 16 * 1024 * 1024),
  });
}

export function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) && value! >= minimum && value! <= maximum ? value! : fallback;
}
