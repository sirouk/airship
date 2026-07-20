import { describe, expect, it } from "vitest";
import { HashEmbeddingProvider, tokenize } from "../indexing/hash-embeddings";
import type { EmbeddedChunk } from "../indexing/contracts";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store";
import { ContextFabricDriver } from "./context-driver";
import type { ContextStreamEvent } from "./contracts";
import { publishContextGeneration } from "./publisher";

describe("ContextFabricDriver", () => {
  it("routes to the focused workspace expert and streams retrieval commitments", async () => {
    const embeddings = new HashEmbeddingProvider(64);
    const chunks = await makeChunks(embeddings, [
      {
        id: "security",
        path: "src/security/e2ee.ts",
        text: "nonce encryption attestation enclave ciphertext key exchange",
      },
      {
        id: "design",
        path: "docs/design/theme.md",
        text: "typography spacing brass steel interface tokens",
      },
      {
        id: "billing",
        path: "src/billing/stripe.ts",
        text: "checkout subscription invoice webhook entitlement",
      },
    ]);
    const { key } = await WorkspaceRootKey.generate();
    const store = new MemoryObjectStore();
    const mirror = await publishContextGeneration({
      store,
      key,
      workspaceId: "workspace-1",
      generation: "generation-1",
      embeddingProvider: embeddings.id,
      dimensions: embeddings.dimensions,
      chunks,
      maxRecordsPerExpert: 1,
    });
    const driver = new ContextFabricDriver({ store, key, embeddings, mirror });
    const events: ContextStreamEvent[] = [];
    for await (const event of driver.search(
      "How is the nonce bound to encryption?",
      { directory: "src/security", taskTerms: ["attestation"] },
      { topK: 2, maxExperts: 1, maxBytes: 512 * 1024 },
    )) {
      events.push(event);
    }

    const route = events.find((event) => event.type === "route");
    const partial = events.find((event) => event.type === "partial");
    const complete = events.find((event) => event.type === "complete");
    expect(route?.type === "route" && route.experts[0]?.label).toBe("src/security");
    expect(partial?.type === "partial" && partial.hits[0]?.chunkId).toBe("security");
    expect(complete?.type === "complete" && complete.hits[0]?.chunkId).toBe("security");
    expect(complete?.type === "complete" && complete.commitment.complete).toBe(true);
    expect(complete?.type === "complete" && complete.commitment.objectReads).toHaveLength(1);
    expect(complete?.type === "complete" && complete.commitment.bytesRead).toBeGreaterThan(0);
  });
});

async function makeChunks(
  embeddings: HashEmbeddingProvider,
  records: Array<{ id: string; path: string; text: string }>,
): Promise<EmbeddedChunk[]> {
  const vectors = await embeddings.embed(records.map((record) => record.text));
  return records.map((record, index) => ({
    id: record.id,
    path: record.path,
    revision: "r1",
    contentDigest: `digest-${record.id}`,
    chunkIndex: 0,
    text: record.text,
    tokens: tokenize(record.text),
    vector: vectors[index]!,
  }));
}

