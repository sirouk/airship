import { objectArguments, requiredString } from "./schema";
import type { JsonValue, Tool } from "../core/contracts";
import { sha256, stableStringify } from "../core/hash";
import type { ClientContextRuntime } from "../retrieval/client-context-runtime";
import { toolLineage, workspaceGenerationLineage } from "../retrieval/tool-lineage";
import type { ToolRegistry } from "./registry";

export function registerContextTools(registry: ToolRegistry, runtime: ClientContextRuntime): void {
  const searchContext: Tool = {
    definition: {
      name: "search_context",
      description: "Find workspace content by meaning when you do not know the exact words: hybrid retrieval over the on-device index, dense embeddings blended with BM25, so it answers \"where is the retry logic\" where search_text needs the literal string. Reach for this first on a concept, a paraphrase, or an unfamiliar codebase, and for search_text when you already know the identifier. Hits carry generation lineage, including whether embeddings are the deterministic bootstrap or the local semantic model.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 8_192 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async execute(argumentsValue, context) {
      const argumentsObject = objectArguments(argumentsValue);
      const query = requiredString(argumentsObject.query, "query");
      const limit = typeof argumentsObject.limit === "number" ? argumentsObject.limit : 8;
      const result = await runtime.search(query, { limit, signal: context.signal });
      const generation = runtime.getState().generation;
      if (!generation) throw new Error("Context generation was not available after refresh.");
      // Lineage comes from this runtime's own generation. In vault mode the tool
      // still reads the local memory-only runtime, so it never borrows the turn
      // selection's lineage, which may describe a different generation entirely.
      const lineage = toolLineage(
        "airship-workspace-tool-search-v1",
        { sessionId: context.sessionId },
        [workspaceGenerationLineage(generation)],
      );
      const payload = {
        query: result.query,
        generationDigest: result.generationDigest,
        workspaceSnapshotDigest: result.workspaceSnapshotDigest,
        lineage: lineage as unknown as JsonValue,
        hits: result.hits.map((hit) => ({
          path: hit.path,
          text: hit.text,
          score: hit.score,
          denseScore: hit.denseScore,
          lexicalScore: hit.lexicalScore,
          revision: hit.revision,
          contentDigest: hit.contentDigest,
          chunkId: hit.chunkId,
          chunkIndex: hit.chunkIndex,
          lineageRef: generation.lineage.generationDigest,
        })),
      };
      // Not a selectionDigest: this payload is above the canonical hit limit and
      // is not byte-accounted, so sealing it would be a false badge.
      const payloadDigest = await sha256(stableStringify(payload as unknown as JsonValue));
      return {
        content: JSON.stringify({ ...payload, payloadDigest }, null, 2),
        metadata: {
          count: result.hits.length,
          generation: generation.lineage.generationDigest,
          indexedDocuments: generation.chunkStats.documents,
          indexedChunks: generation.chunkStats.total,
          embeddingProvider: generation.lineage.embeddingProvider,
          embeddingPosture: generation.lineage.embeddingPosture,
          payloadDigest,
        },
      };
    },
  };

  registry.register(searchContext);
}
