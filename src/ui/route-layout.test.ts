import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readAirshipStyles } from "./style-sheets.test-helper";

const [app, styles, sessions, terminalSource, featureStyles] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readAirshipStyles(),
  readFile(new URL("./sessions-view.css", import.meta.url), "utf8"),
  readFile(new URL("./terminal-view.tsx", import.meta.url), "utf8"),
  Promise.all([
    ["provider-fabric", "./provider-connections-view.css"],
    ["capabilities-view", "./capabilities-view.css"],
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
    expect(app).toContain('? "main chat-layout no-inspector"');
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
      expect(cssRule(source, `.${selector}`), selector).not.toMatch(/(?:^|;)\s*padding(?:-inline|-left|-right)?\s*:/u);
    }
  });

  it("applies safe-area-aware mobile insets once at the route shell", () => {
    expect(styles).toContain("--route-gutter-inline-start: max(13px, env(safe-area-inset-left));");
    expect(styles).toContain("--route-gutter-inline-end: max(13px, env(safe-area-inset-right));");
    expect(styles).not.toMatch(/\.work-view\s*\{[^}]*safe-area-inset/su);
    expect(sessions).not.toMatch(/\.session-library-view\s*\{[^}]*safe-area-inset/su);
  });

  it("keeps prose routes centered while dense workbenches can use full width", () => {
    const vault = cssRule(styles, ".route-layout > .vault-route");
    expect(vault).toContain("width: min(1160px, 100%)");
    expect(vault).toContain("margin-inline: auto");
    const wide = cssRule(styles, '.route-layout > [data-route-measure="wide"]');
    expect(wide).toContain("width: 100%");
    expect(wide).toContain("max-width: none");
    expect(terminalSource).toMatch(/<section\s+class=\{`terminal-route[^>]*?data-route-measure="wide"/su);
  });

  it("holds the profile hub strip inside the scrolling route", () => {
    const sticky = [...styles.matchAll(/\.profile-hub-tabs \{([^}]*)\}/gu)]
      .map((match) => match[1])
      .find((body) => body.includes("position: sticky")) ?? "";
    expect(sticky).toContain("top: 0");
    expect(sticky).toContain("z-index: 2");
    const band = cssRule(styles, ".profile-hub-tabs::before");
    expect(band).toContain("var(--route-gutter-inline-start)");
    expect(band).toContain("var(--route-gutter-inline-end)");
    expect(band).toContain("var(--route-gutter-block)");
    expect(band).toContain("background: var(--ground)");
    expect(band).toContain("bottom: 100%");
  });

  it("keeps profile navigation inside the route-owned measure", () => {
    expect(cssRule(styles, ".profile-hub-tabs")).toContain("width: min(1160px, 100%)");
    expect(cssRule(styles, ".profile-hub-tabs")).toContain("margin: 0 auto");
    expect(styles).not.toMatch(/\.profile-hub-tabs[^{]*\{[^}]*width:\s*calc\(100%\s*-\s*(?:28|36)px\)/su);
  });

  it("writes one 1160px prose measure across the shared route family", () => {
    for (const selector of [".route-layout > *", ".route-layout > .vault-route", ".profile-hub-tabs"]) {
      expect(cssRule(styles, selector), selector).toMatch(/width:\s*min\(1160px,\s*100%\)/u);
    }
  });

  it("binds Vault facts to a readable value column on wide screens", () => {
    const vault = featureStyles.find(({ selector }) => selector === "vault-view")!.source;
    expect(cssRule(vault, ".vault-view__attached li")).toContain("justify-content: space-between");
    const wide = vault.slice(vault.indexOf("@media (min-width: 1101px)"));
    expect(wide).toContain(".vault-view__attached li { justify-content: flex-start; }");
    expect(wide).toMatch(/\.vault-view__attached li > span \{ flex: 0 0 \d+rem; \}/u);
    expect(wide).toContain("text-align: start");
  });

  it("caps source disclosures rather than the row holding Commit", () => {
    const sources = featureStyles.find(({ selector }) => selector === "git-sources")!.source;
    const desktop = sources.slice(sources.indexOf("@media (min-width: 1101px)"), sources.indexOf("@media (max-width: 1100px)"));
    expect(desktop).not.toMatch(/\.git-rails\s*\{[^}]*max-height/su);
    expect(desktop).toContain(".git-repository-controls,\n  .git-remote-boundary { max-height: 200px; overflow-y: auto; }");
    expect(sources).not.toMatch(/\.git-commit-box\s*\{[^}]*max-height/su);
  });

  it("lets a closed capabilities disclosure keep its own height", () => {
    const capabilities = featureStyles.find(({ selector }) => selector === "capabilities-view")!.source;
    expect(cssRule(capabilities, ".capability-policy-row > details:not([open])")).toContain("align-self: start");
  });

  it("lets agent-configuration tabs share the narrowest row", () => {
    expect(styles).toMatch(/@media \(max-width: 360px\) \{[^}]*\.profile-hub-tabs \{[^}]*grid-template-columns: repeat\(3, minmax\(0, auto\)\)/u);
    expect(styles).toMatch(/@media \(max-width: 360px\) \{[\s\S]*?\.profile-hub-tabs > button \{[^}]*padding-inline:/u);
    expect(cssRule(styles, ".profile-hub-tabs")).toContain("repeat(3, minmax(100px, 1fr))");
  });

  it("fades route edges only when content is hidden", () => {
    for (const [edges, gradient] of [
      ["start", "linear-gradient(to bottom, transparent 0, #000 26px)"],
      ["end", "linear-gradient(to bottom, #000 calc(100% - 26px), transparent 100%)"],
    ] as const) expect(styles).toContain(`.route-layout[data-scroll-edges="${edges}"] { --route-scroll-fade: ${gradient}; }`);
    expect(styles).toContain('.route-layout[data-scroll-edges="both"] { --route-scroll-fade:');
    expect(styles).toMatch(/\.route-layout\[data-scroll-edges\]:not\(\[data-scroll-edges="none"\]\)/u);
    expect(app).toContain("useScrollEdges(mainRegion,");
    expect(styles).toMatch(/@media \(forced-colors: active\) \{[\s\S]*?\.route-layout\[data-scroll-edges\][\s\S]*?mask-image: none/u);
  });

  it("stands the route fade down while an overlay is open inside it", () => {
    const masked = /\.route-layout\[data-scroll-edges\]:not\(\[data-scroll-edges="none"\]\)([^{]*)\{([^}]+)\}/u.exec(styles);
    expect(masked?.[1]).toContain(':not(:has(.popover[data-open="true"]))');
    expect(masked?.[1]).toContain(':not(:has(.menu-select-trigger[aria-expanded="true"]))');
    expect(masked?.[2]).toContain("mask-image: var(--route-scroll-fade)");
  });
});

function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start) + 1;
  return source.slice(bodyStart, source.indexOf("}", bodyStart));
}
