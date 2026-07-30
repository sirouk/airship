import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { routeAboutAutoOpens, routeAboutLabel } from "./route-header";

const routeStyles = await readFile(new URL("./routes.css", import.meta.url), "utf8");
const headerSource = await readFile(new URL("./route-header.tsx", import.meta.url), "utf8");

// The two strings the Terminal route may not lose. They are quoted here so a
// rewording of the label format has to be reconciled against real copy.
const TERMINAL_EYEBROW = "Workspace · browser process room";
const PROOF_EYEBROW = "Inspectable, portable evidence";

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
