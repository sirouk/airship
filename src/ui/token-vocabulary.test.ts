import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/*
 * One name per thing.
 *
 * Every claim below started as a *count* taken off the shipped sheets: 144
 * copies of the 44px touch floor, 26 copies of the chip radius beside a token
 * used 19 times, three live spellings of the verified green, six ways of
 * drawing the focus ring, four scrims of which three did not know what colour
 * mode they were in. None of those is a bug a browser reports; each is a
 * divergence a reader sees as "two applications in one window", and the only
 * thing that can hold them is a test that reads the sheets.
 *
 * The pass that introduced this file owned `tokens.css` and `routes.css`, so
 * each claim is asserted *absolutely* on those two and held to a ratchet on the
 * rest. The ratchet is the measured high-water mark: it may only fall. A sheet
 * that lands its migration lowers the number; a sheet that writes a fresh
 * literal fails here rather than at a design review a year from now.
 */

const OWNED = Object.freeze(["tokens.css", "routes.css"] as const);

type Sheet = Readonly<{ name: string; source: string }>;

const sheets: readonly Sheet[] = await readSheets();
const tokens = sheetSource("tokens.css");
const routes = sheetSource("routes.css");

describe("the touch floor has one name", () => {
  /*
   * `min-height: 44px` is not the shipped control height — it is the `:root`
   * fallback of `--density-control`, and the shell boots at `comfortable`,
   * where that token is 46px. So the Approve and Deny buttons in the approval
   * dock were 44px while the slash-command rows the same finger had just
   * touched were 46px, and in Compact they were 44px beside 36px neighbours.
   */
  it("declares the floor once and never repeats the number in the sheets that own it", () => {
    expect(tokens).toContain("--touch-target: 44px;");
    // The declaration is the only 44 left in the token sheet: the coarse-pointer
    // block below it references the token rather than restating it.
    expect(tokenText(tokens).match(/44px/gu)).toHaveLength(1);
    expect(routes).not.toMatch(/min-height:\s*44px/u);
  });

  it("keeps every remaining copy on the ratchet", () => {
    expect(countOutsideTokens(/min-height:\s*44px/gu)).toBeLessThanOrEqual(116);
  });

  it("routes a control height at the density token rather than at the floor", () => {
    // The two the audit named by hand: the approval dock's verbs, and the one
    // bar every route renders.
    expect(rule(routes, ".approval-actions button")).toContain("min-height: var(--density-control)");
    expect(rule(routes, ".route-header__bar")).toContain("min-height: var(--density-control)");
  });
});

describe("the scrim knows what mode it is in", () => {
  /*
   * Three of the four scrims were mode-blind near-black literals against one
   * mode-aware `color-mix`. In Paper mode, Preferences dimmed to a parchment
   * wash and a capability approval blacked the page out — and on a phone every
   * bottom sheet did the same, because `.mobile-sheet-scrim` was one of the
   * blind ones.
   */
  it("mixes the scrim from the ground rather than from a fixed black", () => {
    expect(tokens).toContain("--scrim: color-mix(in srgb, var(--ground) 78%, transparent);");
  });

  it("leaves no literal-backed scrim in the sheets that own one", () => {
    for (const name of OWNED) {
      for (const [, body] of scrimRules(sheetSource(name))) {
        expect(body, `${name} scrim`).not.toMatch(/background:\s*rgba\(/u);
      }
    }
    expect(rule(routes, ".approval-scrim")).toContain("background: var(--scrim)");
  });

  it("keeps every remaining blind scrim on the ratchet", () => {
    const blind = sheets.filter(({ name }) =>
      scrimRules(stripComments(sheetSource(name))).some(([, body]) => /background:\s*rgba\(/u.test(body)));
    expect(blind.map(({ name }) => name).length).toBeLessThanOrEqual(1);
  });
});

describe("focus is drawn one way", () => {
  /*
   * Measured across the sheets: three outline widths, four colour spellings and
   * five offsets. A keyboard user tabbing topbar → rail → workspace tree →
   * vault disclosure watched the ring change width, hue and inside/outside
   * placement four times in one traverse, and the weakest of them — a 1px inset
   * hairline — sat on the densest surface in the product.
   */
  it("declares the ring, its offset and the one sanctioned inset", () => {
    expect(tokens).toContain("--focus-ring: 2px solid var(--focus);");
    expect(tokens).toContain("--focus-ring-offset: 1px;");
    expect(tokens).toContain("--focus-ring-inset: -2px;");
  });

  it("draws the baseline ring from --focus, the token that exists to retarget it", () => {
    // Found by the rule that contains `a:focus-visible`, not by it being the
    // last selector before the brace: the first spelling was
    // `/a:focus-visible \{/`, so adding one more member to the list turned this
    // red without anything about the ring having changed.
    const [selector = "", baseline = ""] = tokens.match(/([^{}]*\ba:focus-visible\b[^{}]*)\{([^}]+)\}/u)?.slice(1) ?? [];
    expect(baseline).toContain("outline: var(--focus-ring)");
    expect(baseline).toContain("outline-offset: var(--focus-ring-offset)");
    // A keyboard-reachable scroll region is a focus stop, and it is drawn from
    // here rather than by each pane that remembered — which is what the
    // override ratchet below is counting down.
    //
    // Keyboard-*reachable* is the whole qualification, and it is the half this
    // assertion used to leave unsaid. `[tabindex]` matched negative values
    // too, so every script-focus target in the product — the dialog that just
    // opened, the rail row that was clicked, the popover panel, the listbox
    // option under a roving pattern — drew the ring when a script sent focus
    // there after a pointer press. No Tab can land on any of them.
    expect(selector).toContain('[tabindex]:not([tabindex^="-"]):focus-visible');
    // The alias that used to draw it. `--focus` is two lines from the top of
    // the file and was not what painted the ring.
    expect(baseline).not.toContain("--brass-bright");
  });

  it("draws no ring on a script-focus target, which no Tab can reach", () => {
    const [silenced = ""] = tokens.match(/\[tabindex\^="-"\]:focus-visible\s*\{([^}]+)\}/u)?.slice(1) ?? [];
    expect(silenced).toContain("outline: none");
  });

  it("re-declares no ring in the sheets that own one", () => {
    for (const name of OWNED) {
      for (const [, body] of focusVisibleRules(sheetSource(name))) {
        if (name === "tokens.css") continue;
        expect(body, `${name} focus ring`).not.toMatch(/outline\s*:/u);
      }
    }
  });

  /*
   * What this counts is a sheet DECIDING the ring for itself, which is the
   * thing that made a keyboard traverse change width, hue and placement four
   * times. A rule that draws `var(--focus-ring)` has not decided anything — it
   * has deferred, which is the outcome the count exists to produce.
   *
   * Counting every `outline:` could not tell those apart, so the composer's fix
   * read as a regression: `.composer textarea` sets `outline: 0` on purpose so
   * there are not two rings, and the box a person actually sees draws the token
   * ring instead. Measured before it, a focused composer differed from a
   * blurred one by 2.47% of pixels against the rail's 203/255 — a sighted
   * keyboard user could not tell where their keystrokes were going. That is an
   * override the ratchet should welcome.
   */
  it("keeps every remaining override on the ratchet", () => {
    const decidesItsOwnRing = ({ body }: { body: string }) => {
      const declarations = [...body.matchAll(/outline\s*:\s*([^;]+)/gu)].map((match) => match[1]!.trim());
      return declarations.some((value) => !/var\(--focus-ring\)|^0$|^none$/u.test(value));
    };
    const overrides = sheets
      .filter(({ name }) => name !== "tokens.css")
      .flatMap(({ name, source }) => focusVisibleRules(source).map(([, body]) => ({ name, body })))
      .filter(({ body }) => /outline\s*:/u.test(body))
      .filter(decidesItsOwnRing);
    // A ratchet, not a pin: `toHaveLength` went red on the next person to
    // correctly remove one, which is the behaviour it exists to encourage.
    expect(overrides.length, `${overrides.map((item) => item.name).join(", ")}`).toBeLessThanOrEqual(20);
  });
});

describe("the Body font preference reaches the rules that name the token", () => {
  /*
   * The preference used to travel by inheritance alone, so the 28 rules that
   * name `var(--font-body)` explicitly — the seal labels, the Proof hero
   * verdict, the Memory card titles, the model-picker prices — each opted their
   * element back out of it, and System serif rendered as a page in two
   * typefaces.
   */
  it("redeclares --font-body inside the serif block and references it once", () => {
    const serif = tokens.match(/:root\[data-body-font="system-serif"\] \{([^}]+)\}/u)?.[1] ?? "";
    expect(serif).toContain('--font-body: Georgia, "Times New Roman", serif;');
    // The `font-family` half references the declaration above it rather than
    // repeating the stack, so the two mechanisms cannot drift apart again.
    expect(serif).toContain("font-family: var(--font-body);");
    expect(serif.match(/Georgia/gu)).toHaveLength(1);
  });
});

describe("a chip is round because --radius-chip says so", () => {
  it("writes the literal nowhere in the sheets that own one", () => {
    expect(tokens).toContain("--radius-chip: 999px;");
    expect(routes).not.toMatch(/border-radius:\s*999px/u);
  });

  it("keeps every remaining copy on the ratchet", () => {
    expect(countOutsideTokens(/border-radius:\s*999px/gu)).toBeLessThanOrEqual(20);
  });
});

describe("one name per colour role", () => {
  /*
   * `--v-verified` / `--signal` / `--verdigris` was 112 call sites across three
   * spellings, and `docs/DESIGN_LANGUAGE.md` published the alias set as the
   * contract — so the design language and the token sheet named different
   * tokens for the same hue.
   */
  const ALIASES = Object.freeze(["brass", "brass-bright", "signal", "signal-red", "verdigris", "danger"] as const);

  it("has retired --steel entirely", () => {
    // It reached zero call sites, so it is deleted rather than left declared
    // for a name nobody types.
    expect(tokenText(tokens)).not.toContain("--steel");
    expect(countOutsideTokens(/var\(--steel\)/gu)).toBe(0);
  });

  it("uses the canonical spelling in the sheets that own one", () => {
    for (const alias of ALIASES) {
      expect(routes, `routes.css still names --${alias}`).not.toContain(`var(--${alias})`);
    }
  });

  it("keeps every remaining alias call site on the ratchet", () => {
    const pattern = new RegExp(`var\\(--(?:${ALIASES.join("|")})\\)`, "gu");
    expect(countOutsideTokens(pattern)).toBeLessThanOrEqual(93);
  });
});

describe("spacing goes through the scale", () => {
  const SCALE = Object.freeze({ 4: "--sp-1", 8: "--sp-2", 12: "--sp-3", 16: "--sp-4", 24: "--sp-5", 32: "--sp-6", 48: "--sp-7" });

  /*
   * `docs/DESIGN_DIRECTION.md` measured it first: "a token'd 4px grid renders
   * 79% off-grid". The exact-match half is mechanical and has no visual
   * consequence at all — a declaration that writes `12px` where `--sp-3` means
   * 12px is a value that cannot be retuned for density or for a phone, for no
   * gain. That half is asserted here; the off-grid half (9px gaps beside 8px
   * ones) is a second pass with a visible result, so it is not asserted yet.
   */
  it("writes no exact rung as a literal in the sheet that owns the most of them", () => {
    const offenders = spacingLiterals(routes).filter((px) => px in SCALE);
    expect(offenders).toEqual([]);
  });

  it("keeps the off-grid backlog on the ratchet", () => {
    const offGrid = spacingLiterals(routes).filter((px) => !(px in SCALE));
    expect(offGrid.length).toBeLessThanOrEqual(240);
  });
});

describe("the tab strips agree on a height", () => {
  it("shares one designed height and one floor", () => {
    expect(tokens).toContain("--tab-height: 40px;");
    expect(rule(routes, ".tabs__tab-button")).toContain("min-height: var(--tab-height)");
    // 39px at every width, on the one strip a phone needs to reach Skills and
    // Capabilities, beside a Trust hub strip that took 44px in the identical
    // phone query.
    expect(routes).toContain(".profile-hub-tabs > button { min-height: var(--tab-height);");
    /*
     * Brace-matched rather than pattern-matched, and the reason is a landmine
     * this cost someone half an hour to find.
     *
     * This read `/@media \(pointer: coarse\) \{\n((?:[^@]|\n)*?)\n\}/`, whose
     * `(?:[^@]|\n)` alternation is ambiguous — `[^@]` already matches a
     * newline, so every character has two derivations and a body the pattern
     * cannot terminate is explored exponentially. It also meant the block was
     * defined as "up to the next at-sign anywhere", so writing the word
     * `@media` inside a COMMENT in that block did not fail this test: it hung
     * `vitest run src/ui/` forever, with no failure and no output. A test that
     * can only hang is worse than a test that can only fail.
     *
     * Counting braces terminates on any input, and asking for the block that
     * actually carries the selector is what the assertion always meant.
     */
    const coarse = coarseBlocks(routes).find((block) => block.includes(".profile-hub-tabs > button")) ?? "";
    expect(coarse, "no coarse-pointer block carries the hub tab floor").not.toBe("");
    expect(coarse).toContain("min-height: var(--touch-target)");
  });
});

describe("the Density preference reaches a route", () => {
  /*
   * `grep -c 'var(--density-'` returned 0 for routes.css, sessions-view.css,
   * workspace-view.css, memory-view.css, proof-view.css, vault-view.css and
   * terminal-view.css: nine of the ten routes were dimensionally frozen and
   * Compact moved the rail and the composer only.
   */
  it("scales the one gutter every route renders inside", () => {
    const layout = rule(routes, ".route-layout");
    expect(layout).toContain("--route-gutter-block: clamp(var(--density-panel-pad)");
    expect(layout).toContain("--route-gutter-inline-start: clamp(calc(var(--density-panel-pad)");
  });

  it("names density tokens in the route sheet at all", () => {
    expect(routes.match(/var\(--density-/gu)?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("the slash menu discloses effect on a phone", () => {
  /*
   * That `<small>` is `category · effect`, read off the tool definition, and it
   * is the only thing in the composer that says whether a command writes files
   * or executes before the user commits to it. Under Full Access or Auto
   * Approve no approval dock fires either, so `display: none` meant the effect
   * was never disclosed at all on a phone.
   */
  it("restacks the effect line instead of deleting it", () => {
    const phone = routes.match(/\.slash-command-menu small \{([^}]+)\}/u)?.[1] ?? "";
    expect(phone).toContain("grid-column: 1 / -1");
    expect(phone).not.toContain("display: none");
  });
});

async function readSheets(): Promise<readonly Sheet[]> {
  const directory = new URL("./", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".css")).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    source: await readFile(new URL(name, directory), "utf8"),
  })));
}

function sheetSource(name: string): string {
  const sheet = sheets.find((candidate) => candidate.name === name);
  if (!sheet) throw new Error(`no such stylesheet: ${name}`);
  return sheet.source;
}

/* Comments quote the literals they retired, so every count reads the code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "");
}

/* The token sheet minus its own prose: the declarations, and nothing else. */
function tokenText(source: string): string {
  return stripComments(source);
}

function countOutsideTokens(pattern: RegExp): number {
  return sheets
    .filter(({ name }) => name !== "tokens.css")
    .reduce((total, { source }) => total + (stripComments(source).match(pattern)?.length ?? 0), 0);
}

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return source.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]+)\\}`, "u"))?.[1] ?? "";
}

function scrimRules(source: string): readonly (readonly [string, string])[] {
  return [...stripComments(source).matchAll(/([^{}]*-scrim[^{}]*)\{([^}]*)\}/gu)]
    .map((match) => [match[1] ?? "", match[2] ?? ""] as const);
}

function focusVisibleRules(source: string): readonly (readonly [string, string])[] {
  return [...stripComments(source).matchAll(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/gu)]
    .map((match) => [match[1] ?? "", match[2] ?? ""] as const);
}

const SPACING_PROPERTIES = /\b(?:padding|margin|gap|row-gap|column-gap|padding-inline|padding-block|margin-inline|margin-block|padding-top|padding-bottom|padding-left|padding-right|margin-top|margin-bottom|margin-left|margin-right)\s*:\s*([^;{}]+)/gu;

function spacingLiterals(source: string): readonly number[] {
  return [...stripComments(source).matchAll(SPACING_PROPERTIES)]
    .flatMap((declaration) => [...(declaration[1] ?? "").matchAll(/(?<![\w.\-])(\d+)px/gu)])
    .map((match) => Number(match[1]))
    .filter((px) => px > 0);
}

/**
 * Every `@media (pointer: coarse)` block in a stylesheet, by balanced braces.
 *
 * At-rules nest, comments contain at-signs, and a stylesheet is not a regular
 * language — so this counts depth instead of guessing where a block ends. See
 * the comment at the call site for the specific failure that made it worth
 * writing out.
 */
function coarseBlocks(source: string): string[] {
  const marker = "@media (pointer: coarse) {";
  const blocks: string[] = [];
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + marker.length)) {
    let depth = 1;
    let index = at + marker.length;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    if (depth === 0) blocks.push(source.slice(at + marker.length, index - 1));
  }
  return blocks;
}
