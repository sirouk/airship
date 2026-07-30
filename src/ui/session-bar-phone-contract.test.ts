import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Read by name, not via the barrel: shell.css carries a media query with the
// identical condition list (`platform-shell.css:147` agreement rules), so a
// barrel read would find that block first and swallow the cascade between the
// two — matching selectors dozens of sheets away from the rules under test.
const styles = await readFile(new URL("./routes.css", import.meta.url), "utf8");

/*
 * The defect this contract pins: at the phone + landscape breakpoints the
 * chips row was restyled from `flex: 0 0 auto` (chips keep their natural
 * width) to `width: 100%; overflow-x: auto`. Inside a scroll container whose
 * children carry `min-width: 0` under the default `flex-shrink: 1`, the
 * browser compresses every chip instead of scrolling — so at 430px the row
 * rendered "2 ev…", "N 4 claims" and "3…", mid-text, with nothing to scroll
 * to and rename and `+` off the right edge. The fix is the relief valve the
 * sessions toolbar documented at 1180px: wrap, pay in height, clip nothing,
 * hide nothing.
 */
const phoneBlock =
  styles.match(
    /@media \(max-width: 640px\), \(max-width: 950px\) and \(max-height: 500px\) \{([\s\S]*?)\n@media \(min-width: 641px\)/u,
  )?.[1] ?? "";

const landscapeBlock =
  styles.match(
    /@media \(min-width: 641px\) and \(max-width: 950px\) and \(max-height: 500px\) \{([\s\S]*?)\n@media /u,
  )?.[1] ?? "";

describe("session bar at phone width", () => {
  it("takes a full second row for the chips cluster and wraps instead of scrolling", () => {
    const chips = phoneBlock.match(/\.session-bar__chips \{([^}]+)\}/u)?.[1] ?? "";

    expect(chips).toContain("grid-column: 1 / -1");
    expect(chips).toContain("flex-wrap: wrap");
    // The scroll restyle is the defect; it may not come back to this row.
    expect(chips).not.toContain("overflow-x");
  });

  it("never shrinks a chip below its own words", () => {
    const children = phoneBlock.match(/\.session-bar__chips > \* \{([^}]+)\}/u)?.[1] ?? "";
    expect(children).toContain("flex: 0 0 auto");
  });

  it("keeps 44px hit targets for every phone chip and action", () => {
    const targets = phoneBlock.match(
      /\.session-status-chip,\s*\.journal-chip,\s*\.session-model-chip,\s*\.session-skills-chip,\s*\.session-bar__rename-action,\s*\.session-bar__new,\s*\.session-bar \.session-runtime \{([^}]+)\}/u,
    )?.[1] ?? "";
    expect(targets).toContain("min-height: 44px");
  });

  it("clips shed labels into the accessible tree rather than removing them", () => {
    // Skills joins the demo label in the shed order: icon-only chips whose
    // counts live in the trigger's accessible name and popover. A shed label
    // is a layout instruction — `display: none` would take it out of the
    // accessibility tree, which is the one theft `clip-path` refuses to do.
    for (const selector of [
      ".session-model-chip--demo .session-model-chip__label",
      ".session-skills-chip__label",
    ]) {
      const escaped = selector.replaceAll(".", "\\.").replaceAll(" ", "\\s");
      const rule = phoneBlock.match(new RegExp(`${escaped} \\{([^}]+)\\}`, "u"))?.[1] ?? "";
      expect(rule).toContain("clip-path: inset(50%)");
      expect(rule).not.toContain("display: none");
    }
  });

  /*
   * The narrowest phones get one more shed step, because the wrap valve is
   * only free while the shell has height to pay it with. The cluster costs
   * 378px at rest and the bar's insets take 24px, so under ~402px the valve
   * fires and buys a third 44px row: 153px of session bar on a 320×700 phone,
   * with the transcript under half the screen. The two secondary counts yield
   * first, whole (a bare number beside a bare number is what their units were
   * added to prevent), and only below 400px — a 430px phone still renders
   * both, which is where the shed order above was measured.
   */
  const narrowBlock = phoneBlock.match(/@media \(max-width: 400px\) \{([\s\S]*?)\n  \}/u)?.[1] ?? "";

  it("sheds both chip counts, and nothing else, on sub-400px phones", () => {
    const rule = narrowBlock.match(
      /\.session-status-chip__count,\s*\.journal-chip__count \{([^}]+)\}/u,
    )?.[1] ?? "";
    expect(rule).toContain("clip-path: inset(50%)");
    expect(rule).not.toContain("display: none");
    // The verdict word is the one string in this cluster that may never be
    // shed: a seal glyph alone stands for a trust claim it cannot state.
    expect(narrowBlock).not.toContain("session-status-chip__word");
    // A count sheds as a count. Shedding the unit alone would leave the two
    // adjacent chips reading as two numbers of unstated kind.
    expect(narrowBlock).not.toContain("__unit");
    // The row may not buy its width back by shrinking a chip or a target.
    expect(narrowBlock).not.toContain("min-height");
    expect(narrowBlock).not.toContain("flex-shrink");
  });

  it("keeps landscape phones on one line beside the folded title", () => {
    const chips = landscapeBlock.match(/\.session-bar__chips \{([^}]+)\}/u)?.[1] ?? "";
    // A ≤500px-tall landscape has no height to pay a second row with, so the
    // cluster stays in its column.
    expect(chips).toContain("grid-column: auto");
  });
});
