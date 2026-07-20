import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [app, styles, sessions, featureStyles] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
  readFile(new URL("./sessions-view.css", import.meta.url), "utf8"),
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
    expect(app).toContain('? "main route-layout trust-route-layout"');
    expect(app).toContain(': "main route-layout"');
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

  it("keeps trust navigation full-bleed without adding a second content gutter", () => {
    const tabs = cssRule(styles, ".trust-route-layout > .trust-hub-tabs");
    expect(tabs).toContain("calc(-1 * var(--route-gutter-inline-start))");
    expect(tabs).toContain("calc(-1 * var(--route-gutter-inline-end))");
    expect(cssRule(styles, ".trust-route-layout > :not(.trust-hub-tabs)")).toContain("margin-top: var(--route-gutter-block)");
  });
});

function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start) + 1;
  return source.slice(bodyStart, source.indexOf("}", bodyStart));
}
