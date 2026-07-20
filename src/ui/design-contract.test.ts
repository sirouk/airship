import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [appSource, attestationSource, sealSource, sessionsSource, sourcesSource, styles, vaultStyles, localLabStyles, menuStyles, routeStyles] = await Promise.all([
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
  readFile(new URL("./attestations-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./seal.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sessions-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sources-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
  readFile(new URL("./vault-view.css", import.meta.url), "utf8"),
  readFile(new URL("./local-lab-setup.css", import.meta.url), "utf8"),
  readFile(new URL("./menu-select.css", import.meta.url), "utf8"),
  Promise.all([
    readFile(new URL("./access-view.css", import.meta.url), "utf8"),
    readFile(new URL("./attestations-view.css", import.meta.url), "utf8"),
    readFile(new URL("./context-view.css", import.meta.url), "utf8"),
    readFile(new URL("./sources-view.css", import.meta.url), "utf8"),
  ]).then((sources) => sources.join("\n")),
]);

describe("Airship Instrument design contract", () => {
  it("uses the shared Seal instead of retired proof glyphs", () => {
    expect(appSource).not.toMatch(/seal-glyph|large-seal|[◐⌛]/u);
    expect(attestationSource).not.toMatch(/statusSymbol|[◐⌛]/u);
    expect(appSource).toContain("<Seal");
    expect(attestationSource).toContain("<Seal");
  });

  it("exposes one accessible image and keeps the SVG presentational", () => {
    expect(sealSource).toContain('role="img"');
    expect(sealSource).toContain("aria-label={accessibleLabel}");
    expect(sealSource).toContain('aria-hidden="true"');
    expect(sealSource).toContain('<span class="seal__label">{label}</span>');
  });

  it("locks the canonical truth palette independently of profile accents", () => {
    expect(property("--v-verified")).toBe("#67a39a");
    expect(property("--v-caution")).toBe("#d9a441");
    expect(property("--v-failed")).toBe("#c86758");
    expect(property("--v-info")).toBe("#7fa8c9");
    expect(property("--truth-local")).toBe("#8ba0a6");
    expect(property("--truth-remote")).toBe("#bd6f4c");
  });

  it("uses copper only as the asserted working metal and keeps a responsive profile switcher pair", () => {
    expect(property("--copper")).toBe("#b8734f");
    expect(styles).toContain('.seal[data-state="asserted"]');
    expect(styles).toMatch(/\.seal\[data-state="asserted"\]\s*\{[^}]*color:\s*var\(--copper\)/u);
    expect(styles).not.toContain("--copper: var(--accent)");
    expect(appSource.match(/ariaLabel="Agent profile"/gu)).toHaveLength(2);
    expect(menuStyles).toContain(".compact-profile-menu { display:none; }");
    expect(appSource).not.toMatch(/<select[^>]+aria-label="Agent profile"/u);
  });

  it("uses one styled menu contract instead of native route selects", () => {
    expect(`${appSource}\n${sessionsSource}\n${sourcesSource}`).not.toMatch(/<select(?:\s|>)/u);
    expect(menuStyles).toContain(".menu-select.placement-down .menu-select-popover");
  });

  it("uses one focus token, immutable verdict tones, and the display face across rem views", () => {
    expect(property("--focus")).toBe("var(--accent-bright)");
    expect(`${vaultStyles}\n${localLabStyles}`).not.toMatch(/--signal-(?:good|warn|info)|#8db8df|var\(--focus,/u);
    expect(vaultStyles).toContain("var(--v-verified)");
    expect(localLabStyles).toContain("var(--v-caution)");
    expect(routeStyles.match(/font-family:\s*var\(--font-display\)/gu)).toHaveLength(4);
  });

  it("renders the mobile shell as four fixed primary controls without horizontal scrolling", () => {
    const mobileNavRules = [...styles.matchAll(/\.mobile-nav\s*\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
    const mobileRule = mobileNavRules.find((rule) => rule.includes("repeat(4")) ?? "";
    expect(mobileRule).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(mobileRule).toContain("overflow: hidden");
    expect(mobileRule).not.toContain("overflow-x: auto");
    expect(mobileRule).not.toContain("grid-auto-flow");
  });
});

function property(name: string): string | undefined {
  const marker = name + ":";
  const start = styles.indexOf(marker);
  if (start < 0) return undefined;
  return styles.slice(start + marker.length).split(";", 1)[0]?.trim();
}
