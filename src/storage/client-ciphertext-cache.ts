import { ownedArrayBuffer } from "../core/bytes";
import { sha256 } from "../core/hash";

const CACHE_VERSION = 1;
const RECORD_MAGIC = "AIRCC01\0";
const RECORD_MAGIC_BYTES = new TextEncoder().encode(RECORD_MAGIC);
const HEADER_PREFIX_BYTES = RECORD_MAGIC_BYTES.byteLength + 4;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CIPHERTEXT_BYTES = 64 * 1024 * 1024;
const MAX_PERSISTED_RECORD_BYTES = HEADER_PREFIX_BYTES + MAX_HEADER_BYTES + MAX_CIPHERTEXT_BYTES;
const OPFS_ROOT = "airship-ciphertext-cache-v1";
const OPFS_START_TIMEOUT_MS = 5_000;
const CACHE_DATABASE_VERSION = 1;
const CACHE_STORE = "ciphertext-pages";
const WORKER_POLICY_NAME = "airship-opfs-worker";

export type CiphertextCacheKind = "workspace" | "git-object" | "index-page";
export type CiphertextCacheBackend = "opfs-sync-worker" | "opfs-async-worker" | "indexeddb" | "memory";

export type CiphertextCacheCapability = Readonly<{
  version: 1;
  active: true;
  backend: CiphertextCacheBackend;
  durability: "origin-private-persistent" | "page-memory";
  persistenceBoundary: "ciphertext-only";
  authority: "vault-provider-remains-authoritative";
  syncAccessHandle: "active" | "unavailable";
  classes: readonly CiphertextCacheKind[];
}>;

export type CiphertextCacheAddress = Readonly<{
  objectKey: string;
  kind: CiphertextCacheKind;
  range?: Readonly<{ start: number; endExclusive: number }>;
}>;

export type CiphertextCacheValue = Readonly<{
  bytes: Uint8Array;
  etag: string;
  updatedAt?: string;
  totalSize?: number;
}>;

export interface CiphertextPageBackend {
  readonly backend: CiphertextCacheBackend;
  readonly durability: CiphertextCacheCapability["durability"];
  readonly syncAccessHandle: CiphertextCacheCapability["syncAccessHandle"];
  read(storageKey: string): Promise<Uint8Array | undefined>;
  write(storageKey: string, bytes: Uint8Array): Promise<void>;
  remove(storageKey: string): Promise<void>;
  close(): void;
}

type CacheHeader = Readonly<{
  version: 1;
  kind: CiphertextCacheKind;
  etag: string;
  ciphertextDigest: string;
  updatedAt?: string;
  range?: Readonly<{ start: number; endExclusive: number }>;
  totalSize?: number;
}>;

export type ClientCiphertextCacheOptions = Readonly<{
  partition: string;
  openOpfs?: (partitionKey: string) => Promise<CiphertextPageBackend>;
  openIndexedDb?: (partitionKey: string) => Promise<CiphertextPageBackend>;
}>;

/**
 * An integrity-checking, ciphertext-only acceleration cache.
 *
 * The cache never receives a workspace key or plaintext. Callers pass the
 * already-enveloped bytes destined for a Vault ObjectStore. Persistent cache
 * corruption is a miss: the entry is removed and provider authority is used.
 */
export class ClientCiphertextCache {
  readonly capability: CiphertextCacheCapability;

  constructor(private readonly pages: CiphertextPageBackend) {
    this.capability = Object.freeze({
      version: CACHE_VERSION,
      active: true,
      backend: pages.backend,
      durability: pages.durability,
      persistenceBoundary: "ciphertext-only",
      authority: "vault-provider-remains-authoritative",
      syncAccessHandle: pages.syncAccessHandle,
      classes: Object.freeze(["workspace", "git-object", "index-page"] as const),
    });
  }

  async get(address: CiphertextCacheAddress): Promise<CiphertextCacheValue | undefined> {
    validateAddress(address);
    const storageKey = await cacheStorageKey(address);
    let encoded: Uint8Array | undefined;
    try {
      encoded = await this.pages.read(storageKey);
    } catch {
      return undefined;
    }
    if (!encoded) return undefined;
    try {
      const record = decodeRecord(encoded);
      if (!headerMatches(record.header, address)) throw new Error("Ciphertext cache address mismatch.");
      if (await sha256(record.bytes) !== record.header.ciphertextDigest) {
        throw new Error("Ciphertext cache digest mismatch.");
      }
      return Object.freeze({
        bytes: record.bytes,
        etag: record.header.etag,
        ...(record.header.updatedAt ? { updatedAt: record.header.updatedAt } : {}),
        ...(record.header.totalSize !== undefined ? { totalSize: record.header.totalSize } : {}),
      });
    } catch {
      await this.pages.remove(storageKey).catch(() => undefined);
      return undefined;
    }
  }

  async put(address: CiphertextCacheAddress, value: CiphertextCacheValue): Promise<void> {
    validateAddress(address);
    validateValue(address, value);
    const header: CacheHeader = Object.freeze({
      version: CACHE_VERSION,
      kind: address.kind,
      etag: value.etag,
      ciphertextDigest: await sha256(value.bytes),
      ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
      ...(address.range ? { range: Object.freeze({ ...address.range }) } : {}),
      ...(value.totalSize !== undefined ? { totalSize: value.totalSize } : {}),
    });
    await this.pages.write(await cacheStorageKey(address), encodeRecord(header, value.bytes));
  }

  async remove(address: CiphertextCacheAddress): Promise<void> {
    validateAddress(address);
    await this.pages.remove(await cacheStorageKey(address));
  }

  close(): void {
    this.pages.close();
  }
}

/** Selects the strongest honest cache path without making it authoritative. */
export async function createClientCiphertextCache(
  options: ClientCiphertextCacheOptions,
): Promise<ClientCiphertextCache> {
  const partition = options.partition.trim();
  if (!partition || new TextEncoder().encode(partition).byteLength > 4_096) {
    throw new Error("Ciphertext cache partition must be a bounded non-empty identifier.");
  }
  const partitionKey = (await sha256(partition)).slice("sha256:".length);
  const openOpfs = options.openOpfs ?? openOpfsWorkerBackend;
  const openIndexedDb = options.openIndexedDb ?? openIndexedDbBackend;
  try {
    return new ClientCiphertextCache(await openOpfs(partitionKey));
  } catch {
    try {
      return new ClientCiphertextCache(await openIndexedDb(partitionKey));
    } catch {
      return new ClientCiphertextCache(new MemoryCiphertextPageBackend());
    }
  }
}

export class MemoryCiphertextPageBackend implements CiphertextPageBackend {
  readonly backend = "memory" as const;
  readonly durability = "page-memory" as const;
  readonly syncAccessHandle = "unavailable" as const;
  private readonly pages = new Map<string, Uint8Array>();

  async read(storageKey: string): Promise<Uint8Array | undefined> {
    const bytes = this.pages.get(validateStorageKey(storageKey));
    return bytes?.slice();
  }

  async write(storageKey: string, bytes: Uint8Array): Promise<void> {
    validateStorageKey(storageKey);
    validateEncodedRecordSize(bytes);
    this.pages.set(storageKey, bytes.slice());
  }

  async remove(storageKey: string): Promise<void> {
    this.pages.delete(validateStorageKey(storageKey));
  }

  close(): void {
    this.pages.clear();
  }
}

class IndexedDbCiphertextPageBackend implements CiphertextPageBackend {
  readonly backend = "indexeddb" as const;
  readonly durability = "origin-private-persistent" as const;
  readonly syncAccessHandle = "unavailable" as const;

  constructor(private readonly database: IDBDatabase) {}

  async read(storageKey: string): Promise<Uint8Array | undefined> {
    const transaction = this.database.transaction(CACHE_STORE, "readonly");
    const request = transaction.objectStore(CACHE_STORE).get(validateStorageKey(storageKey));
    const value = await idbRequest<ArrayBuffer | undefined>(request);
    await idbTransaction(transaction);
    return value ? new Uint8Array(value) : undefined;
  }

  async write(storageKey: string, bytes: Uint8Array): Promise<void> {
    validateStorageKey(storageKey);
    validateEncodedRecordSize(bytes);
    const transaction = this.database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).put(ownedArrayBuffer(bytes), storageKey);
    await idbTransaction(transaction);
  }

  async remove(storageKey: string): Promise<void> {
    const transaction = this.database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).delete(validateStorageKey(storageKey));
    await idbTransaction(transaction);
  }

  close(): void {
    this.database.close();
  }
}

async function openIndexedDbBackend(partitionKey: string): Promise<CiphertextPageBackend> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable.");
  const request = indexedDB.open(`airship-ciphertext-cache-v1-${validateStorageKey(partitionKey)}`, CACHE_DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    if (!request.result.objectStoreNames.contains(CACHE_STORE)) request.result.createObjectStore(CACHE_STORE);
  }, { once: true });
  const database = await idbRequest(request);
  return new IndexedDbCiphertextPageBackend(database);
}

export class OpfsWorkerCiphertextPageBackend implements CiphertextPageBackend {
  readonly durability = "origin-private-persistent" as const;
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<number, Readonly<{
    resolve(value: Uint8Array | undefined): void;
    reject(reason: unknown): void;
  }>>();

  constructor(
    private readonly worker: Worker,
    readonly backend: "opfs-sync-worker" | "opfs-async-worker",
  ) {
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (!response || response.type !== "result" || !Number.isSafeInteger(response.id)) return;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if (!response.ok) request.reject(new Error("OPFS ciphertext cache operation failed."));
      else request.resolve(response.bytes ? new Uint8Array(response.bytes) : undefined);
    });
    worker.addEventListener("error", () => this.stop());
    worker.addEventListener("messageerror", () => this.stop());
  }

  get syncAccessHandle(): "active" | "unavailable" {
    return this.backend === "opfs-sync-worker" ? "active" : "unavailable";
  }

  read(storageKey: string): Promise<Uint8Array | undefined> {
    return this.request("read", validateStorageKey(storageKey));
  }

  async write(storageKey: string, bytes: Uint8Array): Promise<void> {
    validateEncodedRecordSize(bytes);
    const payload = ownedArrayBuffer(bytes);
    await this.request("write", validateStorageKey(storageKey), payload);
  }

  async remove(storageKey: string): Promise<void> {
    await this.request("remove", validateStorageKey(storageKey));
  }

  close(): void {
    this.stop();
  }

  private request(operation: WorkerOperation, storageKey: string, bytes?: ArrayBuffer): Promise<Uint8Array | undefined> {
    if (this.closed) return Promise.reject(workerStoppedError());
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: WorkerRequest = { type: "operation", id, operation, storageKey, ...(bytes ? { bytes } : {}) };
      try {
        this.worker.postMessage(message, bytes ? [bytes] : []);
      } catch {
        // Some engines throw after termination while others silently discard
        // the message. Either behavior permanently retires this backend.
        this.stop();
      }
    });
  }

  private stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending();
    this.worker.terminate();
  }

  private rejectPending(): void {
    for (const request of this.pending.values()) request.reject(workerStoppedError());
    this.pending.clear();
  }
}

function workerStoppedError(): Error {
  return new Error("OPFS ciphertext cache worker stopped.");
}

type WorkerOperation = "read" | "write" | "remove";
type WorkerRequest = Readonly<{
  type: "operation";
  id: number;
  operation: WorkerOperation;
  storageKey: string;
  bytes?: ArrayBuffer;
}>;
type WorkerResponse = Readonly<{
  type: "result";
  id: number;
  ok: boolean;
  bytes?: ArrayBuffer;
}>;

async function openOpfsWorkerBackend(partitionKey: string): Promise<CiphertextPageBackend> {
  const storage = typeof navigator === "undefined"
    ? undefined
    : (navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> } | undefined);
  if (!storage?.getDirectory || typeof Worker === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("OPFS worker storage is unavailable.");
  }
  const url = URL.createObjectURL(new Blob([opfsWorkerSource()], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(trustedOpfsWorkerUrl(url) as string, { name: "airship-ciphertext-opfs" });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  URL.revokeObjectURL(url);
  try {
    const backend = await waitForWorkerReady(worker, validateStorageKey(partitionKey));
    return new OpfsWorkerCiphertextPageBackend(worker, backend);
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

let opfsWorkerPolicy: Readonly<{ createScriptURL(value: string): unknown }> | undefined;

function trustedOpfsWorkerUrl(url: string): unknown {
  const factory = (globalThis as typeof globalThis & {
    trustedTypes?: {
      createPolicy(name: string, rules: { createScriptURL(value: string): string }): { createScriptURL(value: string): unknown };
    };
  }).trustedTypes;
  if (!factory) return url;
  opfsWorkerPolicy ??= factory.createPolicy(WORKER_POLICY_NAME, {
    createScriptURL(value) {
      if (!value.startsWith("blob:")) throw new TypeError("Airship OPFS workers require a fresh blob URL.");
      return value;
    },
  });
  return opfsWorkerPolicy.createScriptURL(url);
}

function waitForWorkerReady(
  worker: Worker,
  partitionKey: string,
): Promise<"opfs-sync-worker" | "opfs-async-worker"> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(() => reject(new Error("OPFS ciphertext cache worker did not start."))), OPFS_START_TIMEOUT_MS);
    const onMessage = (event: MessageEvent<unknown>) => {
      const value = event.data as { type?: unknown; backend?: unknown } | undefined;
      if (value?.type !== "ready") return;
      if (value.backend !== "opfs-sync-worker" && value.backend !== "opfs-async-worker") {
        finish(() => reject(new Error("OPFS ciphertext cache worker reported an invalid mode.")));
        return;
      }
      const backend = value.backend;
      finish(() => resolve(backend));
    };
    const onError = () => finish(() => reject(new Error("OPFS ciphertext cache worker failed to initialize.")));
    const finish = (action: () => void) => {
      clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onError);
      action();
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onError);
    worker.postMessage({ type: "initialize", partitionKey, rootName: OPFS_ROOT });
  });
}

function opfsWorkerSource(): string {
  return `"use strict";
let directory; let mode = "opfs-async-worker"; let tail = Promise.resolve();
const valid = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const filename = key => "p-" + key + ".bin";
const notFound = error => error && (error.name === "NotFoundError" || error.name === "TypeMismatchError");
self.addEventListener("message", event => {
  const message = event.data;
  if (message && message.type === "initialize") {
    tail = tail.then(async () => {
      if (!valid(message.partitionKey) || !/^[a-z0-9-]{1,64}$/.test(message.rootName)) throw new Error("invalid cache partition");
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle(message.rootName, { create: true });
      directory = await base.getDirectoryHandle(message.partitionKey, { create: true });
      const probe = await directory.getFileHandle(".sync-probe", { create: true });
      if (typeof probe.createSyncAccessHandle === "function") {
        try { const handle = await probe.createSyncAccessHandle(); handle.close(); mode = "opfs-sync-worker"; } catch { mode = "opfs-async-worker"; }
      }
      await directory.removeEntry(".sync-probe").catch(() => undefined);
      self.postMessage({ type: "ready", backend: mode });
    }).catch(() => { throw new Error("OPFS initialization failed"); });
    return;
  }
  if (!message || message.type !== "operation") return;
  tail = tail.then(async () => {
    if (!directory || !valid(message.storageKey)) throw new Error("invalid cache operation");
    let result;
    if (message.operation === "read") result = await read(message.storageKey);
    else if (message.operation === "write") await write(message.storageKey, message.bytes);
    else if (message.operation === "remove") await directory.removeEntry(filename(message.storageKey)).catch(error => { if (!notFound(error)) throw error; });
    else throw new Error("invalid cache operation");
    const response = { type: "result", id: message.id, ok: true, ...(result ? { bytes: result } : {}) };
    self.postMessage(response, result ? [result] : []);
  }).catch(() => self.postMessage({ type: "result", id: message.id, ok: false }));
});
async function read(key) {
  let fileHandle;
  try { fileHandle = await directory.getFileHandle(filename(key)); } catch (error) { if (notFound(error)) return undefined; throw error; }
  if (mode === "opfs-sync-worker") {
    const handle = await fileHandle.createSyncAccessHandle();
    try { const size = handle.getSize(); if (size < 1 || size > ${MAX_PERSISTED_RECORD_BYTES}) throw new Error("invalid OPFS cache size"); const bytes = new Uint8Array(size); let offset = 0; while (offset < bytes.byteLength) { const read = handle.read(bytes.subarray(offset), { at: offset }); if (!read) throw new Error("short OPFS read"); offset += read; } return bytes.buffer; }
    finally { handle.close(); }
  }
  const file = await fileHandle.getFile(); if (file.size < 1 || file.size > ${MAX_PERSISTED_RECORD_BYTES}) throw new Error("invalid OPFS cache size"); return file.arrayBuffer();
}
async function write(key, value) {
  if (!(value instanceof ArrayBuffer)) throw new Error("invalid cache bytes");
  if (value.byteLength < 1 || value.byteLength > ${MAX_PERSISTED_RECORD_BYTES}) throw new Error("invalid cache bytes");
  const bytes = new Uint8Array(value); const fileHandle = await directory.getFileHandle(filename(key), { create: true });
  if (mode === "opfs-sync-worker") {
    const handle = await fileHandle.createSyncAccessHandle();
    try { handle.truncate(0); let offset = 0; while (offset < bytes.byteLength) { const written = handle.write(bytes.subarray(offset), { at: offset }); if (!written) throw new Error("short OPFS write"); offset += written; } handle.flush(); }
    finally { handle.close(); }
    return;
  }
  const writable = await fileHandle.createWritable();
  try { await writable.write(bytes); await writable.close(); } catch (error) { await writable.abort().catch(() => undefined); throw error; }
}`;
}

function encodeRecord(header: CacheHeader, bytes: Uint8Array): Uint8Array {
  validateCiphertextSize(bytes);
  const encodedHeader = new TextEncoder().encode(JSON.stringify(header));
  if (encodedHeader.byteLength > MAX_HEADER_BYTES) throw new Error("Ciphertext cache metadata exceeds its limit.");
  const encoded = new Uint8Array(HEADER_PREFIX_BYTES + encodedHeader.byteLength + bytes.byteLength);
  encoded.set(RECORD_MAGIC_BYTES, 0);
  new DataView(encoded.buffer).setUint32(RECORD_MAGIC_BYTES.byteLength, encodedHeader.byteLength, false);
  encoded.set(encodedHeader, HEADER_PREFIX_BYTES);
  encoded.set(bytes, HEADER_PREFIX_BYTES + encodedHeader.byteLength);
  return encoded;
}

function decodeRecord(encoded: Uint8Array): Readonly<{ header: CacheHeader; bytes: Uint8Array }> {
  if (encoded.byteLength < HEADER_PREFIX_BYTES || encoded.byteLength > HEADER_PREFIX_BYTES + MAX_HEADER_BYTES + MAX_CIPHERTEXT_BYTES) {
    throw new Error("Ciphertext cache record has an invalid size.");
  }
  if (!RECORD_MAGIC_BYTES.every((byte, index) => encoded[index] === byte)) throw new Error("Ciphertext cache record has an invalid marker.");
  const headerLength = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    .getUint32(RECORD_MAGIC_BYTES.byteLength, false);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || HEADER_PREFIX_BYTES + headerLength > encoded.byteLength) {
    throw new Error("Ciphertext cache header has an invalid size.");
  }
  const headerBytes = encoded.slice(HEADER_PREFIX_BYTES, HEADER_PREFIX_BYTES + headerLength);
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes)) as unknown;
  const header = parseHeader(parsed);
  const bytes = encoded.slice(HEADER_PREFIX_BYTES + headerLength);
  validateCiphertextSize(bytes);
  return Object.freeze({ header, bytes });
}

function parseHeader(value: unknown): CacheHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ciphertext cache header is invalid.");
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== CACHE_VERSION || !isKind(candidate.kind) || !boundedText(candidate.etag, 4_096) ||
      typeof candidate.ciphertextDigest !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(candidate.ciphertextDigest)) {
    throw new Error("Ciphertext cache header is invalid.");
  }
  const updatedAt = candidate.updatedAt === undefined ? undefined : parseTimestamp(candidate.updatedAt);
  const range = candidate.range === undefined ? undefined : parseRange(candidate.range);
  const totalSize = candidate.totalSize === undefined ? undefined : parseSize(candidate.totalSize);
  return Object.freeze({
    version: CACHE_VERSION,
    kind: candidate.kind,
    etag: candidate.etag as string,
    ciphertextDigest: candidate.ciphertextDigest,
    ...(updatedAt ? { updatedAt } : {}),
    ...(range ? { range } : {}),
    ...(totalSize !== undefined ? { totalSize } : {}),
  });
}

function validateAddress(address: CiphertextCacheAddress): void {
  if (!boundedText(address.objectKey, 4_096) || !isKind(address.kind)) throw new Error("Ciphertext cache address is invalid.");
  if (address.range) parseRange(address.range);
}

function validateValue(address: CiphertextCacheAddress, value: CiphertextCacheValue): void {
  validateCiphertextSize(value.bytes);
  if (!boundedText(value.etag, 4_096)) throw new Error("Ciphertext cache ETag is invalid.");
  if (value.updatedAt !== undefined) parseTimestamp(value.updatedAt);
  if (value.totalSize !== undefined) {
    const total = parseSize(value.totalSize);
    if (address.range && total < address.range.endExclusive) throw new Error("Ciphertext cache total size is smaller than its range.");
  }
  if (address.range && value.bytes.byteLength !== address.range.endExclusive - address.range.start) {
    throw new Error("Ciphertext cache range length does not match its bytes.");
  }
}

function headerMatches(header: CacheHeader, address: CiphertextCacheAddress): boolean {
  return header.kind === address.kind &&
    (address.range
      ? header.range?.start === address.range.start && header.range.endExclusive === address.range.endExclusive
      : header.range === undefined);
}

async function cacheStorageKey(address: CiphertextCacheAddress): Promise<string> {
  const range = address.range ? `${address.range.start}:${address.range.endExclusive}` : "full";
  return (await sha256(`${address.kind}\0${address.objectKey}\0${range}`)).slice("sha256:".length);
}

function validateStorageKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Ciphertext cache storage key is invalid.");
  return value;
}

function validateCiphertextSize(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_CIPHERTEXT_BYTES) {
    throw new Error("Ciphertext cache values require between 1 byte and 64 MiB.");
  }
}

function validateEncodedRecordSize(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_PREFIX_BYTES || bytes.byteLength > MAX_PERSISTED_RECORD_BYTES) {
    throw new Error("Ciphertext cache record has an invalid persisted size.");
  }
}

function parseRange(value: unknown): Readonly<{ start: number; endExclusive: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ciphertext cache range is invalid.");
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.endExclusive) ||
      Number(candidate.start) < 0 || Number(candidate.endExclusive) <= Number(candidate.start)) {
    throw new Error("Ciphertext cache range is invalid.");
  }
  return Object.freeze({ start: Number(candidate.start), endExclusive: Number(candidate.endExclusive) });
}

function parseSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_CIPHERTEXT_BYTES) {
    throw new Error("Ciphertext cache size is invalid.");
  }
  return Number(value);
}

function parseTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) throw new Error("Ciphertext cache timestamp is invalid.");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error("Ciphertext cache timestamp is invalid.");
  return value;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= maxBytes;
}

function isKind(value: unknown): value is CiphertextCacheKind {
  return value === "workspace" || value === "git-object" || value === "index-page";
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("Ciphertext cache IndexedDB request failed.")), { once: true });
  });
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Ciphertext cache IndexedDB transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Ciphertext cache IndexedDB transaction failed.")), { once: true });
  });
}
