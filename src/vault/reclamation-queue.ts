import type { JsonValue } from "../core/contracts";
import { sha256, stableStringify } from "../core/hash";
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

const QUEUE_NAMESPACE = "airship/vault-reclamation-queue/v1";
const QUEUE_CONTENT_TYPE = "application/vnd.airship.reclamation-queue+json";
const QUEUE_PREFIX = "state/reclamation/v1";
const QUEUE_LOGICAL_ID = "vault-reclamation:queue";
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_ENTRIES = 10_000;
const MAX_COMMIT_ATTEMPTS = 3;

/**
 * What a producer knows about an object it made unreachable: which committed
 * reference it fell out of, and when. The kind is descriptive, not a trust
 * decision — the sweep re-verifies every candidate against a fresh authority
 * root before any reclamation is requested, and skips kinds it cannot verify.
 */
export type ReclamationCandidateKind = "workspace-file" | "context-segment" | (string & {});

export type ReclamationQueueEntry = Readonly<{
  kind: ReclamationCandidateKind;
  cloudKey: string;
  supersededAt: string;
}>;

type ReclamationQueueDocument = Readonly<{
  version: 1;
  generation: number;
  entries: readonly ReclamationQueueEntry[];
}>;

type LoadedQueue = Readonly<{
  record: ObjectRecord;
  document: ReclamationQueueDocument;
}>;

/**
 * The durable aged-supersession queue: one encrypted object per Vault, shared
 * by every producer that mints immutable ciphertext segments.
 *
 * A writer records a key here only after the CAS that made it unreachable has
 * already committed, so the queue can never point at a live object ahead of
 * its own commit order — and even if it somehow did, reclamation re-checks
 * the fresh authority root first. Recording itself is deliberately
 * best-effort: a provider that cannot be reached right after a commit must
 * not turn the completed write into a reported failure, and an overflow of
 * this bounded queue is answered by the provider-side untracked-object
 * enumeration, which needs no producer cooperation at all.
 */
export class VaultReclamationQueue {
  constructor(
    private readonly store: ObjectStore,
    private readonly key: WorkspaceRootKey,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * The object key the queue state lives under. Exposed so Vault-wide storage
   * accounting can attribute it, never so callers can mutate it directly.
   */
  async objectKey(): Promise<string> {
    return `${QUEUE_PREFIX}/${await this.key.opaqueObjectId(QUEUE_LOGICAL_ID)}`;
  }

  /** Re-recording an already-queued key keeps the first supersession time. */
  async recordSuperseded(cloudKeys: readonly string[]): Promise<boolean> {
    return this.record(cloudKeys.map((cloudKey) => ({ kind: "workspace-file", cloudKey })));
  }

  /** Never throws: a queue failure must not falsify a committed write. */
  async record(
    candidates: readonly Readonly<{ kind: ReclamationCandidateKind; cloudKey: string }>[],
  ): Promise<boolean> {
    if (!candidates.length) return true;
    const supersededAt = validTimestamp(this.now(), "reclamation supersession time");
    try {
      for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
        const loaded = await this.load();
        const byKey = new Map<string, ReclamationQueueEntry>(
          (loaded?.document.entries ?? []).map((entry) => [entry.cloudKey, entry]),
        );
        for (const candidate of candidates) {
          if (byKey.has(candidate.cloudKey)) continue;
          byKey.set(candidate.cloudKey, Object.freeze({
            kind: validatedKind(candidate.kind),
            cloudKey: validatedCloudKey(candidate.cloudKey),
            supersededAt,
          }));
        }
        const committed = await this.commit(loaded, byKey);
        if (committed) return true;
      }
    } catch {
      // See the class contract: recording is a durability hint, not the write.
    }
    return false;
  }

  async readEntries(): Promise<readonly ReclamationQueueEntry[]> {
    const loaded = await this.load();
    return loaded?.document.entries ?? Object.freeze([] as readonly ReclamationQueueEntry[]);
  }

  /**
   * Drop keys the provider confirmed reclaimed (or that a fresh authority root
   * proves are still referenced, making the queue entry noise). A failed commit
   * just means the next sweep reconsiders the same keys; the fresh-root
   * re-verification keeps that from ever being a live-object risk.
   */
  async confirmReclaimed(cloudKeys: readonly string[]): Promise<boolean> {
    if (!cloudKeys.length) return true;
    const confirmed = new Set(cloudKeys);
    try {
      for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
        const loaded = await this.load();
        if (!loaded) return true;
        const byKey = new Map<string, ReclamationQueueEntry>(
          loaded.document.entries
            .filter((entry) => !confirmed.has(entry.cloudKey))
            .map((entry) => [entry.cloudKey, entry]),
        );
        if (byKey.size === loaded.document.entries.length) return true;
        const committed = await this.commit(loaded, byKey);
        if (committed) return true;
      }
    } catch {
      // A kept key is reconsidered by a later sweep; reclamation never loses state.
    }
    return false;
  }

  private async commit(
    loaded: LoadedQueue | undefined,
    byKey: Map<string, ReclamationQueueEntry>,
  ): Promise<boolean> {
    if (byKey.size > MAX_QUEUE_ENTRIES) {
      // Overflow is not silently dropped entry-by-entry: the write this race
      // belongs to already committed, and the provider-side untracked-object
      // enumeration is the documented backstop for anything the queue cannot
      // hold. Returning false tells the producer the queue did not take it.
      return false;
    }
    const document: ReclamationQueueDocument = {
      version: 1,
      generation: (loaded?.document.generation ?? 0) + 1,
      entries: Object.freeze(
        [...byKey.values()].sort((left, right) => compareCanonical(left.cloudKey, right.cloudKey)),
      ),
    };
    const bytes = await this.sealDocument(document);
    const key = await this.objectKey();
    if (!loaded) {
      const created = await this.store.putIfAbsent(key, bytes);
      if (created.created) return true;
      // A concurrent initializer won; the next CAS attempt loads its document.
      return false;
    }
    const swapped = await this.store.compareAndSwap(key, loaded.record.etag, bytes);
    return swapped.updated;
  }

  private async load(): Promise<LoadedQueue | undefined> {
    const record = await this.store.get(await this.objectKey());
    if (!record) return undefined;
    return { record, document: await this.openDocument(record) };
  }

  private async sealDocument(document: ReclamationQueueDocument): Promise<Uint8Array> {
    const plaintext = encoder.encode(stableStringify(document as unknown as JsonValue));
    if (plaintext.byteLength > MAX_QUEUE_BYTES) throw new Error("Vault reclamation queue exceeds the client limit.");
    const digest = await sha256(plaintext);
    return encodeEnvelope(await sealEnvelope({
      key: this.key,
      namespace: QUEUE_NAMESPACE,
      logicalId: QUEUE_LOGICAL_ID,
      revision: `${document.generation}:${digest}`,
      contentType: QUEUE_CONTENT_TYPE,
      plaintext,
    }));
  }

  private async openDocument(record: ObjectRecord): Promise<ReclamationQueueDocument> {
    const envelope = decodeEnvelope(record.bytes);
    const plaintext = await openEnvelope({
      key: this.key,
      envelope,
      expectedNamespace: QUEUE_NAMESPACE,
      expectedLogicalId: QUEUE_LOGICAL_ID,
      maxPlaintextBytes: MAX_QUEUE_BYTES,
    });
    const document = parseQueueDocument(plaintext);
    const digest = await sha256(plaintext);
    if (
      envelope.revision !== `${document.generation}:${digest}` ||
      envelope.aad.contentType !== QUEUE_CONTENT_TYPE ||
      record.key !== (await this.objectKey())
    ) {
      throw new Error("Vault reclamation queue metadata does not match its contents.");
    }
    return document;
  }
}

function parseQueueDocument(bytes: Uint8Array): ReclamationQueueDocument {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (cause) {
    throw new Error("Could not decode the vault reclamation queue.", { cause });
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0 ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Vault reclamation queue is invalid.");
  }
  if (value.entries.length > MAX_QUEUE_ENTRIES) throw new Error("Vault reclamation queue has too many entries.");
  const entries = value.entries.map(parseQueueEntry);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (index > 0 && entries[index - 1]!.cloudKey >= entry.cloudKey) {
      throw new Error("Vault reclamation queue entries are duplicated or unsorted.");
    }
  }
  return { version: 1, generation: Number(value.generation), entries: Object.freeze(entries) };
}

function parseQueueEntry(value: unknown): ReclamationQueueEntry {
  if (!isRecord(value)) throw new Error("Vault reclamation queue entry is invalid.");
  return Object.freeze({
    kind: validatedKind(requiredString(value.kind, "reclamation candidate kind", 64)),
    cloudKey: validatedCloudKey(requiredString(value.cloudKey, "reclamation cloud key", 4_096)),
    supersededAt: validTimestamp(requiredString(value.supersededAt, "reclamation supersession time", 128), "reclamation supersession time"),
  });
}

function validatedKind(value: string): ReclamationCandidateKind {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(value)) throw new Error("Reclamation candidate kind is invalid.");
  return value;
}

function validatedCloudKey(value: string): string {
  if (value.includes("\\") || value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Reclamation cloud key is invalid.");
  }
  return value;
}

/** Locale-independent canonical order; the parser asserts it. */
function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maxBytes
  ) throw new Error(`${label} is invalid.`);
  return value;
}

function validTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error(`${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
