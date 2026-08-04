import type { VNode } from "preact";
import { describe, expect, it } from "vitest";
import { editorHighlightLanguage, highlightedSource } from "./code-surface";

/**
 * The painted layer sits behind a real textarea, so its only hard obligation
 * is that it holds the *same characters* the textarea holds. Drop one, add
 * one, or lose the trailing line, and every colour below that point is painted
 * against the wrong glyph while the caret keeps telling the truth.
 */
function painted(nodes: unknown): string {
  if (typeof nodes === "string") return nodes;
  if (Array.isArray(nodes)) return nodes.map(painted).join("");
  const node = nodes as VNode<{ children?: unknown }> | null;
  return node?.props ? painted(node.props.children) : "";
}

describe("the painted layer reproduces the buffer exactly", () => {
  it("emits every character of a highlighted file", () => {
    const source = "const answer = 42; // a comment\nexport function go() { return \"x\"; }\n";
    expect(painted(highlightedSource("ts", source))).toBe(`${source} `);
  });

  it("keeps a trailing newline visible as a line", () => {
    // A textarea reserves a line box for the empty final line; a <pre> does
    // not. Without the pad the last row of every file paints one row high.
    expect(painted(highlightedSource("ts", "a\n"))).toBe("a\n ");
    expect(painted(highlightedSource("ts", "a"))).toBe("a");
  });

  it("renders an unknown language as plain text rather than guessing", () => {
    const source = "who knows what this is\n";
    expect(highlightedSource(undefined, source)).toBe(`${source} `);
    expect(highlightedSource("cobol", source)).toBe(`${source} `);
  });

  it("keeps the tail of a buffer longer than the scanner's bound", () => {
    const long = `${"const a = 1;\n".repeat(3_000)}TAIL`;
    const result = painted(highlightedSource("ts", long));
    expect(result).toBe(long);
    expect(result.endsWith("TAIL")).toBe(true);
  });
});

describe("the language comes from the file name", () => {
  it("reads the extension and lowercases it", () => {
    expect(editorHighlightLanguage("/workspace/src/app.TSX")).toBe("tsx");
    expect(editorHighlightLanguage("/workspace/notes.md")).toBe("md");
  });

  it("answers nothing for a name that carries no extension", () => {
    expect(editorHighlightLanguage("/workspace/Dockerfile")).toBeUndefined();
    expect(editorHighlightLanguage("/workspace/.gitignore")).toBeUndefined();
    expect(editorHighlightLanguage("/workspace/archive.")).toBeUndefined();
  });

  it("is not fooled by a dot in a directory name", () => {
    expect(editorHighlightLanguage("/workspace/v1.2/README")).toBeUndefined();
  });
});
