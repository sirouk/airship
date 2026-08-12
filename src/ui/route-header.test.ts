import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { routeAboutAutoOpens, routeAboutLabel } from "./route-header";

const routeStyles = await readFile(new URL("./routes.css", import.meta.url), "utf8");
const headerSource = await readFile(new URL("./route-header.tsx", import.meta.url), "utf8");

// The two strings the Terminal route may not lose. They are quoted here so a
// rewording of the label format has to be reconciled against real copy.
const TERMINAL_EYEBROW = "Workspace · browser process room";
const PROOF_EYEBROW = "Inspectable, portable evidence";

/**
 * The declarations of the first rule with this exact selector. The existing
 * assertions in this file each inline the same regex; it is written once here
 * for the rules added since, and deliberately reads the FIRST match — a rule
 * repeated inside a media query is an override and is asserted against the
 * query it lives in, not through this.
 */
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped} \\{([^}]+)\\}`, "u").exec(routeStyles)?.[1] ?? "";
}

describe("the route ⓘ says what it contains", () => {
  it("quotes the eyebrow and names the sentence it is standing in front of", () => {
    expect(routeAboutLabel({
      title: "Editor",
      eyebrow: "Device-executed · page workspace",
      carriesDescription: true,
      carriesNotes: false,
    })).toBe("About Editor. Device-executed · page workspace, and what this view does.");
  });

  it("enumerates a route's extra caveats separately from its description", () => {
    expect(routeAboutLabel({
      title: "Terminal",
      eyebrow: TERMINAL_EYEBROW,
      carriesDescription: true,
      carriesNotes: true,
    })).toBe(
      `About Terminal. ${TERMINAL_EYEBROW}, what this view does, and this route's caveats.`,
    );
  });

  it("never promises a description that is already visible on the route", () => {
    // Document density leaves the sentence on screen, so the panel holds only
    // the caveats. A trigger that advertised the sentence anyway would be
    // teaching users that the ⓘ restates what they can already read.
    const label = routeAboutLabel({
      title: "Proof",
      eyebrow: PROOF_EYEBROW,
      carriesDescription: false,
      carriesNotes: true,
    });
    expect(label).toBe(`About Proof. ${PROOF_EYEBROW}, and this route's caveats.`);
    expect(label).not.toContain("what this view does");
  });

  it("still names the route and its eyebrow when it carries nothing else", () => {
    expect(routeAboutLabel({
      title: "Vault",
      eyebrow: "Private device state",
      carriesDescription: false,
      carriesNotes: false,
    })).toBe("About Vault. Private device state.");
  });
});

describe("the ⓘ renders and auto-opens only when it holds something unseen", () => {
  it("opens itself where the sentence moved behind it", () => {
    expect(routeAboutAutoOpens({ carriesDescription: true, carriesNotes: false })).toBe(true);
    expect(routeAboutAutoOpens({ carriesDescription: false, carriesNotes: true })).toBe(true);
  });

  it("does not exist at all when every word it would hold is already on screen", () => {
    expect(routeAboutAutoOpens({ carriesDescription: false, carriesNotes: false })).toBe(false);
  });
});

describe("the first-visit ledger", () => {
  it("never opens its own disclosure, because a panel that opens itself covers the route", () => {
    // The header used to click its own trigger on a route's first visit. The
    // panel then sat over the route's controls and, on a phone, over the
    // bottom navigation. Discoverability is the trigger's labelled job; an
    // overlay that intercepts the next click is not a lesser evil.
    const source = headerSource;
    expect(source).not.toContain(".click()");
    expect(source).not.toContain("useEffect");
  });


});

describe("route header geometry", () => {
  /*
   * The literal these two rules used to carry was 44px — which is the `:root`
   * *fallback* of `--density-control`, never the value that ships: the shell
   * boots at `comfortable`, where the token is 46px. So the one bar every route
   * renders sat 2px shorter than the controls beside it at the default setting,
   * and stayed 44px in Compact while its neighbours went to 36px. The token is
   * asserted rather than a copy of a number, so a change to the ramp cannot
   * leave this bar behind again.
   */
  it("is one density-control row, not a frozen 44px bar", () => {
    const bar = routeStyles.match(/\.route-header__bar \{([^}]+)\}/u)?.[1] ?? "";
    expect(bar).toContain("min-height: var(--density-control)");
  });

  it("gives the ⓘ a full control-height target around its 24px mark", () => {
    const trigger = routeStyles.match(/\.route-header__about-trigger \{([^}]+)\}/u)?.[1] ?? "";
    expect(trigger).toContain("min-width: var(--density-control)");
    expect(trigger).toContain("min-height: var(--density-control)");
  });

  it("sets the one route title at the one route-title step, in the serif's one job", () => {
    const title = routeStyles.match(/\.route-title \{([^}]+)\}/u)?.[1] ?? "";
    expect(title).toContain("var(--fs-display)");
    expect(title).toContain("var(--font-display)");
    // A px-literal clamp() here would pin the largest text in the product
    // against the user's type-scale preference (WCAG 1.4.4).
    expect(title).not.toContain("clamp(");
  });

  /*
   * The three truncation declarations are inert without this one. `.route-title`
   * is a flex item of `.route-header__bar`, a flex item's default `min-width:
   * auto` resolves to its min-content width, and a `nowrap` heading's
   * min-content width is the whole string — so at 320px "Repositories &
   * worktrees" laid out at full width and was cut flush by the screen edge,
   * mid-word, with the ellipsis this rule declares never getting a box narrow
   * enough to fire in.
   */
  it("lets the title's own ellipsis fire by allowing the flex item to shrink", () => {
    const title = routeStyles.match(/\.route-title \{([^}]+)\}/u)?.[1] ?? "";
    expect(title).toContain("min-width: 0");
    expect(title).toContain("text-overflow: ellipsis");
    expect(title).toContain("white-space: nowrap");
  });

  /*
   * SO058. On `#sessions` at phone-320 the ⓘ was a 46x46 button at [13,138]
   * whose entire visible content was a 23x24 'ⓘ' ring, alone on a line between
   * the heading (96..130) and the durability chip (192..236) — about 40px of
   * dead vertical space around a generic glyph that said nothing about what it
   * opened. It had a full `aria-label` the whole time, so this was visual
   * discoverability only and the repair is a visible word, not a new promise.
   *
   * The mechanism was the flex wrap: a line breaks on its items' base sizes
   * before it shrinks any of them, so a 260px heading and a 46px ⓘ could not
   * share a 294px row and the ⓘ wrapped alone. Grouped, the pair is one item —
   * the break happens around it and the shrink happens inside it, against the
   * heading's own ellipsis.
   */
  it("keeps the ⓘ on the heading's line rather than letting it wrap to one of its own", () => {
    expect(headerSource).toContain('<div class="route-header__title-line">');
    const line = cssRule(".route-header__title-line");
    // Shrink, never grow: growing would fill the row and make `margin-left:
    // auto` on the status cluster a no-op, which is what docks a route's chips
    // to the right edge at every width above a phone.
    expect(line).toContain("flex: 0 1 auto");
    expect(line).toContain("min-width: 0");
    // Inside the pair only the heading yields; shrink is proportional to base
    // size, so a shrinking ⓘ would give up target width and clip its own word.
    expect(cssRule(".route-header__title-line > .route-header__about")).toContain("flex: none");
    /*
     * And the bar has to be allowed to be narrower than what it holds. It is a
     * grid item of `.route-header`, whose default `min-width: auto` is its
     * min-content width — which for a wrapping flex row used to be its widest
     * single child and is now the heading and the ⓘ together. Measured at
     * phone-320 without this: a 294px header holding a 360px bar, with the ⓘ
     * ending 53px past the right edge of the screen.
     */
    expect(cssRule(".route-header__bar")).toContain("min-width: 0");
  });

  it("gives the ⓘ a word at the width where it had become an orphan, and only there", () => {
    // Hidden by default: above a phone the glyph sits immediately after a route
    // name it plainly belongs to, and a second word there is a label on a label.
    expect(cssRule(".route-header__about-word")).toContain("display: none");
    const phone = routeStyles.slice(routeStyles.indexOf("@media (max-width: 640px) {", routeStyles.indexOf(".route-header__about-word")));
    expect(phone).toContain(".route-header__about-word {");
    // The eyebrow's own recipe — the product's existing treatment for a small
    // word attached to a larger one.
    expect(phone.slice(phone.indexOf(".route-header__about-word {"))).toContain("var(--font-mono)");
    // Superseded by the button's `aria-label`, so the word is a mark for eyes
    // only and cannot become a second, divergent announcement.
    expect(headerSource).toContain('<span class="route-header__about-word" aria-hidden="true">About</span>');
  });

  it("keeps the eyebrow off brass, which encodes location and action only", () => {
    const eyebrow = routeStyles.match(/\.route-header__eyebrow \{([^}]+)\}/u)?.[1] ?? "";
    expect(eyebrow).toContain("color: var(--ink-muted)");
    expect(eyebrow).not.toContain("--brass");
    expect(eyebrow).not.toContain("--accent");
  });

  it("lets the route description wrap rather than truncating a route's own sentence", () => {
    const description = routeStyles.match(/\.route-header__description \{([^}]+)\}/u)?.[1] ?? "";
    expect(description).toContain("max-width: 68ch");
    expect(description).not.toContain("text-overflow");
    expect(description).not.toContain("white-space: nowrap");
  });
});
