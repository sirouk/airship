import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  MemoryGraphRenderer,
  deriveMemoryRelationshipGraph,
  type MemoryNodeKind,
  type MemoryRelationshipGraph,
} from "../memory-graph";
import type { ProfileCatalog } from "../profiles/catalog";
import type { ProfileRevision } from "../profiles/domain";
import type { WorkspaceEntry, WorkspacePort } from "../workspace/contracts";
import type { FederatedMemoryResult } from "../tools/federated-memory";
import { ContextView } from "./context-route";
import { Icon } from "./icons";
import { MemoryKindLegend, MemorySearch } from "./memory-controls";
import { groupMemoryRelationships } from "./memory-relationships";
import { messagePlainText, type MessagePart } from "./chat/message-parts";

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
  const [tab, setTab] = useState<"search" | "graph" | "index">(initialTab);
  const graph = useMemo(() => {
    if (tab !== "graph") return undefined;
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
  }, [activeProfile, catalog, files, messages, sessionId, tab]);
  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => setRelationshipLimit(18), [selectedNodeId]);
  const results = query.trim() && graph ? graph.search(query, { limit: 12 }) : [];
  const selectedNode = selectedNodeId && graph ? graph.getNode(selectedNodeId) : undefined;
  const selectedEdges = selectedNodeId && graph ? graph.getIncidentEdges(selectedNodeId) : [];
  const relationshipGroups = groupMemoryRelationships(selectedEdges, relationshipLimit);
  const truncationCount = graph
    ? Object.values(graph.stats.truncated).reduce((total, value) => total + value, 0)
    : 0;
  const selectMemoryNode = (nodeId: string | undefined) => {
    if (nodeId) setHiddenMemoryNodeIds((current) => {
      if (!current.has(nodeId)) return current;
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
    setSelectedNodeId(nodeId);
  };

  return (
    <section class="work-view memory-view">
      <PageHeading eyebrow="Private recall & on-device retrieval" title="Memory" description="Search conversations, profile memory, and workspace context on this device." />
      <div class="memory-mode-tabs" role="tablist" aria-label="Memory views">
        {(["search", "graph", "index"] as const).map((mode) => <button key={mode} type="button" role="tab" aria-selected={tab === mode} onClick={() => setTab(mode)}>{mode[0]?.toUpperCase()}{mode.slice(1)}</button>)}
      </div>
      {tab === "search" ? <FederatedMemorySearch search={searchMemory} /> : null}
      {tab === "graph" && graph ? <>
        <div class="memory-metrics">
          <div class="metric"><span>Nodes</span><strong>{graph.stats.nodeCount}</strong><small>real page inputs + derived terms</small></div>
          <div class="metric"><span>Relationships</span><strong>{graph.stats.edgeCount}</strong><small>typed, bounded edges</small></div>
          <div class="metric"><span>Components</span><strong>{graph.stats.componentCount}</strong><small>current relationship islands</small></div>
          <div class="metric"><span>Density</span><strong>{formatGraphDensity(graph)}</strong><small>not vector similarity</small></div>
        </div>
        <div class={truncationCount ? "memory-boundary attention" : "memory-boundary"} role="status"><strong>{truncationCount ? "Bounded memory view" : "Memory view within bounds"}</strong><span>{truncationCount ? `${truncationCount} source or derived items were omitted by client limits. ` : "No configured derivation bound was reached. "}{graph.stats.isolatedNodeCount} isolated nodes · maximum degree {graph.stats.maxDegree} · {hiddenMemoryNodeIds.size} individually hidden. View filters never alter source memory.</span></div>
        <div class="memory-shell">
          <div class="memory-graph-panel panel">
            <div class="memory-toolbar">
              <MemorySearch query={query} results={results} onQuery={setQuery} onSelect={selectMemoryNode} />
              <span>{graph.revision.slice(-9)}</span>
            </div>
            <MemoryGraphRenderer graph={graph} hiddenKinds={hiddenMemoryKinds} hiddenNodeIds={hiddenMemoryNodeIds} selectedNodeId={selectedNodeId} onSelect={(selection) => selectMemoryNode(selection?.focus?.id)} class="memory-canvas" minHeight={470} ariaLabel="Interactive memory relationship graph" />
            <MemoryKindLegend counts={graph.stats.nodesByKind} hidden={hiddenMemoryKinds} onToggle={(kind) => setHiddenMemoryKinds((current) => { const next = new Set(current); next.has(kind) ? next.delete(kind) : next.add(kind); return next; })} />
          </div>
          <aside class="memory-detail panel">
            <div class="panel-heading"><span>Relationship inspector</span><span>{selectedNode ? selectedNode.kind : "select a node"}</span></div>
            {selectedNode ? (
              <div class="memory-node-detail">
                <span class="eyebrow">{selectedNode.kind}</span>
                <h2>{selectedNode.label}</h2>
                <p>{selectedNode.summary || "No additional summary is present for this node."}</p>
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
            ) : <EmptyState />}
          </aside>
        </div>
        <div class="callout"><Icon name="cloud" /><div><strong>The selected Vault is the encrypted backbone</strong><p>Google Drive or S3 can serve exact encrypted segment ranges, while expert routing and ranking stay in this browser. This relationship graph still derives from current page inputs; remote graph-generation convergence is not claimed yet.</p></div></div>
      </> : null}
      {tab === "index" ? workspace ? <ContextView workspace={workspace} entries={files} embedded /> : <section class="empty-state"><Icon name="context" /><h2>Index unavailable</h2><p>The active browser workspace is not ready, so no index generation was started.</p></section> : null}
    </section>
  );
}

function FederatedMemorySearch({ search }: Readonly<{ search: (query: string, signal: AbortSignal) => Promise<FederatedMemoryResult> }>) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<FederatedMemoryResult>();
  const [status, setStatus] = useState<string>();
  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setResult(undefined);
      setStatus(undefined);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus("Searching the same three client-owned corpora used by the agent…");
      void search(normalized, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setResult(next);
          setStatus(undefined);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setResult(undefined);
          setStatus(error instanceof Error ? error.message : String(error));
        });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort(new DOMException("A newer memory query replaced this search.", "AbortError"));
    };
  }, [query, search]);
  const thread = result?.groups[0].hits ?? [];
  const profileHits = result?.groups[1].hits ?? [];
  const workspaceHits = result?.groups[2].hits ?? [];
  return <section class="memory-federated" aria-labelledby="memory-search-title">
    <header><div><span class="eyebrow">Federated client search</span><h2 id="memory-search-title">Search across scopes</h2><p>The interface and agent share one revision-checked read service; scores never cross corpus boundaries.</p></div><label><span class="sr-only">Search memory and context</span><Icon name="memory" size={16} /><input type="search" value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search conversation, profile memory, and indexed content…" /></label></header>
    {status ? <p class="memory-search-status" role="status" aria-live="polite">{status}</p> : null}
    <div class="memory-result-lanes">
      <MemorySearchLane title="Current conversation" scope={result?.authority.sessionId ?? "current session"} freshness="journal revision" count={thread.length}>{thread.map((hit) => <article key={memoryHitString(hit, "eventId")}><strong>{memoryHitString(hit, "eventType")}</strong><p>{memoryHitString(hit, "text").slice(0, 320)}</p><small>{memoryHitString(hit, "eventDigest").slice(0, 20)}…</small></article>)}</MemorySearchLane>
      <MemorySearchLane title="Active profile memory" scope={result?.authority.profileId ?? "pinned profile"} freshness={result ? `revision ${result.authority.profileRevision.slice(-8)}` : "pinned revision"} count={profileHits.length}>{profileHits.map((hit) => <article key={memoryHitString(hit, "id")}><strong>{memoryHitString(hit, "source") || "Explicit memory"}</strong><p>{memoryHitString(hit, "content").slice(0, 320)}</p><small>{memoryHitString(hit, "contentDigest").slice(0, 20)}…</small></article>)}</MemorySearchLane>
      <MemorySearchLane title="Workspace &amp; sources" scope="hybrid workspace index" freshness={result ? `generation ${result.groups[2].generationDigest.slice(-8)}` : "revision checked"} count={workspaceHits.length}>{workspaceHits.map((hit) => <article key={`${memoryHitString(hit, "path")}:${memoryHitString(hit, "chunkId")}`}><strong>{memoryHitString(hit, "path")}</strong><p>{memoryHitString(hit, "text").slice(0, 320)}</p><small>revision {memoryHitString(hit, "revision").slice(-8)} · chunk {memoryHitString(hit, "chunkId").slice(-8)}</small></article>)}</MemorySearchLane>
    </div>
  </section>;
}

function memoryHitString(hit: Readonly<Record<string, import("../core/contracts").JsonValue>>, key: string): string {
  const value = hit[key];
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function MemorySearchLane({ title, scope, freshness, count, children }: Readonly<{ title: string; scope: string; freshness: string; count: number; children: ComponentChildren }>) {
  return <section class="memory-result-lane"><header><div><h3>{title}</h3><span>{count} result{count === 1 ? "" : "s"}</span></div><div><span>{scope}</span><span>{freshness}</span></div></header><div>{count ? children : <p class="memory-lane-empty">Enter a query or refine it to surface results from this scope.</p>}</div></section>;
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

function PageHeading({ eyebrow, title, description }: Readonly<{ eyebrow: string; title: string; description: string }>) {
  return <header class="page-heading"><div><span class="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div></header>;
}

function EmptyState() {
  return <section class="empty-state"><Icon name="memory" /><h2>Select an idea</h2><p>Pan, zoom, search, or select any node to inspect its typed relationships and source metadata.</p></section>;
}
