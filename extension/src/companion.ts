/**
 * Airship's optional extension-owned acceleration lane.
 *
 * This is deliberately separate from the provider relay. OAuth and inference
 * requests never enter this database. The only durable bytes accepted here are
 * caller-declared ciphertext cache pages, addressed by opaque partition/page
 * identifiers. The cache is acceleration only: the Vault remains authoritative.
 *
 * Compute requests execute in the extension background context, keeping vector
 * scoring and hashing off Airship's UI thread. They use the same browser CPU as
 * the page and therefore make no hardware-acceleration claim.
 */

import { EXTENSION_VERSION } from "./policy";

export const COMPANION_PROTOCOL_VERSION = 1;
export const COMPANION_PORT_NAME = "airship-companion/1";

const DATABASE_NAME = "airship-companion-v1";
const DATABASE_VERSION = 1;
const RECORD_STORE = "ciphertext-pages";
const SETTINGS_STORE = "settings";
const ENABLED_SETTING = "ciphertext-cache-enabled";
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ENVELOPE_KEYS = 18;
const MAX_CACHE_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_RECORDS = 4_096;
const MAX_VECTOR_BYTES = 4 * 1024 * 1024;
const MAX_VECTOR_CANDIDATES = 512;
const MAX_VECTOR_DIMENSIONS = 2_048;
const MAX_TOP_K = 50;

const OPAQUE_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]+$/u;
const SHA256_DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/u;

export type CompanionStorageCapability = Readonly<{
  state: "available" | "unavailable";
  enabled: boolean;
  backend: "extension-indexeddb" | "none";
  durability: "extension-origin-persistent" | "none";
  boundary: "ciphertext-cache-only";
  maxRecordBytes: number;
  maxCacheBytes: number;
  maxRecords: number;
  usageBytes?: number;
  quotaBytes?: number;
  records?: number;
  reason?: string;
}>;

export type CompanionComputeCapability = Readonly<{
  state: "available" | "unavailable";
  execution: "extension-background";
  operations: readonly ("sha256" | "cosine-top-k")[];
  maxVectorBytes: number;
  maxCandidates: number;
  maxDimensions: number;
  reason?: string;
}>;

export type CompanionCapabilities = Readonly<{
  storage: CompanionStorageCapability;
  compute: CompanionComputeCapability;
}>;

type CompanionHelloRequest = Readonly<{ kind: "hello"; id: string }>;
type CompanionCacheRequest = Readonly<{
  kind: "cache";
  id: string;
  operation: "get" | "put" | "remove" | "stats" | "list";
  namespace: string;
  key?: string;
  data?: string;
  digest?: string;
  ciphertext?: true;
}>;
type CompanionComputeRequest = Readonly<
  | { kind: "compute"; id: string; operation: "sha256"; data: string }
  | {
      kind: "compute";
      id: string;
      operation: "cosine-top-k";
      query: string;
      candidates: readonly Readonly<{ id: string; vector: string }>[];
      dimensions: number;
      topK: number;
    }
>;

export type CompanionRequest =
  | CompanionHelloRequest
  | CompanionCacheRequest
  | CompanionComputeRequest;

type CompanionReplyBase = Readonly<{
  airshipCompanion: 1;
  from: "extension";
  id: string;
}>;

export type CompanionReply = CompanionReplyBase & Readonly<
  | { kind: "hello"; version: string; capabilities: CompanionCapabilities }
  | { kind: "result"; result: unknown }
  | { kind: "error"; code: string; message: string }
>;

export type CompanionPort = Readonly<{
  postMessage(message: unknown): void;
  onMessage: Readonly<{ addListener(listener: (message: unknown) => void): void }>;
  onDisconnect: Readonly<{ addListener(listener: () => void): void }>;
}>;

type CiphertextRecord = Readonly<{
  id: string;
  namespace: string;
  key: string;
  data: string;
  digest: string;
  size: number;
  touchedAt: number;
}>;

type ParsedCompanionRequest =
  | Readonly<{ ok: true; request: CompanionRequest }>
  | Readonly<{ ok: false; id: string; code: string; message: string }>;

export function installCompanionPort(port: CompanionPort): void {
  let tail = Promise.resolve();
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });
  port.onMessage.addListener((message) => {
    tail = tail.then(async () => {
      const parsed = parseCompanionRequest(message);
      const response = parsed.ok
        ? await handleCompanionRequest(parsed.request)
        : companionError(parsed.id, parsed.code, parsed.message);
      if (!disconnected) port.postMessage(response);
    }).catch(() => {
      if (!disconnected) {
        port.postMessage(companionError("", "internal-error", "The companion request failed closed."));
      }
    });
  });
}

export async function inspectCompanionCapabilities(): Promise<CompanionCapabilities> {
  const computeAvailable = typeof crypto?.subtle?.digest === "function";
  let storage: CompanionStorageCapability;
  if (typeof indexedDB === "undefined") {
    storage = Object.freeze({
      state: "unavailable",
      enabled: false,
      backend: "none",
      durability: "none",
      boundary: "ciphertext-cache-only",
      maxRecordBytes: MAX_CACHE_RECORD_BYTES,
      maxCacheBytes: MAX_CACHE_BYTES,
      maxRecords: MAX_CACHE_RECORDS,
      reason: "This extension runtime exposes no IndexedDB database.",
    });
  } else {
    try {
      const [enabled, stats, estimate] = await Promise.all([
        companionCacheEnabled(),
        companionCacheStats(),
        storageEstimate(),
      ]);
      storage = Object.freeze({
        state: "available",
        enabled,
        backend: "extension-indexeddb",
        durability: "extension-origin-persistent",
        boundary: "ciphertext-cache-only",
        maxRecordBytes: MAX_CACHE_RECORD_BYTES,
        maxCacheBytes: MAX_CACHE_BYTES,
        maxRecords: MAX_CACHE_RECORDS,
        usageBytes: stats.bytes,
        records: stats.records,
        ...(estimate.quota !== undefined ? { quotaBytes: estimate.quota } : {}),
      });
    } catch {
      storage = Object.freeze({
        state: "unavailable",
        enabled: false,
        backend: "none",
        durability: "none",
        boundary: "ciphertext-cache-only",
        maxRecordBytes: MAX_CACHE_RECORD_BYTES,
        maxCacheBytes: MAX_CACHE_BYTES,
        maxRecords: MAX_CACHE_RECORDS,
        reason: "The extension-owned cache database could not be opened.",
      });
    }
  }
  const compute: CompanionComputeCapability = Object.freeze({
    state: computeAvailable ? "available" : "unavailable",
    execution: "extension-background",
    operations: computeAvailable
      ? Object.freeze(["sha256", "cosine-top-k"] as const)
      : Object.freeze([]),
    maxVectorBytes: MAX_VECTOR_BYTES,
    maxCandidates: MAX_VECTOR_CANDIDATES,
    maxDimensions: MAX_VECTOR_DIMENSIONS,
    ...(computeAvailable ? {} : { reason: "This extension runtime exposes no WebCrypto digest implementation." }),
  });
  return Object.freeze({ storage, compute });
}

export async function setCompanionCacheEnabled(enabled: boolean): Promise<void> {
  const database = await openDatabase();
  try {
    await transactionRequest(database, SETTINGS_STORE, "readwrite", (store) =>
      store.put({ key: ENABLED_SETTING, value: enabled }));
  } finally {
    database.close();
  }
}

export async function clearCompanionCache(): Promise<void> {
  const database = await openDatabase();
  try {
    await transactionRequest(database, RECORD_STORE, "readwrite", (store) => store.clear());
  } finally {
    database.close();
  }
}

export async function companionCacheStats(namespace?: string): Promise<Readonly<{ records: number; bytes: number }>> {
  const database = await openDatabase();
  try {
    const records = (await allRecords(database))
      .filter((record) => namespace === undefined || record.namespace === namespace);
    return Object.freeze({
      records: records.length,
      bytes: records.reduce((total, record) => total + record.size, 0),
    });
  } finally {
    database.close();
  }
}

export function isCompanionReply(value: unknown): value is CompanionReply {
  if (!isRecord(value)) return false;
  return value.airshipCompanion === COMPANION_PROTOCOL_VERSION
    && value.from === "extension"
    && typeof value.id === "string"
    && (value.kind === "hello" || value.kind === "result" || value.kind === "error");
}

async function handleCompanionRequest(request: CompanionRequest): Promise<CompanionReply> {
  if (request.kind === "hello") {
    return companionReply(request.id, {
      kind: "hello",
      version: EXTENSION_VERSION,
      capabilities: await inspectCompanionCapabilities(),
    });
  }
  if (request.kind === "compute") return handleCompute(request);
  if (!(await companionCacheEnabled())) {
    return companionError(
      request.id,
      "cache-disabled",
      "The extension-owned ciphertext cache is disabled. Enable it from the Airship Companion popup.",
    );
  }
  if (request.operation === "stats") {
    return companionReply(request.id, { kind: "result", result: await companionCacheStats(request.namespace) });
  }
  if (request.operation === "list") {
    const database = await openDatabase();
    try {
      const records = (await allRecords(database))
        .filter((record) => record.namespace === request.namespace)
        .map((record) => Object.freeze({ key: record.key, bytes: record.size }));
      return companionReply(request.id, {
        kind: "result",
        result: Object.freeze({ pages: Object.freeze(records) }),
      });
    } finally {
      database.close();
    }
  }
  const key = request.key;
  if (!key) return companionError(request.id, "invalid-request", "A cache page key is required.");
  if (request.operation === "put") {
    if (request.ciphertext !== true) {
      return companionError(request.id, "plaintext-refused", "Only caller-declared ciphertext cache pages are accepted.");
    }
    const bytes = decodeBase64(request.data ?? "", MAX_CACHE_RECORD_BYTES);
    if (!bytes || bytes.byteLength === 0) {
      return companionError(request.id, "invalid-request", "The ciphertext cache page is empty or invalid.");
    }
    const digest = await sha256(bytes);
    if (request.digest && request.digest !== digest) {
      return companionError(request.id, "digest-mismatch", "The ciphertext page digest did not match its bytes.");
    }
    await putRecord(Object.freeze({
      id: recordId(request.namespace, key),
      namespace: request.namespace,
      key,
      data: request.data!,
      digest,
      size: bytes.byteLength,
      touchedAt: Date.now(),
    }));
    return companionReply(request.id, { kind: "result", result: Object.freeze({ stored: true, digest }) });
  }
  if (request.operation === "remove") {
    await removeRecord(recordId(request.namespace, key));
    return companionReply(request.id, { kind: "result", result: Object.freeze({ removed: true }) });
  }
  const record = await getRecord(recordId(request.namespace, key));
  if (!record) {
    return companionReply(request.id, { kind: "result", result: Object.freeze({ found: false }) });
  }
  const bytes = decodeBase64(record.data, MAX_CACHE_RECORD_BYTES);
  if (!bytes || await sha256(bytes) !== record.digest) {
    await removeRecord(record.id);
    return companionError(request.id, "cache-corrupt", "The cached ciphertext page failed its digest check and was removed.");
  }
  void touchRecord(record).catch(() => undefined);
  return companionReply(request.id, {
    kind: "result",
    result: Object.freeze({ found: true, data: record.data, digest: record.digest, bytes: record.size }),
  });
}

async function handleCompute(request: CompanionComputeRequest): Promise<CompanionReply> {
  if (typeof crypto?.subtle?.digest !== "function") {
    return companionError(request.id, "compute-unavailable", "WebCrypto is unavailable in this extension runtime.");
  }
  if (request.operation === "sha256") {
    const bytes = decodeBase64(request.data, MAX_VECTOR_BYTES);
    if (!bytes) return companionError(request.id, "invalid-request", "The digest input is invalid or too large.");
    return companionReply(request.id, {
      kind: "result",
      result: Object.freeze({ digest: await sha256(bytes), bytes: bytes.byteLength }),
    });
  }
  const query = decodeVector(request.query, request.dimensions);
  if (!query) return companionError(request.id, "invalid-request", "The query vector is invalid.");
  const queryNorm = vectorNorm(query);
  if (queryNorm === 0) return companionError(request.id, "invalid-request", "The query vector has zero magnitude.");
  const ranked: Array<Readonly<{ id: string; score: number }>> = [];
  for (const candidate of request.candidates) {
    const vector = decodeVector(candidate.vector, request.dimensions);
    if (!vector) return companionError(request.id, "invalid-request", "A candidate vector is invalid.");
    const norm = vectorNorm(vector);
    let dot = 0;
    for (let index = 0; index < vector.length; index += 1) dot += query[index]! * vector[index]!;
    ranked.push(Object.freeze({ id: candidate.id, score: norm === 0 ? 0 : dot / (queryNorm * norm) }));
  }
  ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return companionReply(request.id, {
    kind: "result",
    result: Object.freeze({ matches: Object.freeze(ranked.slice(0, request.topK)) }),
  });
}

function parseCompanionRequest(raw: unknown): ParsedCompanionRequest {
  if (!isRecord(raw)) return invalid("", "The companion message is not an object.");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (
    raw.airshipCompanion !== COMPANION_PROTOCOL_VERSION
    || raw.from !== "page"
    || !id
    || id.length > MAX_REQUEST_ID_LENGTH
    || !REQUEST_ID.test(id)
    || Object.keys(raw).length > MAX_ENVELOPE_KEYS
  ) {
    return invalid(id, "The companion envelope is invalid.");
  }
  if (raw.kind === "hello") {
    return Object.freeze({ ok: true, request: Object.freeze({ kind: "hello", id }) });
  }
  if (raw.kind === "cache") {
    const operation = raw.operation;
    const namespace = raw.namespace;
    if (
      (operation !== "get" && operation !== "put" && operation !== "remove" && operation !== "stats" && operation !== "list")
      || typeof namespace !== "string"
      || !OPAQUE_ID.test(namespace)
    ) {
      return invalid(id, "The cache operation or namespace is invalid.");
    }
    if (operation !== "stats" && operation !== "list" && (typeof raw.key !== "string" || !OPAQUE_ID.test(raw.key))) {
      return invalid(id, "The cache page key is invalid.");
    }
    if (operation === "put") {
      if (typeof raw.data !== "string" || raw.data.length > Math.ceil(MAX_CACHE_RECORD_BYTES * 4 / 3) + 8) {
        return invalid(id, "The cache page is invalid or too large.");
      }
      if (raw.digest !== undefined && (typeof raw.digest !== "string" || !SHA256_DIGEST.test(raw.digest))) {
        return invalid(id, "The cache page digest is invalid.");
      }
      if (raw.ciphertext !== true) return invalid(id, "The cache page must be declared ciphertext.");
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({
        kind: "cache",
        id,
        operation,
        namespace,
        ...(typeof raw.key === "string" ? { key: raw.key } : {}),
        ...(typeof raw.data === "string" ? { data: raw.data } : {}),
        ...(typeof raw.digest === "string" ? { digest: raw.digest } : {}),
        ...(raw.ciphertext === true ? { ciphertext: true as const } : {}),
      }),
    });
  }
  if (raw.kind === "compute" && raw.operation === "sha256") {
    if (typeof raw.data !== "string" || raw.data.length > Math.ceil(MAX_VECTOR_BYTES * 4 / 3) + 8) {
      return invalid(id, "The digest input is invalid or too large.");
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({ kind: "compute", id, operation: "sha256", data: raw.data }),
    });
  }
  if (raw.kind === "compute" && raw.operation === "cosine-top-k") {
    if (
      !Number.isSafeInteger(raw.dimensions)
      || Number(raw.dimensions) < 1
      || Number(raw.dimensions) > MAX_VECTOR_DIMENSIONS
      || !Number.isSafeInteger(raw.topK)
      || Number(raw.topK) < 1
      || Number(raw.topK) > MAX_TOP_K
      || !Array.isArray(raw.candidates)
      || raw.candidates.length === 0
      || raw.candidates.length > MAX_VECTOR_CANDIDATES
      || typeof raw.query !== "string"
    ) return invalid(id, "The vector query shape is invalid.");
    const candidates: Array<Readonly<{ id: string; vector: string }>> = [];
    let encodedChars = raw.query.length;
    for (const value of raw.candidates) {
      if (!isRecord(value) || typeof value.id !== "string" || !OPAQUE_ID.test(value.id) || typeof value.vector !== "string") {
        return invalid(id, "A vector candidate is invalid.");
      }
      encodedChars += value.vector.length;
      if (encodedChars > Math.ceil(MAX_VECTOR_BYTES * 4 / 3) + 8) {
        return invalid(id, "The vector query is too large.");
      }
      candidates.push(Object.freeze({ id: value.id, vector: value.vector }));
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({
        kind: "compute",
        id,
        operation: "cosine-top-k",
        query: raw.query,
        candidates: Object.freeze(candidates),
        dimensions: Number(raw.dimensions),
        topK: Math.min(Number(raw.topK), candidates.length || 1),
      }),
    });
  }
  return invalid(id, "The companion request kind is unsupported.");
}

function companionReply<const T extends Readonly<Record<string, unknown>>>(
  id: string,
  fields: T,
): CompanionReplyBase & T {
  return Object.freeze({
    airshipCompanion: COMPANION_PROTOCOL_VERSION,
    from: "extension" as const,
    id,
    ...fields,
  });
}

function companionError(id: string, code: string, message: string): CompanionReply {
  return companionReply(id, {
    kind: "error",
    code: /^[a-z][a-z0-9-]{0,63}$/u.test(code) ? code : "internal-error",
    message: message.replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 320),
  });
}

function invalid(id: string, message: string): ParsedCompanionRequest {
  return Object.freeze({ ok: false, id, code: "invalid-request", message });
}

async function companionCacheEnabled(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  const database = await openDatabase();
  try {
    const setting = await transactionRequest(database, SETTINGS_STORE, "readonly", (store) =>
      store.get(ENABLED_SETTING)) as { value?: unknown } | undefined;
    return setting?.value === true;
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECORD_STORE)) {
        const records = database.createObjectStore(RECORD_STORE, { keyPath: "id" });
        records.createIndex("touchedAt", "touchedAt");
        records.createIndex("namespace", "namespace");
      }
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The companion database could not be opened."));
    request.onblocked = () => reject(new Error("The companion database upgrade was blocked."));
  });
}

function transactionRequest(
  database: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  start: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = start(transaction.objectStore(storeName));
    request.onerror = () => reject(request.error ?? new Error("The companion database request failed."));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? new Error("The companion database transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("The companion database transaction was aborted."));
  });
}

async function allRecords(database: IDBDatabase): Promise<CiphertextRecord[]> {
  const result = await transactionRequest(database, RECORD_STORE, "readonly", (store) => store.getAll());
  return Array.isArray(result) ? result.filter(isCiphertextRecord) : [];
}

async function getRecord(id: string): Promise<CiphertextRecord | undefined> {
  const database = await openDatabase();
  try {
    const result = await transactionRequest(database, RECORD_STORE, "readonly", (store) => store.get(id));
    return isCiphertextRecord(result) ? result : undefined;
  } finally {
    database.close();
  }
}

async function putRecord(record: CiphertextRecord): Promise<void> {
  const database = await openDatabase();
  try {
    await transactionRequest(database, RECORD_STORE, "readwrite", (store) => store.put(record));
    const records = await allRecords(database);
    let bytes = records.reduce((total, entry) => total + entry.size, 0);
    let count = records.length;
    if (bytes <= MAX_CACHE_BYTES && count <= MAX_CACHE_RECORDS) return;
    const oldest = [...records].sort((left, right) => left.touchedAt - right.touchedAt);
    const transaction = database.transaction(RECORD_STORE, "readwrite");
    const store = transaction.objectStore(RECORD_STORE);
    for (const candidate of oldest) {
      if (bytes <= MAX_CACHE_BYTES && count <= MAX_CACHE_RECORDS) break;
      if (candidate.id === record.id && records.length === 1) break;
      store.delete(candidate.id);
      bytes -= candidate.size;
      count -= 1;
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function removeRecord(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    await transactionRequest(database, RECORD_STORE, "readwrite", (store) => store.delete(id));
  } finally {
    database.close();
  }
}

async function touchRecord(record: CiphertextRecord): Promise<void> {
  const database = await openDatabase();
  try {
    await transactionRequest(database, RECORD_STORE, "readwrite", (store) =>
      store.put(Object.freeze({ ...record, touchedAt: Date.now() })));
  } finally {
    database.close();
  }
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("The companion database transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("The companion database transaction was aborted."));
  });
}

function recordId(namespace: string, key: string): string {
  return `${namespace}/${key}`;
}

function isCiphertextRecord(value: unknown): value is CiphertextRecord {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.namespace === "string"
    && OPAQUE_ID.test(value.namespace)
    && typeof value.key === "string"
    && OPAQUE_ID.test(value.key)
    && typeof value.data === "string"
    && typeof value.digest === "string"
    && SHA256_DIGEST.test(value.digest)
    && Number.isSafeInteger(value.size)
    && Number(value.size) > 0
    && Number(value.size) <= MAX_CACHE_RECORD_BYTES
    && Number.isFinite(value.touchedAt);
}

function decodeBase64(value: string, maxBytes: number): Uint8Array | undefined {
  if (typeof value !== "string" || typeof atob !== "function") return undefined;
  try {
    const binary = atob(value);
    if (binary.length > maxBytes) return undefined;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index) & 0xff;
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function decodeVector(value: string, dimensions: number): Float32Array | undefined {
  const bytes = decodeBase64(value, dimensions * 4);
  if (!bytes || bytes.byteLength !== dimensions * 4) return undefined;
  const copy = bytes.slice();
  const vector = new Float32Array(copy.buffer);
  for (const entry of vector) if (!Number.isFinite(entry)) return undefined;
  return vector;
}

function vectorNorm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.slice().buffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `sha256:${base64Url(digest)}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function storageEstimate(): Promise<Readonly<{ usage?: number; quota?: number }>> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return Object.freeze({
      ...(typeof estimate?.usage === "number" ? { usage: estimate.usage } : {}),
      ...(typeof estimate?.quota === "number" ? { quota: estimate.quota } : {}),
    });
  } catch {
    return Object.freeze({});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
