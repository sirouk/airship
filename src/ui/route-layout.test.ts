import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readAirshipStyles } from "./style-sheets.test-helper";

const [app, styles, sessions, proofSource, proofStyles, terminalSource, featureStyles] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readAirshipStyles(),
  readFile(new URL("./sessions-view.css", import.meta.url), "utf8"),
  readFile(new URL("./proof-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./proof-view.css", import.meta.url), "utf8"),
  readFile(new URL("./terminal-view.tsx", import.meta.url), "utf8"),
  Promise.all([
    ["access-connection-view", "./access-view.css"],
    ["attestations-view", "./attestations-view.css"],
    ["client-context-view", "./context-view.css"],
    ["git-sources", "./sources-view.css"],
    ["vault-view", "./vault-view.css"],
  ] as const).then(async (entries) => Promise.all(entries.map(async ([selector, file]) => ({
    selector,
    source: await readFile(new URL(file, import.meta.url), "utf8"),
  })))),
]);

describe("route layout contract", () => {
  it("assigns every non-chat destination to the shell-owned route layout", () => {
    expect(app).toContain('? "main chat-layout"');
    expect(app).toContain(': "main route-layout"');
    expect(app).not.toContain("TrustHubTabs");
  });

  it("owns one outer gutter family and keeps feature roots padding-free", () => {
    const routeRule = cssRule(styles, ".route-layout");
    expect(routeRule).toContain("--route-gutter-block:");
    expect(routeRule).toContain("--route-gutter-inline-start:");
    expect(routeRule).toContain("--route-gutter-inline-end:");
    expect(routeRule).toContain("padding:");

    expect(cssRule(styles, ".work-view")).toMatch(/padding:\s*0;/u);
    expect(cssRule(sessions, ".session-library-view")).toMatch(/padding:\s*0;/u);
    for (const { selector, source } of featureStyles) {
      expect(cssRule(source, `.${selector}`), selector).not.toMatch(/(?:^|;)\s*padding(?:-|:)/u);
    }
  });

  it("applies safe-area-aware mobile insets once at the route shell", () => {
    expect(styles).toContain("--route-gutter-inline-start: max(13px, env(safe-area-inset-left));");
    expect(styles).toContain("--route-gutter-inline-end: max(13px, env(safe-area-inset-right));");
    expect(styles).not.toMatch(/\.work-view\s*\{[^}]*safe-area-inset/su);
    expect(sessions).not.toMatch(/\.session-library-view\s*\{[^}]*safe-area-inset/su);
  });

  it("keeps the Vault route centered while dense workbenches stay full width", () => {
    const vault = cssRule(styles, ".route-layout > .vault-route");
    expect(vault).toContain("width: min(1160px, 100%)");
    expect(vault).toContain("margin-inline: auto");
    const wide = cssRule(styles, '.route-layout > [data-route-measure="wide"]');
    expect(wide).toContain("width: 100%");
    expect(wide).toContain("max-width: none");
  });

  /*
   * VIS-02: dense surfaces expand, prose stays bounded.
   *
   * The mechanism is one attribute, and it only works from a route *root* —
   * `.route-layout > [data-route-measure="wide"]` is a child combinator, so the
   * same attribute on a panel two levels down is silently inert and the route
   * quietly keeps the 1160px prose cap. That is the failure this pins: the
   * opt-out has to be on the element `app.tsx` mounts directly in `<main>`, and
   * a route that is half grid and half prose has to re-enter the measure from
   * the inside rather than leave the cap on and squeeze its grid.
   */
  it("lets a dense route escape the prose measure only from its own root", () => {
    const wide = cssRule(styles, '.route-layout > [data-route-measure="wide"]');
    expect(wide).toContain("width: 100%");
    expect(wide).toContain("max-width: none");
    // The rule has to outrank the default measure, which it can only do on
    // source order: both selectors weigh (0,2,0).
    expect(styles.indexOf('.route-layout > [data-route-measure="wide"]'))
      .toBeGreaterThan(styles.indexOf(".route-layout > *"));

    // On the opening tag of each route root, not on something inside it.
    expect(terminalSource).toMatch(/<section\s+class=\{`terminal-route[^>]*?data-route-measure="wide"/su);
    expect(proofSource).toMatch(/<section\s+class="work-view proof-view"[^>]*?data-route-measure="wide"/su);
    // …and each of those roots is what `app.tsx` renders straight into `<main>`.
    expect(app).toMatch(/<main\b[\s\S]*<ProofScreen\b/u);

    // The attestation ledger is the grid that wanted the width; the receipt
    // panel is prose and re-enters the same measure one level down.
    expect(cssRule(proofStyles, ".proof-surface-panel--prose")).toContain("width: min(1160px, 100%)");
    expect(proofSource).toContain('class="proof-surface-panel proof-surface-panel--prose"');
    expect(proofSource, "the evidence ledger keeps the width the route opted into")
      .toContain('id="proof-panel-attestations" class="proof-surface-panel"');
  });

  it("keeps profile navigation inside the route-owned gutter without nesting another inset", () => {
    expect(cssRule(styles, ".profile-hub-tabs")).toContain("width: min(1320px, 100%)");
    expect(cssRule(styles, ".profile-hub-tabs")).toContain("margin: 0 auto");
    expect(cssRule(styles, ".profile-scope-contract")).toContain("width: min(1320px, 100%)");
    expect(styles).not.toMatch(/\\.profile-(?:hub-tabs|scope-contract)[^{]*\{[^}]*width:\s*calc\(100%\s*-\s*(?:28|36)px\)/su);
  });

  it("keeps the Proof switcher's selected tab whole and charges the shortfall to the other one", () => {
    /*
     * Two defects, one rule. First, `1fr 1fr` was written on `.tabs` — whose two
     * children are the scrolling strip and the `⌄ n` overflow control. So at
     * 320px the strip got half the screen, both labels still laid out at their
     * nowrap widths inside it, and `Receipt & journal` rendered as an 8px sliver
     * of glyph beside a permanent overflow badge: a two-item switcher reading as
     * a rendering fault on the one route whose content depends on knowing which
     * view you are in.
     *
     * Moving the halving onto the strip fixed 320px and then charged every width
     * up to 760 for it. Two equal tracks are two equal tracks whether or not the
     * labels need cutting, so at 430px — where both had always fitted whole —
     * `Attestation evidence` was cut to `Attestation evide…` while `Receipt &
     * journal` sat in a half it did not fill.
     *
     * `flex: 1 1 auto` was written next to say both things at once, and it said
     * neither: measured on the shipped build the active tab came out at exactly
     * half the strip at every phone width — 141 of 286 at 320, 176 of 356 at
     * 390, 196 of 396 at 430 — so 430 kept the cut the rule was added to remove.
     * A tab that grows into slack starts from its label; one that lands on a
     * pixel-exact half started from zero.
     *
     * Scoping that growth to ≤400px fixed 430 and charged 390 instead, which is
     * where this test's subject comes from. The strip is 356px at 390 for a pair
     * wanting 386, and every rule tried so far has taken the 30px shortfall out
     * of both tabs — so `Receipt & journal` rendered `Receipt & jou…` while it
     * was the selected tab, and `Attestation evidence` did the same at 320 and
     * 390 whenever it was the selected one. That is the one truncation a user
     * cannot undo: every other clipped label is one tap from being read, and
     * this one is clipped *because* you already tapped it.
     *
     * So what is pinned is not a split at all. The selected tab pays nothing —
     * `flex-shrink: 0`, because any share of a 30px deficit costs it a
     * character — and the unselected tab absorbs the whole of it. The cap is
     * the other half of the contract: without it a selected tab that refuses to
     * shrink can, at a large `--type-scale`, eat the strip and bring back the
     * `⌄ n` chevron. Both halves are asserted here because either alone is a
     * defect.
     */
    // This sheet has more than one band at any given width, so the block is
    // selected by what it contains rather than by which one comes first.
    const band = (width: number, selector: string) =>
      [...styles.matchAll(new RegExp(`@media \\(max-width: ${width}px\\) \\{(?:[^{}]|\\{[^{}]*\\})*\\}`, "gu"))]
        .map((match) => match[0])
        .find((block) => block.includes(selector)) ?? "";
    const phoneBand = band(760, ".proof-surface-tabs");
    expect(phoneBand, "the phone rules for this strip live in one band").not.toBe("");
    expect(phoneBand).toMatch(/\.proof-surface-tabs \.tabs__tab\[data-active="true"\] \{[^}]*flex-shrink: 0/u);
    expect(phoneBand).toMatch(
      /\.proof-surface-tabs \.tabs__tab\[data-active="true"\] \{[^}]*max-width: calc\(100% - var\(--touch-target\) - var\(--sp-1\)\)/u,
    );
    // No band may hand the tabs equal shares again, at any width. `flex: 1 1
    // auto` on the tab is the 176-of-356 halving this replaces; it belongs to
    // `.tabs__strip`, which is a different box, so the selector is exact.
    expect(styles).not.toMatch(/\.proof-surface-tabs \.tabs__tab(?:-button)? \{[^}]*flex: 1 1 auto/u);
    expect(styles).not.toMatch(/\.proof-surface-tabs[^{]*\{[^}]*grid-template-columns/u);
    // And the unselected tab has to be allowed to shrink below its own label,
    // or there is nothing to absorb the shortfall with and the overflow returns.
    expect(styles).toMatch(/\.proof-surface-tabs \.tabs__tab \{[^}]*min-width: 0/u);
    expect(styles).toMatch(/\.proof-surface-tabs \.tabs__tab-button \{[^}]*min-width: 0/u);
    expect(styles).toMatch(/\.tabs__label \{[^}]*text-overflow: ellipsis/u);
  });

  it("lets the Agent-configuration tabs share the narrowest row instead of each taking a third", () => {
    /*
     * The same defect as the Proof switcher above, one route over and one tab
     * wider. `repeat(3, minmax(0, 1fr))` is an equal share, and at 320px an
     * equal share is a 93px cell — into which "Capabilities" lays out 86px of
     * ink. Measured off the shipped frame: seven pixels of air to the word's
     * left, one to its right, its trailing "s" standing on the pill's rounded
     * border, while "Skills" held 38px of ink in an identical cell. There is no
     * width for the label to be given, because the strip is not short of room —
     * it is dividing the room it has by a rule that cannot see the labels.
     *
     * `minmax(0, auto)` is the rule that says both things at once: take at most
     * your own content, and let the grid's default stretch hand out the surplus
     * evenly so the strip still fills the row. This strip is not short of room
     * at 320, so it needs no version of the Proof switcher's rule above — there
     * is no shortfall here for a selected tab to be spared from, only a surplus
     * that was being handed out without looking at the labels. The `0` floor is
     * load-bearing on its own — it is what the enclosing block's note is about,
     * and without it a track can insist on a width a 320px phone does not have
     * and scroll the whole route sideways.
     *
     * Pinned at 360px and not at 640: 390px already affords 117px a tab, and
     * the frames at 390, 430 and landscape-932 were passed by the sweep with
     * equal thirds. A repair that reshaped them would be taking width from
     * things that had nothing wrong with them.
     */
    expect(styles).toMatch(/@media \(max-width: 360px\) \{[^}]*\.profile-hub-tabs \{[^}]*grid-template-columns: repeat\(3, minmax\(0, auto\)\)/u);
    // Stated, not inherited from the user agent's button default: "zero inline
    // padding" was only ever true because no rule here had said otherwise.
    expect(styles).toMatch(/@media \(max-width: 360px\) \{[\s\S]*?\.profile-hub-tabs > button \{[^}]*padding-inline:/u);
    // Above that width the thirds are still thirds, so nothing the sweep passed
    // is reshaped by this.
    expect(cssRule(styles, ".profile-hub-tabs")).toContain("repeat(3, minmax(100px, 1fr))");
  });
});

function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start) + 1;
  return source.slice(bodyStart, source.indexOf("}", bodyStart));
}
