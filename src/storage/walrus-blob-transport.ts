import { isRecord } from "../core/records";
import { ownedArrayBuffer, sha256Hex } from "../core/bytes";

const DEFAULT_MAX_BLOB_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_EPOCHS = 53;
const BLOB_ID_PATTERN = /^[A-Za-z0-9_-]{20,100}$/u;

export type WalrusUploadGrant = {
  /** Short-lived publisher authorization. Long-lived wallet material never belongs in the browser. */
  authorization: string;
  expiresAt?: string;
  grantId?: string;
};

export interface WalrusUploadGrantIssuer {
  issueUploadGrant(args: {
    ciphertextBytes: number;
    ciphertextSha256: string;
    epochs: number;
    signal?: AbortSignal;
  }): Promise<WalrusUploadGrant>;
}

export type WalrusBlobReceipt = {
  blobId: string;
  created: boolean;
  endEpoch?: number;
  eventTxDigest?: string;
  grantId?: string;
  ciphertextSha256: string;
};

export type WalrusBlobRange = {
  blobId: string;
  bytes: Uint8Array;
  start: number;
  endExclusive: number;
  totalSize?: number;
  aggregator: string;
};

export type WalrusBlobTransportOptions = {
  publisherUrl: string;
  aggregatorUrls: string[];
  grantIssuer?: WalrusUploadGrantIssuer;
  maxBlobBytes?: number;
  maxEpochs?: number;
  fetchImplementation?: typeof fetch;
};

/**
 * Immutable Walrus data-plane transport for already-encrypted Airship objects.
 *
 * This intentionally does not implement ObjectStore: Walrus blob IDs are immutable
 * content handles and do not provide S3 list, key, or compare-and-swap semantics.
 */
export class WalrusBlobTransport {
  private readonly publisherUrl: string;
  private readonly aggregatorUrls: string[];
  private readonly grantIssuer?: WalrusUploadGrantIssuer;
  private readonly maxBlobBytes: number;
  private readonly maxEpochs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: WalrusBlobTransportOptions) {
    this.publisherUrl = endpoint(options.publisherUrl, "publisher");
    if (options.aggregatorUrls.length === 0) throw new Error("At least one Walrus aggregator is required.");
    this.aggregatorUrls = [...new Set(options.aggregatorUrls.map((value) => endpoint(value, "aggregator")))];
    this.grantIssuer = options.grantIssuer;
    this.maxBlobBytes = boundedPositiveInteger(options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES, "maximum blob size");
    this.maxEpochs = boundedPositiveInteger(options.maxEpochs ?? DEFAULT_MAX_EPOCHS, "maximum epoch count");
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async uploadCiphertext(
    ciphertext: Uint8Array,
    options: { epochs: number; signal?: AbortSignal },
  ): Promise<WalrusBlobReceipt> {
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > this.maxBlobBytes) {
      throw new Error("Walrus ciphertext is empty or exceeds the configured client limit.");
    }
    const epochs = boundedPositiveInteger(options.epochs, "Walrus epoch count");
    if (epochs > this.maxEpochs) throw new Error("Walrus epoch count exceeds the configured network limit.");
    const ciphertextSha256 = await sha256Hex(ciphertext);
    const grant = this.grantIssuer
      ? await this.grantIssuer.issueUploadGrant({
          ciphertextBytes: ciphertext.byteLength,
          ciphertextSha256,
          epochs,
          signal: options.signal,
        })
      : undefined;
    if (grant?.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
      throw new Error("The Walrus upload grant expired before use.");
    }

    const url = new URL("v1/blobs", withTrailingSlash(this.publisherUrl));
    url.searchParams.set("epochs", String(epochs));
    const response = await this.fetchImplementation(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(grant ? { Authorization: normalizeAuthorization(grant.authorization) } : {}),
      },
      body: ownedArrayBuffer(ciphertext),
      credentials: "omit",
      mode: "cors",
      signal: options.signal,
    });
    if (!response.ok) throw await responseError("Walrus upload", response);
    const body: unknown = await response.json();
    const parsed = parseUploadResponse(body);
    return { ...parsed, grantId: grant?.grantId, ciphertextSha256 };
  }

  async readBlob(blobId: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; aggregator: string }> {
    validateBlobId(blobId);
    const failures: string[] = [];
    for (const aggregator of orderedAggregators(this.aggregatorUrls, blobId)) {
      try {
        const response = await this.fetchImplementation(blobUrl(aggregator, blobId), {
          method: "GET",
          credentials: "omit",
          mode: "cors",
          signal,
        });
        if (!response.ok) throw await responseError("Walrus read", response);
        const declaredLength = parseOptionalLength(response.headers.get("content-length"));
        if (declaredLength !== undefined && declaredLength > this.maxBlobBytes) {
          throw new Error("Walrus blob exceeds the configured client limit.");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > this.maxBlobBytes) throw new Error("Walrus blob exceeds the configured client limit.");
        return { bytes, aggregator };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        failures.push(`${new URL(aggregator).host}: ${errorMessage(error)}`);
      }
    }
    throw new Error(`Walrus read failed across every configured aggregator: ${failures.join("; ")}`);
  }

  async readRange(blobId: string, start: number, endExclusive: number, signal?: AbortSignal): Promise<WalrusBlobRange> {
    validateBlobId(blobId);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive <= start) {
      throw new Error("Walrus ranges require non-negative, increasing integer offsets.");
    }
    const expectedLength = endExclusive - start;
    if (expectedLength > this.maxBlobBytes) throw new Error("Walrus range exceeds the configured client limit.");
    const failures: string[] = [];
    for (const aggregator of orderedAggregators(this.aggregatorUrls, blobId)) {
      try {
        const response = await this.fetchImplementation(blobUrl(aggregator, blobId), {
          method: "GET",
          headers: { Range: `bytes=${start}-${endExclusive - 1}` },
          credentials: "omit",
          mode: "cors",
          signal,
        });
        if (!response.ok) throw await responseError("Walrus range read", response);
        if (response.status !== 206) throw new Error("Walrus aggregator ignored the byte range request.");
        const range = parseContentRange(response.headers.get("content-range"));
        if (!range || range.start !== start || range.endExclusive !== endExclusive) {
          throw new Error("Walrus aggregator returned a missing or mismatched Content-Range header.");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== expectedLength) throw new Error("Walrus aggregator returned the wrong byte count.");
        return { blobId, bytes, start, endExclusive, totalSize: range.totalSize, aggregator };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        failures.push(`${new URL(aggregator).host}: ${errorMessage(error)}`);
      }
    }
    throw new Error(`Walrus range read failed across every configured aggregator: ${failures.join("; ")}`);
  }
}

function parseUploadResponse(body: unknown): Omit<WalrusBlobReceipt, "grantId" | "ciphertextSha256"> {
  if (!isRecord(body)) throw new Error("Walrus publisher returned an invalid upload receipt.");
  const already = isRecord(body.alreadyCertified) ? body.alreadyCertified : undefined;
  if (already) {
    const blobId = requiredBlobId(already.blobId);
    const event = isRecord(already.event) ? already.event : undefined;
    return {
      blobId,
      created: false,
      endEpoch: optionalSafeInteger(already.endEpoch),
      eventTxDigest: typeof event?.txDigest === "string" ? event.txDigest : undefined,
    };
  }
  const newly = isRecord(body.newlyCreated) ? body.newlyCreated : undefined;
  if (newly) {
    const blobObject = isRecord(newly.blobObject) ? newly.blobObject : undefined;
    const blobId = requiredBlobId(blobObject?.blobId ?? newly.blobId);
    const storage = isRecord(blobObject?.storage) ? blobObject.storage : undefined;
    const event = isRecord(newly.event) ? newly.event : undefined;
    return {
      blobId,
      created: true,
      endEpoch: optionalSafeInteger(storage?.endEpoch ?? newly.endEpoch),
      eventTxDigest: typeof event?.txDigest === "string" ? event.txDigest : undefined,
    };
  }
  throw new Error("Walrus publisher returned an unknown upload receipt shape.");
}

function blobUrl(base: string, blobId: string): URL {
  return new URL(`v1/blobs/${encodeURIComponent(blobId)}`, withTrailingSlash(base));
}

function orderedAggregators(values: string[], seed: string): string[] {
  const start = [...seed].reduce((sum, character) => (sum + character.charCodeAt(0)) >>> 0, 0) % values.length;
  return values.map((_, index) => values[(start + index) % values.length]!);
}

function endpoint(value: string, label: string): string {
  const parsed = new URL(value);
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    throw new Error(`Walrus ${label} must use HTTPS outside local development.`);
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/u, "");
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function validateBlobId(value: string): void {
  if (!BLOB_ID_PATTERN.test(value)) throw new Error("Walrus blob ID is invalid.");
}

function requiredBlobId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Walrus upload receipt is missing its blob ID.");
  validateBlobId(value);
  return value;
}

function normalizeAuthorization(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed)) throw new Error("Walrus upload authorization is invalid.");
  return /^Bearer\s/iu.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function optionalSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseOptionalLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Walrus returned an invalid Content-Length header.");
  return parsed;
}

function parseContentRange(value: string | null): { start: number; endExclusive: number; totalSize?: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value.trim());
  if (!match) throw new Error("Walrus returned an invalid Content-Range header.");
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  const totalSize = match[3] === "*" ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || endInclusive < start) {
    throw new Error("Walrus returned invalid range offsets.");
  }
  return { start, endExclusive: endInclusive + 1, totalSize };
}


async function responseError(operation: string, response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => "")).slice(0, 500);
  return new Error(`${operation} failed (${response.status})${detail ? `: ${detail}` : ""}`);
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
