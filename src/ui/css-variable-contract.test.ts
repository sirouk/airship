import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuiltInProfileCatalog } from "../profiles/catalog";
import {
  STYLESHEET_THEME_BASELINE,
  THEME_COLOR_ROLES,
  themeCssVariables,
  type ThemeColorRole,
} from "../profiles/domain";

type CssSource = Readonly<{
  file: string;
  text: string;
}>;

type CssVariableReference = Readonly<{
  name: string;
  hasFallback: boolean;
  line: number;
}>;

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const cssSources = await readCssSources(sourceRoot);

describe("CSS variable contract", () => {
  it("defines every source variable reference that has no local fallback", () => {
    const definitions = new Set(
      cssSources.flatMap(({ text }) => customPropertyDefinitions(text)),
    );
    const missing = cssSources.flatMap(({ file, text }) => (
      customPropertyReferences(text)
        .filter(({ name, hasFallback }) => !hasFallback && !definitions.has(name))
        .map(({ name, line }) => `${relative(sourceRoot, file)}:${line} ${name}`)
    ));

    expect(
      missing,
      [
        "Undefined CSS variables make complete declarations invalid at runtime.",
        "Define the token in the shared theme, replace it with a canonical token,",
        "or provide an explicit fallback for a deliberately runtime-owned value.",
      ].join(" "),
    ).toEqual([]);
  });
});

/*
 * The contrast half of the contract.
 *
 * A token file can declare a ratio in a comment; only a test can hold it. Both
 * halves are needed because the two layers that can break a ratio are
 * different: the *palette* (a theme manifest, written inline on <html>) and the
 * *mode* (a stylesheet block selected by a preference). Airship shipped a
 * regression in each — a theme whose `inkFaint` silently reverted the
 * stylesheet's AA fix, and a light mode that only flipped the four roles no
 * theme owns — so each layer gets its own assertion here.
 */
const TOKENS_CSS = await readFile(new URL("./tokens.css", import.meta.url), "utf8");
const PLATFORM_SHELL_CSS = await readFile(new URL("./platform-shell.css", import.meta.url), "utf8");
const APP_TSX = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

/** WCAG 1.4.3 AA for text below 18.66px, which is every caption in the product. */
const AA_TEXT = 4.5;
/** WCAG 1.4.11 for the boundary of a control and for a non-text status glyph. */
const NON_TEXT = 3;

describe("colour contract", () => {
  it("keeps every shipped palette's faint ink above AA on its own raised surface", async () => {
    const { themes } = await createBuiltInProfileCatalog();
    const failures = themes.flatMap((theme) => {
      const faint = contrast(theme.colors.inkFaint, theme.colors.surfaceRaised);
      return faint >= AA_TEXT ? [] : [`${theme.themeId} inkFaint ${faint.toFixed(2)}:1 on surfaceRaised`];
    });
    expect(failures, "A caption is where provenance lives; it may not be the thing below AA.").toEqual([]);
  });

  it("keeps every shipped palette's muted ink a rung above its faint ink", async () => {
    const { themes } = await createBuiltInProfileCatalog();
    const failures = themes.flatMap((theme) => {
      const muted = contrast(theme.colors.inkMuted, theme.colors.surface);
      const faint = contrast(theme.colors.inkFaint, theme.colors.surface);
      return [
        ...(muted >= 7 ? [] : [`${theme.themeId} inkMuted ${muted.toFixed(2)}:1 on surface`]),
        ...(muted > faint ? [] : [`${theme.themeId} inkMuted is not above inkFaint`]),
      ];
    });
    expect(failures, "Three ink tiers only read as three if the middle one is a step, not a nudge.").toEqual([]);
  });

  it("mirrors the stylesheet exactly in the baseline the theme layer diffs against", () => {
    const dark = resolvedTokens("dark");
    const light = resolvedTokens("light");
    const drift = THEME_COLOR_ROLES.flatMap((role) => [
      ...compareRole("dark", role, STYLESHEET_THEME_BASELINE.dark[role], dark),
      ...compareRole("light", role, STYLESHEET_THEME_BASELINE.light[role], light),
    ]);
    expect(drift, "profiles/domain.ts must restate the sheets verbatim or it will diff against a fiction.").toEqual([]);
  });

  it("writes no inline custom property for the shipped default profile", async () => {
    const { themes } = await createBuiltInProfileCatalog();
    const foundry = themes.find((theme) => theme.themeId === "foundry");
    const written = Object.entries(themeCssVariables(foundry!)).filter(([, value]) => value !== "");
    // Inline properties outrank the [data-mode] block a colour-mode preference
    // selects. The default profile must leave the whole palette to the cascade.
    expect(written).toEqual([]);
  });

  it("keeps every verdict, accent and ink legible in both colour modes", () => {
    const failures = (["dark", "light"] as const).flatMap((mode) => {
      const tokens = resolvedTokens(mode);
      const surface = tokens["--surface"]!;
      const raised = tokens["--surface-raised"]!;
      const ground = tokens["--ground"]!;
      const text: readonly [string, string, number][] = [
        ["--ink", surface, 7],
        ["--ink-muted", surface, 7],
        ["--ink-faint", raised, AA_TEXT],
        ["--v-verified", surface, AA_TEXT],
        ["--v-caution", surface, AA_TEXT],
        ["--v-info", surface, AA_TEXT],
        ["--truth-local", surface, AA_TEXT],
        ["--accent", surface, AA_TEXT],
        ["--accent-bright", surface, AA_TEXT],
        // The primary button paints --ground on --accent-bright; that pairing,
        // not the token on a surface, is what a person actually reads.
        ["--ground", tokens["--accent-bright"]!, AA_TEXT],
      ];
      const glyph: readonly [string, string, number][] = [
        // --v-failed and --copper are 4.2–4.6:1 by design; shell.css lifts their
        // chip *label* to --ink and keeps the colour for glyph, border and fill,
        // where 1.4.11's 3:1 is the applicable rule.
        ["--v-failed", surface, NON_TEXT],
        ["--copper", raised, NON_TEXT],
        ["--brand-mark", ground, NON_TEXT],
        ["--line-control", surface, NON_TEXT],
        ["--focus", ground, NON_TEXT],
      ];
      return [...text, ...glyph].flatMap(([token, bed, floor]) => {
        const ratio = contrast(tokens[token]!, bed);
        return ratio >= floor ? [] : [`${mode} ${token} ${ratio.toFixed(2)}:1 (needs ${floor})`];
      });
    });
    expect(failures, "A colour is a property of a swatch and its ground, so a mode has to re-express one.").toEqual([]);
  });

  it("keeps a divider visible against the surface it divides in both colour modes", () => {
    const failures = (["dark", "light"] as const).flatMap((mode) => {
      const tokens = resolvedTokens(mode);
      return (["--line", "--line-strong"] as const).flatMap((token) => {
        const ratio = contrast(tokens[token]!, tokens["--ground"]!);
        // 1.2:1 is not AA — a hairline never is. It is the floor below which a
        // divider is darker than its own panel, which is what Paper mode did.
        return ratio >= 1.2 ? [] : [`${mode} ${token} ${ratio.toFixed(3)}:1 over --ground`];
      });
    });
    expect(failures).toEqual([]);
  });

  /*
   * The cascade the app actually produces, not the one the manifest describes.
   *
   * Every assertion above reads one layer at a time: the palette on its own, or
   * the mode's stylesheet on its own. The screen is the composition of the two,
   * and the composition is where Paper mode broke — a dark-scheme theme diffed
   * against the dark sheet wrote all nine roles inline, and inline beats the
   * `[data-mode="light"]` block, so Research and Developer rendered a dark
   * palette under light-mode dividers and inks. This crosses every shipped
   * theme with every mode and re-runs the verdict, ink and line floors on the
   * overlay.
   */
  it("keeps every theme legible in every colour mode once the layers are composed", async () => {
    const { themes } = await createBuiltInProfileCatalog();
    const failures = themes.flatMap((theme) => (["dark", "light"] as const).flatMap((mode) => {
      const tokens: Record<string, string> = { ...resolvedTokens(mode) };
      for (const [property, value] of Object.entries(themeCssVariables(theme, mode))) {
        // An empty value is `removeProperty`: the stylesheet keeps the role.
        if (value !== "") tokens[property] = value;
      }
      const surface = tokens["--surface"]!;
      const raised = tokens["--surface-raised"]!;
      const ground = tokens["--ground"]!;
      const checks: readonly [string, string, number][] = [
        ["--v-verified", surface, AA_TEXT],
        ["--v-caution", surface, AA_TEXT],
        ["--v-info", surface, AA_TEXT],
        // Same split as the single-layer test above: --v-failed and --copper
        // are glyph, border and fill colours whose chip label is lifted to
        // --ink by shell.css, so 1.4.11's 3:1 is the applicable rule for them.
        ["--v-failed", surface, NON_TEXT],
        ["--copper", raised, NON_TEXT],
        ["--ink-faint", raised, AA_TEXT],
        ["--ink-disabled", tokens["--surface-disabled"]!, NON_TEXT],
        ["--line", ground, 1.2],
        ["--line-strong", ground, 1.2],
      ];
      return checks.flatMap(([token, bed, floor]) => {
        const ratio = contrast(tokens[token]!, bed);
        return ratio >= floor ? [] : [`${theme.themeId}/${mode} ${token} ${ratio.toFixed(3)}:1 (needs ${floor})`];
      });
    }));
    expect(
      failures,
      "themeCssVariables must diff against the mode in force; diffing against theme.colorScheme pins a palette on the wrong sheet.",
    ).toEqual([]);
  });

  /*
   * The other half of that composition: nothing may write the palette layer
   * without re-stating the preference layer in the same breath.
   *
   * `applyTheme` also writes the five `<html>` attributes the preference layer
   * owns (mode, type scale, density, corners, body font), so a caller that used
   * it directly silently reset the user's global display preferences —
   * previewing a theme in the Profiles editor did exactly that, and nothing put
   * them back. This is asserted on the source because the defect is *which
   * function is called*, which no rendered pixel can show.
   */
  it("writes the theme layer only through the wrapper that reasserts preferences", () => {
    const calls = [...APP_TSX.matchAll(/(?<![\w.])applyTheme\(/gu)];
    // Two: the declaration, and the one call inside `applyThemeWithPreferences`.
    expect(calls).toHaveLength(2);
    const wrapper = APP_TSX.slice(APP_TSX.indexOf("function applyThemeWithPreferences("));
    // The third argument is load-bearing: it hands the theme's presentation to
    // the preference layer as the base it diffs against, which is the only
    // reason a theme's typography and layout survive the reassertion at all.
    expect(wrapper.slice(0, wrapper.indexOf("}")))
      .toContain("applyPreferenceOverrides(preferences, document.documentElement, themePresentation(theme))");
  });

  it("never carries a disabled state on transparency", () => {
    const violations = cssSources.flatMap(({ file, text }) => (
      [...withoutComments(text).matchAll(/([^{}]*:disabled[^{}]*)\{([^}]*)\}/gu)]
        .filter((rule) => /(?:^|[;\s])opacity\s*:/u.test(rule[2] ?? ""))
        .map((rule) => `${relative(sourceRoot, file)} ${rule[1]?.trim()}`)
    ));
    // tokens.css declares --ink-disabled precisely so a disabled control
    // composites the same way over all 22 surfaces in the product. `toEqual`
    // rather than a subset check, so the ledger cannot rot in either
    // direction: a new offender fails, and a fixed one fails until it is
    // struck off. It only ever shrinks.
    expect(violations).toEqual(DISABLED_OPACITY_LEDGER);
  });
});

/**
 * The five `:disabled { opacity }` rules still outside this package's files.
 *
 * Each is the same defect as the one deleted from `tokens.css`: opacity
 * multiplies against whatever is behind, so six alphas (.42 through .72) over
 * 22 surfaces is why a reviewer cannot tell an enabled control from a disabled
 * one by looking. The base rule now carries --ink-disabled/--surface-disabled
 * for all of them, so each line below is a deletion, not a rewrite.
 */
const DISABLED_OPACITY_LEDGER = Object.freeze([
  "ui/attestations-view.css .attestations-view button:disabled",
  "ui/chat.css .slash-command-menu button:disabled",
  "ui/context-view.css .client-context-view button:disabled",
  "ui/sources-view.css .git-sources button:disabled",
  "ui/workspace-view.css .scm-row > button:disabled",
]);

function compareRole(
  mode: "dark" | "light",
  role: ThemeColorRole,
  declared: string,
  tokens: Readonly<Record<string, string>>,
): string[] {
  const property = { ground: "--ground", surface: "--surface", surfaceRaised: "--surface-raised", surfaceSoft: "--surface-soft", ink: "--ink", inkMuted: "--ink-muted", inkFaint: "--ink-faint", accent: "--accent", accentBright: "--accent-bright" }[role];
  const actual = tokens[property];
  return actual === declared ? [] : [`${mode} ${property}: baseline ${declared} vs stylesheet ${actual}`];
}

/**
 * The winning declaration for every custom property in a colour mode.
 *
 * Source order is the cascade at equal specificity, and the barrel loads
 * `platform-shell.css` *before* `tokens.css`, so a `[data-mode="light"]` block
 * in tokens.css wins over the one in platform-shell.css. Getting that backwards
 * is how a mode reverts a token silently, so the order is spelled out here.
 */
function resolvedTokens(mode: "dark" | "light"): Readonly<Record<string, string>> {
  const declarations: Record<string, string> = { ...blockDeclarations(TOKENS_CSS, ":root") };
  if (mode === "light") {
    Object.assign(declarations, blockDeclarations(PLATFORM_SHELL_CSS, ':root[data-mode="light"]'));
    Object.assign(declarations, blockDeclarations(TOKENS_CSS, ':root[data-mode="light"]'));
  }
  const resolved: Record<string, string> = {};
  for (const name of Object.keys(declarations)) resolved[name] = dereference(name, declarations, new Set());
  return Object.freeze(resolved);
}

function dereference(name: string, declarations: Readonly<Record<string, string>>, seen: Set<string>): string {
  const value = declarations[name] ?? "";
  const alias = value.match(/^var\(\s*(--[\w-]+)\s*\)$/u)?.[1];
  if (!alias || seen.has(alias)) return value;
  seen.add(alias);
  return dereference(alias, declarations, seen);
}

function blockDeclarations(source: string, selector: string): Record<string, string> {
  const css = withoutComments(source);
  const start = css.indexOf(selector + " {");
  if (start < 0) throw new Error(`Missing ${selector} block.`);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  const declarations: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
    if (name && value) declarations[name] = value.trim();
  }
  return declarations;
}

/** WCAG 2.x relative-luminance contrast, with alpha composited over the bed. */
function contrast(foreground: string, background: string): number {
  const bed = channels(background);
  const [red, green, blue, alpha] = channels(foreground);
  const composited: readonly number[] = [
    red * alpha + bed[0]! * (1 - alpha),
    green * alpha + bed[1]! * (1 - alpha),
    blue * alpha + bed[2]! * (1 - alpha),
  ];
  const [high, low] = [luminance(composited), luminance(bed)].sort((left, right) => right - left);
  return (high! + 0.05) / (low! + 0.05);
}

function luminance(rgb: readonly number[]): number {
  const [red, green, blue] = rgb.map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function channels(color: string): readonly [number, number, number, number] {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const parts = color.trim().match(/^rgba?\(([^)]+)\)$/u)?.[1]?.split(/[\s,/]+/u).filter(Boolean).map(Number);
  if (!parts || parts.length < 3) throw new Error(`Unsupported colour literal: ${color}`);
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

async function readCssSources(directory: string): Promise<CssSource[]> {
  const sources: CssSource[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...await readCssSources(path));
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      sources.push({ file: path, text: await readFile(path, "utf8") });
    }
  }
  return sources;
}

function customPropertyDefinitions(source: string): string[] {
  return [...withoutComments(source).matchAll(/(?:^|[;{])\s*(--[\w-]+)\s*:/gmu)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
}

function customPropertyReferences(source: string): CssVariableReference[] {
  const css = withoutComments(source);
  const references: CssVariableReference[] = [];
  const pattern = /var\(\s*(--[\w-]+)/gu;
  for (const match of css.matchAll(pattern)) {
    const name = match[1];
    const start = match.index;
    if (!name || start === undefined) continue;

    let depth = 1;
    let hasFallback = false;
    let cursor = start + match[0].length;
    while (cursor < css.length && depth > 0) {
      const character = css[cursor];
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 1) hasFallback = true;
      cursor += 1;
    }

    references.push({
      name,
      hasFallback,
      line: css.slice(0, start).split("\n").length,
    });
  }
  return references;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => (
    comment.replace(/[^\n]/gu, " ")
  ));
}
