import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sheets = await Promise.all(
  ["tokens.css", "shell.css", "chat.css", "routes.css"].map(async (name) =>
    [name, await readFile(new URL(`./${name}`, import.meta.url), "utf8")] as const),
);

/**
 * Paper mode was a no-op for most of this product's life, so hard-coded dark
 * surfaces went unnoticed: three of them were the literal values of `--ground`
 * and `--surface-raised`. When the colour mode started working, the phone tab
 * bar became a black slab with dark labels on every screen (measured 1.53:1),
 * chat grew a full-width black band, and two brass buttons put dark ink on a
 * dark accent. A literal cannot follow a theme, so the rule is that a painted
 * surface or an ink-on-accent must come from a token.
 */
describe("theme-aware surfaces", () => {
  const DARK_LITERALS = [
    /rgba?\(\s*16\s*,\s*20\s*,\s*23/u,   // --ground
    /rgba?\(\s*23\s*,\s*28\s*,\s*32/u,   // --surface
    /rgba?\(\s*28\s*,\s*34\s*,\s*38/u,   // --surface-raised
    /rgba?\(\s*20\s*,\s*25\s*,\s*28/u,   // --surface-soft
  ];

  for (const [name, css] of sheets) {
    it(`${name} paints no surface with a literal copy of a dark-mode token`, () => {
      const offenders = css
        .split("\n")
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => /(?:^|\s)(?:background|background-color)\s*:/u.test(line))
        .filter(([, line]) => DARK_LITERALS.some((pattern) => pattern.test(line)));

      expect(offenders.map(([line, text]) => `${name}:${line} ${text.trim()}`)).toEqual([]);
    });
  }

  it("never puts a hard-coded dark ink on a brass background", () => {
    // `--accent-bright` is dark in paper mode, so a dark literal beside it is
    // invisible in exactly one of the two modes the product ships.
    for (const [name, css] of sheets) {
      const blocks = css.split("}");
      for (const block of blocks) {
        if (!/background:\s*var\(--(?:brass-bright|accent-bright)\)/u.test(block)) continue;
        const ink = block.match(/(?:^|\s)color:\s*(#[0-9a-f]{3,8})/iu);
        expect(ink?.[1], `${name} sets a literal ink on a brass background`).toBeUndefined();
      }
    }
  });

  it("gives bare buttons and links a recipe so no user-agent default reaches a route", () => {
    const tokens = sheets.find(([name]) => name === "tokens.css")![1];
    // The reset adopted `color` and `font` but never `background` or `border`,
    // so a classless button rendered as the UA grey slab with a 2px outset
    // ridge — measured at 1.57:1 on the workspace zero state.
    expect(tokens).toMatch(/\nbutton\s*\{[^}]*background:\s*transparent/u);
    expect(tokens).toMatch(/\nbutton\s*\{[^}]*border:\s*1px solid var\(--line-control\)/u);
    expect(tokens).toMatch(/\na\s*\{[^}]*color:\s*var\(--accent-bright\)/u);
  });
});
