import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MENU_SELECT_EDGE_GUTTER, menuSelectShift, moveMenuSelection } from "./menu-select";

describe("menu selection keyboard movement", () => {
  const options = [{ disabled: false }, { disabled: true }, { disabled: false }];

  it("wraps with arrow keys and skips disabled options", () => {
    expect(moveMenuSelection(0, "ArrowDown", options)).toBe(2);
    expect(moveMenuSelection(2, "ArrowDown", options)).toBe(0);
    expect(moveMenuSelection(0, "ArrowUp", options)).toBe(2);
  });

  it("moves to enabled boundaries with Home and End", () => {
    expect(moveMenuSelection(2, "Home", options)).toBe(0);
    expect(moveMenuSelection(0, "End", options)).toBe(2);
  });
});

describe("the trigger states a selection only when there is one", () => {
  /*
   * `value` can name no option — empty before a choice is made, stale after a
   * catalog refresh, or simply not yet present in a list still being fetched.
   * Clamping that miss to index 0 made the trigger render the first option as
   * chosen, so a model picker asserted a model the session had never pinned.
   * Opening still starts at the top; only the claim about state changed.
   */
  const source = readFileSync(new URL("./menu-select.tsx", import.meta.url), "utf8");

  it("keeps the display index separate from the navigation index", () => {
    expect(source).toMatch(/const matchedIndex = options\.findIndex\(\(option\) => option\.value === value\);/u);
    // Where to open still has an answer when nothing matches.
    expect(source).toMatch(/const selectedIndex = Math\.max\(0, matchedIndex\);/u);
    // What to display does not invent one.
    expect(source).toMatch(/const selected = matchedIndex < 0 \? undefined : options\[matchedIndex\];/u);
  });

  it("leaves the no-selection fallback reachable", () => {
    // `?? "Choose"` was written for exactly this case and could never fire
    // while the index was clamped.
    expect(source.match(/selected\?\.label \?\? "Choose"/gu)?.length).toBe(2);
  });
});

describe("keys the listbox handles stay inside the listbox", () => {
  /*
   * The option buttons live inside whatever surface owns the `MenuSelect` —
   * in `PreferencesDialog`, an Escape that only closed the listbox still
   * bubbled into the dialog's own keydown and closed the dialog too.
   * Handled keys stop propagating; Tab does not, because focus leaving the
   * listbox is exactly what Tab is for.
   */
  it("stops propagation of Escape and the other handled option keys, never of Tab", () => {
    const source = readFileSync(new URL("./menu-select.tsx", import.meta.url), "utf8");
    expect(source).toMatch(
      /event\.key === "Escape"\)\s*\{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/u,
    );
    // Every fully-handled branch carries the guard…
    expect(source.match(/event\.stopPropagation\(\)/gu)?.length).toBeGreaterThanOrEqual(3);
    // …and there is no path where Tab joins them.
    expect(source).not.toMatch(/key === "Tab"\)\s*\{\s*event\.(preventDefault|stopPropagation)/u);
  });
});

describe("an anchored listbox ends up on the screen, whichever way it opens", () => {
  it("puts a left-overflowing panel back inside the gutter", () => {
    /*
     * The measured defect, at the width it was measured on. The composer's
     * approval-policy chooser is 400px wide and pinned by `right: 0` to a
     * trigger whose own right edge is at 363 on a 768px tablet, so the panel
     * rendered at x=-36.9 and all three option labels — the words `Ask First`,
     * `Auto Approve`, `Full Access` — started off the left edge of the screen.
     */
    expect(menuSelectShift({ panelLeft: -36.9, panelRight: 363.1, viewportWidth: 768 }))
      .toBe(MENU_SELECT_EDGE_GUTTER + 37);
  });

  it("pulls a right-overflowing panel back the other way", () => {
    expect(menuSelectShift({ panelLeft: 500, panelRight: 900, viewportWidth: 768 }))
      .toBe(-(900 - (768 - MENU_SELECT_EDGE_GUTTER)));
  });

  it("leaves a panel that already clears both gutters exactly where it is", () => {
    expect(menuSelectShift({ panelLeft: MENU_SELECT_EDGE_GUTTER, panelRight: 760, viewportWidth: 768 })).toBe(0);
    expect(menuSelectShift({ panelLeft: 200, panelRight: 600, viewportWidth: 768 })).toBe(0);
  });

  it("shows the left edge when the panel cannot fit between both gutters", () => {
    // A listbox wider than the screen can only show one of its edges, and its
    // labels are left-aligned: the right edge is the one with no words on it.
    const shifted = menuSelectShift({ panelLeft: -50, panelRight: 800, viewportWidth: 768 });
    expect(-50 + shifted).toBe(MENU_SELECT_EDGE_GUTTER);
  });

  it("runs the horizontal pass for both placements and measures a clean panel", () => {
    const source = readFileSync(new URL("./menu-select.tsx", import.meta.url), "utf8");
    const effect = source.slice(source.indexOf("useLayoutEffect(() => {\n    if (!open"));
    // The upward placement is the one the defect was on; gating the whole pass
    // on `down` is what let it through.
    const guard = effect.slice(0, effect.indexOf("\n", effect.indexOf("if (!open")));
    expect(guard).not.toContain('placement !== "down"');
    // The pass that keeps it on the screen runs before the branch that returns
    // for anything but `down`, which is the ordering the defect turned on.
    expect(effect.indexOf("menuSelectShift")).toBeLessThan(effect.indexOf('if (placement !== "down") return;'));
    // A flip or a shift left on the node from a previous open is measured as if
    // the stylesheet had put it there, so both are cleared before reading.
    const horizontal = effect.slice(effect.indexOf("if (!narrowViewport)"), effect.indexOf("if (placement !== \"down\") return;"));
    expect(horizontal.indexOf('listbox.style.transform = "";'))
      .toBeLessThan(horizontal.indexOf("getBoundingClientRect()"));
    expect(horizontal).toContain('listbox.style.left = "";');
    expect(horizontal).toContain('listbox.style.right = "";');
    // And the sheet tier is pinned to both viewport edges by CSS, so it is not
    // measured at all.
    expect(effect.indexOf("narrowViewport")).toBeLessThan(effect.indexOf("menuSelectShift"));
  });
});
