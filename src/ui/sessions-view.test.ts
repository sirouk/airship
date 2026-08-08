import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SESSION_LIBRARY_PAGE_SIZE, sessionListBound } from "./sessions-view";

const [source, styles] = await Promise.all([
  readFile(new URL("./sessions-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sessions-view.css", import.meta.url), "utf8"),
]);
const appSource = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

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
  /*
   * A background write must not throw away what someone is typing.
   *
   * The detail effect re-runs on `refresh` and on the host's `revision`, and it
   * closed the rename field and the fork panel on every one of those — so a
   * turn completing, or a vault appending, discarded a half-typed title. It is
   * also what made the rename journey flaky: Playwright reported "element is
   * not stable ... element was detached from the DOM" on the Save button in
   * roughly two runs of five, which is the same event a person gets as a click
   * that does nothing.
   *
   * Asserted against the source because the reset is a control-flow property of
   * one effect, and the browser journey that proves the behaviour end to end is
   * `e2e/vault-auto-adoption.spec.ts` ("a renamed conversation still adopts its
   * vault"), green 6/6 after this.
   */
  it("closes open editors only when the conversation changes, not on every refresh", () => {
    const source = readFileSync(new URL("./sessions-view.tsx", import.meta.url), "utf8");
    const GUARD = "if (openEditorsFor.current !== selectedId) {";
    expect(source).toContain(GUARD);
    // The guard has to hold both editors; guarding one and not the other is the
    // half-fix that would look right and still lose a fork panel.
    const body = source.slice(source.indexOf(GUARD) + GUARD.length);
    const guarded = body.slice(0, body.indexOf("\n    }"));
    expect(guarded).toContain("setRenaming(false)");
    expect(guarded).toContain("setForkOpen(false)");
    /*
     * And the detail effect may not reset them anywhere else. Resets elsewhere
     * are legitimate — after a rename or fork succeeds, and the two explicit
     * Cancel handlers — so this is scoped to the effect that re-runs on every
     * background write rather than counting the whole file.
     */
    const effect = source.slice(
      source.indexOf("const controller = new AbortController();"),
      source.indexOf("}, [library, refresh, revision, runtimeKey, selectedId]);"),
    );
    expect(effect).toContain(GUARD);
    expect([...effect.matchAll(/setRenaming\(false\)/gu)],
      "an ungated reset in this effect reintroduces the defect").toHaveLength(1);
    expect([...effect.matchAll(/setForkOpen\(false\)/gu)],
      "an ungated reset in this effect reintroduces the defect").toHaveLength(1);
  });

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

describe("conversation deletion scope", () => {
  it("refreshes the shell projections and makes proof cleanup an explicit second scope", () => {
    expect(source).toContain("onDeleted?: (sessionId: string, removeEvidence: boolean) => void | Promise<void>;");
    expect(source).toContain("await onDeleted?.(deletedId, removeEvidence);");
    expect(source).toContain('checked={removeEvidence}');
    expect(source).toContain("Also remove this conversation’s endpoint evidence and pending evidence checks.");
    expect(source).toContain("Leave this unchecked to keep its separately stored Proof evidence history.");
    // A failed optional cleanup must not resurrect a journal row that was
    // already removed; the announcement names the partial result instead.
    expect(source).toContain("endpoint evidence was kept because cleanup failed.");
    expect(appSource).toContain("async function adoptLibraryDelete(deletedSessionId: string, removeEvidence: boolean)");
    expect(appSource).toContain("onDeleted={adoptLibraryDelete}");
    expect(appSource).toContain("setSessionRevision((value) => value + 1);");
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
   *
   * The pairing itself is proven by `focus-suppression-pairing.test.ts`, which
   * parses every route stylesheet into rules and requires each suppression to
   * have a focus rule anchored on the same component — including this file's
   * `.session-library-search input`, named there by selector. What lived here
   * was a count comparison (`rings.length >= suppressions.length`) that read
   * only the `outline: 0` spelling and never tied a ring to the element whose
   * outline was suppressed, so it went green for `outline: none` anywhere and
   * for a ring on an unrelated element. What is left is the one fact this file
   * is the right place to hold: which element the filter field's ring moved to.
   */
  it("draws the filter field's ring on the wrapper it was moved to", () => {
    const wrapper = ruleBody(".session-library-search:focus-within");
    expect(wrapper, "the wrapper ring the input's outline: 0 promises").toBeDefined();
    expect(wrapper).toMatch(/(?:outline|box-shadow|border-color)\s*:/u);
    // And the suppression is still the reason the ring is on the wrapper: if the
    // input regains its own outline this becomes a double ring, not a fix.
    expect(ruleBody(".session-library-search input")).toMatch(/outline:\s*(?:0|none)\s*;/u);
  });
});

/** The declarations of one top-level rule, by exact selector. */
function ruleBody(selector: string): string | undefined {
  const open = styles.indexOf(`${selector} {`);
  if (open < 0) return undefined;
  return styles.slice(open + selector.length + 2, styles.indexOf("}", open));
}

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

  /*
   * The row is an opener, not only a selector.
   *
   * Measured: single click, double click and Enter on a conversation row all
   * left `location.hash` at "#sessions". The only opener was "Resume
   * conversation" in the detail pane, which on a 390x844 phone rendered at
   * y=791 — under the bottom tab bar.
   */
  it("gives every row a one-press opener and the gestures a list of documents binds", () => {
    expect(source).toContain('class="session-library-open"');
    expect(source).toContain("onClick={() => void openSession(item.id)}");
    expect(source).toContain("onDblClick={() => void openSession(item.id)}");
    expect(source).toContain('if (event.key === "Enter" && item.id === selectedId && item.id !== activeSessionId) {');
    // A refusal selects the row so the pane that explains it is what appears,
    // rather than failing silently at the button that was pressed.
    expect(source).toContain('setDetailError(fresh.compatibility?.label ?? "This conversation cannot be resumed in the current runtime.");');
    expect(styles).toContain(".session-library-open {");
  });

  it("marks the matched run without rewriting the title", () => {
    expect(source).toContain("titleMatchSegments(item.title, search)");
    expect(styles).toContain(".session-library-card-top mark {");
  });
});

/*
 * What a row and a pane are allowed to spend their width and height on.
 *
 * Every case below was measured on a screenshot of the running route, and every
 * one of them is a rule that reserved space for something the reader could not
 * use — a hidden control, a floor taller than the viewport, a field's own
 * min-content — and took it out of the one thing on that line they were reading.
 */
describe("conversation library space budget", () => {
  /*
   * Measured at 1440px: the same conversation read "Investigate th…" in RECENT
   * and "Inv…" under FAVORITES, in a card of identical width, with a band of
   * empty row between the Active verb and the star. `opacity: 0` hides a
   * control; it does not stop it holding 66px of a 330px panel.
   */
  it("collapses the hidden reorder cluster instead of reserving its width", () => {
    const rest = ruleBody(".session-library-favorite-order");
    expect(rest).toContain("width: 0;");
    expect(rest).toContain("opacity: 0;");
    expect(rest).toContain("overflow: hidden;");

    const revealed = styles.slice(styles.indexOf(".session-library-row:hover .session-library-favorite-order,"));
    expect(revealed.slice(0, revealed.indexOf("}"))).toContain("width: auto;");

    /*
     * And a pointer with no hover has to be given the box back. A collapse the
     * coarse-pointer rule does not undo turns a control that was merely
     * invisible into one with nothing to press — a worse failure than the
     * starved title this collapse exists to fix.
     */
    const coarse = styles.slice(styles.lastIndexOf("@media (pointer: coarse)"));
    const reopened = coarse.slice(coarse.indexOf(".session-library-favorite-order {"));
    expect(reopened).toContain("width: auto;");
    expect(reopened.slice(0, reopened.indexOf("}"))).toContain("opacity: 1;");
  });

  /*
   * Measured at 1440px and 1920px alike: the second line read
   * "Active · 23 events · general · a" and stopped. The model was squeezed to
   * about 18px, which is narrower than its own ellipsis, so the row lost its
   * last discriminating fact and read as a rendering fault rather than as an
   * abbreviation.
   */
  it("spends the row's last line on the model, not on the scope the toolbar already names", () => {
    const profile = ruleBody(".session-library-card-profile");
    expect(profile).toContain("min-width: 4ch;");
    expect(profile).toContain("overflow: hidden;");
    expect(profile).toContain("text-overflow: ellipsis;");

    /*
     * The model stays the item that absorbs what is left, with no floor of its
     * own on purpose: a `min-width` here can exceed what the other three facts
     * leave on a 260px panel, and `.session-library-card-line2` clips — taking
     * the ellipsis with it and restoring the one-bare-letter reading.
     */
    expect(ruleBody(".session-library-card-model")).toContain("min-width: 0;");
    expect(ruleBody(".session-library-card-line2")).toContain("overflow: hidden;");
  });

  /*
   * …and tuning that shrink order was never going to be enough, because the
   * column it shrinks inside was 330px at 1024px, at 1440px and at 1920px
   * alike. Measured at 1920px: the layout stopped at x=1655 with the list still
   * 330px, the detail pane beside it 828px wide and empty below y=490, and the
   * row's second line reading "Active  23 events  ge…  a…" — two facts reduced
   * to two characters each next to several hundred pixels of unused canvas.
   *
   * Two rules answer it, and the pair is the point: the column grows where
   * there is width to grow into, and the line wraps where there is not.
   */
  it("lets the list column grow with the canvas instead of pinning it to 330px", () => {
    const layout = ruleBody(".session-library-layout") ?? "";
    expect(layout).toContain("grid-template-columns: minmax(260px, clamp(330px, 38%, 430px)) minmax(0, 1fr);");

    /*
     * The floor of the clamp is what stops this from being a raid on the detail
     * pane at widths where the pane is the scarce one. Lowering that floor would
     * take width from a pane that has none to give.
     *
     * It was once claimed here that the floor also protects the narrow two-pane
     * widths outright, because 38% does not reach 330px until the container is
     * about 868px. That is the right threshold and the wrong conclusion: every
     * two-pane container in the sweep is above it (905px at 932x430, 917px at
     * 1024px, the nav rail accounting for why those are so close), so the floor
     * protects neither. The landscape phone is protected by the rule pinned in
     * the test below instead.
     */
    expect(layout, "the growth may never drop the column below the width it has today")
      .toMatch(/clamp\(330px,/u);
    /*
     * And the second track has to stay allowed to shrink, or the first one's
     * new maximum is bought by overflowing the panel rather than by the detail
     * pane yielding.
     */
    expect(layout).toContain("minmax(0, 1fr)");
  });

  /*
   * Below that 868px container the column cannot grow, so the line has to be
   * able to answer the deficit some other way than shrinking the model — which
   * is the only thing `flex-wrap: nowrap` left it able to do, and the reason
   * the model still read as one character at laptop widths after the shrink
   * order was corrected. Flex lines are broken at content size before any item
   * is shrunk, so in the two-pane layout the model drops to its own line whole:
   * measured at 1024x768 it reads `airship/demo-v1` entire.
   */
  it("wraps the row's last line rather than grinding the model down to a character", () => {
    const twoPaneAndTall =
      styles.match(/@media \(min-width: 861px\) and \(min-height: 561px\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
    expect(twoPaneAndTall).toContain(".session-library-card-line2");
    expect(twoPaneAndTall).toContain("flex-wrap: wrap;");
    /*
     * `white-space: nowrap` has to survive alongside it. It governs text inside
     * each fact, not the flex line, so it is what keeps a break falling between
     * "23 events" and the model rather than inside either of them.
     */
    expect(ruleBody(".session-library-card-line2")).toContain("white-space: nowrap;");
  });

  /*
   * …and that wrap has to stay an exception, because a second line is only a
   * wider line where a column sets the line's width. Below 861px the route is a
   * single column and the line's width is set by the row's sibling tracks — the
   * opener, the state pill, the star, and the reorder cluster that is held open
   * from 560px down because touch has no hover to expand it. Wrapping moves
   * none of them. Measured at 320px on a favourited row it split one ~160px
   * line into three ~50px ones, so `24 events` came out `24 eve`, `general`
   * came out `gen…` and `airship/demo-v1` came out `air…` — strictly more
   * truncation than the line it replaced.
   *
   * And the ~19px it costs comes out of whatever sits below the list. At
   * 932x430 that was the favourited row's entire right-hand control cluster —
   * the pill's label, the drag handle, ↑, ↓ and the unstar — carried below the
   * mobile tab bar, which is a control made unreachable to abbreviate a fact
   * less. That trade only ever runs one way.
   */
  it("does not wrap the line where a second line cannot be a wider one", () => {
    expect(
      ruleBody(".session-library-card-line2"),
      "the unconditional wrap put five hit targets below the fold at 932x430",
    ).toContain("flex-wrap: nowrap;");

    /*
     * The gate is two conditions and needs both. Width alone would still wrap
     * the 932x430 phone held sideways, which is where the controls were lost;
     * height alone would still wrap every phone, which is where the facts
     * truncated harder. Assert the conjunction, not merely that a query exists.
     */
    expect(styles).toContain("@media (min-width: 861px) and (min-height: 561px) {");
  });

  /*
   * Measured at 320px: an input's min-content width is its own `size`, and
   * `min-width: 0` permits flexing below it without lowering it — so the nowrap
   * rename row demanded about 345px, the detail card grew to match, and
   * `Cancel` was sliced to "Ca" against the right edge of a viewport with no
   * horizontal scroller.
   */
  it("wraps the rename row rather than letting its field set the detail column's width", () => {
    const base = styles.slice(styles.indexOf(".session-library-rename { display: flex;"));
    expect(base.slice(0, base.indexOf("}"))).toContain("flex-wrap: wrap;");

    const shorthand = styles.indexOf(".session-library-rename input { flex: 1 1 22em;");
    expect(shorthand).toBeGreaterThan(0);
    const field = styles.slice(styles.indexOf(".session-library-rename input {", shorthand + 1));
    expect(field.slice(0, field.indexOf("}"))).toContain("flex-basis: 100%;");

    /*
     * And it has to be stated after that shorthand. Both selectors weigh
     * (0,1,1), a media query adds nothing, and `flex` resets `flex-basis` — so
     * the same declaration written beside the route's other 560px rules is
     * inert, and inert in the silent way that reads as fixed.
     */
    expect(styles.lastIndexOf("flex-basis: 100%;")).toBeGreaterThan(shorthand);
  });

  /*
   * Measured at 932x430, a phone held sideways: every media query in the sheet
   * asks about width, so none of them fired, and the pane laid itself out with
   * a desktop's vertical room. The action row — Rename, Proof, Fork, Delete —
   * ended up below the fold showing about 8px of each button's top corner.
   */
  it("stops asking a 430px-tall viewport for 420px of pane and a stacked heading", () => {
    const short = styles.slice(styles.indexOf("@media (max-height: 560px) {"));
    const guard = short.slice(0, short.indexOf("@media (prefers-reduced-motion"));

    expect(guard).toContain(".session-library-detail {");
    expect(guard).toContain("min-height: 0;");

    /*
     * The heading returns to a row only where width is not the scarce axis.
     * Below 861px the route is already one column, and stacking the actions
     * under the title is what is right there — this guard has to know the
     * difference, or it undoes the 1180px rule on a phone in portrait.
     */
    expect(guard).toContain("@media (max-height: 560px) and (min-width: 861px) {");
    expect(guard).toContain(".session-library-detail-heading {");
    expect(guard).toContain("display: flex;");
  });

  /*
   * …and sitting the actions beside the heading is what makes this pane's width
   * critical, so the same block has to stop the list column growing into it.
   *
   * In the grid heading the eyebrow spans the pane. In the flex one it shares
   * the line with the action cluster and takes whatever proportional shrink
   * leaves it, and the block carrying it has no `min-width: 0` to make that
   * share predictable — so a small loss on the pane lands amplified on the id.
   * Measured at 932x430, where the layout container is 905px in every build:
   * with the column at 330px the pane is 574px, the eyebrow's block is 271px,
   * and `Conversation B924F3C2…F142` (232px) sits on one line. Let 38% take the
   * column to 344px and the pane falls to 560px, the block to 236px, and the id
   * breaks mid-token. The extra line costs 19px, which is exactly the margin
   * this viewport has: `Created … · updated …` was legible above the tab bar
   * and is pushed under it.
   */
  it("stops the list column growing into the pane whose heading it just widened", () => {
    const landscape =
      styles.match(/@media \(max-height: 560px\) and \(min-width: 861px\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
    expect(landscape).toContain(".session-library-layout {");
    expect(landscape).toContain("grid-template-columns: minmax(260px, 330px) minmax(0, 1fr);");

    /*
     * 330px is the clamp's own floor, not a new number: this is the growth
     * handed back, not the column cut below what it had before the growth
     * existed.
     */
    expect(ruleBody(".session-library-layout")).toContain("clamp(330px,");

    /*
     * And the hold has to be stated after the base rule. Both selectors weigh
     * (0,1,0) and a media query adds nothing to specificity, so source order is
     * the only thing deciding this — written above the base rule it is inert,
     * and inert in the silent way that reads as fixed. Same trap as the rename
     * field's `flex-basis` two tests above.
     */
    expect(styles.indexOf("@media (max-height: 560px) and (min-width: 861px) {"))
      .toBeGreaterThan(styles.indexOf(".session-library-layout {"));

    /*
     * The narrowing may never reach a portrait phone, where the route is one
     * column and the list *is* the route: `min-width: 861px` is load-bearing.
     */
    expect(styles).not.toContain("@media (max-height: 560px) {\n  .session-library-layout");
  });
});

/*
 * The list and its own heading must agree about how much is on screen.
 *
 * Measured: `limit: 200` with no `offset` anywhere in the file, beneath a
 * heading printing `page.total`. At 312 conversations — and every fork, edit
 * and retry mints a peer row — 112 threads were counted in the heading and
 * unreachable by any gesture on the route.
 */
describe("conversation library bound", () => {
  it("says nothing about a bound when every counted row is rendered", () => {
    const small = sessionListBound(12, 12);
    expect(small.bounded).toBe(false);
    expect(small.next).toBe(0);
  });

  it("names both the shown count and the true total when rows were withheld", () => {
    const bounded = sessionListBound(SESSION_LIBRARY_PAGE_SIZE, 312);
    expect(bounded.bounded).toBe(true);
    expect(bounded.sentence).toContain("200");
    expect(bounded.sentence).toContain("312");
    expect(bounded.next).toBe(112);
  });

  it("never offers to read more than one journal page at a time", () => {
    // The ceiling is the journal query's own — `positiveInteger(query.limit,
    // 100, 200)` — so a "Load 812 more" button would promise a read the
    // storage layer silently truncates.
    expect(sessionListBound(SESSION_LIBRARY_PAGE_SIZE, 1_012).next).toBe(SESSION_LIBRARY_PAGE_SIZE);
    expect(sessionListBound(0, 5).next).toBe(5);
  });

  it("reads further pages by offset, at the page size the journal actually honours", () => {
    // The reference, not a copy of the literal: a build that raises the
    // journal ceiling changes one constant and both the read and the button
    // follow it.
    expect(source).toContain("export const SESSION_LIBRARY_PAGE_SIZE = 200;");
    expect(source).toContain("await library.list({ ...query, offset: 0, limit: SESSION_LIBRARY_PAGE_SIZE }, controller.signal)");
    expect(source).toContain("await library.list({ ...query, offset: items.length, limit: SESSION_LIBRARY_PAGE_SIZE }, controller.signal)");
    expect(source).not.toContain("limit: 200,");
  });

  it("renders the bound statement and the control that lifts it, inside the list", () => {
    expect(source).toContain("const bound = sessionListBound(page?.items.length ?? 0, page?.total ?? 0);");
    expect(source).toContain('<div class="session-library-bound" role="status">');
    expect(source).toContain("<p>{bound.sentence}</p>");
    expect(source).toContain("onClick={() => setDepth(Object.freeze({ key: queryKey, pages: requestedPages + 1 }))}");
    expect(source).toContain("`Load ${bound.next.toLocaleString()} more`");
  });

  it("keeps the reader's depth across a refresh, and resets it when the query changes", () => {
    // Starring, renaming and forking all bump `refresh`; re-reading only the
    // first page there would drop a reader who had loaded 400 rows back to 200.
    expect(source).toContain("refresh, requestedPages, revision");
    // Read back through the query it was made against, so a narrower filter
    // falls to one page during the render that changed it. An effect-based
    // reset would fire the journal read twice on every filter change.
    expect(source).toContain('const queryKey = [scopeProfileId, search, providerId, model, sort].join("\\u0000");');
    expect(source).toContain("const requestedPages = depth.key === queryKey ? depth.pages : 1;");
  });
});

/*
 * One noun for one thing.
 *
 * The route is titled "All conversations" and its heading counts
 * "conversations", while the divider one row below it read "All sessions" and
 * the search landmark inside the "Conversations" panel was named "Filter
 * sessions". Six user-facing occurrences on one screen, in two dialects.
 */
describe("conversation library vocabulary", () => {
  const ACCESSIBLE_NAMES = [...source.matchAll(/(?:aria-label|ariaLabel)=(?:"([^"]*)"|\{`([^`]*)`\})/gu)]
    .map((match) => match[1] ?? match[2] ?? "");
  /** Text nodes between JSX tags, which is what a sighted reader actually sees. */
  const VISIBLE_TEXT = [...source.matchAll(/>([^<>{}\n]{3,})</gu)].map((match) => match[1]);

  it("finds at least the names and text this guard exists to police", () => {
    // Without this the two assertions below could pass by matching nothing.
    expect(ACCESSIBLE_NAMES).toContain("Filter conversations");
    expect(ACCESSIBLE_NAMES).toContain("Sort conversations");
    expect(ACCESSIBLE_NAMES).toContain("Refresh conversations");
    expect(VISIBLE_TEXT).toContain("All conversations");
  });

  it("never names a control or a landmark after the journal record type", () => {
    expect(ACCESSIBLE_NAMES.filter((name) => /\bsessions?\b/iu.test(name))).toEqual([]);
  });

  it("never prints the word to a sighted reader either", () => {
    expect(VISIBLE_TEXT.filter((text) => /\bsessions?\b/iu.test(text))).toEqual([]);
  });

  it("speaks the same noun in its announcements and its verbs", () => {
    expect(source).toContain("is now the active conversation.");
    expect(source).toContain("`Renamed conversation to ${renamed.title}.`");
    expect(source).toContain('? "Resume conversation"');
    expect(source).toContain('conversation record{page.rejected === 1 ? " was" : "s were"} excluded.');
  });
});

/*
 * The refusal that had no remedy but a fork.
 *
 * Measured: a conversation pinned to a cloud provider, opened in a tab whose
 * connection did not survive a reload, rendered five stacked amber mismatch
 * rows — provider, model, inference connection, posture, profile digest — with
 * one cause between them, and offered exactly one enabled action: `Fork to
 * continue`. The product knew the pinned provider id, the pinned model id and
 * the delta, and made the reader carry all three to `#access` by hand.
 *
 * The plan itself is asserted against the real `decideSessionResume` in
 * `sessions-presentation.test.ts`. What is asserted here is the wiring: that
 * the card is conditional on the plan, that it does not leave two gold buttons
 * arguing about one decision, and that both of its controls clear the touch
 * floor — the original defect was a resume verb at y=791 on a 390x844 phone.
 */
describe("reconnecting instead of forking", () => {
  it("renders only when the runtime's own reasons say a reconnect would cure it", () => {
    expect(source).toContain("const reconnect = sessionReconnectPlan({");
    expect(source).toContain("{reconnect ? (");
    // Keyed on the plan, not on "some pin differs": a refusal a reconnect
    // cannot fix must not be offered one.
    expect(source).toContain("const forkPrimary = forkRequired && !reconnect;");
  });

  it("does not put two gold buttons on one decision", () => {
    // The fork steps down to an ordinary button while the card holds the
    // primary, and Resume's emphasis follows the requirement rather than
    // whichever control happens to be gold — otherwise demoting the fork
    // promotes a disabled "Fork required".
    expect(source).toContain('<button class={!forkRequired ? "primary" : ""} type="button" onClick={onResume}');
  });

  it("keeps every mismatch string, and adds the comparison prose cannot make", () => {
    // The runtime's reasons render through the one shared list, verbatim.
    expect(source).toContain("<ReasonList reasons={reasons} />");
    // Closed at rest: the reader who just read the header knows what it says.
    const card = source.slice(source.indexOf("function SessionReconnectCard"));
    expect(card.slice(0, card.indexOf("\n}\n"))).not.toContain("<details open");
    expect(source).toContain('<th scope="row">{delta.label}</th>');
  });

  it("gives both of its controls the touch floor, at every pointer", () => {
    const rule = styles.slice(styles.indexOf(".session-library-reconnect__primary,"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("min-height: var(--touch-target, 44px)");
    // The disclosure is a control too, and it is the one a thumb reaches for
    // when the header did not answer the question.
    const summary = styles.slice(styles.indexOf(".session-library-reconnect__delta > summary"));
    expect(summary.slice(0, summary.indexOf("}"))).toContain("min-height: var(--touch-target, 44px)");
  });
});

/*
 * A row may not document a gesture the reader does not have.
 *
 * The row's `title` said only "Double-click to open" — on a phone, an
 * instruction naming an input the reader has no way to perform, printed beside
 * an `Open` button it never mentioned. Both halves of the fix have to travel
 * together: the affordance and the sentence that tells you it is there.
 */
describe("the row's own gesture line", () => {
  const title = source.slice(source.indexOf("title={`${item.title}\\n${item.providerId}"));
  const template = title.slice(0, title.indexOf("}\n"));

  it("names the control that exists on every input device", () => {
    expect(template).not.toContain("Double-click to open");
    expect(template).toContain("Open on this row");
    // And the control it names is really in the row, under that word — rename
    // the button and this sentence stops being true.
    expect(source).toContain('>{active ? "Active" : "Open"}</button>');
  });

  /*
   * The opener is quiet at rest and states itself on hover — a trade that only
   * pays where a hover exists. Under a coarse pointer it has to state itself
   * outright, or the row is back to documenting a gesture nobody can make.
   */
  it("stops relying on hover to reveal the opener where there is no hover", () => {
    const coarse = styles.slice(styles.lastIndexOf("@media (pointer: coarse)"));
    expect(coarse).toContain(".session-library-open:not(:disabled)");
    // Scoped to the enabled control: the active conversation's row says
    // "Active", and lighting that up as a verb would offer to reopen what is
    // already open.
    expect(coarse.slice(coarse.indexOf(".session-library-open:not(:disabled)"))).toContain("color: var(--accent-bright");
  });

  it("says what pressing the row itself does, since that is the other half", () => {
    // Selection without opening is what the detail pane, the fork, the rename
    // and the resume requirement all depend on; it is not a bug to be
    // discovered by pressing.
    expect(template).toContain("Press to select");
    expect(source).toContain("onClick={() => setSelectedId(item.id)}");
  });
});
