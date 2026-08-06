import type { JsonValue } from "../core/contracts";
import { bytesToHex, decodeCanonicalBase64 } from "./encoding";
import { parseTdxQuote } from "./tdx";
import type { ChutesInstanceEvidence, EvidenceFetchResult, JsonObject } from "./types";

export const CHUTES_API_BASE = "https://api.chutes.ai";
export const DEFAULT_EVIDENCE_TIMEOUT_MS = 30_000;
export const MAX_EVIDENCE_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_CERTIFICATE_BYTES = 64 * 1024;
export const MAX_RESPONSE_SIGNATURE_BYTES = 8 * 1024;
export const MAX_ATTESTED_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_GPU_EVIDENCE_ITEMS = 16;

const MAX_ERROR_RESPONSE_BYTES = 8 * 1024;
const MAX_INSTANCE_ID_LENGTH = 256;
const MAX_API_KEY_LENGTH = 4096;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_OBJECT_KEYS = 256;
const MAX_JSON_ARRAY_ITEMS = 1024;
const MAX_JSON_STRING_LENGTH = 512 * 1024;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ALLOWED_EVIDENCE_FIELDS = new Set([
  "quote",
  "gpu_evidence",
  "instance_id",
  "certificate",
  "signature",
  "attested_body",
]);

export type EvidenceClientErrorCode =
  | "invalid-input"
  | "network"
  | "timeout"
  | "http"
  | "invalid-content-type"
  | "response-too-large"
  | "invalid-json"
  | "invalid-response";

export class EvidenceClientError extends Error {
  readonly code: EvidenceClientErrorCode;
  readonly status?: number;
  readonly nonce?: string;
  readonly requestUrl?: string;

  constructor(
    code: EvidenceClientErrorCode,
    message: string,
    context: { status?: number; nonce?: string; requestUrl?: string; cause?: unknown } = {},
  ) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "EvidenceClientError";
    this.code = code;
    this.status = context.status;
    this.nonce = context.nonce;
    this.requestUrl = context.requestUrl;
  }
}

export type RandomValues = (target: Uint8Array) => void;

export function generateAttestationNonce(randomValues?: RandomValues): string {
  const bytes = new Uint8Array(32);
  if (randomValues) {
    randomValues(bytes);
  } else {
    if (!globalThis.crypto?.getRandomValues) {
      throw new EvidenceClientError(
        "invalid-input",
        "Web Crypto getRandomValues is required for an attestation nonce",
      );
    }
    globalThis.crypto.getRandomValues(bytes);
  }
  return bytesToHex(bytes);
}

export type FetchChutesEvidenceArgs = {
  apiKey: string;
  instanceId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  randomValues?: RandomValues;
  now?: () => string;
};

/** Fetch and strictly validate GET /instances/{id}/evidence?nonce=<32-byte hex>. */
export async function fetchChutesInstanceEvidence(
  args: FetchChutesEvidenceArgs,
): Promise<EvidenceFetchResult> {
  const apiKey = validateApiKey(args.apiKey);
  const instanceId = validateInstanceId(args.instanceId);
  const baseUrl = validateBaseUrl(args.baseUrl ?? CHUTES_API_BASE);
  const timeoutMs = validatePositiveInteger(
    args.timeoutMs ?? DEFAULT_EVIDENCE_TIMEOUT_MS,
    "timeoutMs",
    1,
    120_000,
  );
  const maxResponseBytes = validatePositiveInteger(
    args.maxResponseBytes ?? MAX_EVIDENCE_RESPONSE_BYTES,
    "maxResponseBytes",
    1,
    MAX_EVIDENCE_RESPONSE_BYTES,
  );
  const nonce = generateAttestationNonce(args.randomValues);
  const requestUrl = new URL(
    `/instances/${encodeURIComponent(instanceId)}/evidence`,
    baseUrl,
  );
  requestUrl.searchParams.set("nonce", nonce);
  const requestUrlString = requestUrl.toString();
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new EvidenceClientError("invalid-input", "Fetch API is unavailable", {
      nonce,
      requestUrl: requestUrlString,
    });
  }

  const abort = createAbortScope(args.signal, timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(requestUrl, {
      cache: "no-store",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      method: "GET",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: abort.signal,
    });
  } catch (error) {
    const timedOut = abort.didTimeout();
    abort.dispose();
    throw new EvidenceClientError(
      timedOut ? "timeout" : "network",
      timedOut ? "Chutes evidence request timed out" : "Chutes evidence request failed",
      { cause: error, nonce, requestUrl: requestUrlString },
    );
  }

  try {
    if (!response.ok) {
      await drainBounded(response, MAX_ERROR_RESPONSE_BYTES);
      throw new EvidenceClientError(
        "http",
        `Chutes evidence request returned HTTP ${response.status}`,
        { status: response.status, nonce, requestUrl: requestUrlString },
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/.test(contentType)) {
      await drainBounded(response, MAX_ERROR_RESPONSE_BYTES);
      throw new EvidenceClientError(
        "invalid-content-type",
        "Chutes evidence response was not JSON",
        { nonce, requestUrl: requestUrlString },
      );
    }

    let text: string;
    try {
      text = await readBoundedUtf8(response, maxResponseBytes);
    } catch (error) {
      if (abort.didTimeout()) {
        throw new EvidenceClientError("timeout", "Chutes evidence request timed out", {
          cause: error,
          nonce,
          requestUrl: requestUrlString,
        });
      }
      if (error instanceof EvidenceClientError) {
        throw new EvidenceClientError(error.code, error.message, {
          cause: error,
          nonce,
          requestUrl: requestUrlString,
        });
      }
      throw new EvidenceClientError("invalid-response", "Could not read Chutes evidence response", {
        cause: error,
        nonce,
        requestUrl: requestUrlString,
      });
    }

    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch (error) {
      throw new EvidenceClientError("invalid-json", "Chutes evidence response contained invalid JSON", {
        cause: error,
        nonce,
        requestUrl: requestUrlString,
      });
    }

    let evidence: ChutesInstanceEvidence;
    try {
      evidence = validateChutesEvidenceResponse(body, instanceId);
    } catch (error) {
      throw new EvidenceClientError(
        "invalid-response",
        error instanceof Error ? error.message : "Chutes evidence response was invalid",
        { cause: error, nonce, requestUrl: requestUrlString },
      );
    }

    return {
      nonce,
      requestUrl: requestUrlString,
      fetchedAt: (args.now ?? (() => new Date().toISOString()))(),
      evidence,
    };
  } finally {
    abort.dispose();
  }
}

export function validateChutesEvidenceResponse(
  value: unknown,
  expectedInstanceId: string,
): ChutesInstanceEvidence {
  if (!isRecord(value)) throw new Error("Chutes evidence response must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!ALLOWED_EVIDENCE_FIELDS.has(key)) {
      throw new Error(`Chutes evidence response contains unexpected field ${JSON.stringify(key)}`);
    }
  }

  if (typeof value.quote !== "string") throw new Error("evidence.quote must be a string");
  // Structural parsing verifies canonical base64, quote-v4/v5 identity, bounds, and
  // its declared signature-data length. It does not verify the signature.
  parseTdxQuote(value.quote);

  if (!Array.isArray(value.gpu_evidence)) {
    throw new Error("evidence.gpu_evidence must be an array");
  }
  if (value.gpu_evidence.length > MAX_GPU_EVIDENCE_ITEMS) {
    throw new Error(`evidence.gpu_evidence exceeds ${MAX_GPU_EVIDENCE_ITEMS} items`);
  }
  const gpuEvidence = value.gpu_evidence.map((item, index) => {
    const validated = cloneBoundedJson(item, `evidence.gpu_evidence[${index}]`);
    if (!isRecord(validated)) {
      throw new Error(`evidence.gpu_evidence[${index}] must be an object`);
    }
    return validated as JsonObject;
  });

  if (typeof value.certificate !== "string") {
    throw new Error("evidence.certificate must be a string");
  }
  const certificate = decodeCanonicalBase64({
    value: value.certificate,
    label: "evidence.certificate",
    minBytes: 2,
    maxBytes: MAX_CERTIFICATE_BYTES,
  });
  if (certificate[0] !== 0x30) {
    throw new Error("evidence.certificate is not a DER SEQUENCE");
  }

  const signature = value.signature === undefined || value.signature === null
    ? undefined
    : decodeCanonicalBase64({
      value: typeof value.signature === "string" ? value.signature : "",
      label: "signature",
      minBytes: 1,
      maxBytes: MAX_RESPONSE_SIGNATURE_BYTES,
    });
  const attestedBody = value.attested_body === undefined || value.attested_body === null
    ? undefined
    : decodeCanonicalBase64({
      value: typeof value.attested_body === "string" ? value.attested_body : "",
      label: "attested_body",
      minBytes: 1,
      maxBytes: MAX_ATTESTED_BODY_BYTES,
    });
  if ((signature === undefined) !== (attestedBody === undefined)) {
    throw new Error("signature and attested_body must be supplied together");
  }

  let reportedInstanceId: string | undefined;
  if (value.instance_id !== undefined && value.instance_id !== null) {
    if (typeof value.instance_id !== "string") {
      throw new Error("evidence.instance_id must be a string or null");
    }
    reportedInstanceId = validateInstanceId(value.instance_id);
    if (reportedInstanceId !== expectedInstanceId) {
      throw new Error("evidence.instance_id does not match the requested instance");
    }
  }

  return {
    quote: value.quote,
    gpuEvidence,
    instanceId: expectedInstanceId,
    reportedInstanceId,
    certificate: value.certificate,
    ...(signature ? {
      signature: value.signature as string,
      signatureByteLength: signature.byteLength,
    } : {}),
    ...(attestedBody ? {
      attestedBody: value.attested_body as string,
      attestedBodyByteLength: attestedBody.byteLength,
    } : {}),
  };
}

export function cloneBoundedJson(value: unknown, label = "JSON value"): JsonValue {
  return cloneJson(value, label, 0);
}

function cloneJson(value: unknown, label: string, depth: number): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) throw new Error(`${label} string is too long`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) throw new Error(`${label} array is too large`);
    return value.map((item, index) => cloneJson(item, `${label}[${index}]`, depth + 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_JSON_OBJECT_KEYS) throw new Error(`${label} object has too many keys`);
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of entries) {
      if (key.length > 256 || /[\u0000-\u001f]/.test(key)) {
        throw new Error(`${label} contains an invalid object key`);
      }
      result[key] = cloneJson(item, `${label}.${key}`, depth + 1);
    }
    return result;
  }
  throw new Error(`${label} contains a non-JSON value`);
}

function validateApiKey(value: string): string {
  if (typeof value !== "string") {
    throw new EvidenceClientError("invalid-input", "Chutes API key must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_API_KEY_LENGTH || /[\r\n]/.test(trimmed)) {
    throw new EvidenceClientError("invalid-input", "Chutes API key is empty or invalid");
  }
  return trimmed;
}

function validateInstanceId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_INSTANCE_ID_LENGTH ||
    !INSTANCE_ID_PATTERN.test(value)
  ) {
    throw new EvidenceClientError("invalid-input", "Chutes instance ID is invalid");
  }
  return value;
}

function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new EvidenceClientError("invalid-input", "Chutes API base URL is invalid", {
      cause: error,
    });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new EvidenceClientError(
      "invalid-input",
      "Chutes API base URL must be an HTTPS URL without credentials, query, or fragment",
    );
  }
  return url;
}

function validatePositiveInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EvidenceClientError(
      "invalid-input",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

async function readBoundedUtf8(response: Response, maximum: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new EvidenceClientError("invalid-response", "Invalid Content-Length header");
    }
    if (Number(contentLength) > maximum) {
      await response.body?.cancel();
      throw new EvidenceClientError("response-too-large", "Chutes evidence response is too large");
    }
  }
  if (!response.body) throw new EvidenceClientError("invalid-response", "Empty evidence response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel("response too large");
        throw new EvidenceClientError("response-too-large", "Chutes evidence response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new EvidenceClientError("invalid-response", "Evidence response is not valid UTF-8", {
      cause: error,
    });
  }
}

async function drainBounded(response: Response, maximum: number): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (total <= maximum) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
    }
    await reader.cancel("error response limit reached");
  } catch {
    // Error bodies are intentionally ignored and never included in a receipt.
  } finally {
    reader.releaseLock();
  }
}

function createAbortScope(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("evidence request timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
