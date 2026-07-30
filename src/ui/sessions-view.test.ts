import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [source, styles] = await Promise.all([
  readFile(new URL("./sessions-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sessions-view.css", import.meta.url), "utf8"),
]);

/**
 * The library and its detail pane must agree about what is in scope.
 *
 * Measured: filter to zero results and the pane kept rendering the previously
 * selected conversation with `Fork to continue`, `Fork` and `Rename` all
 * enabled — three state-mutating verbs offered beside a list saying "No
 * matching conversations". That is a correctness hazard, not a cosmetic one:
 * a fork writes a new session identity and manifest.
 */
describe("conversation library scope", () => {
  it("detects the out-of-scope selection from the page it actually rendered", () => {
    expect(source).toContain("const outOfResults = Boolean(page && selectedId && filterActive && !page.items.some((item) => item.id === selectedId))");
    expect(source).toContain("outOfResults={outOfResults}");
  });

  it("says the pane is out of scope, and offers the control that puts it back", () => {
    expect(source).toContain('<div class="session-library-out-of-results" role="status">');
    expect(source).toContain("{SESSION_OUT_OF_RESULTS_NOTICE}");
    expect(source).toContain("Clear filters and show it");
  });

  it("withdraws every mutating verb and no read-only one", () => {
    expect(source).toContain("const mutationBlocked = busy || outOfResults;");
    expect(source).toContain("disabled={mutationBlocked || renaming}");
    expect(source).toContain('onClick={onPrepareFork} disabled={mutationBlocked}');
    expect(source).toContain("const resumeDisabled = mutationBlocked || active");
    // Proof and the disclosures stay live: the facts on the pane are real and
    // the reader may still want them.
    expect(source).toContain("<button type=\"button\" onClick={onOpenProof}>");
    expect(source).toContain("{outOfResults ? <p class=\"session-library-actions-caption\">{SESSION_OUT_OF_RESULTS_CAPTION}</p> : null}");
  });
});

describe("conversation library empty states", () => {
  it("names the term, the scope and the size, and ends in a control", () => {
    expect(source).toContain("const emptyState = sessionEmptyState({ filtered: filterActive, query: search");
    expect(source).toContain("<strong>{emptyState.heading}</strong>");
    expect(source).toContain('{emptyState.offersClear ? (\n                  <button class="session-library-empty-action" type="button" onClick={clearFilters}>Clear filters</button>');
  });

  it("only claims a searched size it actually read, and only from an unfiltered read", () => {
    expect(source).toContain("if (!search && !providerId && !model) setLoadedTotal(next.total);");
    expect(source).toContain("loadedTotal === undefined ? {} : { loadedTotal }");
  });

  it("keeps the ordinary ledger inside the active profile", () => {
    expect(source).toContain("profileId: scopeProfileId");
    expect(source).toContain("Profile · {scopeProfileName}");
    expect(source).toContain("current && next.items.some((item) => item.id === current)");
    expect(source).not.toContain('label: "All profiles"');
    expect(source).not.toContain('ariaLabel="Filter by profile"');
  });

  it("gives the empty detail pane the conversation it is standing next to", () => {
    expect(source).toContain("<strong>No conversation open</strong>");
    expect(source).toContain("onClick={() => setSelectedId(ordered[0]!.id)}");
  });
});

describe("fork legibility", () => {
  it("states why the runtime requires a fork, where the fork is decided", () => {
    expect(source).toContain("const requirement = forkRequirement(compatibility, detail.history);");
    expect(source).toContain("Why this needs a fork · {requirement.label}");
    // One rendering of the reasons, used by the integrity expansion and by the
    // fork panel, so the two cannot drift apart.
    expect(source.match(/<ReasonList reasons=\{requirement\.reasons\} \/>/gu)).toHaveLength(2);
    expect(source).toContain('<section class={`session-library-compatibility ${compatibility.action}`}');
  });

  it("makes the transcript findable by its size, since it lives only in that disclosure", () => {
    expect(source).toContain("Manifest pins and transcript · {detail.transcript.messages.length} message");
  });

  it("traces an Unfinished verdict to the observations that produced it", () => {
    expect(source).toContain("structural observation${detail.history.issues.length === 1 ? \"\" : \"s\"} below");
  });

  /*
   * The panel described the pre-seed contract.
   *
   * `historyCopied: false` is true of the journal and was being read as "the
   * model starts from nothing", so the panel promised an empty transcript while
   * forkSession seals and commits a bounded ancestor-context seed on every
   * fork. The copy has to describe what the button actually does.
   */
  it("states that the branch inherits bounded ancestor context, not a blank slate", () => {
    expect(source).not.toContain("empty transcript");
    expect(source).not.toContain("clean fork");
    expect(source).toContain("The branch inherits a bounded, digest-sealed copy of the ancestor context");
    expect(source).toContain('{busy ? "Creating…" : "Create fork"}');
  });

  /*
   * The downward half of lineage has to say the same thing the upward half
   * does.
   *
   * "Forked from X at head 12" told a branch where it came from; the
   * "Alternates (N)" list under the *source* named only titles and branch
   * times, so three retries of one turn and three branches of three different
   * turns rendered as the same list. The sequence is read from each branch's
   * own `sourceHeadSequence`, which is the manifest commitment the upward line
   * reads, so the two directions cannot disagree.
   */
  it("states the fork point on every alternate, in the branch's own words", () => {
    expect(source).toContain("`branched at head ${branch.sourceHeadSequence}`");
    // Both the visible caption and the link's accessible name carry it: the
    // list is navigated by name from a screen reader, where the caption that
    // follows the button is not part of the choice being made.
    expect(source).toContain("aria-label={`Open the branch ${branch.title}${branch.sourceHeadSequence === undefined ? \"\" : `, branched at head ${branch.sourceHeadSequence}`}`}");
    // No invented sequence when the commitment is missing.
    expect(source).toContain('branch.sourceHeadSequence === undefined ? "fork point unrecorded"');
  });
});

describe("conversation library keyboard focus", () => {
  /*
   * The borderless-input-in-a-bordered-shell pattern moves the ring to the
   * wrapper. Sessions copied only the `outline: 0` half, so a keyboard user
   * tabbing into the filter field got no indication at all.
   */
  it("pairs every suppressed input outline with a ring on its wrapper", () => {
    const suppressions = styles.match(/outline:\s*0\s*;/gu) ?? [];
    expect(suppressions.length).toBeGreaterThan(0);
    const rings = styles.match(/:focus-(?:within|visible)\s*\{/gu) ?? [];
    expect(rings.length).toBeGreaterThanOrEqual(suppressions.length);
    expect(styles).toContain(".session-library-search:focus-within {");
  });
});

describe("conversation library below the full-width toolbar", () => {
  it("wraps the filter row instead of scrolling three controls off the edge", () => {
    const narrow = styles.slice(styles.indexOf("@media (max-width: 1180px)"));
    expect(narrow).toContain("flex-wrap: wrap;");
    expect(narrow).toContain("overflow-x: visible;");
    expect(narrow).not.toContain("overflow-x: auto;");
  });

  /*
   * Sort had no second home.
   *
   * The 1180px rule shed `.session-library-sort-menu` to relieve the six-track
   * grid, and nothing above 860px put it back — so on a 1024px laptop the only
   * ordering control on the route did not exist, and a `Title A-Z` already
   * chosen could be neither seen nor undone.
   */
  it("never hides the only ordering control at any width", () => {
    // Assert the hook still exists first: without it the CSS assertion below
    // passes for the wrong reason, and the guard would go quiet exactly when
    // someone renames the control on the way to restyling it.
    expect(source).toContain('className="session-filter-menu session-library-sort-menu"');
    expect(styles).not.toContain(".session-library-sort-menu {");
  });

  it("lets Clear undo the sort, since sort is one of the reader's choices", () => {
    expect(source).toContain('const clearable = filterActive || sort !== "updated-desc";');
    expect(source).toContain('{clearable ? <button type="button" onClick={clearFilters}>Clear</button> : null}');
    expect(source).toContain('setSort("updated-desc");');
    // `filterActive` still means "rows were withheld", which is what words the
    // empty state and decides whether a selection is out of scope.
    expect(source).toContain("const filterActive = Boolean(search || providerId || model);");
  });

  it("marks the matched run without rewriting the title", () => {
    expect(source).toContain("titleMatchSegments(item.title, search)");
    expect(styles).toContain(".session-library-card-top mark {");
  });
});
