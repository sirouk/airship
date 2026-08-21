import { describe, expect, it } from "vitest";
import { WorkspaceRootKey } from "./encrypted-envelope";
import {
  MAX_AUTHENTICATED_RANGE_BYTES,
  MAX_SEGMENTED_OBJECT_BYTES,
  openSegmentRecord,
  readEncryptedSegment,
  sealSegmentedObject,
} from "./encrypted-segments";
import { MemoryObjectStore } from "./memory-object-store.test-support";

const encoder = new TextEncoder();

describe("encrypted segmented objects", () => {
  it("decrypts one independently authenticated range without loading the whole object", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const sealed = await sealSegmentedObject({
      key,
      namespace: "context-fabric",
      logicalId: "workspace/generation",
      revision: "generation",
      contentType: "application/test",
      blocks: [
        { id: "first", bytes: encoder.encode("first private page") },
        { id: "second", bytes: encoder.encode("second private page") },
      ],
    });
    const store = new MemoryObjectStore();
    await store.putIfAbsent("opaque-shard", sealed.ciphertext);

    const opened = await readEncryptedSegment({
      key,
      store,
      cloudKey: "opaque-shard",
      descriptor: sealed.descriptor,
      blockId: "second",
      expectedNamespace: "context-fabric",
      expectedLogicalId: "workspace/generation",
    });

    expect(new TextDecoder().decode(opened.bytes)).toBe("second private page");
    expect(opened.bytesRead).toBe(sealed.descriptor.blocks[1]!.ciphertextLength);
    expect(opened.bytesRead).toBeLessThan(sealed.ciphertext.byteLength);
  });

  it("fails closed when a ranged ciphertext record is modified", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const sealed = await sealSegmentedObject({
      key,
      namespace: "context-fabric",
      logicalId: "workspace/tamper",
      revision: "tamper",
      contentType: "application/test",
      blocks: [{ id: "page", bytes: encoder.encode("authenticated") }],
    });
    const block = sealed.descriptor.blocks[0]!;
    const record = sealed.ciphertext.slice(block.offset, block.offset + block.ciphertextLength);
    record[record.length - 1] ^= 1;

    await expect(openSegmentRecord({ key, descriptor: sealed.descriptor, block, record })).rejects.toThrow();
  });

  it("rejects authenticated ranges that would work on S3 but exceed the Drive-portable ceiling", async () => {
    const { key } = await WorkspaceRootKey.generate();
    await expect(sealSegmentedObject({
      key,
      namespace: "context-fabric",
      logicalId: "workspace/non-portable-range",
      revision: "range",
      contentType: "application/test",
      blocks: [{ id: "too-wide", bytes: new Uint8Array(MAX_AUTHENTICATED_RANGE_BYTES) }],
    })).rejects.toThrow("portable 8 MiB authenticated-range limit");
  });

  it("rejects aggregate objects above the shared Drive and S3 portability ceiling before encryption", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const portablePlaintextBlock = new Uint8Array(MAX_AUTHENTICATED_RANGE_BYTES - 28);
    const blocks = Array.from({ length: Math.floor(MAX_SEGMENTED_OBJECT_BYTES / MAX_AUTHENTICATED_RANGE_BYTES) + 1 }, (_, index) => ({
      id: `block-${index}`,
      bytes: portablePlaintextBlock,
    }));
    await expect(sealSegmentedObject({
      key,
      namespace: "context-fabric",
      logicalId: "workspace/non-portable-object",
      revision: "object",
      contentType: "application/test",
      blocks,
    })).rejects.toThrow("portable 64 MiB object limit");
  });

  it("rejects a non-portable stored descriptor before issuing a provider range read", async () => {
    const { key } = await WorkspaceRootKey.generate();
    const sealed = await sealSegmentedObject({
      key,
      namespace: "context-fabric",
      logicalId: "workspace/non-portable-descriptor",
      revision: "descriptor",
      contentType: "application/test",
      blocks: [{ id: "page", bytes: encoder.encode("portable") }],
    });
    const descriptor = { ...sealed.descriptor, ciphertextLength: MAX_SEGMENTED_OBJECT_BYTES + 1 };
    let reads = 0;
    const store = new MemoryObjectStore();
    const originalRange = store.getRange.bind(store);
    store.getRange = (...args) => {
      reads += 1;
      return originalRange(...args);
    };

    await expect(readEncryptedSegment({
      key,
      store,
      cloudKey: "opaque-shard",
      descriptor,
      blockId: "page",
      expectedNamespace: "context-fabric",
      expectedLogicalId: "workspace/non-portable-descriptor",
    })).rejects.toThrow("portable 64 MiB object limit");
    expect(reads).toBe(0);
  });
});
