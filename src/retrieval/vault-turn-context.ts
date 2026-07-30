import { boundChunkTextToBytes } from "./codec";
import {
  sealContextSelection,
  type CanonicalContextGeneration,
  type CanonicalContextHit,
  type CanonicalContextSelection,
  type TurnContextProvider,
  type TurnContextRequest,
} from "../core/context-selection";
import { sha256 } from "../core/hash";
import type { ObjectStoreCapabilities } from "../storage/object-store";
import { ContextFabricDriver } from "./context-driver";
import type { ContextRoutingMirror, ContextStreamEvent, RetrievalBudget, RetrievalFocus } from "./contracts";

const DEFAULT_MAX_NETWORK_BYTES = 8 * 1024 * 1024;

/**
 * Provider-neutral turn adapter for encrypted, ranged context shards. The
 * driver streams expert pages; this adapter seals only the bounded final
 * selection and exact object-read evidence into the canonical turn contract.
 */
export class VaultTurnContextProvider implements TurnContextProvider {
  constructor(private readonly options: Readonly<{
    driver: ContextFabricDriver;
    mirror: ContextRoutingMirror;
    adapter: ObjectStoreCapabilities["adapter"];
    focus?: (query: string, request: TurnContextRequest) => RetrievalFocus;
    retrievalBudget?: Omit<RetrievalBudget, "topK">;
  }>) {}

  async selectForTurn(query: string, request: TurnContextRequest): Promise<CanonicalContextSelection> {
    const normalizedQuery = query.slice(0, 8_192);
    const maxHits = boundedInteger(request.maxHits ?? 6, 1, 8, "turn context hit limit");
    const maxBytes = boundedInteger(request.maxBytes ?? 24 * 1024, 1, 32 * 1024, "turn context byte limit");
    const budget: RetrievalBudget = {
      ...this.options.retrievalBudget,
      topK: maxHits,
      maxBytes: this.options.retrievalBudget?.maxBytes ?? DEFAULT_MAX_NETWORK_BYTES,
    };
    let complete: Extract<ContextStreamEvent, { type: "complete" }> | undefined;
    let warned = false;
    for await (const event of this.options.driver.search(
      normalizedQuery,
      this.options.focus?.(normalizedQuery, request) ?? {},
      budget,
      request.signal,
    )) {
      if (event.type === "warning") warned = true;
      if (event.type === "complete") complete = event;
    }
    if (!complete) throw new Error("Vault context retrieval ended without a canonical completion commitment.");

    const generation = generationLineage(this.options.mirror);
    const hits: CanonicalContextHit[] = [];
    let selectedBytes = 0;
    let truncated = warned || !complete.commitment.complete;
    for (const hit of complete.hits) {
      const remaining = maxBytes - selectedBytes;
      if (remaining <= 0 || hits.length >= maxHits) { truncated = true; break; }
      const text = boundChunkTextToBytes(hit.text, remaining);
      if (!text) { truncated = true; break; }
      const bytes = new TextEncoder().encode(text).byteLength;
      selectedBytes += bytes;
      if (text !== hit.text) truncated = true;
      hits.push(Object.freeze({
        path: hit.path,
        revision: hit.revision,
        contentDigest: hit.contentDigest,
        chunkId: hit.chunkId,
        chunkIndex: hit.chunkIndex,
        score: hit.score,
        text,
        textDigest: await sha256(text),
        corpus: "workspace",
        sourceId: hit.path,
        lineageRef: generation.id,
      }));
      if (text !== hit.text) break;
    }

    return sealContextSelection({
      version: 2,
      queryDigest: complete.commitment.queryDigest,
      generationDigest: generation.id,
      workspaceSnapshotDigest: this.options.mirror.lineage.sourceDigest,
      selectedAt: complete.commitment.finishedAt,
      maxHits,
      maxBytes,
      selectedBytes,
      truncated,
      hits: Object.freeze(hits),
      lineage: Object.freeze({
        retriever: "airship-vault-workspace-turn-context-v1",
        scope: Object.freeze({ workspaceId: this.options.mirror.workspaceId }),
        generations: Object.freeze([generation]),
      }),
      retrieval: Object.freeze({
        mode: "encrypted-object-range-v1",
        adapter: this.options.adapter,
        rangeContract: "exact-or-fail",
        mirrorDigest: complete.commitment.mirrorDigest,
        resultDigest: complete.commitment.resultDigest,
        selectedExperts: Object.freeze([...complete.commitment.selectedExperts]),
        objectReads: Object.freeze(complete.commitment.objectReads.map((read) => Object.freeze({ ...read }))),
        bytesRead: complete.commitment.bytesRead,
        complete: complete.commitment.complete,
      }),
    });
  }
}

function generationLineage(mirror: ContextRoutingMirror): CanonicalContextGeneration {
  return Object.freeze({
    id: mirror.generation,
    corpus: "workspace",
    sourceRevision: mirror.lineage.sourceRevision,
    sourceDigest: mirror.lineage.sourceDigest,
    extractor: mirror.lineage.extractor,
    chunker: mirror.lineage.chunker,
    embedding: Object.freeze({
      provider: mirror.embeddingProvider,
      dimensions: mirror.dimensions,
      posture: mirror.lineage.embeddingPosture,
    }),
    indexFormat: mirror.lineage.indexFormat,
    persistence: "encrypted-vault",
  });
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} is invalid.`);
  return value;
}
