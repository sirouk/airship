import { describe, expect, it } from "vitest";
import {
  CODE_THEMES,
  CODE_THEME_CSS_VARIABLES,
  CODE_THEME_ROLES,
  DEFAULT_CODE_THEME_ID,
  codeThemeCssVariables,
  isKnownCodeThemeId,
  resolveCodeTheme,
} from "./code-themes";

/**
 * Code is text, so a syntax colour is held to the floor text is held to.
 *
 * The reason this is a test rather than a review note is that syntax palettes
 * are exactly where "faithful to upstream" and "readable" pull apart: the
 * comment colour of every popular scheme sits between 2:1 and 4.4:1 on its own
 * background, because the schemes were drawn for a preference, not a floor.
 * Each lift is recorded at the value in `code-themes.ts`; this holds the line
 * for whatever gets added next.
 */
const AA_TEXT = 4.5;

describe("every shipped editor theme is legible on its own sheet", () => {
  it("clears AA for all five syntax roles and the default ink", () => {
    const failures = CODE_THEMES.flatMap((theme) => (["ink", "com", "kw", "fn", "str", "num"] as const).flatMap((role) => {
      const ratio = contrast(theme.colors[role], theme.colors.ground);
      return ratio >= AA_TEXT ? [] : [`${theme.codeThemeId} ${role} ${ratio.toFixed(2)}:1`];
    }));
    expect(failures, "A syntax colour is a property of the swatch and its sheet.").toEqual([]);
  });

  it("keeps the five syntax roles distinguishable from one another", () => {
    // Two roles the same colour is a theme that has not been translated, only
    // copied: the reader cannot tell a string from a number.
    const failures = CODE_THEMES.flatMap((theme) => {
      const painted = (["com", "kw", "fn", "str", "num"] as const).map((role) => theme.colors[role]);
      return new Set(painted).size === painted.length ? [] : [theme.codeThemeId];
    });
    expect(failures).toEqual([]);
  });

  it("declares a complete palette with no role left to the shell", () => {
    for (const theme of CODE_THEMES) {
      for (const role of CODE_THEME_ROLES) {
        expect(theme.colors[role], `${theme.codeThemeId}.${role}`).toMatch(/^#[0-9a-f]{6}$/u);
      }
    }
  });

  it("names its upstream and its licence in the line a person reads", () => {
    for (const theme of CODE_THEMES) {
      expect(theme.description, theme.codeThemeId).toContain("MIT");
    }
  });

  it("offers a light sheet as well as dark ones", () => {
    expect(CODE_THEMES.some((theme) => theme.colorScheme === "light")).toBe(true);
    expect(CODE_THEMES.some((theme) => theme.colorScheme === "dark")).toBe(true);
  });

  it("has unique ids and a default that is one of them", () => {
    const ids = CODE_THEMES.map((theme) => theme.codeThemeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(isKnownCodeThemeId(DEFAULT_CODE_THEME_ID)).toBe(true);
  });
});

describe("an editor theme reaches the editor frame and nothing else", () => {
  /*
   * The shell's colour mode owns the instrument. If a code theme could write
   * `--ground`, `--surface`, `--ink` or any verdict role, choosing One Dark
   * Pro in the editor would repaint the rail, the chat and the seals — which
   * is the failure `themeCssVariables` already exists to prevent one layer up.
   */
  it("writes only editor-scoped and token-scoped properties", () => {
    const properties = Object.values(CODE_THEME_CSS_VARIABLES);
    expect(properties.every((name) => name.startsWith("--code-") || name.startsWith("--tok-"))).toBe(true);
    expect(properties).not.toContain("--ground");
    expect(properties).not.toContain("--ink");
    expect(properties).not.toContain("--accent");
  });

  it("emits one value per role", () => {
    const variables = codeThemeCssVariables(resolveCodeTheme(DEFAULT_CODE_THEME_ID));
    expect(Object.keys(variables).sort()).toEqual([...Object.values(CODE_THEME_CSS_VARIABLES)].sort());
  });
});

describe("an unknown id renders rather than refusing", () => {
  it("falls back to the default for a theme a later release named", () => {
    expect(resolveCodeTheme("solarized-ultraviolet").codeThemeId).toBe(DEFAULT_CODE_THEME_ID);
    expect(resolveCodeTheme(undefined).codeThemeId).toBe(DEFAULT_CODE_THEME_ID);
  });
});

/** WCAG 2.x relative-luminance contrast between two opaque hexes. */
function contrast(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (high! + 0.05) / (low! + 0.05);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
