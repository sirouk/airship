import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  MemoryGraphRenderer,
  deriveMemoryRelationshipGraph,
  type MemoryNodeKind,
  type MemoryRelationshipGraph,
} from "../memory-graph";
import type { ProfileCatalog } from "../profiles/catalog";
import type { ProfileRevision } from "../profiles/domain";
import type { WorkspaceEntry, WorkspacePort } from "../workspace/contracts";
import type { FederatedMemoryResult, FederatedMemorySearchState } from "../tools/federated-memory";
import { ContextView } from "./context-route";
import { Icon } from "./icons";
import { MemoryKindLegend } from "./memory-controls";
import { groupMemoryRelationships } from "./memory-relationships";
import { messagePlainText, type MessagePart } from "./chat/message-parts";
import { RouteHeader } from "./route-header";
import { Seal } from "./seal";
import {
  ProvenanceChip,
  provenanceDigest,
  provenanceFact,
  provenanceInherited,
  provenanceNote,
  provenanceTail,
  type ProvenanceRow,
} from "./provenance-chip";
import "./memory-view.css";

export type MemoryViewMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
  parts?: readonly MessagePart[];
}>;

/**
 * The thing a result came from, named in the terms of the surface that owns it.
 *
 * A memory hit that cannot reach its source is a citation without a reference.
 * `message` is reachable from this file alone — the searched journal is the
 * live conversation — so it is handled here; `memory` and `file` need the
 * workspace reader the shell owns, so they are only offered when a host wires
 * them. A destination is never labelled before it is bound.
 */
export type MemorySourceTarget =
  | Readonly<{ kind: "message"; sessionId: string; eventId: string }>
  | Readonly<{ kind: "memory"; recordId: string; path: string }>
  | Readonly<{ kind: "file"; path: string }>;

export type MemoryViewProps = Readonly<{
  sessionId?: string;
  messages: readonly MemoryViewMessage[];
  files: readonly WorkspaceEntry[];
  catalog: ProfileCatalog;
  activeProfile: ProfileRevision;
  workspace?: WorkspacePort;
  searchMemory: (query: string, signal: AbortSignal) => Promise<FederatedMemoryResult>;
  initialTab: "search" | "index";
  /** Opens a hit's source. Unwired hosts get no button rather than a dead one. */
  onOpenSource?: (target: MemorySourceTarget) => void;
}>;

export type MemoryPresentationState = Readonly<{
  query: string;
  relationshipsExpanded: boolean;
  indexExpanded: boolean;
  indexMounted: boolean;
}>;

/** Page-memory presentation state, partitioned by workspace, Profile, and conversation. */
export class ProfileScopedMemoryPageStore {
  private readonly workspaces = new WeakMap<WorkspacePort, Map<string, MemoryPresentationState>>();

  read(workspace: WorkspacePort, profileId: string, sessionId?: string): MemoryPresentationState | undefined {
    return this.workspaces.get(workspace)?.get(memoryPresentationScope(profileId, sessionId));
  }

  write(
    workspace: WorkspacePort,
    profileId: string,
    sessionId: string | undefined,
    state: MemoryPresentationState,
  ): void {
    const scopes = this.workspaces.get(workspace) ?? new Map<string, MemoryPresentationState>();
    scopes.set(memoryPresentationScope(profileId, sessionId), Object.freeze({ ...state }));
    this.workspaces.set(workspace, scopes);
  }
}

const MEMORY_PRESENTATIONS = new ProfileScopedMemoryPageStore();

/** Where the profile lane's records are actually stored, stated once. */
const PROFILE_MEMORY_PATH = "/workspace/.airship/memory.json";

/**
 * Derived `term` nodes start hidden.
 *
 * Measured after one real turn: 189 nodes of which 173 (92%) were derived
 * terms drawn as unlabelled grey dots, burying the 16 entities a person came
 * to look at. The picture is filtered; the memory is not — every term stays in
 * the graph, stays counted in the Nodes metric, stays searchable, and is one
 * legend click away. The legend says so, in words, under the canvas.
 */
const DEFAULT_HIDDEN_KINDS: readonly MemoryNodeKind[] = Object.freeze(["term"]);

function memoryPresentationScope(profileId: string, sessionId?: string): string {
  return `${memoryIdentitySegment(profileId, "Profile ID")}.${memoryIdentitySegment(sessionId ?? "no-session", "Session ID")}`;
}

function memoryIdentitySegment(value: string, label: string): string {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid for Memory presentation state.`);
  }
  const points = [...value];
  return `${String(points.length)}-${points.map((point) => point.codePointAt(0)!.toString(16)).join("-")}`;
}

/** Heavy graph derivation stays behind the Memory route boundary. */
export function MemoryView({
  sessionId,
  messages,
  files,
  catalog,
  activeProfile,
  workspace,
  searchMemory,
  initialTab,
  onOpenSource,
}: MemoryViewProps) {
  const restoredPresentation = workspace
    ? MEMORY_PRESENTATIONS.read(workspace, activeProfile.profileId, sessionId)
    : undefined;
  const [query, setQuery] = useState(restoredPresentation?.query ?? "");
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [hiddenMemoryKinds, setHiddenMemoryKinds] = useState<ReadonlySet<MemoryNodeKind>>(() => new Set(DEFAULT_HIDDEN_KINDS));
  const [hiddenMemoryNodeIds, setHiddenMemoryNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [relationshipLimit, setRelationshipLimit] = useState(18);
  const [relationshipsExpanded, setRelationshipsExpanded] = useState(
    initialTab === "index" ? false : restoredPresentation?.relationshipsExpanded ?? true,
  );
  const [indexExpanded, setIndexExpanded] = useState(
    initialTab === "index" ? true : restoredPresentation?.indexExpanded ?? false,
  );
  const [indexMounted, setIndexMounted] = useState(
    initialTab === "index" || restoredPresentation?.indexMounted === true,
  );
  const [contextGeneration, setContextGeneration] = useState<string>();
  const presentationRef = useRef<MemoryPresentationState>({
    query,
    relationshipsExpanded,
    indexExpanded,
    indexMounted,
  });
  const priorInitialTab = useRef(initialTab);
  presentationRef.current = { query, relationshipsExpanded, indexExpanded, indexMounted };
  const indexRef = useRef<HTMLDetailsElement>(null);
  const alignIndex = useCallback(() => indexRef.current?.scrollIntoView({ block: "start" }), []);
  const workspaceAuthority = indexMounted ? contextGeneration : files;
  const memoryAuthority = useMemo(() => ({}), [activeProfile, catalog, messages, sessionId, workspaceAuthority]);
  const memorySearch = useFederatedMemorySearch(query, searchMemory, memoryAuthority, !indexMounted || Boolean(contextGeneration));
  const graph = useMemo(() => {
    return deriveMemoryRelationshipGraph({
      sessions: sessionId ? [{
        id: sessionId,
        title: `${activeProfile.name} session`,
        profileId: activeProfile.profileId,
        skillIds: effectiveSkillIds(activeProfile, catalog),
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.parts?.length ? messagePlainText(message.parts) : message.content,
          profileId: activeProfile.profileId,
          skillIds: effectiveSkillIds(activeProfile, catalog),
        })),
      }] : [],
      workspaceFiles: files,
      profiles: catalog.profiles.map((profile) => ({
        id: profile.profileId,
        name: profile.name,
        role: profile.description,
        prompt: profile.systemPrompt,
        skillIds: effectiveSkillIds(profile, catalog),
      })),
      skills: catalog.skills.map((skill) => ({
        id: skill.skillId,
        name: skill.name,
        description: skill.description,
        profileIds: catalog.profiles
          .filter((profile) => effectiveSkillIds(profile, catalog).includes(skill.skillId))
          .map((profile) => profile.profileId),
        sessionIds: sessionId && effectiveSkillIds(activeProfile, catalog).includes(skill.skillId) ? [sessionId] : [],
      })),
    });
  }, [activeProfile, catalog, files, messages, sessionId]);
  useEffect(() => {
    const changed = priorInitialTab.current !== initialTab;
    priorInitialTab.current = initialTab;
    if (initialTab === "index") {
      setIndexExpanded(true);
      setIndexMounted(true);
      // A deep link to the Index asks for the Index. Collapsing the graph
      // disclosure is what lets the requested section actually reach the top
      // of the scroller now that the route is a third of its former height —
      // and it is one click from being open again, which is the disclosure
      // model doing its job rather than a section being taken away.
      setRelationshipsExpanded(false);
      const frame = window.requestAnimationFrame(alignIndex);
      return () => window.cancelAnimationFrame(frame);
    } else if (changed) {
      setRelationshipsExpanded(true);
    }
  }, [alignIndex, initialTab]);
  useEffect(() => () => {
    if (!workspace) return;
    MEMORY_PRESENTATIONS.write(
      workspace,
      activeProfile.profileId,
      sessionId,
      presentationRef.current,
    );
  }, [workspace, activeProfile.profileId, sessionId]);
  useEffect(() => setRelationshipLimit(18), [selectedNodeId]);
  const normalizedQuery = query.trim();
  const starters = useMemo(() => memoryStarters(files, activeProfile.name, graph), [activeProfile.name, files, graph]);
  const graphResults = normalizedQuery ? graph.search(normalizedQuery, { limit: 12 }) : [];
  const selectedNode = selectedNodeId ? graph.getNode(selectedNodeId) : undefined;
  const selectedEdges = selectedNodeId ? graph.getIncidentEdges(selectedNodeId) : [];
  const relationshipGroups = groupMemoryRelationships(selectedEdges, relationshipLimit);
  const truncationCount = Object.values(graph.stats.truncated).reduce((total, value) => total + value, 0);
  const hiddenTermCount = hiddenMemoryKinds.has("term") ? graph.stats.nodesByKind.term ?? 0 : 0;
  const selectMemoryNode = (nodeId: string | undefined) => {
    if (nodeId) setHiddenMemoryNodeIds((current) => {
      if (!current.has(nodeId)) return current;
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
    setSelectedNodeId(nodeId);
  };
  const openIndex = (open: boolean) => {
    setIndexExpanded(open);
    if (open) setIndexMounted(true);
  };
  const revealGraphMatches = () => {
    setRelationshipsExpanded(true);
    setHiddenMemoryKinds((current) => {
      // A query that matches a hidden kind must not look like it matched
      // nothing: revealing the kind is the honest response to "show them".
      const next = new Set(current);
      for (const result of graphResults) next.delete(result.node.kind);
      return next;
    });
    window.requestAnimationFrame(() => {
      scrollToMemorySection("memory-relationships");
      if (graphResults[0]) selectMemoryNode(graphResults[0].node.id);
    });
  };

  return (
    <section class="work-view memory-view" aria-labelledby="memory-title">
      <RouteHeader
        routeId="memory"
        density="tool"
        title="Memory"
        headingId="memory-title"
        eyebrow={"Private recall & on-device retrieval"}
        description="One private query across conversation, profile memory, workspace index, and typed relationships."
        status={<Seal state="none" density="chip" label="Private · on-device" detail="Recall, ranking and graph derivation all run inside this browser tab." />}
        notes={<>
          <p>Updates every loaded scope. Each corpus keeps its own scores.</p>
          <p>The agent and interface share one revision-checked service; each corpus keeps independent scores.</p>
          <p>Recall follows the selected storage mode. Remote Vaults can serve encrypted ranges; Local Device and Ephemeral keep recall on-device. Routing and ranking stay in-browser, and this graph derives only from current page inputs.</p>
        </>}
      />

      <form class="memory-query" role="search" onSubmit={(event) => {
        event.preventDefault();
        if (graphResults[0]) {
          setRelationshipsExpanded(true);
          selectMemoryNode(graphResults[0].node.id);
        }
      }}>
        <label class="sr-only" for="memory-query-input">Search every memory surface</label>
        <div>
          <Icon name="memory" size={18} />
          <input
            id="memory-query-input"
            type="search"
            value={query}
            autoComplete="off"
            spellcheck={false}
            aria-describedby="memory-query-help"
            aria-controls="memory-results memory-relationships memory-index"
            placeholder="Search memory"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          {query ? <button type="button" aria-label="Clear memory query" onClick={() => setQuery("")}><span aria-hidden="true">✕</span></button> : null}
        </div>
        {/*
          * The enumeration the placeholder used to carry, which clipped
          * mid-word at 834px and 430px. It is the field's description, so it
          * is read on focus rather than half-shown forever.
          */}
        <p id="memory-query-help" class="sr-only">Searches conversation, profile memory, workspace index, relationships, and the local index. Updates every loaded scope. Each corpus keeps its own scores.</p>
      </form>

      {/*
        * The Recall/Graph/Index strip that stood here restated three counts the
        * sections below already state, and jumped to headings that are one
        * scroll away on the same page. Search leads instead. Every count it
        * carried is still on its own section: the three scope cards are the
        * scopes, the relationship graph reports its nodes and edges, and the
        * Index disclosure reports its workspace sources.
        */}

      <FederatedMemorySearch
        state={memorySearch}
        graphMatchCount={graphResults.length}
        onShowGraphMatches={revealGraphMatches}
        onOpenSource={onOpenSource}
        starters={starters}
        onStart={setQuery}
      />

      <details
        id="memory-relationships"
        class="memory-disclosure"
        open={relationshipsExpanded}
        onToggle={(event) => setRelationshipsExpanded(event.currentTarget.open)}
      >
        <summary>
          <span><Icon name="memory" size={18} /><span><small>Typed relationship graph</small><strong>Explore remembered relationships</strong></span></span>
          {/* Number and unit are separate elements so the phone can shed the
              unit into the accessibility tree instead of deleting the fact —
              `font-size: 0` used to remove both below 620px. */}
          <span class="memory-summary-meta"><b>{normalizedQuery ? graphResults.length : graph.stats.edgeCount}</b><small>{normalizedQuery ? `graph match${graphResults.length === 1 ? "" : "es"}` : "relationships"}</small><i aria-hidden="true" /></span>
        </summary>
        <div class="memory-disclosure-body">
          {/*
            * The sole rendering of these four counts on the route. The top
            * strip that stated "152 nodes" beside a bottom strip stating
            * "Relationships 647" is gone, so the contradiction the two strips
            * produced cannot recur, and each caption is the cell's own
            * provenance, verbatim.
            *
            * These are the shipped `.metric` cells rather than <MetricStrip>:
            * `metric-strip.tsx` is imported by `billing-view`, which lives in
            * the deferred-capabilities chunk, so importing it here too would
            * merge `memory-graph/kind-visual` into a shared chunk and the
            * release gate requires that chunk by name. Same three slots, same
            * strings; the swap is the primitive owner's to make once the
            * chunk map allows it.
            */}
          <div class="memory-metrics" role="group" aria-label="Relationship graph statistics">
            <div class="metric"><span>Nodes</span><strong>{graph.stats.nodeCount}</strong><small>real page inputs + derived terms</small></div>
            <div class="metric"><span>Relationships</span><strong>{graph.stats.edgeCount}</strong><small>typed, bounded edges</small></div>
            <div class="metric"><span>Components</span><strong>{graph.stats.componentCount}</strong><small>current relationship islands</small></div>
            <div class="metric"><span>Density</span><strong>{formatGraphDensity(graph)}</strong><small>not vector similarity</small></div>
          </div>
          {/*
            * Neutral by default. Bounding is how this view is *designed* to
            * work, so amber on an untouched screen reads as a failure where
            * nothing has failed. Caution is reserved for the case where the
            * user has hidden something, which is the only state where a
            * warning colour tells them something they did not choose.
            */}
          <div class={hiddenMemoryNodeIds.size ? "memory-boundary attention" : "memory-boundary"} role="status">
            <strong>{hiddenMemoryNodeIds.size ? "Bounded view · you hid nodes" : "Bounded relationship view"}</strong>
            <span>{truncationCount ? `Showing ${graph.stats.nodeCount} of ${graph.stats.nodeCount + truncationCount} items — this view is bounded on purpose (${truncationCount} source/derived items exceeded bounds). ` : "Within derivation bounds. "}{graph.stats.isolatedNodeCount} isolated · max degree {graph.stats.maxDegree} · {hiddenMemoryNodeIds.size} hidden · rev {graph.revision.slice(-9)}.</span>
          </div>
          <div class="memory-shell">
            <div class="memory-graph-panel panel">
              <div class="memory-toolbar">
                <div class="memory-graph-query">
                  <span role="status" aria-live="polite">{normalizedQuery ? `Graph matches for “${normalizedQuery}”` : "Graph follows the shared query"}</span>
                  {normalizedQuery ? (
                    graphResults.length ? <div aria-label="Matching relationship nodes">{graphResults.map((result) => <button key={result.node.id} type="button" aria-pressed={selectedNodeId === result.node.id} onClick={() => selectMemoryNode(result.node.id)}><span>{result.node.kind}</span>{result.node.label}</button>)}</div>
                      : <p>No relationship nodes match this query.</p>
                  ) : <p>Enter a query above to find and focus matching nodes.</p>}
                </div>
              </div>
              <MemoryGraphRenderer graph={graph} hiddenKinds={hiddenMemoryKinds} hiddenNodeIds={hiddenMemoryNodeIds} selectedNodeId={selectedNodeId} onSelect={(selection) => selectMemoryNode(selection?.focus?.id)} class="memory-canvas" minHeight={470} ariaLabel="Interactive memory relationship graph" />
              <MemoryKindLegend counts={graph.stats.nodesByKind} hidden={hiddenMemoryKinds} onToggle={(kind) => setHiddenMemoryKinds((current) => { const next = new Set(current); next.has(kind) ? next.delete(kind) : next.add(kind); return next; })} />
              <p class="memory-filter-note">{hiddenTermCount
                ? `${hiddenTermCount} derived terms are hidden from the picture. They are still in the graph, still searchable, and still counted above. Filters never alter memory.`
                : "Filters never alter memory."}</p>
            </div>
            <aside class="memory-detail panel" aria-labelledby="memory-inspector-title">
              {/*
                * The state slot of a heading holds a state.
                * "select a node" was an instruction filed where the reader
                * looks for what is currently true, and it was still there
                * while the panel below already offered five nodes to press.
                */}
              <div class="panel-heading"><span id="memory-inspector-title">Relationship inspector</span><span>{selectedNode ? selectedNode.kind : "nothing selected"}</span></div>
              {selectedNode ? (
                <div class="memory-node-detail">
                  <span class="eyebrow">{selectedNode.kind}</span>
                  <h2>{selectedNode.label}</h2>
                  <p>{selectedNode.summary || "This node has no additional summary."}</p>
                  <button class="small-button" type="button" onClick={() => { setHiddenMemoryNodeIds((current) => new Set(current).add(selectedNode.id)); setSelectedNodeId(undefined); }}>Hide from view</button>
                  <dl>{Object.entries(selectedNode.metadata).slice(0, 8).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
                  <h3>{selectedEdges.length} relationships</h3>
                  <div class="relationship-groups">{relationshipGroups.map((group) => <section key={group.kind} aria-labelledby={`relationship-${group.kind}`}><h4 id={`relationship-${group.kind}`}>{group.label}<small>{group.edges.length} shown · {group.total} total</small></h4><div class="relationship-list">{group.edges.map((edge) => {
                    const neighborId = edge.source === selectedNode.id ? edge.target : edge.source;
                    const neighbor = graph.getNode(neighborId);
                    return <button key={edge.id} type="button" onClick={() => selectMemoryNode(neighborId)}><span>{edge.label}</span><strong>{neighbor?.label ?? neighborId}</strong></button>;
                  })}</div></section>)}</div>
                  {selectedEdges.length > relationshipLimit ? <button class="small-button" type="button" onClick={() => setRelationshipLimit((value) => Math.min(selectedEdges.length, value + 18))}>Showing {relationshipLimit} of {selectedEdges.length} · show 18 more</button> : null}
                </div>
              ) : (
                /*
                 * The 587px "Select an idea" placeholder became the launcher
                 * for the interaction it was only describing. Nothing invited
                 * the first click; the most connected nodes now do.
                 */
                <div class="memory-overview">
                  {/* Deliberately no stats here: the four counts are stated
                      once, in the strip above the canvas. This panel's job is
                      to make the first click obvious, which is the one thing
                      the "Select an idea" placeholder never did. */}
                  <h2>This graph</h2>
                  <h3>Most connected</h3>
                  <div class="memory-overview__nodes">
                    {mostConnectedNodes(graph, hiddenMemoryKinds).map((entry) => (
                      <button key={entry.id} type="button" onClick={() => selectMemoryNode(entry.id)}>
                        <span>{entry.kind}</span><strong>{entry.label}</strong><small>{entry.degree} links</small>
                      </button>
                    ))}
                  </div>
                  <p>Pan, zoom, search, or select a node to inspect relationships and source metadata.</p>
                </div>
              )}
            </aside>
          </div>
        </div>
      </details>

      <details
        ref={indexRef}
        id="memory-index"
        class="memory-disclosure memory-index-disclosure"
        open={indexExpanded}
        onToggle={(event) => openIndex(event.currentTarget.open)}
      >
        <summary>
          <span><Icon name="context" size={18} /><span><small>Revision-bound local materialization</small><strong>Index health, candidates, hits, and lineage</strong></span></span>
          <span class="memory-summary-meta">{workspace ? <><b>{files.length}</b><small>workspace source{files.length === 1 ? "" : "s"}</small></> : <small>Workspace unavailable</small>}<i aria-hidden="true" /></span>
        </summary>
        <div class="memory-disclosure-body">
          {indexMounted ? workspace
            ? <ContextView workspace={workspace} entries={files} embedded searchQuery={query} sharedSearch={memorySearch} renderProvenance={(subject, rows) => <ProvenanceChip subject={subject} rows={rows} />} onGenerationChange={setContextGeneration} onReady={initialTab === "index" ? alignIndex : undefined} detailExpanded={initialTab === "index"} onOpenFile={onOpenSource ? (path) => onOpenSource({ kind: "file", path }) : undefined} />
            : <section class="empty-state"><Icon name="context" /><h2>Index unavailable</h2><p>The browser workspace is not ready, so indexing did not start.</p></section>
            : <p class="memory-deferred-note" role="status">Open to load on-device indexing. Source files remain unchanged.</p>}
        </div>
      </details>
    </section>
  );
}

function useFederatedMemorySearch(query: string, search: MemoryViewProps["searchMemory"], authority: object, enabled: boolean): FederatedMemorySearchState {
  const [state, setState] = useState<FederatedMemorySearchState>({ authority, query: "", searching: false });
  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setState({ authority, query: "", searching: false });
      return;
    }
    if (!enabled) {
      setState({ authority, query: normalized, status: "Waiting for the revision-bound index…", searching: true });
      return;
    }
    setState({ authority, query: normalized, status: "Searching three client-owned agent corpora…", searching: true });
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void search(normalized, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setState({ authority, query: normalized, result: next, searching: false });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setState({ authority, query: normalized, status: error instanceof Error ? error.message : String(error), searching: false });
        });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort(new DOMException("Memory query superseded.", "AbortError"));
    };
  }, [authority, enabled, query, search]);
  return state.authority === authority && state.query === query.trim()
    ? state
    : { authority, query: query.trim(), searching: Boolean(query.trim()) };
}

/** Total hits across the three lanes, for the scope rail's honest count. */
function memoryHitTotal(state: FederatedMemorySearchState): number {
  return state.result?.groups.reduce((total, group) => total + group.hits.length, 0) ?? 0;
}

type MemoryLaneView = Readonly<{
  id: "conversation" | "profile" | "workspace";
  title: string;
  count: number;
  /** One sentence naming exactly what this lane consulted. */
  searched: string;
  provenance: readonly ProvenanceRow[];
  hits: ComponentChildren;
}>;

function FederatedMemorySearch({ state, graphMatchCount, onShowGraphMatches, onOpenSource, starters, onStart }: Readonly<{
  state: FederatedMemorySearchState;
  graphMatchCount: number;
  onShowGraphMatches: () => void;
  onOpenSource?: MemoryViewProps["onOpenSource"];
  starters: readonly MemoryStarter[];
  onStart: (query: string) => void;
}>) {
  const result = state.result;
  const sessionId = result?.authority.sessionId;
  const lanes: readonly MemoryLaneView[] = [
    conversationLane(result, sessionId, onOpenSource),
    profileLane(result, onOpenSource),
    workspaceLane(result, onOpenSource),
  ];
  const total = lanes.reduce((sum, lane) => sum + lane.count, 0);
  const settled = Boolean(state.query) && !state.searching && Boolean(result);
  return <section id="memory-results" class="memory-federated" aria-labelledby="memory-search-title">
    {/*
      * "Federated client recall" and "Results across private scopes" name a
      * region whose visible label is the scope rail above it — so they name it
      * in the accessibility tree instead of spending 104px restating it.
      */}
    <h2 id="memory-search-title" class="sr-only">Federated client recall · Results across private scopes</h2>
    <p class="memory-search-status" role={state.status && !state.searching ? "alert" : "status"} aria-live="polite">{state.status ?? (state.query ? "Search complete · results pinned to reported revisions." : "Ready for a private on-device query.")}</p>
    {/*
      * The unsearched state used to be three empty boxes and one sentence
      * reporting that nothing had happened. The three scope headers stay —
      * they are the route's structural claim about where it looks — and the
      * dead end below them becomes the one thing there is to do, built from
      * terms this page can already prove it holds.
      */}
    {!state.query && starters.length ? <MemoryStarters starters={starters} onStart={onStart} /> : null}
    {settled && total === 0
      ? <MemoryNoMatchPanel query={state.query} lanes={lanes} graphMatchCount={graphMatchCount} onShowGraphMatches={onShowGraphMatches} />
      : <div class="memory-result-lanes">
        {lanes.map((lane) => <MemorySearchLane key={lane.id} lane={lane} query={state.query} searching={state.searching} />)}
      </div>}
  </section>;
}

export type MemoryStarter = Readonly<{
  /** The exact string the field is filled with. */
  term: string;
  /** Where this page got the term. Never "popular" or "recent" — nothing tracks either. */
  origin: string;
}>;

/**
 * Search terms this page can prove it holds.
 *
 * A suggestion is a claim about the corpus, so every one of these is read out
 * of live state at render time: an indexed workspace source, the pinned
 * profile, and the most connected idea in the derived graph. Nothing here is a
 * search history — none is kept — and each button says which of the three it
 * came from, so pressing it is a statement about the data, not a guess.
 */
export function memoryStarters(
  files: readonly WorkspaceEntry[],
  profileName: string,
  graph: MemoryRelationshipGraph,
  /** As many as fit one row without the strip becoming a menu. */
  limit = 4,
): readonly MemoryStarter[] {
  const seen = new Set<string>();
  const starters: MemoryStarter[] = [];
  const push = (term: string, origin: string) => {
    const trimmed = term.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || trimmed.length > 48 || seen.has(key) || starters.length >= limit) return;
    seen.add(key);
    starters.push(Object.freeze({ term: trimmed, origin }));
  };
  for (const file of files) {
    const base = file.path.slice(file.path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    push(dot > 0 ? base.slice(0, dot) : base, "workspace source");
  }
  push(profileName, "active profile");
  for (const node of mostConnectedNodes(graph, new Set(), limit)) {
    push(node.label, `most connected ${node.kind}`);
  }
  return Object.freeze(starters);
}

function MemoryStarters({ starters, onStart }: Readonly<{ starters: readonly MemoryStarter[]; onStart: (query: string) => void }>) {
  return (
    <div class="memory-starters">
      <p>Nothing searched yet. Each term below is read from this page's own index, profile and graph; no search history is kept.</p>
      <div>
        {starters.map((starter) => (
          <button
            key={starter.term}
            type="button"
            aria-label={`Search memory for ${starter.term}, from this page's ${starter.origin}`}
            onClick={() => onStart(starter.term)}
          ><strong>{starter.term}</strong><small>{starter.origin}</small></button>
        ))}
      </div>
    </div>
  );
}

/**
 * One panel that says what was searched, instead of three boxes saying nothing.
 *
 * The route's whole argument is that it never hides anything, and the zero
 * state was the one moment where that argument most needed to be made and was
 * instead silent — 687px of "No matches in this scope." repeated three times.
 */
function MemoryNoMatchPanel({ query, lanes, graphMatchCount, onShowGraphMatches }: Readonly<{
  query: string;
  lanes: readonly MemoryLaneView[];
  graphMatchCount: number;
  onShowGraphMatches: () => void;
}>) {
  return (
    <div class="memory-no-match" role="status">
      <h3>No memory matched “{query}”</h3>
      <ul>
        {lanes.map((lane) => (
          <li key={lane.id}>
            <span>{lane.title} — {lane.searched}</span>
            <ProvenanceChip subject={lane.title} rows={lane.provenance} />
          </li>
        ))}
      </ul>
      <p>Nothing was hidden, filtered, or ranked away.</p>
      {graphMatchCount > 0 ? (
        <button class="small-button" type="button" onClick={onShowGraphMatches}>
          But the relationship graph has {graphMatchCount} match{graphMatchCount === 1 ? "" : "es"} — show {graphMatchCount === 1 ? "it" : "them"}
        </button>
      ) : null}
    </div>
  );
}

function conversationLane(result: FederatedMemoryResult | undefined, sessionId: string | undefined, onOpenSource: MemoryViewProps["onOpenSource"]): MemoryLaneView {
  const group = result?.groups[0];
  const hits = group?.hits ?? [];
  const scopeDigest = sessionId ?? "";
  return Object.freeze({
    id: "conversation",
    title: "Current conversation",
    count: hits.length,
    searched: "searched this session's journal, newest first, for lexical matches.",
    provenance: Object.freeze([
      provenanceNote(group?.ranking ?? "reverse-chronological lexical matches"),
      provenanceFact("Corpus", group?.corpus ?? "current-thread"),
      provenanceFact("Session", sessionId ?? "current session"),
      provenanceFact("Freshness", "journal revision at query time"),
    ] as ProvenanceRow[]),
    hits: hits.map((hit) => {
      const eventId = memoryHitString(hit, "eventId");
      const recordedAt = memoryHitString(hit, "recordedAt");
      const text = memoryHitString(hit, "text");
      return <MemoryHit
        key={eventId}
        title={conversationHitTitle(memoryHitString(hit, "eventType"))}
        recordedAt={recordedAt}
        text={text}
        subject="this journal event"
        open={sessionId && eventId ? { label: "Open this conversation", target: { kind: "message", sessionId, eventId } } : undefined}
        onOpenSource={onOpenSource}
        provenance={Object.freeze([
          provenanceFact("Event type", memoryHitString(hit, "eventType")),
          provenanceFact("Sequence", memoryHitString(hit, "sequence")),
          provenanceFact("Recorded", recordedAt),
          provenanceDigest("Event id", eventId),
          provenanceDigest("Event digest", memoryHitString(hit, "eventDigest")),
          provenanceDigest("Text digest", memoryHitString(hit, "textDigest")),
          provenanceInherited("Session", scopeDigest, "the Current conversation scope"),
          ...(text.endsWith("…") ? [provenanceNote("The search service bounds each event at 2,000 characters; this record was cut at that bound.", "caution")] : []),
        ] as ProvenanceRow[])}
      />;
    }),
  });
}

function profileLane(result: FederatedMemoryResult | undefined, onOpenSource: MemoryViewProps["onOpenSource"]): MemoryLaneView {
  const group = result?.groups[1];
  const hits = group?.hits ?? [];
  const quarantined = group?.legacyQuarantined ?? 0;
  const revision = result?.authority.profileRevision ?? "";
  return Object.freeze({
    id: "profile",
    title: "Active profile memory",
    count: hits.length,
    searched: `searched the pinned profile's explicit memory records${revision ? ` at profile revision ${provenanceTail(revision)}` : ""}.`,
    provenance: Object.freeze([
      provenanceNote(group?.ranking ?? "bounded BM25 relevance, recency-tiebroken; within this corpus only"),
      provenanceFact("Corpus", group?.corpus ?? "active-profile-memory"),
      provenanceFact("Profile", result?.authority.profileId ?? "pinned profile"),
      provenanceDigest("Profile revision", revision || "pinned revision"),
      provenanceFact("Record file", PROFILE_MEMORY_PATH),
      ...(quarantined > 0
        ? [provenanceNote(`${quarantined} legacy record${quarantined === 1 ? " is" : "s are"} quarantined and ${quarantined === 1 ? "was" : "were"} not searched.`, "caution")]
        : []),
    ] as ProvenanceRow[]),
    hits: hits.map((hit) => {
      const recordId = memoryHitString(hit, "id");
      return <MemoryHit
        key={recordId}
        title={memoryHitString(hit, "source") || "Explicit memory"}
        recordedAt={memoryHitString(hit, "createdAt")}
        text={memoryHitString(hit, "content")}
        subject="this memory record"
        open={recordId ? { label: "Open profile memory", target: { kind: "memory", recordId, path: PROFILE_MEMORY_PATH } } : undefined}
        onOpenSource={onOpenSource}
        provenance={Object.freeze([
          provenanceFact("Record id", recordId),
          provenanceFact("Source", memoryHitString(hit, "source") || "not recorded"),
          provenanceFact("Created", memoryHitString(hit, "createdAt")),
          provenanceFact("Created in session", memoryHitString(hit, "createdInSessionId") || "not recorded"),
          provenanceDigest("Content digest", memoryHitString(hit, "contentDigest")),
          provenanceDigest("Profile revision at creation", memoryHitString(hit, "profileRevisionAtCreation")),
          provenanceInherited("Profile revision", revision, "the Active profile memory scope"),
        ] as ProvenanceRow[])}
      />;
    }),
  });
}

function workspaceLane(result: FederatedMemoryResult | undefined, onOpenSource: MemoryViewProps["onOpenSource"]): MemoryLaneView {
  const group = result?.groups[2];
  const hits = group?.hits ?? [];
  const generation = group?.generationDigest ?? "";
  const suppressed = group?.duplicatesSuppressed ?? 0;
  return Object.freeze({
    id: "workspace",
    title: "Workspace & sources",
    count: hits.length,
    searched: group
      ? `searched the hybrid workspace index at generation ${provenanceTail(generation)}, completed in ${group.durationMs.toFixed(2)} ms.`
      : "searched the hybrid workspace index for this generation.",
    provenance: Object.freeze([
      provenanceNote(group?.ranking ?? "hybrid score within this corpus only; never comparable across groups"),
      provenanceFact("Corpus", group?.corpus ?? "shared-workspace-index"),
      provenanceDigest("Generation", generation || "revision checked"),
      provenanceDigest("Workspace snapshot", group?.workspaceSnapshotDigest ?? "not produced"),
      provenanceFact("Completed", group?.completedAt ?? "no completed run"),
      provenanceFact("Duration", group ? `${group.durationMs.toFixed(2)} ms` : "not measured"),
      ...(suppressed > 0 ? [provenanceNote(`${suppressed} duplicate chunk${suppressed === 1 ? " was" : "s were"} suppressed.`, "caution")] : []),
    ] as ProvenanceRow[]),
    hits: hits.map((hit) => <MemoryHit
      key={`${hit.path}:${hit.chunkId}`}
      title={hit.path}
      text={hit.text}
      subject={workspaceBaseName(hit.path)}
      open={{ label: "Open in editor", target: { kind: "file", path: hit.path } }}
      onOpenSource={onOpenSource}
      provenance={Object.freeze([
        // The dedup rule at its smallest: the row's own title is the path, so
        // the chip points at it instead of printing it a second time.
        provenanceInherited("Path", hit.path, "this result's title"),
        provenanceFact("Chunk index", String(hit.chunkIndex)),
        provenanceFact("Scores", `Dense ${hit.denseScore.toFixed(3)} · Lexical ${hit.lexicalScore.toFixed(3)} · Combined ${hit.score.toFixed(3)}`),
        provenanceNote("72% deterministic dense score · 28% lexical overlap. Scores are comparable inside this corpus only."),
        provenanceDigest("Revision", hit.revision),
        provenanceDigest("Content digest", hit.contentDigest),
        provenanceDigest("Chunk id", hit.chunkId),
        provenanceInherited("Generation", generation, "the Workspace & sources scope"),
      ] as ProvenanceRow[])}
    />),
  });
}

/** The file's own name, for a chip heading that has to fit beside a row. */
function workspaceBaseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function conversationHitTitle(eventType: string): string {
  if (eventType === "turn.requested") return "You asked";
  if (eventType === "assistant.completed") return "Airship replied";
  if (eventType === "tool.resulted") return "A tool returned";
  if (eventType === "tool.failed") return "A tool failed";
  if (eventType === "tool.denied") return "A tool was denied";
  return eventType;
}

/** The character budget a hit shows before it offers to show the whole record. */
export const MEMORY_HIT_PREVIEW_CHARACTERS = 320;

/**
 * One result, with a human title, a destination and its lineage.
 *
 * What it replaces silently discarded nine computed fields and hard-cut the
 * text at 320 characters with no ellipsis and no expander — a truncation the
 * reader could neither see nor undo. Here the whole record is in the DOM, the
 * clamp is visual, and the expander states the length it is hiding.
 */
function MemoryHit({ title, recordedAt, text, subject, open, onOpenSource, provenance }: Readonly<{
  title: string;
  recordedAt?: string;
  text: string;
  subject: string;
  open?: Readonly<{ label: string; target: MemorySourceTarget }>;
  onOpenSource?: MemoryViewProps["onOpenSource"];
  provenance: readonly ProvenanceRow[];
}>) {
  const [expanded, setExpanded] = useState(false);
  const bounded = text.length > MEMORY_HIT_PREVIEW_CHARACTERS;
  const destination = open && (onOpenSource || open.target.kind === "message") ? open : undefined;
  return (
    <article class="memory-hit">
      <header>
        <strong>{title}</strong>
        {recordedAt ? <time dateTime={recordedAt}>{formatRecordedAt(recordedAt)}</time> : null}
        {destination ? (
          <button
            class="memory-hit__open"
            type="button"
            onClick={() => {
              if (onOpenSource) { onOpenSource(destination.target); return; }
              // The searched journal *is* the live conversation, so this
              // destination is reachable from this file. Every other kind
              // needs the workspace reader the shell owns.
              if (destination.target.kind === "message") window.location.hash = "#chat";
            }}
          >{destination.label}</button>
        ) : null}
      </header>
      <p class="memory-hit__text" data-expanded={expanded ? "true" : "false"}>{text}</p>
      {bounded ? (
        <button class="memory-hit__more" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : `Show the full record (${text.length.toLocaleString()} chars)`}
        </button>
      ) : null}
      <footer><ProvenanceChip subject={subject} rows={provenance} /></footer>
    </article>
  );
}

function formatRecordedAt(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function memoryHitString(hit: Readonly<Record<string, import("../core/contracts").JsonValue>>, key: string): string {
  const value = hit[key];
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

/**
 * A lane is a 44px header plus whatever it actually has.
 *
 * The three lanes used to be locked to equal heights with a 150px body floor,
 * so an empty scope was an 80%-blank 527px box holding one sentence. A scope
 * with nothing in it now says so on one row, and still says which corpus it
 * consulted — the collapse removes padding, not the claim.
 */
function MemorySearchLane({ lane, query, searching }: Readonly<{ lane: MemoryLaneView; query: string; searching: boolean }>) {
  const state = searching ? "searching" : lane.count > 0 ? "hits" : query ? "empty" : "idle";
  return (
    <section class="memory-result-lane" data-state={state}>
      <header>
        <h3>{lane.title}</h3>
        {/* No count before a query: "0 results" on an unsearched corpus reads
            as "nothing is in there", which is a claim nobody has made yet. */}
        {state === "idle" ? null : (
          <span class="memory-lane-count">
            {state === "searching" ? "Searching…" : state === "empty" ? "No matches" : `${lane.count} result${lane.count === 1 ? "" : "s"}`}
          </span>
        )}
        {/* No digest token on a lane header: the scope name has to win the
            width, and the untruncated values are one tap inside the chip. */}
        <ProvenanceChip subject={lane.title} rows={lane.provenance} summary="" />
      </header>
      {state === "hits" ? <div class="memory-lane-hits">{lane.hits}</div> : null}
      {/* In-flight only. A scope that is still being read says so in its own
          body, because "Searching…" in the count slot alone would leave the
          lane looking settled at a moment when it is not. */}
      {state === "searching" ? <p class="memory-lane-note">Searching this scope…</p> : null}
    </section>
  );
}

function effectiveSkillIds(profile: ProfileRevision, catalog: ProfileCatalog): string[] {
  return catalog.skills
    .filter((skill) => {
      const mode = profile.skillModes[skill.skillId] ?? "inherit";
      return mode === "on" || (mode === "inherit" && Boolean(catalog.globalSkills[skill.skillId]));
    })
    .sort((left, right) => left.promptOrder - right.promptOrder || left.skillId.localeCompare(right.skillId))
    .map((skill) => skill.skillId);
}

export type MemoryOverviewNode = Readonly<{ id: string; label: string; kind: string; degree: number }>;

/**
 * The five most connected visible nodes.
 *
 * Hidden kinds are excluded because this list is a launcher: offering to select
 * a node the canvas is not drawing would select something the user cannot see.
 */
export function mostConnectedNodes(
  graph: MemoryRelationshipGraph,
  hiddenKinds: ReadonlySet<MemoryNodeKind>,
  limit = 5,
): readonly MemoryOverviewNode[] {
  return Object.freeze(graph.nodes
    .filter((node) => !hiddenKinds.has(node.kind))
    .map((node) => Object.freeze({
      id: node.id,
      label: node.label,
      kind: node.kind,
      degree: graph.getIncidentEdges(node.id).length,
    }))
    .sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label))
    .slice(0, limit));
}

function formatGraphDensity(graph: MemoryRelationshipGraph): string {
  const possiblePairs = graph.stats.nodeCount * Math.max(0, graph.stats.nodeCount - 1) / 2;
  const density = possiblePairs === 0 ? 0 : graph.stats.edgeCount / possiblePairs;
  return density < 0.001 && density > 0 ? density.toExponential(1) : density.toFixed(3);
}

function scrollToMemorySection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ block: "start" });
}
