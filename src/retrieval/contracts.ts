import type { EmbeddingProvider, SearchHit } from "../indexing/contracts";
import type { SegmentedObjectDescriptor } from "../storage/encrypted-segments";
import type { ObjectStore } from "../storage/object-store";
import type { WorkspaceRootKey } from "../storage/encrypted-envelope";

export type ContextExpertKind = "directory" | "profile" | "source" | "task" | "recent" | "global";

export type ContextScope = {
  directories?: string[];
  profiles?: string[];
  branches?: string[];
  worktrees?: string[];
  sources?: string[];
};

export type ContextExpert = {
  id: string;
  label: string;
  kind: ContextExpertKind;
  scope: ContextScope;
  centroid: number[];
  lexicalSketch: string[];
  itemCount: number;
  objectId: string;
  blockId: string;
};

export type ContextFabricObject = {
  cloudKey: string;
  descriptor: SegmentedObjectDescriptor;
};

export type ContextRoutingMirror = {
  version: 1;
  generation: string;
  workspaceId: string;
  embeddingProvider: string;
  dimensions: number;
  createdAt: string;
  objects: Record<string, ContextFabricObject>;
  experts: ContextExpert[];
};

export type RetrievalFocus = {
  directory?: string;
  profileId?: string;
  branch?: string;
  worktreeId?: string;
  sourceIds?: string[];
  taskTerms?: string[];
};

export type RetrievalBudget = {
  topK?: number;
  maxExperts?: number;
  maxBytes?: number;
  maxLatencyMs?: number;
};

export type RoutedExpert = {
  expertId: string;
  label: string;
  kind: ContextExpertKind;
  score: number;
  bytes: number;
};

export type RetrievalObjectRead = {
  objectId: string;
  blockId: string;
  etag: string;
  offset: number;
  length: number;
  plaintextDigest: string;
};

export type RetrievalCommitment = {
  version: 1;
  generation: string;
  mirrorDigest: string;
  queryDigest: string;
  selectedExperts: string[];
  objectReads: RetrievalObjectRead[];
  bytesRead: number;
  resultDigest: string;
  startedAt: string;
  finishedAt: string;
  complete: boolean;
};

export type ContextStreamEvent =
  | {
      type: "route";
      experts: RoutedExpert[];
      mirrorDigest: string;
      queryDigest: string;
    }
  | {
      type: "partial";
      expertId: string;
      hits: SearchHit[];
      bytesRead: number;
      completedExperts: number;
      totalExperts: number;
    }
  | { type: "warning"; expertId?: string; code: "budget" | "timeout" | "unavailable"; message: string }
  | { type: "complete"; hits: SearchHit[]; commitment: RetrievalCommitment };

export type ContextDriverOptions = {
  store: ObjectStore;
  key: WorkspaceRootKey;
  embeddings: EmbeddingProvider;
  mirror: ContextRoutingMirror;
};

