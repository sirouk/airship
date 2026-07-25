import type { JsonValue } from "../core/contracts";
import { ownedArrayBuffer } from "../core/bytes";
import { sha256, stableStringify } from "../core/hash";
import {
  decodeEnvelope,
  encodeEnvelope,
  openEnvelope,
  sealEnvelope,
  type WorkspaceRootKey,
} from "./encrypted-envelope";
import type { GoogleAccessTokenProvider } from "./google-drive-auth";
import type { GoogleDriveWorkspace } from "./google-drive-workspace";
import type {
  CompareAndSwapResult,
  ObjectRange,
  ObjectRecord,
  ObjectStore,
  ObjectSummary,
  PutIfAbsentResult,
  ObjectStoreCapabilities,
} from "./object-store";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const INDEX_NAMESPACE = "airship/google-drive-object-index/v1";
const INDEX_CONTENT_TYPE = "application/vnd.airship.drive-index+json";
const SEGMENT_CONTENT_TYPE = "application/vnd.airship.encrypted-segment";
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 24 * 1024 * 1024;
const MAX_DRIVE_JSON_BYTES = 512 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_CAS_ATTEMPTS = 5;
const INDEX_CACHE_TTL_MS = 1_500;
const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
const RESUMABLE_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_RESUMABLE_RECOVERY_ATTEMPTS = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type IndexEntry = Readonly<{
  key: string;
  fileId: string;
  etag: string;
  size: number;
  updatedAt: string;
}>;

type DriveIndex = Readonly<{
  version: 1;
  generation: number;
  entries: readonly IndexEntry[];
}>;

type LoadedIndex = Readonly<{
  fileId: string;
  httpEtag: string;
  index: DriveIndex;
}>;

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
};

export type GoogleDriveObjectStoreOptions = Readonly<{
  tokenProvider: GoogleAccessTokenProvider;
  workspace: GoogleDriveWorkspace;
  workspaceKey: WorkspaceRootKey;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}>;

/**
 * Strict ObjectStore over a user-owned Drive folder.
 *
 * Object bytes are immutable Drive files. A single client-encrypted index maps
 * logical keys to opaque Drive IDs and is advanced with HTTP If-Match. Failed
 * races can leave ciphertext orphans but never acknowledge a lost mutation.
 * A live conformance probe remains the authority for a deployment's actual
 * conditional-request and CORS behavior.
 */
export class GoogleDriveObjectStore implements ObjectStore {
  readonly capabilities: ObjectStoreCapabilities = Object.freeze({
    version: 1,
    adapter: "google-drive",
    rangeRead: Object.freeze({ mode: "exact-or-fail", maxBytes: MAX_RANGE_BYTES, providerEvidence: "live-conformance-required" }),
    conditionalWrite: Object.freeze({ createIfAbsent: "atomic-or-fail", compareAndSwap: "atomic-or-fail", providerEvidence: "live-conformance-required" }),
    upload: Object.freeze({ mode: "resumable-active-call", interruptionRecovery: "resume-current-call", persistsResumeCapability: false }),
  });
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private indexId?: string;
  private indexCache?: { loaded: LoadedIndex; expiresAt: number };
  private indexLoad?: { epoch: number; promise: Promise<LoadedIndex> };
  private cacheEpoch = 0;

  constructor(private readonly options: GoogleDriveObjectStoreOptions) {
    validateWorkspace(options.workspace);
    this.fetchImplementation = (options.fetchImplementation ?? fetch).bind(globalThis);
    this.now = options.now ?? (() => new Date());
  }

  async get(key: string, signal?: AbortSignal): Promise<ObjectRecord | undefined> {
    const canonical = logicalKey(key);
    const loaded = await this.loadIndex(signal);
    const entry = loaded.index.entries.find((candidate) => candidate.key === canonical);
    if (!entry) return undefined;
    const response = await this.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(entry.fileId)}?alt=media`, { signal });
    if (response.status === 404) throw new Error("Google Drive encrypted segment is missing.");
    if (!response.ok) throw await driveError(response, "download encrypted segment");
    const bytes = await boundedBytes(response, MAX_OBJECT_BYTES, "Google Drive segment");
    if (bytes.byteLength !== entry.size || await sha256(bytes) !== entry.etag) {
      throw new Error("Google Drive encrypted segment did not match its committed index entry.");
    }
    return { key: canonical, bytes, etag: entry.etag, updatedAt: entry.updatedAt };
  }

  async getRange(key: string, start: number, endExclusive: number, signal?: AbortSignal): Promise<ObjectRange | undefined> {
    const canonical = logicalKey(key);
    validRange(start, endExclusive);
    const length = endExclusive - start;
    if (length > MAX_RANGE_BYTES) throw new Error("Google Drive range exceeds the client limit.");
    const loaded = await this.loadIndex(signal);
    const entry = loaded.index.entries.find((candidate) => candidate.key === canonical);
    if (!entry) return undefined;
    if (endExclusive > entry.size) throw new Error("Google Drive range exceeds the stored object size.");
    const response = await this.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(entry.fileId)}?alt=media`, {
      headers: { Range: `bytes=${start}-${endExclusive - 1}` },
      signal,
    });
    if (response.status !== 206) throw await driveError(response, "download exact encrypted segment range");
    const range = parseContentRange(response.headers.get("content-range"));
    if (range.start !== start || range.endExclusive !== endExclusive || range.total !== entry.size) {
      throw new Error("Google Drive returned a mismatched segment range.");
    }
    const bytes = await boundedBytes(response, length, "Google Drive segment range", length);
    return { key: canonical, bytes, etag: entry.etag, start, endExclusive, totalSize: entry.size };
  }

  async putIfAbsent(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<PutIfAbsentResult> {
    const canonical = logicalKey(key);
    const content = objectBytes(bytes);
    const etag = await sha256(content);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = await this.loadIndex(signal, true);
      const existing = loaded.index.entries.find((entry) => entry.key === canonical);
      if (existing) return { created: false, currentEtag: existing.etag, reason: "exists" };
      if (loaded.index.entries.length >= MAX_OBJECTS) throw new Error("Google Drive object index exceeds the client limit.");
      const entry = await this.uploadSegment(canonical, etag, content, signal);
      const next = replaceEntry(loaded.index, entry);
      if (await this.advanceIndex(loaded, next, signal)) return { created: true, etag };
    }
    throw new Error("Google Drive conditional-create retry budget was exhausted.");
  }

  async compareAndSwap(
    key: string,
    expectedEtag: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<CompareAndSwapResult> {
    const canonical = logicalKey(key);
    const expected = expectedObjectEtag(expectedEtag);
    const content = objectBytes(bytes);
    const etag = await sha256(content);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = await this.loadIndex(signal, true);
      const existing = loaded.index.entries.find((entry) => entry.key === canonical);
      if (!existing) return { updated: false, reason: "missing" };
      if (existing.etag !== expected) {
        return { updated: false, currentEtag: existing.etag, reason: "precondition-failed" };
      }
      const entry = await this.uploadSegment(canonical, etag, content, signal);
      const next = replaceEntry(loaded.index, entry);
      if (await this.advanceIndex(loaded, next, signal)) return { updated: true, etag };
    }
    const latest = await this.loadIndex(signal, true);
    const current = latest.index.entries.find((entry) => entry.key === canonical);
    return current
      ? { updated: false, currentEtag: current.etag, reason: "precondition-failed" }
      : { updated: false, reason: "missing" };
  }

  async list(prefix: string, signal?: AbortSignal): Promise<ObjectSummary[]> {
    const canonical = logicalPrefix(prefix);
    const loaded = await this.loadIndex(signal);
    return loaded.index.entries
      .filter((entry) => entry.key.startsWith(canonical))
      .map((entry) => ({ key: entry.key, etag: entry.etag, size: entry.size, updatedAt: entry.updatedAt }));
  }

  private async loadIndex(signal?: AbortSignal, forceRefresh = false): Promise<LoadedIndex> {
    if (forceRefresh) {
      this.cacheEpoch += 1;
      this.indexCache = undefined;
      // A writer never joins a read-side cache fill because that fill may have
      // begun before the writer's operation. Fetch an independent fresh root.
      return this.loadIndexFresh(signal);
    }
    const cached = this.indexCache;
    if (cached && cached.expiresAt > Date.now()) return cached.loaded;
    const epoch = this.cacheEpoch;
    if (!this.indexLoad || this.indexLoad.epoch !== epoch) {
      const promise = this.loadIndexFresh()
      .then((loaded) => {
        if (this.cacheEpoch === epoch) this.indexCache = { loaded, expiresAt: Date.now() + INDEX_CACHE_TTL_MS };
        return loaded;
      })
      .finally(() => {
        if (this.indexLoad?.promise === promise) this.indexLoad = undefined;
      });
      this.indexLoad = { epoch, promise };
    }
    return awaitWithAbort(this.indexLoad.promise, signal);
  }

  private async loadIndexFresh(signal?: AbortSignal, relocated = false): Promise<LoadedIndex> {
    // Re-list on every uncached/fresh load. Drive names are not unique, so a
    // remembered ID cannot prove that a second authority root was not added.
    const fileId = await this.locateOrCreateIndex(signal);
    this.indexId = fileId;
    const response = await this.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, { signal });
    if (response.status === 404) {
      this.indexId = undefined;
      if (relocated) throw new Error("Google Drive object index remained unavailable after one relocation attempt.");
      return this.loadIndexFresh(signal, true);
    }
    if (!response.ok) throw await driveError(response, "download encrypted object index");
    const httpEtag = strictHttpEtag(response.headers.get("etag"));
    const bytes = await boundedBytes(response, MAX_INDEX_BYTES, "Google Drive encrypted object index");
    return { fileId, httpEtag, index: await this.openIndex(bytes) };
  }

  private async locateOrCreateIndex(signal?: AbortSignal): Promise<string> {
    const candidates = await this.listIndexFiles(signal);
    if (candidates.length > 1) throw ambiguousIndexError(candidates.length);
    if (candidates.length === 1) return candidates[0]!.id;
    const bytes = await this.sealIndex({ version: 1, generation: 0, entries: [] });
    await this.createMultipartFile({
      name: ".airship-root-v1.enc",
      parentId: this.options.workspace.rootFolderId,
      bytes,
      mimeType: INDEX_CONTENT_TYPE,
      appProperties: {
        airshipNamespace: this.options.workspace.namespaceId,
        airshipRole: "object-index-v1",
      },
      signal,
    });
    // Names are not unique in Drive. Re-list after create and fail closed if a
    // concurrent initializer produced an ambiguous authority root.
    const winners = await this.listIndexFiles(signal);
    if (!winners.length) throw new Error("Google Drive object index disappeared after creation.");
    if (winners.length > 1) throw ambiguousIndexError(winners.length);
    return winners[0]!.id;
  }

  private async listIndexFiles(signal?: AbortSignal): Promise<DriveFile[]> {
    const namespace = escapeDriveQuery(this.options.workspace.namespaceId);
    const parent = escapeDriveQuery(this.options.workspace.rootFolderId);
    const q = [
      `'${parent}' in parents`,
      "trashed = false",
      `appProperties has { key='airshipNamespace' and value='${namespace}' }`,
      "appProperties has { key='airshipRole' and value='object-index-v1' }",
    ].join(" and ");
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set("q", q);
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("pageSize", "10");
    url.searchParams.set("fields", "files(id,name,mimeType,size,modifiedTime,appProperties)");
    const response = await this.driveFetch(url, { signal });
    const body = await driveJson<{ files?: DriveFile[] }>(response, "locate encrypted object index");
    return (body.files ?? []).filter((file) => {
      assertDriveFile(file);
      return file.appProperties?.airshipNamespace === this.options.workspace.namespaceId
        && file.appProperties.airshipRole === "object-index-v1";
    }).sort((left, right) => left.id.localeCompare(right.id));
  }

  private async advanceIndex(current: LoadedIndex, next: DriveIndex, signal?: AbortSignal): Promise<boolean> {
    const bytes = await this.sealIndex(next);
    const response = await this.driveFetch(`${DRIVE_UPLOAD}/files/${encodeURIComponent(current.fileId)}?uploadType=media&fields=id`, {
      method: "PATCH",
      headers: {
        "Content-Type": INDEX_CONTENT_TYPE,
        "If-Match": current.httpEtag,
      },
      body: ownedArrayBuffer(bytes),
      signal,
    });
    this.cacheEpoch += 1;
    this.indexCache = undefined;
    if (response.status === 409 || response.status === 412) return false;
    if (!response.ok) throw await driveError(response, "commit encrypted object index");
    return true;
  }

  private async uploadSegment(key: string, etag: string, bytes: Uint8Array, signal?: AbortSignal): Promise<IndexEntry> {
    const opaqueName = await this.options.workspaceKey.opaqueObjectId(`airship/google-drive-segment/v1\0${key}\0${etag}`);
    const upload = {
      name: `${opaqueName}.enc`,
      parentId: this.options.workspace.segmentsFolderId,
      bytes,
      mimeType: SEGMENT_CONTENT_TYPE,
      appProperties: {
        airshipNamespace: this.options.workspace.namespaceId,
        airshipRole: "encrypted-segment-v1",
      },
      signal,
    };
    const file = bytes.byteLength >= RESUMABLE_UPLOAD_THRESHOLD_BYTES
      ? await this.createResumableFile(upload)
      : await this.createMultipartFile(upload);
    return Object.freeze({
      key,
      fileId: file.id,
      etag,
      size: bytes.byteLength,
      updatedAt: validTimestamp(file.modifiedTime ?? this.now().toISOString()),
    });
  }

  /**
   * Drive resumable upload with in-call offset recovery. The session URL is a
   * bearer-like capability and is deliberately never returned, persisted, or
   * retained after this method settles. A refresh retries the immutable shard,
   * not an old session URL.
   */
  private async createResumableFile(args: {
    name: string;
    parentId: string;
    bytes: Uint8Array;
    mimeType: string;
    appProperties: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<DriveFile> {
    const metadata = stableStringify({
      name: args.name,
      mimeType: args.mimeType,
      parents: [args.parentId],
      appProperties: args.appProperties,
    } as unknown as JsonValue);
    const initiation = await this.driveFetch(
      `${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id,name,mimeType,size,modifiedTime,appProperties`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": args.mimeType,
          "X-Upload-Content-Length": String(args.bytes.byteLength),
        },
        body: metadata,
        signal: args.signal,
      },
    );
    if (!initiation.ok) throw await driveError(initiation, "start resumable encrypted-object upload");
    const sessionUrl = resumableSessionUrl(initiation.headers.get("location"));
    await discardResponseBody(initiation);
    let offset = 0;
    let recoveryAttempts = 0;
    while (offset < args.bytes.byteLength) {
      args.signal?.throwIfAborted();
      const endExclusive = Math.min(args.bytes.byteLength, offset + RESUMABLE_UPLOAD_CHUNK_BYTES);
      let response: Response;
      try {
        response = await this.driveFetch(sessionUrl, {
          method: "PUT",
          headers: {
            "Content-Type": args.mimeType,
            "Content-Length": String(endExclusive - offset),
            "Content-Range": `bytes ${offset}-${endExclusive - 1}/${args.bytes.byteLength}`,
          },
          body: ownedArrayBuffer(args.bytes.slice(offset, endExclusive)),
          signal: args.signal,
        });
      } catch (error) {
        if (args.signal?.aborted) throw error;
        response = await this.queryResumableUpload(sessionUrl, args.bytes.byteLength, args.signal);
      }
      if (response.status === 308) {
        try {
          const committed = resumableCommittedOffset(response.headers.get("range"), args.bytes.byteLength);
          if (committed < offset || committed > endExclusive) {
            throw new Error("Google Drive resumable upload reported an invalid committed range.");
          }
          offset = committed;
          recoveryAttempts = committed === endExclusive ? 0 : recoveryAttempts + 1;
          if (recoveryAttempts > MAX_RESUMABLE_RECOVERY_ATTEMPTS) {
            throw new Error("Google Drive resumable upload made no progress within its recovery budget.");
          }
        } finally {
          await discardResponseBody(response);
        }
        continue;
      }
      if (response.ok) {
        if (endExclusive !== args.bytes.byteLength) {
          throw new Error("Google Drive completed a resumable upload before all bytes were acknowledged.");
        }
        const file = await responseJson<DriveFile>(response, "complete resumable encrypted-object upload");
        assertDriveFile(file);
        return file;
      }
      if (!isRetryableUploadStatus(response.status) || recoveryAttempts >= MAX_RESUMABLE_RECOVERY_ATTEMPTS) {
        throw await driveError(response, "resume encrypted-object upload");
      }
      recoveryAttempts += 1;
      await discardResponseBody(response);
      response = await this.queryResumableUpload(sessionUrl, args.bytes.byteLength, args.signal);
      if (response.ok && response.status !== 308) {
        const file = await responseJson<DriveFile>(response, "recover completed encrypted-object upload");
        assertDriveFile(file);
        return file;
      }
      try {
        offset = resumableCommittedOffset(response.headers.get("range"), args.bytes.byteLength);
      } finally {
        await discardResponseBody(response);
      }
    }
    throw new Error("Google Drive resumable upload ended without final file metadata.");
  }

  private async queryResumableUpload(sessionUrl: string, totalBytes: number, signal?: AbortSignal): Promise<Response> {
    const response = await this.driveFetch(sessionUrl, {
      method: "PUT",
      headers: {
        "Content-Length": "0",
        "Content-Range": `bytes */${totalBytes}`,
      },
      signal,
    });
    if (response.status === 404 || response.status === 410) {
      throw new Error("Google Drive resumable upload session expired; retry the immutable shard.");
    }
    if (response.status !== 308 && !response.ok) throw await driveError(response, "query resumable encrypted-object upload");
    return response;
  }

  private async createMultipartFile(args: {
    name: string;
    parentId: string;
    bytes: Uint8Array;
    mimeType: string;
    appProperties: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<DriveFile> {
    const boundary = `airship_${crypto.getRandomValues(new Uint32Array(4)).join("_")}`;
    const metadata = stableStringify({
      name: args.name,
      mimeType: args.mimeType,
      parents: [args.parentId],
      appProperties: args.appProperties,
    } as unknown as JsonValue);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${args.mimeType}\r\n\r\n`,
      ownedArrayBuffer(args.bytes),
      `\r\n--${boundary}--\r\n`,
    ]);
    const response = await this.driveFetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,appProperties`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      signal: args.signal,
    });
    const file = await driveJson<DriveFile>(response, "upload encrypted vault object");
    assertDriveFile(file);
    return file;
  }

  private async sealIndex(index: DriveIndex): Promise<Uint8Array> {
    const plaintext = encoder.encode(stableStringify(index as unknown as JsonValue));
    if (plaintext.byteLength > MAX_INDEX_BYTES - 2_048) throw new Error("Google Drive object index exceeds the client limit.");
    return encodeEnvelope(await sealEnvelope({
      key: this.options.workspaceKey,
      namespace: INDEX_NAMESPACE,
      logicalId: this.options.workspace.namespaceId,
      revision: String(index.generation),
      contentType: INDEX_CONTENT_TYPE,
      plaintext,
    }));
  }

  private async openIndex(bytes: Uint8Array): Promise<DriveIndex> {
    const envelope = decodeEnvelope(bytes);
    const plaintext = await openEnvelope({
      key: this.options.workspaceKey,
      envelope,
      expectedNamespace: INDEX_NAMESPACE,
      expectedLogicalId: this.options.workspace.namespaceId,
      maxPlaintextBytes: MAX_INDEX_BYTES,
    });
    let value: unknown;
    try { value = JSON.parse(decoder.decode(plaintext)); }
    catch { throw new Error("Google Drive encrypted object index is not valid JSON."); }
    const index = parseIndex(value);
    if (envelope.revision !== String(index.generation) || envelope.aad.contentType !== INDEX_CONTENT_TYPE) {
      throw new Error("Google Drive encrypted object index revision is inconsistent.");
    }
    return index;
  }

  private async driveFetch(input: string | URL, init: RequestInit): Promise<Response> {
    const token = await this.options.tokenProvider.getAccessToken(init.signal ?? undefined);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token.accessToken}`);
    return this.fetchImplementation(input, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  }
}

function replaceEntry(index: DriveIndex, entry: IndexEntry): DriveIndex {
  const entries = index.entries.filter((candidate) => candidate.key !== entry.key).concat(entry)
    .sort((left, right) => left.key.localeCompare(right.key));
  return Object.freeze({ version: 1, generation: index.generation + 1, entries: Object.freeze(entries) });
}

function parseIndex(value: unknown): DriveIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Google Drive encrypted object index is invalid.");
  const raw = value as { version?: unknown; generation?: unknown; entries?: unknown };
  if (raw.version !== 1 || !Number.isSafeInteger(raw.generation) || (raw.generation as number) < 0 || !Array.isArray(raw.entries) || raw.entries.length > MAX_OBJECTS) {
    throw new Error("Google Drive encrypted object index is invalid.");
  }
  const seen = new Set<string>();
  const entries = raw.entries.map((candidate): IndexEntry => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Google Drive encrypted object index entry is invalid.");
    const entry = candidate as Partial<IndexEntry>;
    const key = logicalKey(entry.key ?? "");
    if (seen.has(key)) throw new Error("Google Drive encrypted object index contains duplicate keys.");
    seen.add(key);
    if (!driveId(entry.fileId) || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_OBJECT_BYTES) {
      throw new Error("Google Drive encrypted object index entry is invalid.");
    }
    return Object.freeze({ key, fileId: entry.fileId!, etag: exactEtag(entry.etag ?? ""), size: entry.size, updatedAt: validTimestamp(entry.updatedAt ?? "") });
  }).sort((left, right) => left.key.localeCompare(right.key));
  return Object.freeze({ version: 1, generation: raw.generation as number, entries: Object.freeze(entries) });
}

function logicalKey(value: string): string {
  if (!value || value.length > 1_024 || value.startsWith("/") || value.includes("//") || /[\u0000-\u001f]/u.test(value)) throw new Error("Google Drive object key is invalid.");
  return value;
}

function logicalPrefix(value: string): string {
  if (value === "") return "";
  return logicalKey(value);
}

function objectBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_OBJECT_BYTES) throw new Error("Google Drive object exceeds the client limit.");
  return value.slice();
}

function exactEtag(value: string): string {
  if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Google Drive object ETag is invalid.");
  return value;
}

function expectedObjectEtag(value: string): string {
  if (!value || value.length > 256 || /[\r\n]/u.test(value)) throw new Error("Expected Google Drive object ETag is invalid.");
  return value;
}

function strictHttpEtag(value: string | null): string {
  if (!value || value.length > 256 || /[\r\n]/u.test(value)) throw new Error("Google Drive did not expose a usable HTTP ETag for conditional index writes.");
  return value;
}

function driveId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,256}$/u.test(value);
}

function assertDriveFile(value: unknown): asserts value is DriveFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Google Drive returned invalid file metadata.");
  const file = value as Partial<DriveFile>;
  if (!driveId(file.id) || typeof file.name !== "string" || typeof file.mimeType !== "string") throw new Error("Google Drive returned invalid file metadata.");
}

function validateWorkspace(workspace: GoogleDriveWorkspace): void {
  if (![workspace.workspaceFolderId, workspace.rootFolderId, workspace.segmentsFolderId].every(driveId) || !/^[A-Za-z0-9_-]{20,128}$/u.test(workspace.namespaceId)) {
    throw new Error("Google Drive workspace descriptor is invalid.");
  }
}

function validTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Google Drive returned an invalid modification time.");
  return timestamp.toISOString();
}

function validRange(start: number, endExclusive: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive <= start) {
    throw new Error("Google Drive ranges require non-negative, increasing integer offsets.");
  }
}

function parseContentRange(value: string | null): { start: number; endExclusive: number; total: number } {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value ?? "");
  if (!match) throw new Error("Google Drive returned an invalid Content-Range header.");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || end < start || total <= end) throw new Error("Google Drive returned an invalid Content-Range header.");
  return { start, endExclusive: end + 1, total };
}

async function boundedBytes(response: Response, maximum: number, label: string, exact?: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared)) throw new Error(`${label} declared an invalid size.`);
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum || (exact !== undefined && size !== exact)) throw new Error(`${label} declared an invalid size.`);
  }
  if (!response.body) {
    if (exact === 0) return new Uint8Array();
    throw new Error(`${label} returned an empty body.`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum || (exact !== undefined && total > exact)) {
        await reader.cancel(`${label} exceeded its bounded response size.`).catch(() => undefined);
        throw new Error(`${label} returned an invalid size.`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* a cancelled stream may retain its reader */ }
  }
  if (exact !== undefined && total !== exact) throw new Error(`${label} returned an invalid size.`);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function driveJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) throw await driveError(response, operation);
  try { return JSON.parse(decoder.decode(await boundedBytes(response, MAX_DRIVE_JSON_BYTES, "Google Drive JSON response"))) as T; }
  catch { throw new Error(`Google Drive returned invalid JSON while attempting to ${operation}.`); }
}

async function responseJson<T>(response: Response, operation: string): Promise<T> {
  try { return JSON.parse(decoder.decode(await boundedBytes(response, MAX_DRIVE_JSON_BYTES, "Google Drive JSON response"))) as T; }
  catch { throw new Error(`Google Drive returned invalid JSON while attempting to ${operation}.`); }
}

function resumableSessionUrl(value: string | null): string {
  if (!value || value.length > 4_096 || /[\r\n]/u.test(value)) {
    throw new Error("Google Drive did not return a usable resumable upload session.");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== "https://www.googleapis.com" || !url.pathname.startsWith("/upload/drive/v3/")) {
    throw new Error("Google Drive returned a resumable upload session outside the pinned API origin.");
  }
  return url.href;
}

function resumableCommittedOffset(value: string | null, totalBytes: number): number {
  if (value === null) return 0;
  const match = /^bytes=0-(\d+)$/u.exec(value.trim());
  if (!match) throw new Error("Google Drive resumable upload returned an invalid committed range.");
  const endInclusive = Number(match[1]);
  if (!Number.isSafeInteger(endInclusive) || endInclusive < 0 || endInclusive >= totalBytes) {
    throw new Error("Google Drive resumable upload returned an out-of-bounds committed range.");
  }
  return endInclusive + 1;
}

function isRetryableUploadStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function driveError(response: Response, operation: string): Promise<Error> {
  void response.body?.cancel().catch(() => undefined);
  const error = new Error(`Google Drive could not ${operation} (${response.status}).`);
  error.name = "GoogleDriveStorageError";
  return error;
}

function escapeDriveQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function ambiguousIndexError(count: number): Error {
  const error = new Error(`Google Drive contains ${count} object-index roots for this workspace. Authority is ambiguous; repair or explicitly migrate the roots before reconnecting.`);
  error.name = "GoogleDriveAmbiguousRootError";
  return error;
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Google Drive request was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Google Drive request was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}
