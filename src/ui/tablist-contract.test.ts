import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `tabs.tsx` owns keyboard movement for every tablist.
 *
 * `Tabs` uses the shared rule internally. A specialized hand-rolled strip may
 * keep its own markup, but it must import `nextTabId`, expose a roving tab stop,
 * and bind selection to that same tab. This scan covers every TSX source so a
 * new strip cannot silently opt out.
 */
const OWNER = join("src", "ui", "tabs.tsx");

/** `import { …, nextTabId, … } from "./tabs"` at any depth under `src/ui`. */
const ADOPTS_MOVEMENT_RULE = /import\s*\{[^}]*\bnextTabId\b[^}]*\}\s*from\s*"(?:\.\.?\/)+tabs"/u;

describe("the tablist contract", () => {
  it("takes its movement rule from tabs.tsx rather than reimplementing it", () => {
    const offenders: string[] = [];
    for (const file of handRolledTablists()) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const tag of openingTagsWith(source, 'role="tablist"')) {
        if (!tag.includes("onKeyDown")) offenders.push(`${file} has role="tablist" with no key handler`);
      }
      if (!ADOPTS_MOVEMENT_RULE.test(source)) offenders.push(`${file} implements tablist movement without nextTabId`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps exactly one tab in the tab order wherever it is hand-rolled", () => {
    const offenders: string[] = [];
    for (const file of handRolledTablists()) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const tag of openingTagsWith(source, 'role="tab"')) {
        const position = attributeExpression(tag, "tabIndex");
        const selected = attributeExpression(tag, "aria-selected");
        if (position === undefined) {
          offenders.push(`${file} has role="tab" without tabIndex`);
          continue;
        }
        /*
         * Read the expression, not the attribute. A literal position is a fixed
         * one: `tabIndex={0}` makes every tab a Tab stop — one keystroke per tab
         * to cross the strip — and `tabIndex={-1}` on all of them makes the strip
         * unreachable. Only a conditional can rove, and it has to name both ends
         * of the pair.
         */
        const condition = ternaryCondition(position);
        if (condition === undefined || !/(?:^|[^\d-])0(?:[^\d]|$)/u.test(position) || !position.includes("-1")) {
          offenders.push(`${file} has role="tab" with a fixed tab-order position: tabIndex={${position.trim()}}`);
          continue;
        }
        /*
         * And "exactly one" is only true if the tab at 0 is the selected one.
         * `aria-selected` is single-valued across the strip, so requiring the
         * roving condition to be the very expression that renders selection is
         * what turns "some tabs are -1" into one tab stop, landing where the eye
         * already is. Textual equality is deliberately strict: two spellings of
         * the same idea are two things to keep in step, which is the drift this
         * file exists to refuse.
         */
        if (selected === undefined) offenders.push(`${file} has role="tab" without aria-selected`);
        else if (condition.trim() !== selected.trim()) {
          offenders.push(`${file} roves on \`${condition.trim()}\` but renders selection as \`${selected.trim()}\``);
        }
        if (!tag.includes("aria-controls")) offenders.push(`${file} has role="tab" without aria-controls`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sees the specialized Terminal strip rather than a stale fixture ledger", () => {
    expect(handRolledTablists()).toEqual([
      join("src", "ui", "terminal-view.tsx"),
    ]);
  });
});

/**
 * The test of a conditional expression, or `undefined` if it is not one.
 *
 * `?.` and `??` are spelled with the same character and are not a choice
 * between two positions, so a scan that stopped at the first `?` would read
 * `session.id === activeId` as `session.id === sessions[0]` and report drift
 * that is not there.
 */
function ternaryCondition(expression: string): string | undefined {
  let depth = 0;
  for (let cursor = 0; cursor < expression.length; cursor += 1) {
    const character = expression[cursor];
    if (character !== undefined && "([{".includes(character)) depth += 1;
    else if (character !== undefined && ")]}".includes(character)) depth -= 1;
    else if (character === "?" && depth === 0) {
      if (expression[cursor + 1] === "." || expression[cursor + 1] === "?") {
        cursor += 1;
        continue;
      }
      return expression.slice(0, cursor);
    }
  }
  return undefined;
}

/** One attribute's `{…}` expression, brace-aware so a nested `{}` survives. */
function attributeExpression(tag: string, attribute: string): string | undefined {
  const open = tag.indexOf(`${attribute}={`);
  if (open < 0) return undefined;
  let depth = 0;
  for (let cursor = open + attribute.length + 1; cursor < tag.length; cursor += 1) {
    if (tag[cursor] === "{") depth += 1;
    else if (tag[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return tag.slice(open + attribute.length + 2, cursor);
    }
  }
  return undefined;
}

/** Every `.tsx` under `src` that paints a tablist itself instead of using `Tabs`. */
function handRolledTablists(): string[] {
  return sourceFiles("src").filter((file) =>
    file !== OWNER && withoutComments(readFileSync(file, "utf8")).includes('role="tablist"'));
}

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
