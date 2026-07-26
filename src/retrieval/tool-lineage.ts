import {
  canonicalContextLineage,
  type CanonicalContextGeneration,
  type CanonicalContextLineage,
} from "../core/context-selection";
import type { ClientContextGeneration } from "../indexing/client-context-engine";

/**
 * Lineage for retrieval the agent performs deliberately through a tool. The turn
 * seam already seals extractor, chunker and embedding posture; without this the
 * same facts were dropped on tool payloads, so a model could not tell a
 * deterministic-bootstrap hit from a real semantic one.
 *
 * These are tool payloads, not canonical turn selections: they carry more hits
 * than MAX_HITS and are not byte-accounted, so callers label their digest a
 * payload digest and never a selectionDigest.
 */
export function workspaceGenerationLineage(generation: ClientContextGeneration): CanonicalContextGeneration {
  return Object.freeze({
    id: generation.lineage.generationDigest,
    corpus: "workspace" as const,
    sourceRevision: generation.workspaceSnapshotDigest,
    sourceDigest: generation.workspaceSnapshotDigest,
    extractor: generation.lineage.extractor,
    chunker: `${generation.lineage.chunker};max=${generation.lineage.maxChunkCharacters};overlap=${generation.lineage.overlapCharacters}`,
    embedding: Object.freeze({
      provider: generation.lineage.embeddingProvider,
      dimensions: generation.lineage.embeddingDimensions,
      posture: generation.lineage.embeddingPosture,
    }),
    indexFormat: generation.lineage.indexFormat,
    persistence: generation.lineage.persistence,
  });
}

/** Fail closed: a lineage block that does not canonicalize is never reported. */
export function toolLineage(
  retriever: CanonicalContextLineage["retriever"],
  scope: CanonicalContextLineage["scope"],
  generations: readonly CanonicalContextGeneration[],
): CanonicalContextLineage {
  const lineage = canonicalContextLineage({ retriever, scope, generations });
  if (!lineage) throw new Error("Retrieval lineage did not satisfy the canonical bounds.");
  return lineage;
}
