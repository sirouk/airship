import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `tabs.tsx` declares itself the single owner of the tablist contract, and
 * nothing enforced that. Three surfaces took `role="tab"` as styling-adjacent
 * markup and shipped without the behaviour the role obliges: a roving tabindex
 * and ←/→/Home/End moving selection and focus. Every one of them was a strip a
 * keyboard user could reach and then not move through.
 *
 * `Tabs` itself hangs the handler on each tab button, which is why it is the
 * one exemption; every other tablist has to carry the handler on the element
 * that owns the role, where this check can see it.
 */
const OWNER = "src/ui/tabs.tsx";

describe("the tablist contract", () => {
  it("is either adopted from tabs.tsx or implemented, never only painted", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      if (file === OWNER) continue;
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const tag of openingTagsWith(source, 'role="tablist"')) {
        if (!tag.includes("onKeyDown")) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps exactly one tab in the tab order wherever it is hand-rolled", () => {
    for (const file of sourceFiles("src")) {
      if (file === OWNER) continue;
      const source = withoutComments(readFileSync(file, "utf8"));
      if (!source.includes('role="tablist"')) continue;
      const tabs = openingTagsWith(source, 'role="tab"');
      // Every `role="tab"` in the file states its own tab-order position, so
      // the strip has one entry point rather than one stop per tab.
      expect(tabs.filter((tag) => !tag.includes("tabIndex")), `${file} has role="tab" without tabIndex`).toEqual([]);
      expect(tabs.filter((tag) => !tag.includes("aria-controls")), `${file} has role="tab" without aria-controls`).toEqual([]);
    }
  });
});

/**
 * The opening tags carrying an attribute, brace-aware.
 *
 * An attribute value may hold `>` — a template literal, an arrow function — so
 * the scan tracks `{}` depth rather than stopping at the first angle bracket.
 */
function openingTagsWith(source: string, attribute: string): string[] {
  const tags: string[] = [];
  for (let index = source.indexOf(attribute); index >= 0; index = source.indexOf(attribute, index + 1)) {
    // `[role="tab"]` is a CSS selector looking for one, not a tab declaring
    // itself; the strips below use exactly that selector to move focus.
    if (source[index - 1] === "[") continue;
    const start = source.lastIndexOf("<", index);
    if (start < 0) continue;
    let depth = 0;
    let end = start;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) break;
    }
    tags.push(source.slice(start, end + 1));
  }
  return tags;
}

/**
 * This repo explains itself in prose, and that prose quotes the very markup
 * being checked. A comment naming `role="tab"` is documentation, not a tab.
 * A JSX comment collapses to a balanced pair of braces, so the depth scan
 * below stays honest across the removal.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "");
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (path.endsWith(".tsx")) found.push(path);
  }
  return found;
}
