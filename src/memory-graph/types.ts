export const MEMORY_NODE_KINDS = ["session", "message", "workspace-file", "profile", "skill", "term"] as const;
export type MemoryNodeKind = (typeof MEMORY_NODE_KINDS)[number];

export const MEMORY_EDGE_KINDS = [
  "contains",
  "follows",
  "uses-profile",
  "uses-skill",
  "references-file",
  "mentions-profile",
  "mentions-skill",
  "mentions",
  "co-occurs",
] as const;
export type MemoryEdgeKind = (typeof MEMORY_EDGE_KINDS)[number];

export type MemoryMessageSource = {
  id?: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt?: string;
  profileId?: string;
  skillIds?: readonly string[];
  filePaths?: readonly string[];
};

export type MemorySessionSource = {
  id: string;
  title?: string;
  profileId?: string;
  skillIds?: readonly string[];
  messages: readonly MemoryMessageSource[];
};

export type MemoryWorkspaceFileSource = {
  path: string;
  content?: string;
  revision?: string;
  updatedAt?: string;
  size?: number;
};

export type MemoryProfileSource = {
  id: string;
  name: string;
  role?: string;
  prompt?: string;
  skillIds?: readonly string[];
};

export type MemorySkillSource = {
  id: string;
  name: string;
  description?: string;
  profileIds?: readonly string[];
  sessionIds?: readonly string[];
  sourcePaths?: readonly string[];
};

export type MemoryGraphInput = {
  sessions?: readonly MemorySessionSource[];
  workspaceFiles?: readonly MemoryWorkspaceFileSource[];
  profiles?: readonly MemoryProfileSource[];
  skills?: readonly MemorySkillSource[];
};

export type MemoryGraphOptions = {
  maxNodes?: number;
  maxEdges?: number;
  maxMessagesPerSession?: number;
  maxFiles?: number;
  maxTextScanChars?: number;
  maxTextScanCharsPerDocument?: number;
  autoLinkText?: boolean;
  deriveTerms?: boolean;
  maxTermDocuments?: number;
  maxTerms?: number;
  maxTermsPerDocument?: number;
  maxTermCandidates?: number;
  maxTermEdges?: number;
  maxCooccurrencePairsPerDocument?: number;
};

export type MemoryGraphMetadataValue = string | number | boolean;

export type MemoryGraphNode = {
  id: string;
  kind: MemoryNodeKind;
  key: string;
  label: string;
  summary?: string;
  parentId?: string;
  createdAt?: string;
  revision?: string;
  metadata: Readonly<Record<string, MemoryGraphMetadataValue>>;
  size: number;
  color: string;
  x: number;
  y: number;
};

export type MemoryGraphEdge = {
  id: string;
  kind: MemoryEdgeKind;
  source: string;
  target: string;
  directed: boolean;
  weight: number;
  label: string;
  metadata: Readonly<Record<string, MemoryGraphMetadataValue>>;
};

export type MemoryGraphStats = {
  nodeCount: number;
  edgeCount: number;
  isolatedNodeCount: number;
  componentCount: number;
  maxDegree: number;
  nodeKinds: Readonly<Record<MemoryNodeKind, number>>;
  edgeKinds: Readonly<Record<MemoryEdgeKind, number>>;
  nodesByKind: Readonly<Record<MemoryNodeKind, number>>;
  edgesByKind: Readonly<Record<MemoryEdgeKind, number>>;
  truncated: Readonly<{
    nodes: number;
    edges: number;
    messages: number;
    files: number;
    unscannedCharacters: number;
    termDocuments: number;
    termCandidates: number;
    terms: number;
    termEdges: number;
  }>;
};

export type MemoryGraphSearchOptions = {
  kinds?: readonly MemoryNodeKind[];
  limit?: number;
};

export type MemoryGraphSearchHit = {
  node: MemoryGraphNode;
  score: number;
  matchedFields: readonly ("label" | "summary" | "key")[];
};

export type MemoryGraphSelectionOptions = {
  depth?: number;
  maxNodes?: number;
  edgeKinds?: readonly MemoryEdgeKind[];
};

export type MemoryGraphSelection = {
  focus?: MemoryGraphNode;
  nodes: readonly MemoryGraphNode[];
  edges: readonly MemoryGraphEdge[];
  truncated: boolean;
};

export type SerializableMemoryGraph = {
  version: 1;
  revision: string;
  nodes: readonly MemoryGraphNode[];
  edges: readonly MemoryGraphEdge[];
  stats: MemoryGraphStats;
};

export interface MemoryRelationshipGraph {
  readonly revision: string;
  readonly nodes: readonly MemoryGraphNode[];
  readonly edges: readonly MemoryGraphEdge[];
  readonly stats: MemoryGraphStats;
  getNode(id: string): MemoryGraphNode | undefined;
  getIncidentEdges(id: string): readonly MemoryGraphEdge[];
  getNeighbors(id: string, edgeKinds?: readonly MemoryEdgeKind[]): readonly MemoryGraphNode[];
  search(query: string, options?: MemoryGraphSearchOptions): readonly MemoryGraphSearchHit[];
  select(id: string, options?: MemoryGraphSelectionOptions): MemoryGraphSelection;
  serialize(): SerializableMemoryGraph;
}
