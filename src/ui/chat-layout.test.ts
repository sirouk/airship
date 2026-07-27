import { describe, expect, it } from "vitest";
import { readAirshipStyles } from "./style-sheets.test-helper";

const styles = await readAirshipStyles();

describe("chat role layout", () => {
  it("places user messages on the right and agent messages on the left without changing DOM order", () => {
    const userRules = [...styles.matchAll(/\.message\.user\s*\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
    const baseMessage = [...styles.matchAll(/\.message\s*\{([^}]+)\}/gu)]
      .map((match) => match[1] ?? "")
      .find((rule) => rule.includes("grid-template-columns")) ?? "";
    const desktopUser = userRules.find((rule) => rule.includes("grid-template-columns: minmax(0, 1fr) 31px")) ?? "";

    expect(baseMessage).toContain("margin: 0 auto 18px 0");
    expect(desktopUser).toContain("grid-template-columns: minmax(0, 1fr) 31px");
    expect(desktopUser).toContain("margin-right: 0");
    expect(desktopUser).toContain("margin-left: auto");
  });

  it("preserves the differentiated sides at the mobile breakpoint", () => {
    const userRules = [...styles.matchAll(/\.message\.user\s*\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
    const mobileUser = userRules.at(-1) ?? "";

    expect(userRules.length).toBeGreaterThanOrEqual(2);
    expect(mobileUser).toContain("grid-template-columns: minmax(0, 1fr) 26px");
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
    expect(styles).toMatch(/\.session-status-chip,\n\.journal-chip,\n\.session-model-chip,\n\.session-bar__new,/u);
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

  it("docks an empty conversation to the composer rather than centring it in the void", () => {
    const empty = styles.match(/\.transcript\.no-turns \{([^}]+)\}/u)?.[1] ?? "";

    expect(empty).toContain("align-content: end");
    expect(empty).not.toContain("center");
  });
});
