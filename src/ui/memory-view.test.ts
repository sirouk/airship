import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { FederatedMemorySearchState } from "../tools/federated-memory";
import { isLiveMemoryMessage, memoryLaneCountLabel, memoryLaneState, memorySearchFailed, stableMemoryAuthoritySignature, type MemoryViewMessage } from "./memory-view";

const [source, appSource, contextSource, styles, contextStyles] = await Promise.all([
  readFile(new URL("./memory-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./context-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./memory-view.css", import.meta.url), "utf8"),
  readFile(new URL("./context-view.css", import.meta.url), "utf8"),
]);

describe("unified Memory surface", () => {
  it("uses one query for recall, graph matching, and the embedded index", () => {
    expect(source).toContain("const memorySearch = useFederatedMemorySearch(query, searchMemory, memoryAuthority, !indexMounted || Boolean(contextGeneration), searchAttempt)");
    expect(source).toContain("<FederatedMemorySearch");
    expect(source).toContain("state={memorySearch}");
    expect(source).toContain("graph.search(normalizedQuery, { limit: 12 })");
    expect(source).toContain("searchQuery={query} sharedSearch={memorySearch}");
    expect(contextSource).toContain("sharedContextResult(sharedSearch, query, generationDigest)");
    expect(contextSource).toContain("workspace.generationDigest !== generationDigest");
    expect(source).toContain("const memoryAuthority = useMemo(() => ({}), [activeProfile, catalog, settledMessages, sessionId, workspaceAuthority])");
    expect(contextSource).not.toContain("The shared Memory query changed.");
    expect(source.match(/type="search"/gu)).toHaveLength(1);
    expect(source).not.toContain('role="tablist"');
  });

  it("keeps relationship and index potency behind native progressive disclosure", () => {
    // The two route sections, plus the hidden-node restore list — which is a
    // disclosure for the same reason they are: it exists only when it has
    // something to say, and it is the control that lifts what it reports.
    expect(source.match(/<details/gu)).toHaveLength(3);
    expect(source).toContain('id="memory-relationships"');
    expect(source).toContain('id="memory-index"');
    expect(source).toContain('<details class="memory-hidden-nodes">');
    expect(source).toContain("setHiddenMemoryNodeIds(new Set())}>Restore all");
    expect(source).toContain("graph.stats.componentCount");
    expect(source).toContain("groupMemoryRelationships(selectedEdges, relationshipLimit)");
    expect(source).toContain("<ContextView workspace={workspace} entries={files} embedded searchQuery={query} sharedSearch={memorySearch}");
    expect(source).toContain("if (open) setIndexMounted(true)");
    expect(source).toContain('indexRef.current?.scrollIntoView({ block: "start" })');
    expect(source).toContain('onReady={initialTab === "index" ? alignIndex : undefined}');
  });

  it("labels the shared control and every destination it updates", () => {
    expect(source).toContain('aria-labelledby="memory-title"');
    expect(source).toContain('aria-controls="memory-results memory-relationships memory-index"');
    // The page-sections nav and its jump to the Index are gone with the scope
    // strip. The shared search control still declares the three destinations it
    // updates, which is the labelling this test exists to protect.
    expect(source).not.toContain('aria-label="Memory page sections"');
    expect(source).not.toContain('href="#memory-');
    expect(contextSource).toContain('aria-label={embedded ? "Workspace context index" : undefined}');
  });

  it("describes remote, local-device, and ephemeral storage without inventing a Vault posture", () => {
    expect(source).toContain("Recall follows the selected storage mode");
    expect(source).toContain("Remote Vaults can serve encrypted ranges; Local Device and Ephemeral keep recall on-device.");
    expect(source).not.toContain("The selected Vault is the encrypted backbone");
  });

  it("provides stable desktop and touch layouts without a second route gutter", () => {
    expect(cssRule(styles, ".memory-view")).toContain("display: grid");
    expect(cssRule(styles, ".memory-view")).not.toMatch(/(?:^|;)\s*padding(?:-|:)/u);
    expect(styles).toContain("@media (max-width: 620px)");
    expect(styles).toContain("overflow-x: auto");
    /*
     * The iOS zoom guard, which used to be asserted as the literal `16px`.
     * It is `--fs-field` now — `max(16px, var(--fs-body))` — so the guard is
     * unchanged at every scale that would fall short of it and the field still
     * grows with the reader's Type scale preference above it. Asserting the
     * token rather than the number is what keeps both halves.
     */
    expect(cssRule(styles, ".memory-query input", "@media (max-width: 620px)")).toContain("font-size: var(--fs-field)");
  });

  /*
   * The three replacements for the retired `min-height: 150px` lane floor and
   * the 68px summary. Each is a stronger statement than the height it
   * replaces: a floor asserted that an empty scope should occupy 150px, which
   * is the defect. These assert that it must not.
   */
  it("lets a scope size to what it actually found", () => {
    const lanes = cssRule(styles, ".memory-view .memory-result-lanes");
    expect(lanes).toContain("align-items: start");
    expect(lanes).toContain("repeat(auto-fit, minmax(320px, 1fr))");
    expect(styles).not.toContain(".memory-lane-empty");
    // A scope with nothing in it is one 44px row that still names its corpus.
    // The word itself is the projection's, so a fourth lane state cannot be
    // added without a fourth definition beside the other three.
    expect(memoryLaneCountLabel("empty", 0)).toBe("No matches");
    expect(source).toContain("const count = memoryLaneCountLabel(state, lane.count);");
    expect(source).toContain('{state === "hits" ? <div class="memory-lane-hits">{lane.hits}</div> : null}');
    // A lane header and every hit control clear the touch floor.
    expect(cssRule(styles, ".memory-result-lane > header")).toContain("min-height: 44px");
    expect(cssRule(styles, ".memory-hit__open")).toContain("min-height: 44px");
    expect(cssRule(styles, ".memory-hit__more")).toContain("min-height: 44px");
    expect(cssRule(styles, ".memory-graph-query button")).toContain("min-height: 44px");
    // The `.memory-scope-rail` touch floor was asserted here until the strip
    // was removed: it restated counts the sections below already carry and
    // jumped to headings one scroll away. Search leads the route now.
    expect(styles).not.toContain(".memory-scope-rail");
  });

  /*
   * The rule this replaces was `.memory-summary-meta { font-size: 0 }` below
   * 620px, which did not compress "647 relationships" — it deleted it, on the
   * route whose entire argument is that it never hides anything.
   */
  it("never deletes a count at the phone breakpoint", () => {
    expect(styles).not.toMatch(/\.memory-summary-meta\s*\{[^}]*font-size:\s*0\s*[;}]/su);
    const phoneMeta = cssRule(styles, ".memory-summary-meta small");
    expect(phoneMeta).toContain("clip-path: inset(50%)");
    expect(phoneMeta).not.toContain("display: none");
    expect(source).toContain("<b>{normalizedQuery ? graphResults.length : graph.stats.edgeCount}</b>");
  });

  it("gives a hit a destination, its bounded text and its dropped fields", () => {
    // Nine fields the search service computed and the card threw away.
    for (const field of ["recordedAt", "sequence", "eventId", "textDigest", "createdAt", "profileRevisionAtCreation", "createdInSessionId", "denseScore", "lexicalScore"]) {
      expect(source, field).toContain(field);
    }
    // The 320-character cut was invisible and irreversible; the clamp is not.
    expect(source).not.toContain('memoryHitString(hit, "text").slice(0, 320)');
    expect(cssRule(styles, '.memory-hit__text[data-expanded="false"]')).toContain("-webkit-line-clamp: 4");
    expect(source).toContain("Show the full record (");
    // A destination is never labelled before it is bound.
    expect(source).toContain("onOpenSource || open.target.kind === \"message\"");
    expect(appSource).toContain("async function openMemorySource(target: MemorySourceTarget)");
    expect(appSource).toContain("onOpenSource={(target) => void openMemorySource(target)}");
    expect(appSource).toContain("await openFile(target.path)");
  });

  it("never announces an open for a source the workspace no longer holds", () => {
    // `openFile` reported its outcome only through state, so "did not throw"
    // was read as "opened" and a deleted path still announced `Opened …`.
    expect(appSource).toContain('async function openFile(path: string): Promise<"opened" | "missing" | "superseded">');
    expect(appSource).toContain('const outcome = await openFile(target.path);');
    expect(appSource).toContain('if (outcome === "missing") {');
    expect(appSource).toContain("That Memory source is no longer in the workspace: ${target.path}");
    // A superseded request belongs to the runtime that replaced it, so it says
    // nothing at all rather than claiming either outcome.
    expect(appSource).toContain('if (outcome === "superseded") return;');
  });

  it("states what was searched instead of three vague empty boxes", () => {
    expect(source).toContain("No memory matched");
    expect(source).toContain("Nothing was hidden, filtered, or ranked away.");
    expect(source).toContain("But the relationship graph has");
    // The ambiguous sentence printed three times is gone; the surviving
    // per-lane label names the scope it is talking about.
    expect(source).not.toContain('? "No matches in this scope."');
    expect(source).not.toContain('"Enter a query."');
    // Every group's ranking contract now renders; none of it did before.
    expect(source).toContain("group?.ranking");
    expect(source).toContain("legacyQuarantined");
    expect(source).toContain("duplicatesSuppressed");
  });

  it("opens the graph on the entities rather than on derived terms", () => {
    expect(source).toContain('DEFAULT_HIDDEN_KINDS: readonly MemoryNodeKind[] = Object.freeze(["term"])');
    expect(source).toContain("new Set(DEFAULT_HIDDEN_KINDS)");
    expect(source).toContain("derived terms are hidden from the picture. They are still in the graph, still searchable, and still counted above.");
    expect(source).toContain("Filters never alter memory.");
    // Amber is reserved for a state the user created, not for the default one.
    expect(source).toContain('hiddenMemoryNodeIds.size ? "memory-boundary attention" : "memory-boundary"');
  });
});

/*
 * During a live turn the chat transcripts rebuild the `messages` array once
 * per stream delta *and* mutate the live assistant row's text. Both
 * derivations on this route — the relationship graph and the federated search
 * authority — must update only on settled changes: a completed turn, an
 * appended message, a durable edit. `stableMemoryAuthoritySignature` is the
 * gate; these pin its contract.
 */
function chat(overrides: Partial<MemoryViewMessage> & { id: string }): MemoryViewMessage {
  return { role: "assistant", content: "", ...overrides };
}

describe("settled-turn message signature", () => {
  it("does not move while a turn is streaming", () => {
    const settled = [chat({ id: "u1", role: "user", content: "hello" })];
    const queued = [...settled, chat({ id: "a1", status: "Queued", content: "" })];
    const streaming = [...settled, chat({ id: "a1", status: "Thinking", content: "partial par" })];
    const moreStreaming = [...settled, chat({ id: "a1", status: "Streaming output", content: "partial partial answer" })];
    expect(stableMemoryAuthoritySignature(streaming)).toBe(stableMemoryAuthoritySignature(queued));
    expect(stableMemoryAuthoritySignature(moreStreaming)).toBe(stableMemoryAuthoritySignature(queued));
    // The same deterministic signature, not reference equality.
    expect(stableMemoryAuthoritySignature(streaming)).toBe(stableMemoryAuthoritySignature([...streaming]));
  });

  it("moves exactly when a turn settles, an append lands, or settled text is edited", () => {
    const before = [chat({ id: "u1", role: "user", content: "hello" }), chat({ id: "a1", status: "Queued", content: "" })];
    const after = [chat({ id: "u1", role: "user", content: "hello" }), chat({ id: "a1", content: "the answer" })];
    expect(stableMemoryAuthoritySignature(after)).not.toBe(stableMemoryAuthoritySignature(before));
    // An appended settled row changes it.
    const appended = [...after, chat({ id: "u2", role: "user", content: "next question" })];
    expect(stableMemoryAuthoritySignature(appended)).not.toBe(stableMemoryAuthoritySignature(after));
    // An edit to settled text changes it.
    const edited = [chat({ id: "u1", role: "user", content: "hello!" }), chat({ id: "a1", content: "the answer" })];
    expect(stableMemoryAuthoritySignature(edited)).not.toBe(stableMemoryAuthoritySignature(after));
    // A settled failure row changes it too — the answer is final even when it errored:
    // its error text belongs in the graph the same moment a successful one would.
    const failed = [chat({ id: "u1", role: "user", content: "hello" }), chat({ id: "a1", content: "Turn stopped" })];
    expect(isLiveMemoryMessage(failed[1]!)).toBe(false);
    expect(stableMemoryAuthoritySignature(failed)).not.toBe(stableMemoryAuthoritySignature(before));
  });

  it("reads the terminal turn record over the display status on local-tool rows", () => {
    // A settled local-tool row keeps its "Local result ·" display status
    // forever; the `completed` turn record is what says its text stopped
    // moving. Treating the status line as the live marker would mask the row
    // from the graph for the rest of the session.
    const settledLocal = chat({ id: "a1", status: "Local result · excluded from model context", content: "tool output", history: { turnStatus: "completed" } });
    const liveLocal = chat({ id: "a1", status: "Streaming run", content: "partial", history: { turnStatus: "incomplete" } });
    const liveNormal = chat({ id: "a2", status: "Queued", content: "" });
    const settledNormal = chat({ id: "a2", content: "done" });
    expect(isLiveMemoryMessage(settledLocal)).toBe(false);
    expect(isLiveMemoryMessage(liveLocal)).toBe(true);
    expect(isLiveMemoryMessage(liveNormal)).toBe(true);
    expect(isLiveMemoryMessage(settledNormal)).toBe(false);
    // A replayed incomplete turn has no status line; nothing mutates it any
    // more, so it counts as settled rather than being masked forever.
    expect(isLiveMemoryMessage(chat({ id: "a3", content: "partial answer", history: { turnStatus: "incomplete" } }))).toBe(false);
  });

  it("feeds both derivations from the masked projection, not the raw array", () => {
    expect(source).toContain("const messageSignature = stableMemoryAuthoritySignature(messages);");
    expect(source).toContain("const settledMessages = useMemo(");
    expect(source).toContain("[messageSignature],");
    // The graph no longer derives from the raw streaming array.
    expect(source).toContain("messages: settledMessages.map((message) => ({");
    expect(source).toContain("}, [activeProfile, catalog, files, settledMessages, sessionId]);");
    expect(source).not.toContain("}, [activeProfile, catalog, files, messages, sessionId]);");
    // Live rows reach the graph with empty text until their turn commits.
    expect(source).toContain('isLiveMemoryMessage(message)');
    expect(source).toContain('content: "", status: message.status');
  });
});

describe("embedded index surface", () => {
  it("replaces the index preamble with one status row that keeps every metric", () => {
    expect(contextSource).toContain('aria-label="Context index status"');
    expect(contextSource).toContain("aria-expanded={statusExpanded}");
    for (const metric of ["State", "Candidates", "Chunks", "Refresh", "Vector memory"]) {
      expect(contextSource, metric).toContain(`label="${metric}"`);
    }
    // Both embedding paragraphs and the shared-runtime note survive verbatim.
    expect(contextSource).toContain("They are deterministic test/bootstrap signals, not semantic understanding.");
    expect(contextSource).toContain("WebGPU is preferred; WASM is the automatic fallback.");
    expect(contextSource).toContain("This screen, the search_context tool, and automatic turn grounding use the same memory-only generation.");
    // …and the caveat is promoted to a visible caution once it is load-bearing.
    expect(contextSource).toContain("These results were ranked with deterministic test/bootstrap signals, not semantic understanding.");
    expect(cssRule(contextStyles, ".context-index-status__toggle")).toContain("min-height: 44px");
    expect(contextStyles).toMatch(/\.embedding-engine-actions button \{[^}]*min-height: 44px/su);
  });

  /*
   * `#context` is the Index's own destination, so it lands on the full status.
   * Inside `#memory` the index is one disclosure among three and the compact
   * row is the point. Both states carry the same five metrics.
   */
  it("keeps the deep-linked Index landing on its full status", () => {
    expect(contextSource).toContain("useState(detailExpanded)");
    expect(source).toContain('detailExpanded={initialTab === "index"}');
    expect(source).toContain("setRelationshipsExpanded(false)");
  });

  /*
   * Measured: with the index open at 430px the status block was 548px wide and
   * pushed `main` 153px sideways, because a grid child's default
   * `min-width: auto` is the intrinsic width of the longest unbreakable thing
   * inside it — a 51-character sha256 in a `white-space: nowrap` status line.
   */
  it("stops a digest from widening the index past a phone viewport", () => {
    const guard = contextStyles.slice(contextStyles.indexOf(".client-context-view > *"));
    for (const selector of [".client-context-layout > *", ".context-index-status > *", ".context-index-status__row > *", ".context-hit > *"]) {
      expect(guard.slice(0, guard.indexOf("}")), selector).toContain(selector);
    }
    expect(guard.slice(0, guard.indexOf("}") + 1)).toContain("min-width: 0");
    // …and nothing on this route clips a chip's own disclosure shut.
    expect(cssRule(styles, ".memory-view .memory-result-lane")).toContain("overflow: visible");
    expect(cssRule(styles, ".memory-view .memory-lane-hits")).toContain("overflow: visible");
    expect(cssRule(contextStyles, ".context-candidate-list,\n.context-hit-list")).not.toContain("overflow: auto");
  });

  it("files a candidate's lineage instead of printing it at full length per card", () => {
    // Degraded-first ordering now travels inside the bounded window, so the
    // rule and the cut cannot be applied by two different call sites.
    expect(contextSource).toContain("const ordered = orderCandidates(candidates);");
    expect(contextSource).toContain("contextCandidateWindow(generation?.candidates ?? [], candidatePages)");
    expect(contextSource).toContain("{renderProvenance(workspaceBaseName(candidate.path), rows)}");
    expect(contextSource).not.toContain('<dl class="context-exact-record">');
    expect(contextSource).not.toContain("exact chunk identifier");
    // A degraded row still states its reason where it stands.
    expect(contextSource).toContain("{degraded ? <p>{candidate.reason}</p> : null}");
  });

  it("promotes the sentence that says why a hit matched and stops repeating the generation", () => {
    expect(contextSource).toContain('class="context-hit__why"');
    expect(contextSource).toContain("whyMatched(hit.denseScore, hit.lexicalScore)");
    expect(contextSource).toContain("Show the whole chunk (");
    expect(contextSource).not.toContain('<dl class="context-query-lineage">');
    expect(contextSource).toContain("<dt>Query digest</dt>");
    expect(contextSource).toContain('inheritedRow("Generation", generationDigest, "the Index lineage panel")');
    // The chip crosses this boundary as a prop, never as a runtime import: the
    // two importers would merge the graph's kind-visual chunk away.
    expect(contextSource).toContain('import type { ProvenanceRow } from "./provenance-chip"');
    expect(contextSource).not.toMatch(/import \{[^}]*ProvenanceChip[^}]*\} from "\.\/provenance-chip"/u);
    expect(source).toContain("renderProvenance={(subject, rows) => <ProvenanceChip subject={subject} rows={rows} />}");
    // The 72/28 split only existed on the standalone route's label before.
    expect(contextSource).toContain("72% deterministic dense score · 28% lexical overlap. Hybrid score within this corpus only");
  });

  /**
   * A state slot holds a state; an empty panel ends in a verb.
   *
   * These are the two failures the last pass left on this route: the graph
   * inspector's heading printed the instruction "select a node" where the
   * reader looks for what is currently true, and every empty panel described
   * its own absence and stopped. Both are honesty questions as much as layout
   * ones — an accurate dead end is still a dead end.
   */
  it("states what is true rather than instructing, and every empty panel offers the action it is describing", () => {
    expect(source).toContain('{selectedNode ? selectedNode.kind : "nothing selected"}');
    expect(source).not.toContain('selectedNode.kind : "select a node"');
    // The retired placeholder's own sentence keeps its documented fate as the
    // overview panel's footer, so the words survive where they read as help —
    // and it now names controls that exist rather than a bare "zoom" that only
    // a mouse wheel could reach.
    expect(source).toContain("Drag to pan, pinch or use Zoom in · Zoom out · Fit above the graph, search, or select a node to inspect relationships and source metadata.");
    expect(source).toContain('<div class="memory-graph-controls" role="group" aria-label="Graph viewport">');

    // The unsearched recall state offers terms this page can prove it holds.
    expect(source).toContain("{!state.query && starters.length ? <MemoryStarters");
    expect(source).toContain("no search history is kept");
    expect(source).toContain('push(dot > 0 ? base.slice(0, dot) : base, "workspace source")');
    expect(source).toContain('push(profileName, "active profile")');

    // The Index panels reach the field they are describing rather than naming it.
    expect(contextSource).toContain('action={{ label: embedded ? "Search memory" : "Search the active generation"');
    expect(contextSource).toContain('action={{ label: "Change the query", onAct: () => focusContextQuery(embedded) }}');
    expect(contextSource).toContain('document.getElementById(embedded ? "memory-query-input" : "client-context-query")');
    // Staging is the engine's own work, so that state stays without a button:
    // a verb there would name an action the reader does not have.
    expect(contextSource).toContain('{...(entries.length ? {} : { action: { label: "Open the workspace"');
  });

  it("says the shared query is followed once instead of a card that restates the field above it", () => {
    expect(contextSource).not.toContain('class="context-managed-search"');
    expect(contextSource).not.toContain("<span>Shared Memory query</span>");
    // The sentence, the live region and the query it is bound to all survive.
    // The region also carries an accessible name now: the label pair it replaced
    // was the only name the shared-query binding had, and dropping it left the
    // region addressable only by its text.
    expect(contextSource).toContain('class="context-shared-status"');
    expect(contextSource).toContain('role="status"');
    expect(contextSource).toContain('aria-label="Shared Memory query in the workspace index"');
    expect(contextSource).toContain("managedSearchStatusText(query, engineState.phase, searchStatus, searchResult)");
    expect(contextSource).toContain("Following “{query.trim().slice(0, 160)}”");
    expect(styles).toContain(".memory-view .context-shared-status {");
    expect(styles).not.toContain(".memory-view .context-managed-search");
  });

  it("stops the Index clipping its own panel names and its own embedding engine", () => {
    // `AUTOMATIC DISCO…` beside `Vectorization candi…`, and `4.5 Ki…` on a
    // phone, were a route that never hides anything hiding four facts.
    expect(cssRule(contextStyles, ".context-surface-heading h2")).toContain("overflow-wrap: anywhere");
    expect(cssRule(contextStyles, ".context-surface-heading h2")).not.toContain("white-space: nowrap");
    expect(cssRule(contextStyles, ".context-index-status__toggle > span:not(.context-index-status__dot)"))
      .not.toContain("text-overflow: ellipsis");
  });
});

/**
 * The body of `selector`'s rule, optionally the one *after* `after` — which is
 * how a media-query override is distinguished from the base rule of the same
 * selector without parsing the sheet.
 */
function cssRule(sourceText: string, selector: string, after?: string): string {
  const from = after ? sourceText.indexOf(after) : 0;
  expect(from, `missing ${after}`).toBeGreaterThanOrEqual(0);
  const start = sourceText.indexOf(`${selector} {`, from);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = sourceText.indexOf("{", start) + 1;
  return sourceText.slice(bodyStart, sourceText.indexOf("}", bodyStart));
}

/*
 * A rejected search must not be spoken as three empty corpora.
 *
 * Measured: on rejection the state carries `status` and no `result`, so
 * `settled` is false, the honest `MemoryNoMatchPanel` is skipped, and all three
 * lanes fall through to "No matches" — telling a reader that their
 * conversation, their profile memory and their workspace index contain nothing
 * matching, on a route whose stated contract is "Nothing was hidden, filtered,
 * or ranked away". No network fault is needed: `searchMemoryForUi` throws "The
 * active accountable session is not ready." when no session is bound and
 * "Federated memory search is not installed in this agent runtime." when the
 * tool is absent.
 */
describe("federated memory search failure", () => {
  const authority = {};
  const failedState = { authority, query: "ledger", status: "The active accountable session is not ready.", searching: false } as FederatedMemorySearchState;

  it("tells a rejection apart from a settled zero-hit result", () => {
    expect(memorySearchFailed(failedState)).toBe(true);
    expect(memorySearchFailed({ authority, query: "ledger", searching: true, status: "Searching three client-owned agent corpora…" } as FederatedMemorySearchState)).toBe(false);
    expect(memorySearchFailed({ authority, query: "", searching: false } as FederatedMemorySearchState)).toBe(false);
    // A real zero-hit answer carries a result, so it stays the empty state.
    expect(memorySearchFailed({ authority, query: "ledger", searching: false, result: { groups: [] } } as unknown as FederatedMemorySearchState)).toBe(false);
  });

  it("never lets a lane claim a corpus was searched and held nothing", () => {
    const failed = memoryLaneState({ searching: false, failed: true, count: 0, query: "ledger" });
    expect(failed).toBe("failed");
    expect(memoryLaneCountLabel(failed, 0)).toBe("Not searched — the query failed");
    expect(memoryLaneCountLabel(failed, 0)).not.toBe(memoryLaneCountLabel("empty", 0));
    expect(memoryLaneCountLabel("empty", 0)).toBe("No matches");
  });

  it("keeps every other lane state exactly as it was", () => {
    expect(memoryLaneState({ searching: true, failed: false, count: 0, query: "ledger" })).toBe("searching");
    expect(memoryLaneState({ searching: false, failed: false, count: 3, query: "ledger" })).toBe("hits");
    expect(memoryLaneState({ searching: false, failed: false, count: 0, query: "ledger" })).toBe("empty");
    expect(memoryLaneState({ searching: false, failed: false, count: 0, query: "" })).toBe("idle");
    // No count slot before a query: "0 results" on an unsearched corpus reads
    // as "nothing is in there", which is a claim nobody has made yet.
    expect(memoryLaneCountLabel("idle", 0)).toBeUndefined();
    expect(memoryLaneCountLabel("hits", 1)).toBe("1 result");
    expect(memoryLaneCountLabel("hits", 4)).toBe("4 results");
  });

  it("states the failure once, assertively, beside a control that re-runs it", () => {
    expect(source).toContain("const failed = memorySearchFailed(state);");
    expect(source).toContain('role={failed ? "alert" : "status"}');
    expect(source).toContain('{failed ? <button class="small-button memory-search-retry" type="button" onClick={onRetry}>Retry search</button> : null}');
    // The nonce is a dependency of the search effect, so the identical query
    // re-runs — before this the only recovery was to retype a different term.
    expect(source).toContain("onRetry={() => setSearchAttempt((value) => value + 1)}");
    expect(source).toContain("}, [attempt, authority, enabled, query, search]);");
    // The lane words come from one projection, not from a ternary chain that
    // can grow a fourth answer without a fourth definition.
    expect(source).toContain("const state = memoryLaneState({ searching, failed, count: lane.count, query });");
    expect(source).not.toContain('state === "empty" ? "No matches"');
  });

  it("still renders the honest zero-hit panel for a genuine empty result", () => {
    expect(source).toContain("const settled = Boolean(state.query) && !state.searching && Boolean(result);");
    expect(source).toContain("{settled && total === 0\n      ? <MemoryNoMatchPanel");
    expect(source).toContain("<p>Nothing was hidden, filtered, or ranked away.</p>");
  });
});
