import { sha256, stableStringify } from "../core/hash";
import type { JsonValue } from "../core/contracts";
import { readEncryptedSegment } from "../storage/encrypted-segments";
import { decodeExpertBlock, type StoredContextRecord } from "./codec";
import type {
  ContextDriverOptions,
  ContextFabricSearchHit,
  ContextExpert,
  ContextRoutingMirror,
  ContextStreamEvent,
  RetrievalBudget,
  RetrievalFocus,
  RetrievalObjectRead,
  RoutedExpert,
} from "./contracts";

const DEFAULT_BUDGET = { topK: 8, maxExperts: 4, maxBytes: 8 * 1024 * 1024, maxLatencyMs: 1_500 } as const;

export class ContextFabricDriver {
  constructor(private readonly options: ContextDriverOptions) {
    validateMirror(options.mirror);
  }

  async *search(
    query: string,
    focus: RetrievalFocus = {},
    budget: RetrievalBudget = {},
    signal?: AbortSignal,
  ): AsyncGenerator<ContextStreamEvent> {
    const limits = normalizeBudget(budget);
    const startedAt = new Date().toISOString();
    const mirror = this.options.mirror;
    if (
      mirror.embeddingProvider !== this.options.embeddings.id ||
      mirror.dimensions !== this.options.embeddings.dimensions
    ) {
      throw new Error("The context mirror and query embedding provider do not match.");
    }
    const queryTokens = tokenize([query, ...(focus.taskTerms ?? [])].join(" "));
    const [queryVector] = await this.options.embeddings.embed([query], signal);
    if (!queryVector || queryVector.length !== mirror.dimensions) throw new Error("Query embedding dimensions are invalid.");
    const mirrorDigest = await sha256(stableStringify(mirror as unknown as JsonValue));
    const queryDigest = await sha256(query);
    const routed = routeExperts(mirror, queryVector, queryTokens, focus);
    const selected = selectWithinBudget(routed, mirror, limits.maxExperts, limits.maxBytes);
    yield { type: "route", experts: selected.map(({ expert, score, bytes }) => routedView(expert, score, bytes)), mirrorDigest, queryDigest };

    if (selected.length < Math.min(routed.length, limits.maxExperts)) {
      yield { type: "warning", code: "budget", message: "Some context experts were skipped to honor the byte budget." };
    }

    const deadline = deadlineSignal(signal, limits.maxLatencyMs);
    const candidates = new Map<string, ContextFabricSearchHit>();
    const reads: RetrievalObjectRead[] = [];
    let bytesRead = 0;
    let completedExperts = 0;
    let timedOut = false;
    try {
      const pending = selected.map(({ expert, score }, index) =>
        fetchExpert(this.options, expert, score, queryVector, queryTokens, deadline.signal).then(
          (value) => ({ index, ok: true as const, value }),
          (error: unknown) => ({ index, ok: false as const, error }),
        ),
      );
      const active = new Map(pending.map((promise, index) => [index, promise]));
      while (active.size > 0) {
        const outcome = await Promise.race(active.values());
        active.delete(outcome.index);
        completedExperts += 1;
        const expert = selected[outcome.index]!.expert;
        if (!outcome.ok) {
          // The deadline signal fires for two unrelated reasons, and only the
          // caller's own signal separates them. A cancelled turn that was
          // reported as `timeout` fell through to the `complete` event below,
          // so the vault provider sealed and journaled a context commitment for
          // a turn the caller had asked to abandon, blaming the latency budget
          // for it. Reject the way ClientContextEngine.search does and reserve
          // `timeout` for the deadline timer alone.
          if (signal?.aborted) throw signal.reason ?? new DOMException("The context retrieval was aborted.", "AbortError");
          if (deadline.signal.aborted) {
            timedOut = true;
            yield { type: "warning", expertId: expert.id, code: "timeout", message: "Context retrieval reached its latency budget." };
            break;
          }
          yield {
            type: "warning",
            expertId: expert.id,
            code: "unavailable",
            message: outcome.error instanceof Error ? outcome.error.message : "A context expert could not be read.",
          };
          continue;
        }
        bytesRead += outcome.value.read.length;
        reads.push(outcome.value.read);
        for (const hit of outcome.value.hits) {
          const prior = candidates.get(hit.chunkId);
          if (!prior || prior.score < hit.score) candidates.set(hit.chunkId, hit);
        }
        yield {
          type: "partial",
          expertId: expert.id,
          hits: topHits(candidates, limits.topK),
          bytesRead,
          completedExperts,
          totalExperts: selected.length,
        };
      }
    } finally {
      deadline.dispose();
    }
    const hits = topHits(candidates, limits.topK);
    const resultDigest = await sha256(
      stableStringify(
        await Promise.all(hits.map(async ({ chunkId, path, revision, contentDigest, chunkIndex, score, text }) => ({
          chunkId,
          path,
          revision,
          contentDigest,
          chunkIndex,
          score,
          textDigest: await sha256(text),
        }))) as unknown as JsonValue,
      ),
    );
    yield {
      type: "complete",
      hits,
      commitment: {
        version: 1,
        generation: mirror.generation,
        mirrorDigest,
        queryDigest,
        selectedExperts: selected.map(({ expert }) => expert.id),
        objectReads: reads,
        bytesRead,
        resultDigest,
        startedAt,
        finishedAt: new Date().toISOString(),
        complete: !timedOut && completedExperts === selected.length,
      },
    };
  }
}

async function fetchExpert(
  options: ContextDriverOptions,
  expert: ContextExpert,
  routeScore: number,
  queryVector: Float32Array,
  queryTokens: string[],
  signal: AbortSignal,
): Promise<{ hits: ContextFabricSearchHit[]; read: RetrievalObjectRead }> {
  const object = options.mirror.objects[expert.objectId];
  if (!object) throw new Error("The context expert references a missing segment object.");
  const block = object.descriptor.blocks.find((candidate) => candidate.id === expert.blockId);
  if (!block) throw new Error("The context expert references a missing segment block.");
  const result = await readEncryptedSegment({
    key: options.key,
    store: options.store,
    cloudKey: object.cloudKey,
    descriptor: object.descriptor,
    blockId: expert.blockId,
    expectedNamespace: "context-fabric",
    expectedLogicalId: `${options.mirror.workspaceId}/${options.mirror.generation}`,
    signal,
  });
  const decoded = decodeExpertBlock(result.bytes, options.mirror.dimensions);
  return {
    hits: decoded.records.map((record) => scoreRecord(record, queryVector, queryTokens, routeScore)),
    read: {
      objectId: expert.objectId,
      blockId: expert.blockId,
      etag: result.etag,
      offset: block.offset,
      length: block.ciphertextLength,
      plaintextDigest: block.plaintextDigest,
    },
  };
}

function routeExperts(
  mirror: ContextRoutingMirror,
  queryVector: Float32Array,
  queryTokens: string[],
  focus: RetrievalFocus,
): Array<{ expert: ContextExpert; score: number; bytes: number }> {
  return mirror.experts
    .map((expert) => {
      const object = mirror.objects[expert.objectId];
      const block = object?.descriptor.blocks.find((candidate) => candidate.id === expert.blockId);
      if (!block) throw new Error("Context mirror contains an unresolved expert block.");
      const semantic = normalizedCosine(expert.centroid, queryVector);
      const lexical = overlap(queryTokens, expert.lexicalSketch);
      const gate = scopeAffinity(expert, focus);
      return { expert, score: 0.58 * semantic + 0.22 * lexical + 0.2 * gate, bytes: block.ciphertextLength };
    })
    .sort((left, right) => right.score - left.score || left.expert.id.localeCompare(right.expert.id));
}

function selectWithinBudget(
  routed: Array<{ expert: ContextExpert; score: number; bytes: number }>,
  _mirror: ContextRoutingMirror,
  maxExperts: number,
  maxBytes: number,
): Array<{ expert: ContextExpert; score: number; bytes: number }> {
  const selected: Array<{ expert: ContextExpert; score: number; bytes: number }> = [];
  let bytes = 0;
  for (const route of routed) {
    if (selected.length >= maxExperts) break;
    if (bytes + route.bytes > maxBytes) continue;
    selected.push(route);
    bytes += route.bytes;
  }
  return selected;
}

function scoreRecord(
  record: StoredContextRecord,
  queryVector: Float32Array,
  queryTokens: string[],
  routeScore: number,
): ContextFabricSearchHit {
  const denseScore = normalizedCosine(record.vector, queryVector);
  const lexicalScore = overlap(queryTokens, record.tokens);
  return {
    chunkId: record.chunkId,
    path: record.path,
    revision: record.revision,
    contentDigest: record.contentDigest,
    chunkIndex: record.chunkIndex,
    text: record.text,
    denseScore,
    lexicalScore,
    score: 0.72 * denseScore + 0.23 * lexicalScore + 0.05 * routeScore,
  };
}

function normalizedCosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  const cosine = leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
  return Math.max(0, Math.min(1, (cosine + 1) / 2));
}

function overlap(queryTokens: string[], terms: string[]): number {
  const query = new Set(queryTokens);
  if (query.size === 0) return 0;
  const available = new Set(terms);
  let matches = 0;
  for (const token of query) if (available.has(token)) matches += 1;
  return matches / query.size;
}

function scopeAffinity(expert: ContextExpert, focus: RetrievalFocus): number {
  const scores: number[] = [];
  if (focus.directory) scores.push(directoryMatch(focus.directory, expert.scope.directories ?? []));
  if (focus.profileId) scores.push(expert.scope.profiles?.includes(focus.profileId) ? 1 : 0);
  if (focus.branch) scores.push(expert.scope.branches?.includes(focus.branch) ? 1 : 0);
  if (focus.worktreeId) scores.push(expert.scope.worktrees?.includes(focus.worktreeId) ? 1 : 0);
  if (focus.sourceIds?.length) {
    const sources = new Set(expert.scope.sources ?? []);
    scores.push(focus.sourceIds.some((source) => sources.has(source)) ? 1 : 0);
  }
  return scores.length ? Math.max(...scores) : 0.5;
}

function directoryMatch(focus: string, directories: string[]): number {
  const normalized = normalizePath(focus);
  let best = 0;
  for (const directory of directories) {
    const candidate = normalizePath(directory);
    if (candidate === normalized) best = Math.max(best, 1);
    else if (normalized.startsWith(`${candidate}/`) || candidate.startsWith(`${normalized}/`)) best = Math.max(best, 0.75);
  }
  return best;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "") || ".";
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
}

function topHits(candidates: Map<string, ContextFabricSearchHit>, limit: number): ContextFabricSearchHit[] {
  return [...candidates.values()]
    .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
    .slice(0, limit);
}

function normalizeBudget(budget: RetrievalBudget): Required<RetrievalBudget> {
  const integer = (value: number | undefined, fallback: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Math.floor(value ?? fallback)));
  return {
    topK: integer(budget.topK, DEFAULT_BUDGET.topK, 1, 100),
    maxExperts: integer(budget.maxExperts, DEFAULT_BUDGET.maxExperts, 1, 64),
    maxBytes: integer(budget.maxBytes, DEFAULT_BUDGET.maxBytes, 1_024, 64 * 1024 * 1024),
    maxLatencyMs: integer(budget.maxLatencyMs, DEFAULT_BUDGET.maxLatencyMs, 50, 30_000),
  };
}

function routedView(expert: ContextExpert, score: number, bytes: number): RoutedExpert {
  return { expertId: expert.id, label: expert.label, kind: expert.kind, score, bytes };
}

function validateMirror(mirror: ContextRoutingMirror): void {
  if (
    mirror.version !== 2 ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(mirror.generation) ||
    !mirror.workspaceId ||
    mirror.dimensions <= 0 ||
    !mirror.lineage.sourceRevision ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(mirror.lineage.sourceDigest) ||
    !mirror.lineage.extractor ||
    !mirror.lineage.chunker ||
    !mirror.lineage.indexFormat
  ) {
    throw new Error("Invalid context routing mirror.");
  }
  if (!mirror.experts.length || !Object.keys(mirror.objects).length) throw new Error("Context routing mirror is empty.");
}

function deadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Retrieval deadline exceeded.", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}
