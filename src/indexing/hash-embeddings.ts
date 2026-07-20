import type { EmbeddingProvider } from "./contracts";

export function tokenize(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((token) => token.length > 1);
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly posture = "deterministic-bootstrap" as const;

  constructor(readonly dimensions = 384) {
    if (dimensions < 32) throw new Error("Hash embeddings require at least 32 dimensions.");
    this.id = `airship-hash-embedding-v1-${dimensions}`;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return texts.map((text) => {
      if (signal?.aborted) throw signal.reason;
      const vector = new Float32Array(this.dimensions);
      const tokens = tokenize(text);
      for (const token of tokens) {
        const primary = fnv1a(token, 0x811c9dc5);
        const secondary = fnv1a(token, 0x9e3779b9);
        vector[primary % this.dimensions] += secondary & 1 ? 1 : -1;
      }
      let norm = 0;
      for (const value of vector) norm += value * value;
      if (norm > 0) {
        const scale = 1 / Math.sqrt(norm);
        for (let index = 0; index < vector.length; index += 1) vector[index] *= scale;
      }
      return vector;
    });
  }
}
