import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The shell scrolls nothing. Its panes do.
 *
 * `.app-shell` is a fixed-height grid — topbar, session bar, route, navigation
 * — and only the route pane is meant to move. When the *document* scrolls
 * instead, the last grid row goes with it, and the last grid row on a phone is
 * the navigation: measured at phone-320 on `#proof`, at maximum scroll the nav
 * sat at y=-61..-5, above the top of the screen, with 573px of empty ground
 * below it. `#context` arrived already scrolled by 82px, so the void was there
 * before anyone touched the page.
 *
 * The cause was one missing declaration. `.main` was `position: static`, so
 * the screen-reader spans inside the routes — `position: absolute`, no offsets,
 * 1px tall — resolved against the initial containing block instead of against
 * the pane that contains them, and a box positioned against the ICB is a box
 * `overflow: auto` on that pane has no standing to clip. They landed at their
 * static positions in the document (a `span.status-mark__label` reading "Journal
 * structure passed" at y=1140.6 in a 568px viewport) and `scrollHeight` grew to
 * hold them.
 *
 * These assertions are on the stylesheet because that is where the whole repair
 * is, and because the three plausible-looking alternatives are each a different
 * regression: `contain`, `transform` and `filter` also make a containing block,
 * and all three capture `position: fixed` as well — which would re-anchor the
 * four bottom sheets to a scroller instead of to the viewport.
 */
const css = readFileSync(new URL("./shell.css", import.meta.url), "utf8");
/** Comment-free, so a rule's text cannot be matched inside prose about it. */
const rules = css.replace(/\/\*[\s\S]*?\*\//gu, "");
/** What a selector declares, from the sheet with its prose removed. */
const bodyOf = (selector: string): string =>
  new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{([^}]*)\\}`, "u").exec(rules)?.[1] ?? "";

describe("the route pane's containing block", () => {
  it("makes `.main` the containing block for what `.main` clips", () => {
    const main = bodyOf(".main");
    expect(main).toContain("position: relative");
    expect(main).toContain("overflow: auto");
  });

  it("does not buy that containment with anything that also captures `position: fixed`", () => {
    // The four sheet-mode overlays rise from the edge of the viewport. A pane
    // that contains `fixed` descendants would open them inside itself, halfway
    // down a scroller, which is a worse defect than the one being repaired.
    const main = bodyOf(".main");
    for (const capture of ["contain:", "transform:", "filter:", "backdrop-filter:", "perspective:", "will-change:"]) {
      expect(main, `.main must not declare ${capture}`).not.toContain(capture);
    }
    // And no stacking context either: `position: relative` alone creates none,
    // so nothing that paints over this pane changes order.
    expect(main).not.toContain("z-index");
  });

  it("keeps the shell itself a fixed grid rather than a second scroller", () => {
    // The repair is that the document stops scrolling, not that the shell
    // learns to. `overflow: clip` here was measured first and changed nothing —
    // the escaping boxes were the document's layout, not this box's overflow.
    const shell = bodyOf(".app-shell");
    expect(shell).toContain("height: 100%");
    expect(shell).not.toContain("overflow");
  });
});
