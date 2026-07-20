export const CHUTES_ACCOUNT_API_BASE = "https://api.chutes.ai";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 20_000;
const MAX_ARRAY_ITEMS = 2_048;
const MAX_OBJECT_KEYS = 512;
const MAX_STRING_LENGTH = 64 * 1024;
const MAX_CREDENTIAL_LENGTH = 16 * 1024;
const USAGE_PAGE_LIMIT = 1_000;

export type ChutesAccountSource = "account" | "quotas" | "subscription" | "usage";

export type ChutesAccountIssueCode =
  | "http"
  | "network"
  | "invalid-json"
  | "invalid-payload"
  | "response-too-large";

export type ChutesAccountIssue = Readonly<{
  source: ChutesAccountSource;
  code: ChutesAccountIssueCode;
  message: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
}>;

export type ChutesAccountSummary = Readonly<{
  username?: string;
  userId?: string;
  balance?: number;
}>;

export type ChutesSubscriptionWindow = Readonly<{
  usage?: number;
  cap?: number;
  remaining?: number;
  resetAt?: string;
  uncapped?: boolean;
}>;

export type ChutesSubscriptionSummary = Readonly<{
  active: boolean;
  monthlyPrice?: number;
  custom?: boolean;
  monthly?: ChutesSubscriptionWindow;
  fourHour?: ChutesSubscriptionWindow;
}>;

export type ChutesUsageEntry = Readonly<{
  bucket: string;
  cost: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  chuteId?: string;
}>;

export type ChutesUsageSummary = Readonly<{
  entries: readonly ChutesUsageEntry[];
  totalCost: number;
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  rangeStart: string;
  rangeEnd: string;
}>;

export type ChutesQuotaEntry = Readonly<{
  chuteId?: string;
  quota: number | "unlimited";
  effectiveDate?: string;
  updatedAt?: string;
}>;

export type ChutesQuotaSummary = Readonly<{
  entries: readonly ChutesQuotaEntry[];
  rawCount: number;
  unlimited: boolean;
}>;

export type ChutesAccountSnapshot = Readonly<{
  fetchedAt: string;
  account?: ChutesAccountSummary;
  subscription?: ChutesSubscriptionSummary;
  usage?: ChutesUsageSummary;
  quotas?: ChutesQuotaSummary;
  issues: readonly ChutesAccountIssue[];
  complete: boolean;
}>;

export type LoadChutesAccountSnapshotOptions = Readonly<{
  /** A user-scoped OAuth token or API key held only in page memory. */
  credential: string;
  signal: AbortSignal;
  apiBase?: string;
  now?: () => Date | number;
}>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type SourceResult<T> =
  | Readonly<{ source: ChutesAccountSource; value: T }>
  | Readonly<{ source: ChutesAccountSource; issue: ChutesAccountIssue }>;

class PayloadError extends Error {
  constructor(
    readonly code: Extract<ChutesAccountIssueCode, "invalid-json" | "invalid-payload" | "response-too-large">,
    message: string,
  ) {
    super(message);
    this.name = "PayloadError";
  }
}

/**
 * Loads a read-only account snapshot directly from Chutes. All four requests
 * start in parallel and independently contribute to the returned snapshot.
 */
export async function loadChutesAccountSnapshot(
  options: LoadChutesAccountSnapshotOptions,
): Promise<ChutesAccountSnapshot> {
  throwIfAborted(options.signal);
  const credential = normalizeCredential(options.credential);
  const apiBase = normalizeApiBase(options.apiBase ?? CHUTES_ACCOUNT_API_BASE);
  const now = normalizeNow(options.now?.() ?? Date.now());
  const fetchedAt = now.toISOString();
  const rangeStart = utcNaive(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const rangeEnd = utcNaive(now);
  const fetchImpl = resolveFetch();

  const usageUrl = endpointUrl(apiBase, "/users/me/usage");
  usageUrl.searchParams.set("page", "0");
  usageUrl.searchParams.set("limit", String(USAGE_PAGE_LIMIT));
  usageUrl.searchParams.set("start_date", rangeStart);
  usageUrl.searchParams.set("end_date", rangeEnd);

  const requests = [
    captureSource("account", endpointUrl(apiBase, "/users/me"), credential, options.signal, fetchImpl, normalizeAccount),
    captureSource("quotas", endpointUrl(apiBase, "/users/me/quotas"), credential, options.signal, fetchImpl, normalizeQuotas),
    captureSource(
      "subscription",
      endpointUrl(apiBase, "/users/me/subscription_usage"),
      credential,
      options.signal,
      fetchImpl,
      normalizeSubscription,
    ),
    captureSource(
      "usage",
      usageUrl,
      credential,
      options.signal,
      fetchImpl,
      (value) => normalizeUsage(value, rangeStart, rangeEnd),
    ),
  ] as const;

  const results = await Promise.all(requests);
  throwIfAborted(options.signal);

  let account: ChutesAccountSummary | undefined;
  let quotas: ChutesQuotaSummary | undefined;
  let subscription: ChutesSubscriptionSummary | undefined;
  let usage: ChutesUsageSummary | undefined;
  const issues: ChutesAccountIssue[] = [];

  for (const result of results) {
    if ("issue" in result) {
      issues.push(result.issue);
      continue;
    }
    switch (result.source) {
      case "account":
        account = result.value as ChutesAccountSummary;
        break;
      case "quotas":
        quotas = result.value as ChutesQuotaSummary;
        break;
      case "subscription":
        subscription = result.value as ChutesSubscriptionSummary;
        break;
      case "usage":
        usage = result.value as ChutesUsageSummary;
        break;
    }
  }

  return Object.freeze({
    fetchedAt,
    ...(account ? { account } : {}),
    ...(subscription ? { subscription } : {}),
    ...(usage ? { usage } : {}),
    ...(quotas ? { quotas } : {}),
    issues: Object.freeze(issues),
    complete: issues.length === 0,
  });
}

async function captureSource<T>(
  source: ChutesAccountSource,
  url: URL,
  credential: string,
  signal: AbortSignal,
  fetchImpl: FetchLike,
  normalize: (value: unknown) => T,
): Promise<SourceResult<T>> {
  try {
    const response = await abortable(
      fetchImpl(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential}`,
        },
      }),
      signal,
    );
    if (!response.ok) return { source, issue: httpIssue(source, response) };
    const value = await readJsonBounded(response, signal);
    return { source, value: normalize(value) };
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortReason(signal, error);
    if (error instanceof PayloadError) {
      return {
        source,
        issue: Object.freeze({
          source,
          code: error.code,
          message: sourceMessage(source, error.code),
          retryable: false,
        }),
      };
    }
    return {
      source,
      issue: Object.freeze({
        source,
        code: "network",
        message: `${sourceLabel(source)} telemetry could not be reached.`,
        retryable: true,
      }),
    };
  }
}

function normalizeAccount(value: unknown): ChutesAccountSummary {
  const record = requireRecord(value, "account");
  const username = optionalBoundedString(record, ["username", "name"], "account username", 256);
  const userId = optionalBoundedString(record, ["user_id", "userId", "id"], "account user ID", 512);
  let balance = optionalFiniteNumber(record, ["balance"], "account balance");
  if (balance === undefined && isRecord(record.current_balance)) {
    balance = optionalFiniteNumber(
      record.current_balance,
      ["effective_balance", "effectiveBalance", "balance"],
      "account balance",
    );
  }
  if (username === undefined && userId === undefined && balance === undefined) {
    throw new PayloadError("invalid-payload", "Account response contains no recognized account fields.");
  }
  return Object.freeze({ username, userId, balance });
}

function normalizeSubscription(value: unknown): ChutesSubscriptionSummary {
  const record = requireRecord(value, "subscription");
  const activeRaw = firstPresent(record, ["subscription", "active"]);
  if (typeof activeRaw !== "boolean") {
    throw new PayloadError("invalid-payload", "Subscription response has no boolean subscription state.");
  }
  const customRaw = firstPresent(record, ["custom", "is_custom", "isCustom"]);
  if (customRaw !== undefined && typeof customRaw !== "boolean") {
    throw new PayloadError("invalid-payload", "Subscription custom state must be boolean.");
  }
  const monthlyPrice = optionalNonNegativeNumber(
    record,
    ["monthly_price", "monthlyPrice"],
    "subscription monthly price",
  );
  const monthly = normalizeSubscriptionWindow(firstPresent(record, ["monthly"]), "monthly");
  const fourHour = normalizeSubscriptionWindow(
    firstPresent(record, ["four_hour", "fourHour"]),
    "four-hour",
  );
  return Object.freeze({
    active: activeRaw,
    monthlyPrice,
    custom: customRaw,
    monthly,
    fourHour,
  });
}

function normalizeSubscriptionWindow(
  value: unknown,
  label: string,
): ChutesSubscriptionWindow | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireRecord(value, `${label} subscription window`);
  const uncappedRaw = firstPresent(record, ["uncapped"]);
  if (uncappedRaw !== undefined && typeof uncappedRaw !== "boolean") {
    throw new PayloadError("invalid-payload", `${label} subscription uncapped state must be boolean.`);
  }
  const usage = optionalNonNegativeNumber(record, ["usage", "used"], `${label} subscription usage`);
  const cap = optionalNonNegativeNumber(record, ["cap", "limit"], `${label} subscription cap`);
  const remaining = optionalNonNegativeNumber(
    record,
    ["remaining"],
    `${label} subscription remaining amount`,
  );
  const resetAt = optionalBoundedString(
    record,
    ["reset_at", "resetAt"],
    `${label} subscription reset time`,
    256,
  );
  if (uncappedRaw === undefined && usage === undefined && cap === undefined && remaining === undefined && resetAt === undefined) {
    throw new PayloadError("invalid-payload", `${label} subscription window is empty.`);
  }
  return Object.freeze({ usage, cap, remaining, resetAt, uncapped: uncappedRaw });
}

function normalizeUsage(value: unknown, rangeStart: string, rangeEnd: string): ChutesUsageSummary {
  const record = requireRecord(value, "usage");
  const items = firstPresent(record, ["items", "entries", "data"]);
  if (!Array.isArray(items)) {
    throw new PayloadError("invalid-payload", "Usage response items must be an array.");
  }
  if (items.length > USAGE_PAGE_LIMIT) {
    throw new PayloadError("invalid-payload", "Usage response contains too many entries.");
  }
  const entries = items.map((item, index) => normalizeUsageEntry(item, index));
  let totalCost = 0;
  let totalRequests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const entry of entries) {
    totalCost = addFinite(totalCost, entry.cost, "usage cost");
    totalRequests = addSafeInteger(totalRequests, entry.requests, "usage request count");
    inputTokens = addSafeInteger(inputTokens, entry.inputTokens, "usage input-token count");
    outputTokens = addSafeInteger(outputTokens, entry.outputTokens, "usage output-token count");
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    totalCost,
    totalRequests,
    inputTokens,
    outputTokens,
    rangeStart,
    rangeEnd,
  });
}

function normalizeUsageEntry(value: unknown, index: number): ChutesUsageEntry {
  const record = requireRecord(value, `usage item ${index}`);
  const bucket = requiredBoundedString(record, ["bucket", "timestamp", "date"], `usage item ${index} bucket`, 256);
  const cost = requiredNonNegativeNumber(record, ["amount", "cost", "total_cost"], `usage item ${index} cost`);
  const requests = requiredNonNegativeSafeInteger(
    record,
    ["count", "requests", "total_requests"],
    `usage item ${index} request count`,
  );
  const inputTokens = requiredNonNegativeSafeInteger(
    record,
    ["input_tokens", "inputTokens"],
    `usage item ${index} input tokens`,
  );
  const outputTokens = requiredNonNegativeSafeInteger(
    record,
    ["output_tokens", "outputTokens"],
    `usage item ${index} output tokens`,
  );
  const chuteId = optionalBoundedString(record, ["chute_id", "chuteId"], `usage item ${index} chute ID`, 512);
  return Object.freeze({ bucket, cost, requests, inputTokens, outputTokens, chuteId });
}

function normalizeQuotas(value: unknown): ChutesQuotaSummary {
  const rawItems = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : undefined;
  let entries: ChutesQuotaEntry[];
  let rawCount: number;

  if (rawItems) {
    rawCount = rawItems.length;
    entries = rawItems.map((item, index) => normalizeQuotaRecord(item, index));
  } else {
    const record = requireRecord(value, "quotas");
    const mapped = Object.entries(record);
    rawCount = mapped.length;
    entries = mapped.map(([chuteId, rawQuota], index) => {
      if (isRecord(rawQuota)) {
        return normalizeQuotaRecord({ ...rawQuota, chute_id: rawQuota.chute_id ?? chuteId }, index);
      }
      return Object.freeze({
        chuteId,
        quota: normalizeQuotaValue(rawQuota, `quota ${chuteId}`),
      });
    });
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    rawCount,
    // Only an explicit quota value establishes an unlimited claim. An empty
    // response has no limit semantics and remains unknown at presentation time.
    unlimited: entries.some((entry) => entry.quota === "unlimited"),
  });
}

function normalizeQuotaRecord(value: unknown, index: number): ChutesQuotaEntry {
  const record = requireRecord(value, `quota item ${index}`);
  const chuteId = optionalBoundedString(record, ["chute_id", "chuteId"], `quota item ${index} chute ID`, 512);
  const rawQuota = firstPresent(record, ["quota", "limit"]);
  if (rawQuota === undefined) {
    throw new PayloadError("invalid-payload", `Quota item ${index} has no quota value.`);
  }
  const quota = normalizeQuotaValue(rawQuota, `quota item ${index}`);
  const effectiveDate = optionalBoundedString(
    record,
    ["effective_date", "effectiveDate"],
    `quota item ${index} effective date`,
    256,
  );
  const updatedAt = optionalBoundedString(
    record,
    ["updated_at", "updatedAt"],
    `quota item ${index} update time`,
    256,
  );
  return Object.freeze({ chuteId, quota, effectiveDate, updatedAt });
}

function normalizeQuotaValue(value: unknown, label: string): number | "unlimited" {
  if (typeof value === "string" && value.toLowerCase() === "unlimited") return "unlimited";
  const number = finiteNumber(value);
  if (number === undefined || number < 0) {
    throw new PayloadError("invalid-payload", `${label} must be non-negative or unlimited.`);
  }
  return number;
}

async function readJsonBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new PayloadError("response-too-large", "Telemetry response exceeds the byte limit.");
  }
  const text = await readTextBounded(response, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PayloadError("invalid-json", "Telemetry response is not valid JSON.");
  }
  validateJson(parsed);
  return parsed;
}

async function readTextBounded(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("response-too-large").catch(() => undefined);
        throw new PayloadError("response-too-large", "Telemetry response exceeds the byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    if (signal.aborted) await reader.cancel(abortReason(signal)).catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // A hostile custom stream may retain a pending read after cancellation.
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
    throw new PayloadError("invalid-json", "Telemetry response is not valid UTF-8.");
  }
}

function validateJson(value: unknown): void {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new PayloadError("invalid-payload", "Telemetry response is too complex.");
    }
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new PayloadError("invalid-payload", "Telemetry contains a non-finite number.");
      return;
    }
    if (typeof candidate === "string") {
      if (candidate.length > MAX_STRING_LENGTH) throw new PayloadError("invalid-payload", "Telemetry contains an oversized string.");
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_ARRAY_ITEMS) throw new PayloadError("invalid-payload", "Telemetry array is too large.");
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (!isRecord(candidate)) throw new PayloadError("invalid-payload", "Telemetry contains an unsupported value.");
    const entries = Object.entries(candidate);
    if (entries.length > MAX_OBJECT_KEYS) throw new PayloadError("invalid-payload", "Telemetry object has too many keys.");
    for (const [key, item] of entries) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new PayloadError("invalid-payload", "Telemetry contains a forbidden object key.");
      }
      if (key.length > 512) throw new PayloadError("invalid-payload", "Telemetry contains an oversized object key.");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function httpIssue(source: ChutesAccountSource, response: Response): ChutesAccountIssue {
  const requestId = safeHeader(response.headers.get("x-request-id") ?? response.headers.get("cf-ray"));
  return Object.freeze({
    source,
    code: "http",
    message: `${sourceLabel(source)} telemetry returned HTTP ${response.status}.`,
    status: response.status,
    requestId,
    retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
  });
}

function sourceMessage(source: ChutesAccountSource, code: PayloadError["code"]): string {
  switch (code) {
    case "invalid-json":
      return `${sourceLabel(source)} telemetry was not valid JSON.`;
    case "response-too-large":
      return `${sourceLabel(source)} telemetry exceeded the safe response limit.`;
    case "invalid-payload":
      return `${sourceLabel(source)} telemetry had an unsupported shape.`;
  }
}

function sourceLabel(source: ChutesAccountSource): string {
  return source[0].toUpperCase() + source.slice(1);
}

function normalizeCredential(value: string): string {
  if (typeof value !== "string") throw new TypeError("A Chutes credential is required.");
  const credential = value.trim();
  if (!credential) throw new TypeError("A Chutes credential is required.");
  if (
    !(credential.startsWith("cak_") || credential.startsWith("cpk_"))
    || credential.length > MAX_CREDENTIAL_LENGTH
    || /[\u0000-\u0020\u007f]/u.test(credential)
  ) {
    throw new TypeError("The Chutes credential has an invalid format.");
  }
  return credential;
}

function normalizeApiBase(value: string): string {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new TypeError("The Chutes API base must use HTTPS, except for localhost development.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError("The Chutes API base must be an origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

function endpointUrl(apiBase: string, path: string): URL {
  return new URL(path, `${apiBase}/`);
}

function normalizeNow(value: Date | number): Date {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError("The account snapshot clock returned an invalid date.");
  return result;
}

function utcNaive(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/u, "");
}

function resolveFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") throw new TypeError("Fetch is required to load Chutes account telemetry.");
  return globalThis.fetch.bind(globalThis);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PayloadError("invalid-payload", `${label} response must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstPresent(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) return record[key];
  }
  return undefined;
}

function optionalBoundedString(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  maxLength: number,
): string | undefined {
  const value = firstPresent(record, keys);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PayloadError("invalid-payload", `${label} must be a bounded string.`);
  }
  return value;
}

function requiredBoundedString(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  maxLength: number,
): string {
  const value = optionalBoundedString(record, keys, label, maxLength);
  if (value === undefined) throw new PayloadError("invalid-payload", `${label} is required.`);
  return value;
}

function optionalNonNegativeNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): number | undefined {
  const value = firstPresent(record, keys);
  if (value === undefined || value === null) return undefined;
  const result = finiteNumber(value);
  if (result === undefined || result < 0) {
    throw new PayloadError("invalid-payload", `${label} must be a non-negative finite number.`);
  }
  return result;
}

function optionalFiniteNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): number | undefined {
  const value = firstPresent(record, keys);
  if (value === undefined || value === null) return undefined;
  const result = finiteNumber(value);
  if (result === undefined) {
    throw new PayloadError("invalid-payload", `${label} must be a finite number.`);
  }
  return result;
}

function requiredNonNegativeNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): number {
  const value = optionalNonNegativeNumber(record, keys, label);
  if (value === undefined) throw new PayloadError("invalid-payload", `${label} is required.`);
  return value;
}

function requiredNonNegativeSafeInteger(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): number {
  const value = requiredNonNegativeNumber(record, keys, label);
  if (!Number.isSafeInteger(value)) throw new PayloadError("invalid-payload", `${label} must be a safe integer.`);
  return value;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function addFinite(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isFinite(result)) throw new PayloadError("invalid-payload", `${label} overflowed.`);
  return result;
}

function addSafeInteger(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new PayloadError("invalid-payload", `${label} overflowed.`);
  return result;
}

function safeHeader(value: string | null): string | undefined {
  if (!value || value.length > 256 || !/^[\x21-\x7e]+$/u.test(value)) return undefined;
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal, fallback?: unknown): unknown {
  if (signal.aborted && signal.reason instanceof Error) return signal.reason;
  if (isAbortError(fallback)) return fallback;
  return new DOMException("The Chutes account request was aborted.", "AbortError");
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException
    ? value.name === "AbortError"
    : value instanceof Error && value.name === "AbortError";
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
