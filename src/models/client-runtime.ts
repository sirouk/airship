import {
  CatalogPayloadError,
  mergeModelCatalog,
  parseInferenceCatalog,
  parseManagementCatalog,
  type ParsedInferenceCatalog,
  type ParsedManagementCatalog,
} from "./parser";
import type { ParsedUtilizationCatalog } from "./telemetry";
import {
  CHUTES_API_BASE,
  CHUTES_LLM_MODELS_URL,
  type ModelCatalogIssue,
  type ModelCatalogIssueCode,
  type ModelCatalogSnapshot,
  type ModelCatalogSource,
} from "./types";

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_STALE_TTL_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MANAGEMENT_LIMIT = 500;
const MAX_CREDENTIAL_LENGTH = 16 * 1024;

export type ModelCatalogAuthorization = Readonly<{
  kind: "oauth" | "api-key";
  /** Called only for a network request and never copied into Airship storage. */
  getBearerToken: (signal: AbortSignal) => string | Promise<string>;
  /** Optional guardrail for OAuth callers that already know the granted scopes. */
  scopes?: readonly string[];
}>;

export type ModelCatalogClientOptions = Readonly<{
  fetch?: typeof fetch;
  modelsUrl?: string;
  apiBase?: string;
  includeManagement?: boolean;
  includeUtilization?: boolean;
  managementLimit?: number;
  /** `/v1/models` is public. Enable only to avoid the anonymous rate bucket. */
  authorization?: ModelCatalogAuthorization;
  cacheTtlMs?: number;
  staleTtlMs?: number;
  timeoutMs?: number;
  debounceMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}>;

export type LoadModelCatalogOptions = Readonly<{
  signal?: AbortSignal;
  forceRefresh?: boolean;
}>;

type ResolvedOptions = Readonly<{
  fetch: typeof fetch;
  modelsUrl: string;
  apiBase: string;
  includeManagement: boolean;
  includeUtilization: boolean;
  managementLimit: number;
  authorization?: ModelCatalogAuthorization;
  cacheTtlMs: number;
  staleTtlMs: number;
  timeoutMs: number;
  debounceMs: number;
  maxResponseBytes: number;
  now: () => number;
}>;

type CacheEntry = Readonly<{
  snapshot: ModelCatalogSnapshot;
  freshUntil: number;
  staleUntil: number;
}>;

type InFlight = {
  controller: AbortController;
  promise: Promise<ModelCatalogSnapshot>;
  waiters: number;
  settled: boolean;
};

type DebouncedLoad = {
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  reject: (reason: unknown) => void;
  disposeSignal: () => void;
};

type SourceSuccess<T> = Readonly<{
  source: ModelCatalogSource;
  value: T;
  issues: readonly ModelCatalogIssue[];
}>;

type SourceFailure = Readonly<{
  source: ModelCatalogSource;
  issue: ModelCatalogIssue;
}>;

type SourceResult<T> = SourceSuccess<T> | SourceFailure;

class SourceRequestError extends Error {
  constructor(
    readonly code: ModelCatalogIssueCode,
    readonly context: { status?: number; requestId?: string; retryable?: boolean } = {},
  ) {
    super(code);
    this.name = "SourceRequestError";
  }
}

/** Browser-direct Chutes catalog client. Cache contents are normalized metadata only. */
export class ModelCatalogClientRuntime {
  private readonly options: ResolvedOptions;
  private cache?: CacheEntry;
  private inFlight?: InFlight;
  private debounced?: DebouncedLoad;

  constructor(options: ModelCatalogClientOptions = {}) {
    this.options = resolveOptions(options);
  }

  async load(options: LoadModelCatalogOptions = {}): Promise<ModelCatalogSnapshot> {
    throwIfAborted(options.signal);
    const now = this.options.now();
    if (!options.forceRefresh && this.cache && this.cache.freshUntil > now) {
      return withCacheState(this.cache.snapshot, "memory");
    }

    const flight = this.inFlight ?? this.startNetworkLoad();
    flight.waiters += 1;
    try {
      const snapshot = await abortable(flight.promise, options.signal);
      if (snapshot.sources.inference === "failed" && this.cache && this.cache.staleUntil > this.options.now()) {
        return staleSnapshot(this.cache.snapshot, snapshot);
      }
      if (snapshot.sources.inference === "fresh") {
        const loadedAt = this.options.now();
        this.cache = Object.freeze({
          snapshot,
          freshUntil: loadedAt + this.options.cacheTtlMs,
          staleUntil: loadedAt + this.options.staleTtlMs,
        });
      }
      return snapshot;
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(abortError("No model catalog callers remain."));
      }
    }
  }

  /** Latest-call-wins refresh for UI lifecycle/search transitions. */
  refreshDebounced(options: LoadModelCatalogOptions = {}): Promise<ModelCatalogSnapshot> {
    this.cancelDebounced(abortError("Superseded by a newer model catalog refresh."));
    const controller = new AbortController();
    const disposeForward = forwardAbort(options.signal, controller);

    return new Promise<ModelCatalogSnapshot>((resolve, reject) => {
      const abort = () => {
        if (this.debounced !== entry) return;
        this.debounced = undefined;
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.disposeSignal();
        reject(abortReason(controller.signal));
      };
      const disposeSignal = () => {
        disposeForward();
        controller.signal.removeEventListener("abort", abort);
      };
      const entry: DebouncedLoad = { controller, reject, disposeSignal };
      this.debounced = entry;
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) {
        abort();
        return;
      }
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        void this.load({ signal: controller.signal, forceRefresh: options.forceRefresh ?? true })
          .then(resolve, reject)
          .finally(() => {
            if (this.debounced === entry) this.debounced = undefined;
            entry.disposeSignal();
          });
      }, this.options.debounceMs);
    });
  }

  clearMemoryCache(): void {
    this.cache = undefined;
  }

  dispose(): void {
    this.cancelDebounced(abortError("Model catalog client was disposed."));
    this.inFlight?.controller.abort(abortError("Model catalog client was disposed."));
    this.inFlight = undefined;
    this.cache = undefined;
  }

  private startNetworkLoad(): InFlight {
    const controller = new AbortController();
    const flight: InFlight = {
      controller,
      promise: Promise.resolve(undefined as never),
      waiters: 0,
      settled: false,
    };
    flight.promise = this.fetchSnapshot(controller.signal).finally(() => {
      flight.settled = true;
      if (this.inFlight === flight) this.inFlight = undefined;
    });
    this.inFlight = flight;
    return flight;
  }

  private async fetchSnapshot(signal: AbortSignal): Promise<ModelCatalogSnapshot> {
    const timeout = createTimeout(signal, this.options.timeoutMs);
    try {
      const inferencePromise = captureSource(
        "llm-models",
        timeout.signal,
        () => this.fetchInference(timeout.signal),
        timeout.didTimeout,
      );
      const managementPromise = this.options.includeManagement
        ? captureSource(
            "chutes-management",
            timeout.signal,
            () => this.fetchManagement(timeout.signal),
            timeout.didTimeout,
          )
        : Promise.resolve(undefined);
      const utilizationPromise = this.options.includeUtilization
        ? captureSource(
            "chutes-utilization",
            timeout.signal,
            () => this.fetchUtilization(timeout.signal),
            timeout.didTimeout,
          )
        : Promise.resolve(undefined);
      const [inferenceResult, managementResult, utilizationResult] = await Promise.all([
        inferencePromise,
        managementPromise,
        utilizationPromise,
      ]);

      const issues: ModelCatalogIssue[] = [];
      let inference: ParsedInferenceCatalog = Object.freeze({
        models: Object.freeze([]),
        records: 0,
        skipped: 0,
      });
      let management: ParsedManagementCatalog | undefined;
      let utilization: ParsedUtilizationCatalog | undefined;
      if ("issue" in inferenceResult) {
        issues.push(inferenceResult.issue);
      } else {
        inference = inferenceResult.value;
        issues.push(...inferenceResult.issues);
      }
      if (managementResult) {
        if ("issue" in managementResult) {
          issues.push(managementResult.issue);
        } else {
          management = managementResult.value;
          issues.push(...managementResult.issues);
        }
      }
      if (utilizationResult) {
        if ("issue" in utilizationResult) {
          issues.push(utilizationResult.issue);
        } else {
          utilization = utilizationResult.value;
          issues.push(...utilizationResult.issues);
        }
      }

      const models = mergeModelCatalog(inference, management, utilization);
      const sources = Object.freeze({
        inference: "issue" in inferenceResult ? "failed" as const : "fresh" as const,
        management: !this.options.includeManagement
          ? "disabled" as const
          : managementResult && "issue" in managementResult
            ? "failed" as const
            : "fresh" as const,
        utilization: !this.options.includeUtilization
          ? "disabled" as const
          : utilizationResult && "issue" in utilizationResult
            ? "failed" as const
            : "fresh" as const,
      });
      return Object.freeze({
        fetchedAt: new Date(this.options.now()).toISOString(),
        cache: "network",
        models,
        inferenceRecords: inference.records,
        ...(management ? { managementRecords: management.records } : {}),
        ...(management?.total !== undefined ? { managementTotal: management.total } : {}),
        ...(utilization ? { utilizationRecords: utilization.records } : {}),
        sources,
        issues: Object.freeze(issues),
        complete: issues.length === 0 && sources.inference === "fresh" && sources.management !== "failed",
      });
    } finally {
      timeout.dispose();
    }
  }

  private async fetchInference(signal: AbortSignal): Promise<SourceSuccess<ParsedInferenceCatalog>> {
    const headers = new Headers({ Accept: "application/json" });
    if (this.options.authorization) {
      headers.set("Authorization", `Bearer ${await resolveBearer(this.options.authorization, signal)}`);
    }
    const payload = await requestJson(
      this.options.fetch,
      this.options.modelsUrl,
      headers,
      signal,
      this.options.maxResponseBytes,
    );
    const value = parseInferenceCatalog(payload);
    const issues = value.skipped > 0
      ? [invalidRecordsIssue("llm-models", value.skipped)]
      : [];
    return Object.freeze({ source: "llm-models", value, issues: Object.freeze(issues) });
  }

  private async fetchManagement(signal: AbortSignal): Promise<SourceSuccess<ParsedManagementCatalog>> {
    const url = new URL("/chutes/", this.options.apiBase);
    url.searchParams.set("include_public", "true");
    url.searchParams.set("template", "vllm");
    url.searchParams.set("page", "0");
    url.searchParams.set("limit", String(this.options.managementLimit));
    url.searchParams.set("include_schemas", "false");
    const payload = await requestJson(
      this.options.fetch,
      url.toString(),
      new Headers({ Accept: "application/json" }),
      signal,
      this.options.maxResponseBytes,
    );
    const value = parseManagementCatalog(payload);
    const issues: ModelCatalogIssue[] = [];
    if (value.skipped > 0) issues.push(invalidRecordsIssue("chutes-management", value.skipped));
    if (value.truncated) {
      issues.push(Object.freeze({
        source: "chutes-management",
        code: "truncated",
        message: "Chutes management metadata was truncated; affected model status remains unknown.",
        retryable: false,
        count: Math.max(0, (value.total ?? value.records) - value.records),
      }));
    }
    return Object.freeze({ source: "chutes-management", value, issues: Object.freeze(issues) });
  }

  private async fetchUtilization(signal: AbortSignal): Promise<SourceSuccess<ParsedUtilizationCatalog>> {
    const url = new URL("/chutes/utilization", this.options.apiBase);
    const payload = await requestJson(
      this.options.fetch,
      url.toString(),
      new Headers({ Accept: "application/json" }),
      signal,
      this.options.maxResponseBytes,
    );
    const { parseUtilizationCatalog } = await import("./telemetry");
    const value = parseUtilizationCatalog(payload, this.options.now());
    const issues = value.skipped > 0
      ? [invalidRecordsIssue("chutes-utilization", value.skipped)]
      : [];
    return Object.freeze({ source: "chutes-utilization", value, issues: Object.freeze(issues) });
  }

  private cancelDebounced(reason: unknown): void {
    const entry = this.debounced;
    if (!entry) return;
    this.debounced = undefined;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.controller.abort(reason);
    entry.disposeSignal();
    entry.reject(reason);
  }
}

async function captureSource<T>(
  source: ModelCatalogSource,
  signal: AbortSignal,
  load: () => Promise<SourceSuccess<T>>,
  didTimeout: () => boolean,
): Promise<SourceResult<T>> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof SourceRequestError) {
      return Object.freeze({
        source,
        issue: Object.freeze({
          source,
          code: error.code,
          message: sourceMessage(source, error.code, error.context.status),
          retryable: error.context.retryable ?? isRetryable(error.code, error.context.status),
          ...(error.context.status !== undefined ? { status: error.context.status } : {}),
          ...(error.context.requestId ? { requestId: error.context.requestId } : {}),
        }),
      });
    }
    if (error instanceof CatalogPayloadError || isCatalogPayloadError(error)) {
      return Object.freeze({
        source,
        issue: Object.freeze({
          source,
          code: error.code,
          message: sourceMessage(source, error.code),
          retryable: false,
        }),
      });
    }
    const timeout = didTimeout();
    return Object.freeze({
      source,
      issue: Object.freeze({
        source,
        code: timeout ? "timeout" : "network",
        message: sourceMessage(source, timeout ? "timeout" : "network"),
        retryable: true,
      }),
    });
  }
}

function isCatalogPayloadError(error: unknown): error is CatalogPayloadError {
  if (!(error instanceof Error) || error.name !== "CatalogPayloadError") return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "invalid-payload" || code === "response-too-large";
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Headers,
  signal: AbortSignal,
  maxBytes: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await abortable(
      fetchImpl(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
        headers,
      }),
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SourceRequestError("network");
  }
  const requestId = boundedHeader(response.headers.get("x-request-id"));
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort disposal only.
    }
    throw new SourceRequestError("http", {
      status: response.status,
      ...(requestId ? { requestId } : {}),
    });
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/.test(contentType)) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort disposal only.
    }
    throw new SourceRequestError("invalid-content-type", {
      retryable: false,
    });
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort disposal only.
    }
    throw new SourceRequestError("response-too-large", {
      retryable: false,
    });
  }
  const text = await readBoundedUtf8(response, maxBytes, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SourceRequestError("invalid-json", {
      retryable: false,
    });
  }
}

async function readBoundedUtf8(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await abortable(response.arrayBuffer(), signal);
    if (buffer.byteLength > maxBytes) {
      throw new SourceRequestError("response-too-large", {
        retryable: false,
      });
    }
    return decodeUtf8(new Uint8Array(buffer));
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SourceRequestError("response-too-large", {
          retryable: false,
        });
      }
      chunks.push(result.value);
    }
  } finally {
    if (signal.aborted) {
      try {
        await reader.cancel(signal.reason);
      } catch {
        // The fetch abort may already have errored or detached the stream.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // A hostile stream may leave a read pending despite cancellation.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeUtf8(bytes);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SourceRequestError("invalid-json", {
      retryable: false,
    });
  }
}

async function resolveBearer(authorization: ModelCatalogAuthorization, signal: AbortSignal): Promise<string> {
  if (
    authorization.kind === "oauth" &&
    authorization.scopes &&
    !authorization.scopes.some((scope) => scope === "chutes:invoke" || scope === "invoke" || scope === "admin")
  ) {
    throw new SourceRequestError("invalid-payload", {
      retryable: false,
    });
  }
  let value: string;
  try {
    value = await abortable(Promise.resolve(authorization.getBearerToken(signal)), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SourceRequestError("network");
  }
  const token = value.trim();
  const expectedPrefix = authorization.kind === "oauth" ? "cak_" : "cpk_";
  if (
    !token.startsWith(expectedPrefix) ||
    token.length > MAX_CREDENTIAL_LENGTH ||
    /[\u0000-\u0020\u007f]/.test(token)
  ) {
    throw new SourceRequestError("invalid-payload", {
      retryable: false,
    });
  }
  return token;
}

function resolveOptions(options: ModelCatalogClientOptions): ResolvedOptions {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") throw new TypeError("Fetch API is unavailable.");
  const cacheTtlMs = boundedOption(
    options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    "cacheTtlMs",
    0,
    3_600_000,
  );
  const staleTtlMs = Math.max(
    cacheTtlMs,
    boundedOption(options.staleTtlMs ?? DEFAULT_STALE_TTL_MS, "staleTtlMs", 0, 86_400_000),
  );
  return Object.freeze({
    fetch: fetchImpl,
    modelsUrl: secureUrl(options.modelsUrl ?? CHUTES_LLM_MODELS_URL, "modelsUrl"),
    apiBase: secureUrl(options.apiBase ?? CHUTES_API_BASE, "apiBase"),
    includeManagement: options.includeManagement ?? true,
    includeUtilization: options.includeUtilization ?? options.includeManagement ?? true,
    managementLimit: boundedOption(options.managementLimit ?? DEFAULT_MANAGEMENT_LIMIT, "managementLimit", 1, 5_000),
    ...(options.authorization ? { authorization: options.authorization } : {}),
    cacheTtlMs,
    staleTtlMs,
    timeoutMs: boundedOption(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 1, 120_000),
    debounceMs: boundedOption(options.debounceMs ?? DEFAULT_DEBOUNCE_MS, "debounceMs", 0, 10_000),
    maxResponseBytes: boundedOption(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      1,
      8 * 1024 * 1024,
    ),
    now: options.now ?? Date.now,
  });
}

function secureUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new TypeError(`${label} must use HTTPS (or loopback HTTP for tests).`);
  }
  if (url.username || url.password) throw new TypeError(`${label} must not contain credentials.`);
  return url.toString();
}

function boundedOption(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function invalidRecordsIssue(source: ModelCatalogSource, count: number): ModelCatalogIssue {
  return Object.freeze({
    source,
    code: "invalid-records",
    message: `${sourceLabel(source)} skipped ${count} malformed or duplicate record${count === 1 ? "" : "s"}.`,
    retryable: false,
    count,
  });
}

function sourceMessage(
  source: ModelCatalogSource,
  code: ModelCatalogIssueCode,
  status?: number,
): string {
  const label = sourceLabel(source);
  switch (code) {
    case "network": return `${label} could not be reached.`;
    case "timeout": return `${label} timed out.`;
    case "http": return `${label} returned HTTP ${status ?? "error"}.`;
    case "invalid-content-type": return `${label} did not return JSON.`;
    case "response-too-large": return `${label} exceeded the safe response limit.`;
    case "invalid-json": return `${label} returned invalid JSON.`;
    case "invalid-payload": return `${label} returned an invalid payload.`;
    case "invalid-records": return `${label} contained invalid records.`;
    case "truncated": return `${label} was truncated.`;
  }
}

function sourceLabel(source: ModelCatalogSource): string {
  return source === "llm-models"
    ? "Chutes inference catalog"
    : source === "chutes-management"
      ? "Chutes management catalog"
      : "Chutes utilization telemetry";
}

function isRetryable(code: ModelCatalogIssueCode, status?: number): boolean {
  if (code === "network" || code === "timeout") return true;
  return code === "http" && (status === 408 || status === 425 || status === 429 || (status ?? 0) >= 500);
}

function withCacheState(
  snapshot: ModelCatalogSnapshot,
  cache: ModelCatalogSnapshot["cache"],
): ModelCatalogSnapshot {
  return Object.freeze({ ...snapshot, cache });
}

function staleSnapshot(cached: ModelCatalogSnapshot, refresh: ModelCatalogSnapshot): ModelCatalogSnapshot {
  return Object.freeze({
    ...cached,
    cache: "stale-memory",
    models: Object.freeze(cached.models.map((model) => model.telemetry
      ? Object.freeze({
          ...model,
          telemetry: Object.freeze({ ...model.telemetry, freshness: "stale" as const }),
        })
      : model)),
    sources: refresh.sources,
    issues: Object.freeze(dedupeIssues([...cached.issues, ...refresh.issues])),
    complete: false,
  });
}

function dedupeIssues(issues: readonly ModelCatalogIssue[]): ModelCatalogIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.source}:${issue.code}:${issue.status ?? ""}:${issue.count ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedHeader(value: string | null): string | undefined {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function createTimeout(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const forward = () => controller.abort(parent.reason);
  parent.addEventListener("abort", forward, { once: true });
  if (parent.aborted) forward();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(abortError("Model catalog request timed out."));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", forward);
    },
  };
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const listener = () => target.abort(source.reason);
  source.addEventListener("abort", listener, { once: true });
  if (source.aborted) listener();
  return () => source.removeEventListener("abort", listener);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : abortError("Operation aborted.");
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}
