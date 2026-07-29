import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [source, appSource, contextSource, styles, contextStyles] = await Promise.all([
  readFile(new URL("./memory-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./context-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./memory-view.css", import.meta.url), "utf8"),
  readFile(new URL("./context-view.css", import.meta.url), "utf8"),
]);

describe("unified Memory surface", () => {
  it("uses one query for recall, graph matching, and the embedded index", () => {
    expect(source).toContain("const memorySearch = useFederatedMemorySearch(query, searchMemory, memoryAuthority, !indexMounted || Boolean(contextGeneration))");
    expect(source).toContain("<FederatedMemorySearch");
    expect(source).toContain("state={memorySearch}");
    expect(source).toContain("graph.search(normalizedQuery, { limit: 12 })");
    expect(source).toContain("searchQuery={query} sharedSearch={memorySearch}");
    expect(contextSource).toContain("sharedContextResult(sharedSearch, query, generationDigest)");
    expect(contextSource).toContain("workspace.generationDigest !== generationDigest");
    expect(source).toContain("[activeProfile, catalog, messages, sessionId, workspaceAuthority]");
    expect(contextSource).not.toContain("The shared Memory query changed.");
    expect(source.match(/type="search"/gu)).toHaveLength(1);
    expect(source).not.toContain('role="tablist"');
  });

  it("keeps relationship and index potency behind native progressive disclosure", () => {
    expect(source.match(/<details/gu)).toHaveLength(2);
    expect(source).toContain('id="memory-relationships"');
    expect(source).toContain('id="memory-index"');
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
    expect(source).toContain('state === "empty" ? "No matches"');
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
    expect(contextSource).toContain("orderCandidates(generation.candidates)");
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
    // overview panel's footer, so the words survive where they read as help.
    expect(source).toContain("Pan, zoom, search, or select a node to inspect relationships and source metadata.");

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
