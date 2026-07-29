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
});

describe("conversation library at a phone width", () => {
  it("wraps the filter row instead of scrolling three controls off the edge", () => {
    const phone = styles.slice(styles.indexOf("@media (max-width: 860px)"));
    expect(phone).toContain("flex-wrap: wrap;");
    expect(phone).toContain("overflow-x: visible;");
    expect(phone).not.toContain("overflow-x: auto;");
  });

  it("marks the matched run without rewriting the title", () => {
    expect(source).toContain("titleMatchSegments(item.title, search)");
    expect(styles).toContain(".session-library-card-top mark {");
  });
});
