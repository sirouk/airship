import { describe, expect, it } from "vitest";

import { createBuiltInProfileCatalog } from "./catalog";
import { validateProfileCatalog } from "./persistence";
import { createThemeManifest, type ThemeManifestDraft } from "./domain";

/*
 * Pass 3 — adversarial load for the Vault-revival boundary.
 *
 * A Vault is ciphertext until provenance proves otherwise: an older, hostile,
 * or same-origin page that ever wrote into this origin could seed manifests
 * this validator must refuse before a byte of them is rendered, applied as
 * CSS, or handed to a digest the rest of the product will then bless forever.
 *
 * The catalog owns three rejection families, all covered below:
 *  — poison keys that walk the prototype chain if spread blindly
 *  — color values that land in `el.style.setProperty` unfiltered (a `url()`
 *    in a custom property is a fetch beacon; anything non-hex must throw)
 *  — shapes and counts a hostile encoder can inflate without limit
 */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type CatalogRecord = Record<string, unknown> & {
  themes: Record<string, unknown>[];
  skills: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
};

async function builtInRecord(): Promise<CatalogRecord> {
  return clone(await createBuiltInProfileCatalog()) as unknown as CatalogRecord;
}

/**
 * The injection Vector: plain assignment `record["__proto__"] = x` sets a
 * prototype, but `JSON.parse` plants the string as an OWN enumerable key —
 * which is exactly what a hostile Vault payload delivers. This helper plants
 * the same thing the parser would, so `Object.hasOwn` sees what revival sees.
 */
function withOwnKey<T extends object>(target: T, key: string, value: unknown): T {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return target;
}

describe("adversarial profile catalog revival", () => {
  it("rejects poison keys at every nest level of the catalog", async () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const makeVariants = async (): Promise<Record<string, unknown>[]> => {
        const out: Record<string, unknown>[] = [];
        const top = await builtInRecord();
        out.push(withOwnKey(top as unknown as object, key, { polluted: true }) as unknown as Record<string, unknown>);

        const inTheme = await builtInRecord();
        out.push(withOwnKey(inTheme.themes[0]!, key, { polluted: true }) as unknown as Record<string, unknown>);

        const inColors = await builtInRecord();
        out.push(withOwnKey(inColors.themes[0]!.colors as object, key, "#ffffff") as unknown as Record<string, unknown>);

        const inSkill = await builtInRecord();
        out.push(withOwnKey(inSkill.skills[0]!, key, { polluted: true }) as unknown as Record<string, unknown>);

        const inProfile = await builtInRecord();
        out.push(withOwnKey(inProfile.profiles[0]!, key, { polluted: true }) as unknown as Record<string, unknown>);
        return out;
      };
      const variants = await makeVariants();
      for (const [index, variant] of variants.entries()) {
        await expect(validateProfileCatalog(variant), `${key} at nest ${index}`).rejects.toThrow();
      }
    }
    // Nothing the rejection path rejected poisoned the global object.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects oversized populations at the bound, not after digest work", async () => {
    const catalog = await builtInRecord();
    // MAX_THEMES is 256; inflate far past it. The bound must reject before
    // per-record digest verification, or the validator becomes the amplifier.
    for (let i = 0; i < 300; i += 1) catalog.themes.push(clone(catalog.themes[0]!));
    const probe = performance.now();
    await expect(validateProfileCatalog(catalog as unknown as Record<string, unknown>)).rejects.toThrow();
    expect(performance.now() - probe).toBeLessThan(500);
  });

  it("rejects a forged color on the wire", async () => {
    const corrupted = await builtInRecord();
    corrupted.themes[0]!.colors = {
      ...(corrupted.themes[0]!.colors as Record<string, unknown>),
      accent: "url(https://attacker.example/beacon.gif)",
    };
    await expect(validateProfileCatalog(corrupted as unknown as Record<string, unknown>)).rejects.toThrow();
  });

  it("rejects a fetch beacon before there is a digest to forge", async () => {
    // `createThemeManifest` validates content before it can carry a digest:
    // no color value that is not hex can ever become a blessed theme.
    const hostile = {
      themeId: "evil-beacon",
      name: "Evil Beacon",
      description: "",
      colorScheme: "dark" as const,
      colors: {
        ground: "#101417" as `#${string}`,
        surface: "#171c20" as `#${string}`,
        surfaceRaised: "#1c2226" as `#${string}`,
        surfaceSoft: "#14191c" as `#${string}`,
        ink: "#ece8de" as `#${string}`,
        inkMuted: "#b0b6b3" as `#${string}`,
        inkFaint: "#949c99" as `#${string}`,
        accent: "url(https://attacker.example/beacon.gif)" as unknown as `#${string}`,
        accentBright: "#dfba72" as `#${string}`,
      },
      typography: { body: "system-sans" as const, scale: "standard" as const },
      layout: { density: "comfortable" as const, corners: "subtle" as const },
    };
    await expect(createThemeManifest(hostile)).rejects.toThrow(/accent/u);
    await expect(createThemeManifest({ ...hostile, colors: { ...hostile.colors, accent: "#12345" } })).rejects.toThrow(/accent/u);
    await expect(createThemeManifest({
      ...hostile,
      colors: { ...hostile.colors, accent: "expression(alert(1))" as unknown as `#${string}` },
    })).rejects.toThrow(/accent/u);
  });

  it("rejects identifiers that escape their grammar", async () => {
    const catalog = await builtInRecord();
    catalog.themes[0]!.themeId = "../../etc/passwd";
    await expect(validateProfileCatalog(catalog as unknown as Record<string, unknown>)).rejects.toThrow();
  });
});
