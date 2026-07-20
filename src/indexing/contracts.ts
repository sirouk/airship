import type { WorkspacePort } from "../workspace/contracts";

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
  readonly posture?: "deterministic-bootstrap" | "local-semantic";
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
};
