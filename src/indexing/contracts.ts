import type { WorkspacePort } from "../workspace/contracts";
import type { EmbeddingPosture } from "../core/contracts";

export type Indexability = "ready" | "indexed" | "changed" | "unsupported" | "too-large" | "failed";

export type IndexCandidate = {
  path: string;
  revision: string;
  size: number;
  status: Indexability;
  reason: string;
  contentType?: string;
  chunks?: number;
};

export type EmbeddedChunk = {
  id: string;
  path: string;
  revision: string;
  contentDigest: string;
  chunkIndex: number;
  text: string;
  tokens: string[];
  vector: Float32Array;
};

export type SearchHit = {
  chunkId: string;
  path: string;
  revision: string;
  text: string;
  score: number;
  denseScore: number;
  lexicalScore: number;
};

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  /**
   * Where the vectors are computed, because it is a privacy claim and not an
   * implementation detail. Every posture this build ships runs on this device;
   * a remote embedder would put the corpus in someone else's plaintext and is
   * not a posture this type admits.
   */
  readonly posture?: EmbeddingPosture;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface ClientIndex {
  upsert(chunks: EmbeddedChunk[]): Promise<void>;
  removeByPath(path: string): Promise<void>;
  search(vector: Float32Array, queryTokens: string[], limit: number): Promise<SearchHit[]>;
  all(): Promise<EmbeddedChunk[]>;
  clear(): Promise<void>;
}

export type IndexSnapshot = {
  version: 1;
  embeddingProvider: string;
  dimensions: number;
  createdAt: string;
  chunks: Array<Omit<EmbeddedChunk, "vector"> & { vector: number[] }>;
};

export type IndexerOptions = {
  workspace: WorkspacePort;
  embeddings: EmbeddingProvider;
  index: ClientIndex;
  maxFileBytes?: number;
  maxChunkCharacters?: number;
  overlapCharacters?: number;
  scheduling?: Readonly<{
    embeddingBatchSize: number;
    maxIndexingConcurrency: number;
    cooperativeYieldIntervalMs: number;
    clock?: () => number;
    yieldControl?: () => Promise<void>;
  }>;
};
