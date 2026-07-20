import { normalizeWorkspacePath } from "../workspace/contracts";
import { stableStringify } from "../core/hash";
import type { JsonValue } from "../core/contracts";
import type {
  MemoryEdgeKind,
  MemoryGraphEdge,
  MemoryGraphInput,
  MemoryGraphNode,
  MemoryGraphOptions,
  MemoryGraphSearchHit,
  MemoryGraphSearchOptions,
  MemoryGraphSelection,
  MemoryGraphSelectionOptions,
  MemoryGraphStats,
  MemoryNodeKind,
  MemoryRelationshipGraph,
  SerializableMemoryGraph,
} from "./types";
import { MEMORY_EDGE_KINDS, MEMORY_NODE_KINDS } from "./types";

const DEFAULT_OPTIONS: Required<MemoryGraphOptions> = {
  maxNodes: 5_000,
  maxEdges: 20_000,
  maxMessagesPerSession: 256,
  maxFiles: 2_000,
  maxTextScanChars: 2_000_000,
  maxTextScanCharsPerDocument: 32_768,
  autoLinkText: true,
  deriveTerms: true,
  maxTermDocuments: 512,
  maxTerms: 512,
  maxTermsPerDocument: 20,
  maxTermCandidates: 4_096,
  maxTermEdges: 6_000,
  maxCooccurrencePairsPerDocument: 48,
};

const NODE_COLORS: Record<MemoryNodeKind, string> = {
  session: "#c19a58",
  message: "#71878d",
  "workspace-file": "#67a39a",
  profile: "#dfba72",
  skill: "#b66a48",
  term: "#9b83b7",
};

const EDGE_LABELS: Record<MemoryEdgeKind, string> = {
  contains: "contains",
  follows: "followed by",
  "uses-profile": "uses profile",
  "uses-skill": "uses skill",
  "references-file": "references file",
  "mentions-profile": "mentions profile",
  "mentions-skill": "mentions skill",
  mentions: "mentions",
  "co-occurs": "co-occurs",
};

type MutableTruncation = {
  nodes: number;
  edges: number;
  messages: number;
  files: number;
  unscannedCharacters: number;
  termDocuments: number;
  termCandidates: number;
  terms: number;
  termEdges: number;
};

type TextSource = {
  nodeId: string;
  text: string;
  priority: number;
  order: number;
};

type AliasTarget = {
  nodeId: string;
  kind: "workspace-file" | "profile" | "skill";
};

type ExtractedTerm = {
  key: string;
  label: string;
  termType: "token" | "phrase";
  count: number;
};

type TermAggregate = Omit<ExtractedTerm, "count"> & {
  occurrences: number;
  documentCount: number;
};

type DocumentTerms = {
  nodeId: string;
  terms: ReadonlyMap<string, number>;
};

const DERIVE_CACHE = new Map<string, MemoryRelationshipGraph>();
const DERIVE_CACHE_LIMIT = 8;

export function deriveMemoryRelationshipGraph(
  input: MemoryGraphInput,
  graphOptions: MemoryGraphOptions = {},
): MemoryRelationshipGraph {
  const content = stableStringify({ input, graphOptions } as unknown as JsonValue);
  const cacheKey = stableMemoryContentHash(content);
  const cached = DERIVE_CACHE.get(cacheKey);
  if (cached) {
    DERIVE_CACHE.delete(cacheKey);
    DERIVE_CACHE.set(cacheKey, cached);
    return cached;
  }
  const graph = deriveUncachedMemoryRelationshipGraph(input, graphOptions);
  DERIVE_CACHE.set(cacheKey, graph);
  if (DERIVE_CACHE.size > DERIVE_CACHE_LIMIT) DERIVE_CACHE.delete(DERIVE_CACHE.keys().next().value!);
  return graph;
}

export function stableMemoryContentHash(content: string): string {
  let hash = 0x811c9dc5;
  let check = 0x9e3779b9;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    hash ^= code;
    hash = Math.imul(hash, 0x01000193);
    check = Math.imul(check ^ code, 0x85ebca6b) ^ (check >>> 13);
  }
  return `${content.length.toString(36)}:${(hash >>> 0).toString(16).padStart(8, "0")}:${(check >>> 0).toString(16).padStart(8, "0")}`;
}

function deriveUncachedMemoryRelationshipGraph(
  input: MemoryGraphInput,
  graphOptions: MemoryGraphOptions = {},
): MemoryRelationshipGraph {
  const options = resolveOptions(graphOptions);
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const nodesById = new Map<string, MemoryGraphNode>();
  const edgesById = new Set<string>();
  const textSources: TextSource[] = [];
  const aliases = new Map<string, AliasTarget[]>();
  const truncation: MutableTruncation = {
    nodes: 0,
    edges: 0,
    messages: 0,
    files: 0,
    unscannedCharacters: 0,
    termDocuments: 0,
    termCandidates: 0,
    terms: 0,
    termEdges: 0,
  };
  let textSourceOrder = 0;
  const queueTextSource = (nodeId: string, text: string, priority: number) => {
    textSources.push({ nodeId, text, priority, order: textSourceOrder });
    textSourceOrder += 1;
  };

  const profiles = [...(input.profiles ?? [])].sort((left, right) => binaryCompare(left.id, right.id));
  const skills = [...(input.skills ?? [])].sort((left, right) => binaryCompare(left.id, right.id));
  const sessions = [...(input.sessions ?? [])].sort((left, right) => binaryCompare(left.id, right.id));
  const files = [...(input.workspaceFiles ?? [])]
    .map((file) => ({ ...file, path: normalizeWorkspacePath(file.path) }))
    .sort((left, right) => binaryCompare(left.path, right.path));

  assertUnique(profiles.map((profile) => profile.id), "profile id");
  assertUnique(skills.map((skill) => skill.id), "skill id");
  assertUnique(sessions.map((session) => session.id), "session id");
  assertUnique(files.map((file) => file.path), "workspace path");

  const addNode = (
    kind: MemoryNodeKind,
    key: string,
    data: Omit<MemoryGraphNode, "id" | "kind" | "key" | "color" | "x" | "y" | "metadata"> & {
      metadata?: MemoryGraphNode["metadata"];
    },
    index: number,
    parent?: MemoryGraphNode,
  ): MemoryGraphNode | undefined => {
    const safeKey = requireKey(key, `${kind} key`);
    const id = memoryNodeId(kind, safeKey);
    if (nodesById.has(id)) throw new Error(`Duplicate ${kind} key: ${safeKey}`);
    if (nodes.length >= options.maxNodes) {
      truncation.nodes += 1;
      return undefined;
    }
    const position = deterministicPosition(kind, safeKey, index, parent);
    const node = Object.freeze({
      id,
      kind,
      key: safeKey,
      ...data,
      label: cleanLabel(data.label, 160),
      summary: data.summary === undefined ? undefined : cleanLabel(data.summary, 320),
      metadata: Object.freeze({ ...(data.metadata ?? {}) }),
      color: NODE_COLORS[kind],
      x: position.x,
      y: position.y,
    });
    nodes.push(node);
    nodesById.set(id, node);
    return node;
  };

  const addEdge = (
    kind: MemoryEdgeKind,
    source: string | undefined,
    target: string | undefined,
    weight = 1,
    directed = true,
    metadata: MemoryGraphEdge["metadata"] = {},
  ): MemoryGraphEdge | undefined => {
    if (!source || !target || source === target || !nodesById.has(source) || !nodesById.has(target)) return undefined;
    const [normalizedSource, normalizedTarget] = directed || binaryCompare(source, target) <= 0
      ? [source, target]
      : [target, source];
    const id = memoryEdgeId(kind, normalizedSource, normalizedTarget);
    if (edgesById.has(id)) return undefined;
    edgesById.add(id);
    if (edges.length >= options.maxEdges) {
      truncation.edges += 1;
      return undefined;
    }
    const edge = Object.freeze({
      id,
      kind,
      source: normalizedSource,
      target: normalizedTarget,
      directed,
      weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      label: EDGE_LABELS[kind],
      metadata: Object.freeze({ ...metadata }),
    });
    edges.push(edge);
    return edge;
  };

  const profileNodes = new Map<string, MemoryGraphNode>();
  profiles.forEach((profile, index) => {
    const node = addNode("profile", profile.id, {
      label: requireKey(profile.name, "profile name"),
      summary: profile.role || profile.prompt,
      metadata: {
        profileId: profile.id,
        configuredSkills: profile.skillIds?.length ?? 0,
        lineage: "profile-catalog",
      },
      size: 8,
    }, index);
    if (!node) return;
    profileNodes.set(profile.id, node);
    addAlias(aliases, profile.id, node);
    addAlias(aliases, profile.name, node);
    queueTextSource(node.id, `${profile.role ?? ""}\n${profile.prompt ?? ""}`, 4);
  });

  const skillNodes = new Map<string, MemoryGraphNode>();
  skills.forEach((skill, index) => {
    const node = addNode("skill", skill.id, {
      label: requireKey(skill.name, "skill name"),
      summary: skill.description,
      metadata: {
        skillId: skill.id,
        lineage: "skill-catalog",
      },
      size: 7,
    }, index);
    if (!node) return;
    skillNodes.set(skill.id, node);
    addAlias(aliases, skill.id, node);
    addAlias(aliases, skill.name, node);
    queueTextSource(node.id, skill.description ?? "", 5);
  });

  const sessionNodes = new Map<string, MemoryGraphNode>();
  sessions.forEach((session, index) => {
    const node = addNode("session", session.id, {
      label: session.title || `Session ${session.id}`,
      summary: `${session.messages.length} message${session.messages.length === 1 ? "" : "s"}`,
      metadata: {
        sessionId: session.id,
        messageCount: session.messages.length,
        lineage: "session-state",
      },
      size: 10,
    }, index);
    if (!node) return;
    sessionNodes.set(session.id, node);
    queueTextSource(node.id, session.title ?? "", 1);
  });

  const admittedFiles = files.slice(0, options.maxFiles);
  truncation.files += Math.max(0, files.length - admittedFiles.length);
  const fileNodes = new Map<string, MemoryGraphNode>();
  admittedFiles.forEach((file, index) => {
    const summaryParts = [formatFileSize(file.size), file.revision ? `revision ${cleanLabel(file.revision, 24)}` : undefined]
      .filter((part): part is string => Boolean(part));
    const node = addNode("workspace-file", file.path, {
      label: file.path.replace(/^\/workspace\//u, ""),
      summary: summaryParts.join(" · ") || undefined,
      revision: file.revision,
      createdAt: file.updatedAt,
      metadata: {
        path: file.path,
        ...(Number.isFinite(file.size) && (file.size ?? -1) >= 0 ? { bytes: Math.floor(file.size!) } : {}),
        revision: file.revision ?? "not supplied",
        lineage: "workspace-file",
      },
      size: 6,
    }, index);
    if (!node) {
      truncation.files += 1;
      return;
    }
    fileNodes.set(file.path, node);
    addAlias(aliases, file.path, node);
    addAlias(aliases, file.path.replace(/^\/workspace\//u, ""), node);
    addAlias(aliases, file.path.slice(file.path.lastIndexOf("/") + 1), node);
    queueTextSource(node.id, file.content ?? "", 2);
  });

  profiles.forEach((profile) => {
    const profileNode = profileNodes.get(profile.id);
    for (const skillId of sortedStrings(profile.skillIds)) addEdge("uses-skill", profileNode?.id, skillNodes.get(skillId)?.id, 2);
  });

  skills.forEach((skill) => {
    const skillNode = skillNodes.get(skill.id);
    for (const profileId of sortedStrings(skill.profileIds)) addEdge("uses-skill", profileNodes.get(profileId)?.id, skillNode?.id, 2);
    for (const sessionId of sortedStrings(skill.sessionIds)) addEdge("uses-skill", sessionNodes.get(sessionId)?.id, skillNode?.id, 2);
    for (const path of sortedStrings(skill.sourcePaths)) {
      const normalizedPath = safeWorkspacePath(path);
      if (normalizedPath) addEdge("references-file", skillNode?.id, fileNodes.get(normalizedPath)?.id, 1.5);
    }
  });

  sessions.forEach((session) => {
    const sessionNode = sessionNodes.get(session.id);
    if (!sessionNode) return;
    addEdge("uses-profile", sessionNode.id, session.profileId ? profileNodes.get(session.profileId)?.id : undefined, 2);
    for (const skillId of sortedStrings(session.skillIds)) addEdge("uses-skill", sessionNode.id, skillNodes.get(skillId)?.id, 2);

    const messageIds = new Set<string>();
    for (const message of session.messages) {
      if (!message.id) continue;
      const safeId = requireKey(message.id, "message id");
      if (messageIds.has(safeId)) throw new Error(`Duplicate message id in session ${session.id}: ${safeId}`);
      messageIds.add(safeId);
    }

    const firstMessageIndex = Math.max(0, session.messages.length - options.maxMessagesPerSession);
    truncation.messages += firstMessageIndex;
    let previousNode: MemoryGraphNode | undefined;
    for (let absoluteIndex = firstMessageIndex; absoluteIndex < session.messages.length; absoluteIndex += 1) {
      const message = session.messages[absoluteIndex]!;
      const messageKey = JSON.stringify([session.id, message.id ? `id:${message.id}` : `index:${absoluteIndex}`]);
      const node = addNode("message", messageKey, {
        label: `${message.role}: ${messagePreview(message.content)}`,
        summary: message.content,
        parentId: sessionNode.id,
        createdAt: message.createdAt,
        metadata: {
          sessionId: session.id,
          messageId: message.id ?? `index:${absoluteIndex}`,
          role: message.role,
          ordinal: absoluteIndex,
          lineage: "session-message",
        },
        size: message.role === "user" ? 5.5 : 5,
      }, absoluteIndex - firstMessageIndex, sessionNode);
      if (!node) {
        truncation.messages += 1;
        continue;
      }
      addEdge("contains", sessionNode.id, node.id, 1.2);
      if (previousNode) addEdge("follows", previousNode.id, node.id, 0.65);
      previousNode = node;
      if (message.profileId) addEdge("mentions-profile", node.id, profileNodes.get(message.profileId)?.id, 1.5);
      for (const skillId of sortedStrings(message.skillIds)) addEdge("mentions-skill", node.id, skillNodes.get(skillId)?.id, 1.5);
      for (const path of sortedStrings(message.filePaths)) {
        const normalizedPath = safeWorkspacePath(path);
        if (normalizedPath) addEdge("references-file", node.id, fileNodes.get(normalizedPath)?.id, 1.5);
      }
      queueTextSource(node.id, message.content, 0);
    }
  });

  if (options.autoLinkText || options.deriveTerms) {
    const uniqueAliases = resolveUniqueAliases(aliases);
    const tokenAliases = new Map<string, AliasTarget>();
    const phraseAliases: Array<readonly [string, AliasTarget]> = [];
    for (const [alias, target] of uniqueAliases) {
      if (alias.includes(" ")) phraseAliases.push([alias, target]);
      else tokenAliases.set(alias, target);
    }
    phraseAliases.sort(([left], [right]) => right.length - left.length || binaryCompare(left, right));

    const termAggregates = new Map<string, TermAggregate>();
    const documentTerms: DocumentTerms[] = [];
    const orderedTextSources = [...textSources].sort((left, right) =>
      left.priority - right.priority
      || (left.priority === 0 ? right.order - left.order : left.order - right.order)
      || binaryCompare(left.nodeId, right.nodeId),
    );
    let scanned = 0;
    let admittedTermDocuments = 0;
    for (const source of orderedTextSources) {
      if (!source.text) continue;
      const remaining = options.maxTextScanChars - scanned;
      if (remaining <= 0) {
        truncation.unscannedCharacters += source.text.length;
        if (options.deriveTerms) truncation.termDocuments += 1;
        continue;
      }
      const admittedCharacters = Math.min(remaining, options.maxTextScanCharsPerDocument);
      const text = source.text.slice(0, admittedCharacters);
      scanned += text.length;
      truncation.unscannedCharacters += source.text.length - text.length;
      const normalized = normalizeText(text);

      if (options.autoLinkText) {
        const matchedTargets = new Map<string, AliasTarget>();
        for (const token of extractReferenceTokens(normalized)) {
          const target = tokenAliases.get(token);
          if (target) matchedTargets.set(target.nodeId, target);
        }
        for (const [phrase, target] of phraseAliases) {
          if (containsBounded(normalized, phrase)) matchedTargets.set(target.nodeId, target);
        }
        for (const target of matchedTargets.values()) {
          if (source.nodeId === target.nodeId) continue;
          const kind: MemoryEdgeKind = target.kind === "workspace-file"
            ? "references-file"
            : target.kind === "profile"
              ? "mentions-profile"
              : "mentions-skill";
          addEdge(kind, source.nodeId, target.nodeId, 1);
        }
      }

      if (!options.deriveTerms) continue;
      if (admittedTermDocuments >= options.maxTermDocuments) {
        truncation.termDocuments += 1;
        continue;
      }
      admittedTermDocuments += 1;
      const extracted = extractDocumentTerms(normalized, options.maxTermsPerDocument);
      const admitted = new Map<string, number>();
      for (const term of extracted) {
        let aggregate = termAggregates.get(term.key);
        if (!aggregate) {
          if (termAggregates.size >= options.maxTermCandidates) {
            truncation.termCandidates += 1;
            continue;
          }
          aggregate = {
            key: term.key,
            label: term.label,
            termType: term.termType,
            occurrences: 0,
            documentCount: 0,
          };
          termAggregates.set(term.key, aggregate);
        }
        aggregate.occurrences += term.count;
        aggregate.documentCount += 1;
        admitted.set(term.key, term.count);
      }
      if (admitted.size > 0) documentTerms.push({ nodeId: source.nodeId, terms: admitted });
    }

    const rankedTerms = [...termAggregates.values()].sort(compareTermAggregates);
    const selectedTerms = rankedTerms.slice(0, options.maxTerms);
    truncation.terms += Math.max(0, rankedTerms.length - selectedTerms.length);
    const termNodes = new Map<string, MemoryGraphNode>();
    selectedTerms.forEach((term, index) => {
      const node = addNode("term", term.key, {
        label: term.label,
        summary: `${term.occurrences} occurrence${term.occurrences === 1 ? "" : "s"} across ${term.documentCount} source${term.documentCount === 1 ? "" : "s"}`,
        metadata: {
          term: term.label,
          termType: term.termType,
          occurrences: term.occurrences,
          documentCount: term.documentCount,
          normalization: "NFKC lowercase",
          lineage: "normalized-extractive",
        },
        size: Math.min(8, 3.5 + Math.log2(term.occurrences + term.documentCount + 1)),
      }, index);
      if (node) termNodes.set(term.key, node);
      else truncation.terms += 1;
    });

    let admittedTermEdges = 0;
    const addTermEdge = (
      kind: "mentions" | "co-occurs",
      source: string,
      target: string,
      weight: number,
      directed: boolean,
      metadata: MemoryGraphEdge["metadata"],
    ) => {
      if (admittedTermEdges >= options.maxTermEdges) {
        truncation.termEdges += 1;
        return;
      }
      const edge = addEdge(kind, source, target, weight, directed, metadata);
      if (edge) admittedTermEdges += 1;
      else truncation.termEdges += 1;
    };

    const cooccurrences = new Map<string, {
      source: string;
      target: string;
      documentCount: number;
      occurrenceCount: number;
    }>();
    for (const document of documentTerms) {
      const presentTerms = [...document.terms]
        .filter(([termKey]) => termNodes.has(termKey))
        .sort((left, right) => right[1] - left[1] || binaryCompare(left[0], right[0]));
      for (const [termKey, count] of presentTerms) {
        addTermEdge("mentions", document.nodeId, termNodes.get(termKey)!.id, count, true, {
          occurrenceCount: count,
          lineage: "exact-normalized-text",
        });
      }

      const totalPairs = presentTerms.length * (presentTerms.length - 1) / 2;
      const pairLimit = Math.min(totalPairs, options.maxCooccurrencePairsPerDocument);
      truncation.termEdges += Math.max(0, totalPairs - pairLimit);
      let admittedPairs = 0;
      for (let leftIndex = 0; leftIndex < presentTerms.length && admittedPairs < pairLimit; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < presentTerms.length && admittedPairs < pairLimit; rightIndex += 1) {
          const left = presentTerms[leftIndex]!;
          const right = presentTerms[rightIndex]!;
          const [sourceKey, targetKey] = binaryCompare(left[0], right[0]) <= 0 ? [left[0], right[0]] : [right[0], left[0]];
          const pairKey = JSON.stringify([sourceKey, targetKey]);
          const aggregate = cooccurrences.get(pairKey) ?? {
            source: termNodes.get(sourceKey)!.id,
            target: termNodes.get(targetKey)!.id,
            documentCount: 0,
            occurrenceCount: 0,
          };
          aggregate.documentCount += 1;
          aggregate.occurrenceCount += Math.min(left[1], right[1]);
          cooccurrences.set(pairKey, aggregate);
          admittedPairs += 1;
        }
      }
    }

    const rankedPairs = [...cooccurrences.values()].sort((left, right) =>
      right.documentCount - left.documentCount
      || right.occurrenceCount - left.occurrenceCount
      || binaryCompare(left.source, right.source)
      || binaryCompare(left.target, right.target),
    );
    for (const pair of rankedPairs) {
      addTermEdge("co-occurs", pair.source, pair.target, pair.documentCount, false, {
        documentCount: pair.documentCount,
        occurrenceCount: pair.occurrenceCount,
        lineage: "same-source-co-occurrence",
      });
    }
  }

  return createRelationshipGraph(nodes, edges, truncation);
}

export function memoryNodeId(kind: MemoryNodeKind, key: string): string {
  return `${kind}:${JSON.stringify(key)}`;
}

function memoryEdgeId(kind: MemoryEdgeKind, source: string, target: string): string {
  return `${kind}:${JSON.stringify([source, target])}`;
}

function createRelationshipGraph(
  sourceNodes: MemoryGraphNode[],
  sourceEdges: MemoryGraphEdge[],
  truncation: MutableTruncation,
): MemoryRelationshipGraph {
  const nodes = Object.freeze([...sourceNodes]);
  const edges = Object.freeze([...sourceEdges]);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const incident = new Map<string, MemoryGraphEdge[]>();
  const degree = new Map<string, number>();
  for (const node of nodes) incident.set(node.id, []);
  for (const edge of edges) {
    incident.get(edge.source)?.push(edge);
    incident.get(edge.target)?.push(edge);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  for (const list of incident.values()) Object.freeze(list);

  const nodeKinds = Object.fromEntries(MEMORY_NODE_KINDS.map((kind) => [kind, 0])) as Record<MemoryNodeKind, number>;
  const edgeKinds = Object.fromEntries(MEMORY_EDGE_KINDS.map((kind) => [kind, 0])) as Record<MemoryEdgeKind, number>;
  for (const node of nodes) nodeKinds[node.kind] += 1;
  for (const edge of edges) edgeKinds[edge.kind] += 1;
  const stats: MemoryGraphStats = Object.freeze({
    nodeCount: nodes.length,
    edgeCount: edges.length,
    isolatedNodeCount: nodes.reduce((count, node) => count + ((degree.get(node.id) ?? 0) === 0 ? 1 : 0), 0),
    componentCount: countComponents(nodes, incident),
    maxDegree: nodes.reduce((maximum, node) => Math.max(maximum, degree.get(node.id) ?? 0), 0),
    nodeKinds: Object.freeze(nodeKinds),
    edgeKinds: Object.freeze(edgeKinds),
    nodesByKind: Object.freeze(nodeKinds),
    edgesByKind: Object.freeze(edgeKinds),
    truncated: Object.freeze({ ...truncation }),
  });
  const revision = hashString(JSON.stringify({
    nodes: nodes.map((node) => [node.id, node.label, node.summary, node.parentId, node.createdAt, node.revision, node.size]),
    edges: edges.map((edge) => [edge.id, edge.weight, edge.label, edge.directed, edge.metadata]),
  }));

  const graph: MemoryRelationshipGraph = {
    revision,
    nodes,
    edges,
    stats,
    getNode(id) {
      return nodesById.get(id);
    },
    getIncidentEdges(id) {
      return incident.get(id) ?? EMPTY_EDGES;
    },
    getNeighbors(id, requestedKinds) {
      const allowed = requestedKinds ? new Set(requestedKinds) : undefined;
      const seen = new Set<string>();
      const result: MemoryGraphNode[] = [];
      for (const edge of incident.get(id) ?? []) {
        if (allowed && !allowed.has(edge.kind)) continue;
        const neighborId = edge.source === id ? edge.target : edge.source;
        if (seen.has(neighborId)) continue;
        const node = nodesById.get(neighborId);
        if (!node) continue;
        seen.add(neighborId);
        result.push(node);
      }
      return Object.freeze(result);
    },
    search(query, searchOptions) {
      return searchNodes(nodes, query, searchOptions);
    },
    select(id, selectionOptions) {
      return selectNeighborhood(nodesById, incident, edges, id, selectionOptions);
    },
    serialize(): SerializableMemoryGraph {
      return Object.freeze({ version: 1, revision, nodes, edges, stats });
    },
  };
  return Object.freeze(graph);
}

function searchNodes(
  nodes: readonly MemoryGraphNode[],
  query: string,
  options: MemoryGraphSearchOptions = {},
): readonly MemoryGraphSearchHit[] {
  const normalizedQuery = normalizeText(query).slice(0, 512).trim();
  if (!normalizedQuery) return [];
  const tokens = [...new Set(extractReferenceTokens(normalizedQuery))];
  if (tokens.length === 0) return [];
  const allowed = options.kinds ? new Set(options.kinds) : undefined;
  const limit = boundedInteger(options.limit, 20, 1, 200, "search limit");
  const hits: MemoryGraphSearchHit[] = [];
  for (const node of nodes) {
    if (allowed && !allowed.has(node.kind)) continue;
    const fields = {
      label: normalizeText(node.label),
      summary: normalizeText(node.summary ?? ""),
      key: normalizeText(node.key),
    };
    const combined = `${fields.label}\n${fields.summary}\n${fields.key}`;
    if (tokens.length > 0 && !tokens.every((token) => combined.includes(token))) continue;
    const matchedFields: Array<"label" | "summary" | "key"> = [];
    let score = 0;
    if (fields.label === normalizedQuery) score += 140;
    else if (fields.label.startsWith(normalizedQuery)) score += 95;
    else if (fields.label.includes(normalizedQuery)) score += 65;
    if (fields.label.includes(normalizedQuery)) matchedFields.push("label");
    if (fields.key === normalizedQuery) score += 110;
    else if (fields.key.includes(normalizedQuery)) score += 45;
    if (fields.key.includes(normalizedQuery)) matchedFields.push("key");
    if (fields.summary.includes(normalizedQuery)) {
      score += 30;
      matchedFields.push("summary");
    }
    if (!matchedFields.includes("label") && tokens.some((token) => fields.label.includes(token))) matchedFields.push("label");
    if (!matchedFields.includes("key") && tokens.some((token) => fields.key.includes(token))) matchedFields.push("key");
    if (!matchedFields.includes("summary") && tokens.some((token) => fields.summary.includes(token))) matchedFields.push("summary");
    score += tokens.reduce((total, token) => total + (fields.label.includes(token) ? 8 : fields.key.includes(token) ? 5 : 2), 0);
    hits.push(Object.freeze({ node, score, matchedFields: Object.freeze(matchedFields) }));
  }
  hits.sort((left, right) => right.score - left.score || binaryCompare(left.node.label, right.node.label) || binaryCompare(left.node.id, right.node.id));
  return Object.freeze(hits.slice(0, limit));
}

function selectNeighborhood(
  nodesById: ReadonlyMap<string, MemoryGraphNode>,
  incident: ReadonlyMap<string, readonly MemoryGraphEdge[]>,
  allEdges: readonly MemoryGraphEdge[],
  id: string,
  options: MemoryGraphSelectionOptions = {},
): MemoryGraphSelection {
  const focus = nodesById.get(id);
  if (!focus) return Object.freeze({ focus: undefined, nodes: Object.freeze([]), edges: Object.freeze([]), truncated: false });
  const depth = boundedInteger(options.depth, 1, 0, 8, "selection depth");
  const maxNodes = boundedInteger(options.maxNodes, 200, 1, 10_000, "selection node limit");
  const allowed = options.edgeKinds ? new Set(options.edgeKinds) : undefined;
  const selected = new Set<string>([id]);
  let frontier = [id];
  let truncated = false;
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of incident.get(current) ?? []) {
        if (allowed && !allowed.has(edge.kind)) continue;
        const neighbor = edge.source === current ? edge.target : edge.source;
        if (selected.has(neighbor)) continue;
        if (selected.size >= maxNodes) {
          truncated = true;
          continue;
        }
        selected.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  const nodes = Object.freeze([...selected].map((nodeId) => nodesById.get(nodeId)!).filter(Boolean));
  const edges = Object.freeze(allEdges.filter((edge) =>
    selected.has(edge.source) && selected.has(edge.target) && (!allowed || allowed.has(edge.kind)),
  ));
  return Object.freeze({ focus, nodes, edges, truncated });
}

function resolveOptions(options: MemoryGraphOptions): Required<MemoryGraphOptions> {
  return {
    maxNodes: boundedInteger(options.maxNodes, DEFAULT_OPTIONS.maxNodes, 1, 100_000, "maxNodes"),
    maxEdges: boundedInteger(options.maxEdges, DEFAULT_OPTIONS.maxEdges, 0, 500_000, "maxEdges"),
    maxMessagesPerSession: boundedInteger(options.maxMessagesPerSession, DEFAULT_OPTIONS.maxMessagesPerSession, 0, 10_000, "maxMessagesPerSession"),
    maxFiles: boundedInteger(options.maxFiles, DEFAULT_OPTIONS.maxFiles, 0, 100_000, "maxFiles"),
    maxTextScanChars: boundedInteger(options.maxTextScanChars, DEFAULT_OPTIONS.maxTextScanChars, 0, 100_000_000, "maxTextScanChars"),
    maxTextScanCharsPerDocument: boundedInteger(options.maxTextScanCharsPerDocument, DEFAULT_OPTIONS.maxTextScanCharsPerDocument, 0, 10_000_000, "maxTextScanCharsPerDocument"),
    autoLinkText: options.autoLinkText ?? DEFAULT_OPTIONS.autoLinkText,
    deriveTerms: options.deriveTerms ?? DEFAULT_OPTIONS.deriveTerms,
    maxTermDocuments: boundedInteger(options.maxTermDocuments, DEFAULT_OPTIONS.maxTermDocuments, 0, 100_000, "maxTermDocuments"),
    maxTerms: boundedInteger(options.maxTerms, DEFAULT_OPTIONS.maxTerms, 0, 20_000, "maxTerms"),
    maxTermsPerDocument: boundedInteger(options.maxTermsPerDocument, DEFAULT_OPTIONS.maxTermsPerDocument, 0, 500, "maxTermsPerDocument"),
    maxTermCandidates: boundedInteger(options.maxTermCandidates, DEFAULT_OPTIONS.maxTermCandidates, 0, 100_000, "maxTermCandidates"),
    maxTermEdges: boundedInteger(options.maxTermEdges, DEFAULT_OPTIONS.maxTermEdges, 0, 100_000, "maxTermEdges"),
    maxCooccurrencePairsPerDocument: boundedInteger(options.maxCooccurrencePairsPerDocument, DEFAULT_OPTIONS.maxCooccurrencePairsPerDocument, 0, 10_000, "maxCooccurrencePairsPerDocument"),
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${name} must be a safe integer between ${minimum} and ${maximum}.`);
  }
  return candidate;
}

function requireKey(value: string, name: string): string {
  const cleaned = value.trim();
  if (value !== cleaned || !cleaned || cleaned.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(cleaned)) {
    throw new Error(`${name} must be a non-empty string of at most 16384 characters without control characters.`);
  }
  return cleaned;
}

function assertUnique(values: readonly string[], name: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = requireKey(value, name);
    if (seen.has(key)) throw new Error(`Duplicate ${name}: ${key}`);
    seen.add(key);
  }
}

function cleanLabel(value: string, maximum: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (cleaned.length <= maximum) return cleaned || "Untitled";
  return `${cleaned.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function messagePreview(content: string): string {
  return cleanLabel(content, 72);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function normalizeAlias(value: string): string {
  return normalizeText(value).trim().replace(/^['"`([{<]+|['"`\])}>.,;:!?]+$/gu, "");
}

function addAlias(aliases: Map<string, AliasTarget[]>, value: string, node: MemoryGraphNode): void {
  const alias = normalizeAlias(value);
  if (alias.length < 2 || (node.kind !== "workspace-file" && node.kind !== "profile" && node.kind !== "skill")) return;
  const targets = aliases.get(alias) ?? [];
  targets.push({ nodeId: node.id, kind: node.kind });
  aliases.set(alias, targets);
}

function resolveUniqueAliases(aliases: ReadonlyMap<string, readonly AliasTarget[]>): ReadonlyMap<string, AliasTarget> {
  const unique = new Map<string, AliasTarget>();
  for (const [alias, targets] of aliases) {
    const nodeIds = new Set(targets.map((target) => target.nodeId));
    if (nodeIds.size === 1) unique.set(alias, targets[0]!);
  }
  return unique;
}

function extractDocumentTerms(text: string, limit: number): readonly ExtractedTerm[] {
  if (limit === 0 || !text) return [];
  const counts = new Map<string, ExtractedTerm>();
  const matches = text.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}_'-]{1,63}/gu);
  let previous: string | undefined;
  let previousEnd = 0;
  for (const match of matches) {
    const index = match.index ?? previousEnd;
    if (/[.!?;:\n\r]/u.test(text.slice(previousEnd, index))) previous = undefined;
    const token = normalizeTermToken(match[0]);
    previousEnd = index + match[0].length;
    if (!token) {
      previous = undefined;
      continue;
    }
    incrementExtractedTerm(counts, `token:${token}`, token, "token");
    if (previous && previous !== token) {
      const phrase = `${previous} ${token}`;
      incrementExtractedTerm(counts, `phrase:${phrase}`, phrase, "phrase");
    }
    previous = token;
  }

  const tokens = [...counts.values()].filter((term) => term.termType === "token").sort(compareExtractedTerms);
  const phrases = [...counts.values()].filter((term) => term.termType === "phrase").sort(compareExtractedTerms);
  const phraseTarget = Math.min(phrases.length, Math.ceil(limit / 3));
  const selected = [...tokens.slice(0, Math.max(0, limit - phraseTarget)), ...phrases.slice(0, phraseTarget)];
  if (selected.length < limit) {
    const selectedKeys = new Set(selected.map((term) => term.key));
    const remainder = [...tokens, ...phrases]
      .filter((term) => !selectedKeys.has(term.key))
      .sort(compareExtractedTerms)
      .slice(0, limit - selected.length);
    selected.push(...remainder);
  }
  return selected.sort(compareExtractedTerms);
}

function incrementExtractedTerm(
  counts: Map<string, ExtractedTerm>,
  key: string,
  label: string,
  termType: "token" | "phrase",
): void {
  const current = counts.get(key);
  if (current) current.count += 1;
  else counts.set(key, { key, label, termType, count: 1 });
}

function normalizeTermToken(value: string): string | undefined {
  const token = normalizeText(value)
    .replace(/^[\p{P}\p{S}_-]+|[\p{P}\p{S}_-]+$/gu, "")
    .replace(/(?:'s|’s)$/u, "");
  if (token.length < 3 || token.length > 48 || TERM_STOP_WORDS.has(token)) return undefined;
  if (!/\p{L}/u.test(token) || /^(?:https?|www)$/u.test(token)) return undefined;
  if (/^[a-f0-9]{16,}$/u.test(token) || /^(.)\1{5,}$/u.test(token)) return undefined;
  return token;
}

function compareExtractedTerms(left: ExtractedTerm, right: ExtractedTerm): number {
  return right.count - left.count
    || (left.termType === right.termType ? 0 : left.termType === "token" ? -1 : 1)
    || binaryCompare(left.key, right.key);
}

function compareTermAggregates(left: TermAggregate, right: TermAggregate): number {
  return right.documentCount - left.documentCount
    || right.occurrences - left.occurrences
    || (left.termType === right.termType ? 0 : left.termType === "token" ? -1 : 1)
    || binaryCompare(left.key, right.key);
}

function extractReferenceTokens(value: string): readonly string[] {
  const matches = value.match(/[\p{L}\p{N}_@./:+-]+/gu) ?? [];
  const tokens = new Set<string>();
  for (const match of matches) {
    const token = normalizeAlias(match);
    if (token.length >= 2) tokens.add(token);
  }
  return [...tokens];
}

function countComponents(
  nodes: readonly MemoryGraphNode[],
  incident: ReadonlyMap<string, readonly MemoryGraphEdge[]>,
): number {
  const visited = new Set<string>();
  let components = 0;
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    components += 1;
    visited.add(node.id);
    const queue = [node.id];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      for (const edge of incident.get(current) ?? EMPTY_EDGES) {
        const neighbor = edge.source === current ? edge.target : edge.source;
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return components;
}

function containsBounded(text: string, phrase: string): boolean {
  let index = text.indexOf(phrase);
  while (index >= 0) {
    const before = index === 0 ? "" : text[index - 1]!;
    const afterIndex = index + phrase.length;
    const after = afterIndex >= text.length ? "" : text[afterIndex]!;
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    index = text.indexOf(phrase, index + 1);
  }
  return false;
}

function isWordCharacter(value: string): boolean {
  return value !== "" && /[\p{L}\p{N}_-]/u.test(value);
}

function safeWorkspacePath(path: string): string | undefined {
  try {
    return normalizeWorkspacePath(path);
  } catch {
    return undefined;
  }
}

function deterministicPosition(
  kind: MemoryNodeKind,
  key: string,
  index: number,
  parent?: MemoryGraphNode,
): { x: number; y: number } {
  const anchors: Record<MemoryNodeKind, readonly [number, number]> = {
    session: [0, 0],
    message: [0, 0],
    "workspace-file": [-5, 0],
    profile: [4.5, -2.5],
    skill: [4.5, 2.5],
    term: [0, 5],
  };
  const [anchorX, anchorY] = parent ? [parent.x, parent.y] : anchors[kind];
  const hash = hashNumber(`${kind}\u0000${key}`);
  const angle = ((hash % 1_000_003) / 1_000_003) * Math.PI * 2 + index * 2.399963229728653;
  const radius = parent ? 0.55 + Math.sqrt(index + 1) * 0.22 : 0.45 + Math.sqrt(index + 1) * 0.36;
  return {
    x: anchorX + Math.cos(angle) * radius,
    y: anchorY + Math.sin(angle) * radius,
  };
}

function formatFileSize(size: number | undefined): string | undefined {
  if (size === undefined || !Number.isFinite(size) || size < 0) return undefined;
  if (size < 1_024) return `${Math.floor(size)} B`;
  return `${(size / 1_024).toFixed(1)} KiB`;
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedStrings(values: readonly string[] | undefined): readonly string[] {
  return values ? [...values].sort(binaryCompare) : [];
}

function hashNumber(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashString(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

const EMPTY_EDGES: readonly MemoryGraphEdge[] = Object.freeze([]);

const TERM_STOP_WORDS: ReadonlySet<string> = new Set([
  "about", "after", "again", "against", "all", "also", "and", "any", "are", "because", "been", "before",
  "being", "between", "both", "but", "can", "could", "did", "does", "doing", "down", "during", "each",
  "few", "for", "from", "further", "had", "has", "have", "having", "here", "hers", "him", "himself",
  "his", "how", "into", "its", "itself", "just", "more", "most", "not", "now", "off", "once", "only",
  "other", "our", "ours", "out", "over", "own", "same", "she", "should", "some", "such", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those",
  "through", "too", "under", "until", "very", "was", "were", "what", "when", "where", "which", "while",
  "who", "whom", "why", "will", "with", "would", "you", "your", "yours", "yourself", "yourselves",
]);
