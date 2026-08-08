import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  isTabCloseAuxiliaryActivation,
  middleTruncate,
  nextTabId,
  TAB_LABEL_MAX,
  tabAccessibleName,
  tabOverflowLabel,
  tabScrollLeft,
  tabStripEdges,
  tabStripOverflows,
  tabsOutOfView,
  type TabItem,
} from "./tabs";

const routeStyles = await readFile(new URL("./routes.css", import.meta.url), "utf8");

const items: readonly TabItem[] = Object.freeze([
  { id: "explorer", label: "Explorer" },
  { id: "source", label: "Source Control", count: 3, countLabel: "3 changes" },
  { id: "history", label: "History", disabled: true },
]);

describe("what the strip is hiding", () => {
  it("reports nothing hidden when every tab fits", () => {
    expect(tabsOutOfView(
      [{ id: "a", start: 0, end: 100 }, { id: "b", start: 100, end: 200 }],
      { start: 0, end: 200 },
    )).toEqual([]);
  });

  it("counts a tab clipped mid-word as hidden, because a clipped name is unreadable", () => {
    // The measured case: nine editor tabs, 1593px of strip in a 797px box.
    const boxes = [
      { id: "a", start: 0, end: 200 },
      { id: "b", start: 200, end: 400 },
      { id: "c", start: 400, end: 600 },
    ];
    expect(tabsOutOfView(boxes, { start: 0, end: 500 })).toEqual(["c"]);
    expect(tabsOutOfView(boxes, { start: 250, end: 750 })).toEqual(["a", "b"]);
  });

  it("does not report a phantom from sub-pixel layout", () => {
    expect(tabsOutOfView([{ id: "a", start: -0.5, end: 200.5 }], { start: 0, end: 200 })).toEqual([]);
    expect(tabsOutOfView([{ id: "a", start: -2, end: 200 }], { start: 0, end: 200 })).toEqual(["a"]);
  });

  it("returns a frozen list, so a caller cannot edit the count out from under the label", () => {
    expect(Object.isFrozen(tabsOutOfView([], { start: 0, end: 100 }))).toBe(true);
  });
});

describe("the edge fade", () => {
  it("paints nothing when the strip is not actually overflowing", () => {
    expect(tabStripEdges({ scrollLeft: 0, scrollWidth: 797, clientWidth: 797 })).toBe("none");
  });

  it("paints only the side that still hides tabs", () => {
    expect(tabStripEdges({ scrollLeft: 0, scrollWidth: 1593, clientWidth: 797 })).toBe("end");
    expect(tabStripEdges({ scrollLeft: 796, scrollWidth: 1593, clientWidth: 797 })).toBe("start");
    expect(tabStripEdges({ scrollLeft: 300, scrollWidth: 1593, clientWidth: 797 })).toBe("both");
  });
});

/*
 * The measured latch, and the one reading of the row that does not have it.
 *
 * The `⌄ n` control is the strip's sibling, so it takes ~52px off the box whose
 * fullness decided it should appear. 347px of tabs is then "nothing hidden" in
 * the 374px row without it and "one hidden" in the 322px row with it, both
 * stable, and the strip keeps whichever it arrived in. That is what put
 * "…lorer | Editor | Source Contro  ⌄ 1" on the Workspace pane switcher at
 * 390px with its container never having changed width. The numbers below are
 * that phone, so a rule that reintroduces the latch fails on the case it broke.
 */
describe("which row decides the overflow control exists", () => {
  it("does not grow a control the row without it has no need of", () => {
    expect(tabStripOverflows({ contentWidth: 347, rowWidth: 374 })).toBe(false);
  });

  it("unlatches a strip already narrowed by the control it grew", () => {
    // The losing fixed point: the same tabs in the same viewport, read from the
    // 322px the control left behind. Measured against the row rather than
    // against that remainder, the answer is the one the reader can act on.
    expect(tabStripOverflows({ contentWidth: 347, rowWidth: 322 })).toBe(true);
    expect(tabStripOverflows({ contentWidth: 347, rowWidth: 374 })).toBe(false);
  });

  it("still grows one for a row that genuinely cannot hold the tabs", () => {
    // The same three labels at 320px: 304px of row against 347px of tabs. The
    // control is honest there and must survive the fix to the case above.
    expect(tabStripOverflows({ contentWidth: 347, rowWidth: 304 })).toBe(true);
  });

  it("does not report a phantom from sub-pixel layout", () => {
    expect(tabStripOverflows({ contentWidth: 374.5, rowWidth: 374 })).toBe(false);
    expect(tabStripOverflows({ contentWidth: 376, rowWidth: 374 })).toBe(true);
  });

  it("is the first thing the live measurement asks, and it asks it of the container", async () => {
    // The rule is only worth having if it is the gate. Both halves are pinned:
    // the measurement runs the rule before it looks at a single tab box, and the
    // row it hands it comes from the strip's parent — `strip.clientWidth` is the
    // number the chevron already ate, and reading it here is the latch itself.
    const source = await readFile(new URL("./tabs.tsx", import.meta.url), "utf8");
    const measure = source.slice(source.indexOf("function measureTabOverflow"));
    expect(measure.slice(0, measure.indexOf("const boxes")))
      .toContain("tabStripOverflows({ contentWidth: strip.scrollWidth, rowWidth: tabStripRowWidth(strip) })");
    const rowWidth = source.match(/function tabStripRowWidth\(strip: HTMLElement\): number \{([\s\S]*?)\n\}/u)?.[1] ?? "";
    expect(rowWidth).toContain("strip.parentElement");
  });

  it("claims nothing about a row nobody has measured", () => {
    // A strip read before layout. This holds because the rule asserts that the
    // tabs overflow rather than negating that they fit — `!(content <= row)`
    // reads the same until a width is NaN, and then it is a chevron grown over
    // a row that was never measured, which narrows the row it was guessing at.
    expect(tabStripOverflows({ contentWidth: Number.NaN, rowWidth: 374 })).toBe(false);
    expect(tabStripOverflows({ contentWidth: 347, rowWidth: Number.NaN })).toBe(false);
  });
});

describe("bringing the active tab into view", () => {
  const viewport = { start: 0, end: 800 };

  it("does not move a strip whose active tab is already readable", () => {
    expect(tabScrollLeft({ id: "a", start: 100, end: 300 }, viewport)).toBe(0);
    expect(tabScrollLeft({ id: "a", start: 900, end: 1100 }, { start: 850, end: 1650 })).toBe(850);
  });

  it("scrolls the minimum distance that shows the whole tab", () => {
    expect(tabScrollLeft({ id: "a", start: 1200, end: 1400 }, viewport)).toBe(600);
    expect(tabScrollLeft({ id: "a", start: 100, end: 300 }, { start: 400, end: 1200 })).toBe(100);
  });

  it("never asks for a negative offset", () => {
    expect(tabScrollLeft({ id: "a", start: -50, end: 100 }, viewport)).toBe(0);
    expect(tabScrollLeft({ id: "a", start: 0, end: 900 }, viewport)).toBe(100);
  });
});

describe("the overflow control states its own cost", () => {
  it("says how many tabs are cut off and that the panel holds all of them", () => {
    expect(tabOverflowLabel({ hidden: 4, total: 9 }))
      .toBe("4 tabs are cut off. Open the full list of all 9.");
  });

  it("agrees with itself in the singular", () => {
    expect(tabOverflowLabel({ hidden: 1, total: 2 }))
      .toBe("1 tab is cut off. Open the full list of all 2.");
  });
});

describe("a tab's accessible name", () => {
  it("leads with the untruncated identity when the visible label was shortened", () => {
    expect(tabAccessibleName({
      id: "docs/architecture.md",
      label: middleTruncate("architecture.md"),
      detail: "docs/architecture.md",
    })).toBe("docs/architecture.md");
  });

  it("carries the count's unit and the live-state word", () => {
    expect(tabAccessibleName(items[1] as TabItem)).toBe("Source Control, 3 changes");
    expect(tabAccessibleName({ id: "t1", label: "Terminal 1", state: "checking", stateLabel: "Running" }))
      .toBe("Terminal 1, Running");
  });

  it("falls back to the bare count when no unit is given", () => {
    expect(tabAccessibleName({ id: "a", label: "Sources", count: 3 })).toBe("Sources, 3");
  });

  it("states replaceable preview status in addition to italicizing it", () => {
    expect(tabAccessibleName({ id: "a", label: "README.md", detail: "docs/README.md", preview: true }))
      .toBe("docs/README.md, Preview");
  });
});

describe("auxiliary close", () => {
  it("reserves only the standard middle button for closing a document tab", () => {
    expect(isTabCloseAuxiliaryActivation(1)).toBe(true);
    expect(isTabCloseAuxiliaryActivation(0)).toBe(false);
    expect(isTabCloseAuxiliaryActivation(2)).toBe(false);
    expect(isTabCloseAuxiliaryActivation(3)).toBe(false);
  });
});

describe("roving tabindex", () => {
  it("moves and wraps", () => {
    expect(nextTabId(items, "explorer", "ArrowRight")).toBe("source");
    expect(nextTabId(items, "source", "ArrowRight")).toBe("explorer");
    expect(nextTabId(items, "explorer", "ArrowLeft")).toBe("source");
  });

  it("skips a disabled tab instead of parking focus on it", () => {
    expect(nextTabId(items, "source", "End")).toBe("source");
    expect(nextTabId(items, "source", "Home")).toBe("explorer");
  });

  it("leaves every other key alone, so the strip is never a keyboard trap", () => {
    expect(nextTabId(items, "explorer", "Tab")).toBeUndefined();
    expect(nextTabId(items, "explorer", "Enter")).toBeUndefined();
    expect(nextTabId(items, "explorer", "Escape")).toBeUndefined();
  });

  it("has an answer when the active id is not in the strip", () => {
    expect(nextTabId(items, "gone", "ArrowRight")).toBe("explorer");
    expect(nextTabId(items, "gone", "ArrowLeft")).toBe("source");
    expect(nextTabId([], "gone", "ArrowRight")).toBeUndefined();
  });
});

describe("middle truncation", () => {
  it("keeps the extension, which is the part that says what the file is", () => {
    expect(middleTruncate("really-long-component-name-panel.tsx")).toBe("really-…nel.tsx");
    expect(middleTruncate("really-long-component-name-panel.tsx")).toHaveLength(TAB_LABEL_MAX);
  });

  it("leaves a label that already fits exactly as it is", () => {
    expect(middleTruncate("architecture.md")).toBe("architecture.md");
    expect(middleTruncate("index.ts")).toBe("index.ts");
  });

  it("counts characters, not code units, so a name is never cut mid-glyph", () => {
    expect(middleTruncate("🛰🛰🛰🛰🛰🛰", 5)).toBe("🛰🛰…🛰🛰");
  });
});

describe("one tab grammar", () => {
  it("encodes 'you are here' once: a 2px brass underline and a lift to --ink", () => {
    // Anchored to the start of a line for the same reason the label-step
    // assertion below is: unanchored, this read whichever scoped override came
    // first in the sheet, and the Proof switcher's phone rule for its selected
    // tab — which sets flex behaviour and says nothing about colour — sits
    // thousands of lines above the primitive. The primitive would then have
    // been free to drop the underline entirely while this test went on passing
    // against a route's private rule.
    const active = routeStyles.match(/\n\.tabs__tab\[data-active="true"\] \{([^}]+)\}/u)?.[1] ?? "";
    expect(active).toContain("border-bottom-color: var(--accent)");
    // The retired encodings: a solid brass fill and a brass wash. Brass means
    // "you are here" as a 2px rule, never as a 1156px block behind a passive
    // label.
    expect(active).not.toContain("background: var(--accent");
  });

  it("sets every tab label at the one tab step", () => {
    // Anchored to the start of a line so this reads the primitive's own rule.
    // Unanchored it matched whichever scoped override happened to come first in
    // the sheet — a strip that narrows the button on a phone would then be the
    // thing asserted to carry the type step, and the primitive could lose it
    // silently.
    const button = routeStyles.match(/\n\.tabs__tab-button \{([^}]+)\}/u)?.[1] ?? "";
    expect(button).toContain("var(--fs-lead)");
    // The height is asserted as the token, not as 40px: the product shipped
    // three tab heights (40 here, 44 on the Trust hub, 39 on the
    // Agent-configuration strip) because each strip wrote its own number.
    expect(button).toContain("min-height: var(--tab-height)");
  });

  it("raises every target to the touch floor where there is a finger", () => {
    const coarse = routeStyles.match(/@media \(pointer: coarse\) \{\n((?:[^@]|\n)*?)\n\}/u)?.[1] ?? "";
    expect(coarse).toContain(".tabs__tab-button");
    expect(coarse).toContain(".tabs__close");
    expect(coarse).toContain(".tabs__overflow-trigger");
    // The Agent-configuration strip — a phone's only route to Skills and
    // Capabilities — was the one strip with no floor at all and measured 39px
    // at every width. It is floored here rather than in its own rule so the
    // next strip inherits the answer instead of having to remember it.
    expect(coarse).toContain(".profile-hub-tabs > button");
    expect(coarse).toContain("min-height: var(--touch-target)");
  });

  it("reserves the overflow trigger's full hit width in the tab row", () => {
    const overflow = routeStyles.match(/\.tabs__overflow \{([^}]+)\}/u)?.[1] ?? "";
    expect(overflow).toContain("flex: 0 0 var(--touch-target)");
  });

  it("keeps a count as text rather than reinstating a filled badge", () => {
    const count = routeStyles.match(/\.tabs__count \{([^}]+)\}/u)?.[1] ?? "";
    expect(count).toContain("var(--fs-caption)");
    expect(count).not.toContain("background");
    expect(count).not.toContain("border-radius");
  });

  it("gives the overflow rows the full identity at a full control-height target", () => {
    const row = routeStyles.match(/\.tabs__overflow-item \{([^}]+)\}/u)?.[1] ?? "";
    expect(row).toContain("min-height: var(--density-control)");
    // The full path wraps here. Ellipsising it would leave the untruncated
    // name nowhere but a `title`, which a touch user cannot reach.
    const span = routeStyles.match(/\.tabs__overflow-item > \.tabs__overflow-label \{([^}]+)\}/u)?.[1] ?? "";
    expect(span).toContain("overflow-wrap: anywhere");
    expect(span).not.toContain("text-overflow");
  });

  it("italicizes the one replaceable document preview in the strip and overflow list", () => {
    const preview = routeStyles.match(/\.tabs\[data-variant="document"\] \.tabs__tab\[data-preview="true"\] \.tabs__label,\s*\.tabs__overflow-item\[data-preview="true"\] > \.tabs__overflow-label \{([^}]+)\}/u)?.[1] ?? "";
    expect(preview).toContain("font-style: italic");
  });

  it("gives a decorative leading mark one stable slot in both tab surfaces", async () => {
    const source = await readFile(new URL("./tabs.tsx", import.meta.url), "utf8");
    expect(source.match(/class="tabs__leading"/gu)).toHaveLength(2);
    expect(source).toContain('class="tabs__overflow-label"');
  });
});
