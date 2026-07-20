import type { ClientIndex, EmbeddedChunk, SearchHit } from "./contracts";

export class FlatClientIndex implements ClientIndex {
  private readonly chunks = new Map<string, EmbeddedChunk>();

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    for (const chunk of chunks) this.chunks.set(chunk.id, cloneChunk(chunk));
  }

  async removeByPath(path: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.path === path) this.chunks.delete(id);
    }
  }

  async search(vector: Float32Array, queryTokens: string[], limit: number): Promise<SearchHit[]> {
    const querySet = new Set(queryTokens);
    return [...this.chunks.values()]
      .map((chunk) => {
        const denseScore = cosine(vector, chunk.vector);
        const lexicalScore = lexical(querySet, chunk.tokens);
        return {
          chunkId: chunk.id,
          path: chunk.path,
          revision: chunk.revision,
          text: chunk.text,
          denseScore,
          lexicalScore,
          score: denseScore * 0.72 + lexicalScore * 0.28,
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

function lexical(query: Set<string>, tokens: string[]): number {
  if (!query.size || !tokens.length) return 0;
  const candidate = new Set(tokens);
  let matches = 0;
  for (const token of query) if (candidate.has(token)) matches += 1;
  return matches / Math.sqrt(query.size * candidate.size);
}
