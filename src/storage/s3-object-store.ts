import { ownedArrayBuffer } from "../core/bytes";
import type {
  CompareAndSwapResult,
  ObjectRange,
  ObjectReclamationOutcome,
  ObjectReclamationReceipt,
  ObjectRecord,
  ObjectSummary,
  ReclaimableObjectStore,
  PutIfAbsentResult,
  ObjectStoreCapabilities,
} from "./object-store";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_OBJECT_BYTES = 96 * 1024 * 1024;
const MAX_RANGE_BYTES = 16 * 1024 * 1024;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_LIST_PAGES = 100;
const MAX_LIST_OBJECTS = 100_000;
const MAX_ERROR_BYTES = 16 * 1024;
const MIN_READ_CREDENTIAL_TTL_MS = 60_000;
const MIN_WRITE_CREDENTIAL_TTL_MS = 120_000;
const ASSUMED_MINIMUM_UPLOAD_BYTES_PER_SECOND = 256 * 1024;
const MAX_READ_ATTEMPTS = 3;

export type S3TemporaryCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: string;
};

export interface S3CredentialProvider {
  /** Return short-lived, prefix-scoped credentials. Implementations must not persist them. */
  getCredentials(signal?: AbortSignal): Promise<S3TemporaryCredentials>;
}

export type S3ObjectStoreOptions = {
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  forcePathStyle?: boolean;
  credentialProvider: S3CredentialProvider;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
  /** Unsafe escape hatch for local emulators only. Production vaults require expiring session credentials. */
  allowPermanentCredentialsForDevelopment?: boolean;
};

export class S3StorageError extends Error {
  constructor(
    message: string,
    readonly details: {
      status?: number;
      code?: string;
      requestId?: string;
      retryable: boolean;
      commitState: "not-applicable" | "not-committed" | "unknown";
      bucketRegion?: string;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "S3StorageError";
  }
}

/** A real S3 REST adapter: SigV4, exact ranges, conditional creates/CAS, and ListObjectsV2. */
export class S3ObjectStore implements ReclaimableObjectStore {
  readonly capabilities: ObjectStoreCapabilities = Object.freeze({
    version: 1,
    adapter: "s3",
    rangeRead: Object.freeze({ mode: "exact-or-fail", maxBytes: MAX_RANGE_BYTES, providerEvidence: "live-conformance-required" }),
    conditionalWrite: Object.freeze({ createIfAbsent: "atomic-or-fail", compareAndSwap: "atomic-or-fail", providerEvidence: "live-conformance-required" }),
    upload: Object.freeze({ mode: "single-request", interruptionRecovery: "retry-immutable-shard", persistsResumeCapability: false }),
  });
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly forcePathStyle: boolean;
  private readonly credentialProvider: S3CredentialProvider;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private readonly allowPermanentCredentialsForDevelopment: boolean;

  constructor(options: S3ObjectStoreOptions) {
    this.endpoint = validateEndpoint(options.endpoint);
    this.region = s3Region(options.region);
    this.bucket = bucketName(options.bucket);
    this.prefix = normalizePrefix(options.prefix ?? "");
    this.forcePathStyle = options.forcePathStyle ?? true;
    if (!this.forcePathStyle && this.bucket.includes(".")) {
      throw new Error("Virtual-host S3 mode refuses dotted bucket names because they weaken exact-origin TLS/CSP assumptions.");
    }
    this.credentialProvider = options.credentialProvider;
    // Window.fetch is a Web IDL method and some browsers reject calls whose
    // receiver is the S3ObjectStore instance ("Illegal invocation"). Binding
    // the ambient implementation also keeps dependency-injected test and
    // worker fetch functions untouched.
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.allowPermanentCredentialsForDevelopment = options.allowPermanentCredentialsForDevelopment ?? false;
    if (this.allowPermanentCredentialsForDevelopment && !isLocalEndpoint(this.endpoint)) {
      throw new Error("Permanent S3 credentials may be enabled only for a localhost development endpoint.");
    }
  }

  async get(key: string, signal?: AbortSignal): Promise<ObjectRecord | undefined> {
    const response = await this.request("GET", this.objectUrl(key), { signal });
    if (response.status === 404) {
      await discardBody(response);
      return undefined;
    }
    if (!response.ok) throw await responseError("get S3 object", response);
    const declaredLength = parseOptionalLength(response.headers.get("content-length"));
    if (declaredLength !== undefined && declaredLength > MAX_OBJECT_BYTES) {
      await discardBody(response);
      throw new Error("S3 object exceeds the client limit.");
    }
    const etag = requiredEtag(response.headers.get("etag"));
    const bytes = await readBoundedBytes(response, MAX_OBJECT_BYTES, "S3 object");
    return {
      key,
      bytes,
      etag,
      updatedAt: response.headers.get("last-modified") ?? undefined,
    };
  }

  async getRange(
    key: string,
    start: number,
    endExclusive: number,
    signal?: AbortSignal,
  ): Promise<ObjectRange | undefined> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive <= start) {
      throw new Error("S3 ranges require non-negative, increasing integer offsets.");
    }
    const length = endExclusive - start;
    if (length > MAX_RANGE_BYTES) throw new Error("S3 range exceeds the client limit.");
    const response = await this.request("GET", this.objectUrl(key), {
      headers: { Range: `bytes=${start}-${endExclusive - 1}` },
      signal,
    });
    if (response.status === 404) {
      await discardBody(response);
      return undefined;
    }
    if (!response.ok) throw await responseError("get S3 object range", response);
    if (response.status !== 206) {
      await discardBody(response);
      throw new Error("S3 provider ignored the byte range request.");
    }
    const range = parseContentRange(response.headers.get("content-range"));
    if (!range || range.start !== start || range.endExclusive !== endExclusive) {
      await discardBody(response);
      throw new Error("S3 provider returned a missing or mismatched Content-Range header.");
    }
    const declaredLength = parseOptionalLength(response.headers.get("content-length"));
    if (declaredLength !== undefined && declaredLength !== length) {
      await discardBody(response);
      throw new Error("S3 provider declared the wrong byte count.");
    }
    const etag = requiredEtag(response.headers.get("etag"));
    const bytes = await readBoundedBytes(response, length, "S3 object range", length);
    if (bytes.byteLength !== length) throw new Error("S3 provider returned the wrong byte count.");
    return {
      key,
      bytes,
      etag,
      start,
      endExclusive,
      totalSize: range.totalSize,
    };
  }

  async putIfAbsent(
    key: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<PutIfAbsentResult> {
    checkObjectSize(bytes);
    const response = await this.conditionalWrite(this.objectUrl(key), {
      body: bytes,
      headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" },
      signal,
    });
    if (response.status === 412) {
      const currentEtag = normalizeEtag(response.headers.get("etag"));
      await discardBody(response);
      return { currentEtag, created: false, reason: "exists" };
    }
    if (response.status === 409) {
      throw await responseError("create S3 object", response, {
        retryable: true,
        commitState: "not-committed",
      });
    }
    if (!response.ok) {
      throw await responseError("create S3 object", response, { commitState: "unknown" });
    }
    return { etag: requiredEtag(response.headers.get("etag")), created: true };
  }

  async compareAndSwap(
    key: string,
    expectedEtag: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<CompareAndSwapResult> {
    checkObjectSize(bytes);
    const etag = headerValue(expectedEtag, "expected S3 ETag");
    const response = await this.conditionalWrite(this.objectUrl(key), {
      body: bytes,
      headers: { "Content-Type": "application/octet-stream", "If-Match": quoteEtag(etag) },
      signal,
    });
    if (response.status === 404 || response.status === 412) {
      const currentEtag = normalizeEtag(response.headers.get("etag"));
      const reason = response.status === 404 ? "missing" : "precondition-failed";
      await discardBody(response);
      return { currentEtag, updated: false, reason };
    }
    if (response.status === 409) {
      throw await responseError("compare-and-swap S3 object", response, {
        retryable: true,
        commitState: "not-committed",
      });
    }
    if (!response.ok) {
      throw await responseError("compare-and-swap S3 object", response, { commitState: "unknown" });
    }
    return { etag: requiredEtag(response.headers.get("etag")), updated: true };
  }

  async list(prefix: string, signal?: AbortSignal): Promise<ObjectSummary[]> {
    const logicalPrefix = objectKey(prefix, true);
    const remotePrefix = `${this.prefix}${logicalPrefix}`;
    checkS3KeyLength(remotePrefix, "S3 list prefix");
    const output: ObjectSummary[] = [];
    const seenKeys = new Set<string>();
    let continuationToken: string | undefined;
    const seenTokens = new Set<string>();
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const url = this.bucketUrl();
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", remotePrefix);
      url.searchParams.set("max-keys", "1000");
      if (continuationToken) url.searchParams.set("continuation-token", continuationToken);
      const response = await this.request("GET", url, { signal });
      if (!response.ok) throw await responseError("list S3 objects", response);
      const body = await boundedText(response, MAX_LIST_BYTES, "S3 list response");
      const parsed = parseListObjectsV2(body);
      for (const item of parsed.objects) {
        if (!item.key.startsWith(remotePrefix)) throw new Error("S3 list escaped the requested namespace prefix.");
        if (seenKeys.has(item.key)) throw new Error("S3 list repeated an object key across pages.");
        seenKeys.add(item.key);
        const logicalKey = item.key.slice(this.prefix.length);
        objectKey(logicalKey);
        output.push({ ...item, key: logicalKey });
        if (output.length > MAX_LIST_OBJECTS) throw new Error("S3 list exceeds the client object limit.");
      }
      if (!parsed.isTruncated) return output;
      if (!parsed.nextContinuationToken || seenTokens.has(parsed.nextContinuationToken)) {
        throw new Error("S3 returned an invalid continuation token.");
      }
      continuationToken = parsed.nextContinuationToken;
      seenTokens.add(continuationToken);
    }
    throw new Error("S3 list exceeds the client page limit.");
  }

  /**
   * Reclamation over `DeleteObject`, one key at a time.
   *
   * Without this the S3/MinIO tier — the durability most Airship users select —
   * was the one that could not delete a conversation, so "Export, migrate,
   * delete, or self-host all state" was false for them specifically. The bucket
   * has always been able to do it; nothing here asked.
   *
   * Deliberately not `DeleteObjects` (the batch POST): that endpoint reports
   * per-key errors inside a 200 body, and a receipt whose whole job is to
   * separate confirmed removals from retained ones must not have to parse a
   * success to discover a failure. One request per key is slower and cannot lie.
   *
   * S3 delete is idempotent — a missing key answers 204 — so an absent object
   * is reported as `not-indexed` only when the caller can be told nothing more
   * useful, and any non-2xx is `refused` rather than thrown: a receipt that
   * removed nine of ten objects is more useful than an exception that loses the
   * nine.
   */
  async trash(keys: readonly string[], signal?: AbortSignal): Promise<ObjectReclamationReceipt> {
    const requested = [...new Set(keys)];
    const outcomes: ObjectReclamationOutcome[] = [];
    for (const key of requested) {
      try {
        const response = await this.request("DELETE", this.objectUrl(key), { signal });
        await discardBody(response);
        outcomes.push(Object.freeze(response.ok || response.status === 404
          ? { key, reclaimed: true as const }
          : { key, reclaimed: false as const, reason: "refused" as const }));
      } catch (error) {
        if (signal?.aborted) throw error;
        outcomes.push(Object.freeze({ key, reclaimed: false as const, reason: "unconfirmed" as const }));
      }
    }
    return Object.freeze({
      requested: requested.length,
      reclaimed: Object.freeze(outcomes.filter((outcome) => outcome.reclaimed).map((outcome) => outcome.key)),
      retained: Object.freeze(outcomes.filter((outcome) => !outcome.reclaimed).map((outcome) => outcome.key)),
      outcomes: Object.freeze(outcomes),
    });
  }

  private objectUrl(key: string): URL {
    const remoteKey = `${this.prefix}${objectKey(key)}`;
    checkS3KeyLength(remoteKey, "S3 object key");
    const url = this.bucketUrl();
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/${encodeS3Key(remoteKey)}`;
    return url;
  }

  private bucketUrl(): URL {
    const url = new URL(this.endpoint);
    if (this.forcePathStyle) {
      url.pathname = `${url.pathname.replace(/\/$/u, "")}/${uriEncode(this.bucket)}`;
    } else {
      url.hostname = `${this.bucket}.${url.hostname}`;
    }
    return url;
  }

  private async conditionalWrite(
    url: URL,
    options: { headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
  ): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.request("PUT", url, options);
      if (response.status !== 409 || attempt === 2) return response;
      const delay = retryDelayMs(response.headers.get("retry-after"), attempt, this.now());
      await discardBody(response);
      await abortableDelay(delay, options.signal);
    }
    throw new Error("S3 conditional-write retry loop exhausted unexpectedly.");
  }

  private async request(
    method: "GET" | "PUT" | "DELETE",
    url: URL,
    options: { headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal },
  ): Promise<Response> {
    const minimumTtlMs = options.body
      ? Math.min(
          15 * 60_000,
          MIN_WRITE_CREDENTIAL_TTL_MS + Math.ceil(options.body.byteLength / ASSUMED_MINIMUM_UPLOAD_BYTES_PER_SECOND) * 1_000,
        )
      : MIN_READ_CREDENTIAL_TTL_MS;
    const payloadHash = options.body ? await sha256Hex(options.body) : EMPTY_SHA256;
    const wireUrl = new URL(url);
    wireUrl.search = canonicalQuery(wireUrl.searchParams);
    const attempts = method === "GET" ? MAX_READ_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const now = this.now();
      const credentials = validateCredentials(
        await this.credentialProvider.getCredentials(options.signal),
        now,
        minimumTtlMs,
        this.allowPermanentCredentialsForDevelopment,
      );
      const signed = await signS3Request({
        method,
        url: wireUrl,
        region: this.region,
        credentials,
        headers: options.headers,
        payloadHash,
        now,
      });
      try {
        const response = await this.fetchImplementation(wireUrl, {
          method,
          headers: signed.headers,
          body: options.body ? ownedArrayBuffer(options.body) : undefined,
          cache: "no-store",
          credentials: "omit",
          mode: "cors",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: options.signal,
        });
        if (method === "GET" && isRetryableReadStatus(response.status) && attempt + 1 < attempts) {
          const delay = retryDelayMs(response.headers.get("retry-after"), attempt, now);
          await discardBody(response);
          await abortableDelay(delay, options.signal);
          continue;
        }
        return response;
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        if (method === "GET" && attempt + 1 < attempts) {
          await abortableDelay(retryDelayMs(undefined, attempt, now), options.signal);
          continue;
        }
        throw new S3StorageError(
          `${method} S3 request failed before a response was available.`,
          {
            retryable: true,
            commitState: method === "PUT" ? "unknown" : "not-applicable",
          },
          { cause },
        );
      }
    }
    throw new Error("S3 request retry loop exhausted unexpectedly.");
  }
}

export async function signS3Request(args: {
  method: string;
  url: URL;
  region: string;
  credentials: S3TemporaryCredentials;
  headers?: Record<string, string>;
  payloadHash: string;
  now: Date;
}): Promise<{ headers: Headers; canonicalRequest: string; stringToSign: string; signature: string }> {
  const amzDate = formatAmzDate(args.now);
  const shortDate = amzDate.slice(0, 8);
  const headers = new Headers(args.headers);
  headers.set("x-amz-content-sha256", args.payloadHash);
  headers.set("x-amz-date", amzDate);
  if (args.credentials.sessionToken) headers.set("x-amz-security-token", args.credentials.sessionToken);

  const canonicalHeaderValues = new Map<string, string>();
  canonicalHeaderValues.set("host", args.url.host);
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (lower === "authorization") continue;
    canonicalHeaderValues.set(lower, value.trim().replace(/\s+/gu, " "));
  }
  const sortedHeaders = [...canonicalHeaderValues].sort(([left], [right]) => asciiCompare(left, right));
  const canonicalHeaders = sortedHeaders.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = sortedHeaders.map(([name]) => name).join(";");
  const canonicalRequest = [
    args.method.toUpperCase(),
    canonicalPath(args.url.pathname),
    canonicalQuery(args.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join("\n");
  const scope = `${shortDate}/${args.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(new TextEncoder().encode(canonicalRequest))].join("\n");
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${args.credentials.secretAccessKey}`), shortDate);
  const regionKey = await hmac(dateKey, args.region);
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  headers.set(
    "Authorization",
    `AWS4-HMAC-SHA256 Credential=${args.credentials.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  );
  return { headers, canonicalRequest, stringToSign, signature };
}

function validateEndpoint(value: string): URL {
  const url = new URL(value);
  const local = isLocalEndpoint(url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("S3 endpoints must use HTTPS outside local development.");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("S3 endpoint must not contain credentials, query, or fragment.");
  return url;
}

function isLocalEndpoint(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function validateCredentials(
  credentials: S3TemporaryCredentials,
  now: Date,
  minimumTtlMs: number,
  allowPermanentCredentialsForDevelopment: boolean,
): S3TemporaryCredentials {
  const accessKeyId = headerValue(credentials.accessKeyId, "S3 access key ID");
  const secretAccessKey = headerValue(credentials.secretAccessKey, "S3 secret access key");
  const sessionToken = credentials.sessionToken
    ? headerValue(credentials.sessionToken, "S3 session token")
    : undefined;
  const expiration = credentials.expiration?.trim();
  if (!allowPermanentCredentialsForDevelopment && (!sessionToken || !expiration)) {
    throw new Error("Production S3 vaults require an expiring session token; permanent credentials are refused.");
  }
  if (expiration) {
    const expiresAt = Date.parse(expiration);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() + minimumTtlMs) {
      throw new Error("S3 temporary credentials are expired or too close to expiry for this operation.");
    }
  }
  return { accessKeyId, secretAccessKey, sessionToken, expiration };
}

function headerValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed)) throw new Error(`${label} is invalid.`);
  return trimmed;
}

function s3Region(value: string): string {
  const region = headerValue(value, "S3 region");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(region)) throw new Error("S3 region is invalid.");
  return region;
}

function bucketName(value: string): string {
  const bucket = headerValue(value, "S3 bucket");
  if (
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucket) ||
    bucket.includes("..") ||
    bucket.includes(".-") ||
    bucket.includes("-.") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(bucket)
  ) {
    throw new Error("S3 bucket must be a DNS-compatible bucket name.");
  }
  return bucket;
}

function normalizePrefix(value: string): string {
  if (!value) return "";
  if (value.startsWith("/") || value.endsWith("//")) throw new Error("S3 prefix is invalid.");
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  validateLogicalPath(normalized, "S3 prefix");
  return `${normalized}/`;
}

function objectKey(value: string, allowEmpty = false): string {
  if (allowEmpty && value === "") return "";
  if (allowEmpty && value.endsWith("/")) {
    validateLogicalPath(value.slice(0, -1), "S3 object key");
    return value;
  }
  validateLogicalPath(value, "S3 object key");
  return value;
}

function validateLogicalPath(value: string, label: string): void {
  if (!value || value.startsWith("/") || /[\0-\x1f\x7f\\]/u.test(value)) throw new Error(`${label} is invalid.`);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an empty or relative path segment.`);
  }
}

function checkS3KeyLength(value: string, label: string): void {
  if (new TextEncoder().encode(value).byteLength > 1_024) throw new Error(`${label} exceeds the S3 key limit.`);
}

function encodeS3Key(value: string): string {
  return value.split("/").map(uriEncode).join("/");
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join("/") || "/";
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => asciiCompare(leftName, rightName) || asciiCompare(leftValue, rightValue))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatAmzDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("S3 signing time is invalid.");
  return value.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ownedArrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes))));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function checkObjectSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error("S3 object exceeds the client limit.");
}

function requiredEtag(value: string | null): string {
  const etag = normalizeEtag(value);
  if (!etag) throw new Error("S3 response did not expose a usable ETag; check bucket CORS.");
  return etag;
}

function normalizeEtag(value: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("W/") || /[\r\n]/u.test(trimmed)) throw new Error("S3 returned a weak or invalid ETag.");
  const quoted = trimmed.startsWith('"') || trimmed.endsWith('"');
  if (quoted && !(trimmed.startsWith('"') && trimmed.endsWith('"'))) throw new Error("S3 returned a malformed ETag.");
  const normalized = quoted ? trimmed.slice(1, -1) : trimmed;
  if (!normalized || normalized.includes('"')) throw new Error("S3 returned a malformed ETag.");
  return normalized;
}

function quoteEtag(value: string): string {
  const normalized = normalizeEtag(value);
  if (!normalized) throw new Error("Expected S3 ETag is invalid.");
  return `"${normalized}"`;
}

function parseOptionalLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("S3 returned an invalid Content-Length header.");
  return parsed;
}

function parseContentRange(value: string | null): { start: number; endExclusive: number; totalSize?: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value.trim());
  if (!match) throw new Error("S3 returned an invalid Content-Range header.");
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  const totalSize = match[3] === "*" ? undefined : Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endInclusive) ||
    endInclusive < start ||
    (totalSize !== undefined &&
      (!Number.isSafeInteger(totalSize) || totalSize <= 0 || start >= totalSize || endInclusive >= totalSize))
  ) {
    throw new Error("S3 returned invalid range offsets.");
  }
  return { start, endExclusive: endInclusive + 1, totalSize };
}

function parseListObjectsV2(xml: string): {
  objects: ObjectSummary[];
  isTruncated: boolean;
  nextContinuationToken?: string;
} {
  const rootOpenings = [...xml.matchAll(/<ListBucketResult(?:\s|>)/gu)].length;
  const rootClosings = [...xml.matchAll(/<\/ListBucketResult>/gu)].length;
  if (
    !/^\s*(?:<\?xml[^?]*\?>\s*)?<ListBucketResult(?:\s|>)[\s\S]*<\/ListBucketResult>\s*$/u.test(xml) ||
    rootOpenings !== 1 ||
    rootClosings !== 1 ||
    /<!DOCTYPE|<!ENTITY/iu.test(xml)
  ) {
    throw new Error("S3 returned an invalid ListObjectsV2 document.");
  }
  const objects: ObjectSummary[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
    const block = match[1]!;
    const key = requiredXmlText(block, "Key");
    const etag = normalizeEtag(requiredXmlText(block, "ETag"));
    const size = Number(requiredXmlText(block, "Size"));
    const updatedAt = optionalXmlText(block, "LastModified");
    if (
      !etag ||
      new TextEncoder().encode(key).byteLength > 1_024 ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error("S3 returned invalid object metadata.");
    }
    objects.push({ key, etag, size, updatedAt });
  }
  const truncationMarkers = [...xml.matchAll(/<IsTruncated>([\s\S]*?)<\/IsTruncated>/gu)];
  if (truncationMarkers.length !== 1) throw new Error("S3 list must contain exactly one truncation marker.");
  const isTruncatedText = decodeXml(truncationMarkers[0]![1]!);
  if (isTruncatedText !== "true" && isTruncatedText !== "false") throw new Error("S3 returned an invalid truncation marker.");
  const nextContinuationToken = optionalXmlText(xml, "NextContinuationToken");
  if (nextContinuationToken && nextContinuationToken.length > 16_384) {
    throw new Error("S3 returned an oversized continuation token.");
  }
  return {
    objects,
    isTruncated: isTruncatedText === "true",
    nextContinuationToken,
  };
}

function requiredXmlText(xml: string, tag: string): string {
  const value = optionalXmlText(xml, tag);
  if (value === undefined) throw new Error(`S3 list is missing ${tag}.`);
  return value;
}

function optionalXmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "u").exec(xml);
  return match ? decodeXml(match[1]!) : undefined;
}

function decodeXml(value: string): string {
  const entity = /&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/giu;
  if (/&(?!lt;|gt;|quot;|apos;|amp;|#\d+;|#x[0-9a-f]+;)/iu.test(value)) {
    throw new Error("S3 list contains an invalid XML entity.");
  }
  return value.replace(entity, (_, token: string) => {
    const lower = token.toLowerCase();
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "amp") return "&";
    if (lower.startsWith("#x")) return xmlCodePoint(Number.parseInt(lower.slice(2), 16));
    return xmlCodePoint(Number(lower.slice(1)));
  });
}

async function boundedText(response: Response, maximum: number, label: string): Promise<string> {
  const length = parseOptionalLength(response.headers.get("content-length"));
  if (length !== undefined && length > maximum) {
    await discardBody(response);
    throw new Error(`${label} exceeds the client limit.`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBytes(response, maximum, label));
}

async function responseError(
  operation: string,
  response: Response,
  overrides?: { retryable?: boolean; commitState?: "not-applicable" | "not-committed" | "unknown" },
): Promise<S3StorageError> {
  const detail = await boundedText(response, MAX_ERROR_BYTES, "S3 error response").catch(() => "");
  const code = /<Code>([^<]{1,128})<\/Code>/u.exec(detail)?.[1];
  const requestId = response.headers.get("x-amz-request-id") ?? /<RequestId>([^<]{1,256})<\/RequestId>/u.exec(detail)?.[1];
  const retryable = overrides?.retryable ?? (response.status === 408 || response.status === 429 || response.status >= 500);
  const commitState = overrides?.commitState ?? "not-applicable";
  const excerpt = detail.replace(/\s+/gu, " ").trim().slice(0, 500);
  return new S3StorageError(
    `${operation} failed (${response.status})${code ? ` [${code}]` : ""}${excerpt ? `: ${excerpt}` : ""}`,
    {
      status: response.status,
      code,
      requestId,
      retryable,
      commitState,
      bucketRegion: response.headers.get("x-amz-bucket-region") ?? undefined,
    },
  );
}

function xmlCodePoint(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    throw new Error("S3 list contains an invalid XML character reference.");
  }
  return String.fromCodePoint(value);
}

async function readBoundedBytes(
  response: Response,
  maximum: number,
  label: string,
  exactLength?: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    if (exactLength === 0) return new Uint8Array();
    throw new Error(`${label} response has no readable body.`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximum || (exactLength !== undefined && total > exactLength)) {
        await reader.cancel(`${label} exceeds the client limit.`);
        throw new Error(`${label} exceeds the client limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (exactLength !== undefined && total !== exactLength) throw new Error(`${label} returned the wrong byte count.`);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function isRetryableReadStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(retryAfter: string | null | undefined, attempt: number, now: Date): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_000, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, Math.min(2_000, date - now.getTime()));
  }
  const jitter = crypto.getRandomValues(new Uint16Array(1))[0]! / 0xffff;
  return Math.min(2_000, 50 * 2 ** attempt + Math.floor(jitter * 50));
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
