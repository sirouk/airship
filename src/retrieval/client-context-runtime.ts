import { boundChunkTextToBytes } from "./codec";
import {
  ClientContextEngine,
  type ClientContextEngineOptions,
  type ClientContextSchedulingPolicy,
  type ClientContextEngineState,
  type ClientContextGeneration,
  type ClientContextGenerationExport,
  type ClientContextSearchOptions,
  type ClientContextSearchResult,
} from "../indexing/client-context-engine";
import { getBrowserCapabilityRegistry } from "../capabilities/browser-runtime";
import { sealContextSelection, type CanonicalContextHit, type CanonicalContextSelection } from "../core/context-selection";
import type { TurnContextRequest } from "../core/context-selection";
import { sha256 } from "../core/hash";
import type { WorkspaceEntry, WorkspacePort } from "../workspace/contracts";
import { HashEmbeddingProvider } from "../indexing/hash-embeddings";
import {
  readEmbeddingMode,
  readStoredEmbeddingMode,
  SwitchableEmbeddingProvider,
  type EmbeddingMode,
} from "../indexing/semantic-browser-provider";
import type { SemanticProviderState } from "../indexing/semantic-worker-provider";

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_TURN_HITS = 6;
const DEFAULT_TURN_BYTES = 24 * 1024;
const BUILT_IN_SEMANTIC_PACK_AVAILABLE = import.meta.env.VITE_AIRSHIP_SEMANTIC_PACK_AVAILABLE === "true";
const runtimes = new WeakMap<WorkspacePort, ClientContextRuntime>();

export type ClientContextRuntimeOptions = Omit<ClientContextEngineOptions, "workspace"> & Readonly<{
  debounceMs?: number;
  /** Overrides the built-in pack declaration for an application-supplied runtime. */
  semanticPackAvailable?: boolean;
}>;

/**
 * One memory-only retrieval lifecycle per workspace object. The runtime is an
 * ephemeron-owned page resource: no index, plaintext, or credential is persisted.
 */
export class ClientContextRuntime {
  readonly engine: ClientContextEngine;
  private readonly workspace: WorkspacePort;
  private readonly embeddings: ClientContextEngineOptions["embeddings"];
  private readonly switchable?: SwitchableEmbeddingProvider;
  readonly semanticPackAvailable: boolean;
  private readonly debounceMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private scheduled?: Promise<ClientContextGeneration>;
  private scheduledResolve?: (value: ClientContextGeneration) => void;
  private scheduledReject?: (reason: unknown) => void;
  private observed?: WorkspacePort;
  private derivedMode?: Promise<void>;

  constructor(workspace: WorkspacePort, options: ClientContextRuntimeOptions = {}) {
    const { debounceMs, semanticPackAvailable, ...engineOptions } = options;
    this.workspace = workspace;
    this.debounceMs = boundedInteger(debounceMs ?? DEFAULT_DEBOUNCE_MS, 0, 60_000);
    this.semanticPackAvailable = semanticPackAvailable
      ?? (engineOptions.embeddings !== undefined || BUILT_IN_SEMANTIC_PACK_AVAILABLE);
    const embeddings = engineOptions.embeddings
      ?? createDefaultEmbeddingProvider(engineOptions.dimensions, this.semanticPackAvailable);
    this.embeddings = embeddings;
    if (embeddings instanceof SwitchableEmbeddingProvider) this.switchable = embeddings;
    this.engine = new ClientContextEngine({
      workspace,
      ...engineOptions,
      embeddings,
      scheduling: engineOptions.scheduling ?? browserContextScheduling,
    });
  }

  get embeddingProviderId(): string { return this.embeddings!.id; }
  getEmbeddingMode(): EmbeddingMode { return this.switchable?.getMode() ?? (this.embeddings?.posture === "local-semantic" ? "semantic" : "bootstrap"); }
  getSemanticState(): SemanticProviderState | undefined { return this.switchable?.getSemanticState(); }
  /**
   * Which embedding deployment the confidential engine actually resolved.
   *
   * Undefined until discovery answers, and that is the honest state rather than
   * a gap to paper over: before `prepare()` completes nothing here knows which
   * chute will serve, so the screen that describes the engine must be able to
   * say so instead of naming a model from a constant. See
   * `context-view.tsx` `embeddingEngineNote`.
   */
  getConfidentialEmbeddingModelId(): string | undefined { return this.switchable?.getConfidentialReadiness()?.modelId; }
  subscribeSemantic(listener: (state: SemanticProviderState) => void): (() => void) | undefined {
    return this.switchable?.subscribeSemantic(listener);
  }

  /** Switch only after any active generation completes, then rebuild atomically. */
  async setEmbeddingMode(mode: EmbeddingMode): Promise<ClientContextGeneration> {
    if (!this.switchable) throw new Error("This context runtime uses an application-supplied embedding provider.");
    if (mode === "semantic" && !this.semanticPackAvailable) {
      throw new Error("Local semantic embeddings are unavailable because this Airship build does not publish the optional semantic pack. Bootstrap remains active; publish the verified pack before selecting Local semantic.");
    }
    // An explicit selection settles the question the probe exists to answer,
    // including when it arrives before the first generation.
    this.derivedMode = Promise.resolve();
    /*
     * Discovery happens before the switch, not after it.
     *
     * The confidential engine has to ask Chutes which chutes embed and how wide
     * their vectors are before it can hold an index. Doing that here means an
     * unreadable catalog or a deployment that will not answer a width probe
     * rejects `setEmbeddingMode` with its own sentence — which the Context view
     * puts on screen — instead of switching the index into a mode that cannot
     * embed and discovering it one rebuild later.
     */
    await this.switchable.prepare(mode);
    if (this.switchable.getMode() === mode && this.engine.getState().generation) return this.refreshNow();
    try { await this.refreshNow(); } catch { /* A failed old generation does not prevent a clean rebuild. */ }
    this.engine.cancelSearch(new DOMException("Embedding mode changed.", "AbortError"));
    this.engine.resetMaterialization();
    this.switchable.setMode(mode);
    return this.engine.updateWorkspace(await this.workspace.list("/workspace"));
  }

  getState(): ClientContextEngineState { return this.engine.getState(); }
  exportActiveGeneration(): ClientContextGenerationExport { return this.engine.exportActiveGeneration(); }
  subscribe(listener: (state: ClientContextEngineState) => void): () => void { return this.engine.subscribe(listener); }
  cancelSearch(reason?: unknown): void { this.engine.cancelSearch(reason); }
  async updateWorkspace(entries: readonly WorkspaceEntry[]): Promise<ClientContextGeneration> {
    await this.resolveDerivedEmbeddingMode();
    return this.engine.updateWorkspace(entries);
  }

  /**
   * Chooses the embedding mode from this device when nobody has chosen one.
   *
   * Mode selection used to read a single input — a recorded preference — and
   * had no branch for "none recorded", so the capability probe's verdict was
   * computed and then ignored. This joins the two, once per runtime, before the
   * first generation is built. It never persists: the durable preference stays
   * the person's alone, and an explicit selection still wins on the next load.
   */
  private resolveDerivedEmbeddingMode(): Promise<void> {
    return this.derivedMode ??= (async () => {
      const switchable = this.switchable;
      if (!switchable || !this.semanticPackAvailable || readStoredEmbeddingMode() !== undefined) return;
      try {
        const report = await getBrowserCapabilityRegistry().refresh();
        // The probe is not instant, and a person may have chosen during it.
        if (readStoredEmbeddingMode() !== undefined) return;
        const scheduling = report.scheduling;
        const backendAvailable = scheduling.preferredSemanticBackend === "webgpu"
          ? report.webgpu.state === "available"
          : report.wasm.state === "available";
        // `heavyPackLoading` gates nothing on its own; activating semantic mode
        // downloads the optional pack, so this is that consumer gating its own
        // fetch on an offline or data-saving device.
        if (!backendAvailable || scheduling.class === "constrained" || scheduling.heavyPackLoading === "manual") return;
        switchable.applyDerivedMode("semantic");
        // Proving the worker starts before a generation depends on it: a
        // capability report is a prediction, and an unstarted worker would
        // otherwise fail every candidate instead of degrading to bootstrap.
        await switchable.embed(["airship semantic activation probe"]);
      } catch {
        switchable.applyDerivedMode("bootstrap");
      }
    })();
  }

  /** Debounced refresh used after successful client-side mutations/imports. */
  scheduleRefresh(): Promise<ClientContextGeneration> {
    if (!this.scheduled) {
      this.scheduled = new Promise<ClientContextGeneration>((resolve, reject) => {
        this.scheduledResolve = resolve;
        this.scheduledReject = reject;
      });
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flushScheduledRefresh().catch(() => undefined), this.debounceMs);
    return this.scheduled;
  }

  async refreshNow(): Promise<ClientContextGeneration> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.flushScheduledRefresh();
  }

  async search(query: string, options: ClientContextSearchOptions = {}): Promise<ClientContextSearchResult> {
    await this.refreshNow();
    return this.engine.search(query, options);
  }

  async selectForTurn(query: string, request: TurnContextRequest): Promise<CanonicalContextSelection>;
  async selectForTurn(
    query: string,
    signal?: AbortSignal,
    limits?: Readonly<{ maxHits?: number; maxBytes?: number }>,
  ): Promise<CanonicalContextSelection>;
  async selectForTurn(
    query: string,
    requestOrSignal?: TurnContextRequest | AbortSignal,
    requestedLimits: Readonly<{ maxHits?: number; maxBytes?: number }> = {},
  ): Promise<CanonicalContextSelection> {
    const request = isTurnContextRequest(requestOrSignal) ? requestOrSignal : undefined;
    const signal = request ? request.signal : requestOrSignal as AbortSignal | undefined;
    const limits = request ? { maxHits: request.maxHits, maxBytes: request.maxBytes } : requestedLimits;
    const maxHits = boundedInteger(limits.maxHits ?? DEFAULT_TURN_HITS, 1, 8);
    const maxBytes = boundedInteger(limits.maxBytes ?? DEFAULT_TURN_BYTES, 1, 32 * 1024);
    const result = await this.search(query.slice(0, 8_192), { limit: maxHits, signal });
    const generation = this.engine.getState().generation;
    if (!generation || generation.lineage.generationDigest !== result.generationDigest) {
      throw new Error("Context lineage changed before the turn selection was sealed.");
    }
    const hits: CanonicalContextHit[] = [];
    let selectedBytes = 0;
    let truncated = result.hits.length > maxHits;
    for (const hit of result.hits.slice(0, maxHits)) {
      const remaining = maxBytes - selectedBytes;
      if (remaining <= 0) { truncated = true; break; }
      const text = boundChunkTextToBytes(hit.text, remaining);
      if (!text) { truncated = true; break; }
      const bytes = new TextEncoder().encode(text).byteLength;
      selectedBytes += bytes;
      if (text !== hit.text) truncated = true;
      hits.push(Object.freeze({
        path: hit.path,
        revision: hit.revision,
        contentDigest: hit.contentDigest,
        chunkId: hit.chunkId,
        chunkIndex: hit.chunkIndex,
        score: hit.score,
        text,
        textDigest: await sha256(text),
        corpus: "workspace",
        sourceId: hit.path,
        lineageRef: generation.lineage.generationDigest,
      }));
      if (text !== hit.text) break;
    }
    return sealContextSelection({
      version: 2,
      queryDigest: result.queryDigest,
      generationDigest: result.generationDigest,
      workspaceSnapshotDigest: result.workspaceSnapshotDigest,
      selectedAt: result.completedAt,
      maxHits,
      maxBytes,
      selectedBytes,
      truncated,
      hits: Object.freeze(hits),
      lineage: Object.freeze({
        retriever: "airship-workspace-turn-context-v1",
        scope: Object.freeze({}),
        generations: Object.freeze([Object.freeze({
          id: generation.lineage.generationDigest,
          corpus: "workspace",
          sourceRevision: generation.workspaceSnapshotDigest,
          sourceDigest: generation.workspaceSnapshotDigest,
          extractor: generation.lineage.extractor,
          chunker: `${generation.lineage.chunker};max=${generation.lineage.maxChunkCharacters};overlap=${generation.lineage.overlapCharacters}`,
          embedding: Object.freeze({
            provider: generation.lineage.embeddingProvider,
            dimensions: generation.lineage.embeddingDimensions,
            posture: generation.lineage.embeddingPosture,
          }),
          indexFormat: generation.lineage.indexFormat,
          persistence: generation.lineage.persistence,
        })]),
      }),
    });
  }

  /** Workspace facade used by every built-in tool to observe successful writes. */
  observeWorkspace(): WorkspacePort {
    if (this.observed) return this.observed;
    const runtime = this;
    this.observed = Object.freeze({
      read: (path: string) => runtime.workspace.read(path),
      ...(runtime.workspace.readBounded
        ? { readBounded: (path: string, maxBytes: number) => runtime.workspace.readBounded!(path, maxBytes) }
        : {}),
      list: (path?: string) => runtime.workspace.list(path),
      async write(path: string, content: string, options?: { expectedRevision?: string | null }) {
        const file = await runtime.workspace.write(path, content, options);
        void runtime.scheduleRefresh().catch(() => undefined);
        return file;
      },
      async remove(path: string, options?: { expectedRevision?: string }) {
        await runtime.workspace.remove(path, options);
        void runtime.scheduleRefresh().catch(() => undefined);
      },
    });
    return this.observed;
  }

  private async flushScheduledRefresh(): Promise<ClientContextGeneration> {
    const resolve = this.scheduledResolve;
    const reject = this.scheduledReject;
    this.scheduled = undefined;
    this.scheduledResolve = undefined;
    this.scheduledReject = undefined;
    this.timer = undefined;
    try {
      await this.resolveDerivedEmbeddingMode();
      const generation = await this.engine.updateWorkspace(await this.workspace.list("/workspace"));
      resolve?.(generation);
      return generation;
    } catch (error) {
      reject?.(error);
      throw error;
    }
  }
}

function isTurnContextRequest(value: TurnContextRequest | AbortSignal | undefined): value is TurnContextRequest {
  return Boolean(value) && typeof value === "object" && "sessionId" in value;
}

function createDefaultEmbeddingProvider(dimensions: number | undefined, semanticPackAvailable: boolean) {
  // Custom low-dimensional providers remain deterministic for unit tests and
  // embeddings that are not compatible with the pinned 384d semantic model.
  return dimensions && dimensions !== 384
    ? new HashEmbeddingProvider(dimensions)
    : new SwitchableEmbeddingProvider(384, semanticPackAvailable ? readEmbeddingMode() : "bootstrap");
}

function browserContextScheduling(): ClientContextSchedulingPolicy {
  const policy = getBrowserCapabilityRegistry().snapshot()?.scheduling;
  if (!policy) {
    // Startup remains responsive before the asynchronous probe completes. A
    // later generation re-reads the registry and can safely widen its lanes.
    return Object.freeze({ embeddingBatchSize: 4, maxIndexingConcurrency: 1, yieldEveryMs: 8 });
  }
  return Object.freeze({
    embeddingBatchSize: policy.embeddingBatchSize,
    maxIndexingConcurrency: policy.maxIndexingConcurrency,
    yieldEveryMs: policy.yieldEveryMs,
  });
}

export function getClientContextRuntime(
  workspace: WorkspacePort,
  options: ClientContextRuntimeOptions = {},
): ClientContextRuntime {
  const existing = runtimes.get(workspace);
  if (existing) {
    if (options.embeddings && options.embeddings.id !== existing.embeddingProviderId) {
      throw new Error(`Workspace context runtime is already pinned to ${existing.embeddingProviderId}.`);
    }
    return existing;
  }
  const runtime = new ClientContextRuntime(workspace, options);
  runtimes.set(workspace, runtime);
  return runtime;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError("Context runtime limit is invalid.");
  return value;
}
