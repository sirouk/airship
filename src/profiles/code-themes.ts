import type { HexColor, ThemeColorScheme } from "./domain";

/**
 * Editor syntax palettes — a second, deliberately smaller theme concept than
 * `ThemeManifest`.
 *
 * A `ThemeManifest` is the *instrument's* palette: nine roles that repaint the
 * whole shell, chosen once per profile in Preferences, content-digested and
 * pinned into every session. This is the *editing sheet's* palette: the five
 * `--tok-*` roles the shared highlighter already paints plus the two that make
 * a sheet a sheet. It is chosen in the editor, it never leaves the editor
 * frame, and it is not content-addressed — a person changing their syntax
 * colours is not minting a profile revision that a year of conversations then
 * has to resolve against.
 *
 * The two must not be collapsed into one. `themeCssVariables` refuses to write
 * a dark manifest onto a light stylesheet precisely because the shell's colour
 * mode owns the shell; the editor sheet is a bounded surface inside it, the
 * way a sheet of paper on a desk does not have to match the desk.
 *
 * ## Provenance and licence
 *
 * Every scheme named here ships under a permissive licence — Atom One Dark and
 * its One Dark Pro port (MIT, Atom contributors / binaryify), Nord (MIT,
 * Arctic Ice Studio), Gruvbox (MIT, Pavel Pertsev), Tokyo Night (MIT, enkia),
 * Catppuccin (MIT, Catppuccin org), GitHub's VS Code theme (MIT, GitHub Inc).
 * Nothing is vendored: no theme JSON, TextMate grammar, icon font or webfont
 * enters the tree. What is written below is a seven-role translation of each
 * scheme into the roles this product's own highlighter emits, the same
 * treatment `catalog.ts` gives the six curated shell palettes.
 *
 * Where a value differs from its upstream it is because that upstream value
 * does not clear WCAG AA (4.5:1) against its own editor ground, and code is
 * text. Those lifts are marked at the value. `code-theme-contract.test.ts`
 * holds the floor for every role of every theme, so a future palette cannot
 * ship a comment nobody can read.
 */

export const CODE_THEME_ROLES = ["ground", "ink", "com", "kw", "fn", "str", "num"] as const;

export type CodeThemeRole = (typeof CODE_THEME_ROLES)[number];

/**
 * The only CSS properties an editor theme can influence.
 *
 * `--tok-*` are the five the shared highlighter already emits class names for,
 * so a transcript code block and the editor cannot disagree about what a
 * keyword looks like. `--code-ground` and `--code-ink` are scoped to the
 * editor frame and exist nowhere else — an editor theme has no way to reach
 * `--ground`, `--surface`, `--accent` or any verdict colour.
 */
export const CODE_THEME_CSS_VARIABLES = Object.freeze({
  ground: "--code-ground",
  ink: "--code-ink",
  com: "--tok-com",
  kw: "--tok-kw",
  fn: "--tok-fn",
  str: "--tok-str",
  num: "--tok-num",
} satisfies Readonly<Record<CodeThemeRole, `--${string}`>>);

export type CodeTheme = Readonly<{
  codeThemeId: string;
  name: string;
  /** Named upstream and licence, shown in the editor's own theme menu. */
  description: string;
  colorScheme: ThemeColorScheme;
  colors: Readonly<Record<CodeThemeRole, HexColor>>;
}>;

/**
 * One Dark Pro is the default because it is the most-installed editor theme in
 * the open-source world and because the shell already ships a One Dark
 * manifest, so a profile left on both defaults reads as one decision.
 */
export const DEFAULT_CODE_THEME_ID = "one-dark-pro";

export const CODE_THEMES: readonly CodeTheme[] = Object.freeze([
  Object.freeze({
    codeThemeId: "one-dark-pro",
    name: "One Dark Pro",
    description: "Atom's One Dark, MIT · graphite sheet, violet keywords, sage strings.",
    colorScheme: "dark",
    colors: Object.freeze({
      ground: "#282c34",
      ink: "#abb2bf",
      // Upstream #7f848e is 4.42:1 here; lifted to clear AA.
      com: "#909aa8",
      // Upstream #c678dd is 4.75:1 and passes, but sits below its own siblings;
      // lifted with them so no one role reads as the dim one.
      kw: "#d190e4",
      fn: "#61afef",
      str: "#98c379",
      num: "#d19a66",
    }),
  }),
  Object.freeze({
    codeThemeId: "nord",
    name: "Nord",
    description: "Arctic Ice Studio's Nord, MIT · polar night sheet with frost signals.",
    colorScheme: "dark",
    colors: Object.freeze({
      ground: "#2e3440",
      ink: "#d8dee9",
      // Nord3 (#4c566a) is 1.9:1 on Nord0 — unreadable as body text. This is
      // Nord3's hue carried up to AA rather than a different colour.
      com: "#93a1ba",
      // Frost nord9 #81a1c1 lifted from 4.64:1 for parity with its siblings.
      kw: "#8bacce",
      fn: "#88c0d0",
      str: "#a3be8c",
      // Aurora nord15 #b48ead is 4.41:1; lifted to clear AA.
      num: "#bd94b6",
    }),
  }),
  Object.freeze({
    codeThemeId: "gruvbox-dark",
    name: "Gruvbox Dark",
    description: "Pavel Pertsev's Gruvbox, MIT · warm retro paper on deep brown.",
    colorScheme: "dark",
    colors: Object.freeze({
      ground: "#282828",
      ink: "#ebdbb2",
      com: "#a89984",
      // bright_red #fb4934 is 4.29:1 on bg0; lifted to clear AA.
      kw: "#fb6a52",
      fn: "#8ec07c",
      str: "#b8bb26",
      num: "#d3869b",
    }),
  }),
  Object.freeze({
    codeThemeId: "tokyo-night",
    name: "Tokyo Night",
    description: "enkia's Tokyo Night, MIT · midnight violet with electric blue.",
    colorScheme: "dark",
    colors: Object.freeze({
      ground: "#1a1b26",
      ink: "#c0caf5",
      com: "#7f8bb5",
      kw: "#bb9af7",
      fn: "#7aa2f7",
      str: "#9ece6a",
      num: "#ff9e64",
    }),
  }),
  Object.freeze({
    codeThemeId: "github-light",
    name: "GitHub Light",
    description: "GitHub's VS Code theme, MIT · white sheet, the palette of a diff.",
    colorScheme: "light",
    colors: Object.freeze({
      ground: "#ffffff",
      ink: "#24292f",
      com: "#6e7781",
      kw: "#cf222e",
      fn: "#8250df",
      str: "#0a3069",
      num: "#0550ae",
    }),
  }),
  Object.freeze({
    codeThemeId: "catppuccin-latte",
    name: "Catppuccin Latte",
    description: "Catppuccin's Latte, MIT · soft warm grey sheet with pastel signals.",
    colorScheme: "light",
    colors: Object.freeze({
      ground: "#eff1f5",
      ink: "#4c4f69",
      // Latte overlay1 #8c8fa1 is 2.9:1; carried down to AA.
      com: "#5c5f74",
      kw: "#8839ef",
      fn: "#1e66d5",
      // Latte green #40a02b is 3.1:1 and peach #fe640b is 2.5:1 on base.
      str: "#357a26",
      num: "#b04e08",
    }),
  }),
]);

const BY_ID = new Map(CODE_THEMES.map((theme) => [theme.codeThemeId, theme] as const));

/**
 * Resolve an id to a palette, falling back to the default rather than throwing.
 *
 * A Vault written by a later release can name a theme this build has never
 * heard of. Refusing to render an editor over a colour preference would be the
 * wrong trade every time, and the stored id is left alone so returning to the
 * newer build restores the choice.
 */
export function resolveCodeTheme(codeThemeId: string | undefined): CodeTheme {
  return (codeThemeId ? BY_ID.get(codeThemeId) : undefined) ?? BY_ID.get(DEFAULT_CODE_THEME_ID)!;
}

export function isKnownCodeThemeId(codeThemeId: string): boolean {
  return BY_ID.has(codeThemeId);
}

/** Inline custom properties for the editor frame; never written to `:root`. */
export function codeThemeCssVariables(theme: CodeTheme): Readonly<Record<string, HexColor>> {
  const properties: Record<string, HexColor> = {};
  for (const role of CODE_THEME_ROLES) properties[CODE_THEME_CSS_VARIABLES[role]] = theme.colors[role];
  return Object.freeze(properties);
}
