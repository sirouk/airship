import { describe, expect, it } from "vitest";
import { WorkspaceRootKey } from "./encrypted-envelope";
import { openSegmentRecord, readEncryptedSegment, sealSegmentedObject } from "./encrypted-segments";
import { MemoryObjectStore } from "./memory-object-store";

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
});

