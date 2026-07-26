import { createElement, type ComponentChildren, type VNode } from "preact";
import { useRef } from "preact/hooks";
import { highlightSpans, type HighlightSpan } from "./highlight";

export const MARKDOWN_LIMITS = Object.freeze({
  sourceChars: 65_536,
  codeChars: 32_768,
  tableRows: 100,
  listItems: 200,
  /**
   * `listItems` alone does not bound indentation: 200 items each one level
   * deeper would build a 200-deep element tree. Depth is capped separately.
   */
  listDepth: 6,
});

export type MarkdownHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** A flat list line plus the nesting level it was written at. */
export type MarkdownListItem = Readonly<{
  depth: number;
  ordered: boolean;
  text: string;
}>;

export type MarkdownBlock =
  | Readonly<{ kind: "paragraph" | "blockquote"; text: string }>
  | Readonly<{ kind: "heading"; level: MarkdownHeadingLevel; text: string }>
  | Readonly<{ kind: "code"; language?: string; text: string; closed: boolean }>
  | Readonly<{ kind: "list"; ordered: boolean; items: readonly MarkdownListItem[] }>
  | Readonly<{ kind: "rule" }>
  | Readonly<{ kind: "table"; rows: readonly (readonly string[])[] }>;

export type IncrementalMarkdownProjection = Readonly<{
  source: string;
  stableLength: number;
  stableBlocks: readonly MarkdownBlock[];
  trailingBlocks: readonly MarkdownBlock[];
}>;

/** Bounded, zero-dependency markdown parsing. Rendering never uses innerHTML. */
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  const input = source.slice(0, MARKDOWN_LIMITS.sourceChars).replace(/\r\n?/gu, "\n");
  const lines = input.split("\n");
  const blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index += 1; continue; }
    const fence = /^```([^`]*)$/u.exec(line);
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index] ?? "")) {
        if (content.join("\n").length < MARKDOWN_LIMITS.codeChars) content.push(lines[index] ?? "");
        index += 1;
      }
      const closed = index < lines.length;
      if (closed) index += 1;
      blocks.push(Object.freeze({ kind: "code", language: boundedLabel(fence[1]), text: content.join("\n").slice(0, MARKDOWN_LIMITS.codeChars), closed }));
      continue;
    }
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      blocks.push(Object.freeze({ kind: "heading", level: heading[1]!.length as MarkdownHeadingLevel, text: heading[2]! }));
      index += 1;
      continue;
    }
    if (RULE_PATTERN.test(line)) {
      blocks.push(FROZEN_RULE);
      index += 1;
      continue;
    }
    const list = LIST_PATTERN.exec(line);
    if (list) {
      const ordered = /\d/u.test(list[2]!);
      const items: MarkdownListItem[] = [];
      // One indent stack for the whole run: an ordered list nested inside a
      // bulleted one is one structure, not two sibling blocks.
      const indents: number[] = [];
      while (index < lines.length && items.length < MARKDOWN_LIMITS.listItems) {
        const candidate = LIST_PATTERN.exec(lines[index] ?? "");
        if (!candidate) break;
        const candidateOrdered = /\d/u.test(candidate[2]!);
        const depth = listDepth(indents, indentWidth(candidate[1]!));
        // A marker switch at the run's own depth is a sibling block, not a
        // continuation: `nestListItems` records ordering per nesting level, so
        // absorbing `1. beta` into a bulleted run would render it as a bullet.
        // Deeper switches are kept, which is what makes the nested case work.
        if (depth === 0 && candidateOrdered !== ordered) break;
        items.push(Object.freeze({
          depth,
          ordered: candidateOrdered,
          text: candidate[3]!,
        }));
        index += 1;
      }
      blocks.push(Object.freeze({ kind: "list", ordered, items: Object.freeze(items) }));
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/u.test(lines[index + 1] ?? "")) {
      const rows = [cells(line)];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && rows.length < MARKDOWN_LIMITS.tableRows) {
        rows.push(cells(lines[index] ?? ""));
        index += 1;
      }
      const frozenRows: readonly (readonly string[])[] = Object.freeze(rows.map((row) => Object.freeze(row.slice())));
      blocks.push(Object.freeze({ kind: "table", rows: frozenRows }));
      continue;
    }
    if (/^>\s?/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index] ?? "")) quote.push((lines[index++] ?? "").replace(/^>\s?/u, ""));
      blocks.push(Object.freeze({ kind: "blockquote", text: quote.join("\n") }));
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !startsBlock(lines[index] ?? "")) paragraph.push(lines[index++] ?? "");
    blocks.push(Object.freeze({ kind: "paragraph", text: paragraph.join("\n") }));
  }
  return Object.freeze(blocks);
}

export function MarkdownView({ source, streaming = false }: { source: string; streaming?: boolean }) {
  const blocks = parseMarkdown(source);
  return <div class={`markdown ${streaming ? "streaming" : ""}`}>
    {blocks.map((block, index) => <MarkdownBlockView block={block} key={`${block.kind}-${index}`} />)}
  </div>;
}

/** Completed block objects retain identity; only the mutable tail is reparsed. */
export function projectIncrementalMarkdown(
  source: string,
  previous?: IncrementalMarkdownProjection,
): IncrementalMarkdownProjection {
  const bounded = source.slice(0, MARKDOWN_LIMITS.sourceChars).replace(/\r\n?/gu, "\n");
  const canExtend = Boolean(previous && bounded.startsWith(previous.source));
  const priorStableLength = canExtend ? previous!.stableLength : 0;
  const stableLength = stableMarkdownBoundary(bounded, priorStableLength);
  const newlyStable = bounded.slice(priorStableLength, stableLength);
  const stableBlocks = Object.freeze([
    ...(canExtend ? previous!.stableBlocks : []),
    ...(newlyStable ? parseMarkdown(newlyStable) : []),
  ]);
  return Object.freeze({
    source: bounded,
    stableLength,
    stableBlocks,
    trailingBlocks: parseMarkdown(bounded.slice(stableLength)),
  });
}

export function IncrementalMarkdownView({ source }: { source: string }) {
  const projection = useRef<IncrementalMarkdownProjection>();
  projection.current = projectIncrementalMarkdown(source, projection.current);
  const blocks = [...projection.current.stableBlocks, ...projection.current.trailingBlocks];
  return <div class="markdown streaming">
    {blocks.map((block, index) => <MarkdownBlockView block={block} key={`${block.kind}-${index}`} />)}
  </div>;
}

function MarkdownBlockView({ block }: { block: MarkdownBlock }) {
  if (block.kind === "code") return <section class="markdown-code">
    <header><span>{block.language || "code"}{block.closed ? "" : " · streaming"}</span><button type="button" onClick={(event) => void copyText(block.text, event.currentTarget)}>Copy</button></header>
    <pre><code>{highlightedCode(block)}</code></pre>
  </section>;
  if (block.kind === "heading") return createElement(`h${String(block.level)}`, {}, inline(block.text));
  if (block.kind === "rule") return <hr class="markdown-rule" />;
  if (block.kind === "list") return <ListGroupView group={nestListItems(block.items, block.ordered)} />;
  if (block.kind === "table") return <div class="markdown-table-wrap"><table><thead><tr>{block.rows[0]?.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead><tbody>{block.rows.slice(1).map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>;
  if (block.kind === "blockquote") return <blockquote>{inline(block.text)}</blockquote>;
  return <p>{inline(block.text)}</p>;
}

/**
 * Tokenisation is keyed on the frozen block object, so a completed block is
 * scanned once no matter how many streaming flushes re-render the transcript.
 * Only the mutable trailing block is rescanned, keeping streaming O(n).
 */
const highlightCache = new WeakMap<object, readonly HighlightSpan[]>();

function highlightedCode(block: Readonly<{ kind: "code"; language?: string; text: string; closed: boolean }>): ComponentChildren {
  let spans = highlightCache.get(block);
  if (!spans) {
    spans = highlightSpans(block.language, block.text);
    if (block.closed) highlightCache.set(block, spans);
  }
  if (!spans.length) return block.text;
  const nodes: ComponentChildren[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) nodes.push(block.text.slice(cursor, span.start));
    nodes.push(<span class={`tok-${span.kind}`}>{block.text.slice(span.start, span.end)}</span>);
    cursor = span.end;
  }
  if (cursor < block.text.length) nodes.push(block.text.slice(cursor));
  return nodes as VNode[];
}

export type MarkdownListNode = Readonly<{ text: string; children?: MarkdownListGroup }>;
export type MarkdownListGroup = Readonly<{ ordered: boolean; items: readonly MarkdownListNode[] }>;

/**
 * Rebuilds the nesting the parser recorded as a depth per item. The parser
 * already caps depth at `MARKDOWN_LIMITS.listDepth`, so this recursion is
 * bounded; a deeper indent simply stays at the cap rather than being dropped.
 */
export function nestListItems(items: readonly MarkdownListItem[], ordered: boolean): MarkdownListGroup {
  let cursor = 0;
  const level = (depth: number, levelOrdered: boolean): MarkdownListGroup => {
    const nodes: MarkdownListNode[] = [];
    while (cursor < items.length) {
      const item = items[cursor]!;
      if (item.depth < depth) break;
      if (item.depth > depth) {
        // A deeper run belongs to the item that opened it; an orphan deeper
        // run with no parent becomes its own item so no text is lost.
        const nested = level(depth + 1, item.ordered);
        const previous = nodes.pop();
        nodes.push(Object.freeze({ text: previous?.text ?? "", children: nested }));
        continue;
      }
      cursor += 1;
      nodes.push(Object.freeze({ text: item.text }));
    }
    return Object.freeze({ ordered: levelOrdered, items: Object.freeze(nodes) });
  };
  return level(0, ordered);
}

function ListGroupView({ group }: { group: MarkdownListGroup }) {
  return createElement(group.ordered ? "ol" : "ul", {}, group.items.map((item, index) => (
    <li key={index}>{inline(item.text)}{item.children ? <ListGroupView group={item.children} /> : null}</li>
  )));
}

/** Exported so the inline grammar can be asserted without a DOM renderer. */
export function inline(text: string): ComponentChildren {
  const nodes: ComponentChildren[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    // Order is load-bearing in both places: `**` must be tested before `*`,
    // and the alternation above must offer `**` first, or every bold token is
    // split into two empty emphases.
    if (token.startsWith("`")) nodes.push(<code>{token.slice(1, -1)}</code>);
    else if (token.startsWith("![") || token.startsWith("[")) nodes.push(linkNode(token));
    else if (token.startsWith("**")) nodes.push(<strong>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("~~")) nodes.push(<del>{token.slice(2, -2)}</del>);
    else nodes.push(<em>{token.slice(1, -1)}</em>);
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes as VNode[];
}

/**
 * Inline grammar. Every delimiter is flanked, because a transcript carries far
 * more prose about code than emphasis:
 *
 * - `*`, `**` and `~~` follow CommonMark's flanking rule — the opener may not
 *   be followed by whitespace and the closer may not be preceded by it — so
 *   `3 * 4 * 5`, `2 ** 8` and `rm *.log *.tmp` stay literal while `*word*`
 *   still emphasises. Without it any two spaced asterisks italicise the text
 *   between them.
 * - `_..._` is additionally fenced by non-word boundaries, because unlike `*`
 *   it also appears inside identifiers: `MARKDOWN_LIMITS`, `foo_bar_baz`.
 */
const INLINE_PATTERN = new RegExp([
  "`[^`\\n]+`",
  "!?\\[[^\\]\\n]*\\]\\([^\\s)]+\\)",
  "\\*\\*(?![\\s*])[^*\\n]*[^\\s*]\\*\\*",
  "~~(?![\\s~])[^~\\n]*[^\\s~]~~",
  "\\*(?![\\s*])[^*\\n]*[^\\s*]\\*",
  "(?<![\\p{L}\\p{N}_])_[^_\\n]+_(?![\\p{L}\\p{N}_])",
].map((alternative) => `(?:${alternative})`).join("|"), "gu");

/**
 * Images render as their alt text plus a link, never as `<img>`: index.html
 * restricts `img-src` to this origin, so a model-supplied remote image would
 * both fail to load and hand the page's IP to whoever the model named.
 */
function linkNode(token: string): ComponentChildren {
  const image = token.startsWith("!");
  const parsed = /^!?\[([^\]]*)\]\(([^)]+)\)$/u.exec(token);
  if (!parsed) return token;
  const label = parsed[1] || (image ? "image" : parsed[2]!);
  const href = safeHref(parsed[2]!);
  if (!href) return label;
  return image
    ? <a href={href} target="_blank" rel="noreferrer noopener">{`Image: ${label}`}</a>
    : <a href={href} target="_blank" rel="noreferrer noopener">{label}</a>;
}

export function safeHref(value: string): string | undefined {
  return /^(https?:|mailto:)/iu.test(value) ? value.slice(0, 2_048) : undefined;
}

async function copyText(value: string, button: HTMLButtonElement): Promise<void> {
  await navigator.clipboard.writeText(value);
  const prior = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => { button.textContent = prior; }, 1_200);
}

const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/u;
const LIST_PATTERN = /^([ \t]*)([-*+] |\d+\. )(.+)$/u;
/** A thematic break; `___` is excluded so a snake_case line is never eaten. */
const RULE_PATTERN = /^ {0,3}(?:-{3,}|\*{3,})[ \t]*$/u;
const FROZEN_RULE: MarkdownBlock = Object.freeze({ kind: "rule" });

function indentWidth(prefix: string): number {
  let width = 0;
  for (const character of prefix) width += character === "\t" ? 4 : 1;
  return width;
}

/**
 * Resolves an indent column to a nesting depth against the columns already
 * seen in this run, so 2-space, 3-space and tab indentation all nest once.
 * The stack is the bound: depth can never exceed `MARKDOWN_LIMITS.listDepth`.
 */
function listDepth(indents: number[], width: number): number {
  while (indents.length && indents[indents.length - 1]! > width) indents.pop();
  if (!indents.length || indents[indents.length - 1]! < width) {
    if (indents.length < MARKDOWN_LIMITS.listDepth) indents.push(width);
  }
  return Math.max(0, indents.length - 1);
}

/**
 * A block-opening line the paragraph accumulator must not swallow. Thematic
 * breaks and h4-h6 are unreachable without being listed here, because the
 * accumulator consumes every non-blank line this returns false for.
 */
function startsBlock(line: string): boolean {
  return /^(```|#{1,6}\s|>\s?|[ \t]*(?:[-*+] |\d+\. ))/u.test(line) || RULE_PATTERN.test(line);
}

function stableMarkdownBoundary(source: string, floor: number): number {
  let inFence = false;
  let stable = floor;
  let cursor = 0;
  for (const line of source.split("\n")) {
    const next = cursor + line.length + 1;
    if (/^```/u.test(line)) {
      inFence = !inFence;
      if (!inFence) stable = Math.min(source.length, next);
    } else if (!inFence && line.trim() === "") {
      stable = Math.min(source.length, next);
    }
    cursor = next;
  }
  return Math.max(floor, stable);
}

function cells(line: string): string[] {
  return line.replace(/^\s*\||\|\s*$/gu, "").split("|").map((value) => value.trim()).slice(0, 24);
}

function boundedLabel(value: string | undefined): string | undefined {
  const result = value?.trim().slice(0, 40);
  return result || undefined;
}
