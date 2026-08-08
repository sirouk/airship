import { describe, expect, it } from "vitest";
import { readAirshipStyles } from "./style-sheets.test-helper";

const styles = await readAirshipStyles();

describe("chat stage tracks", () => {
  /*
   * The stage's first child — the agent-runtime eyebrow — is conditional three
   * times over, and its lazy chunk means every first paint starts without it.
   * Grid auto-placement is positional, so unpinned that frame slid the
   * transcript onto an `auto` track: not a scroll region, and `safe center`
   * centring the zero state inside a box its own height. Declaring four rows
   * was not enough on its own; the two tracks that may never move say so.
   */
  it("pins the transcript and the composer so a missing eyebrow cannot displace them", () => {
    const rule = (selector: string) =>
      new RegExp(`\\.chat-stage > \\.${selector}\\s*\\{[^}]*grid-row:\\s*(\\d)`, "u").exec(styles)?.[1];
    expect(rule("transcript")).toBe("3");
    expect(rule("composer-wrap")).toBe("4");
  });

  it("keeps the four-row declaration the pinning depends on", () => {
    // `.chat-stage` is declared more than once across the concatenated sheets —
    // routes.css carries a breakpoint rule that only clears `border-right` — so
    // this picks the block that actually templates the rows, the same way the
    // `.message` assertion below picks its base rule.
    const stage = [...styles.matchAll(/\.chat-stage\s*\{([^}]+)\}/gu)]
      .map((match) => match[1] ?? "")
      .find((rule) => rule.includes("grid-template-rows")) ?? "";
    expect(stage).toContain("grid-template-rows: auto auto minmax(0, 1fr) auto");
  });
});

describe("chat role layout", () => {
  it("places user messages on the right and agent messages on the left without changing DOM order", () => {
    const userRules = [...styles.matchAll(/\.message\.user\s*\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
    const baseMessage = [...styles.matchAll(/\.message\s*\{([^}]+)\}/gu)]
      .map((match) => match[1] ?? "")
      .find((rule) => rule.includes("grid-template-columns")) ?? "";
    const desktopUser = userRules.find((rule) => rule.includes("width: min(78%, 650px)")) ?? "";

    expect(baseMessage).toContain("margin: 0 auto 18px 0");
    expect(baseMessage).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(desktopUser).toContain("margin-right: 0");
    expect(desktopUser).toContain("margin-left: auto");
  });

  it("preserves the differentiated sides at the mobile breakpoint", () => {
    const userRules = [...styles.matchAll(/\.message\.user\s*\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
    const mobileUser = userRules.at(-1) ?? "";

    expect(userRules.length).toBeGreaterThanOrEqual(2);
    expect(mobileUser).not.toContain("grid-template-columns");
    expect(mobileUser).toContain("width: 88%");
    expect(mobileUser).toContain("margin-left: auto");
  });

  it("reserves a stable message-action rail across hover and keyboard focus", () => {
    const actions = styles.match(/\.message-actions\s*\{([^}]+)\}/u)?.[1] ?? "";
    const revealed = styles.match(/\.message:hover \.message-actions, \.message:focus-within \.message-actions\s*\{([^}]+)\}/u)?.[1] ?? "";

    expect(actions).toContain("height: var(--message-action-height)");
    expect(actions).toContain("opacity: 0");
    expect(actions).not.toContain("max-height");
    expect(revealed).toContain("opacity: 1");
    expect(revealed).not.toMatch(/height|margin|padding/u);
  });

  /*
   * The old assertion pinned a two-column header — a 180px title column beside
   * a 270-420px model column, with a wrapping meta row underneath. That shape
   * is what cost 88px, starved the model name to 169px and pushed the trust
   * row onto its own line. The claims did not change; their container did, so
   * these read the one row that now holds all four.
   */
  it("keeps the session title, model, trust state, and journal identity in one 40px row", () => {
    const bar = styles.match(/\n\.session-bar \{([^}]+)\}/u)?.[1] ?? "";

    expect(bar).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(bar).toContain("min-height: 40px");
    // The title track may shrink to nothing before anything in the right
    // cluster wraps; wrapping is what turned one row into three.
    expect(styles).toMatch(/\.session-bar__title \{[^}]*text-overflow: ellipsis/u);
    expect(styles).toContain(".session-bar__chips {");
    // Three indicators and one verb share the chip recipe. The pinned-skills
    // chip left this list when its content moved into the runtime chip's
    // sheet: it was a 44px glyph on a 430px bar whose whole payload was a
    // popover, and the bar's problem is that it has more indicators than the
    // title it crowds. A fourth name reappearing here is a fourth slot.
    expect(styles).toMatch(/\.session-status-chip,\n\.journal-chip,\n\.session-model-chip,\n\.session-bar__new,/u);
    expect(styles).not.toContain(".session-skills-chip");
    // The old two-column header may not come back under any breakpoint.
    expect(styles).not.toContain(".stage-header");
    expect(styles).not.toContain(".session-meta");
  });

  /*
   * Collapse trigger 1 of the four in the product. It has two invariants that
   * a stylesheet can lose silently: a 44px target may never shrink under a
   * thumb, and a shed label must stay in the accessibility tree.
   */
  it("collapses the session bar on scroll only where there is a fine pointer, and clips labels rather than removing them", () => {
    const fine = styles.match(/@media \(pointer: fine\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";

    expect(fine).toContain('.chat-stage[data-scrolled="true"] .session-bar {');
    expect(fine).toContain("min-height: 32px");
    expect(fine).toContain("clip-path: inset(50%)");
    expect(fine).not.toContain("display: none");
    expect(styles).not.toMatch(/\.chat-stage\[data-scrolled="true"\][^{]*\{[^}]*display: none/u);
  });

  it("fades the transcript under the session bar instead of cutting it with a rule", () => {
    const scrim = styles.match(/\.transcript::before \{([^}]+)\}/u)?.[1] ?? "";

    expect(scrim).toContain("position: sticky");
    expect(scrim).toContain("linear-gradient(to bottom, var(--ground), transparent)");
    // A scrim that ate clicks would hide the first message's controls behind a
    // decoration, and it must not add height to a scroll container either.
    expect(scrim).toContain("pointer-events: none");
    expect(scrim).toContain("margin-bottom: calc(-1 * var(--transcript-scrim))");
  });

  it("centres an empty conversation instead of dropping it against the composer", () => {
    /*
     * Docking was tried and measured worse. At 1440x900 the first-run block is
     * 72px inside a 694px transcript: `align-content: end` left 504px of void
     * above it — 56% of the region — and still did not sit against the
     * composer, because the composer has its own margin. Centring halves the
     * gap above to 264px and reads as composed rather than as an empty screen
     * with something fallen to the bottom of it.
     *
     * This also restores the resolution the design direction already made
     * (conflict 1) and that `e2e/responsive-breakpoints.spec.ts` was written
     * for. That e2e only asserts `firstTopWithin > 120`, which docking also
     * satisfies, so it could not catch the change on its own — hence this
     * assertion naming the property directly.
     */
    const empty = styles.match(/\.transcript\.no-turns \{([^}]+)\}/u)?.[1] ?? "";

    /*
     * `safe center`, not bare `center`. The keyword is the whole point of the
     * companion assertion in `e2e/responsive-breakpoints.spec.ts` — "bare
     * `center` puts the first card at a negative offset a scroll container can
     * never reach" — and the rule said `center` anyway, passing at 390×844 by
     * 2px of slack that the phone type ramp then spent: measured -2.05px, the
     * welcome card rendered above the top of its own scrollport.
     */
    expect(empty).toContain("align-content: safe center");
    expect(empty).not.toContain("align-content: end");
  });
});
