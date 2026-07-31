import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  MemoryGraphRenderer,
  deriveMemoryRelationshipGraph,
  type MemoryGraphNode,
  type MemoryGraphViewportControls,
  type MemoryNodeKind,
  type MemoryRelationshipGraph,
} from "../memory-graph";
import { stableMemoryContentHash } from "../memory-graph/derive";
import type { ProfileCatalog } from "../profiles/catalog";
import type { ProfileRevision } from "../profiles/domain";
import type { ClientEncryptedWorkspacePort, WorkspaceEntry, WorkspacePort } from "../workspace/contracts";
import type { FederatedMemoryResult, FederatedMemorySearchState } from "../tools/federated-memory";
import { ContextView } from "./context-route";
import { durabilityLabel, durabilitySeal, type DurabilityState } from "./durability-indicator";
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
  /**
   * The live status line a turn carries until it settles ("Queued",
   * "Streaming …"). Cleared on success, failure and cancellation alike, in
   * the same commit the final answer lands — so its presence is the page's
   * marker for "this row's text is still moving".
   */
  status?: string;
  /**
   * The replay/materializer turn record. A row that settled inside the page
   * carries a terminal status here, which is what tells it apart from an
   * in-flight one: settled local-tool rows keep a display status forever.
   */
  history?: Readonly<{ turnStatus?: string }>;
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
  | Readonly<{ kind: "message"; sessionId: string }>
  | Readonly<{ kind: "memory"; recordId: string; path: string }>
  | Readonly<{ kind: "file"; path: string }>;

/** Where this profile's remembered records actually live, and for how long. */
export type MemoryDurability = Readonly<{ state: DurabilityState; label?: string; detail: string }>;

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
  /**
   * The shell's richer reading of where this session's state is written. Absent
   * hosts fall back to what the workspace port itself proves — never to
   * silence, because silence is what let "Private · on-device" stand alone
   * beside records a reload had already destroyed.
   */
  durability?: MemoryDurability;
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

/**
 * Whether a transcript row is still being written.
 *
 * A normal turn appends one assistant row with a status line and mutates its
 * content once per stream delta, clearing the status in the same commit the
 * answer — or the failure — lands. The local-tool path instead starts the row
 * with an `incomplete` turn record and settles the record; those rows keep a
 * display status after settling, so the terminal turn record outranks the
 * status line where both exist. A replayed incomplete turn never carries a
 * status line at all and counts as settled: its text stopped moving when the
 * journal did.
 */
export function isLiveMemoryMessage(message: MemoryViewMessage): boolean {
  if (message.history?.turnStatus && message.history.turnStatus !== "incomplete") return false;
  return message.status !== undefined;
}

/**
 * The derivation input's answer to "did anything *settled* change?".
 *
 * The rows a live turn mutates contribute identity only — their text is
 * deliberately absent until the turn commits — while settled rows contribute
 * identity and their content, so the key changes on a completed turn, an
 * appended message and any durable edit, and does NOT change per stream
 * delta. The signature itself never feeds the graph; it gates the memo whose
 * output does, so the graph, the spatial index and the federated search
 * re-arm once per settled change instead of once per chunk.
 */
export function stableMemoryAuthoritySignature(messages: readonly MemoryViewMessage[]): string {
  return messages.map((message) => `${message.id}${isLiveMemoryMessage(message) ? " live" : ` settled:${message.content.length}:${stableMemoryContentHash(message.content)}`}`).join("");
}

/** Where the profile lane's records are actually stored, stated once. */
const PROFILE_MEMORY_PATH = "/workspace/.airship/memory.json";

/**
 * The words this route uses for the rows the retrieval floor disqualified.
 *
 * The canonical string is `RETRIEVAL_FLOOR_HEADING` in
 * `indexing/client-context-engine`, beside the rule that produces the
 * classification — and it is copied rather than imported because that module
 * lives in the deferred-capabilities pack with the context runtime, while this
 * one is the Memory route's own chunk. A runtime import would split the engine
 * into a third chunk the release gate cannot attribute to an owner (measured:
 * "unclassified: assets/client-context-engine-*.js"). `memory-view.test.ts`
 * imports both and fails if they ever differ, so one vocabulary is enforced by
 * the tests rather than by the bundler.
 */
export const RETRIEVAL_FLOOR_HEADING = "Closest, below the confidence floor";

/**
 * What the workspace port itself proves about durability.
 *
 * The measured defect: a record written with `/update-memory` was verified
 * present in the Active profile memory lane, and after one `reload()` the same
 * query returned "No matches" while the route's only status chip still read
 * "Private · on-device" — a privacy claim a researcher reads as a durability
 * one. Memory now states both claims, and this is the floor under the second:
 * a host that passes nothing still cannot leave the route silent.
 *
 * Twin of `inferredTerminalDurability` in `terminal-view.tsx`, deliberately not
 * imported from it: Terminal is its own lazily loaded route chunk, and a
 * runtime import would merge it into Memory's. The shared vocabulary — the
 * state names, `durabilityLabel`, `durabilitySeal` — does come from the one
 * owner, so only this four-line inference is stated twice.
 */
export function inferredMemoryDurability(workspace?: WorkspacePort): MemoryDurability {
  if (!workspace) {
    return Object.freeze({
      state: "ephemeral" as const,
      detail: "No workspace is bound to this route, so nothing it finds is written anywhere durable.",
    });
  }
  if ((workspace as Partial<ClientEncryptedWorkspacePort>).encryptionBoundary === "airship-client-envelope-v1") {
    return Object.freeze({
      state: "local" as const,
      label: "Client-encrypted · tier unknown",
      detail: `The active workspace proves Airship's client-encryption boundary, so ${PROFILE_MEMORY_PATH} is written through it. Its backing tier was not supplied to Memory, so this route claims neither device nor cloud synchronization.`,
    });
  }
  return Object.freeze({
    state: "ephemeral" as const,
    detail: `Remembered records are written to ${PROFILE_MEMORY_PATH} in page memory. Nothing here survives a reload or a new tab.`,
  });
}

/**
 * The one witness that outlives a reload of this tab.
 *
 * Everything else the route reads — the journal, the workspace, the profile
 * memory file — is page memory when the Vault is Ephemeral, so after a reload
 * there is nothing left to compare against and the loss reads as an empty
 * corpus. `sessionStorage` has exactly the right lifetime: it survives the
 * reload and dies with the tab, which is the same lifetime as the claim
 * "records you found *here* are gone". Chat makes the equivalent statement from
 * the equivalent evidence — a session id in the hash that no longer resolves.
 *
 * Profile-scoped by key, because memory is a real silo: a record dropped from
 * General is not a fact about Research.
 */
export const MEMORY_WITNESS_KEY_PREFIX = "airship.memory.page-witness.";

/** As many ids as make a count trustworthy without turning storage into a log. */
const MEMORY_WITNESS_LIMIT = 64;

export type MemoryPageWitness = Readonly<{
  /** The page load that observed these records. */
  loadId: string;
  recordIds: readonly string[];
  /** Records a previous load of this tab observed and this one cannot reach. */
  dropped: number;
}>;

/**
 * This page load's identity. Module scope: a reload makes a new module.
 */
const MEMORY_PAGE_LOAD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function readMemoryWitness(storage: Storage | undefined, profileId: string): MemoryPageWitness | undefined {
  try {
    const raw = storage?.getItem(`${MEMORY_WITNESS_KEY_PREFIX}${profileId}`);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as Partial<MemoryPageWitness>;
    if (typeof value.loadId !== "string") return undefined;
    const recordIds = Array.isArray(value.recordIds) ? value.recordIds.filter((id): id is string => typeof id === "string") : [];
    return Object.freeze({
      loadId: value.loadId,
      recordIds: Object.freeze(recordIds.slice(0, MEMORY_WITNESS_LIMIT)),
      dropped: typeof value.dropped === "number" && Number.isFinite(value.dropped) ? Math.max(0, Math.floor(value.dropped)) : 0,
    });
  } catch {
    return undefined;
  }
}

function writeMemoryWitness(storage: Storage | undefined, profileId: string, witness: MemoryPageWitness): void {
  try {
    storage?.setItem(`${MEMORY_WITNESS_KEY_PREFIX}${profileId}`, JSON.stringify(witness));
  } catch {
    // A witness that cannot be stored simply produces no notice. It must never
    // take the route down: this is a claim about durability, not a dependency.
  }
}

/**
 * The witness this load starts from, and what the previous one lost.
 *
 * A stored witness whose `loadId` is not this page's belongs to the load before
 * the reload. When records are written to page memory, that load's records are
 * provably unreachable — the workspace they lived in was rebuilt empty — so the
 * count is carried forward as `dropped` and the id list is retired. A durable
 * workspace keeps its records, so the same witness is simply re-adopted.
 */
export function adoptMemoryWitness(
  stored: MemoryPageWitness | undefined,
  loadId: string,
  durability: DurabilityState,
): MemoryPageWitness {
  if (!stored) return Object.freeze({ loadId, recordIds: Object.freeze([]), dropped: 0 });
  if (stored.loadId === loadId) return stored;
  if (durability !== "ephemeral") return Object.freeze({ ...stored, loadId });
  return Object.freeze({
    loadId,
    recordIds: Object.freeze([]),
    dropped: stored.dropped + stored.recordIds.length,
  });
}

/** Records this load has actually seen, folded into the witness it will leave. */
export function mergeMemoryWitness(witness: MemoryPageWitness, observedIds: readonly string[]): MemoryPageWitness {
  const merged = new Set(witness.recordIds);
  for (const id of observedIds) {
    if (!id || merged.size >= MEMORY_WITNESS_LIMIT) continue;
    merged.add(id);
  }
  // Identity is the signal the persistence effect reads: an observation that
  // adds nothing must not re-write storage on every render.
  return merged.size === witness.recordIds.length ? witness : Object.freeze({ ...witness, recordIds: Object.freeze([...merged]) });
}

/** The loss, in the words chat already uses for the same event. */
export function droppedMemoryNotice(dropped: number): string | undefined {
  if (dropped <= 0) return undefined;
  return `${dropped} remembered record${dropped === 1 ? "" : "s"} this tab held existed only in page memory and did not survive the reload. ${dropped === 1 ? "It is" : "They are"} not recoverable.`;
}

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
  durability,
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
  const recallDurability = durability ?? inferredMemoryDurability(workspace);
  /*
   * Adopted once per mount, before anything is rendered: the comparison is
   * between this page load and the one that wrote the witness, so it has to
   * happen before this load records anything of its own.
   */
  const [witness, setWitness] = useState<MemoryPageWitness>(() => adoptMemoryWitness(
    readMemoryWitness(browserSessionStorage(), activeProfile.profileId),
    MEMORY_PAGE_LOAD_ID,
    recallDurability.state,
  ));
  /*
   * The only way back from a failed search.
   *
   * The search effect is keyed on the query, so a rejection left the reader
   * with no way to re-run the identical term — `searchMemoryForUi` throws
   * "The active accountable session is not ready." before any network exists,
   * and recovery meant retyping a different string and coming back. The nonce
   * is a dependency, so bumping it re-arms the same query.
   */
  const [searchAttempt, setSearchAttempt] = useState(0);
  // Held in state, not a ref: the graph surface is loaded lazily, so the zoom
  // controls have to re-render disabled until the engine that answers them exists.
  const [viewportControls, setViewportControls] = useState<MemoryGraphViewportControls>();
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
  /*
   * `messages` gets a fresh identity per stream delta, so neither derivation
   * may depend on it raw. The signature only moves on settled changes, and
   * the memoized rows below mask an in-flight row's text until its turn
   * commits — the graph and the search then re-arm exactly once per settled
   * change instead of once per chunk. Everything else (profile, catalog,
   * query) still depends on the real values.
   */
  const messageSignature = stableMemoryAuthoritySignature(messages);
  const settledMessages = useMemo(
    () => messages.map((message): MemoryViewMessage => isLiveMemoryMessage(message)
      ? { id: message.id, role: message.role, content: "", status: message.status }
      : message),
    // Keyed on the settled signature by design: `messages` is read only for
    // the masked projection, and the signature moves exactly when the
    // projection's content does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messageSignature],
  );
  const memoryAuthority = useMemo(() => ({}), [activeProfile, catalog, settledMessages, sessionId, workspaceAuthority]);
  const memorySearch = useFederatedMemorySearch(query, searchMemory, memoryAuthority, !indexMounted || Boolean(contextGeneration), searchAttempt);
  const graph = useMemo(() => {
    return deriveMemoryRelationshipGraph({
      sessions: sessionId ? [{
        id: sessionId,
        title: `${activeProfile.name} session`,
        profileId: activeProfile.profileId,
        skillIds: effectiveSkillIds(activeProfile, catalog),
        messages: settledMessages.map((message) => ({
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
  }, [activeProfile, catalog, files, settledMessages, sessionId]);
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
  /*
   * The witness is written on every mount, not only when it changes: a second
   * reload must inherit the first reload's count rather than recompute it from
   * a stale id list and silently forget the earlier loss.
   */
  useEffect(() => {
    writeMemoryWitness(browserSessionStorage(), activeProfile.profileId, witness);
  }, [activeProfile.profileId, witness]);
  useEffect(() => {
    const observed = (memorySearch.result?.groups[1].hits ?? []).map((hit) => memoryHitString(hit, "id"));
    if (observed.length) setWitness((current) => mergeMemoryWitness(current, observed));
  }, [memorySearch.result]);
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
  const droppedNotice = droppedMemoryNotice(witness.dropped);
  const starters = useMemo(() => memoryStarters(files, activeProfile.name, graph), [activeProfile.name, files, graph]);
  const graphResults = normalizedQuery ? graph.search(normalizedQuery, { limit: 12 }) : [];
  const selectedNode = selectedNodeId ? graph.getNode(selectedNodeId) : undefined;
  const selectedNodeDestination = selectedNode ? memoryNodeDestination(selectedNode, onOpenSource) : undefined;
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
        /*
         * Two claims, because they are two claims. "Private · on-device" is
         * where recall *runs*; a reader takes it for where memory *lives*, and
         * took it for that while a reload was destroying explicitly remembered
         * records. The second chip is the durability claim, in the same
         * vocabulary Workspace and Terminal already use for it.
         */
        status={<>
          <Seal state="none" density="chip" label="Private · on-device" detail="Recall, ranking and graph derivation all run inside this browser tab." />
          <Seal
            state={durabilitySeal(recallDurability.state)}
            density="chip"
            label={recallDurability.label ?? durabilityLabel(recallDurability.state)}
            detail={recallDurability.detail}
          />
        </>}
        notes={<>
          <p>Updates every loaded scope. Each corpus keeps its own scores.</p>
          <p>The agent and interface share one revision-checked service; each corpus keeps independent scores.</p>
          <p>Recall follows the selected storage mode. Remote Vaults can serve encrypted ranges; Local Device and Ephemeral keep recall on-device. Routing and ranking stay in-browser, and this graph derives only from current page inputs.</p>
        </>}
      />

      {/*
        * The notice chat has printed for a lost conversation since before this
        * route existed, for the loss this route was silent about. It leads the
        * page because it is the one thing on it that is no longer true: the
        * corpus below the search box is missing records the reader put there.
        */}
      {droppedNotice ? (
        <div class="memory-dropped" role="alert">
          <Icon name="warning" size={18} />
          <div>
            <strong>Remembered records did not survive the reload</strong>
            <p>{droppedNotice}</p>
          </div>
          <div class="memory-dropped__actions">
            <button class="small-button" type="button" onClick={() => { window.location.hash = "#vault"; }}>Choose a durable Vault</button>
            <button class="small-button" type="button" onClick={() => setWitness((current) => Object.freeze({ ...current, dropped: 0 }))}>Dismiss</button>
          </div>
        </div>
      ) : null}

      <form class="memory-query" role="search" onSubmit={(event) => {
        event.preventDefault();
        if (graphResults[0]) {
          setRelationshipsExpanded(true);
          selectMemoryNode(graphResults[0].node.id);
        }
      }}>
        <label class="sr-only" for="memory-query-input">Search every memory surface</label>
        <div class="search-field">
          <Icon name="memory" size={18} />
          {/* The field and its one clear affordance are a single grid cell now,
              so the shared recipe in `search-field.css` reaches every search
              field without each route sheet growing a track for the button. */}
          <span class="search-field__entry">
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
            {query ? <button class="search-field__clear" type="button" aria-label="Clear memory query" onClick={() => setQuery("")}><span aria-hidden="true">✕</span></button> : null}
          </span>
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
        onRetry={() => setSearchAttempt((value) => value + 1)}
        durability={recallDurability}
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
          {/*
            * Hiding was a one-way door: the count was reported in a status
            * string, so the state was legible but not operable. A filter the
            * user applied has to be a filter the user can lift, by name.
            */}
          {hiddenMemoryNodeIds.size ? (
            <details class="memory-hidden-nodes">
              <summary>{hiddenMemoryNodeIds.size} hidden<small>restore any node you removed from the picture</small></summary>
              <ul>
                {[...hiddenMemoryNodeIds].map((nodeId) => (
                  <li key={nodeId}>
                    <span>{graph.getNode(nodeId)?.label ?? nodeId}</span>
                    <button class="small-button" type="button" onClick={() => selectMemoryNode(nodeId)}>Restore</button>
                  </li>
                ))}
              </ul>
              <button class="small-button" type="button" onClick={() => setHiddenMemoryNodeIds(new Set())}>Restore all</button>
            </details>
          ) : null}
          <div class="memory-shell">
            <div class="memory-graph-panel panel">
              <div class="memory-toolbar">
                <div class="memory-graph-query">
                  <span role="status" aria-live="polite">{normalizedQuery ? `Graph matches for “${normalizedQuery}”` : "Graph follows the shared query"}</span>
                  {normalizedQuery ? (
                    graphResults.length ? <div role="group" aria-label="Matching relationship nodes">{graphResults.map((result) => <button key={result.node.id} type="button" aria-pressed={selectedNodeId === result.node.id} onClick={() => selectMemoryNode(result.node.id)}><span>{result.node.kind}</span>{result.node.label}</button>)}</div>
                      : <p>No relationship nodes match this query.</p>
                  ) : <p>Enter a query above to find and focus matching nodes.</p>}
                </div>
                {/*
                  * The same clamped viewport command the wheel and the pinch
                  * gesture use, reachable by keyboard and assistive technology.
                  * Disabled until the lazily loaded surface publishes them, so
                  * a control is never live before the engine behind it is.
                  */}
                <div class="memory-graph-controls" role="group" aria-label="Graph viewport">
                  <button class="small-button" type="button" disabled={!viewportControls} onClick={() => viewportControls?.zoomIn()}>Zoom in</button>
                  <button class="small-button" type="button" disabled={!viewportControls} onClick={() => viewportControls?.zoomOut()}>Zoom out</button>
                  <button class="small-button" type="button" disabled={!viewportControls} onClick={() => viewportControls?.fit()}>Fit</button>
                </div>
              </div>
              <MemoryGraphRenderer graph={graph} hiddenKinds={hiddenMemoryKinds} hiddenNodeIds={hiddenMemoryNodeIds} selectedNodeId={selectedNodeId} onSelect={(selection) => selectMemoryNode(selection?.focus?.id)} onViewportControls={setViewportControls} class="memory-canvas" minHeight={470} ariaLabel="Interactive memory relationship graph" />
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
                  <div class="memory-node-actions">
                    {/* The graph knew which conversation or file a node came
                        from and offered only "Hide from view": selecting the
                        message that mentions a term was a dead end. It routes
                        through the same destination contract the result lanes
                        use, so a node and a hit reach the same place. */}
                    {selectedNodeDestination ? (
                      <button class="small-button" type="button" onClick={() => onOpenSource?.(selectedNodeDestination.target)}>{selectedNodeDestination.label}</button>
                    ) : null}
                    <button class="small-button" type="button" onClick={() => { setHiddenMemoryNodeIds((current) => new Set(current).add(selectedNode.id)); setSelectedNodeId(undefined); }}>Hide from view</button>
                  </div>
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
                    {mostConnectedNodes(graph, hiddenMemoryKinds, hiddenMemoryNodeIds).map((entry) => (
                      <button key={entry.id} type="button" onClick={() => selectMemoryNode(entry.id)}>
                        <span>{entry.kind}</span><strong>{entry.label}</strong><small>{entry.degree} links</small>
                      </button>
                    ))}
                  </div>
                  {/* Names the controls that exist rather than a capability
                      the reader has to discover. */}
                  <p>Drag to pan, pinch or use Zoom in · Zoom out · Fit above the graph, search, or select a node to inspect relationships and source metadata.</p>
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

function useFederatedMemorySearch(query: string, search: MemoryViewProps["searchMemory"], authority: object, enabled: boolean, attempt: number): FederatedMemorySearchState {
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
  }, [attempt, authority, enabled, query, search]);
  return state.authority === authority && state.query === query.trim()
    ? state
    : { authority, query: query.trim(), searching: Boolean(query.trim()) };
}

/**
 * The search rejected, as distinct from the corpora being empty.
 *
 * The measured defect: on rejection the state carries `status` and no
 * `result`, so the honest `MemoryNoMatchPanel` was skipped and all three lanes
 * fell through to `"No matches"` — telling a reader that their conversation,
 * their profile memory and their workspace index contain nothing matching, on
 * the one route that promises "Nothing was hidden, filtered, or ranked away".
 * This is reachable with no network at all: `searchMemoryForUi` throws when no
 * accountable session is bound and when the federated tool is not installed.
 */
export function memorySearchFailed(state: FederatedMemorySearchState): boolean {
  return Boolean(state.query) && !state.searching && !state.result && Boolean(state.status);
}

export type MemoryLaneState = "searching" | "failed" | "hits" | "empty" | "idle";

/**
 * What one scope card may claim about itself.
 *
 * `failed` outranks the hit count because a rejected search produced no
 * groups, so `count` is zero for a reason that has nothing to do with the
 * corpus — and zero-because-nothing-ran must never be spoken as
 * zero-because-nothing-matched.
 */
export function memoryLaneState(args: Readonly<{
  searching: boolean;
  failed: boolean;
  count: number;
  query: string;
}>): MemoryLaneState {
  if (args.searching) return "searching";
  if (args.failed) return "failed";
  if (args.count > 0) return "hits";
  return args.query ? "empty" : "idle";
}

/**
 * The count-slot words for each lane state; `idle` renders no slot at all.
 *
 * `hasClosest` separates the two zeros. A scope that returned nothing at all
 * says "No matches"; a scope that returned rows its own contract disqualified
 * says so, because "No matches" beside a visible nearest row is the surface
 * disagreeing with itself.
 */
export function memoryLaneCountLabel(state: MemoryLaneState, count: number, hasClosest = false): string | undefined {
  if (state === "searching") return "Searching…";
  if (state === "failed") return "Not searched — the query failed";
  if (state === "empty") return hasClosest ? "No confident match" : "No matches";
  if (state === "hits") return `${count} result${count === 1 ? "" : "s"}`;
  return undefined;
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
  /**
   * Rows the lane found and its own contract disqualified. Rendered whether or
   * not the lane has results — a scope with nothing confident still owes the
   * reader its nearest row and the reason it does not count.
   */
  belowFloor?: ComponentChildren;
  /** The nearest disqualified row, for the zero-result panel's one line. */
  closest?: string;
}>;

function FederatedMemorySearch({ state, graphMatchCount, onShowGraphMatches, onOpenSource, starters, onStart, onRetry, durability }: Readonly<{
  state: FederatedMemorySearchState;
  graphMatchCount: number;
  onShowGraphMatches: () => void;
  onOpenSource?: MemoryViewProps["onOpenSource"];
  starters: readonly MemoryStarter[];
  onStart: (query: string) => void;
  /** Re-arms the identical query; the effect is keyed on a nonce, not the text. */
  onRetry: () => void;
  durability: MemoryDurability;
}>) {
  const result = state.result;
  const sessionId = result?.authority.sessionId;
  const lanes: readonly MemoryLaneView[] = [
    conversationLane(result, sessionId, onOpenSource),
    profileLane(result, onOpenSource, durability),
    workspaceLane(result, onOpenSource),
  ];
  const total = lanes.reduce((sum, lane) => sum + lane.count, 0);
  const settled = Boolean(state.query) && !state.searching && Boolean(result);
  const failed = memorySearchFailed(state);
  return <section id="memory-results" class="memory-federated" aria-labelledby="memory-search-title">
    {/*
      * "Federated client recall" and "Results across private scopes" name a
      * region whose visible label is the scope rail above it — so they name it
      * in the accessibility tree instead of spending 104px restating it.
      */}
    <h2 id="memory-search-title" class="sr-only">Federated client recall · Results across private scopes</h2>
    <p class="memory-search-status" role={failed ? "alert" : "status"} aria-live="polite">{state.status ?? (state.query ? "Search complete · results pinned to reported revisions." : "Ready for a private on-device query.")}</p>
    {/* The sentence above is the only place the failure is stated, and this is
        the only way back to it: the effect is keyed on the query, so before
        this button the sole recovery from a rejected search was to retype a
        different term and navigate back. */}
    {failed ? <button class="small-button memory-search-retry" type="button" onClick={onRetry}>Retry search</button> : null}
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
        {lanes.map((lane) => <MemorySearchLane key={lane.id} lane={lane} query={state.query} searching={state.searching} failed={failed} />)}
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
  for (const node of mostConnectedNodes(graph, new Set(), new Set(), limit)) {
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
            {/* The nearest disqualified row is named on the lane's own line:
                "no confident match — closest: README.md (0.046)" is the honest
                reading of what used to be reported as "1 result". */}
            <span>{lane.title} — {lane.searched}{lane.closest ? ` No confident match; closest: ${lane.closest}.` : ""}</span>
            <ProvenanceChip subject={lane.title} rows={lane.provenance} />
          </li>
        ))}
      </ul>
      <p>Nothing was hidden, filtered, or ranked away.</p>
      {lanes.map((lane) => lane.belowFloor ? <div key={`floor-${lane.id}`} class="memory-no-match__floor">{lane.belowFloor}</div> : null)}
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
        open={sessionId && eventId ? { label: "Open this conversation", target: { kind: "message", sessionId } } : undefined}
        onOpenSource={onOpenSource}
        citation={formatMemoryCitation(text, [
          conversationHitTitle(memoryHitString(hit, "eventType")),
          `conversation ${sessionId ?? "current session"}`,
          `event ${eventId}`,
          recordedAt ? `recorded ${recordedAt}` : "",
          memoryHitString(hit, "textDigest"),
        ])}
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

function profileLane(result: FederatedMemoryResult | undefined, onOpenSource: MemoryViewProps["onOpenSource"], durability: MemoryDurability): MemoryLaneView {
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
      /*
       * The lane that lost the work states its own lifetime, at the lane, in
       * the caution tone — the route-level chip says where records live, and
       * this is the scope that is actually holding them.
       */
      provenanceNote(durability.detail, durability.state === "ephemeral" ? "caution" : "neutral"),
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
        citation={formatMemoryCitation(memoryHitString(hit, "content"), [
          `profile memory · ${memoryHitString(hit, "source") || "source not recorded"}`,
          `record ${recordId}`,
          `created ${memoryHitString(hit, "createdAt")}`,
          memoryHitString(hit, "contentDigest"),
          durability.state === "ephemeral" ? "held in page memory only" : "",
        ])}
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
  const allHits = group?.hits ?? [];
  /*
   * The floor, applied where the count is spoken.
   *
   * Measured: "Kyoto" against a workspace with no occurrence of the word
   * reported "1 result · /workspace/README.md" and printed the whole README,
   * with "Dense 0.065 · Lexical 0.000 · Combined 0.046" three disclosures down.
   * The engine classifies each hit against its embedding posture; this lane
   * stops counting the disqualified ones as results and shows them, with the
   * disqualifying score at the top level, under a heading that says what they
   * are. Nothing is dropped: `belowFloor` renders in the empty state too.
   */
  const hits = allHits.filter((hit) => hit.confidence !== "weak");
  const weak = allHits.filter((hit) => hit.confidence === "weak");
  const generation = group?.generationDigest ?? "";
  const suppressed = group?.duplicatesSuppressed ?? 0;
  return Object.freeze({
    id: "workspace",
    title: "Workspace & sources",
    count: hits.length,
    closest: weak[0] ? `${workspaceBaseName(weak[0].path)} (${weak[0].score.toFixed(3)})` : undefined,
    belowFloor: weak.length ? <MemoryBelowFloor count={weak.length}>{weak.map((hit) => (
      <MemoryHit
        key={`${hit.path}:${hit.chunkId}`}
        title={hit.path}
        text={hit.text}
        subject={workspaceBaseName(hit.path)}
        caution={`Dense ${hit.denseScore.toFixed(3)} · Lexical ${hit.lexicalScore.toFixed(3)} · Combined ${hit.score.toFixed(3)}. ${hit.weakBecause ?? ""}`}
        open={{ label: "Open in editor", target: { kind: "file", path: hit.path } }}
        onOpenSource={onOpenSource}
        citation={workspaceCitation(hit)}
        provenance={workspaceHitProvenance(hit, generation)}
      />
    ))}</MemoryBelowFloor> : undefined,
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
      ...(weak.length > 0
        ? [provenanceNote(`${weak.length} row${weak.length === 1 ? "" : "s"} ranked below the confidence floor and ${weak.length === 1 ? "is" : "are"} shown, uncounted, under “${RETRIEVAL_FLOOR_HEADING}”.`, "caution")]
        : []),
      ...(suppressed > 0 ? [provenanceNote(`${suppressed} duplicate chunk${suppressed === 1 ? " was" : "s were"} suppressed.`, "caution")] : []),
    ] as ProvenanceRow[]),
    hits: hits.map((hit) => <MemoryHit
      key={`${hit.path}:${hit.chunkId}`}
      title={hit.path}
      text={hit.text}
      subject={workspaceBaseName(hit.path)}
      open={{ label: "Open in editor", target: { kind: "file", path: hit.path } }}
      onOpenSource={onOpenSource}
      citation={workspaceCitation(hit)}
      provenance={workspaceHitProvenance(hit, generation)}
    />),
  });
}

type WorkspaceMemoryHit = NonNullable<FederatedMemoryResult["groups"][2]>["hits"][number];

/** One lineage list for a workspace row, whether or not it cleared the floor. */
function workspaceHitProvenance(hit: WorkspaceMemoryHit, generation: string): readonly ProvenanceRow[] {
  return Object.freeze([
    // The dedup rule at its smallest: the row's own title is the path, so
    // the chip points at it instead of printing it a second time.
    provenanceInherited("Path", hit.path, "this result's title"),
    provenanceFact("Chunk index", String(hit.chunkIndex)),
    provenanceFact("Scores", `Dense ${hit.denseScore.toFixed(3)} · Lexical ${hit.lexicalScore.toFixed(3)} · Combined ${hit.score.toFixed(3)}`),
    provenanceNote("72% deterministic dense score · 28% lexical overlap. Scores are comparable inside this corpus only."),
    ...(hit.confidence === "weak" ? [provenanceNote(hit.weakBecause ?? "This row ranked below the confidence floor.", "caution")] : []),
    provenanceDigest("Revision", hit.revision),
    provenanceDigest("Content digest", hit.contentDigest),
    provenanceDigest("Chunk id", hit.chunkId),
    provenanceInherited("Generation", generation, "the Workspace & sources scope"),
  ] as ProvenanceRow[]);
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

/** How much of a record a citation quotes before it says so. */
export const MEMORY_CITATION_QUOTE_CHARACTERS = 600;

/**
 * The artifact that carries a result out of this route.
 *
 * The measured gap: every hit already holds an event id, a sequence, a revision,
 * a chunk id and two digests — and none of it could leave the screen. A hit
 * opened its source or it did nothing, so a researcher who wanted to quote a
 * line back into a conversation retyped it and lost the provenance on the way.
 * A citation is the smallest thing that travels: the quoted text, bounded and
 * declared, plus the lineage that makes the quote checkable, in one paste.
 */
export function formatMemoryCitation(text: string, source: readonly string[]): string {
  const bounded = text.length > MEMORY_CITATION_QUOTE_CHARACTERS;
  const quote = bounded ? `${text.slice(0, MEMORY_CITATION_QUOTE_CHARACTERS)}…` : text;
  const parts = source.filter(Boolean);
  // The cut is part of the citation: a quote that silently ends early is a
  // misquote, and this route's whole argument is that nothing is hidden.
  const bound = bounded ? [`quoted ${MEMORY_CITATION_QUOTE_CHARACTERS} of ${text.length} characters`] : [];
  return `> ${quote.replaceAll("\n", "\n> ")}\n— ${[...parts, ...bound].join(" · ")}`;
}

function workspaceCitation(hit: WorkspaceMemoryHit): string {
  return formatMemoryCitation(hit.text, [
    hit.path,
    `chunk ${hit.chunkIndex}`,
    `revision ${hit.revision}`,
    hit.contentDigest,
    ...(hit.confidence === "weak" ? ["below the retrieval confidence floor"] : []),
  ]);
}

/**
 * One result, with a human title, a destination and its lineage.
 *
 * What it replaces silently discarded nine computed fields and hard-cut the
 * text at 320 characters with no ellipsis and no expander — a truncation the
 * reader could neither see nor undo. Here the whole record is in the DOM, the
 * clamp is visual, and the expander states the length it is hiding.
 */
function MemoryHit({ title, recordedAt, text, subject, open, onOpenSource, provenance, caution, citation }: Readonly<{
  title: string;
  recordedAt?: string;
  text: string;
  subject: string;
  open?: Readonly<{ label: string; target: MemorySourceTarget }>;
  onOpenSource?: MemoryViewProps["onOpenSource"];
  provenance: readonly ProvenanceRow[];
  /** The disqualifying fact, at the top level rather than inside the chip. */
  caution?: string;
  /** The pasteable quote-plus-lineage this row is worth citing as. */
  citation?: string;
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
        {citation ? <MemoryCitationButton citation={citation} subject={subject} /> : null}
      </header>
      {caution ? <p class="memory-hit__caution">{caution}</p> : null}
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

/**
 * Copy, or nothing — the same rule `provenance-chip`'s field copier follows.
 *
 * Not imported from it: that component's copier is private to the chip, and a
 * control that silently fails where the Clipboard API is absent is worse than
 * no control at all, so the rule is what travels rather than the code.
 */
function MemoryCitationButton({ citation, subject }: Readonly<{ citation: string; subject: string }>) {
  const [copied, setCopied] = useState(false);
  if (typeof navigator === "undefined" || !navigator.clipboard) return null;
  return (
    <button
      class="memory-hit__cite"
      type="button"
      aria-label={copied ? `Citation for ${subject} copied` : `Copy a citation for ${subject}: the quoted text with its source, revision and digest`}
      onClick={() => {
        void navigator.clipboard.writeText(citation).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_600);
          },
          () => setCopied(false),
        );
      }}
    >{copied ? "Citation copied" : "Copy citation"}</button>
  );
}

/**
 * The rows the retrieval contract found and disqualified.
 *
 * Closed by default and never absent: this is the difference between a floor
 * and a filter. The summary states the count, so the disclosure declares its
 * own cost, and each row inside carries its scores at the top level — the
 * defect was those scores being three disclosures deep, not their existing.
 */
function MemoryBelowFloor({ count, children }: Readonly<{ count: number; children: ComponentChildren }>) {
  return (
    <details class="memory-below-floor">
      <summary>
        <span>{RETRIEVAL_FLOOR_HEADING}</span>
        <small>{count} row{count === 1 ? "" : "s"} · found, not counted as {count === 1 ? "a result" : "results"}</small>
      </summary>
      <div class="memory-below-floor__rows">{children}</div>
    </details>
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
function MemorySearchLane({ lane, query, searching, failed }: Readonly<{ lane: MemoryLaneView; query: string; searching: boolean; failed: boolean }>) {
  const state = memoryLaneState({ searching, failed, count: lane.count, query });
  const count = memoryLaneCountLabel(state, lane.count, Boolean(lane.closest));
  return (
    <section class="memory-result-lane" data-state={state}>
      <header>
        <h3>{lane.title}</h3>
        {/* No count before a query: "0 results" on an unsearched corpus reads
            as "nothing is in there", which is a claim nobody has made yet. And
            no "No matches" after a rejection, which is the same claim made
            about three corpora that were never consulted. */}
        {count ? <span class="memory-lane-count">{count}</span> : null}
        {/* No digest token on a lane header: the scope name has to win the
            width, and the untruncated values are one tap inside the chip. */}
        <ProvenanceChip subject={lane.title} rows={lane.provenance} summary="" />
      </header>
      {state === "hits" ? <div class="memory-lane-hits">{lane.hits}</div> : null}
      {/* A floor is not a filter: the disqualified rows render whether or not
          the lane counted anything, including in the state where the count slot
          reads "No confident match". */}
      {state === "hits" || state === "empty" ? lane.belowFloor : null}
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

/**
 * Where a selected node's source actually is.
 *
 * Measured: selecting the node "kyoto trial" reported "1 occurrence across 1
 * source" and "MENTIONS user: /update-memory --js…", and pressing that
 * relationship left `location.hash` at `#memory`. The graph derives every
 * message node with its `sessionId` and every file node with its `path`, so the
 * destination was known and simply never offered. A node whose metadata does
 * not carry one — a derived term, a skill — gets no button rather than a dead
 * one, exactly as a hit does.
 */
export function memoryNodeDestination(
  node: MemoryGraphNode,
  onOpenSource: MemoryViewProps["onOpenSource"],
): Readonly<{ label: string; target: MemorySourceTarget }> | undefined {
  if (!onOpenSource) return undefined;
  if (node.kind === "message" || node.kind === "session") {
    const sessionId = node.metadata.sessionId;
    return typeof sessionId === "string" && sessionId
      ? Object.freeze({ label: "Open this conversation", target: Object.freeze({ kind: "message" as const, sessionId }) })
      : undefined;
  }
  if (node.kind === "workspace-file") {
    const path = node.metadata.path;
    return typeof path === "string" && path
      ? Object.freeze({ label: "Open in editor", target: Object.freeze({ kind: "file" as const, path }) })
      : undefined;
  }
  return undefined;
}

export type MemoryOverviewNode = Readonly<{ id: string; label: string; kind: string; degree: number }>;

/**
 * The five most connected visible nodes.
 *
 * Hidden kinds are excluded because this list is a launcher: offering to select
 * a node the canvas is not drawing would select something the user cannot see.
 * Individually hidden nodes are excluded for the same reason — selecting one
 * used to un-hide it as an undocumented side effect, which is now the Restore
 * control's job to do on purpose.
 */
export function mostConnectedNodes(
  graph: MemoryRelationshipGraph,
  hiddenKinds: ReadonlySet<MemoryNodeKind>,
  hiddenNodeIds: ReadonlySet<string> = new Set(),
  limit = 5,
): readonly MemoryOverviewNode[] {
  return Object.freeze(graph.nodes
    .filter((node) => !hiddenKinds.has(node.kind) && !hiddenNodeIds.has(node.id))
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

/**
 * The witness store, or nothing.
 *
 * A storage access can throw outright under a third-party-cookie or private-mode
 * policy, and a route that cannot record a witness must still render: the
 * consequence of `undefined` here is one notice that is not offered, never a
 * Memory surface that fails to load.
 */
function browserSessionStorage(): Storage | undefined {
  try { return typeof sessionStorage === "undefined" ? undefined : sessionStorage; }
  catch { return undefined; }
}
