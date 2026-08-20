import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MOBILE_PRIMARY_CONTROLS } from "./navigation-model";
import { readAirshipStyles } from "./style-sheets.test-helper";

const [appSource, statusMarkSource, sessionsSource, sourcesSource, styles, vaultStyles, localLabStyles, menuStyles, mobileNavSource, routeStyles, durabilityStyles] = await Promise.all([
  Promise.all([
    readFile(new URL("./app.tsx", import.meta.url), "utf8"),
    readFile(new URL("./rail.tsx", import.meta.url), "utf8"),
  ]).then((sources) => sources.join("\n")),
  readFile(new URL("./status-mark.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sessions-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("./sources-view.tsx", import.meta.url), "utf8"),
  readAirshipStyles(),
  readFile(new URL("./vault-view.css", import.meta.url), "utf8"),
  readFile(new URL("./local-lab-setup.css", import.meta.url), "utf8"),
  readFile(new URL("./menu-select.css", import.meta.url), "utf8"),
  readFile(new URL("./mobile-navigation.tsx", import.meta.url), "utf8"),
  Promise.all([
    readFile(new URL("./provider-connections-view.css", import.meta.url), "utf8"),
    readFile(new URL("./context-view.css", import.meta.url), "utf8"),
    readFile(new URL("./sources-view.css", import.meta.url), "utf8"),
  ]).then((sources) => sources.join("\n")),
  readFile(new URL("./durability-indicator.css", import.meta.url), "utf8"),
]);

describe("Airship Instrument design contract", () => {
  it("uses the shared status mark without retired proof glyphs", () => {
    expect(appSource).not.toMatch(/seal-glyph|large-seal|[◐⌛]/u);
    expect(appSource).toContain("<StatusMark");
    expect(sessionsSource).toContain("<StatusMark");
  });

  it("exposes one accessible image and keeps its SVG presentational", () => {
    expect(statusMarkSource).toContain('role="img"');
    expect(statusMarkSource).toContain("aria-label={accessibleLabel}");
    expect(statusMarkSource).toContain('aria-hidden="true"');
    expect(statusMarkSource).toContain('<span class="status-mark__label">{label}</span>');
  });

  it("keeps acting and stale SVG hooks paired with their stylesheet behavior", () => {
    expect(statusMarkSource).toContain('class="status-mark__arc--checking"');
    expect(statusMarkSource).toContain('class="status-mark__arc--stale"');
    expect(styles).toMatch(/\.status-mark\[data-acting="true"\]\s+\.status-mark__arc--checking/u);
    expect(styles).toContain("@keyframes status-mark-checking");
    expect(styles).toMatch(/\.status-mark__arc--stale\s*\{[^}]*stroke-dasharray/u);
  });

  it("gives every status density at least 16px and keeps the label accessible", () => {
    expect(statusMarkSource).toMatch(/statusMarkRenderedSize\(size \?\? \(density === "hero" \? 28 : 16\)\)/u);
    expect(statusMarkSource).toMatch(/statusMarkDensitySize\(density,\s*size\)/u);
    expect(statusMarkSource).toContain("Math.max(16, size)");
    expect(styles).toMatch(/\.status-mark\[data-density="dot"\]\s+\.status-mark__label\s*\{[^}]*clip-path/u);
    expect(styles).not.toMatch(/\.status-mark\[data-density="dot"\]\s+\.status-mark__label\s*\{[^}]*display:\s*none/u);
    expect(durabilityStyles).not.toMatch(/border-radius:\s*50%/u);
  });

  it("uses one compact recipe for run metadata and runtime state", () => {
    const recipe = styles.match(/\.receipt-chip,\s*\.runtime-posture\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(recipe).toContain("border-radius: var(--radius-chip)");
    expect(recipe).toContain("color-mix(in srgb, currentColor 34%, transparent)");
    expect(styles).not.toContain(".attestation-chip");
    expect(styles).not.toContain(".proof-level");
  });

  it("keeps notice tone off the sentence it tints", () => {
    const notice = styles.match(/\.workbench-notice\s*\{([^}]+)\}/u)?.[1] ?? "";
    expect(notice).toContain("--notice-tone");
    expect(notice).toContain("color: var(--ink-muted)");
  });

  it("keeps state and boundary colors independent of profile accents", () => {
    expect(property("--v-verified")).toBe("#67a39a");
    expect(property("--v-caution")).toBe("#d9a441");
    expect(property("--v-failed")).toBe("#d68172");
    expect(property("--v-info")).toBe("#7fa8c9");
    expect(property("--truth-local")).toBe("#8ba0a6");
    expect(property("--truth-remote")).toBe("#bd6f4c");
  });

  it("keeps one responsive profile switcher pair", () => {
    expect(appSource.match(/ariaLabel="Agent profile"/gu)).toHaveLength(2);
    expect(menuStyles).toContain(".compact-profile-menu { display:none; }");
    expect(appSource).not.toMatch(/<select[^>]+aria-label="Agent profile"/u);
  });

  it("uses the styled menu contract instead of native route selects", () => {
    expect(`${appSource}\n${sessionsSource}\n${sourcesSource}`).not.toMatch(/<select(?:\s|>)/u);
    expect(menuStyles).toContain(".menu-select.placement-down .menu-select-popover");
  });

  it("carries each profile theme into its muted initials badge", () => {
    expect(appSource).toContain("profileThemeFor(catalog, option.value)");
    expect(appSource).toContain('"--profile-accent": theme.colors.accent');
    expect(styles).toContain("--profile-accent: var(--accent)");
    expect(styles).toContain("color-mix(in srgb, var(--profile-accent) 10%, var(--profile-surface))");
  });

  it("uses the shared focus token and display face across route sheets", () => {
    expect(property("--focus")).toBe("var(--accent-bright)");
    expect(`${vaultStyles}\n${localLabStyles}`).not.toMatch(/--signal-(?:good|warn|info)|#8db8df|var\(--focus,/u);
    expect(routeStyles).not.toContain("--focus:");
  });

  it("renders fixed mobile primary controls without horizontal scrolling", () => {
    const mobileNavRules = [...styles.matchAll(/\.mobile-nav\s*\{([^}]+)\}/gu)].map((match) => match[1] ?? "");
    const mobileRule = mobileNavRules.find((rule) => rule.includes("grid-template-columns")) ?? "";
    expect(mobileRule).toMatch(
      new RegExp(`grid-template-columns:\\s*repeat\\(${MOBILE_PRIMARY_CONTROLS.length}, minmax\\(0, 1fr\\)\\);`, "u"),
    );
    expect(mobileNavSource).toContain("{MOBILE_PRIMARY_CONTROLS.map((control) => {");
    expect(mobileNavSource).not.toContain("<RuntimeLoadIndicator");
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
