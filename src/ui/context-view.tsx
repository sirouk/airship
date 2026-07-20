import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { isContextSupersession, type ClientContextEngineState, type ClientContextSearchResult } from "../indexing/client-context-engine";
import { getClientContextRuntime } from "../retrieval/client-context-runtime";
import type { WorkspaceEntry, WorkspacePort } from "../workspace/contracts";
import { Icon } from "./icons";
import type { ContextFabricDriver } from "../retrieval/context-driver";
import type { RetrievalCommitment, RoutedExpert } from "../retrieval/contracts";
import type { EmbeddingMode } from "../indexing/semantic-browser-provider";
import type { SemanticProviderState } from "../indexing/semantic-worker-provider";
import "./context-view.css";

export type ContextViewProps = Readonly<{
  workspace: WorkspacePort;
  entries: readonly WorkspaceEntry[];
  dimensions?: number;
  resultLimit?: number;
  fabricDriver?: ContextFabricDriver;
  embedded?: boolean;
}>;

export function ContextView({ workspace, entries, dimensions = 384, resultLimit = 8, fabricDriver, embedded = false }: ContextViewProps) {
  const runtime = useMemo(() => getClientContextRuntime(workspace, { dimensions }), [dimensions, workspace]);
  const [engineState, setEngineState] = useState<ClientContextEngineState>(() => runtime.getState());
  const [embeddingMode, setEmbeddingMode] = useState<EmbeddingMode>(() => runtime.getEmbeddingMode());
  const [semanticState, setSemanticState] = useState<SemanticProviderState | undefined>(() => runtime.getSemanticState());
  const [embeddingChange, setEmbeddingChange] = useState<"idle" | "changing">("idle");
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<ClientContextSearchResult>();
  const [searchStatus, setSearchStatus] = useState<"idle" | "searching" | "cancelled" | "complete">("idle");
  const [searchError, setSearchError] = useState<string>();
  const [fabric, setFabric] = useState<Readonly<{ experts: readonly RoutedExpert[]; warnings: readonly string[]; commitment?: RetrievalCommitment }>>({ experts: [], warnings: [] });
  const searchController = useRef<AbortController>();
  const searchSequence = useRef(0);

  useEffect(() => runtime.subscribe(setEngineState), [runtime]);
  useEffect(() => runtime.subscribeSemantic(setSemanticState), [runtime]);

  useEffect(() => {
    void runtime.updateWorkspace(entries).catch((error: unknown) => {
      if (!isContextSupersession(error)) setSearchError(undefined);
    });
  }, [runtime, entries]);

  useEffect(() => () => {
    searchController.current?.abort(new DOMException("Context view closed.", "AbortError"));
  }, [runtime]);

  const generationDigest = engineState.generation?.lineage.generationDigest;
  useEffect(() => {
    setSearchResult((current) => current?.generationDigest === generationDigest ? current : undefined);
    if (engineState.phase !== "ready") {
      searchController.current?.abort(new DOMException("The context generation changed.", "AbortError"));
      setSearchStatus("idle");
    }
  }, [engineState.phase, generationDigest]);

  async function search() {
    const normalized = query.trim();
    if (!normalized || engineState.phase !== "ready") return;
    const sequence = ++searchSequence.current;
    searchController.current?.abort(new DOMException("A newer search started.", "AbortError"));
    const controller = new AbortController();
    searchController.current = controller;
    setSearchStatus("searching");
    setSearchError(undefined);
    try {
      if (fabricDriver) {
        const experts: RoutedExpert[] = [];
        const warnings: string[] = [];
        let commitment: RetrievalCommitment | undefined;
        for await (const event of fabricDriver.search(normalized, {}, { topK: resultLimit }, controller.signal)) {
          if (event.type === "route") experts.push(...event.experts);
          if (event.type === "warning") warnings.push(event.message);
          if (event.type === "complete") commitment = event.commitment;
          setFabric({ experts: [...experts], warnings: [...warnings], ...(commitment ? { commitment } : {}) });
        }
      }
      const result = await runtime.search(normalized, { limit: resultLimit, signal: controller.signal });
      if (sequence !== searchSequence.current) return;
      setSearchResult(result);
      setSearchStatus("complete");
    } catch (error) {
      if (sequence !== searchSequence.current) return;
      if (isCancellation(error) || isContextSupersession(error)) {
        setSearchStatus("cancelled");
      } else {
        setSearchStatus("idle");
        setSearchError(error instanceof Error ? error.message : "Context search failed.");
      }
    } finally {
      if (searchController.current === controller) searchController.current = undefined;
    }
  }

  function cancelSearch() {
    searchSequence.current += 1;
    searchController.current?.abort(new DOMException("Search cancelled by the user.", "AbortError"));
    runtime.cancelSearch();
    searchController.current = undefined;
    setSearchStatus("cancelled");
  }

  const generation = engineState.generation;
  const stats = generation?.candidateStats;
  const chunks = generation?.chunkStats;

  async function changeEmbeddingMode(mode: EmbeddingMode) {
    if (mode === embeddingMode || embeddingChange === "changing") return;
    setEmbeddingChange("changing");
    setSearchError(undefined);
    try {
      await runtime.setEmbeddingMode(mode);
      setEmbeddingMode(mode);
      setSearchResult(undefined);
    } catch (error) {
      setEmbeddingMode(runtime.getEmbeddingMode());
      setSearchError(error instanceof Error ? error.message : "The local embedding engine could not be changed.");
    } finally {
      setEmbeddingChange("idle");
    }
  }

  return (
    <section class="client-context-view" aria-labelledby="client-context-title">
      {!embedded ? <header class="client-context-heading">
        <div>
          <span>On-device context index</span>
          <h1 id="client-context-title">Context</h1>
          <p>Workspace revisions are discovered, chunked, embedded, and searched inside this page. Each completed generation is bound to the exact revision set before it becomes searchable.</p>
        </div>
        <div class="bootstrap-badge" role="note">
          <Icon name="warning" size={18} />
          <div><strong>Deterministic hash bootstrap</strong><span>Useful for executable hybrid retrieval tests; not a production semantic embedding model.</span></div>
        </div>
      </header> : null}

      <section class="embedding-engine-card" aria-labelledby="embedding-engine-title">
        <div>
          <span>Private embedding engine</span>
          <h2 id="embedding-engine-title">{embeddingMode === "semantic" ? "Semantic transformer" : "Deterministic bootstrap"}</h2>
          <p>{embeddingMode === "semantic"
            ? "The pinned model executes in an isolated browser worker. WebGPU is preferred; WASM is the automatic fallback. Public model artifacts may be cached, but workspace text and vectors remain page-memory only."
            : "Hash vectors keep retrieval immediately available without a model download. They are deterministic test/bootstrap signals, not semantic understanding."}</p>
        </div>
        <div class="embedding-engine-actions" role="group" aria-label="Embedding engine">
          <button type="button" class={embeddingMode === "bootstrap" ? "selected" : ""} aria-pressed={embeddingMode === "bootstrap"} disabled={embeddingChange === "changing"} onClick={() => void changeEmbeddingMode("bootstrap")}>Bootstrap</button>
          <button type="button" class={embeddingMode === "semantic" ? "selected" : ""} aria-pressed={embeddingMode === "semantic"} disabled={embeddingChange === "changing"} onClick={() => void changeEmbeddingMode("semantic")}>Local semantic</button>
        </div>
        <div class="embedding-engine-state" role="status" aria-live="polite">
          <span class={semanticTone(embeddingMode, semanticState)} />
          {embeddingStatus(embeddingMode, semanticState, embeddingChange)}
          {semanticState?.loadedBytes !== undefined ? <small>{formatBytes(semanticState.loadedBytes)}{semanticState.totalBytes ? ` / ${formatBytes(semanticState.totalBytes)}` : ""}</small> : null}
        </div>
      </section>

      <div class="context-live-strip" aria-label="Context index status">
        <ContextMetric label="State" value={phaseLabel(engineState.phase, Boolean(stats?.byStatus.failed))} detail={engineState.phase === "refreshing" ? "staging privately" : "memory-only"} tone={engineState.phase === "error" ? "error" : engineState.phase === "ready" && stats?.byStatus.failed ? "caution" : engineState.phase === "ready" ? "ready" : "neutral"} />
        <ContextMetric label="Candidates" value={formatInteger(stats?.total ?? entries.length)} detail={stats ? `${formatBytes(stats.indexedBytes)} indexed` : `${formatInteger(entries.length)} observed`} />
        <ContextMetric label="Chunks" value={formatInteger(chunks?.total ?? 0)} detail={chunks ? `${formatInteger(chunks.documents)} documents` : "awaiting refresh"} />
        <ContextMetric label="Refresh" value={generation ? formatMilliseconds(generation.timing.totalMs) : "—"} detail={generation ? `${formatMilliseconds(generation.timing.indexingMs)} indexing` : "no completed run"} />
        <ContextMetric label="Vector memory" value={chunks ? formatBytes(chunks.vectorBytes) : "—"} detail={generation ? `${generation.lineage.embeddingDimensions} dimensions` : "not allocated"} />
      </div>

      {engineState.phase === "refreshing" ? (
        <p class="context-engine-status" role="status" aria-live="polite"><span />Coalescing the latest workspace revision snapshot. Search stays closed until staging and lineage validation complete.</p>
      ) : null}
      {engineState.error ? (
        <p class="context-engine-error" role="alert"><Icon name="warning" size={17} /><span><strong>{engineState.error.code}</strong>{engineState.error.message}</span></p>
      ) : null}

      <form class="context-search" role="search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label for="client-context-query"><span>Hybrid local search</span><small>72% deterministic dense score · 28% lexical overlap</small></label>
        <div>
          <Icon name="context" size={18} />
          <input
            id="client-context-query"
            type="search"
            value={query}
            autoComplete="off"
            spellcheck={false}
            placeholder={engineState.phase === "ready" ? "Search this exact workspace generation…" : "Index refresh must complete first…"}
            disabled={engineState.phase !== "ready" || searchStatus === "searching"}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          {searchStatus === "searching" ? (
            <button type="button" onClick={cancelSearch}><Icon name="stop" size={15} />Cancel</button>
          ) : (
            <button class="primary" type="submit" disabled={!query.trim() || engineState.phase !== "ready"}><Icon name="context" size={15} />Search</button>
          )}
        </div>
        <p class="context-search-status" role="status" aria-live="polite">{searchStatusText(searchStatus, searchResult)}</p>
        {searchError ? <p class="context-search-error" role="alert">{searchError}</p> : null}
      </form>

      <p class="context-injection-disclosure" role="note"><strong>Shared runtime.</strong> This screen, the search_context tool, and automatic turn grounding use the same memory-only generation. Selected turn context is bounded and committed to the session journal with source digests.</p>
      {fabricDriver ? <section class="context-fabric-results" aria-labelledby="context-fabric-title"><div class="context-surface-heading"><div><span>Encrypted segmented routing</span><h2 id="context-fabric-title">Selected context experts</h2></div><span>{fabric.commitment ? `${formatBytes(fabric.commitment.bytesRead)} streamed` : `${fabric.experts.length} routed`}</span></div>{fabric.warnings.map((warning) => <p class="context-recall-warning" role="alert"><Icon name="warning" size={16} />Recall reduced · {warning}</p>)}<div>{fabric.experts.map((expert) => <article key={expert.expertId}><span>{expert.kind}</span><strong>{expert.label}</strong><small>{expert.score.toFixed(3)} relevance · {formatBytes(expert.bytes)} budget</small></article>)}</div>{fabric.commitment ? <details><summary>Retrieval commitment</summary><code>{fabric.commitment.resultDigest}</code><small> generation {fabric.commitment.generation} · {fabric.commitment.complete ? "complete" : "incomplete"}</small></details> : null}</section> : null}
      {stats?.byStatus.failed ? <p class="context-recall-warning" role="alert"><Icon name="warning" size={16} /><span><strong>Recall reduced.</strong> {stats.byStatus.failed} source{stats.byStatus.failed === 1 ? "" : "s"} could not be indexed for this generation.</span></p> : null}

      <div class="client-context-layout">
        <section class="context-surface context-candidates" aria-labelledby="context-candidates-title">
          <div class="context-surface-heading">
            <div><span>Automatic discovery</span><h2 id="context-candidates-title">Vectorization candidates</h2></div>
            <span>{stats ? candidateSummary(stats.byStatus) : "Waiting"}</span>
          </div>
          {generation?.candidates.length ? (
            <div class="context-candidate-list">
              {generation.candidates.map((candidate) => (
                <article class="context-candidate" key={`${candidate.path}:${candidate.revision}`}>
                  <div class="context-candidate-title">
                    <span class={`context-index-state ${candidate.status}`}>{candidate.status}</span>
                    <div><strong>{displayPath(candidate.path)}</strong><small>{candidate.contentType ?? "unsupported"} · {formatBytes(candidate.size)} · {candidate.chunks} chunk{candidate.chunks === 1 ? "" : "s"}</small></div>
                  </div>
                  <p>{candidate.reason}</p>
                  <dl class="context-exact-record">
                    <div><dt>Revision</dt><dd><code>{candidate.revision}</code></dd></div>
                    <div><dt>Content digest</dt><dd><code>{candidate.contentDigest ?? "not produced"}</code></dd></div>
                  </dl>
                  {candidate.chunkIds.length ? (
                    <details class="candidate-chunks">
                      <summary>{candidate.chunkIds.length} exact chunk identifier{candidate.chunkIds.length === 1 ? "" : "s"}</summary>
                      <ol>{candidate.chunkIds.map((chunkId) => <li key={chunkId}><code>{chunkId}</code></li>)}</ol>
                    </details>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <ContextEmpty icon={engineState.phase === "error" ? "warning" : "context"} title={entries.length ? "Index generation pending" : "No workspace files"} body={entries.length ? "The current revision set has not passed staging validation yet." : "Add a supported text or code file to surface the first candidate."} />
          )}
        </section>

        <section class="context-surface context-results" aria-labelledby="context-results-title">
          <div class="context-surface-heading">
            <div><span>Generation-pinned retrieval</span><h2 id="context-results-title">Search hits</h2></div>
            <span>{searchResult ? `${searchResult.hits.length} in ${formatMilliseconds(searchResult.durationMs)}` : "No query"}</span>
          </div>
          {searchResult?.hits.length ? (
            <div class="context-hit-list">
              {searchResult.hits.map((hit, index) => (
                <article class="context-hit" key={hit.chunkId}>
                  <div class="context-hit-heading"><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{displayPath(hit.path)}</strong><small>chunk {hit.chunkIndex} · hybrid {formatScore(hit.score)}</small></div></div>
                  <p>{hit.text}</p>
                  <div class="context-human-route"><span>{humanKind(hit.path)}</span><strong>{whyMatched(hit.denseScore, hit.lexicalScore)}</strong><small>{formatBytes(new TextEncoder().encode(hit.text).byteLength)} retrieved</small></div>
                  <div class="context-score-grid" aria-label="Hybrid score components">
                    <span><small>Dense</small><strong>{formatScore(hit.denseScore)}</strong></span>
                    <span><small>Lexical</small><strong>{formatScore(hit.lexicalScore)}</strong></span>
                    <span><small>Combined</small><strong>{formatScore(hit.score)}</strong></span>
                  </div>
                  <dl class="context-exact-record">
                    <div><dt>Revision</dt><dd><code>{hit.revision}</code></dd></div>
                    <div><dt>Content digest</dt><dd><code>{hit.contentDigest}</code></dd></div>
                    <div><dt>Chunk ID</dt><dd><code>{hit.chunkId}</code></dd></div>
                  </dl>
                </article>
              ))}
            </div>
          ) : searchResult ? (
            <ContextEmpty icon="context" title="No local matches" body="The active flat index returned no candidates for this generation and result limit." />
          ) : (
            <ContextEmpty icon="context" title="Search the active generation" body="Results include exact file revisions, content digests, chunk identifiers, and inspectable dense/lexical scores." />
          )}
          {searchResult ? (
            <dl class="context-query-lineage">
              <div><dt>Query digest</dt><dd><code>{searchResult.queryDigest}</code></dd></div>
              <div><dt>Generation</dt><dd><code>{searchResult.generationDigest}</code></dd></div>
              <div><dt>Completed</dt><dd><time dateTime={searchResult.completedAt}>{searchResult.completedAt}</time></dd></div>
            </dl>
          ) : null}
        </section>
      </div>

      {generation ? (
        <section class="context-lineage" aria-labelledby="context-lineage-title">
          <div class="context-surface-heading"><div><span>Rebuildable local materialization</span><h2 id="context-lineage-title">Index lineage</h2></div><span>Nothing persisted</span></div>
          <dl>
            <div><dt>Generation digest</dt><dd><code>{generation.lineage.generationDigest}</code></dd></div>
            <div><dt>Workspace snapshot</dt><dd><code>{generation.lineage.workspaceSnapshotDigest}</code></dd></div>
            <div><dt>Embedding provider</dt><dd><code>{generation.lineage.embeddingProvider}</code> · {generation.lineage.embeddingDimensions} dimensions</dd></div>
            <div><dt>Extractor</dt><dd><code>{generation.lineage.extractor}</code> · {formatBytes(generation.lineage.maxFileBytes)} per-file ceiling</dd></div>
            <div><dt>Chunker</dt><dd><code>{generation.lineage.chunker}</code> · {generation.lineage.maxChunkCharacters} chars · {generation.lineage.overlapCharacters} overlap</dd></div>
            <div><dt>Index and scoring</dt><dd><code>{generation.lineage.indexFormat}</code> · <code>{generation.lineage.scoring}</code></dd></div>
            <div><dt>Materialized</dt><dd><time dateTime={generation.createdAt}>{generation.createdAt}</time> · sequence {generation.sequence}</dd></div>
            <div><dt>Retention</dt><dd>Page memory only · discarded on teardown · no credential or persistent index state</dd></div>
          </dl>
        </section>
      ) : null}
    </section>
  );
}

function ContextMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "ready" | "error" | "caution" }) {
  return <div class={`context-metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function humanKind(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "rs", "go", "py"].includes(extension ?? "")) return "Code source";
  if (["md", "txt", "rst"].includes(extension ?? "")) return "Document source";
  return "Workspace source";
}

function whyMatched(dense: number, lexical: number): string {
  if (lexical > dense) return "Matched the query’s exact words and nearby terms.";
  if (dense > lexical) return "Matched the query’s broader meaning in this local index.";
  return "Matched both words and local semantic signals.";
}

function ContextEmpty({ icon, title, body }: { icon: "context" | "warning"; title: string; body: string }) {
  return <div class="context-empty"><Icon name={icon} size={24} /><strong>{title}</strong><p>{body}</p></div>;
}

function phaseLabel(phase: ClientContextEngineState["phase"], degraded: boolean): string {
  if (phase === "ready") return degraded ? "Degraded" : "Searchable";
  if (phase === "refreshing") return "Refreshing";
  if (phase === "error") return "Closed";
  if (phase === "disposed") return "Disposed";
  return "Waiting";
}

function candidateSummary(byStatus: Readonly<Record<string, number>>): string {
  const indexed = byStatus.indexed ?? 0;
  const excluded = (byStatus.unsupported ?? 0) + (byStatus["too-large"] ?? 0);
  const failed = byStatus.failed ?? 0;
  return `${indexed} indexed · ${excluded} excluded${failed ? ` · ${failed} failed` : ""}`;
}

function searchStatusText(status: "idle" | "searching" | "cancelled" | "complete", result?: ClientContextSearchResult): string {
  if (status === "searching") return "Searching the active in-memory generation…";
  if (status === "cancelled") return "Search cancelled; no stale result was committed.";
  if (status === "complete" && result) return `${result.hits.length} result${result.hits.length === 1 ? "" : "s"} sealed to ${result.generationDigest}.`;
  return "Search is cancellable and automatically invalidated by a workspace refresh.";
}

function isCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function displayPath(path: string): string {
  return path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function formatMilliseconds(milliseconds: number): string {
  return milliseconds < 1 ? `${milliseconds.toFixed(2)} ms` : `${milliseconds.toFixed(1)} ms`;
}

function formatScore(score: number): string {
  return score.toFixed(3);
}

function embeddingStatus(mode: EmbeddingMode, state: SemanticProviderState | undefined, change: "idle" | "changing"): string {
  if (change === "changing") return mode === "semantic" ? "Returning to bootstrap…" : "Loading the same-origin semantic pack…";
  if (mode === "bootstrap") return "Bootstrap active · no model loaded";
  if (!state || state.phase === "cold") return "Semantic selected · starts on first index operation";
  if (state.phase === "ready") return `${state.backend === "webgpu" ? "WebGPU" : "WASM"} semantic model ready`;
  if (state.phase === "downloading") return state.message ?? "Downloading public model assets…";
  if (state.phase === "loading-worker" || state.phase === "initializing") return state.message ?? "Initializing local semantic inference…";
  if (state.phase === "unavailable" || state.phase === "failed") return `Semantic unavailable · ${state.message ?? "model pack failed"}`;
  return state.phase;
}

function semanticTone(mode: EmbeddingMode, state?: SemanticProviderState): string {
  if (mode === "bootstrap" || !state) return "neutral";
  if (state.phase === "ready") return "ready";
  if (state.phase === "failed" || state.phase === "unavailable") return "error";
  return "working";
}
