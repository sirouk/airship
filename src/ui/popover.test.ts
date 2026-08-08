import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POPOVER_EDGE_GUTTER,
  POPOVER_HOVER_INTENT_MS,
  POPOVER_MIN_ROOM,
  POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT,
  POPOVER_SHEET_LANDSCAPE_MAX_WIDTH,
  POPOVER_SHEET_MAX_WIDTH,
  popoverPlacement,
  popoverRoom,
} from "./popover";

/** A viewport tall enough that only the width arm can decide the mode. */
const TALL = 900;

describe("the one anchored disclosure", () => {
  it("anchors from the left while the panel clears the viewport gutter", () => {
    expect(popoverPlacement({ anchorLeft: 40, popoverWidth: 320, viewportWidth: 1440, viewportHeight: TALL }))
      .toEqual({ mode: "anchored", align: "start" });
  });

  it("flips to the right edge exactly when the panel would cross the gutter", () => {
    // The last chip in a right-hand cluster is the case that matters: one pixel
    // either side of the boundary has to pick a different edge, or the flip is
    // decorative rather than load bearing.
    const justInside = 1440 - POPOVER_EDGE_GUTTER - 320;
    expect(popoverPlacement({ anchorLeft: justInside, popoverWidth: 320, viewportWidth: 1440, viewportHeight: TALL }).align).toBe("start");
    expect(popoverPlacement({ anchorLeft: justInside + 1, popoverWidth: 320, viewportWidth: 1440, viewportHeight: TALL }).align).toBe("end");
  });

  it("becomes a bottom sheet at and below the phone breakpoint, whatever the anchor", () => {
    expect(popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: POPOVER_SHEET_MAX_WIDTH, viewportHeight: TALL }).mode).toBe("sheet");
    expect(popoverPlacement({ anchorLeft: 300, popoverWidth: 320, viewportWidth: 430, viewportHeight: TALL }).mode).toBe("sheet");
    expect(popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: POPOVER_SHEET_MAX_WIDTH + 1, viewportHeight: TALL }).mode).toBe("anchored");
  });

  /*
   * The landscape defect this arm exists for.
   *
   * At 932x430 the Proof route's claim-stack chip ends ~305px down a `.main`
   * pane that stops at 385px above the navigation band. The width test alone
   * called that anchored — 932 is wider than any upright-phone threshold — so
   * `popoverRoom` fell to its floor, the panel overhung, and the route's
   * primary evidence surface showed a header and about 10px of its first claim
   * with the other eight underneath the band. A viewport can be too short to
   * anchor in while being far too wide to look like a phone.
   */
  it("becomes a sheet on the landscape arm, where the viewport is wide but has no height", () => {
    expect(popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: 932, viewportHeight: 430 }).mode).toBe("sheet");
    // Both bounds are inclusive, and one pixel past either returns the panel to
    // an anchor — the arm has to be a boundary, not a mood.
    expect(popoverPlacement({
      anchorLeft: 0,
      popoverWidth: 320,
      viewportWidth: POPOVER_SHEET_LANDSCAPE_MAX_WIDTH,
      viewportHeight: POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT,
    }).mode).toBe("sheet");
    expect(popoverPlacement({
      anchorLeft: 0,
      popoverWidth: 320,
      viewportWidth: POPOVER_SHEET_LANDSCAPE_MAX_WIDTH + 1,
      viewportHeight: POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT,
    }).mode).toBe("anchored");
    expect(popoverPlacement({
      anchorLeft: 0,
      popoverWidth: 320,
      viewportWidth: POPOVER_SHEET_LANDSCAPE_MAX_WIDTH,
      viewportHeight: POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT + 1,
    }).mode).toBe("anchored");
  });

  it("leaves a short window that is wider than the landscape arm anchored", () => {
    // A 1440x420 desktop window is short, but it is not the compact shell and a
    // full-bleed bottom sheet there would be a 1440px-wide overlay for a chip.
    // `popoverRoom` is what keeps that case honest, not the mode.
    expect(popoverPlacement({ anchorLeft: 40, popoverWidth: 320, viewportWidth: 1440, viewportHeight: 420 }).mode)
      .toBe("anchored");
  });

  it("measures the room to the clipping pane, not to the window", () => {
    /*
     * A chip partway down a `.main` pane (`overflow: auto`) that stops at y=382
     * because a fixed band owns the rest, in a 430px window. A body capped at
     * 60vh of the screen is 258px while the pane has only 276px left below the
     * trigger, so the `vh` fraction says nothing about how much of the screen
     * this panel may actually occupy — and the window's own height is the
     * number that was never the answer.
     *
     * Deliberately not written as a landscape phone any more: that shape opens
     * as a sheet now and never reaches this function. What is left for it are
     * short desktop windows, chips low in a scrolled pane, and the editor route
     * where `.main` is `overflow: hidden` and clips outright.
     */
    expect(popoverRoom({ anchorBottom: 94, clipBottom: 382 })).toBe(382 - 94 - POPOVER_EDGE_GUTTER);
    expect(popoverRoom({ anchorBottom: 94, clipBottom: 430 }))
      .toBeGreaterThan(popoverRoom({ anchorBottom: 94, clipBottom: 382 }));
  });

  it("stops measuring rather than hand a chip near the fold a two-line panel", () => {
    // A trigger 30px above the pane's bottom edge has no usable room. Reporting
    // that honestly would produce a scroll viewport too short to read, so the
    // floor holds and the panel overhangs instead — visible beats contained.
    expect(popoverRoom({ anchorBottom: 352, clipBottom: 382 })).toBe(POPOVER_MIN_ROOM);
    expect(popoverRoom({ anchorBottom: 900, clipBottom: 382 })).toBe(POPOVER_MIN_ROOM);
  });

  it("returns a frozen placement so a caller cannot mutate the shared result", () => {
    const placement = popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: 1440, viewportHeight: TALL });
    expect(Object.isFrozen(placement)).toBe(true);
  });

  it("keeps hover intent short enough to feel like a hover and long enough not to fire in transit", () => {
    expect(POPOVER_HOVER_INTENT_MS).toBeGreaterThanOrEqual(120);
    expect(POPOVER_HOVER_INTENT_MS).toBeLessThanOrEqual(200);
  });

  it("only owns keys while the keyboard is actually inside the disclosure", () => {
    /*
     * The scene this pins: a hover-open panel on one part of the page, the
     * reader's focus in a control somewhere else, an Escape meant for THAT
     * control. The document-level capture listener used to swallow every
     * Escape while any popover was open, closing the panel and refocusing its
     * trigger under someone else's cursor. The adjacent Tab guard already
     * required focus containment; Escape now passes the identical gate before
     * it may close, stop propagation, or refocus anything.
     */
    const source = readFileSync(new URL("./popover.tsx", import.meta.url), "utf8");
    const start = source.indexOf("function onKeyDown");
    // Only the handler itself — `onPointerLeave` further down legitimately
    // reads the same containment, and the listener attach marks the boundary.
    const keydown = source.slice(start, source.indexOf("document.addEventListener", start));
    const gate = keydown.indexOf("if (!hostRef.current?.contains(document.activeElement)) return;");
    expect(gate, "the shared containment gate exists").toBeGreaterThan(-1);
    expect(keydown.indexOf('if (event.key === "Escape")')).toBeGreaterThan(gate);
    expect(keydown.indexOf('if (event.key === "Tab")')).toBeGreaterThan(gate);
    // One gate, both keys: the Tab branch must not have quietly regrown a
    // second, divergent containment check of its own.
    expect(keydown.match(/contains\(document\.activeElement\)/gu)).toHaveLength(1);
  });
});

const sheet = readFileSync(new URL("./popover.css", import.meta.url), "utf8");

describe("the panel is the width of the box it is pinned to", () => {
  it("stops the nowrap header from sizing the panel it sits in", () => {
    /*
     * Seen at 320 and 390: the header read `MEMORY INDEX · REVISION-BOUND LOCA`
     * straight into the screen edge with no ellipsis, every body line was cut
     * mid-word, and the 44px Done button — the only visible way a touch reader
     * has to dismiss a sheet — was laid out entirely off-screen. Seen at 1440
     * too, where the same header and body ran outside the panel's own opaque
     * background and interleaved with the page beneath it.
     *
     * One cause for all of it: the panel is a grid, the header's min-content is
     * a nowrap heading plus Done, and an `auto` track takes its floor from
     * exactly that — so the panel laid its rows out at ~490px whatever width the
     * panel itself had been given.
     */
    const panel = block(sheet, ".popover__panel");
    const header = block(sheet, ".popover__header");

    expect(panel).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(header).toContain("min-width: 0");
  });

  it("bounds the header by wrapping it, not by deleting the half that does not fit", () => {
    /*
     * The cost side of the rule above, and the reason it is no longer paid.
     * Containing the header with `white-space: nowrap` plus an ellipsis fitted
     * the title by removing it: `ACCOUNT STANDING · CHUTES TELEMETRY AND
     * PROVIDER INVENTORY` rendered as `ACCOUNT STANDING · CHUTES T…` on a
     * 1920px display, and `PROVENANCE · ARCHITECTURE.MD` lost the extension of
     * the file it names on a tablet — with no wider state to open, so the
     * missing half was unreachable everywhere.
     *
     * Wrapping bounds it harder: a nowrap heading's min-content is the entire
     * 490px string, which is what sized the panel in the first place, and a
     * wrapping one's is a single word. So `nowrap` must not come back here —
     * it would reinstate both defects at once.
     */
    const heading = block(sheet, ".popover__header > strong");
    expect(heading).toContain("white-space: normal");
    expect(heading).toContain("overflow-wrap: anywhere");
    expect(heading).not.toContain("nowrap");
  });

  it("caps the panel at the room its trigger actually has, and makes the body the row that yields", () => {
    /*
     * A chip anchored partway down a `.main` pane that ends before the window
     * does, with the only ceiling being the body's `60vh` — a fraction of the
     * screen, which is more than the pane has left. The panel is scrollable
     * throughout and it does not help, because the bottom of its own scroll
     * viewport is the part outside the box that clips it.
     *
     * The landscape phone that first produced this is no longer one of its
     * cases; it takes the sheet arm now. Short desktop windows and deeply
     * scrolled panes still land here.
     */
    const panel = block(sheet, ".popover__panel");
    expect(panel).toMatch(/max-height: calc\(var\(--popover-room, 100vh\) - var\(--sp-2\)\)/u);
    // The header carries Done. If it were the flexible row, bounding the panel
    // would compress the dismissal control instead of the prose.
    expect(panel).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(block(sheet, ".popover__body")).toContain("overflow: auto");
  });

  it("keeps the sheet's dismissal control at the touch floor inside that width", () => {
    // Done is what makes the header worth bounding: a sheet whose only visible
    // exit is off-screen is dismissible solely by a gesture nobody is told about.
    expect(sheet).toMatch(/\.popover\[data-mode="sheet"\] \.popover__done \{[^}]*min-height: 44px/u);
  });

  it("declares the header's vertical air instead of borrowing it from the 44px floor", () => {
    /*
     * The other cost of wrapping the heading, and the one that was left unpaid.
     * `padding: 0 var(--sp-3)` was air only while the title was one line. At
     * phone-320 the account sheet's title takes three mono `--fs-micro` lines —
     * 39.6px in a 44px box — so the pixels showed ~2px between the sheet's own
     * top border and the first glyph and ~2px between the last descender and
     * the header rule, and at the two larger type scales the same three lines
     * measure 43px and 47px, which is a collision and then an overflow.
     *
     * The floor stays: with 8px either side a one or two-line heading is 29px
     * or 42px of content, still under 44px, so nothing that fits today moves.
     */
    const header = block(sheet, ".popover__header");
    expect(header).toContain("padding: var(--sp-2) var(--sp-3)");
    expect(header).toContain("min-height: 44px");
  });

  it("makes the bounded body's own cut visible rather than leaving it to read as a fault", () => {
    /*
     * Capping the panel to its trigger's room was right and it gave the panel a
     * hard bottom border to draw through whatever row happened to be there:
     * measured on the laptop-1024 provenance panel, the border runs through the
     * middle of the `CONTENT DIGEST` glyphs. The scroll shadow is the thing that
     * says "this row continues", and at 13% of `--ink` its peak measured 8/255
     * over the body's ground against the border's 78 — an affordance that is
     * present in the cascade and absent from the screen.
     *
     * The two `local` layers are the other half and they are asserted with it:
     * they scroll with the content and mask these exactly where the text has
     * genuinely ended, so a stronger shadow may not start claiming a fourth
     * paragraph that does not exist. Their 14px must stay at or above the
     * shadow's own height for that to hold.
     */
    const body = block(sheet, ".popover__body");
    expect(body).toContain("var(--ink) 30%");
    expect(body).toContain("scroll top / 100% 10px");
    expect(body).toContain("scroll bottom / 100% 10px");
    expect(body).toContain("local top / 100% 14px");
    expect(body).toContain("local bottom / 100% 14px");
    expect(body).toContain("overflow: auto");
  });

  it("positions the sheet on both arms of the compact shell, not just the narrow one", () => {
    /*
     * The defect this pins, and it is a disagreement between two files rather
     * than a bad value in either.
     *
     * `popover.tsx` sets `data-mode="sheet"` on the landscape arm — wide but
     * short, the 932x430 phone held sideways. The block that actually makes a
     * sheet a sheet (`position: fixed`, pinned to the bottom edge, the sticky
     * header, the 44px Done) was scoped `@media (max-width: 640px)` alone. A
     * landscape viewport therefore satisfied the JS and missed the CSS, leaving
     * the panel `position: absolute` under its trigger while calling itself a
     * sheet: the one state neither mode is designed for.
     *
     * So this asserts the query, not the declarations inside it. The
     * declarations were always right; the width they were gated behind was not.
     */
    expect(sheet).toContain('@media (max-width: 640px), (max-width: 950px) and (max-height: 500px) {');
    // And the constants the JS decides with have to be the same two numbers, or
    // the two files drift apart again silently.
    expect(POPOVER_SHEET_MAX_WIDTH).toBe(640);
    expect(POPOVER_SHEET_LANDSCAPE_MAX_WIDTH).toBe(950);
    expect(POPOVER_SHEET_LANDSCAPE_MAX_HEIGHT).toBe(500);
  });

  it("bounds the landscape sheet's measure rather than letting it span 932px", () => {
    /*
     * The bill for the arm above, paid in the same change that incurred it.
     *
     * A sheet spans the bottom edge, and on an upright phone that edge is
     * 320-430px so the span is also the measure. At 932x430 the same rule sets
     * a claim's `small` detail — `grid-area: 2 / 1 / 3 / -1`, the full row — to
     * a ~900px line, roughly 150 characters and twice any measure this product
     * uses elsewhere. That would have been a legibility defect introduced by
     * the repair rather than found by it.
     *
     * The body's single track is what is capped, not the panel: the panel keeps
     * its full-bleed geometry, its bottom-edge travel and its sticky header, so
     * nothing about how the sheet arrives or dismisses is re-derived. The query
     * floors at 641px so the 640px cap can only ever narrow the column, never
     * stretch it.
     */
    expect(sheet).toContain('@media (min-width: 641px) and (max-width: 950px) and (max-height: 500px) {');
    const landscape = sheet.slice(sheet.indexOf('@media (min-width: 641px) and (max-width: 950px)'));
    expect(landscape).toContain("grid-template-columns: minmax(0, 640px)");
    expect(landscape).toContain("justify-content: center");
  });
});

/** The declarations of the first rule with exactly this selector. */
function block(source: string, selector: string): string {
  const start = source.indexOf(`\n${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start) + 1;
  return source.slice(bodyStart, source.indexOf("}", bodyStart));
}
