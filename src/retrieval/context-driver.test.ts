import { describe, expect, it } from "vitest";
import { sha256 } from "../core/hash";
import { canonicalContextSelection, verifyContextSelection } from "../core/context-selection";
import { HashEmbeddingProvider, tokenize } from "../indexing/hash-embeddings";
import type { EmbeddedChunk } from "../indexing/contracts";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store";
import type { ObjectStore } from "../storage/object-store";
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

  it("propagates a caller's abort instead of sealing the turn as a latency-budget timeout", async () => {
    const embeddings = new HashEmbeddingProvider(64);
    const chunks = await makeChunks(embeddings, [
      { id: "security", path: "src/security/e2ee.ts", text: "nonce encryption attestation enclave ciphertext key exchange" },
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
    // The cancellation has to land while a read is in flight — an abort raised
    // before the query is embedded never reaches the loop that confuses a
    // cancelled turn with an exhausted latency budget.
    const cancelOnRead = (controller: AbortController): ObjectStore => ({
      capabilities: store.capabilities,
      get: (objectKey) => store.get(objectKey),
      getRange: async () => {
        controller.abort(new DOMException("The turn was superseded.", "AbortError"));
        throw controller.signal.reason;
      },
      putIfAbsent: (objectKey, bytes) => store.putIfAbsent(objectKey, bytes),
      compareAndSwap: (objectKey, etag, bytes) => store.compareAndSwap(objectKey, etag, bytes),
      list: (prefix) => store.list(prefix),
    });

    const cancelled = new AbortController();
    const driver = new ContextFabricDriver({ store: cancelOnRead(cancelled), key, embeddings, mirror });
    const seen: ContextStreamEvent[] = [];
    await expect((async () => {
      for await (const event of driver.search("nonce", {}, { maxExperts: 1 }, cancelled.signal)) seen.push(event);
    })()).rejects.toMatchObject({ name: "AbortError", message: "The turn was superseded." });
    // The deadline timer is the only thing entitled to say "latency budget",
    // and a cancelled turn must never leave a commitment behind to be sealed.
    expect(seen.some((event) => event.type === "warning" && event.code === "timeout")).toBe(false);
    expect(seen.some((event) => event.type === "complete")).toBe(false);

    const superseded = new AbortController();
    const provider = new VaultTurnContextProvider({
      driver: new ContextFabricDriver({ store: cancelOnRead(superseded), key, embeddings, mirror }),
      mirror,
      adapter: store.capabilities.adapter,
      retrievalBudget: { maxExperts: 1 },
    });
    await expect(provider.selectForTurn("nonce", { sessionId: "session-1", signal: superseded.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
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
