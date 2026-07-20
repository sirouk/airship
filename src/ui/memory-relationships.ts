import { MEMORY_EDGE_KINDS, type MemoryEdgeKind, type MemoryGraphEdge } from "../memory-graph";

export type MemoryRelationshipGroup = Readonly<{ kind: MemoryEdgeKind; label: string; edges: readonly MemoryGraphEdge[]; total: number }>;

export function groupMemoryRelationships(edges: readonly MemoryGraphEdge[], limit = 18): readonly MemoryRelationshipGroup[] {
  const bounded = Math.max(1, Math.min(180, Math.floor(limit)));
  const visible = edges.slice(0, bounded);
  return MEMORY_EDGE_KINDS.flatMap((kind) => {
    const all = edges.filter((edge) => edge.kind === kind);
    const shown = visible.filter((edge) => edge.kind === kind);
    if (!shown.length) return [];
    return [{ kind, label: relationshipKindLabel(kind), edges: shown, total: all.length }];
  });
}

export function relationshipKindLabel(kind: MemoryEdgeKind): string {
  return ({
    contains: "Contains",
    follows: "Sequence",
    "uses-profile": "Profiles used",
    "uses-skill": "Skills used",
    "references-file": "Files referenced",
    "mentions-profile": "Profiles mentioned",
    "mentions-skill": "Skills mentioned",
    mentions: "Ideas mentioned",
    "co-occurs": "Ideas appearing together",
  })[kind];
}
