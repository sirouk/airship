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


describe("session bar at phone width", () => {
  /*
   * The one-row header.
   *
   * The previous contract pinned a full second row for the chips cluster (a
   * measured 103px of session bar at 390×844, two decks of chrome above every
   * conversation). The design is now one 48px row: the title takes what is
   * left after the indicators price themselves, the indicators never shrink
   * below their own words, and when arithmetic cannot hide the surplus the
   * cluster scrolls inside itself rather than buying a second deck. What the
   * chips may never do is compress mid-text, which is the defect both
   * versions of this contract exist against.
   */
  it("keeps the indicators on the title's single row", () => {
    const chips = phoneBlock.match(/\.session-bar__chips \{([^}]+)\}/u)?.[1] ?? "";

    expect(chips).toContain("grid-column: 2");
    expect(chips).toContain("grid-row: 1");
    expect(chips).toContain("flex-wrap: nowrap");
    // In-row overflow is what keeps a 320px bar from spending a second deck:
    // the strip scrolls rather than compressing a chip. It moved onto the
    // instruments, so the two verbs beside them cannot be carried off by it.
    const instruments = phoneBlock.match(/\.session-bar__instruments \{([^}]+)\}/u)?.[1] ?? "";
    expect(instruments).toContain("overflow-x: auto");
  });

  it("never shrinks a chip below its own words", () => {
    const children = phoneBlock.match(/\.session-bar__instruments > \* \{([^}]+)\}/u)?.[1] ?? "";
    expect(children).toContain("flex: 0 0 auto");
  });

  /*
   * Two guarantees the one-row design was missing, both measured on this build
   * before they were added.
   *
   * "The title takes what is left" had no floor, and the arithmetic took all of
   * it: the conversation name rendered 38px wide at 390px and the identity
   * block 2px at 320px, so the H1 read "Ge…" beside six fully legible chips.
   * The element that answers "which conversation is this" was the only thing
   * on the bar that had been priced at zero.
   *
   * And when the surplus scrolled, it carried the verbs with it: `+` left the
   * strip at 390px and Rename followed at 320px. A reading you scroll to is
   * still a reading; a verb you scroll to is a verb nobody finds. So the
   * readings scroll and the actions are pinned.
   */
  it("gives the conversation's own name a floor", () => {
    const bar = phoneBlock.match(/\.session-bar \{([^}]+)\}/u)?.[1] ?? "";
    expect(bar).toMatch(/grid-template-columns:\s*minmax\(\s*7rem/u);
  });

  it("pins the two verbs outside the strip that scrolls", () => {
    const pinned = phoneBlock.match(/\.session-bar__rename-action,\s*\n\s*\.session-bar__new \{([^}]+)\}/u)?.[1] ?? "";
    expect(pinned, "rename and new conversation must not be carried off by the instrument scroll").toContain("flex: 0 0 auto");
    const shrinkable = phoneBlock.match(/\.session-bar__chips > \.session-bar__instruments \{([^}]+)\}/u)?.[1] ?? "";
    expect(shrinkable, "the readings are the row's one shrinkable child").toContain("flex: 0 1 auto");
  });

  it("keeps 44px hit targets for every phone chip and action", () => {
    const targets = phoneBlock.match(
      /\.session-status-chip,\s*\.journal-chip,\s*\.session-model-chip,\s*\.session-skills-chip,\s*\.session-bar__rename-action,\s*\.session-bar__new,\s*\.session-bar \.session-runtime \{([^}]+)\}/u,
    )?.[1] ?? "";
    // The token, not a copy of the number: `--touch-target` is the one place
    // the 44px floor is declared, and it was written out longhand 144 times.
    expect(targets).toContain("min-height: var(--touch-target)");
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
   * The shed ladder that keeps one row possible.
   *
   * Below 480px the status chip's word and count step behind the seal, and
   * below 400px both secondary counts follow: a bare number beside a bare
   * number is what the units were added to prevent, so each goes whole. Every
   * shed is a clip into the accessibility tree — the complete claim stays in
   * the trigger's accessible name and the popover a tap opens — and the row
   * may not buy its width back by shrinking a chip or a target.
   */
  const narrowBlock = phoneBlock.match(/@media \(max-width: 480px\), \(max-height: 500px\) \{([\s\S]*?)\n  \}/u)?.[1] ?? "";
  const narrowestBlock = phoneBlock.match(/@media \(max-width: 400px\), \(max-height: 500px\) \{([\s\S]*?)\n  \}/u)?.[1] ?? "";

  it("sheds the status chip's texts below 480px, whole and clipped", () => {
    const rule = narrowBlock.match(
      /\.session-status-chip__word,\s*\.session-status-chip__count \{([^}]+)\}/u,
    )?.[1] ?? "";
    expect(rule).toContain("clip-path: inset(50%)");
    expect(rule).not.toContain("display: none");
  });

  it("below 400px sheds nothing a target could be measured against", () => {
    // A count sheds as a count. Shedding the unit alone would leave the two
    // adjacent chips reading as two numbers of unstated kind.
    expect(narrowestBlock).not.toContain("__unit");
    // The row may not buy its width back by shrinking a chip or a target.
    expect(narrowestBlock).not.toContain("min-height");
    expect(narrowestBlock).not.toContain("flex-shrink");
    // Every chip stays mounted at every width: clipping carries the shed,
    // `display: none` on a chip would take it out of the accessibility tree.
    expect(narrowestBlock).not.toMatch(/\.session-[a-z-]+ \{ display: none/u);
  });
});
