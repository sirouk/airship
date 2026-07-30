import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/*
 * The view sheets, held to the vocabulary the token sheet publishes.
 *
 * Every claim here started as a count taken off the shipped stylesheets, not
 * as a preference: 83 hand-written monospace stacks beside a `--font-mono`
 * used 127 times (and spelled with a *different* family name), 15 serif stacks
 * in two incompatible spellings, 31 font weights on no rung of a three-rung
 * scale, 15 rgba() literals that are the dark-mode `--accent` and `--v-verified`
 * hexes written out by hand, and a shared `.eyebrow` class re-implemented 47
 * more times with five trackings and four colours.
 *
 * The pass that wrote this file owned every sheet in `src/ui` except
 * `tokens.css` (which is where the vocabulary is *declared*, so the literals
 * belong there) and `routes.css` (which another implementer held open at the
 * same time). Each claim is therefore asserted absolutely on the sheets this
 * pass owned and held to a ratchet on `routes.css` — the measured high-water
 * mark, which may only fall. A sheet that lands its migration lowers the
 * number; a sheet that writes a fresh literal fails here.
 */

const DECLARATION_HOME = "tokens.css";
const NOT_OURS = "routes.css";

type Sheet = Readonly<{ name: string; source: string }>;

const sheets: readonly Sheet[] = await readSheets();
const ours = sheets.filter((sheet) => sheet.name !== DECLARATION_HOME && sheet.name !== NOT_OURS);
const routes = sheets.find((sheet) => sheet.name === NOT_OURS)?.source ?? "";
const shell = sheets.find((sheet) => sheet.name === "shell.css")?.source ?? "";

describe("the three font roles have one spelling each", () => {
  /*
   * `"SF Mono"` (the family name, in `--font-mono`) and `SFMono-Regular` (the
   * PostScript name, in 83 hand-written stacks) are not the same font
   * reference, and `Georgia, "Times New Roman", serif` and `Georgia, serif`
   * resolve to two different faces on any Linux desktop where Georgia is
   * absent and fontconfig aliases Times New Roman to Liberation Serif — so a
   * Sessions heading and a Proof heading, both meant to be the display serif,
   * rendered in two different faces on the same screen.
   */
  it("names no font family outside the token sheet", () => {
    expect(offenders(ours, /ui-monospace|Georgia|\bInter\b/gu)).toEqual([]);
  });

  it("keeps routes.css on the ratchet until it is re-homed", () => {
    expect(countIn(routes, /ui-monospace/gu)).toBeLessThanOrEqual(31);
    expect(countIn(routes, /Georgia/gu)).toBeLessThanOrEqual(12);
  });
});

describe("the type ramp is the only source of a size", () => {
  /*
   * `--type-scale` is the Type scale preference and WCAG 1.4.4's whole
   * mechanism here. A bare `0.7rem` cannot move: at Extra large every label
   * around the Attestations eyebrows grew 25% to 14.6px while they stayed at
   * 11.9px, so the smallest text on the route — the text that was already
   * hardest to read — ended up visibly smaller than its neighbours.
   *
   * `density-contract.test.ts` holds the `font-size` property; this holds the
   * `font:` shorthand, which is where all six survivors were hiding.
   */
  it("writes no bare length in a font declaration", () => {
    const frozen = ours.flatMap(({ name, source }) => (
      [...withoutComments(source).matchAll(/font(-size)?:[^;{}]*/gu)]
        .filter((match) => /(^|[ /(:])\d*\.?\d+(rem|px)/u.test(match[0]))
        .map((match) => `${name}: ${match[0].trim()}`)
    ));
    expect(frozen).toEqual([]);
  });

  it("keeps routes.css on the ratchet", () => {
    expect(countIn(routes, /font(-size)?:[^;{}]*[ /(:]\d*\.?\d+(rem|px)/gu)).toBeLessThanOrEqual(1);
  });
});

describe("three weights, and no fourth", () => {
  /*
   * `tokens.css` sets `font-synthesis: none`, and the serif the Body font
   * preference switches to ships only 400 and 700 — so 500, 650, 720 and 750
   * all snapped to a neighbour and the three-tier hierarchy in Capabilities,
   * Attestations and the model picker rendered as two. A weight written as a
   * number is also a weight the scale cannot move.
   */
  it("declares every weight through a --fw token", () => {
    expect(offenders(ours, /font-weight:\s*\d+|font:\s*\d{3}[ \t]/gu)).toEqual([]);
  });

  it("keeps routes.css on the ratchet", () => {
    expect(countIn(routes, /font-weight:\s*\d+|font:\s*\d{3}[ \t]/gu)).toBeLessThanOrEqual(20);
  });
});

describe("a tint asks for its colour by name", () => {
  /*
   * rgb(193,154,88) is `--accent`'s dark value and rgb(103,163,154) is
   * `--v-verified`'s. Written out by hand they ignore both the colour mode and
   * the profile theme, which rewrites `--accent` inline — so the border that
   * appears around the composer on every click, the ring around the
   * assistant's avatar on every answer, and the open claim row kept a
   * dark-brass tint on a parchment page and under a theme that had asked for
   * something else.
   */
  it("writes neither hex as an rgba() literal", () => {
    expect(offenders(ours, /rgba\(193, ?154, ?88|rgba\(103, ?163, ?154/gu)).toEqual([]);
  });

  it("keeps routes.css on the ratchet", () => {
    expect(countIn(routes, /rgba\(193, ?154, ?88|rgba\(103, ?163, ?154/gu)).toBeLessThanOrEqual(8);
  });
});

describe("one elevation, and it is the one that flips in paper mode", () => {
  /*
   * `--shadow` is the only elevation the light-mode block remaps. Beside it,
   * four popovers and four modals carried their own literal — 65px of 55%
   * black under the profile menu against 60px of 45% under the model picker,
   * both open in the same session — and in Paper mode every one of them kept a
   * dark-build drop shadow on a parchment page.
   */
  it("resolves every elevation through the shadow token", () => {
    const literals = ours.flatMap(({ name, source }) => (
      [...withoutComments(source).matchAll(/box-shadow:[^;{}]*/gu)]
        .map((match) => match[0].trim())
        .filter((declaration) => !/var\(--shadow\)|inset|none|box-shadow:\s*0 0 0/u.test(declaration))
        .map((declaration) => `${name}: ${declaration}`)
    ));
    /*
     * The dock's lip is the one shadow that is not an elevation: it points
     * *up*, into the editor above it, and `--shadow` is a downward offset that
     * would paint it off the bottom of the screen. It is listed rather than
     * silently excluded so the next reader knows it was decided, not missed.
     */
    expect(literals).toEqual([
      "workspace-terminal-dock.css: box-shadow:0 -10px 28px color-mix(in srgb,#000 20%,transparent)",
    ]);
  });

  it("keeps routes.css on the ratchet", () => {
    const literals = [...withoutComments(routes).matchAll(/box-shadow:[^;{}]*/gu)]
      .filter((match) => !/var\(--shadow\)|inset|none|box-shadow:\s*0 0 0/u.test(match[0]));
    expect(literals.length).toBeLessThanOrEqual(4);
  });
});

describe("the section label is one object", () => {
  /*
   * The most repeated object in the product never looked the same twice:
   * brass in the rail and on Attestations, muted grey in Sources, faint grey
   * in Sessions and Billing; tracking anywhere between .06em and .12em; weight
   * between 400 and 700. `sources-view.css` was the sharpest evidence — it
   * consumed the shared `.eyebrow` class and then overrode four of its five
   * properties. A grouped selector is how CSS says "import": the 47 losers
   * share this declaration block instead of copying it, and keep only their
   * own boxes.
   */
  it("declares the recipe exactly once, on .eyebrow", () => {
    const tracked = ours.flatMap(({ name, source }) => (
      rules(source)
        .filter(({ body }) => /text-transform:\s*uppercase/u.test(body) && inEyebrowBand(body))
        .map(({ selector }) => `${name}: ${selector}`)
    ));
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatch(/^shell\.css: \.eyebrow,/u);
  });

  it("sets the recipe from tokens, so no member can drift from another", () => {
    const recipe = rules(shell).find(({ selector }) => selector.startsWith(".eyebrow,"))?.body ?? "";
    expect(recipe).toContain("color: var(--ink-muted)");
    expect(recipe).toContain("font: var(--fw-strong) var(--fs-micro)/1.2 var(--font-mono)");
    expect(recipe).toContain("letter-spacing: 0.11em");
    // Brass encodes "you are here" or "act here" (DESIGN_DIRECTION.md §4.3);
    // a section label is neither, and `.eyebrow` alone accounted for a third
    // of the brass text in the product.
    expect(recipe).not.toContain("--brass");
    expect(recipe).not.toContain("--accent");
  });

  it("keeps routes.css on the ratchet", () => {
    const tracked = rules(routes)
      .filter(({ body }) => /text-transform:\s*uppercase/u.test(body) && inEyebrowBand(body));
    expect(tracked.length).toBeLessThanOrEqual(4);
  });
});

describe("one rule answers how tall a nav row is", () => {
  /*
   * The nested recents were designed at 36px so a list of conversations reads
   * as subordinate to the destinations above it. `--rail-item-height: 36px` is
   * only read by `.nav-item`'s own (0,1,0) `min-height`, and
   * `:root[data-density] .nav-item` in tokens.css is (0,3,0), so the rows
   * rendered at 46px at the shipped Comfortable default — the same height as
   * the primary destinations. A third rule in platform-shell.css answered 40px
   * and had been dead since it was written.
   */
  it("gives the nested override the weight the density block has", () => {
    expect(shell).toContain(":root[data-density] .nav-item.nav-item--nested {\n  min-height: var(--rail-item-height);\n}");
    expect(shell).toContain("--rail-item-height: 36px;");
  });

  it("leaves no second answer in platform-shell.css", () => {
    // Read past the comments: both dead rules are quoted in the comment that
    // records why they were deleted, which is the point of the comment.
    const platformShell = withoutComments(sheetSource("platform-shell.css"));
    expect(platformShell).not.toMatch(/\.nav-item\s*\{[^}]*min-height/u);
    // `data-corners="subtle"` is the shipped default and was declared twice
    // with different values; the token sheet keeps the answer.
    expect(platformShell).not.toContain(':root[data-corners="subtle"]');
  });

  it("declares each corner preference exactly once across every sheet", () => {
    for (const corners of ["square", "rounded", "subtle"]) {
      const declared = sheets.filter(({ source }) =>
        new RegExp(`:root\\[data-corners="${corners}"\\]\\s*\\{`, "u").test(withoutComments(source)));
      expect(declared.map(({ name }) => name)).toEqual([DECLARATION_HOME]);
    }
  });
});

describe("a phone can reach what a desktop can reach", () => {
  it("docks the command palette to the visual viewport, not the layout viewport", () => {
    /*
     * `.platform-scrim` is `position: fixed; inset: 0` with no transformed
     * ancestor, so its containing block is the layout viewport — the one this
     * repo documents as never shrinking under a soft keyboard. The palette
     * autofocuses its input, so at 390x844 with a 290px keyboard the results
     * list and the whole footer opened underneath it.
     */
    const platformShell = sheetSource("platform-shell.css");
    expect(platformShell).toContain("padding-bottom: calc(env(safe-area-inset-bottom) + var(--visual-viewport-bottom, 0px));");
    // The sheet has to shrink as well as move: 84vh of the layout viewport is
    // 709px on an 844px phone, which would hang off the top instead.
    expect(platformShell).toContain("max-height: min(84vh, 44rem, 100%)");
  });

  it("gives the advanced source-control dialog a touch floor", () => {
    /*
     * On a phone `.source-tools-dialog` is full-bleed and is the only place
     * branches, worktrees, history, the Tree/Flat layout and the diff-file
     * switcher exist. The sheet had no `pointer: coarse` rule at all: Tree/Flat
     * measured 38px and every folder row in tree mode measured 36px.
     */
    const coarse = coarseBlock(sheetSource("sources-view.css"));
    for (const selector of [
      ".git-view-toggle button",
      ".git-change-folder",
      ".git-diff-files button",
      ".git-sources-empty__actions button",
      ".git-stage-actions button",
    ]) {
      expect(coarse).toContain(selector);
    }
    expect(coarse).toContain("min-height: var(--touch-target)");
  });

  it("gives the terminal dock a resize a finger can land on", () => {
    /*
     * The dock's separator is 6px, and its only other paths are arrow keys and
     * a double-click — neither of which a phone has. Its sibling
     * `.workbench-splitter` was explicitly handled for touch; this one was not,
     * so on a phone the dock's height could not be changed at all.
     */
    const coarse = coarseBlock(sheetSource("workspace-terminal-dock.css"));
    expect(coarse).toContain("height: 24px");
    expect(coarse).toContain("grid-template-rows: 24px minmax(0, 1fr)");
  });
});

function offenders(subject: readonly Sheet[], pattern: RegExp): readonly string[] {
  return subject.flatMap(({ name, source }) => (
    [...withoutComments(source).matchAll(pattern)].map((match) => `${name}: ${match[0]}`)
  ));
}

function countIn(source: string, pattern: RegExp): number {
  return [...withoutComments(source).matchAll(pattern)].length;
}

/*
 * Comments carry the measured defect a rule was written to fix, and several of
 * them quote the literal they replaced — `font-size: 19px` in platform-shell.css
 * is a dead rule being explained, not a dead rule. Blanking them out preserves
 * line offsets so a failure still points at the right place.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

function rules(source: string): readonly Readonly<{ selector: string; body: string }>[] {
  return [...withoutComments(source).matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => Object.freeze({
    selector: (match[1] ?? "").trim().replace(/\s*\n\s*/gu, " "),
    body: match[2] ?? "",
  }));
}

/* .06em–.12em is what an eyebrow's tracking has ever been in this product; a
   glyph badge or a 22px logo circle is uppercase without tracking, and adding
   tracking to those would push the letter off its own centre. */
function inEyebrowBand(body: string): boolean {
  const tracking = /letter-spacing:\s*(0?\.\d+)em/u.exec(body);
  if (!tracking) return false;
  const value = Number.parseFloat(tracking[1] ?? "0");
  return value >= 0.06 && value <= 0.12;
}

function coarseBlock(source: string): string {
  return [...withoutComments(source).matchAll(/@media\s*\(\s*pointer:\s*coarse\s*\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/gu)]
    .map((match) => match[1] ?? "")
    .join("\n");
}

function sheetSource(name: string): string {
  return sheets.find((sheet) => sheet.name === name)?.source ?? "";
}

async function readSheets(): Promise<readonly Sheet[]> {
  const directory = new URL("./", import.meta.url);
  const names = (await readdir(directory)).filter((entry) => entry.endsWith(".css")).sort();
  return Promise.all(names.map(async (name) => Object.freeze({
    name,
    source: await readFile(new URL(name, directory), "utf8"),
  })));
}
