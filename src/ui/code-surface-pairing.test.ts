import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The textarea and the layer painted behind it are one control in two boxes.
 *
 * Every metric that decides where a glyph lands — the font, the line height,
 * the padding, the tab size, the wrap mode — has to be identical in both, and
 * nothing about breaking that is visible in a diff. It shipped broken within
 * an hour of being written: a density block from a neighbouring change named
 * `.code-editor` and `.code-gutter` and knew nothing about `.code-highlight`,
 * so under Comfortable the textarea grew to 15.9px/28.4px while the paint
 * stayed at 12.75px/21.9px. The colours were a quarter of a line out by row
 * five and a full row out by row twenty, with the caret telling the truth the
 * whole way down.
 *
 * A reviewer cannot catch that. This can: any rule that moves one of the
 * paired properties on one of the two boxes has to move it on the other, in
 * the same at-rule context, to the same value.
 */

const PAIRED_PROPERTIES = Object.freeze([
  "font",
  "font-size",
  "font-family",
  "line-height",
  "letter-spacing",
  "padding",
  "padding-inline",
  "padding-block",
  "padding-left",
  "padding-right",
  "padding-top",
  "padding-bottom",
  "box-sizing",
  "tab-size",
  "white-space",
  "overflow-wrap",
  "word-break",
  "text-indent",
] as const);

const source = withoutComments(await readFile(new URL("./workspace-view.css", import.meta.url), "utf8"));

describe("the editing surface and the layer painted behind it share one geometry", () => {
  it("moves both boxes together, in every context that moves either", () => {
    const editor = pairedDeclarations(".code-editor");
    const layer = pairedDeclarations(".code-highlight");
    const measure = pairedDeclarations(".code-wrap-measure");
    expect(
      [...editor.keys()].sort(),
      "A context that lays out the textarea must lay out the painted layer too.",
    ).toEqual([...layer.keys()].sort());
    expect(
      [...editor.keys()].sort(),
      "The hidden wrapping measurement must use the textarea's exact geometry.",
    ).toEqual([...measure.keys()].sort());
    for (const [context, declarations] of editor) {
      expect(layer.get(context), `${context || "base rule"}`).toEqual(declarations);
      expect(measure.get(context), `${context || "base rule"} measurement`).toEqual(declarations);
    }
  });

  it("reads a real rule, so the scan cannot silently match nothing", () => {
    // The guard the whole file rests on: if the parser stops finding rules,
    // every assertion above passes on two empty maps.
    expect(pairedDeclarations(".code-editor").size).toBeGreaterThanOrEqual(2);
    // "|" is the key of the unconditional base rule: no at-rule, nothing left
    // in the selector once the class itself is removed.
    expect(pairedDeclarations(".code-editor").get("|")?.["tab-size"]).toBe("2");
  });
});

/**
 * Declarations of the paired properties, keyed by the *context* the rule
 * applies in: its at-rule chain plus whatever the selector says beyond naming
 * the box itself. `.code-editor` and `.code-highlight` both reduce to the same
 * key, so the two base rules and the two `[data-wrap="on"]` rules are compared
 * against each other rather than against nothing.
 */
function pairedDeclarations(className: string): Map<string, Record<string, string>> {
  // `className` carries its leading dot, so the backslash escapes it; the
  // lookahead is what keeps `.code-editor-frame` out of `.code-editor`'s scan.
  const named = new RegExp(`\\${className}(?![\\w-])`, "u");
  const found = new Map<string, Record<string, string>>();
  for (const rule of rules(source)) {
    if (!named.test(rule.selector)) continue;
    const declarations: Record<string, string> = {};
    for (const declaration of rule.body.split(";")) {
      const split = declaration.indexOf(":");
      if (split < 0) continue;
      const property = declaration.slice(0, split).trim();
      if (!(PAIRED_PROPERTIES as readonly string[]).includes(property)) continue;
      declarations[property] = declaration.slice(split + 1).trim().replace(/\s+/gu, " ");
    }
    if (Object.keys(declarations).length === 0) continue;
    const context = `${rule.conditions}|${normalizeSelector(rule.selector, className)}`;
    found.set(context, { ...found.get(context), ...declarations });
  }
  return found;
}

/**
 * Reduce the selector to "what this rule says apart from which of the two
 * boxes it names", so `.code-editor` and `.code-highlight` — and the
 * `:is(.code-editor, .code-highlight)` form that fixed the density bug — all
 * land on the same key.
 */
function normalizeSelector(selector: string, className: string): string {
  return selector
    .replace(/:is\([^)]*\)/gu, "")
    .replace(new RegExp(`\\${className}(?![\\w-])`, "gu"), "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Flat scan of `selector { body }`, carrying the enclosing at-rule preludes. */
function* rules(css: string): Generator<Readonly<{ conditions: string; selector: string; body: string }>> {
  const stack: string[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    const close = css.indexOf("}", cursor);
    if (open < 0 && close < 0) return;
    if (close >= 0 && (open < 0 || close < open)) {
      stack.pop();
      cursor = close + 1;
      continue;
    }
    const prelude = css.slice(cursor, open).trim();
    if (prelude.startsWith("@")) {
      stack.push(prelude);
      cursor = open + 1;
      continue;
    }
    const end = css.indexOf("}", open);
    if (end < 0) return;
    yield { conditions: stack.join(" "), selector: prelude, body: css.slice(open + 1, end) };
    cursor = end + 1;
  }
}

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}
