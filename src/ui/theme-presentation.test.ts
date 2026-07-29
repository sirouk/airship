import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { createBuiltInProfileCatalog } from "../profiles/catalog";
import { applyPreferenceOverrides, DEFAULT_PREFERENCES, STYLESHEET_PRESENTATION_DEFAULTS } from "./platform-shell";
import { themePresentation, themePresentationSummary } from "./profile-theme-swatch";

const tokens = await readFile(new URL("./tokens.css", import.meta.url), "utf8");
const builtInThemes = (await createBuiltInProfileCatalog()).themes;

function fakeRoot() {
  return { dataset: {} as Record<string, string>, style: {} as { colorScheme?: string } };
}

function theme(themeId: string) {
  const found = builtInThemes.find((candidate) => candidate.themeId === themeId);
  if (!found) throw new Error(`No built-in theme ${themeId}.`);
  return found;
}

describe("theme presentation reaches the document", () => {
  it("lets a theme establish type scale, density, corners and body font under default preferences", () => {
    // Blue Ledger is the only built-in whose manifest asks for anything other
    // than the stylesheet baseline. Before the preference layer took a base,
    // these four assertions were all "comfortable/subtle/default/system-sans":
    // the theme wrote them and the preference layer overwrote them one
    // statement later, which made ThemeManifest.typography/.layout dead.
    const blueLedger = theme("blue-ledger");
    const root = fakeRoot();
    applyPreferenceOverrides(DEFAULT_PREFERENCES, root as unknown as HTMLElement, themePresentation(blueLedger));
    expect(root.dataset.typeScale).toBe("compact");
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.corners).toBe("square");
    expect(root.dataset.bodyFont).toBe("system-sans");
  });

  it("keeps the preference the final layer wherever the user chose one", () => {
    const blueLedger = theme("blue-ledger");
    const root = fakeRoot();
    applyPreferenceOverrides(
      { ...DEFAULT_PREFERENCES, typeScale: "x-large", corners: "rounded" },
      root as unknown as HTMLElement,
      themePresentation(blueLedger),
    );
    expect(root.dataset.typeScale).toBe("x-large");
    expect(root.dataset.corners).toBe("rounded");
    // Untouched preferences still fall through to the theme.
    expect(root.dataset.density).toBe("compact");
  });

  it("returns to the theme's value when a preference is set back to default", () => {
    // The reason the resolved value is always written rather than skipped: a
    // skip would strand the previous override on the element forever.
    const blueLedger = theme("blue-ledger");
    const root = fakeRoot();
    applyPreferenceOverrides({ ...DEFAULT_PREFERENCES, density: "compact" }, root as unknown as HTMLElement, STYLESHEET_PRESENTATION_DEFAULTS);
    expect(root.dataset.density).toBe("compact");
    applyPreferenceOverrides(DEFAULT_PREFERENCES, root as unknown as HTMLElement, STYLESHEET_PRESENTATION_DEFAULTS);
    expect(root.dataset.density).toBe("comfortable");
    applyPreferenceOverrides(DEFAULT_PREFERENCES, root as unknown as HTMLElement, themePresentation(blueLedger));
    expect(root.dataset.density).toBe("compact");
  });
});

describe("one vocabulary for data-type-scale", () => {
  it("translates the manifest's 'standard' into the attribute's 'default'", () => {
    // The manifest word is not renamed: theme manifests are content-addressed
    // and persisted, so the rename would fail every stored catalog's digest
    // check. The two names are reconciled at the write site instead.
    for (const manifest of builtInThemes) {
      expect(themePresentation(manifest).typeScale).not.toBe("standard");
    }
    expect(themePresentation(theme("foundry")).typeScale).toBe("default");
    expect(themePresentation(theme("blue-ledger")).typeScale).toBe("compact");
  });

  it("gives every value either writer can emit a --type-scale block in tokens.css", () => {
    const emitted = new Set<string>([
      DEFAULT_PREFERENCES.typeScale,
      "large",
      "x-large",
      ...builtInThemes.map((manifest) => themePresentation(manifest).typeScale),
    ]);
    for (const value of emitted) {
      expect(tokens, `tokens.css has no --type-scale block for data-type-scale="${value}"`)
        .toContain(`:root[data-type-scale="${value}"] {`);
    }
  });
});

describe("the theme library names what activation produces", () => {
  it("states the applied type scale, density and corners beside the colours", () => {
    expect(themePresentationSummary(theme("blue-ledger")))
      .toBe("compact type · compact density · square corners");
    expect(themePresentationSummary(theme("foundry")))
      .toBe("default type · comfortable density · subtle corners");
  });
});
