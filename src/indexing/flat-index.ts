import type { ClientIndex, EmbeddedChunk, SearchHit } from "./contracts";
import { prepareBm25 } from "../retrieval/bm25";

/**
 * How a lane weighs meaning against words.
 *
 * `hybrid` is the default and the only one that should normally be selected:
 * dense vectors find "vehicle" from "car", BM25 finds the rare identifier the
 * embedding smooths away, and each covers the other's failure. The single-signal
 * modes exist because a person may need to see one lane's evidence on its own —
 * and because a profile pinned to hash embeddings gets a weak dense signal, for
 * which `lexical` is the honest choice rather than a blend that pretends.
 */
export type RetrievalMode = "hybrid" | "semantic" | "lexical";

/**
 * Weights for `hybrid`. Dense leads because it is the signal that generalizes;
 * lexical is a quarter of the score because it is the signal that is exact.
 * These are the ratios this index already shipped — what changed underneath is
 * that the lexical quarter is now BM25 rather than a set-overlap coefficient.
 */
const DENSE_WEIGHT = 0.72;
const LEXICAL_WEIGHT = 0.28;

export class FlatClientIndex implements ClientIndex {
  private readonly chunks = new Map<string, EmbeddedChunk>();

  constructor(private readonly mode: RetrievalMode = "hybrid") {}

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    for (const chunk of chunks) this.chunks.set(chunk.id, cloneChunk(chunk));
  }

  async removeByPath(path: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.path === path) this.chunks.delete(id);
    }
  }

  async search(vector: Float32Array, queryTokens: string[], limit: number): Promise<SearchHit[]> {
    const chunks = [...this.chunks.values()];
    /*
     * BM25 needs the corpus, not the candidate: inverse document frequency and
     * average length are properties of the index. Preparing once per search and
     * scoring by position keeps this the same single pass over the chunks it
     * always was, rather than paying for corpus statistics per hit.
     */
    const ranker = prepareBm25(chunks.map((chunk) => chunk.tokens), [...new Set(queryTokens)]);
    return chunks
      .map((chunk, index) => {
        const denseScore = cosine(vector, chunk.vector);
        const lexicalScore = ranker.score(index);
        return {
          chunkId: chunk.id,
          path: chunk.path,
          revision: chunk.revision,
          text: chunk.text,
          denseScore,
          lexicalScore,
          score: this.mode === "semantic"
            ? denseScore
            : this.mode === "lexical"
              ? lexicalScore
              : denseScore * DENSE_WEIGHT + lexicalScore * LEXICAL_WEIGHT,
        };
      })
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, Math.max(0, limit));
  }

  async all(): Promise<EmbeddedChunk[]> {
    return [...this.chunks.values()].map(cloneChunk);
  }

  async clear(): Promise<void> {
    this.chunks.clear();
  }
}

function cloneChunk(chunk: EmbeddedChunk): EmbeddedChunk {
  return { ...structuredClone({ ...chunk, vector: undefined }), vector: chunk.vector.slice() } as EmbeddedChunk;
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new Error("Embedding dimensions do not match.");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

