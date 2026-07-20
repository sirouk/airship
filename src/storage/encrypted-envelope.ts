import type { JsonValue } from "../core/contracts";
import { ownedArrayBuffer } from "../core/bytes";
import { fromBase64Url, sha256, stableStringify, toBase64Url } from "../core/hash";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type EnvelopeAad = {
  namespace: string;
  objectId: string;
  revision: string;
  contentType: string;
};

export type EncryptedEnvelope = {
  version: 1;
  suite: "AES-256-GCM/HKDF-SHA-256";
  workspaceEpoch: number;
  objectId: string;
  revision: string;
  nonce: string;
  ciphertext: string;
  aad: EnvelopeAad;
};

export class WorkspaceRootKey {
  private constructor(private readonly key: CryptoKey) {}

  static async import(bytes: Uint8Array): Promise<WorkspaceRootKey> {
    if (bytes.byteLength !== 32) throw new Error("A workspace root key must be exactly 32 bytes.");
    const key = await crypto.subtle.importKey("raw", ownedArrayBuffer(bytes), "HKDF", false, ["deriveKey"]);
    return new WorkspaceRootKey(key);
  }

  static async generate(): Promise<{ key: WorkspaceRootKey; recoveryBytes: Uint8Array }> {
    const recoveryBytes = crypto.getRandomValues(new Uint8Array(32));
    return { key: await WorkspaceRootKey.import(recoveryBytes), recoveryBytes };
  }

  async opaqueObjectId(logicalId: string): Promise<string> {
    const namingKey = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode("airship/name/salt/v1"),
        info: encoder.encode("airship/object-name/v1"),
      },
      this.key,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", namingKey, encoder.encode(logicalId));
    return toBase64Url(new Uint8Array(signature));
  }

  async objectEncryptionKey(objectId: string, revision: string): Promise<CryptoKey> {
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode(objectId),
        info: encoder.encode(`airship/object-encryption/v1/${revision}`),
      },
      this.key,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
}

export async function sealEnvelope(args: {
  key: WorkspaceRootKey;
  namespace: string;
  logicalId: string;
  revision: string;
  contentType: string;
  plaintext: Uint8Array;
  workspaceEpoch?: number;
}): Promise<EncryptedEnvelope> {
  if (!args.namespace || !args.logicalId || !args.revision || !args.contentType) {
    throw new Error("Encrypted objects require namespace, logical ID, revision, and content type.");
  }
  const objectId = await args.key.opaqueObjectId(`${args.namespace}\0${args.logicalId}`);
  const aad: EnvelopeAad = {
    namespace: args.namespace,
    objectId,
    revision: args.revision,
    contentType: args.contentType,
  };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const contentKey = await args.key.objectEncryptionKey(objectId, args.revision);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(stableStringify(aad as unknown as JsonValue)) },
    contentKey,
    ownedArrayBuffer(args.plaintext),
  );
  return {
    version: 1,
    suite: "AES-256-GCM/HKDF-SHA-256",
    workspaceEpoch: args.workspaceEpoch ?? 1,
    objectId,
    revision: args.revision,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    aad,
  };
}

export async function openEnvelope(args: {
  key: WorkspaceRootKey;
  envelope: EncryptedEnvelope;
  expectedNamespace?: string;
  expectedLogicalId?: string;
  maxPlaintextBytes?: number;
}): Promise<Uint8Array> {
  const envelope = args.envelope;
  if (envelope.version !== 1 || envelope.suite !== "AES-256-GCM/HKDF-SHA-256") {
    throw new Error("Unsupported encrypted object envelope.");
  }
  if (envelope.aad.objectId !== envelope.objectId || envelope.aad.revision !== envelope.revision) {
    throw new Error("Encrypted object metadata is inconsistent.");
  }
  if (args.expectedNamespace && envelope.aad.namespace !== args.expectedNamespace) {
    throw new Error("Encrypted object namespace does not match.");
  }
  if (args.expectedLogicalId) {
    const expectedId = await args.key.opaqueObjectId(`${envelope.aad.namespace}\0${args.expectedLogicalId}`);
    if (expectedId !== envelope.objectId) throw new Error("Encrypted object identifier does not match.");
  }
  const nonce = fromBase64Url(envelope.nonce);
  if (nonce.byteLength !== 12) throw new Error("Invalid AES-GCM nonce length.");
  const ciphertext = fromBase64Url(envelope.ciphertext);
  const maxPlaintextBytes = args.maxPlaintextBytes ?? 64 * 1024 * 1024;
  if (ciphertext.byteLength > maxPlaintextBytes + 16) throw new Error("Encrypted object exceeds the configured limit.");
  const contentKey = await args.key.objectEncryptionKey(envelope.objectId, envelope.revision);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ownedArrayBuffer(nonce),
      additionalData: encoder.encode(stableStringify(envelope.aad as unknown as JsonValue)),
    },
    contentKey,
    ownedArrayBuffer(ciphertext),
  );
  if (plaintext.byteLength > maxPlaintextBytes) throw new Error("Plaintext exceeds the configured limit.");
  return new Uint8Array(plaintext);
}

export function encodeEnvelope(envelope: EncryptedEnvelope): Uint8Array {
  return encoder.encode(stableStringify(envelope as unknown as JsonValue));
}

export function decodeEnvelope(bytes: Uint8Array): EncryptedEnvelope {
  if (bytes.byteLength > 96 * 1024 * 1024) throw new Error("Encrypted envelope is too large.");
  const parsed: unknown = JSON.parse(decoder.decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid encrypted envelope.");
  return parsed as EncryptedEnvelope;
}

export async function envelopeDigest(envelope: EncryptedEnvelope): Promise<string> {
  return sha256(encodeEnvelope(envelope));
}
