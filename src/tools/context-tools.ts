import type { JsonValue, Tool } from "../core/contracts";
import type { ClientContextRuntime } from "../retrieval/client-context-runtime";
import type { ToolRegistry } from "./registry";

export function registerContextTools(registry: ToolRegistry, runtime: ClientContextRuntime): void {
  const searchContext: Tool = {
    definition: {
      name: "search_context",
      description: "Search the shared on-device workspace index and return generation-pinned hybrid retrieval hits.",
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
      const query = stringArgument(argumentsObject.query, "query");
      const limit = typeof argumentsObject.limit === "number" ? argumentsObject.limit : 8;
      const result = await runtime.search(query, { limit, signal: context.signal });
      const generation = runtime.getState().generation;
      if (!generation) throw new Error("Context generation was not available after refresh.");
      return {
        content: JSON.stringify({
          query: result.query,
          generationDigest: result.generationDigest,
          workspaceSnapshotDigest: result.workspaceSnapshotDigest,
          hits: result.hits.map((hit) => ({
            path: hit.path,
            text: hit.text,
            score: hit.score,
            denseScore: hit.denseScore,
            lexicalScore: hit.lexicalScore,
            revision: hit.revision,
            contentDigest: hit.contentDigest,
            chunkId: hit.chunkId,
          })),
        }, null, 2),
        metadata: {
          count: result.hits.length,
          generation: generation.lineage.generationDigest,
          indexedDocuments: generation.chunkStats.documents,
          indexedChunks: generation.chunkStats.total,
        },
      };
    },
  };

  registry.register(searchContext);
}

function objectArguments(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value;
}

function stringArgument(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}
