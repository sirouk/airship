import { describe, expect, it } from "vitest";
import { MARKDOWN_LIMITS, parseMarkdown, projectIncrementalMarkdown, safeHref } from "./markdown";

describe("bounded markdown", () => {
  it("parses the CLI-grade subset in source order", () => {
    const blocks = parseMarkdown("# Result\n\n- one\n- two\n\n```ts\nconst ok = true;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "list", "code", "table"]);
    expect(blocks[2]).toMatchObject({ kind: "code", language: "ts", closed: true });
  });

  it("marks a streaming fence open and bounds hostile source", () => {
    const blocks = parseMarkdown(`\`\`\`txt\n${"x".repeat(MARKDOWN_LIMITS.sourceChars * 2)}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code", closed: false });
    if (blocks[0]?.kind === "code") expect(blocks[0].text.length).toBeLessThanOrEqual(MARKDOWN_LIMITS.codeChars);
  });

  it("allows navigable schemes and rejects script/data links", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,nope")).toBeUndefined();
  });

  it("freezes completed blocks and reparses only the trailing block", () => {
    const first = projectIncrementalMarkdown("Completed paragraph.\n\nOpen");
    const stableBlock = first.stableBlocks[0];
    const next = projectIncrementalMarkdown("Completed paragraph.\n\nOpen paragraph grows", first);
    expect(next.stableBlocks[0]).toBe(stableBlock);
    expect(next.trailingBlocks).toMatchObject([{ kind: "paragraph", text: "Open paragraph grows" }]);
  });
});
