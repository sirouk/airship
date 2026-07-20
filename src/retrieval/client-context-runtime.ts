import {
  ClientContextEngine,
  type ClientContextEngineOptions,
  type ClientContextEngineState,
  type ClientContextGeneration,
  type ClientContextSearchOptions,
  type ClientContextSearchResult,
} from "../indexing/client-context-engine";
import { sealContextSelection, type CanonicalContextHit, type CanonicalContextSelection } from "../core/context-selection";
import { sha256 } from "../core/hash";
import type { WorkspaceEntry, WorkspacePort } from "../workspace/contracts";
import { HashEmbeddingProvider } from "../indexing/hash-embeddings";
import {
  SwitchableEmbeddingProvider,
  type EmbeddingMode,
} from "../indexing/semantic-browser-provider";
import type { SemanticProviderState } from "../indexing/semantic-worker-provider";

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_TURN_HITS = 6;
const DEFAULT_TURN_BYTES = 24 * 1024;
const runtimes = new WeakMap<WorkspacePort, ClientContextRuntime>();

export type ClientContextRuntimeOptions = Omit<ClientContextEngineOptions, "workspace"> & Readonly<{
  debounceMs?: number;
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
  private readonly debounceMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private scheduled?: Promise<ClientContextGeneration>;
  private scheduledResolve?: (value: ClientContextGeneration) => void;
  private scheduledReject?: (reason: unknown) => void;
  private observed?: WorkspacePort;

  constructor(workspace: WorkspacePort, options: ClientContextRuntimeOptions = {}) {
    const { debounceMs, ...engineOptions } = options;
    this.workspace = workspace;
    this.debounceMs = boundedInteger(debounceMs ?? DEFAULT_DEBOUNCE_MS, 0, 60_000);
    const embeddings = engineOptions.embeddings ?? createDefaultEmbeddingProvider(engineOptions.dimensions);
    this.embeddings = embeddings;
    if (embeddings instanceof SwitchableEmbeddingProvider) this.switchable = embeddings;
    this.engine = new ClientContextEngine({ workspace, ...engineOptions, embeddings });
  }

  get embeddingProviderId(): string { return this.embeddings!.id; }
  getEmbeddingMode(): EmbeddingMode { return this.switchable?.getMode() ?? (this.embeddings?.posture === "local-semantic" ? "semantic" : "bootstrap"); }
  getSemanticState(): SemanticProviderState | undefined { return this.switchable?.getSemanticState(); }
  subscribeSemantic(listener: (state: SemanticProviderState) => void): (() => void) | undefined {
    return this.switchable?.subscribeSemantic(listener);
  }

  /** Switch only after any active generation completes, then rebuild atomically. */
  async setEmbeddingMode(mode: EmbeddingMode): Promise<ClientContextGeneration> {
    if (!this.switchable) throw new Error("This context runtime uses an application-supplied embedding provider.");
    if (this.switchable.getMode() === mode && this.engine.getState().generation) return this.refreshNow();
    try { await this.refreshNow(); } catch { /* A failed old generation does not prevent a clean rebuild. */ }
    this.engine.cancelSearch(new DOMException("Embedding mode changed.", "AbortError"));
    this.engine.resetMaterialization();
    this.switchable.setMode(mode);
    return this.engine.updateWorkspace(await this.workspace.list("/workspace"));
  }

  getState(): ClientContextEngineState { return this.engine.getState(); }
  subscribe(listener: (state: ClientContextEngineState) => void): () => void { return this.engine.subscribe(listener); }
  cancelSearch(reason?: unknown): void { this.engine.cancelSearch(reason); }
  updateWorkspace(entries: readonly WorkspaceEntry[]): Promise<ClientContextGeneration> { return this.engine.updateWorkspace(entries); }

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

  async selectForTurn(
    query: string,
    signal?: AbortSignal,
    limits: Readonly<{ maxHits?: number; maxBytes?: number }> = {},
  ): Promise<CanonicalContextSelection> {
    const maxHits = boundedInteger(limits.maxHits ?? DEFAULT_TURN_HITS, 1, 8);
    const maxBytes = boundedInteger(limits.maxBytes ?? DEFAULT_TURN_BYTES, 1, 32 * 1024);
    const result = await this.search(query.slice(0, 8_192), { limit: maxHits, signal });
    const hits: CanonicalContextHit[] = [];
    let selectedBytes = 0;
    let truncated = result.hits.length > maxHits;
    for (const hit of result.hits.slice(0, maxHits)) {
      const remaining = maxBytes - selectedBytes;
      if (remaining <= 0) { truncated = true; break; }
      const text = truncateUtf8(hit.text, remaining);
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
      }));
      if (text !== hit.text) break;
    }
    return sealContextSelection({
      version: 1,
      queryDigest: result.queryDigest,
      generationDigest: result.generationDigest,
      workspaceSnapshotDigest: result.workspaceSnapshotDigest,
      selectedAt: result.completedAt,
      maxHits,
      maxBytes,
      selectedBytes,
      truncated,
      hits: Object.freeze(hits),
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
      const generation = await this.engine.updateWorkspace(await this.workspace.list("/workspace"));
      resolve?.(generation);
      return generation;
    } catch (error) {
      reject?.(error);
      throw error;
    }
  }
}

function createDefaultEmbeddingProvider(dimensions?: number) {
  // Custom low-dimensional providers remain deterministic for unit tests and
  // embeddings that are not compatible with the pinned 384d semantic model.
  return dimensions && dimensions !== 384
    ? new HashEmbeddingProvider(dimensions)
    : new SwitchableEmbeddingProvider(384);
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

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (encoder.encode(output + character).byteLength > maxBytes) break;
    output += character;
  }
  return output;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError("Context runtime limit is invalid.");
  return value;
}
