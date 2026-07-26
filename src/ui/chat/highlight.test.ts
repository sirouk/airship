import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_LIMITS,
  highlightSpans,
  highlightSupportsLanguage,
  normalizeHighlightLanguage,
  type HighlightSpan,
} from "./highlight";
import { MARKDOWN_LIMITS } from "./markdown";

describe("HIGHLIGHT_LIMITS", () => {
  it("scans exactly as far as the parser already keeps", () => {
    // The bound is duplicated to avoid an import cycle; it must not drift.
    expect(HIGHLIGHT_LIMITS.chars).toBe(MARKDOWN_LIMITS.codeChars);
  });
});

describe("normalizeHighlightLanguage", () => {
  it("reads only the language word out of a full fence info string", () => {
    expect(normalizeHighlightLanguage("ts title=foo")).toBe("ts");
    expect(normalizeHighlightLanguage("  TypeScript  ")).toBe("typescript");
    expect(normalizeHighlightLanguage(undefined)).toBeUndefined();
    expect(normalizeHighlightLanguage("   ")).toBeUndefined();
  });

  it("still recognises a supported grammar behind fence metadata", () => {
    expect(highlightSupportsLanguage("ts title=example.ts")).toBe(true);
    expect(highlightSupportsLanguage("brainfuck")).toBe(false);
  });
});

describe("highlightSpans", () => {
  // Fail open: an unrecognised language renders exactly as it does today
  // rather than being tokenised with someone else's grammar.
  it("returns nothing for an unknown or absent language", () => {
    expect(highlightSpans(undefined, "const x = 1;")).toEqual([]);
    expect(highlightSpans("brainfuck", "+++[->+<]")).toEqual([]);
    expect(highlightSpans("ts", "")).toEqual([]);
  });

  it("classifies the ordinary TypeScript vocabulary", () => {
    const source = 'const total = compute(42); // note\nconst label = "hi";';
    expect(kindsOf(source, highlightSpans("ts", source))).toEqual([
      ["kw", "const"],
      ["fn", "compute"],
      ["num", "42"],
      ["com", "// note"],
      ["kw", "const"],
      ["str", '"hi"'],
    ]);
  });

  it("lets a comment swallow keywords instead of tokenising inside it", () => {
    const source = "// const return function\ncode();";
    const spans = highlightSpans("ts", source);
    expect(spans[0]).toMatchObject({ kind: "com", start: 0, end: "// const return function".length });
  });

  it("lets a string swallow keywords", () => {
    const source = 'const message = "if else return";';
    expect(kindsOf(source, highlightSpans("ts", source))).toEqual([
      ["kw", "const"],
      ["str", '"if else return"'],
    ]);
  });

  it("covers rust, python, json, bash and markdown", () => {
    expect(kindsOf("fn main() {}", highlightSpans("rust", "fn main() {}"))).toEqual([["kw", "fn"], ["fn", "main"]]);
    expect(kindsOf("def go(): # c", highlightSpans("py", "def go(): # c"))).toEqual([["kw", "def"], ["fn", "go"], ["com", "# c"]]);
    expect(kindsOf('{"a": 1, "b": true}', highlightSpans("json", '{"a": 1, "b": true}'))).toEqual([
      ["str", '"a"'], ["num", "1"], ["str", '"b"'], ["kw", "true"],
    ]);
    expect(highlightSpans("bash", "if true; then\n  echo \"hi\"\nfi").some((span) => span.kind === "kw")).toBe(true);
    expect(highlightSpans("md", "# Title\n\n`code`").some((span) => span.kind === "kw")).toBe(true);
  });

  it("emits monotonic, non-overlapping spans inside the text", () => {
    const source = readFixture();
    for (const language of HIGHLIGHT_FIXTURE_LANGUAGES) {
      const spans = highlightSpans(language, source);
      // A grammar that stopped matching entirely would make the loop below
      // pass over an empty array, so the assertions have to be reachable first.
      expect(spans.length, language).toBeGreaterThan(0);
      let previousEnd = 0;
      for (const span of spans) {
        expect(span.start, language).toBeGreaterThanOrEqual(previousEnd);
        expect(span.end, language).toBeGreaterThan(span.start);
        expect(span.end, language).toBeLessThanOrEqual(source.length);
        previousEnd = span.end;
      }
    }
  });

  /*
   * This replaces a reassembly check that appended `source.slice(cursor,
   * span.start)` then `source.slice(span.start, span.end)` — algebraically
   * `source.slice(cursor, span.end)`, so it could not fail for any span set
   * that already passed the monotonicity test above. The property that is
   * actually at risk is token alignment: a span whose boundaries drift by a
   * character paints `const` inside `constant` and swallows the rest of the
   * identifier into the keyword colour.
   */
  it("aligns spans to whole tokens instead of matching inside identifiers", () => {
    const source = "const constant = ifelse(iffy); // if";
    expect(kindsOf(source, highlightSpans("ts", source))).toEqual([
      ["kw", "const"],
      ["fn", "ifelse"],
      ["com", "// if"],
    ]);
    const python = "def define(returned): return returned # def";
    expect(kindsOf(python, highlightSpans("py", python))).toEqual([
      ["kw", "def"],
      ["fn", "define"],
      ["kw", "return"],
      ["com", "# def"],
    ]);
  });

  it("bounds span count and scanned length for a pathological block", () => {
    const hostile = "1 ".repeat(HIGHLIGHT_LIMITS.spans * 3);
    const spans = highlightSpans("ts", hostile);
    expect(spans.length).toBeLessThanOrEqual(HIGHLIGHT_LIMITS.spans);
    const long = `const a = 1;\n${"x".repeat(HIGHLIGHT_LIMITS.chars * 2)}`;
    for (const span of highlightSpans("ts", long)) {
      expect(span.end).toBeLessThanOrEqual(HIGHLIGHT_LIMITS.chars);
    }
  });

  it("returns frozen records", () => {
    const spans = highlightSpans("ts", "const a = 1;");
    expect(Object.isFrozen(spans)).toBe(true);
    expect(Object.isFrozen(spans[0])).toBe(true);
  });
});

function kindsOf(source: string, spans: readonly HighlightSpan[]): readonly (readonly [string, string])[] {
  return spans.map((span) => [span.kind, source.slice(span.start, span.end)] as const);
}

const HIGHLIGHT_FIXTURE_LANGUAGES = ["ts", "rust", "py", "json", "bash", "md"] as const;

function readFixture(): string {
  return [
    "# heading and `code`",
    "const total = compute(0x1f, 42.5e3); // trailing",
    "fn main() -> Result<(), Error> { let x = 1_000u32; }",
    "def go(value): return f\"{value}\" # note",
    '{"key": [1, 2, null], "flag": false}',
    "if [ -n \"$HOME\" ]; then echo 'ok'; fi",
    "/* block\n   comment */",
    "- list item",
    "[link](https://example.com)",
  ].join("\n");
}
