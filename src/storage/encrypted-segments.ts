import { ownedArrayBuffer } from "../core/bytes";
import type { JsonValue } from "../core/contracts";
import { sha256, stableStringify } from "../core/hash";
import { WorkspaceRootKey } from "./encrypted-envelope";
import type { ObjectStore } from "./object-store";

const encoder = new TextEncoder();
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Portable ceilings shared by the strict S3 and Google Drive adapters. */
export const MAX_AUTHENTICATED_RANGE_BYTES = 8 * 1024 * 1024;
export const MAX_SEGMENTED_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_BLOCK_BYTES = MAX_AUTHENTICATED_RANGE_BYTES - NONCE_BYTES - TAG_BYTES;
const MAX_BLOCKS = 65_536;

export type PlaintextSegment = {
  id: string;
  bytes: Uint8Array;
};

export type EncryptedSegmentBlock = {
  id: string;
  index: number;
  offset: number;
  ciphertextLength: number;
  plaintextLength: number;
  plaintextDigest: string;
};

export type SegmentedObjectDescriptor = {
  version: 1;
  suite: "AES-256-GCM/HKDF-SHA-256/SEGMENTED";
  workspaceEpoch: number;
  namespace: string;
  objectId: string;
  revision: string;
  contentType: string;
  ciphertextLength: number;
  blocks: EncryptedSegmentBlock[];
};

export type SealedSegmentedObject = {
  descriptor: SegmentedObjectDescriptor;
  ciphertext: Uint8Array;
};

export async function sealSegmentedObject(args: {
  key: WorkspaceRootKey;
  namespace: string;
  logicalId: string;
  revision: string;
  contentType: string;
  blocks: PlaintextSegment[];
  workspaceEpoch?: number;
}): Promise<SealedSegmentedObject> {
  validateIdentity(args);
  if (args.blocks.length === 0 || args.blocks.length > MAX_BLOCKS) {
    throw new Error(`Segmented objects require between 1 and ${MAX_BLOCKS} blocks.`);
  }
  const ids = new Set<string>();
  let ciphertextLength = 0;
  for (const block of args.blocks) {
    if (!block.id || ids.has(block.id)) throw new Error("Segment block identifiers must be non-empty and unique.");
    if (block.bytes.byteLength > MAX_BLOCK_BYTES) {
      throw new Error("A segment block exceeds the portable 8 MiB authenticated-range limit.");
    }
    ciphertextLength += NONCE_BYTES + block.bytes.byteLength + TAG_BYTES;
    if (ciphertextLength > MAX_SEGMENTED_OBJECT_BYTES) {
      throw new Error("A segmented object exceeds the portable 64 MiB object limit; publish it as multiple objects.");
    }
    ids.add(block.id);
  }

  const objectId = await args.key.opaqueObjectId(`${args.namespace}\0${args.logicalId}`);
  const digests = await Promise.all(args.blocks.map((block) => sha256(block.bytes)));
  let offset = 0;
  const blocks = args.blocks.map((block, index): EncryptedSegmentBlock => {
    const ciphertextLength = NONCE_BYTES + block.bytes.byteLength + TAG_BYTES;
    const descriptor = {
      id: block.id,
      index,
      offset,
      ciphertextLength,
      plaintextLength: block.bytes.byteLength,
      plaintextDigest: digests[index]!,
    };
    offset += ciphertextLength;
    return descriptor;
  });
  const descriptor: SegmentedObjectDescriptor = {
    version: 1,
    suite: "AES-256-GCM/HKDF-SHA-256/SEGMENTED",
    workspaceEpoch: args.workspaceEpoch ?? 1,
    namespace: args.namespace,
    objectId,
    revision: args.revision,
    contentType: args.contentType,
    ciphertextLength: offset,
    blocks,
  };
  const contentKey = await args.key.objectEncryptionKey(objectId, args.revision);
  const encryptedBlocks = await Promise.all(
    args.blocks.map(async (block, index) => {
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const encrypted = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: encoder.encode(stableStringify(blockAad(descriptor, blocks[index]!) as JsonValue)),
        },
        contentKey,
        ownedArrayBuffer(block.bytes),
      );
      const record = new Uint8Array(NONCE_BYTES + encrypted.byteLength);
      record.set(nonce, 0);
      record.set(new Uint8Array(encrypted), NONCE_BYTES);
      return record;
    }),
  );
  const ciphertext = new Uint8Array(descriptor.ciphertextLength);
  for (const [index, block] of encryptedBlocks.entries()) ciphertext.set(block, blocks[index]!.offset);
  return { descriptor, ciphertext };
}

export async function readEncryptedSegment(args: {
  key: WorkspaceRootKey;
  store: ObjectStore;
  cloudKey: string;
  descriptor: SegmentedObjectDescriptor;
  blockId: string;
  expectedNamespace?: string;
  expectedLogicalId?: string;
  signal?: AbortSignal;
}): Promise<{ bytes: Uint8Array; etag: string; bytesRead: number }> {
  await validateDescriptor(args.key, args.descriptor, args.expectedNamespace, args.expectedLogicalId);
  const block = args.descriptor.blocks.find((candidate) => candidate.id === args.blockId);
  if (!block) throw new Error(`Unknown encrypted segment block: ${args.blockId}`);
  const range = await args.store.getRange(
    args.cloudKey,
    block.offset,
    block.offset + block.ciphertextLength,
    args.signal,
  );
  if (!range) throw new Error("Encrypted segment object is missing from cloud storage.");
  if (range.totalSize !== undefined && range.totalSize !== args.descriptor.ciphertextLength) {
    throw new Error("Encrypted segment object size does not match its authenticated descriptor.");
  }
  const bytes = await openSegmentRecord({ key: args.key, descriptor: args.descriptor, block, record: range.bytes });
  return { bytes, etag: range.etag, bytesRead: range.bytes.byteLength };
}

export async function openSegmentRecord(args: {
  key: WorkspaceRootKey;
  descriptor: SegmentedObjectDescriptor;
  block: EncryptedSegmentBlock;
  record: Uint8Array;
}): Promise<Uint8Array> {
  validateBlock(args.descriptor, args.block);
  if (args.record.byteLength !== args.block.ciphertextLength) {
    throw new Error("Encrypted segment range length does not match its descriptor.");
  }
  const nonce = args.record.slice(0, NONCE_BYTES);
  const ciphertext = args.record.slice(NONCE_BYTES);
  const contentKey = await args.key.objectEncryptionKey(args.descriptor.objectId, args.descriptor.revision);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: encoder.encode(stableStringify(blockAad(args.descriptor, args.block) as JsonValue)),
      },
      contentKey,
      ownedArrayBuffer(ciphertext),
    ),
  );
  if (plaintext.byteLength !== args.block.plaintextLength) throw new Error("Decrypted segment length is invalid.");
  if ((await sha256(plaintext)) !== args.block.plaintextDigest) throw new Error("Decrypted segment digest is invalid.");
  return plaintext;
}

async function validateDescriptor(
  key: WorkspaceRootKey,
  descriptor: SegmentedObjectDescriptor,
  expectedNamespace?: string,
  expectedLogicalId?: string,
): Promise<void> {
  if (descriptor.version !== 1 || descriptor.suite !== "AES-256-GCM/HKDF-SHA-256/SEGMENTED") {
    throw new Error("Unsupported segmented encryption descriptor.");
  }
  if (expectedNamespace && descriptor.namespace !== expectedNamespace) {
    throw new Error("Encrypted segment namespace does not match.");
  }
  if (expectedLogicalId) {
    const expectedObjectId = await key.opaqueObjectId(`${descriptor.namespace}\0${expectedLogicalId}`);
    if (expectedObjectId !== descriptor.objectId) throw new Error("Encrypted segment object identifier does not match.");
  }
  if (descriptor.blocks.length === 0 || descriptor.blocks.length > MAX_BLOCKS) {
    throw new Error("Encrypted segment descriptor has an invalid block count.");
  }
  if (
    !Number.isSafeInteger(descriptor.ciphertextLength)
    || descriptor.ciphertextLength < 1
    || descriptor.ciphertextLength > MAX_SEGMENTED_OBJECT_BYTES
  ) {
    throw new Error("Encrypted segment descriptor exceeds the portable 64 MiB object limit.");
  }
  let expectedOffset = 0;
  const ids = new Set<string>();
  for (const block of descriptor.blocks) {
    validateBlock(descriptor, block);
    if (block.offset !== expectedOffset || ids.has(block.id)) throw new Error("Encrypted segment layout is invalid.");
    ids.add(block.id);
    expectedOffset += block.ciphertextLength;
  }
  if (expectedOffset !== descriptor.ciphertextLength) throw new Error("Encrypted segment object length is invalid.");
}

function validateBlock(descriptor: SegmentedObjectDescriptor, block: EncryptedSegmentBlock): void {
  if (!block.id || !Number.isSafeInteger(block.index) || !Number.isSafeInteger(block.offset)) {
    throw new Error("Encrypted segment block metadata is invalid.");
  }
  if (descriptor.blocks[block.index]?.id !== block.id || block.offset < 0 || block.plaintextLength < 0) {
    throw new Error("Encrypted segment block ordering is invalid.");
  }
  if (block.ciphertextLength !== NONCE_BYTES + block.plaintextLength + TAG_BYTES) {
    throw new Error("Encrypted segment block length is invalid.");
  }
  if (block.plaintextLength > MAX_BLOCK_BYTES || !block.plaintextDigest.startsWith("sha256:")) {
    throw new Error("Encrypted segment block exceeds limits or has an invalid digest.");
  }
}

function validateIdentity(args: { namespace: string; logicalId: string; revision: string; contentType: string }): void {
  if (!args.namespace || !args.logicalId || !args.revision || !args.contentType) {
    throw new Error("Segmented objects require namespace, logical ID, revision, and content type.");
  }
}

function blockAad(descriptor: SegmentedObjectDescriptor, block: EncryptedSegmentBlock): Record<string, JsonValue> {
  return {
    format: "airship/encrypted-segment/v1",
    workspaceEpoch: descriptor.workspaceEpoch,
    namespace: descriptor.namespace,
    objectId: descriptor.objectId,
    revision: descriptor.revision,
    contentType: descriptor.contentType,
    blockId: block.id,
    blockIndex: block.index,
    offset: block.offset,
    ciphertextLength: block.ciphertextLength,
    plaintextLength: block.plaintextLength,
    plaintextDigest: block.plaintextDigest,
  };
}
