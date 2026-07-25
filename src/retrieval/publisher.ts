import { sha256 } from "../core/hash";
import type { EmbeddedChunk } from "../indexing/contracts";
import { sealSegmentedObject } from "../storage/encrypted-segments";
import type { ObjectStore } from "../storage/object-store";
import type { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { encodeExpertBlock } from "./codec";
import type { ContextExpert, ContextRoutingMirror, ContextScope } from "./contracts";

export async function publishContextGeneration(args: {
  store: ObjectStore;
  key: WorkspaceRootKey;
  workspaceId: string;
  generation: string;
  embeddingProvider: string;
  dimensions: number;
  sourceRevision: string;
  sourceDigest: string;
  extractor: string;
  chunker: string;
  embeddingPosture: "deterministic-bootstrap" | "local-semantic";
  indexFormat: string;
  chunks: EmbeddedChunk[];
  maxRecordsPerExpert?: number;
  resolveScope?: (chunk: EmbeddedChunk) => ContextScope;
  now?: () => Date;
  signal?: AbortSignal;
}): Promise<ContextRoutingMirror> {
  args.signal?.throwIfAborted();
  if (
    !args.workspaceId ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(args.generation) ||
    !args.embeddingProvider ||
    !args.sourceRevision ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(args.sourceDigest) ||
    !args.extractor ||
    !args.chunker ||
    !args.indexFormat
  ) {
    throw new Error("Context generations require workspace, generation, and embedding identifiers.");
  }
  if (args.chunks.some((chunk) => chunk.vector.length !== args.dimensions)) {
    throw new Error("Context chunks do not match the declared embedding dimensions.");
  }
  if (args.chunks.some((chunk) =>
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(chunk.id) ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(chunk.contentDigest) ||
    !chunk.path || !chunk.revision || !Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0
  )) {
    throw new Error("Context chunks do not carry canonical source and chunk lineage.");
  }
  const maxRecords = Math.max(1, Math.min(args.maxRecordsPerExpert ?? 96, 512));
  const grouped = groupChunks(args.chunks, args.resolveScope ?? defaultScope);
  const expertInputs: Array<{ scope: ContextScope; chunks: EmbeddedChunk[] }> = [];
  for (const group of grouped.values()) {
    for (let index = 0; index < group.chunks.length; index += maxRecords) {
      expertInputs.push({ scope: group.scope, chunks: group.chunks.slice(index, index + maxRecords) });
    }
  }
  if (expertInputs.length === 0) throw new Error("A context generation must contain at least one indexable chunk.");

  const blocks = expertInputs.map((expert, index) => ({
    id: `expert-${index}`,
    bytes: encodeExpertBlock(expert.chunks),
  }));
  const logicalId = `${args.workspaceId}/${args.generation}`;
  const sealed = await sealSegmentedObject({
    key: args.key,
    namespace: "context-fabric",
    logicalId,
    revision: args.generation,
    contentType: "application/vnd.airship.context-shards+json",
    blocks,
  });
  args.signal?.throwIfAborted();
  const cloudKey = `context/segments/${sealed.descriptor.objectId}`;
  const write = await args.store.putIfAbsent(cloudKey, sealed.ciphertext, args.signal);
  if (!write.created) throw new Error("A context generation with this identifier already exists.");

  const experts: ContextExpert[] = await Promise.all(
    expertInputs.map(async (input, index) => ({
      id: `expert-${(await sha256(`${args.generation}\0${index}\0${scopeKey(input.scope)}`)).slice(7, 23)}`,
      label: expertLabel(input.scope, index),
      kind: "directory" as const,
      scope: input.scope,
      centroid: centroid(input.chunks, args.dimensions),
      lexicalSketch: lexicalSketch(input.chunks),
      itemCount: input.chunks.length,
      objectId: sealed.descriptor.objectId,
      blockId: blocks[index]!.id,
    })),
  );
  return {
    version: 2,
    generation: args.generation,
    workspaceId: args.workspaceId,
    embeddingProvider: args.embeddingProvider,
    dimensions: args.dimensions,
    lineage: Object.freeze({
      sourceRevision: args.sourceRevision,
      sourceDigest: args.sourceDigest,
      extractor: args.extractor,
      chunker: args.chunker,
      embeddingPosture: args.embeddingPosture,
      indexFormat: args.indexFormat,
    }),
    createdAt: (args.now ?? (() => new Date()))().toISOString(),
    objects: {
      [sealed.descriptor.objectId]: { cloudKey, descriptor: sealed.descriptor },
    },
    experts,
  };
}

function groupChunks(
  chunks: EmbeddedChunk[],
  resolveScope: (chunk: EmbeddedChunk) => ContextScope,
): Map<string, { scope: ContextScope; chunks: EmbeddedChunk[] }> {
  const groups = new Map<string, { scope: ContextScope; chunks: EmbeddedChunk[] }>();
  for (const chunk of chunks) {
    const scope = normalizeScope(resolveScope(chunk));
    const key = scopeKey(scope);
    const group = groups.get(key) ?? { scope, chunks: [] };
    group.chunks.push(chunk);
    groups.set(key, group);
  }
  return groups;
}

function defaultScope(chunk: EmbeddedChunk): ContextScope {
  const separator = chunk.path.lastIndexOf("/");
  return { directories: [separator < 0 ? "." : chunk.path.slice(0, separator) || "."] };
}

function normalizeScope(scope: ContextScope): ContextScope {
  const normalize = (items?: string[]) =>
    items ? [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort() : undefined;
  return {
    directories: normalize(scope.directories),
    profiles: normalize(scope.profiles),
    branches: normalize(scope.branches),
    worktrees: normalize(scope.worktrees),
    sources: normalize(scope.sources),
  };
}

function scopeKey(scope: ContextScope): string {
  return JSON.stringify(scope);
}

function expertLabel(scope: ContextScope, index: number): string {
  return scope.directories?.[0] ?? scope.sources?.[0] ?? scope.profiles?.[0] ?? `Context partition ${index + 1}`;
}

function centroid(chunks: EmbeddedChunk[], dimensions: number): number[] {
  const result = new Float64Array(dimensions);
  for (const chunk of chunks) for (let index = 0; index < dimensions; index += 1) result[index] += chunk.vector[index]!;
  let norm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    result[index] /= chunks.length;
    norm += result[index] ** 2;
  }
  norm = Math.sqrt(norm) || 1;
  return [...result].map((value) => value / norm);
}

function lexicalSketch(chunks: EmbeddedChunk[]): string[] {
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    for (const token of new Set(chunk.tokens)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([leftToken, left], [rightToken, right]) => right - left || leftToken.localeCompare(rightToken))
    .slice(0, 48)
    .map(([token]) => token);
}
