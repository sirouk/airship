import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { moveMenuSelection } from "./menu-select";

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
