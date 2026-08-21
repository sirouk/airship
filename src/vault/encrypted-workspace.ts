import type { JsonValue } from "../core/contracts";
import { stableStringify, sha256 } from "../core/hash";
import { randomUuid } from "../core/id";
import {
  WorkspaceConflictError,
  normalizeWorkspacePath,
  type WorkspaceEntry,
  type WorkspaceFile,
  type ClientEncryptedWorkspacePort,
  type PortableSealPort,
  type WorkspacePort,
} from "../workspace/contracts";
import { workspaceContentByteLength } from "../workspace/content-codec";
import {
  WorkspaceRootKey,
  decodeEnvelope,
  encodeEnvelope,
  openEnvelope,
  sealEnvelope,
} from "../storage/encrypted-envelope";
import type { ObjectRecord, ObjectStore } from "../storage/object-store";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ROOT_NAMESPACE = "airship/workspace-head/v1";
const FILE_NAMESPACE = "airship/workspace-file/v1";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
/** One logical name for every caller-owned sealed artifact; see `sealPortable`. */
const PORTABLE_SEAL_LOGICAL_ID = "portable";

type WorkspaceManifestEntry = WorkspaceEntry & {
  cloudKey: string;
  etag: string;
};

type WorkspaceManifest = {
  version: 1;
  generation: number;
  files: WorkspaceManifestEntry[];
};

type LoadedManifest = {
  record: ObjectRecord;
  manifest: WorkspaceManifest;
};

/**
 * What the workspace needs from the Vault-wide reclamation queue: a
 * best-effort record of the revisions a committed CAS just made unreachable.
 * The queue stamps the supersession time itself; recording never throws and
 * never participates in whether the write succeeded, which already committed
 * at the manifest CAS by the time this is called.
 */
export interface WorkspaceSupersessionRecorder {
  recordSuperseded(cloudKeys: readonly string[]): Promise<boolean>;
}

/**
 * Strict cloud workspace: immutable encrypted file objects are committed first,
 * then one encrypted manifest is advanced with CAS. Lost CAS races leave only
 * opaque ciphertext orphans and never acknowledge the conflicting mutation.
 */
export class EncryptedObjectWorkspace implements WorkspacePort, ClientEncryptedWorkspacePort, PortableSealPort {
  readonly encryptionBoundary = "airship-client-envelope-v1" as const;
  private readonly prefix: string;

  constructor(
    private readonly store: ObjectStore,
    private readonly key: WorkspaceRootKey,
    prefix = "state/workspace/v1",
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = randomUuid,
    private readonly reclamation?: WorkspaceSupersessionRecorder,
  ) {
    this.prefix = canonicalPrefix(prefix);
  }

  /**
   * Seal bytes the caller owns, under this Vault's key, without exposing it.
   *
   * This is how a *sealed* work bundle leaves the device. It reuses exactly the
   * envelope this workspace already writes its own files with — AES-256-GCM
   * with an HKDF-derived per-object key — so nothing new is invented and
   * nothing new has to be reviewed as cryptography. The revision is fresh per
   * seal, which is what keeps the derived content key and the nonce unique.
   *
   * The consequence is stated wherever this is offered: only Airship, opened
   * against this same Vault, can read the result back.
   */
  async sealPortable(namespace: string, plaintext: Uint8Array): Promise<Uint8Array> {
    return encodeEnvelope(await sealEnvelope({
      key: this.key,
      namespace,
      logicalId: PORTABLE_SEAL_LOGICAL_ID,
      revision: this.id(),
      contentType: "application/json",
      plaintext,
    }));
  }

  /** The inverse. A bundle sealed by another Vault fails here, by design. */
  async openPortable(namespace: string, sealed: Uint8Array): Promise<Uint8Array> {
    return openEnvelope({
      key: this.key,
      envelope: decodeEnvelope(sealed),
      expectedNamespace: namespace,
      expectedLogicalId: PORTABLE_SEAL_LOGICAL_ID,
    });
  }

  async read(path: string): Promise<WorkspaceFile | undefined> {
    const normalized = normalizeWorkspacePath(path);
    const loaded = await this.loadManifest();
    if (!loaded) return undefined;
    const { manifest } = loaded;
    const entry = manifest.files.find((candidate) => candidate.path === normalized);
    if (!entry) return undefined;
    return this.readEntry(entry);
  }

  async readBounded(path: string, maxBytes: number): Promise<WorkspaceFile | undefined> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_BYTES) {
      throw new Error("Encrypted workspace bounded reads require a 1 byte to 16 MiB limit.");
    }
    const normalized = normalizeWorkspacePath(path);
    const loaded = await this.loadManifest();
    const entry = loaded?.manifest.files.find((candidate) => candidate.path === normalized);
    if (!entry) return undefined;
    // AES-GCM authenticates the complete immutable object. For an oversized
    // file, returning committed metadata and an empty preview avoids silently
    // downloading/decrypting the whole object under a bounded-read request.
    if (entry.size > maxBytes) {
      return {
        path: entry.path,
        content: "",
        revision: entry.revision,
        updatedAt: entry.updatedAt,
        size: entry.size,
        // Nothing was decrypted, so the committed entry is the only witness of
        // the decoded length. Legacy entries have none and fall back to `size`.
        ...(entry.contentByteLength === undefined ? {} : { contentByteLength: entry.contentByteLength }),
      };
    }
    return this.readEntry(entry);
  }

  async list(path = "/workspace"): Promise<WorkspaceEntry[]> {
    const normalized = normalizeWorkspacePath(path);
    const loaded = await this.loadManifest();
    if (!loaded) return [];
    const { manifest } = loaded;
    return manifest.files
      .filter((entry) => entry.path === normalized || entry.path.startsWith(`${normalized}/`))
      .map(({ cloudKey: _cloudKey, etag: _etag, ...entry }) => structuredClone(entry));
  }

  async write(
    path: string,
    content: string,
    options: { expectedRevision?: string | null } = {},
  ): Promise<WorkspaceFile> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === "/workspace") throw new Error("Cannot write to the workspace root.");
    const contentBytes = encoder.encode(content);
    if (contentBytes.byteLength > MAX_FILE_BYTES) throw new Error("Encrypted workspace file exceeds the client limit.");
    const loaded = await this.loadOrCreateManifest();
    const current = loaded.manifest.files.find((candidate) => candidate.path === normalized);
    checkExpectedRevision(current, options.expectedRevision);
    if (!current && loaded.manifest.files.length >= MAX_FILES) {
      throw new Error("Encrypted workspace exceeds the client file limit.");
    }

    const file: WorkspaceFile = {
      path: normalized,
      content,
      revision: this.id(),
      updatedAt: validTimestamp(this.now(), "workspace update time"),
      // `size` stays the sealed plaintext length: `openFile` proves the object
      // against it. The decoded length is carried beside it so a binary file
      // is not presented as its ~4/3 base64 envelope.
      size: contentBytes.byteLength,
      contentByteLength: workspaceContentByteLength(content),
    };
    const logicalId = fileLogicalId(file.path, file.revision);
    const cloudKey = `${this.prefix}/files/${await this.key.opaqueObjectId(logicalId)}`;
    const bytes = await this.sealFile(file, logicalId);
    const created = await this.store.putIfAbsent(cloudKey, bytes);
    let etag: string;
    if (created.created) {
      etag = created.etag;
    } else {
      const existing = await this.store.get(cloudKey);
      if (!existing) throw new Error("Encrypted workspace file conflicted and then disappeared.");
      const opened = await this.openFile(existing, file.path, file.revision, file.updatedAt, file.size);
      if (
        stableStringify(opened as unknown as JsonValue) !==
        stableStringify(file as unknown as JsonValue)
      ) {
        throw new Error("Encrypted workspace file identifier collided with different content.");
      }
      etag = existing.etag;
    }

    const nextEntry: WorkspaceManifestEntry = {
      path: file.path,
      revision: file.revision,
      updatedAt: file.updatedAt,
      size: file.size,
      contentByteLength: file.contentByteLength,
      cloudKey,
      etag,
    };
    const files = loaded.manifest.files
      .filter((entry) => entry.path !== normalized)
      .concat(nextEntry)
      .sort((left, right) => compareWorkspacePaths(left.path, right.path));
    try {
      await this.advanceManifest(loaded, { version: 1, generation: loaded.manifest.generation + 1, files });
    } catch (error) {
      // On a lost CAS the just-minted revision is the orphan, not the old one:
      // no committed manifest will ever reference this key again.
      await this.dropCachedRevision(cloudKey);
      throw error;
    }
    if (current) await this.supersedeCommittedRevision(current.cloudKey);
    return structuredClone(file);
  }

  async remove(path: string, options: { expectedRevision?: string } = {}): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    const loaded = await this.loadManifest();
    if (!loaded) return;
    const current = loaded.manifest.files.find((candidate) => candidate.path === normalized);
    if (!current) return;
    checkExpectedRevision(current, options.expectedRevision);
    const files = loaded.manifest.files.filter((entry) => entry.path !== normalized);
    await this.advanceManifest(loaded, { version: 1, generation: loaded.manifest.generation + 1, files });
    await this.supersedeCommittedRevision(current.cloudKey);
  }

  /**
   * The cloud keys the freshest committed manifest still references — the
   * reclamation sweep's re-verification set. A candidate that appears here is
   * reconciled out of the queue rather than ever being offered to the
   * provider; the manifest is the authority, never the queue.
   */
  async collectReferencedObjectKeys(): Promise<readonly string[]> {
    const loaded = await this.loadManifest();
    if (!loaded) return Object.freeze([] as readonly string[]);
    return Object.freeze(loaded.manifest.files.map((entry) => entry.cloudKey));
  }

  /**
   * A committed manifest CAS is what made this revision unreachable, so the
   * aged-supersession queue is told first and the read-side acceleration page
   * second. Neither is the mutation itself: recording is best-effort and the
   * provider object stays until the bounded sweep ages and re-verifies it.
   */
  private async supersedeCommittedRevision(cloudKey: string): Promise<void> {
    if (this.reclamation) await this.reclamation.recordSuperseded([cloudKey]);
    await this.dropCachedRevision(cloudKey);
  }

  /**
   * Releases a revision-scoped ciphertext page from the acceleration cache when
   * the committed manifest can no longer reference it. Provider authority is
   * untouched: the object itself stays until a reclamation job trashes it, so a
   * reader holding an older manifest generation still resolves.
   */
  private async dropCachedRevision(cloudKey: string): Promise<void> {
    const store = this.store as ObjectStore & { dropSupersededRevision?(key: string): Promise<void> };
    if (typeof store.dropSupersededRevision !== "function") return;
    await store.dropSupersededRevision(cloudKey).catch(() => undefined);
  }

  private async readEntry(entry: WorkspaceManifestEntry): Promise<WorkspaceFile> {
    const record = await this.store.get(entry.cloudKey);
    if (!record) throw new Error("Encrypted workspace file is missing.");
    if (record.etag !== entry.etag) throw new Error("Encrypted workspace immutable file ETag changed.");
    return this.openFile(record, entry.path, entry.revision, entry.updatedAt, entry.size);
  }

  private async loadOrCreateManifest(): Promise<LoadedManifest> {
    const loaded = await this.loadManifest();
    if (loaded) return loaded;
    const key = await this.rootCloudKey();
    const manifest: WorkspaceManifest = { version: 1, generation: 0, files: [] };
    const bytes = await this.sealManifest(manifest);
    const created = await this.store.putIfAbsent(key, bytes);
    if (created.created) {
      return {
        record: { key, bytes, etag: created.etag },
        manifest,
      };
    }
    const winner = await this.store.get(key);
    if (!winner) throw new Error("Encrypted workspace root conflicted and then disappeared.");
    return { record: winner, manifest: await this.openManifest(winner) };
  }

  private async loadManifest(): Promise<LoadedManifest | undefined> {
    const record = await this.store.get(await this.rootCloudKey());
    if (!record) return undefined;
    return { record, manifest: await this.openManifest(record) };
  }

  private async advanceManifest(current: LoadedManifest, next: WorkspaceManifest): Promise<void> {
    const bytes = await this.sealManifest(next);
    const result = await this.store.compareAndSwap(current.record.key, current.record.etag, bytes);
    if (!result.updated) throw new WorkspaceConflictError("The encrypted workspace root changed before commit.");
  }

  private async rootCloudKey(): Promise<string> {
    return `${this.prefix}/heads/${await this.key.opaqueObjectId(rootLogicalId(this.prefix))}`;
  }

  private async sealManifest(manifest: WorkspaceManifest): Promise<Uint8Array> {
    const plaintext = encodeJson(manifest);
    if (plaintext.byteLength > MAX_MANIFEST_BYTES) throw new Error("Encrypted workspace manifest exceeds the client limit.");
    const digest = await sha256(plaintext);
    return encodeEnvelope(await sealEnvelope({
      key: this.key,
      namespace: ROOT_NAMESPACE,
      logicalId: rootLogicalId(this.prefix),
      revision: `${manifest.generation}:${digest}`,
      contentType: "application/vnd.airship.workspace-head+json",
      plaintext,
    }));
  }

  private async openManifest(record: ObjectRecord): Promise<WorkspaceManifest> {
    const envelope = decodeEnvelope(record.bytes);
    const plaintext = await openEnvelope({
      key: this.key,
      envelope,
      expectedNamespace: ROOT_NAMESPACE,
      expectedLogicalId: rootLogicalId(this.prefix),
      maxPlaintextBytes: MAX_MANIFEST_BYTES,
    });
    const manifest = parseManifest(plaintext, this.prefix);
    const digest = await sha256(plaintext);
    if (
      envelope.revision !== `${manifest.generation}:${digest}` ||
      envelope.aad.contentType !== "application/vnd.airship.workspace-head+json" ||
      record.key !== await this.rootCloudKey()
    ) {
      throw new Error("Encrypted workspace root metadata does not match its contents.");
    }
    return manifest;
  }

  private async sealFile(file: WorkspaceFile, logicalId: string): Promise<Uint8Array> {
    return encodeEnvelope(await sealEnvelope({
      key: this.key,
      namespace: FILE_NAMESPACE,
      logicalId,
      revision: file.revision,
      contentType: "text/plain;charset=utf-8",
      plaintext: encoder.encode(file.content),
    }));
  }

  private async openFile(
    record: ObjectRecord,
    path: string,
    revision: string,
    updatedAt: string,
    expectedSize: number,
  ): Promise<WorkspaceFile> {
    const envelope = decodeEnvelope(record.bytes);
    const plaintext = await openEnvelope({
      key: this.key,
      envelope,
      expectedNamespace: FILE_NAMESPACE,
      expectedLogicalId: fileLogicalId(path, revision),
      maxPlaintextBytes: MAX_FILE_BYTES,
    });
    if (plaintext.byteLength !== expectedSize) {
      throw new Error("Encrypted workspace file byte size does not match its committed manifest entry.");
    }
    let content: string;
    try {
      content = decoder.decode(plaintext);
    } catch (cause) {
      throw new Error("Encrypted workspace file is not valid UTF-8.", { cause });
    }
    if (
      envelope.revision !== revision ||
      envelope.aad.contentType !== "text/plain;charset=utf-8"
    ) {
      throw new Error("Encrypted workspace file metadata does not match its contents.");
    }
    // Derived from the plaintext AES-GCM just authenticated rather than copied
    // from the manifest, so an object opened from a pre-`contentByteLength`
    // manifest still reports its true decoded length.
    return { path, content, revision, updatedAt, size: expectedSize, contentByteLength: workspaceContentByteLength(content) };
  }
}

function parseManifest(bytes: Uint8Array, prefix: string): WorkspaceManifest {
  const value = parseJson(bytes, "encrypted workspace manifest");
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0 || !Array.isArray(value.files)) {
    throw new Error("Encrypted workspace manifest is invalid.");
  }
  if (value.files.length > MAX_FILES) throw new Error("Encrypted workspace manifest has too many files.");
  const files = value.files.map(parseManifestEntry);
  for (let index = 0; index < files.length; index += 1) {
    const entry = files[index]!;
    if (index > 0 && files[index - 1]!.path >= entry.path) {
      throw new Error("Encrypted workspace manifest paths are duplicated or unsorted.");
    }
    if (!entry.cloudKey.startsWith(`${prefix}/files/`)) {
      throw new Error("Encrypted workspace manifest references an object outside its prefix.");
    }
  }
  return { version: 1, generation: Number(value.generation), files };
}

/** Locale-independent order matching the manifest parser's canonical check. */
function compareWorkspacePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseManifestEntry(value: unknown): WorkspaceManifestEntry {
  if (!isRecord(value)) throw new Error("Encrypted workspace manifest entry is invalid.");
  const path = normalizeWorkspacePath(requiredString(value.path, "workspace path", 4_096));
  if (path === "/workspace") throw new Error("Encrypted workspace manifest contains the workspace root as a file.");
  const size = requiredInteger(value.size, "workspace file size", true);
  if (size > MAX_FILE_BYTES) throw new Error("Encrypted workspace manifest file exceeds the client limit.");
  // Optional by design: manifests sealed before this field existed are still
  // valid, and every read path can re-derive the length from the plaintext.
  // A present value is validated as strictly as `size` and can never exceed it,
  // because decoding an envelope only ever removes bytes.
  const contentByteLength = value.contentByteLength === undefined
    ? undefined
    : requiredInteger(value.contentByteLength, "workspace file content byte length", true);
  if (contentByteLength !== undefined && contentByteLength > size) {
    throw new Error("Encrypted workspace manifest content byte length exceeds its stored size.");
  }
  return {
    path,
    revision: requiredString(value.revision, "workspace revision", 512),
    updatedAt: validTimestamp(requiredString(value.updatedAt, "workspace update time", 128), "workspace update time"),
    size,
    ...(contentByteLength === undefined ? {} : { contentByteLength }),
    cloudKey: requiredString(value.cloudKey, "workspace cloud key", 4_096),
    etag: requiredString(value.etag, "workspace ETag", 4_096),
  };
}

function checkExpectedRevision(
  current: Pick<WorkspaceManifestEntry, "revision"> | undefined,
  expected: string | null | undefined,
): void {
  if (expected === undefined) return;
  if (expected === null && current) throw new WorkspaceConflictError("The encrypted workspace file already exists.");
  if (typeof expected === "string" && current?.revision !== expected) throw new WorkspaceConflictError();
}

function canonicalPrefix(value: string): string {
  if (
    value !== value.trim() ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("\\") ||
    !/^[A-Za-z0-9._:/=@+-]+$/u.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Encrypted workspace prefix is invalid.");
  }
  return value;
}

function rootLogicalId(prefix: string): string {
  return `workspace:${prefix}:head`;
}

function fileLogicalId(path: string, revision: string): string {
  return `workspace:file:${path}:${revision}`;
}

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(stableStringify(value as JsonValue));
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (cause) {
    throw new Error(`Could not decode ${label}.`, { cause });
  }
}

function requiredString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maxBytes
  ) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredInteger(value: unknown, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(value);
}

function validTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error(`${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
