import type {
  CompareAndSwapResult,
  ObjectRange,
  ObjectRecord,
  ObjectStore,
  ObjectSummary,
  PutIfAbsentResult,
  ObjectStoreCapabilities,
} from "./object-store";
import { ownedArrayBuffer } from "../core/bytes";

export type DirectObjectOperation = "get" | "get-range" | "put-if-absent" | "compare-and-swap" | "list";

export type AuthorizedRequest = {
  url: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
};

export interface DirectObjectAuthorizer {
  authorize(args: {
    operation: DirectObjectOperation;
    key: string;
    expectedEtag?: string;
    contentLength?: number;
    range?: { start: number; endExclusive: number };
    signal?: AbortSignal;
  }): Promise<AuthorizedRequest>;
}

const MAX_OBJECT_BYTES = 96 * 1024 * 1024;
const MAX_RANGE_BYTES = 16 * 1024 * 1024;

export class DirectObjectStore implements ObjectStore {
  readonly capabilities: ObjectStoreCapabilities = Object.freeze({
    version: 1,
    adapter: "direct",
    rangeRead: Object.freeze({ mode: "exact-or-fail", maxBytes: MAX_RANGE_BYTES, providerEvidence: "live-conformance-required" }),
    conditionalWrite: Object.freeze({ createIfAbsent: "atomic-or-fail", compareAndSwap: "atomic-or-fail", providerEvidence: "live-conformance-required" }),
    upload: Object.freeze({ mode: "single-request", interruptionRecovery: "none", persistsResumeCapability: false }),
  });
  constructor(
    private readonly authorizer: DirectObjectAuthorizer,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async get(key: string, signal?: AbortSignal): Promise<ObjectRecord | undefined> {
    const request = await this.authorizer.authorize({ operation: "get", key, signal });
    const response = await this.fetchImplementation(request.url, {
      method: "GET",
      headers: request.headers,
      credentials: request.credentials ?? "omit",
      signal,
      mode: "cors",
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw await responseError("get object", response);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_OBJECT_BYTES) throw new Error("Cloud object exceeds the client size limit.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error("Cloud object exceeds the client size limit.");
    return {
      key,
      bytes,
      etag: normalizeEtag(response.headers.get("etag")) ?? "unknown",
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
      throw new Error("Object ranges require non-negative, increasing integer offsets.");
    }
    const requestedLength = endExclusive - start;
    if (requestedLength > MAX_RANGE_BYTES) throw new Error("Cloud object range exceeds the client size limit.");
    const request = await this.authorizer.authorize({
      operation: "get-range",
      key,
      range: { start, endExclusive },
      signal,
    });
    const response = await this.fetchImplementation(request.url, {
      method: "GET",
      headers: { ...request.headers, Range: `bytes=${start}-${endExclusive - 1}` },
      credentials: request.credentials ?? "omit",
      signal,
      mode: "cors",
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw await responseError("get object range", response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== requestedLength) {
      throw new Error("Cloud storage did not return the exact requested byte range.");
    }
    if (response.status !== 206) throw new Error("Cloud storage ignored the exact byte range request.");
    const contentRange = parseContentRange(response.headers.get("content-range"));
    if (!contentRange || contentRange.start !== start || contentRange.endExclusive !== endExclusive) {
      throw new Error("Cloud storage returned a mismatched Content-Range header.");
    }
    return {
      key,
      bytes,
      etag: normalizeEtag(response.headers.get("etag")) ?? "unknown",
      start,
      endExclusive,
      totalSize: contentRange?.totalSize,
    };
  }

  async putIfAbsent(
    key: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<PutIfAbsentResult> {
    this.checkSize(bytes);
    const request = await this.authorizer.authorize({
      operation: "put-if-absent",
      key,
      contentLength: bytes.byteLength,
      signal,
    });
    const response = await this.fetchImplementation(request.url, {
      method: "PUT",
      body: ownedArrayBuffer(bytes),
      credentials: request.credentials ?? "omit",
      mode: "cors",
      signal,
      headers: { ...request.headers, "Content-Type": "application/octet-stream", "If-None-Match": "*" },
    });
    if (response.status === 409 || response.status === 412) {
      return { currentEtag: normalizeEtag(response.headers.get("etag")), created: false, reason: "exists" };
    }
    if (!response.ok) throw await responseError("put object", response);
    return { etag: normalizeEtag(response.headers.get("etag")) ?? "created", created: true };
  }

  async compareAndSwap(
    key: string,
    expectedEtag: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<CompareAndSwapResult> {
    this.checkSize(bytes);
    const request = await this.authorizer.authorize({
      operation: "compare-and-swap",
      key,
      expectedEtag,
      contentLength: bytes.byteLength,
      signal,
    });
    const response = await this.fetchImplementation(request.url, {
      method: "PUT",
      body: ownedArrayBuffer(bytes),
      credentials: request.credentials ?? "omit",
      mode: "cors",
      signal,
      headers: { ...request.headers, "Content-Type": "application/octet-stream", "If-Match": expectedEtag },
    });
    if (response.status === 409 || response.status === 412) {
      return {
        currentEtag: normalizeEtag(response.headers.get("etag")),
        updated: false,
        reason: "precondition-failed",
      };
    }
    if (!response.ok) throw await responseError("update object", response);
    return { etag: normalizeEtag(response.headers.get("etag")) ?? "updated", updated: true };
  }

  async list(prefix: string, signal?: AbortSignal): Promise<ObjectSummary[]> {
    const request = await this.authorizer.authorize({ operation: "list", key: prefix, signal });
    const response = await this.fetchImplementation(request.url, {
      method: "GET",
      headers: request.headers,
      credentials: request.credentials ?? "omit",
      signal,
      mode: "cors",
    });
    if (!response.ok) throw await responseError("list objects", response);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("The direct storage list adapter returned an invalid response.");
    return body.filter(isObjectSummary);
  }

  private checkSize(bytes: Uint8Array): void {
    if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error("Cloud object exceeds the client size limit.");
  }
}

function normalizeEtag(etag: string | null): string | undefined {
  return etag?.replace(/^"|"$/gu, "") || undefined;
}

function isObjectSummary(value: unknown): value is ObjectSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.key === "string" && typeof item.etag === "string" && typeof item.size === "number";
}

async function responseError(operation: string, response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => "")).slice(0, 500);
  return new Error(`${operation} failed (${response.status})${detail ? `: ${detail}` : ""}`);
}

function parseContentRange(value: string | null): { start: number; endExclusive: number; totalSize?: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value.trim());
  if (!match) throw new Error("Cloud storage returned an invalid Content-Range header.");
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  const totalSize = match[3] === "*" ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || endInclusive < start) {
    throw new Error("Cloud storage returned invalid byte range offsets.");
  }
  return { start, endExclusive: endInclusive + 1, totalSize };
}
