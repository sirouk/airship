import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { RETRIEVAL_FLOOR_HEADING, isContextSupersession, type ClientContextCandidate, type ClientContextEngineState, type ClientContextSearchHit, type ClientContextSearchResult } from "../indexing/client-context-engine";
import { getClientContextRuntime } from "../retrieval/client-context-runtime";
import type { WorkspaceEntry, WorkspacePort } from "../workspace/contracts";
import { Icon } from "./icons";
import type { ContextFabricDriver } from "../retrieval/context-driver";
import type { RetrievalCommitment, RoutedExpert } from "../retrieval/contracts";
import type { EmbeddingMode } from "../indexing/semantic-browser-provider";
import type { SemanticProviderState } from "../indexing/semantic-worker-provider";
import type { FederatedMemorySearchState } from "../tools/federated-memory";
import type { ProvenanceRow } from "./provenance-chip";
import "./context-view.css";

export type ContextViewProps = Readonly<{
  workspace: WorkspacePort;
  entries: readonly WorkspaceEntry[];
  dimensions?: number;
  resultLimit?: number;
  fabricDriver?: ContextFabricDriver;
  embedded?: boolean;
  searchQuery?: string;
  sharedSearch?: FederatedMemorySearchState;
  onGenerationChange?: (generationDigest?: string) => void;
  onReady?: () => void;
  /** Opens an indexed source in the editor. Unwired hosts get no button. */
  onOpenFile?: (path: string) => void;
  /**
   * How this view renders a lineage chip.
   *
   * Passed in rather than imported. `<ProvenanceChip>` is a Memory-route
   * module, and a *runtime* import from here would put it in the same lazy
   * chunk group as the graph's kind-visual table and merge the two — the
   * release gate requires that table to remain a chunk of its own, and a
   * bundler-shaped merge is not a reason to move a component. The type crosses
   * the boundary (types are erased); the component does not.
   */
  renderProvenance: (subject: string, rows: readonly ProvenanceRow[]) => ComponentChildren;
  /**
   * Whether the index-status detail starts open.
   *
   * True when this view *is* the destination — arriving at `#context` asks for
   * the index itself, and that landing keeps the five metric cells and both
   * embedding paragraphs on screen exactly as it always has. False when the
   * index is one disclosure inside Memory, where the compact row is the point.
   */
  detailExpanded?: boolean;
}>;

export function ContextView({ workspace, entries, dimensions = 384, resultLimit = 8, fabricDriver, embedded = false, searchQuery, sharedSearch, onGenerationChange, onReady, onOpenFile, renderProvenance, detailExpanded = false }: ContextViewProps) {
  const runtime = useMemo(() => getClientContextRuntime(workspace, { dimensions }), [dimensions, workspace]);
  const [engineState, setEngineState] = useState<ClientContextEngineState>(() => runtime.getState());
  const [embeddingMode, setEmbeddingMode] = useState<EmbeddingMode>(() => runtime.getEmbeddingMode());
  const [semanticState, setSemanticState] = useState<SemanticProviderState | undefined>(() => runtime.getSemanticState());
  const [embeddingChange, setEmbeddingChange] = useState<"idle" | "changing">("idle");
  const [statusExpanded, setStatusExpanded] = useState(detailExpanded);
  const [draftQuery, setDraftQuery] = useState("");
  const [localSearchResult, setLocalSearchResult] = useState<ClientContextSearchResult>();
  const [localSearchStatus, setLocalSearchStatus] = useState<"idle" | "searching" | "cancelled" | "complete">("idle");
  const [localSearchError, setLocalSearchError] = useState<string>();
  const [fabric, setFabric] = useState<Readonly<{ experts: readonly RoutedExpert[]; warnings: readonly string[]; commitment?: RetrievalCommitment }>>({ experts: [], warnings: [] });
  /** How many `CONTEXT_CANDIDATE_PAGE_SIZE` pages of sources the reader asked for. */
  const [candidatePages, setCandidatePages] = useState(1);
  const searchController = useRef<AbortController>();
  const searchSequence = useRef(0);
  const query = searchQuery ?? draftQuery;
  const generationDigest = engineState.generation?.lineage.generationDigest;
  const sharedResult = sharedContextResult(sharedSearch, query, generationDigest);
  const searchResult = searchQuery === undefined ? localSearchResult : sharedResult;
  const searchStatus = searchQuery === undefined
    ? localSearchStatus
    : sharedSearch?.searching ? "searching" : sharedResult ? "complete" : "idle";
  const searchError = searchQuery === undefined
    ? localSearchError
    : sharedSearch?.searching ? undefined : sharedSearch?.status;

  // The mode is no longer fixed at mount: the runtime may derive it from this
  // device's capability probe before the first generation, so it is re-read
  // with every engine state rather than trusted from the initial render.
  useEffect(() => runtime.subscribe((state) => {
    setEngineState(state);
    setEmbeddingMode(runtime.getEmbeddingMode());
  }), [runtime]);
  useEffect(() => runtime.subscribeSemantic(setSemanticState), [runtime]);
  useEffect(() => {
    if (!onReady) return;
    const frame = window.requestAnimationFrame(onReady);
    return () => window.cancelAnimationFrame(frame);
  }, [onReady]);

  useEffect(() => {
    void runtime.updateWorkspace(entries).catch((error: unknown) => {
      if (!isContextSupersession(error)) setLocalSearchError(undefined);
    });
  }, [runtime, entries]);

  useEffect(() => () => {
    searchController.current?.abort(new DOMException("Context view closed.", "AbortError"));
  }, [runtime]);

  useEffect(() => onGenerationChange?.(generationDigest), [generationDigest, onGenerationChange]);
  // A new generation is a different candidate set, so the reader's depth
  // request does not carry over — otherwise a refresh silently remounts every
  // row they had expanded into on the previous one.
  useEffect(() => setCandidatePages(1), [generationDigest]);
  useEffect(() => {
    setLocalSearchResult((current) => current?.generationDigest === generationDigest ? current : undefined);
    if (engineState.phase !== "ready") {
      searchController.current?.abort(new DOMException("The context generation changed.", "AbortError"));
      setLocalSearchStatus("idle");
    }
  }, [engineState.phase, generationDigest]);

  async function search(candidate = query) {
    const normalized = candidate.trim();
    if (!normalized || engineState.phase !== "ready") return;
    const sequence = ++searchSequence.current;
    searchController.current?.abort(new DOMException("A newer search started.", "AbortError"));
    const controller = new AbortController();
    searchController.current = controller;
    setLocalSearchStatus("searching");
    setLocalSearchError(undefined);
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
      setLocalSearchResult(result);
      setLocalSearchStatus("complete");
    } catch (error) {
      if (sequence !== searchSequence.current) return;
      if (isCancellation(error) || isContextSupersession(error)) {
        setLocalSearchStatus("cancelled");
      } else {
        setLocalSearchStatus("idle");
        setLocalSearchError(error instanceof Error ? error.message : "Context search failed.");
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
    setLocalSearchStatus("cancelled");
  }

  /*
   * The floor the engine already applied, read where the counts are spoken.
   *
   * The engine classifies every hit against the posture of the provider that
   * embedded it; this panel stops calling a disqualified row a hit. Both lists
   * render — the disqualified ones under their own heading — so the split is a
   * statement about confidence, never a deletion.
   */
  const confidentHits = searchResult?.hits.filter((hit) => hit.confidence !== "weak") ?? [];
  const weakHits = searchResult?.hits.filter((hit) => hit.confidence === "weak") ?? [];
  const generation = engineState.generation;
  const candidateWindow = useMemo(
    () => contextCandidateWindow(generation?.candidates ?? [], candidatePages),
    [candidatePages, generation?.candidates],
  );
  const stats = generation?.candidateStats;
  const chunks = generation?.chunkStats;
  const indexTone = engineState.phase === "error"
    ? "error"
    : engineState.phase === "ready" && stats?.byStatus.failed
      ? "caution"
      : engineState.phase === "ready" ? "ready" : "neutral";

  async function changeEmbeddingMode(mode: EmbeddingMode) {
    if (mode === embeddingMode || embeddingChange === "changing") return;
    setEmbeddingChange("changing");
    setLocalSearchError(undefined);
    try {
      await runtime.setEmbeddingMode(mode);
      setEmbeddingMode(mode);
      setLocalSearchResult(undefined);
    } catch (error) {
      setEmbeddingMode(runtime.getEmbeddingMode());
      setLocalSearchError(error instanceof Error ? error.message : "The local embedding engine could not be changed.");
    } finally {
      setEmbeddingChange("idle");
    }
  }

  return (
    <section class="client-context-view" aria-labelledby={embedded ? undefined : "client-context-title"} aria-label={embedded ? "Workspace context index" : undefined}>
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

      {/*
        * One status row where 470px of preamble used to stand: an embedding
        * card (eyebrow + H2 + three-line paragraph), a five-cell metric strip,
        * a card restating the search field 1,600px above it, and a shared-
        * runtime note — five eyebrow/heading pairs before a single indexed
        * file appeared. Every one of those strings is still here; the metrics
        * and the two embedding paragraphs are one gesture away, and the state
        * word, the counts and the engine's own live status never were.
        */}
      <div class="context-index-status" role="group" aria-label="Context index status">
        <div class="context-index-status__row">
          <button
            class="context-index-status__toggle"
            type="button"
            aria-expanded={statusExpanded}
            aria-label={`${phaseLabel(engineState.phase, Boolean(stats?.byStatus.failed))}. ${indexSummaryText(stats?.total ?? entries.length, chunks?.total ?? 0, chunks?.vectorBytes, embeddingMode)}. ${statusExpanded ? "Hide" : "Show"} the five index metrics, the embedding engine description, and the shared-runtime note.`}
            onClick={() => setStatusExpanded((value) => !value)}
          >
            <span class={`context-index-status__dot ${indexTone}`} aria-hidden="true" />
            <strong>{phaseLabel(engineState.phase, Boolean(stats?.byStatus.failed))}</strong>
            {/* The counts win the width over the affordance's own label: the
                chevron is the affordance, and its accessible name states both
                the counts and exactly what the panel holds. */}
            <span>{indexSummaryText(stats?.total ?? entries.length, chunks?.total ?? 0, chunks?.vectorBytes, embeddingMode)}</span>
            <i class="context-index-status__chevron" aria-hidden="true" />
          </button>
          <p class="embedding-engine-state" role="status" aria-live="polite">
            <span class={semanticTone(embeddingMode, semanticState)} />
            {embeddingStatus(embeddingMode, semanticState, embeddingChange)}
            {semanticState?.loadedBytes !== undefined ? <small>{formatBytes(semanticState.loadedBytes)}{semanticState.totalBytes ? ` / ${formatBytes(semanticState.totalBytes)}` : ""}</small> : null}
          </p>
          <div class="embedding-engine-actions" role="group" aria-label="Embedding engine">
            <button type="button" class={embeddingMode === "bootstrap" ? "selected" : ""} aria-pressed={embeddingMode === "bootstrap"} disabled={embeddingChange === "changing"} title="Hash vectors keep retrieval immediately available without a model download. They are deterministic test/bootstrap signals, not semantic understanding." onClick={() => void changeEmbeddingMode("bootstrap")}>Bootstrap</button>
            <button type="button" class={embeddingMode === "semantic" ? "selected" : ""} aria-pressed={embeddingMode === "semantic"} disabled={embeddingChange === "changing"} title="The pinned model executes in an isolated browser worker. WebGPU is preferred; WASM is the automatic fallback." onClick={() => void changeEmbeddingMode("semantic")}>Local semantic</button>
          </div>
        </div>

        {/*
          * One line where a 76px card stood.
          *
          * `SHARED MEMORY QUERY / Waiting for a query above` existed only to
          * report that the field 1,600px up the page was being followed, and
          * then said it a second time in a sentence underneath. The sentence
          * is the part that carries a fact, so the sentence is what survives;
          * when a query is running it names the query it is bound to, which
          * the label pair never did.
          */}
        {searchQuery !== undefined ? (
          <p
            class="context-shared-status"
            role="status"
            aria-live="polite"
            /* The label pair this replaced carried the only accessible name for
               the shared-query binding. Keeping the name on the sentence that
               replaced it means the region is still addressable by assistive
               technology and by tests, rather than only findable by its text. */
            aria-label="Shared Memory query in the workspace index"
          >
            {query.trim() ? <b>Following “{query.trim().slice(0, 160)}”</b> : null}
            {managedSearchStatusText(query, engineState.phase, searchStatus, searchResult)}
          </p>
        ) : null}
        {searchQuery !== undefined && searchError ? <p class="context-search-error" role="alert">{searchError}</p> : null}

        {/*
          * The bootstrap caveat is promoted from a paragraph inside a card to
          * a visible caution the moment it is load-bearing: hits are on screen
          * and they were ranked by hash vectors, not by meaning.
          */}
        {embeddingMode === "bootstrap" && searchResult?.hits.length ? (
          <p class="context-bootstrap-caution" role="note">These results were ranked with deterministic test/bootstrap signals, not semantic understanding.</p>
        ) : null}

        {statusExpanded ? (
          <div class="context-index-status__detail">
            <div class="context-live-strip">
              <ContextMetric label="State" value={phaseLabel(engineState.phase, Boolean(stats?.byStatus.failed))} detail={engineState.phase === "refreshing" ? "staging privately" : "memory-only"} tone={engineState.phase === "error" ? "error" : engineState.phase === "ready" && stats?.byStatus.failed ? "caution" : engineState.phase === "ready" ? "ready" : "neutral"} />
              <ContextMetric label="Candidates" value={formatInteger(stats?.total ?? entries.length)} detail={stats ? `${formatBytes(stats.indexedBytes)} indexed` : `${formatInteger(entries.length)} observed`} />
              <ContextMetric label="Chunks" value={formatInteger(chunks?.total ?? 0)} detail={chunks ? `${formatInteger(chunks.documents)} documents` : "awaiting refresh"} />
              <ContextMetric label="Refresh" value={generation ? formatMilliseconds(generation.timing.totalMs) : "—"} detail={generation ? `${formatMilliseconds(generation.timing.indexingMs)} indexing` : "no completed run"} />
              <ContextMetric label="Vector memory" value={chunks ? formatBytes(chunks.vectorBytes) : "—"} detail={generation ? `${generation.lineage.embeddingDimensions} dimensions` : "not allocated"} />
            </div>
            <p class="context-engine-note"><strong>Private embedding engine · {embeddingMode === "semantic" ? "Semantic transformer" : "Deterministic bootstrap"}.</strong> {embeddingMode === "semantic"
              ? "The pinned model executes in an isolated browser worker. WebGPU is preferred; WASM is the automatic fallback. Public model artifacts may be cached, but workspace text and vectors remain page-memory only."
              : "Hash vectors keep retrieval immediately available without a model download. They are deterministic test/bootstrap signals, not semantic understanding."}</p>
            <p class="context-injection-disclosure" role="note"><strong>Shared runtime.</strong> This screen, the search_context tool, and automatic turn grounding use the same memory-only generation. Selected turn context is bounded and committed to the session journal with source digests.</p>
          </div>
        ) : null}
      </div>

      {engineState.phase === "refreshing" ? (
        <p class="context-engine-status" role="status" aria-live="polite"><span />Coalescing the latest workspace revision snapshot. Search stays closed until staging and lineage validation complete.</p>
      ) : null}
      {engineState.error ? (
        <p class="context-engine-error" role="alert"><Icon name="warning" size={17} /><span><strong>{engineState.error.code}</strong>{engineState.error.message}</span></p>
      ) : null}

      {searchQuery !== undefined ? null : (
        <form class="context-search" role="search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <label for="client-context-query"><span>Hybrid local search</span><small>72% deterministic dense score · 28% lexical overlap</small></label>
          <div class="search-field">
            <Icon name="context" size={18} />
            {/*
              * The same one-affordance treatment Memory already had. This field
              * shipped the browser's native `type=search` cross and nothing
              * else: a ~12px target, absent entirely in Firefox, unreachable
              * from a keyboard. Clearing takes the settled result and error with
              * it — leaving hits on screen for a query no longer in the box is
              * the surface disagreeing with itself — and cancels an in-flight
              * search, because "clear" that leaves a request running for the
              * erased query is not what the word says.
              */}
            <span class="search-field__entry">
              <input
                id="client-context-query"
                type="search"
                value={query}
                autoComplete="off"
                spellcheck={false}
                placeholder={engineState.phase === "ready" ? "Search this exact workspace generation…" : "Index refresh must complete first…"}
                disabled={engineState.phase !== "ready" || searchStatus === "searching"}
                onInput={(event) => setDraftQuery(event.currentTarget.value)}
              />
              {query ? (
                <button
                  class="search-field__clear"
                  type="button"
                  aria-label="Clear workspace search"
                  onClick={() => {
                    if (searchStatus === "searching") cancelSearch();
                    setDraftQuery("");
                    setLocalSearchResult(undefined);
                    setLocalSearchError(undefined);
                    setLocalSearchStatus("idle");
                  }}
                ><span aria-hidden="true">✕</span></button>
              ) : null}
            </span>
            {searchStatus === "searching" ? (
              <button type="button" onClick={cancelSearch}><Icon name="stop" size={15} />Cancel</button>
            ) : (
              <button class="primary" type="submit" disabled={!query.trim() || engineState.phase !== "ready"}><Icon name="context" size={15} />Search</button>
            )}
          </div>
          <p class="context-search-status" role="status" aria-live="polite">{searchStatusText(searchStatus, searchResult)}</p>
          {searchError ? <p class="context-search-error" role="alert">{searchError}</p> : null}
        </form>
      )}

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
              {candidateWindow.shown.map((candidate) => (
                <ContextCandidateRow
                  key={`${candidate.path}:${candidate.revision}`}
                  candidate={candidate}
                  generationDigest={generation.lineage.generationDigest}
                  onOpenFile={onOpenFile}
                  renderProvenance={renderProvenance}
                />
              ))}
              {/* The bound, stated where the rows stop. The heading's
                  `candidateSummary` counts every source in the generation, so
                  without this sentence the panel would silently show 100 of
                  10,000 beneath a header saying 10,000 are indexed. */}
              {candidateWindow.bounded ? (
                <div class="context-candidate-bound" role="status">
                  <p>{candidateWindow.sentence}</p>
                  <button
                    class="context-empty__action"
                    type="button"
                    onClick={() => setCandidatePages((value) => value + 1)}
                  >Show {candidateWindow.next.toLocaleString()} more</button>
                </div>
              ) : null}
            </div>
          ) : (
            <ContextEmpty
              icon={engineState.phase === "error" ? "warning" : "context"}
              title={entries.length ? "Index generation pending" : "No workspace files"}
              body={entries.length ? "The current revision set has not passed staging validation yet." : "Add a supported text or code file to surface the first candidate."}
              /* Staging is the engine's own work; offering a button there would
                 name an action the reader does not have. Creating a file is an
                 action they do have, and the workspace is where it is taken. */
              {...(entries.length ? {} : { action: { label: "Open the workspace", onAct: () => { window.location.hash = "#workspace"; } } })}
            />
          )}
        </section>

        <section class="context-surface context-results" aria-labelledby="context-results-title">
          <div class="context-surface-heading">
            <div><span>Generation-pinned retrieval</span><h2 id="context-results-title">Search hits</h2></div>
            <span>{searchResult ? `${confidentHits.length} in ${formatMilliseconds(searchResult.durationMs)}${weakHits.length ? ` · ${weakHits.length} below floor` : ""}` : "No query"}</span>
          </div>
          {confidentHits.length ? (
            <div class="context-hit-list">
              {confidentHits.map((hit, index) => (
                <ContextHitRow
                  key={hit.chunkId}
                  hit={hit}
                  rank={index + 1}
                  generationDigest={searchResult!.generationDigest}
                  onOpenFile={onOpenFile}
                  renderProvenance={renderProvenance}
                />
              ))}
            </div>
          ) : searchResult ? (
            <ContextEmpty
              icon="context"
              title={weakHits.length ? "No confident match" : "No local matches"}
              /* The nearest row and its score, in the panel that would
                 otherwise have counted it as a hit. */
              body={weakHits.length
                ? `Closest: ${displayPath(weakHits[0]!.path)} at ${formatScore(weakHits[0]!.score)} combined — below the floor for this embedding engine. ${candidateSummary(stats?.byStatus ?? {})} in this generation.`
                : `The active flat index returned no candidates for this generation and result limit. ${candidateSummary(stats?.byStatus ?? {})} in this generation.`}
              action={{ label: "Change the query", onAct: () => focusContextQuery(embedded) }}
            />
          ) : (
            <ContextEmpty
              icon="context"
              title="Nothing searched yet"
              body="Results include exact file revisions, content digests, chunk identifiers, and inspectable dense/lexical scores."
              action={{ label: embedded ? "Search memory" : "Search the active generation", onAct: () => focusContextQuery(embedded) }}
            />
          )}
          {/* Shown in every settled state, counted in none: a row the floor
              disqualified is still a row the generation holds, and this panel
              is where its scores and lineage are inspected. */}
          {weakHits.length ? (
            <details class="context-below-floor">
              <summary><span>{RETRIEVAL_FLOOR_HEADING}</span><small>{weakHits.length} row{weakHits.length === 1 ? "" : "s"} · not counted as {weakHits.length === 1 ? "a hit" : "hits"}</small></summary>
              <div class="context-hit-list">
                {weakHits.map((hit, index) => (
                  <ContextHitRow
                    key={hit.chunkId}
                    hit={hit}
                    rank={index + 1}
                    generationDigest={searchResult!.generationDigest}
                    onOpenFile={onOpenFile}
                    renderProvenance={renderProvenance}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </section>
      </div>

      {generation ? (
        <section class="context-lineage" aria-labelledby="context-lineage-title">
          <div class="context-surface-heading"><div><span>Rebuildable local materialization</span><h2 id="context-lineage-title">Index lineage</h2></div><span>Nothing persisted</span></div>
          <dl>
            {/* The query's own lineage folds in here rather than repeating the
                generation digest once per hit and again beneath the hit list:
                these are generation-scoped facts, and this panel is the one
                canonical owner of them. */}
            {searchResult ? <>
              <div><dt>Query digest</dt><dd><code>{searchResult.queryDigest}</code></dd></div>
              <div><dt>Query completed</dt><dd><time dateTime={searchResult.completedAt}>{searchResult.completedAt}</time></dd></div>
            </> : null}
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

/*
 * The four row shapes, constructed locally.
 *
 * Same boundary as `renderProvenance`: these are four one-line data
 * constructors, and importing them would re-create the runtime edge the prop
 * exists to avoid. The union they build is the shared type, so a shape that
 * drifts from `provenance-chip.tsx` fails the typecheck rather than the eye.
 */
const factRow = (label: string, value: string): ProvenanceRow => Object.freeze({ kind: "fact", label, value });
const digestRow = (label: string, value: string): ProvenanceRow => Object.freeze({ kind: "digest", label, value });
const inheritedRow = (label: string, value: string, scope: string): ProvenanceRow => Object.freeze({ kind: "inherited", label, value, scope });
const noteRow = (text: string, tone: "neutral" | "caution" = "neutral"): ProvenanceRow => Object.freeze({ kind: "note", text, tone });

function ContextMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "ready" | "error" | "caution" }) {
  return <div class={`context-metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

/**
 * The four counts the status row carries, in one sentence.
 *
 * They are the same numbers the five metric cards hold; the cards keep their
 * captions and their tone states one gesture away. What the row buys is that
 * "is this thing searchable, over how much, with which engine" reads in one
 * line instead of in a 92px grid under a 175px explanatory card.
 */
export function indexSummaryText(sources: number, chunkCount: number, vectorBytes: number | undefined, mode: EmbeddingMode): string {
  const parts = [
    `${formatInteger(sources)} source${sources === 1 ? "" : "s"}`,
    `${formatInteger(chunkCount)} chunk${chunkCount === 1 ? "" : "s"}`,
  ];
  if (vectorBytes !== undefined) parts.push(formatBytes(vectorBytes));
  parts.push(mode === "semantic" ? "local semantic embeddings" : "bootstrap embeddings");
  return parts.join(" · ");
}

/**
 * Degraded candidates float to the top.
 *
 * A `failed`, `too-large` or `unsupported` row is the one a person has to act
 * on, and it was formatted identically to the healthy ones and sorted by path,
 * so it could sit anywhere in a list of hundreds. Stable within each band.
 */
export function orderCandidates(candidates: readonly ClientContextCandidate[]): readonly ClientContextCandidate[] {
  return Object.freeze([...candidates].sort((left, right) => candidateRank(left) - candidateRank(right)));
}

/**
 * How many candidate rows this panel mounts at once.
 *
 * The measured defect: the list mounted one `<article>` per workspace entry
 * with no ceiling of its own — `repository-import` admits up to 10,000 files
 * (`boundedInteger(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 10_000)`) and the
 * engine's only bound is `MAX_SNAPSHOT_ENTRIES = 250_000` — and every row
 * eagerly mounts a provenance popover, because `Popover` always renders its
 * children. One ordinary GitHub import therefore built ~10,000 `<dl>`s of 8+
 * rows with a copy button apiece: a multi-second freeze on a phone. The
 * upstream cap was deliberately removed on the grounds that "bounding belongs
 * in the consumers that need it" — this is that bound, in this consumer.
 */
export const CONTEXT_CANDIDATE_PAGE_SIZE = 100;

export type ContextCandidateWindow = Readonly<{
  /** The rows actually mounted, degraded-first. */
  shown: readonly ClientContextCandidate[];
  total: number;
  /** True when sources exist that this panel is not drawing. */
  bounded: boolean;
  /** Names both numbers, so the panel never implies it is showing everything. */
  sentence: string;
  /** How many rows the next press would add, at most. */
  next: number;
}>;

/**
 * The bounded slice, and the sentence that admits it is one.
 *
 * `orderCandidates` is applied here rather than at the call site so the cut and
 * the degraded-first rule cannot drift apart: the whole reason a bound is safe
 * is that the rows a person has to act on are the ones that survive it.
 */
export function contextCandidateWindow(
  candidates: readonly ClientContextCandidate[],
  pages: number,
  pageSize: number = CONTEXT_CANDIDATE_PAGE_SIZE,
): ContextCandidateWindow {
  const ordered = orderCandidates(candidates);
  const limit = Math.max(pageSize, pageSize * pages);
  const shown = ordered.slice(0, limit);
  const remaining = ordered.length - shown.length;
  return Object.freeze({
    shown: Object.freeze(shown),
    total: ordered.length,
    bounded: remaining > 0,
    sentence: `Showing ${shown.length.toLocaleString()} of ${ordered.length.toLocaleString()} source${ordered.length === 1 ? "" : "s"}`,
    next: Math.min(pageSize, Math.max(0, remaining)),
  });
}

function candidateRank(candidate: ClientContextCandidate): number {
  if (candidate.status === "failed") return 0;
  if (candidate.status === "too-large" || candidate.status === "unsupported") return 1;
  return 2;
}

/**
 * One 44px row per source, with its lineage filed rather than shouted.
 *
 * Three 100-byte markdown files used to consume 531px of stacked cards, each
 * printing a 36-character revision UUID and a 51-character sha256 in full,
 * plus a separate 28px disclosure for its chunk identifiers, plus the same
 * seven-word reason line once per healthy row.
 */
function ContextCandidateRow({ candidate, generationDigest, onOpenFile, renderProvenance }: Readonly<{
  candidate: ClientContextCandidate;
  generationDigest: string;
  onOpenFile?: (path: string) => void;
  renderProvenance: ContextViewProps["renderProvenance"];
}>) {
  const degraded = candidate.status !== "indexed";
  const rows: ProvenanceRow[] = [
    noteRow(candidate.reason, degraded ? "caution" : "neutral"),
    // The row already prints the workspace-relative path; the chip carries the
    // absolute one by reference rather than restating it.
    inheritedRow("Path", candidate.path, "this row's name"),
    factRow("Content type", candidate.contentType ?? "unsupported"),
    factRow("Size", formatBytes(candidate.size)),
    digestRow("Revision", candidate.revision),
    digestRow("Content digest", candidate.contentDigest ?? "not produced"),
    ...candidate.chunkIds.map((chunkId, index) => digestRow(`Chunk ${index}`, chunkId)),
    inheritedRow("Generation", generationDigest, "this index generation"),
  ];
  return (
    <article class="context-candidate" data-status={candidate.status}>
      <div class="context-candidate__row">
        <span class={`context-index-state ${candidate.status}`}>{candidate.status}</span>
        <strong>{displayPath(candidate.path)}</strong>
        <small>{candidate.contentType ?? "unsupported"} · {formatBytes(candidate.size)} · {candidate.chunks} chunk{candidate.chunks === 1 ? "" : "s"}</small>
        {onOpenFile ? <button class="context-open" type="button" onClick={() => onOpenFile(candidate.path)}>Open in editor</button> : null}
        {renderProvenance(workspaceBaseName(candidate.path), rows)}
      </div>
      {/* A degraded row states its reason where it is, at rest. A healthy row's
          reason is the same seven words on every line, so it files itself. */}
      {degraded ? <p>{candidate.reason}</p> : null}
    </article>
  );
}

/** The characters a hit shows before it offers to show the whole chunk. */
export const CONTEXT_CHUNK_PREVIEW_CHARACTERS = 420;

/**
 * One hit: rank, source, why it matched, the chunk, its lineage.
 *
 * A single measured hit was 627px tall — an unclamped chunk, a three-cell score
 * grid, a three-row exact-record list and a three-row query-lineage list, with
 * `whyMatched()`, the best sentence on the route, buried in the middle at
 * metadata weight. The sentence leads now; the scores and digests are in the
 * chip, where they are also copyable for the first time.
 */
function ContextHitRow({ hit, rank, generationDigest, onOpenFile, renderProvenance }: Readonly<{
  hit: ClientContextSearchHit;
  rank: number;
  generationDigest: string;
  onOpenFile?: (path: string) => void;
  renderProvenance: ContextViewProps["renderProvenance"];
}>) {
  const [expanded, setExpanded] = useState(false);
  const bytes = new TextEncoder().encode(hit.text).byteLength;
  const rows: ProvenanceRow[] = [
    noteRow("72% deterministic dense score · 28% lexical overlap. Hybrid score within this corpus only; never comparable across groups."),
    factRow("Scores", `Dense ${formatScore(hit.denseScore)} · Lexical ${formatScore(hit.lexicalScore)} · Combined ${formatScore(hit.score)}`),
    inheritedRow("Path", hit.path, "this hit's name"),
    factRow("Chunk index", String(hit.chunkIndex)),
    factRow("Retrieved", formatBytes(bytes)),
    digestRow("Revision", hit.revision),
    digestRow("Content digest", hit.contentDigest),
    digestRow("Chunk id", hit.chunkId),
    inheritedRow("Generation", generationDigest, "the Index lineage panel"),
  ];
  return (
    <article class="context-hit">
      <div class="context-hit-heading">
        <span>{String(rank).padStart(2, "0")}</span>
        <strong>{displayPath(hit.path)}</strong>
        <small>chunk {hit.chunkIndex} · hybrid {formatScore(hit.score)} · {formatBytes(bytes)} retrieved</small>
        {onOpenFile ? <button class="context-open" type="button" onClick={() => onOpenFile(hit.path)}>Open in editor</button> : null}
        {renderProvenance(workspaceBaseName(hit.path), rows)}
      </div>
      <p class="context-hit__why" data-confidence={hit.confidence}><span>{humanKind(hit.path)}</span>{whyMatched(hit)}</p>
      <p class="context-hit__chunk" data-expanded={expanded ? "true" : "false"}>{hit.text}</p>
      {hit.text.length > CONTEXT_CHUNK_PREVIEW_CHARACTERS ? (
        <button class="context-hit__more" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : `Show the whole chunk (${formatBytes(bytes)})`}
        </button>
      ) : null}
    </article>
  );
}

function humanKind(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "rs", "go", "py"].includes(extension ?? "")) return "Code source";
  if (["md", "txt", "rst"].includes(extension ?? "")) return "Document source";
  return "Workspace source";
}

/**
 * The row's own sentence about why it is here — including when it should not be.
 *
 * "Matched the query’s broader meaning in this local index" was printed over a
 * hash-collision score of 0.046 for a query the file does not contain. A row the
 * engine disqualified states the disqualifying fact instead of a match claim.
 */
function whyMatched(hit: Pick<ClientContextSearchHit, "denseScore" | "lexicalScore" | "confidence" | "weakBecause">): string {
  if (hit.confidence === "weak") return hit.weakBecause ?? "Below the confidence floor for this embedding engine: the nearest row, not a match.";
  if (hit.lexicalScore > hit.denseScore) return "Matched the query’s exact words and nearby terms.";
  if (hit.denseScore > hit.lexicalScore) return "Matched the query’s broader meaning in this local index.";
  return "Matched both words and local semantic signals.";
}

/**
 * An empty panel that ends in something to press.
 *
 * Every state on this route was accurate and terminal: "Search the active
 * generation" describes what would happen if the reader found the field, which
 * on the embedded surface is 1,600px above and on the standalone surface is
 * below the panel doing the describing. The action is optional because a state
 * with no honest action — an index that has not finished staging — must not
 * grow a button that pretends otherwise.
 */
function ContextEmpty({ icon, title, body, action }: {
  icon: "context" | "warning";
  title: string;
  body: string;
  action?: Readonly<{ label: string; onAct: () => void }>;
}) {
  return (
    <div class="context-empty">
      <Icon name={icon} size={24} />
      <strong>{title}</strong>
      <p>{body}</p>
      {action ? <button class="context-empty__action" type="button" onClick={action.onAct}>{action.label}</button> : null}
    </div>
  );
}

/**
 * Puts the caret in the field this panel is describing.
 *
 * The embedded index is driven by the Memory route's own search box, so the
 * only honest destination is that box — not a second field, which is the thing
 * this surface deliberately does not have.
 */
function focusContextQuery(embedded: boolean): void {
  const field = document.getElementById(embedded ? "memory-query-input" : "client-context-query");
  if (!(field instanceof HTMLInputElement)) return;
  field.scrollIntoView({ block: "center" });
  field.focus();
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
  if (status === "complete" && result) return `${resultCountText(result)} sealed to ${result.generationDigest}.`;
  return "Search is cancellable and automatically invalidated by a workspace refresh.";
}

/**
 * How many hits a status line may claim.
 *
 * The count is of rows that cleared the floor; rows below it are reported
 * separately in the same breath rather than folded into the number, which is
 * how "1 result" came to stand for a hash collision.
 */
function resultCountText(result: ClientContextSearchResult, noun = "result"): string {
  const confident = result.hits.filter((hit) => hit.confidence !== "weak").length;
  const weak = result.hits.length - confident;
  return `${confident} ${noun}${confident === 1 ? "" : "s"}${weak ? ` · ${weak} below the confidence floor` : ""}`;
}

function sharedContextResult(state: FederatedMemorySearchState | undefined, query: string, generationDigest?: string): ClientContextSearchResult | undefined {
  const result = state?.result;
  if (!result || state.query !== query.trim()) return undefined;
  const workspace = result.groups[2];
  if (!generationDigest || workspace.generationDigest !== generationDigest) return undefined;
  return {
    query: result.query,
    queryDigest: result.queryDigest,
    generationDigest: workspace.generationDigest,
    workspaceSnapshotDigest: workspace.workspaceSnapshotDigest,
    durationMs: workspace.durationMs,
    completedAt: workspace.completedAt,
    hits: workspace.hits,
  };
}

function managedSearchStatusText(
  query: string,
  phase: ClientContextEngineState["phase"],
  status: "idle" | "searching" | "cancelled" | "complete",
  result?: ClientContextSearchResult,
): string {
  if (!query.trim()) return "The index stays ready while the shared query is empty.";
  if (phase !== "ready") return "The query will run when the current workspace generation becomes searchable.";
  if (status === "searching") return "Searching the active in-memory generation with the query above…";
  if (status === "complete" && result) return `${resultCountText(result, "index result")} sealed to ${result.generationDigest}.`;
  return "The shared query is ready to run against this exact workspace generation.";
}

function isCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** The file's own name, for a chip heading that has to fit beside a row. */
function workspaceBaseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
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
