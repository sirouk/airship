import { describe, expect, it } from "vitest";
import { sha256 } from "../core/hash";
import { canonicalContextSelection, verifyContextSelection } from "../core/context-selection";
import { HashEmbeddingProvider, tokenize } from "../indexing/hash-embeddings";
import type { EmbeddedChunk } from "../indexing/contracts";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store";
import { ContextFabricDriver } from "./context-driver";
import type { ContextStreamEvent } from "./contracts";
import { publishContextGeneration } from "./publisher";
import { VaultTurnContextProvider } from "./vault-turn-context";

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
      generation: await sha256("generation-1"),
      embeddingProvider: embeddings.id,
      dimensions: embeddings.dimensions,
      sourceRevision: "workspace-r1",
      sourceDigest: await sha256("workspace-r1"),
      extractor: "test-extractor-v1",
      chunker: "test-chunker-v1",
      embeddingPosture: "deterministic-bootstrap",
      indexFormat: "test-context-shard-v1",
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
    const securityChunkId = chunks.find((chunk) => chunk.path === "src/security/e2ee.ts")?.id;
    expect(partial?.type === "partial" && partial.hits[0]?.chunkId).toBe(securityChunkId);
    expect(complete?.type === "complete" && complete.hits[0]?.chunkId).toBe(securityChunkId);
    expect(complete?.type === "complete" && complete.commitment.complete).toBe(true);
    expect(complete?.type === "complete" && complete.commitment.objectReads).toHaveLength(1);
    expect(complete?.type === "complete" && complete.commitment.bytesRead).toBeGreaterThan(0);

    const provider = new VaultTurnContextProvider({
      driver,
      mirror,
      adapter: store.capabilities.adapter,
      focus: () => ({ directory: "src/security", taskTerms: ["attestation"] }),
      retrievalBudget: { maxExperts: 1, maxBytes: 512 * 1024 },
    });
    const selection = await provider.selectForTurn("How is the nonce bound to encryption?", {
      sessionId: "session-1",
      maxHits: 2,
      maxBytes: 8 * 1024,
    });
    expect(canonicalContextSelection(selection)).toEqual(selection);
    expect(await verifyContextSelection(selection)).toBe(true);
    expect(selection.lineage?.generations[0]).toMatchObject({
      id: mirror.generation,
      persistence: "encrypted-vault",
      sourceRevision: "workspace-r1",
      sourceDigest: mirror.lineage.sourceDigest,
    });
    expect(selection.retrieval).toMatchObject({
      mode: "encrypted-object-range-v1",
      adapter: "memory",
      rangeContract: "exact-or-fail",
      complete: true,
    });
    expect(selection.retrieval?.objectReads).toHaveLength(1);
  });
});

async function makeChunks(
  embeddings: HashEmbeddingProvider,
  records: Array<{ id: string; path: string; text: string }>,
): Promise<EmbeddedChunk[]> {
  const vectors = await embeddings.embed(records.map((record) => record.text));
  return Promise.all(records.map(async (record, index) => ({
    id: await sha256(`${record.path}\0${record.text}`),
    path: record.path,
    revision: "r1",
    contentDigest: await sha256(record.text),
    chunkIndex: 0,
    text: record.text,
    tokens: tokenize(record.text),
    vector: vectors[index]!,
  })));
}
