import { sha256 } from "../core/hash";
import { isWorkspaceControlPlanePath, normalizeWorkspacePath, type WorkspaceEntry, type WorkspacePort } from "../workspace/contracts";
import type {
  ClientIndex,
  EmbeddedChunk,
  EmbeddingProvider,
  IndexCandidate,
  Indexability,
  IndexSnapshot,
  SearchHit,
} from "./contracts";
import { FlatClientIndex } from "./flat-index";
import { HashEmbeddingProvider } from "./hash-embeddings";
import { IncrementalWorkspaceIndexer } from "./incremental-indexer";

const DEFAULT_DIMENSIONS = 384;
const DEFAULT_MAX_FILE_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_CHUNK_CHARACTERS = 1_200;
const DEFAULT_OVERLAP_CHARACTERS = 160;
const MAX_SNAPSHOT_ENTRIES = 250_000;
const MAX_QUERY_CHARACTERS = 8_192;

export type ClientContextPhase = "idle" | "refreshing" | "ready" | "error" | "disposed";

/**
 * Whether a hit is evidence, or merely the nearest row the index holds.
 *
 * The measured defect: the query "Kyoto", against a workspace containing no
 * occurrence of the word, rendered "Workspace & sources · 1 result ·
 * /workspace/README.md" and printed the whole README as the answer. The
 * disqualifying fact — "Dense 0.065 · Lexical 0.000 · Combined 0.046" — was
 * three disclosures down, under a route-level promise that "Nothing was
 * hidden, filtered, or ranked away". `zzqqxv` produced the same "1 result".
 *
 * A flat index always returns its top-k, and that ranking is correct; what was
 * missing is the floor that says which of those rows may be spoken of as a
 * match. Classification never removes a row — a weak hit is still returned,
 * still opens, still carries its full lineage — it only stops it being counted
 * as a result and states, at the top level, why it does not qualify.
 *
 * It lives in the engine because the engine is the only layer that knows which
 * provider embedded the vectors it scored, which is the whole basis of the rule.
 */
export type RetrievalConfidence = "confident" | "weak";

export type RetrievalConfidenceVerdict = Readonly<{
  confidence: RetrievalConfidence;
  /** Present only on a weak hit: the disqualifying fact, in one sentence. */
  weakBecause?: string;
}>;

/**
 * The cosine a real local model has to reach before a wordless hit counts.
 *
 * Only the semantic posture gets a dense-only path at all: a sentence-embedding
 * model legitimately matches "freshness window" to "quote expiry" with no token
 * in common. Below this, the same model's neighbours are topic noise, so the
 * row is reported as the nearest one rather than as a match.
 */
export const SEMANTIC_DENSE_FLOOR = 0.35;

/**
 * The words every surface uses for the rows that fell below the floor.
 *
 * Copied — not imported — by `ui/memory-view.tsx`, which is its own route chunk
 * and would split this module out of the deferred-capabilities pack into an
 * unattributable third one. The copy is fenced by a test that imports both.
 */
export const RETRIEVAL_FLOOR_HEADING = "Closest, below the confidence floor";

/**
 * The floor, derived from the embedding posture rather than from a taste.
 *
 * `deterministic-bootstrap` hashes each token into one of N buckets and sums
 * ±1. Two texts that share no token can only score above zero when two
 * different tokens land in the same bucket, so a dense score with zero lexical
 * overlap is a hash collision and carries no information about meaning. That is
 * exactly the 0.065 the README scored for "Kyoto". For that provider the rule
 * is therefore absolute: a query word has to actually appear.
 */
export function classifyRetrievalHit(
  hit: Pick<SearchHit, "denseScore" | "lexicalScore" | "score">,
  posture: EmbeddingProvider["posture"] = "deterministic-bootstrap",
): RetrievalConfidenceVerdict {
  if (hit.lexicalScore > 0) return Object.freeze({ confidence: "confident" as const });
  if (posture === "local-semantic") {
    return hit.denseScore >= SEMANTIC_DENSE_FLOOR
      ? Object.freeze({ confidence: "confident" as const })
      : Object.freeze({
        confidence: "weak" as const,
        weakBecause: `No word of the query appears here, and the local semantic model scored it ${hit.denseScore.toFixed(3)} — below the ${SEMANTIC_DENSE_FLOOR.toFixed(2)} similarity floor.`,
      });
  }
  return Object.freeze({
    confidence: "weak" as const,
    weakBecause: `No word of the query appears here. Bootstrap embeddings hash tokens into buckets, so unrelated text still scores ${hit.denseScore.toFixed(3)} by collision — this is the nearest row, not a match.`,
  });
}

export type ClientContextCandidate = Readonly<{
  path: string;
  revision: string;
  updatedAt: string;
  size: number;
  status: Indexability;
  reason: string;
  contentType?: string;
  chunks: number;
  contentDigest?: string;
  chunkIds: readonly string[];
}>;

export type ClientContextCandidateStats = Readonly<{
  total: number;
  bytes: number;
  indexedBytes: number;
  byStatus: Readonly<Record<Indexability, number>>;
}>;

export type ClientContextChunkStats = Readonly<{
  total: number;
  documents: number;
  characters: number;
  tokens: number;
  vectorBytes: number;
}>;

export type ClientContextRefreshTiming = Readonly<{
  discoveryMs: number;
  indexingMs: number;
  validationMs: number;
  totalMs: number;
}>;

export type ClientContextLineage = Readonly<{
  generationDigest: string;
  workspaceSnapshotDigest: string;
  embeddingProvider: string;
  embeddingDimensions: number;
  /*
   * Taken from the provider contract rather than restated. This union was
   * written out a second time here, so adding a posture to `EmbeddingProvider`
   * broke lineage typing instead of flowing into it — and lineage is where a
   * reader learns whether their vectors left the device.
   */
  embeddingPosture: NonNullable<EmbeddingProvider["posture"]>;
  extractor: "airship-extension-text-v1";
  chunker: "airship-character-window-v1";
  maxFileBytes: number;
  maxChunkCharacters: number;
  overlapCharacters: number;
  indexFormat: "flat-client-index-v1";
  scoring: "cosine-0.72+lexical-0.28";
  persistence: "memory-only";
}>;

export type ClientContextGeneration = Readonly<{
  sequence: number;
  createdAt: string;
  workspaceSnapshotDigest: string;
  candidates: readonly ClientContextCandidate[];
  candidateStats: ClientContextCandidateStats;
  chunkStats: ClientContextChunkStats;
  timing: ClientContextRefreshTiming;
  lineage: ClientContextLineage;
}>;

/**
 * Immutable publication view of the active client generation. This is exposed
 * only after the same revision snapshot used for search is fully committed.
 * Callers receive cloned vectors so a Vault publisher cannot mutate the live
 * in-memory index.
 */
export type ClientContextGenerationExport = Readonly<{
  generation: ClientContextGeneration;
  embeddings: EmbeddingProvider;
  chunks: readonly EmbeddedChunk[];
}>;

export type ClientContextSearchHit = Readonly<SearchHit & {
  contentDigest: string;
  chunkIndex: number;
  /**
   * Whether this row may be spoken of as a match. Every hit the ranking
   * produced is still returned; `weak` is a label, never a filter.
   */
  confidence: RetrievalConfidence;
  /** Present only on a weak hit: the disqualifying fact, in one sentence. */
  weakBecause?: string;
}>;

export type ClientContextSearchResult = Readonly<{
  query: string;
  queryDigest: string;
  generationDigest: string;
  workspaceSnapshotDigest: string;
  durationMs: number;
  completedAt: string;
  hits: readonly ClientContextSearchHit[];
}>;

export type ClientContextLastSearch = Readonly<{
  queryDigest: string;
  generationDigest: string;
  resultCount: number;
  durationMs: number;
  completedAt: string;
}>;

export type ClientContextEngineState = Readonly<{
  phase: ClientContextPhase;
  generation?: ClientContextGeneration;
  targetSnapshotDigest?: string;
  lastSearch?: ClientContextLastSearch;
  error?: Readonly<{ code: string; message: string }>;
}>;

export type ClientContextEngineOptions = Readonly<{
  workspace: WorkspacePort;
  embeddings?: EmbeddingProvider;
  dimensions?: number;
  maxFileBytes?: number;
  maxChunkCharacters?: number;
  overlapCharacters?: number;
  clock?: () => number;
  now?: () => Date;
  /** Re-read for every generation so battery/network lifecycle probes can tune new work. */
  scheduling?: () => ClientContextSchedulingPolicy;
}>;

export type ClientContextSchedulingPolicy = Readonly<{
  embeddingBatchSize: number;
  maxIndexingConcurrency: number;
  yieldEveryMs: number;
}>;

export type ClientContextSearchOptions = Readonly<{
  limit?: number;
  signal?: AbortSignal;
}>;

export class ClientContextSupersededError extends Error {
  readonly code = "CONTEXT_RUN_SUPERSEDED";

  constructor(message = "A newer workspace snapshot superseded this context run.") {
    super(message);
    this.name = "ClientContextSupersededError";
  }
}

export class ClientContextStaleSnapshotError extends Error {
  readonly code = "CONTEXT_SNAPSHOT_STALE";

  constructor(message = "The workspace no longer matches the requested revision snapshot.") {
    super(message);
    this.name = "ClientContextStaleSnapshotError";
  }
}

export class ClientContextUnavailableError extends Error {
  readonly code = "CONTEXT_NOT_READY";

  constructor(message = "Context search is unavailable until the current workspace snapshot is indexed.") {
    super(message);
    this.name = "ClientContextUnavailableError";
  }
}

type NormalizedWorkspaceSnapshot = Readonly<{
  entries: readonly WorkspaceEntry[];
  key: string;
}>;

type Waiter = Readonly<{
  resolve: (generation: ClientContextGeneration) => void;
  reject: (error: unknown) => void;
}>;

type RefreshRun = {
  snapshot: NormalizedWorkspaceSnapshot;
  controller: AbortController;
  waiters: Waiter[];
};

type ActiveGeneration = Readonly<{
  key: string;
  public: ClientContextGeneration;
  indexer: IncrementalWorkspaceIndexer;
  index: ClientIndex;
  chunks: ReadonlyMap<string, EmbeddedChunk>;
  snapshot: IndexSnapshot;
}>;

type StagedGeneration = ActiveGeneration;

/**
 * A memory-only coordinator around the bootstrap indexer. Each refresh builds
 * in an isolated staging index, so an aborted or stale run can never become
 * searchable. The latest distinct revision snapshot wins; identical snapshots
 * share one refresh run.
 */
export class ClientContextEngine {
  private readonly workspace: WorkspacePort;
  private readonly embeddings: EmbeddingProvider;
  private readonly maxFileBytes: number;
  private readonly maxChunkCharacters: number;
  private readonly overlapCharacters: number;
  private readonly clock: () => number;
  private readonly now: () => Date;
  private readonly scheduling?: () => ClientContextSchedulingPolicy;
  private readonly listeners = new Set<(state: ClientContextEngineState) => void>();
  private active?: ActiveGeneration;
  private running?: RefreshRun;
  private pending?: RefreshRun;
  private pumping = false;
  private disposed = false;
  private sequence = 0;
  private searchController?: AbortController;
  private state: ClientContextEngineState = Object.freeze({ phase: "idle" });

  constructor(options: ClientContextEngineOptions) {
    this.workspace = options.workspace;
    this.embeddings = options.embeddings ?? new HashEmbeddingProvider(options.dimensions ?? DEFAULT_DIMENSIONS);
    this.maxFileBytes = boundedInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "Maximum file bytes", 1, 1_073_741_824);
    this.maxChunkCharacters = boundedInteger(options.maxChunkCharacters ?? DEFAULT_MAX_CHUNK_CHARACTERS, "Maximum chunk characters", 64, 1_000_000);
    this.overlapCharacters = boundedInteger(options.overlapCharacters ?? DEFAULT_OVERLAP_CHARACTERS, "Chunk overlap characters", 0, this.maxChunkCharacters - 1);
    this.clock = options.clock ?? monotonicNow;
    this.now = options.now ?? (() => new Date());
    this.scheduling = options.scheduling;
  }

  getState(): ClientContextEngineState {
    return this.state;
  }

  exportActiveGeneration(): ClientContextGenerationExport {
    if (this.disposed || this.state.phase !== "ready" || !this.active || this.running || this.pending) {
      throw new ClientContextUnavailableError("A stable context generation is not available for encrypted publication.");
    }
    return Object.freeze({
      generation: this.active.public,
      embeddings: this.embeddings,
      chunks: Object.freeze([...this.active.chunks.values()].map((chunk) => Object.freeze({
        ...chunk,
        tokens: [...chunk.tokens],
        vector: new Float32Array(chunk.vector),
      }))),
    });
  }

  subscribe(listener: (state: ClientContextEngineState) => void): () => void {
    if (this.disposed) throw new ClientContextUnavailableError("The context engine has been disposed.");
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Schedule the latest authoritative workspace entry snapshot for indexing. */
  updateWorkspace(entries: readonly WorkspaceEntry[]): Promise<ClientContextGeneration> {
    if (this.disposed) return Promise.reject(new ClientContextUnavailableError("The context engine has been disposed."));
    let snapshot: NormalizedWorkspaceSnapshot;
    try {
      snapshot = normalizeSnapshot(entries);
    } catch (error) {
      const normalized = normalizeError(error);
      this.running?.controller.abort(normalized);
      if (this.pending) rejectWaiters(this.pending, normalized);
      this.pending = undefined;
      this.setFailure(error);
      return Promise.reject(error);
    }

    if (!this.running && !this.pending && this.state.phase === "ready" && this.active?.key === snapshot.key) {
      return Promise.resolve(this.active.public);
    }

    const sameRun = this.pending?.snapshot.key === snapshot.key
      ? this.pending
      : this.running?.snapshot.key === snapshot.key && !this.running.controller.signal.aborted
        ? this.running
        : undefined;
    if (sameRun) return appendWaiter(sameRun);

    const nextRun: RefreshRun = {
      snapshot,
      controller: new AbortController(),
      waiters: [],
    };
    const promise = appendWaiter(nextRun);
    if (this.pending) {
      rejectWaiters(this.pending, new ClientContextSupersededError());
      this.pending = undefined;
    }
    this.pending = nextRun;
    if (this.running && this.running.snapshot.key !== snapshot.key) {
      this.running.controller.abort(new ClientContextSupersededError());
    }
    this.cancelSearch(new ClientContextSupersededError("A workspace refresh superseded the active context search."));
    this.publish({
      phase: "refreshing",
      generation: this.active?.public,
    });
    void this.pump();
    return promise;
  }

  async search(query: string, options: ClientContextSearchOptions = {}): Promise<ClientContextSearchResult> {
    if (this.disposed) throw new ClientContextUnavailableError("The context engine has been disposed.");
    const normalizedQuery = boundedQuery(query);
    const limit = boundedInteger(options.limit ?? 8, "Search result limit", 1, 50);
    if (this.state.phase !== "ready" || !this.active || this.running || this.pending) {
      throw new ClientContextUnavailableError();
    }

    this.cancelSearch(new ClientContextSupersededError("A newer context search superseded this search."));
    const controller = new AbortController();
    this.searchController = controller;
    const detachExternalSignal = forwardAbort(options.signal, controller);
    const active = this.active;
    const startedAt = this.clock();
    try {
      throwIfAborted(controller.signal);
      await this.assertWorkspaceSnapshot(active.key, controller.signal);
      const hits = await active.indexer.search(normalizedQuery, limit, controller.signal);
      throwIfAborted(controller.signal);
      await this.assertWorkspaceSnapshot(active.key, controller.signal);
      if (this.active !== active || this.state.phase !== "ready" || this.running || this.pending) {
        throw new ClientContextSupersededError("The indexed generation changed during search.");
      }
      const enriched = hits
        .filter((hit) => Number.isFinite(hit.score) && Number.isFinite(hit.denseScore) && Number.isFinite(hit.lexicalScore) && hit.score > 0)
        // The posture is read here rather than baked into the hit by the index:
        // the flat index scores, and only the engine knows which provider
        // produced the vectors it scored — which is the whole basis of the floor.
        .map((hit) => enrichHit(hit, active.chunks, this.embeddings.posture));
      const completedAt = this.now().toISOString();
      const durationMs = elapsed(this.clock(), startedAt);
      const queryDigest = await sha256(normalizedQuery);
      throwIfAborted(controller.signal);
      const result: ClientContextSearchResult = Object.freeze({
        query: normalizedQuery,
        queryDigest,
        generationDigest: active.public.lineage.generationDigest,
        workspaceSnapshotDigest: active.public.workspaceSnapshotDigest,
        durationMs,
        completedAt,
        hits: Object.freeze(enriched),
      });
      if (this.active !== active || this.state.phase !== "ready") {
        throw new ClientContextSupersededError("The indexed generation changed while sealing search lineage.");
      }
      this.publish({
        ...this.state,
        lastSearch: Object.freeze({
          queryDigest,
          generationDigest: result.generationDigest,
          resultCount: result.hits.length,
          durationMs,
          completedAt,
        }),
      });
      return result;
    } catch (error) {
      if (error instanceof ClientContextStaleSnapshotError && this.active === active) this.setFailure(error);
      throw error;
    } finally {
      detachExternalSignal();
      if (this.searchController === controller) this.searchController = undefined;
    }
  }

  cancelSearch(reason: unknown = new DOMException("Context search was cancelled.", "AbortError")): void {
    if (!this.searchController?.signal.aborted) this.searchController?.abort(reason);
    this.searchController = undefined;
  }

  /** Discard the rebuildable memory index before changing embedding providers. */
  resetMaterialization(): void {
    if (this.disposed) throw new ClientContextUnavailableError("The context engine has been disposed.");
    if (this.running || this.pending || this.pumping) throw new ClientContextUnavailableError("The context engine is still refreshing.");
    this.cancelSearch(new DOMException("The context materialization was reset.", "AbortError"));
    void this.active?.index.clear();
    this.active = undefined;
    this.publish({ phase: "idle" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new ClientContextUnavailableError("The context engine has been disposed.");
    this.running?.controller.abort(error);
    if (this.running) rejectWaiters(this.running, error);
    if (this.pending) rejectWaiters(this.pending, error);
    this.pending = undefined;
    this.cancelSearch(error);
    void this.active?.index.clear();
    this.active = undefined;
    this.publish({ phase: "disposed" });
    this.listeners.clear();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.pending) {
        const run = this.pending;
        this.pending = undefined;
        this.running = run;
        try {
          const staged = await this.executeRefresh(run);
          throwIfAborted(run.controller.signal);
          if (this.pending) throw new ClientContextSupersededError();
          const previous = this.active;
          this.active = staged;
          this.publish({
            phase: "ready",
            generation: staged.public,
          });
          resolveWaiters(run, staged.public);
          if (previous && previous !== staged) void previous.index.clear();
        } catch (error) {
          rejectWaiters(run, error);
          if (!this.pending && !this.disposed && !(error instanceof ClientContextSupersededError)) this.setFailure(error);
        } finally {
          if (this.running === run) this.running = undefined;
        }
      }
    } finally {
      this.pumping = false;
      if (!this.disposed && this.pending) void this.pump();
    }
  }

  private async executeRefresh(run: RefreshRun): Promise<StagedGeneration> {
    const totalStartedAt = this.clock();
    const workspaceSnapshotDigest = await sha256(run.snapshot.key);
    throwIfAborted(run.controller.signal);
    this.publish({
      phase: "refreshing",
      generation: this.active?.public,
      targetSnapshotDigest: workspaceSnapshotDigest,
    });

    let validationMs = 0;
    const firstValidation = this.clock();
    await this.assertWorkspaceSnapshot(run.snapshot.key, run.controller.signal);
    validationMs += elapsed(this.clock(), firstValidation);

    const index = new FlatClientIndex();
    const scheduling = resolveScheduling(this.scheduling?.());
    const indexer = new IncrementalWorkspaceIndexer({
      workspace: this.workspace,
      embeddings: this.embeddings,
      index,
      maxFileBytes: this.maxFileBytes,
      maxChunkCharacters: this.maxChunkCharacters,
      overlapCharacters: this.overlapCharacters,
      scheduling: {
        embeddingBatchSize: scheduling.embeddingBatchSize,
        maxIndexingConcurrency: scheduling.maxIndexingConcurrency,
        cooperativeYieldIntervalMs: scheduling.yieldEveryMs,
      },
    });
    if (this.active) await indexer.importSnapshot(this.active.snapshot);
    throwIfAborted(run.controller.signal);

    const discoveryStartedAt = this.clock();
    await indexer.discover();
    const discoveryMs = elapsed(this.clock(), discoveryStartedAt);
    throwIfAborted(run.controller.signal);

    const indexingStartedAt = this.clock();
    const indexedCandidates = await indexer.refresh(run.controller.signal);
    const indexingMs = elapsed(this.clock(), indexingStartedAt);
    throwIfAborted(run.controller.signal);

    for (const candidate of indexedCandidates) {
      if (candidate.status !== "indexed") await index.removeByPath(candidate.path);
    }
    const chunks = await index.all();
    const finalValidation = this.clock();
    await this.assertWorkspaceSnapshot(run.snapshot.key, run.controller.signal);
    validateChunks(chunks, run.snapshot.entries);
    const candidates = await materializeCandidates(indexedCandidates, chunks, run.snapshot.entries, this.workspace, run.controller.signal);
    validationMs += elapsed(this.clock(), finalValidation);
    throwIfAborted(run.controller.signal);

    const generationSequence = this.sequence + 1;
    const generationDigest = await sha256(JSON.stringify({
      version: 1,
      workspaceSnapshotDigest,
      embeddingProvider: this.embeddings.id,
      dimensions: this.embeddings.dimensions,
      maxFileBytes: this.maxFileBytes,
      maxChunkCharacters: this.maxChunkCharacters,
      overlapCharacters: this.overlapCharacters,
      indexFormat: "flat-client-index-v1",
    }));
    throwIfAborted(run.controller.signal);
    this.sequence = generationSequence;
    const snapshot = await indexer.exportSnapshot();
    throwIfAborted(run.controller.signal);
    const publicGeneration = createPublicGeneration({
      sequence: generationSequence,
      createdAt: this.now().toISOString(),
      workspaceSnapshotDigest,
      generationDigest,
      candidates,
      chunks,
      discoveryMs,
      indexingMs,
      validationMs,
      totalMs: elapsed(this.clock(), totalStartedAt),
      embeddings: this.embeddings,
      maxFileBytes: this.maxFileBytes,
      maxChunkCharacters: this.maxChunkCharacters,
      overlapCharacters: this.overlapCharacters,
    });
    return Object.freeze({
      key: run.snapshot.key,
      public: publicGeneration,
      indexer,
      index,
      chunks: new Map(chunks.map((chunk) => [chunk.id, chunk])),
      snapshot,
    });
  }

  private async assertWorkspaceSnapshot(expectedKey: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const actual = normalizeSnapshot(await this.workspace.list("/workspace"));
    throwIfAborted(signal);
    if (actual.key !== expectedKey) throw new ClientContextStaleSnapshotError();
  }

  private setFailure(error: unknown): void {
    const normalized = normalizeError(error);
    this.cancelSearch(normalized);
    this.publish({
      phase: "error",
      generation: this.active?.public,
      error: Object.freeze({ code: errorCode(normalized), message: normalized.message }),
    });
  }

  private publish(state: ClientContextEngineState): void {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) listener(this.state);
  }
}

function resolveScheduling(value: ClientContextSchedulingPolicy | undefined): ClientContextSchedulingPolicy {
  if (!value) return Object.freeze({ embeddingBatchSize: 512, maxIndexingConcurrency: 1, yieldEveryMs: 0 });
  return Object.freeze({
    embeddingBatchSize: boundedInteger(value.embeddingBatchSize, "Embedding batch size", 1, 512),
    maxIndexingConcurrency: boundedInteger(value.maxIndexingConcurrency, "Indexing concurrency", 1, 8),
    yieldEveryMs: boundedInteger(value.yieldEveryMs, "Cooperative yield interval", 0, 1_000),
  });
}

export function isContextSupersession(error: unknown): error is ClientContextSupersededError {
  return error instanceof ClientContextSupersededError;
}

function appendWaiter(run: RefreshRun): Promise<ClientContextGeneration> {
  return new Promise<ClientContextGeneration>((resolve, reject) => run.waiters.push({ resolve, reject }));
}

function resolveWaiters(run: RefreshRun, generation: ClientContextGeneration): void {
  for (const waiter of run.waiters.splice(0)) waiter.resolve(generation);
}

function rejectWaiters(run: RefreshRun, error: unknown): void {
  for (const waiter of run.waiters.splice(0)) waiter.reject(error);
}

function normalizeSnapshot(entries: readonly WorkspaceEntry[]): NormalizedWorkspaceSnapshot {
  if (!Array.isArray(entries) || entries.length > MAX_SNAPSHOT_ENTRIES) throw new TypeError("The workspace revision snapshot is invalid or too large.");
  const seen = new Set<string>();
  const normalized = entries.filter((entry) => !isWorkspaceControlPlanePath(entry.path)).map((entry) => {
    const path = normalizeWorkspacePath(entry.path);
    if (path === "/workspace" || seen.has(path)) throw new TypeError("Workspace revision snapshots require unique file paths.");
    seen.add(path);
    if (!entry.revision || entry.revision.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(entry.revision)) {
      throw new TypeError("A workspace revision is invalid.");
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new TypeError("A workspace entry size is invalid.");
    if (!entry.updatedAt || !Number.isFinite(Date.parse(entry.updatedAt))) throw new TypeError("A workspace update timestamp is invalid.");
    return Object.freeze({
      path,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
      size: entry.size,
    });
  }).sort((left, right) => left.path.localeCompare(right.path));
  const key = JSON.stringify(normalized.map(({ path, revision, size }) => [path, revision, size]));
  return Object.freeze({ entries: Object.freeze(normalized), key });
}

function validateChunks(chunks: readonly EmbeddedChunk[], entries: readonly WorkspaceEntry[]): void {
  const revisions = new Map(entries.map((entry) => [entry.path, entry.revision]));
  const chunkIds = new Set<string>();
  for (const chunk of chunks) {
    if (chunkIds.has(chunk.id)) throw new ClientContextStaleSnapshotError("The staged index contains a duplicate chunk identifier.");
    chunkIds.add(chunk.id);
    if (revisions.get(chunk.path) !== chunk.revision) {
      throw new ClientContextStaleSnapshotError("The staged index contains a chunk from a stale file revision.");
    }
  }
}

async function materializeCandidates(
  indexedCandidates: readonly IndexCandidate[],
  chunks: readonly EmbeddedChunk[],
  entries: readonly WorkspaceEntry[],
  workspace: WorkspacePort,
  signal: AbortSignal,
): Promise<readonly ClientContextCandidate[]> {
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const chunksByPath = new Map<string, EmbeddedChunk[]>();
  for (const chunk of chunks) {
    const grouped = chunksByPath.get(chunk.path) ?? [];
    grouped.push(chunk);
    chunksByPath.set(chunk.path, grouped);
  }
  if (indexedCandidates.length !== entries.length) {
    throw new ClientContextStaleSnapshotError("The index candidate set does not match the workspace revision snapshot.");
  }
  const candidates: ClientContextCandidate[] = [];
  for (const candidate of indexedCandidates) {
    throwIfAborted(signal);
    const entry = entriesByPath.get(candidate.path);
    if (!entry || entry.revision !== candidate.revision || entry.size !== candidate.size) {
      throw new ClientContextStaleSnapshotError("An index candidate changed during refresh.");
    }
    const candidateChunks = (chunksByPath.get(candidate.path) ?? []).sort((left, right) => left.chunkIndex - right.chunkIndex);
    const digests = new Set(candidateChunks.map((chunk) => chunk.contentDigest));
    if (digests.size > 1) throw new ClientContextStaleSnapshotError("A file revision produced conflicting content digests.");
    let contentDigest = candidateChunks[0]?.contentDigest;
    if (candidate.status === "indexed" && !contentDigest) {
      const file = await workspace.read(candidate.path);
      throwIfAborted(signal);
      if (!file || file.revision !== candidate.revision) throw new ClientContextStaleSnapshotError();
      contentDigest = await sha256(file.content);
    }
    candidates.push(Object.freeze({
      path: candidate.path,
      revision: candidate.revision,
      updatedAt: entry.updatedAt,
      size: candidate.size,
      status: candidate.status,
      reason: candidate.reason,
      contentType: candidate.contentType,
      chunks: candidateChunks.length,
      contentDigest,
      chunkIds: Object.freeze(candidateChunks.map((chunk) => chunk.id)),
    }));
  }
  return Object.freeze(candidates.sort((left, right) => left.path.localeCompare(right.path)));
}

function createPublicGeneration(args: Readonly<{
  sequence: number;
  createdAt: string;
  workspaceSnapshotDigest: string;
  generationDigest: string;
  candidates: readonly ClientContextCandidate[];
  chunks: readonly EmbeddedChunk[];
  discoveryMs: number;
  indexingMs: number;
  validationMs: number;
  totalMs: number;
  embeddings: EmbeddingProvider;
  maxFileBytes: number;
  maxChunkCharacters: number;
  overlapCharacters: number;
}>): ClientContextGeneration {
  const byStatus: Record<Indexability, number> = {
    ready: 0,
    indexed: 0,
    changed: 0,
    unsupported: 0,
    "too-large": 0,
    failed: 0,
  };
  let bytes = 0;
  let indexedBytes = 0;
  for (const candidate of args.candidates) {
    byStatus[candidate.status] += 1;
    bytes += candidate.size;
    if (candidate.status === "indexed") indexedBytes += candidate.size;
  }
  const documentPaths = new Set<string>();
  let characters = 0;
  let tokens = 0;
  let vectorBytes = 0;
  for (const chunk of args.chunks) {
    documentPaths.add(chunk.path);
    characters += chunk.text.length;
    tokens += chunk.tokens.length;
    vectorBytes += chunk.vector.byteLength;
  }
  const timing: ClientContextRefreshTiming = Object.freeze({
    discoveryMs: roundedDuration(args.discoveryMs),
    indexingMs: roundedDuration(args.indexingMs),
    validationMs: roundedDuration(args.validationMs),
    totalMs: roundedDuration(args.totalMs),
  });
  const lineage: ClientContextLineage = Object.freeze({
    generationDigest: args.generationDigest,
    workspaceSnapshotDigest: args.workspaceSnapshotDigest,
    embeddingProvider: args.embeddings.id,
    embeddingDimensions: args.embeddings.dimensions,
    embeddingPosture: args.embeddings.posture ?? "deterministic-bootstrap",
    extractor: "airship-extension-text-v1",
    chunker: "airship-character-window-v1",
    maxFileBytes: args.maxFileBytes,
    maxChunkCharacters: args.maxChunkCharacters,
    overlapCharacters: args.overlapCharacters,
    indexFormat: "flat-client-index-v1",
    scoring: "cosine-0.72+lexical-0.28",
    persistence: "memory-only",
  });
  return Object.freeze({
    sequence: args.sequence,
    createdAt: args.createdAt,
    workspaceSnapshotDigest: args.workspaceSnapshotDigest,
    candidates: args.candidates,
    candidateStats: Object.freeze({
      total: args.candidates.length,
      bytes,
      indexedBytes,
      byStatus: Object.freeze(byStatus),
    }),
    chunkStats: Object.freeze({
      total: args.chunks.length,
      documents: documentPaths.size,
      characters,
      tokens,
      vectorBytes,
    }),
    timing,
    lineage,
  });
}

function enrichHit(
  hit: SearchHit,
  chunks: ReadonlyMap<string, EmbeddedChunk>,
  posture: EmbeddingProvider["posture"],
): ClientContextSearchHit {
  const chunk = chunks.get(hit.chunkId);
  if (!chunk || chunk.path !== hit.path || chunk.revision !== hit.revision) {
    throw new ClientContextStaleSnapshotError("A search hit is not bound to the active index generation.");
  }
  return Object.freeze({
    ...hit,
    contentDigest: chunk.contentDigest,
    chunkIndex: chunk.chunkIndex,
    ...classifyRetrievalHit(hit, posture),
  });
}

function boundedQuery(query: string): string {
  if (typeof query !== "string") throw new TypeError("A context search query is required.");
  const normalized = query.trim();
  if (!normalized || normalized.length > MAX_QUERY_CHARACTERS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("The context search query is empty or invalid.");
  }
  return normalized;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} is invalid.`);
  return value;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason ?? new DOMException("Context search was cancelled.", "AbortError"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function errorCode(error: Error): string {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : "CONTEXT_REFRESH_FAILED";
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function elapsed(value: number, startedAt: number): number {
  return Math.max(0, value - startedAt);
}

function roundedDuration(value: number): number {
  return Math.round(value * 100) / 100;
}
