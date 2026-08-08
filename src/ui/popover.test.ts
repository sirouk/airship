import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POPOVER_EDGE_GUTTER,
  POPOVER_HOVER_INTENT_MS,
  POPOVER_SHEET_MAX_WIDTH,
  popoverPlacement,
} from "./popover";

describe("the one anchored disclosure", () => {
  it("anchors from the left while the panel clears the viewport gutter", () => {
    expect(popoverPlacement({ anchorLeft: 40, popoverWidth: 320, viewportWidth: 1440 }))
      .toEqual({ mode: "anchored", align: "start" });
  });

  it("flips to the right edge exactly when the panel would cross the gutter", () => {
    // The last chip in a right-hand cluster is the case that matters: one pixel
    // either side of the boundary has to pick a different edge, or the flip is
    // decorative rather than load bearing.
    const justInside = 1440 - POPOVER_EDGE_GUTTER - 320;
    expect(popoverPlacement({ anchorLeft: justInside, popoverWidth: 320, viewportWidth: 1440 }).align).toBe("start");
    expect(popoverPlacement({ anchorLeft: justInside + 1, popoverWidth: 320, viewportWidth: 1440 }).align).toBe("end");
  });

  it("becomes a bottom sheet at and below the phone breakpoint, whatever the anchor", () => {
    expect(popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: POPOVER_SHEET_MAX_WIDTH }).mode).toBe("sheet");
    expect(popoverPlacement({ anchorLeft: 300, popoverWidth: 320, viewportWidth: 430 }).mode).toBe("sheet");
    expect(popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: POPOVER_SHEET_MAX_WIDTH + 1 }).mode).toBe("anchored");
  });

  it("returns a frozen placement so a caller cannot mutate the shared result", () => {
    const placement = popoverPlacement({ anchorLeft: 0, popoverWidth: 320, viewportWidth: 1440 });
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
    // The floor is half the contract. The heading still has to have somewhere
    // to put the characters that a narrower box costs it.
    expect(sheet).toMatch(/\.popover__header > strong \{[^}]*text-overflow: ellipsis/u);
  });

  it("keeps the sheet's dismissal control at the touch floor inside that width", () => {
    // Done is what makes the header worth bounding: a sheet whose only visible
    // exit is off-screen is dismissible solely by a gesture nobody is told about.
    expect(sheet).toMatch(/\.popover\[data-mode="sheet"\] \.popover__done \{[^}]*min-height: 44px/u);
  });
});

/** The declarations of the first rule with exactly this selector. */
function block(source: string, selector: string): string {
  const start = source.indexOf(`\n${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start) + 1;
  return source.slice(bodyStart, source.indexOf("}", bodyStart));
}
