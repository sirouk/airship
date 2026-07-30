import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * `outline: 0` is a promise to draw the ring somewhere else.
 *
 * The borderless-input-in-a-bordered-shell pattern moves the focus ring from
 * the field to the wrapper the reader actually sees. Half of that pattern is a
 * suppression and half is a replacement, and the suppression is the half that
 * gets copied: Sessions shipped `outline: 0` with no wrapper ring, and so did
 * the command palette. This guard was written scoped to one stylesheet, which
 * is exactly the shape of mistake it exists to catch, so it runs over every
 * stylesheet in the route tree.
 *
 * `outline: none` counts. It is the same declaration spelled differently, and a
 * guard that reads only one spelling is a guard that teaches the other one.
 *
 * What this checks is component-local pairing, not a cascade solve: for every
 * rule that suppresses the outline, the same stylesheet must carry a focus-state
 * rule anchored on the same root class that paints something. It cannot prove
 * the replacement wins the cascade — but it can prove nobody forgot to write
 * one, which is the failure that has actually happened three times.
 */

const uiDirectory = new URL("./", import.meta.url);

type Rule = { readonly selector: string; readonly body: string };

/** Flatten a stylesheet to leaf rules, descending through `@media`/`@supports`. */
function leafRules(css: string): readonly Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: Rule[] = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{", index);
    if (open < 0) break;
    const selector = source.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = source.slice(open + 1, cursor - 1);
    if (body.includes("{")) rules.push(...leafRules(`${selector}{${body}}`.slice(selector.length + 1, -1)));
    else if (selector) rules.push({ selector, body });
    index = cursor;
  }
  return rules;
}

const SUPPRESSION = /(^|[;{\s])outline\s*:\s*(0|none)\s*(?:;|$)/u;
/** A ring, an inset shadow, or a border that changes — anything a reader sees. */
const REPLACEMENT = /(outline\s*:\s*(?!0|none)|box-shadow\s*:|border(?:-\w+)?-color\s*:|border\s*:)/u;

/** The component the suppressed control belongs to: its selector's first class. */
function anchorClass(selectorPart: string): string | undefined {
  return /\.([A-Za-z_][\w-]*)/u.exec(selectorPart)?.[1];
}

/*
 * The ring lives on the control or on a wrapper the control sits inside, and
 * that wrapper is normally a BEM element of the same block — `.composer` for
 * `.composer textarea`, `.command-palette__search` for `.command-palette
 * input`. So the match is "somewhere in this component", accepting a `__`
 * element of the anchor block. It deliberately stops short of claiming the
 * ring is on an *ancestor*: resolving that needs the DOM, and a guard that
 * asserted ancestry it cannot see would be the fictional-geometry version of
 * this check. What it does prove is that the component has a focus rule at
 * all, which is the thing that keeps being missing.
 */
function anchoredFocusRule(rules: readonly Rule[], anchor: string): boolean {
  const token = new RegExp(`\\.${anchor}(?:__[\\w-]+)?(?![\\w-])`, "u");
  return rules.some((rule) =>
    rule.selector.includes(":focus")
    && token.test(rule.selector)
    && REPLACEMENT.test(rule.body)
    && !SUPPRESSION.test(rule.body));
}

const stylesheets = (await readdir(uiDirectory)).filter((name) => name.endsWith(".css")).sort();
const parsed = new Map<string, readonly Rule[]>(
  await Promise.all(stylesheets.map(async (name) =>
    [name, leafRules(await readFile(new URL(name, uiDirectory), "utf8"))] as const)),
);

describe("focus rings survive every outline suppression", () => {
  it("reads the whole route stylesheet set, so a new sheet cannot opt itself out", () => {
    expect(stylesheets).toContain("sessions-view.css");
    expect(stylesheets).toContain("platform-shell.css");
    expect(stylesheets).toContain("model-picker.css");
    expect(stylesheets.length).toBeGreaterThan(25);
  });

  it("finds the suppressions it is meant to be policing", () => {
    const suppressing = [...parsed].flatMap(([name, rules]) =>
      rules.filter((rule) => SUPPRESSION.test(rule.body)).map((rule) => `${name} ${rule.selector}`));
    // A parser regression that matched nothing would make every assertion below
    // pass by vacuum. The count is a floor, not a fixture.
    expect(suppressing.length).toBeGreaterThanOrEqual(7);
    expect(suppressing).toContain("sessions-view.css .session-library-search input");
  });

  it("pairs every suppression with a focus-state rule in the same component", () => {
    const unpaired: string[] = [];
    for (const [name, rules] of parsed) {
      for (const rule of rules) {
        if (!SUPPRESSION.test(rule.body)) continue;
        // A focus rule that swaps the outline for its own visible indicator has
        // already kept the promise inside its own block.
        if (rule.selector.includes(":focus") && REPLACEMENT.test(rule.body)) continue;
        for (const part of rule.selector.split(",").map((value) => value.trim()).filter(Boolean)) {
          if (`${name} ${part}` === PROGRAMMATIC_FOCUS_TARGET) continue;
          const anchor = anchorClass(part);
          if (!anchor) {
            unpaired.push(`${name} ${part} (no class to anchor a ring on)`);
            continue;
          }
          if (!anchoredFocusRule(parsed.get(name)!, anchor)) unpaired.push(`${name} ${part}`);
        }
      }
    }
    expect(unpaired).toEqual([]);
  });
});

/*
 * The single suppression that is not a missing ring.
 *
 * Route navigation moves focus to the `<main>` landmark so a screen reader
 * lands in the new view; the landmark is not a control and painting a
 * viewport-sized ring around it is noise, not information. That is only true
 * while `<main>` stays out of the tab order, so the carve-out is not taken on
 * trust — the markup fact it depends on is asserted below, and the day someone
 * makes the landmark tabbable this test fails before the pairing test does.
 */
const PROGRAMMATIC_FOCUS_TARGET = "shell.css .main:focus";

describe("the one exempted suppression", () => {
  it("is exempt only while the landmark is unreachable by Tab", async () => {
    const app = await readFile(new URL("./app.tsx", uiDirectory), "utf8");
    const landmark = /<main\s+([\s\S]*?)>/u.exec(app)?.[1] ?? "";
    expect(landmark).toContain("ref={mainRegion}");
    expect(landmark).toContain("tabIndex={-1}");
    // And the exemption must still be describing a real rule: if the rule is
    // renamed or deleted, the constant above stops matching anything and this
    // says so rather than going quietly stale.
    const shell = parsed.get("shell.css")!;
    expect(shell.some((rule) => rule.selector === ".main:focus" && SUPPRESSION.test(rule.body))).toBe(true);
  });
});
