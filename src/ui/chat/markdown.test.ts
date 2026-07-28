import { describe, expect, it } from "vitest";
import { MARKDOWN_LIMITS, MarkdownView, inline, nestListItems, parseMarkdown, projectIncrementalMarkdown, safeHref } from "./markdown";
import type { MarkdownBlock, MarkdownListGroup } from "./markdown";

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

describe("headings beyond level three", () => {
  it("parses h4 through h6 instead of rendering the hashes as prose", () => {
    const blocks = parseMarkdown("#### Four\n\n##### Five\n\n###### Six");
    expect(blocks).toEqual([
      { kind: "heading", level: 4, text: "Four" },
      { kind: "heading", level: 5, text: "Five" },
      { kind: "heading", level: 6, text: "Six" },
    ]);
  });

  // The paragraph accumulator eats any line startsBlock() rejects, so a
  // heading directly after prose is the case that actually regresses.
  it("breaks a paragraph on a deep heading that follows prose", () => {
    const blocks = parseMarkdown("Intro sentence.\n#### Section");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "heading"]);
  });

  it("still refuses a seventh level", () => {
    expect(parseMarkdown("####### Seven")).toEqual([{ kind: "paragraph", text: "####### Seven" }]);
  });
});

describe("thematic breaks", () => {
  it("parses a rule that immediately follows a prose line", () => {
    const blocks = parseMarkdown("Before the break.\n---\nAfter the break.");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "rule", "paragraph"]);
  });

  it("accepts asterisk rules and ignores underscores so snake_case survives", () => {
    expect(parseMarkdown("***").map((block) => block.kind)).toEqual(["rule"]);
    expect(parseMarkdown("___").map((block) => block.kind)).toEqual(["paragraph"]);
  });

  it("does not mistake a table separator for a rule", () => {
    const blocks = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(blocks.map((block) => block.kind)).toEqual(["table"]);
  });
});

describe("nested lists", () => {
  it("keeps the indentation level the model wrote", () => {
    const block = firstList("- top\n  - nested\n    - deeper\n- back");
    expect(block.items.map((item) => item.depth)).toEqual([0, 1, 2, 0]);
  });

  it("keeps an ordered sub-list inside its bulleted parent as one block", () => {
    const blocks = parseMarkdown("- plan\n  1. first\n  2. second\n- next");
    expect(blocks.map((block) => block.kind)).toEqual(["list"]);
    const group = nestListItems(firstList("- plan\n  1. first\n  2. second\n- next").items, false);
    expect(group.ordered).toBe(false);
    expect(group.items).toHaveLength(2);
    expect(group.items[0]?.text).toBe("plan");
    expect(group.items[0]?.children?.ordered).toBe(true);
    expect(group.items[0]?.children?.items.map((item) => item.text)).toEqual(["first", "second"]);
    expect(group.items[1]?.text).toBe("next");
  });

  it("treats tab indentation as one nesting level", () => {
    expect(firstList("- top\n\t- nested").items.map((item) => item.depth)).toEqual([0, 1]);
  });

  it("caps adversarially deep indentation at the declared bound", () => {
    const source = Array.from({ length: 40 }, (_, index) => `${" ".repeat(index * 2)}- item ${String(index)}`).join("\n");
    const depths = firstList(source).items.map((item) => item.depth);
    expect(Math.max(...depths)).toBeLessThanOrEqual(MARKDOWN_LIMITS.listDepth - 1);
  });

  it("never loses an item when the nesting is rebuilt", () => {
    const items = firstList("- a\n  - b\n    - c\n  - d\n- e").items;
    expect(flatten(nestListItems(items, false))).toEqual(["a", "b", "c", "d", "e"]);
  });

  // nestListItems only records ordering when it descends a level, so a marker
  // switch among siblings has to become a second block or the numbered run
  // renders as bullets inside the <ul> that preceded it.
  it("splits a same-depth marker switch into sibling blocks", () => {
    const blocks = parseMarkdown("- alpha\n1. beta\n2. gamma");
    expect(blocks.map((block) => block.kind)).toEqual(["list", "list"]);
    expect(listSummary(blocks[0])).toEqual({ ordered: false, texts: ["alpha"] });
    expect(listSummary(blocks[1])).toEqual({ ordered: true, texts: ["beta", "gamma"] });
  });

  it("splits back to bullets when a numbered run is followed by dashes", () => {
    const blocks = parseMarkdown("1. one\n2. two\n- three");
    expect(blocks.map((block) => block.kind)).toEqual(["list", "list"]);
    expect(listSummary(blocks[0])).toEqual({ ordered: true, texts: ["one", "two"] });
    expect(listSummary(blocks[1])).toEqual({ ordered: false, texts: ["three"] });
  });

  // The split is by depth, not by line: the nested case above must not regress
  // into two blocks just because the marker changed one level down.
  it("returns to the outer marker after a nested switch without splitting", () => {
    const blocks = parseMarkdown("- plan\n  1. first\n- next");
    expect(blocks.map((block) => block.kind)).toEqual(["list"]);
    expect(listSummary(blocks[0])).toEqual({ ordered: false, texts: ["plan", "first", "next"] });
  });
});

describe("inline grammar", () => {
  const inlineOf = (source: string) => renderInline(source);

  it("renders bold before italic instead of splitting every bold token", () => {
    expect(inlineOf("**bold** and *italic*")).toEqual([
      { tag: "strong", text: "bold" },
      { text: " and " },
      { tag: "em", text: "italic" },
    ]);
  });

  it("renders strikethrough", () => {
    expect(inlineOf("~~gone~~")).toEqual([{ tag: "del", text: "gone" }]);
  });

  // A transcript carries far more prose about code than emphasis. Without a
  // flanking rule every pair of spaced asterisks in an answer — arithmetic, a
  // shell glob, a footnote marker — silently becomes an <em>.
  it("leaves spaced asterisks in prose literal", () => {
    expect(inlineOf("compute a * b * c now")).toEqual([{ text: "compute a * b * c now" }]);
    expect(inlineOf("run rm *.log *.tmp first")).toEqual([{ text: "run rm *.log *.tmp first" }]);
    expect(inlineOf("3 * 4 * 5 equals 60")).toEqual([{ text: "3 * 4 * 5 equals 60" }]);
    expect(inlineOf("in python 2 ** 8 ** 1 is 256")).toEqual([{ text: "in python 2 ** 8 ** 1 is 256" }]);
  });

  it("still emphasises a genuine delimiter run that hugs its text", () => {
    expect(inlineOf("an *emphasised* word")).toEqual([
      { text: "an " },
      { tag: "em", text: "emphasised" },
      { text: " word" },
    ]);
    expect(inlineOf("a *b* c")).toEqual([{ text: "a " }, { tag: "em", text: "b" }, { text: " c" }]);
    expect(inlineOf("a **b c** d")).toEqual([{ text: "a " }, { tag: "strong", text: "b c" }, { text: " d" }]);
    expect(inlineOf("wildcard*glob*here")).toEqual([
      { text: "wildcard" },
      { tag: "em", text: "glob" },
      { text: "here" },
    ]);
  });

  it("does not italicise snake_case identifiers in prose", () => {
    expect(inlineOf("read MARKDOWN_LIMITS and foo_bar_baz")).toEqual([{ text: "read MARKDOWN_LIMITS and foo_bar_baz" }]);
    expect(inlineOf("_emphasis_ stands alone")).toEqual([{ tag: "em", text: "emphasis" }, { text: " stands alone" }]);
  });

  // index.html restricts img-src to this origin, so a model-supplied remote
  // image is both a broken render and an IP-disclosure vector.
  it("renders an image as labelled link text and never as an img element", () => {
    expect(inlineOf("![a diagram](https://example.com/x.png)")).toEqual([
      { tag: "a", text: "Image: a diagram", href: "https://example.com/x.png" },
    ]);
    // An unsafe scheme degrades to the alt text: no link, and never an <img>.
    expect(inlineOf("![blocked](javascript:alert1)")).toEqual([{ text: "blocked" }]);
    expect(inlineOf("![](https://example.com/x.png)")).toEqual([
      { tag: "a", text: "Image: image", href: "https://example.com/x.png" },
    ]);
  });

  it("keeps ordinary links working", () => {
    expect(inlineOf("[docs](https://example.com/docs)")).toEqual([
      { tag: "a", text: "docs", href: "https://example.com/docs" },
    ]);
  });

  it("keeps inline code opaque to every other rule", () => {
    expect(inlineOf("`a * b _ c`")).toEqual([{ tag: "code", text: "a * b _ c" }]);
  });
});

describe("code block rendering", () => {
  it("emits tokenised spans that still reproduce the source exactly", () => {
    const code = 'const total = compute(42); // note';
    const rendered = renderCodeBlock(`\`\`\`ts\n${code}\n\`\`\``);
    expect(rendered.map((part) => part.text).join("")).toBe(code);
    expect(rendered.filter((part) => part.tag).map((part) => part.tag)).toContain("span");
    expect(rendered.filter((part) => part.className).map((part) => part.className))
      .toEqual(expect.arrayContaining(["tok-kw", "tok-fn", "tok-num", "tok-com"]));
  });

  it("renders an unknown language as untouched plain text", () => {
    const rendered = renderCodeBlock("```brainfuck\n+++[->+<]\n```");
    expect(rendered).toEqual([{ text: "+++[->+<]" }]);
  });
});

/** Walks the real component output down to the `<code>` element's children. */
function renderCodeBlock(source: string): readonly Record<string, unknown>[] {
  const view = MarkdownView({ source }) as { props?: { children?: unknown } };
  const blocks = Array.isArray(view.props?.children) ? view.props!.children : [view.props?.children];
  const block = blocks[0] as { type?: unknown; props?: unknown };
  if (typeof block.type !== "function") throw new Error("expected a block component");
  const rendered = (block.type as (props: unknown) => unknown)(block.props);
  const code = findElement(rendered, "code");
  if (!code) throw new Error("expected a <code> element");
  const parts: Record<string, unknown>[] = [];
  collectCodeParts((code as { props?: { children?: unknown } }).props?.children, parts);
  return parts;
}

function findElement(node: unknown, tag: string): unknown {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, tag);
      if (found) return found;
    }
    return undefined;
  }
  const vnode = node as { type?: unknown; props?: { children?: unknown } };
  if (vnode.type === tag) return vnode;
  return findElement(vnode.props?.children, tag);
}

function collectCodeParts(node: unknown, out: Record<string, unknown>[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string") {
    if (node) out.push({ text: node });
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectCodeParts(child, out);
    return;
  }
  const vnode = node as { type?: unknown; props?: { children?: unknown; class?: string } };
  const inner: Record<string, unknown>[] = [];
  collectCodeParts(vnode.props?.children, inner);
  out.push({
    tag: typeof vnode.type === "string" ? vnode.type : "component",
    className: vnode.props?.class,
    text: inner.map((entry) => String(entry.text ?? "")).join(""),
  });
}

function firstList(source: string) {
  const block = parseMarkdown(source)[0];
  if (block?.kind !== "list") throw new Error(`expected a list block, received ${String(block?.kind)}`);
  return block;
}

function listSummary(block: MarkdownBlock | undefined): Readonly<{ ordered: boolean; texts: readonly string[] }> {
  if (block?.kind !== "list") throw new Error(`expected a list block, received ${String(block?.kind)}`);
  return { ordered: block.ordered, texts: block.items.map((item) => item.text) };
}

function flatten(group: MarkdownListGroup): string[] {
  return group.items.flatMap((item) => [
    ...(item.text ? [item.text] : []),
    ...(item.children ? flatten(item.children) : []),
  ]);
}

/**
 * Reduces the real inline output to a comparable shape. It walks the actual
 * VNodes the transcript renders — nothing here reimplements the grammar.
 */
function renderInline(source: string): readonly Record<string, unknown>[] {
  const collected: Record<string, unknown>[] = [];
  walk(inline(source), collected);
  return collected;
}

function walk(node: unknown, out: Record<string, unknown>[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string") {
    if (node) out.push({ text: node });
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  const vnode = node as { type?: unknown; props?: { children?: unknown; href?: string } };
  if (typeof vnode.type !== "string") throw new Error("inline markdown must emit intrinsic elements only");
  const text: Record<string, unknown>[] = [];
  walk(vnode.props?.children, text);
  out.push({
    tag: vnode.type,
    text: text.map((entry) => String(entry.text ?? "")).join(""),
    ...(vnode.props?.href ? { href: vnode.props.href } : {}),
  });
}
