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
import "./memory-view.css";

export type MemoryViewMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
  parts?: readonly MessagePart[];
}>;

export type MemoryViewProps = Readonly<{
  sessionId?: string;
  messages: readonly MemoryViewMessage[];
  files: readonly WorkspaceEntry[];
  catalog: ProfileCatalog;
  activeProfile: ProfileRevision;
  workspace?: WorkspacePort;
  searchMemory: (query: string, signal: AbortSignal) => Promise<FederatedMemoryResult>;
  initialTab: "search" | "index";
}>;

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
}: MemoryViewProps) {
  const [query, setQuery] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [hiddenMemoryKinds, setHiddenMemoryKinds] = useState<ReadonlySet<MemoryNodeKind>>(() => new Set());
  const [hiddenMemoryNodeIds, setHiddenMemoryNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [relationshipLimit, setRelationshipLimit] = useState(18);
  const [relationshipsExpanded, setRelationshipsExpanded] = useState(initialTab !== "index");
  const [indexExpanded, setIndexExpanded] = useState(initialTab === "index");
  const [indexMounted, setIndexMounted] = useState(initialTab === "index");
  const [contextGeneration, setContextGeneration] = useState<string>();
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
    if (initialTab === "index") {
      setIndexExpanded(true);
      setIndexMounted(true);
      const frame = window.requestAnimationFrame(alignIndex);
      return () => window.cancelAnimationFrame(frame);
    } else {
      setRelationshipsExpanded(true);
    }
  }, [alignIndex, initialTab]);
  useEffect(() => setRelationshipLimit(18), [selectedNodeId]);
  const normalizedQuery = query.trim();
  const graphResults = normalizedQuery ? graph.search(normalizedQuery, { limit: 12 }) : [];
  const selectedNode = selectedNodeId ? graph.getNode(selectedNodeId) : undefined;
  const selectedEdges = selectedNodeId ? graph.getIncidentEdges(selectedNodeId) : [];
  const relationshipGroups = groupMemoryRelationships(selectedEdges, relationshipLimit);
  const truncationCount = Object.values(graph.stats.truncated).reduce((total, value) => total + value, 0);
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

  return (
    <section class="work-view memory-view" aria-labelledby="memory-title">
      <header class="memory-hero">
        <div class="page-heading"><span class="eyebrow">Private recall &amp; on-device retrieval</span><h1 id="memory-title">Memory</h1><p>One private query across conversation, profile memory, workspace index, and typed relationships.</p></div>
        <form class="memory-query" role="search" onSubmit={(event) => {
          event.preventDefault();
          if (graphResults[0]) {
            setRelationshipsExpanded(true);
            selectMemoryNode(graphResults[0].node.id);
          }
        }}>
          <label for="memory-query-input">Search every memory surface</label>
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
              placeholder="Search conversation, profile, workspace, relationships, and index…"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            {query ? <button type="button" aria-label="Clear memory query" onClick={() => setQuery("")}>Clear</button> : null}
          </div>
          <p id="memory-query-help">Updates every loaded scope. Each corpus keeps its own scores.</p>
        </form>
        <nav class="memory-jump-nav" aria-label="Memory page sections">
          <button type="button" onClick={() => scrollToMemorySection("memory-results")}><span>Recall</span><small>3 private scopes</small></button>
          <button type="button" onClick={() => { setRelationshipsExpanded(true); window.requestAnimationFrame(() => scrollToMemorySection("memory-relationships")); }}><span>Relationships</span><small>{graph.stats.nodeCount} nodes</small></button>
          <button type="button" onClick={() => { openIndex(true); window.requestAnimationFrame(() => scrollToMemorySection("memory-index")); }}><span>Local index</span><small>{files.length} sources</small></button>
        </nav>
      </header>

      <FederatedMemorySearch state={memorySearch} />

      <details
        id="memory-relationships"
        class="memory-disclosure"
        open={relationshipsExpanded}
        onToggle={(event) => setRelationshipsExpanded(event.currentTarget.open)}
      >
        <summary>
          <span><Icon name="memory" size={18} /><span><small>Typed relationship graph</small><strong>Explore remembered relationships</strong></span></span>
          <span class="memory-summary-meta">{normalizedQuery ? `${graphResults.length} graph match${graphResults.length === 1 ? "" : "es"}` : `${graph.stats.edgeCount} relationships`}<i aria-hidden="true" /></span>
        </summary>
        <div class="memory-disclosure-body">
          <div class="memory-metrics" role="group" aria-label="Relationship graph statistics">
            <div class="metric"><span>Nodes</span><strong>{graph.stats.nodeCount}</strong><small>real page inputs + derived terms</small></div>
            <div class="metric"><span>Relationships</span><strong>{graph.stats.edgeCount}</strong><small>typed, bounded edges</small></div>
            <div class="metric"><span>Components</span><strong>{graph.stats.componentCount}</strong><small>current relationship islands</small></div>
            <div class="metric"><span>Density</span><strong>{formatGraphDensity(graph)}</strong><small>not vector similarity</small></div>
          </div>
          <div class={truncationCount ? "memory-boundary attention" : "memory-boundary"} role="status">
            <strong>{truncationCount ? "Bounded memory view" : "Memory view within bounds"}</strong>
            <span>{truncationCount ? `${truncationCount} source/derived items exceeded bounds. ` : "Within derivation bounds. "}{graph.stats.isolatedNodeCount} isolated · max degree {graph.stats.maxDegree} · {hiddenMemoryNodeIds.size} hidden. Filters never alter memory.</span>
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
                <span title="Graph revision">rev {graph.revision.slice(-9)}</span>
              </div>
              <MemoryGraphRenderer graph={graph} hiddenKinds={hiddenMemoryKinds} hiddenNodeIds={hiddenMemoryNodeIds} selectedNodeId={selectedNodeId} onSelect={(selection) => selectMemoryNode(selection?.focus?.id)} class="memory-canvas" minHeight={470} ariaLabel="Interactive memory relationship graph" />
              <MemoryKindLegend counts={graph.stats.nodesByKind} hidden={hiddenMemoryKinds} onToggle={(kind) => setHiddenMemoryKinds((current) => { const next = new Set(current); next.has(kind) ? next.delete(kind) : next.add(kind); return next; })} />
            </div>
            <aside class="memory-detail panel" aria-labelledby="memory-inspector-title">
              <div class="panel-heading"><span id="memory-inspector-title">Relationship inspector</span><span>{selectedNode ? selectedNode.kind : "select a node"}</span></div>
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
              ) : <section class="empty-state"><Icon name="memory" /><h2>Select an idea</h2><p>Pan, zoom, search, or select a node to inspect relationships and source metadata.</p></section>}
            </aside>
          </div>
          <div class="callout"><Icon name="cloud" /><div><strong>Recall follows the selected storage mode</strong><p>Remote Vaults can serve encrypted ranges; Local Device and Ephemeral keep recall on-device. Routing and ranking stay in-browser, and this graph derives only from current page inputs.</p></div></div>
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
          <span class="memory-summary-meta">{workspace ? `${files.length} workspace source${files.length === 1 ? "" : "s"}` : "Workspace unavailable"}<i aria-hidden="true" /></span>
        </summary>
        <div class="memory-disclosure-body">
          {indexMounted ? workspace
            ? <ContextView workspace={workspace} entries={files} embedded searchQuery={query} sharedSearch={memorySearch} onGenerationChange={setContextGeneration} onReady={initialTab === "index" ? alignIndex : undefined} />
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

function FederatedMemorySearch({ state }: Readonly<{ state: FederatedMemorySearchState }>) {
  const thread = state.result?.groups[0].hits ?? [];
  const profileHits = state.result?.groups[1].hits ?? [];
  const workspaceHits = state.result?.groups[2].hits ?? [];
  const emptyMessage = state.searching
    ? "Searching this scope…"
    : state.query
      ? "No matches in this scope."
      : "Enter a query.";
  return <section id="memory-results" class="memory-federated" aria-labelledby="memory-search-title">
    <header>
      <div><span class="eyebrow">Federated client recall</span><h2 id="memory-search-title">Results across private scopes</h2><p>The agent and interface share one revision-checked service; each corpus keeps independent scores.</p></div>
      <p class="memory-search-status" role={state.status && !state.searching ? "alert" : "status"} aria-live="polite">{state.status ?? (state.query ? "Search complete · results pinned to reported revisions." : "Ready for a private on-device query.")}</p>
    </header>
    <div class="memory-result-lanes">
      <MemorySearchLane title="Current conversation" scope={state.result?.authority.sessionId ?? "current session"} freshness="journal revision" count={thread.length} emptyMessage={emptyMessage}>{thread.map((hit) => <article key={memoryHitString(hit, "eventId")}><strong>{memoryHitString(hit, "eventType")}</strong><p>{memoryHitString(hit, "text").slice(0, 320)}</p><small>{memoryHitString(hit, "eventDigest").slice(0, 20)}…</small></article>)}</MemorySearchLane>
      <MemorySearchLane title="Active profile memory" scope={state.result?.authority.profileId ?? "pinned profile"} freshness={state.result ? `revision ${state.result.authority.profileRevision.slice(-8)}` : "pinned revision"} count={profileHits.length} emptyMessage={emptyMessage}>{profileHits.map((hit) => <article key={memoryHitString(hit, "id")}><strong>{memoryHitString(hit, "source") || "Explicit memory"}</strong><p>{memoryHitString(hit, "content").slice(0, 320)}</p><small>{memoryHitString(hit, "contentDigest").slice(0, 20)}…</small></article>)}</MemorySearchLane>
      <MemorySearchLane title="Workspace &amp; sources" scope="hybrid workspace index" freshness={state.result ? `generation ${state.result.groups[2].generationDigest.slice(-8)}` : "revision checked"} count={workspaceHits.length} emptyMessage={emptyMessage}>{workspaceHits.map((hit) => <article key={`${hit.path}:${hit.chunkId}`}><strong>{hit.path}</strong><p>{hit.text.slice(0, 320)}</p><small>revision {hit.revision.slice(-8)} · chunk {hit.chunkId.slice(-8)}</small></article>)}</MemorySearchLane>
    </div>
  </section>;
}

function memoryHitString(hit: Readonly<Record<string, import("../core/contracts").JsonValue>>, key: string): string {
  const value = hit[key];
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function MemorySearchLane({ title, scope, freshness, count, emptyMessage, children }: Readonly<{ title: string; scope: string; freshness: string; count: number; emptyMessage: string; children: ComponentChildren }>) {
  return <section class="memory-result-lane"><header><div><h3>{title}</h3><span>{count} result{count === 1 ? "" : "s"}</span></div><div><span>{scope}</span><span>{freshness}</span></div></header><div>{count ? children : <p class="memory-lane-empty">{emptyMessage}</p>}</div></section>;
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

function formatGraphDensity(graph: MemoryRelationshipGraph): string {
  const possiblePairs = graph.stats.nodeCount * Math.max(0, graph.stats.nodeCount - 1) / 2;
  const density = possiblePairs === 0 ? 0 : graph.stats.edgeCount / possiblePairs;
  return density < 0.001 && density > 0 ? density.toExponential(1) : density.toFixed(3);
}

function scrollToMemorySection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ block: "start" });
}
