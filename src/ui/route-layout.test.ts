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

  it("halves the Proof switcher across its two tabs, not across the strip and its chevron", () => {
    /*
     * `1fr 1fr` is one column per tab, and it was written on `.tabs` — whose two
     * children are the scrolling strip and the `⌄ n` overflow control. So at
     * 320px the strip got half the screen, both labels still laid out at their
     * nowrap widths inside it, and `Receipt & journal` rendered as an 8px sliver
     * of glyph beside a permanent overflow badge: a two-item switcher reading as
     * a rendering fault on the one route whose content depends on knowing which
     * view you are in.
     */
    expect(styles).toMatch(/\.proof-surface-tabs \.tabs__strip \{[^}]*grid-template-columns: 1fr 1fr/u);
    // The root may never carry the halving again: it is a claim about how many
    // children there are, and there are two only while the chevron exists.
    expect(styles).not.toMatch(/\.proof-surface-tabs \{[^}]*grid-template-columns/u);
    // And each tab has to be allowed to shrink below its own label, or the
    // halving just moves the overflow one box inwards.
    expect(styles).toMatch(/\.proof-surface-tabs \.tabs__tab \{[^}]*min-width: 0/u);
    expect(styles).toMatch(/\.proof-surface-tabs \.tabs__tab-button \{[^}]*min-width: 0/u);
    expect(styles).toMatch(/\.tabs__label \{[^}]*text-overflow: ellipsis/u);
  });
});

function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start) + 1;
  return source.slice(bodyStart, source.indexOf("}", bodyStart));
}
