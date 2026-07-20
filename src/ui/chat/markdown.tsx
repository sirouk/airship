import { createElement, type ComponentChildren, type VNode } from "preact";
import { useRef } from "preact/hooks";

export const MARKDOWN_LIMITS = Object.freeze({
  sourceChars: 65_536,
  codeChars: 32_768,
  tableRows: 100,
  listItems: 200,
});

export type MarkdownBlock =
  | Readonly<{ kind: "paragraph" | "blockquote"; text: string }>
  | Readonly<{ kind: "heading"; level: 1 | 2 | 3; text: string }>
  | Readonly<{ kind: "code"; language?: string; text: string; closed: boolean }>
  | Readonly<{ kind: "list"; ordered: boolean; items: readonly string[] }>
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
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) {
      blocks.push(Object.freeze({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! }));
      index += 1;
      continue;
    }
    const list = /^(\s*)([-*+] |\d+\. )(.+)$/u.exec(line);
    if (list) {
      const ordered = /\d/u.test(list[2]!);
      const items: string[] = [];
      while (index < lines.length && items.length < MARKDOWN_LIMITS.listItems) {
        const candidate = /^(\s*)([-*+] |\d+\. )(.+)$/u.exec(lines[index] ?? "");
        if (!candidate || /\d/u.test(candidate[2]!) !== ordered) break;
        items.push(candidate[3]!);
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
    <pre><code>{block.text}</code></pre>
  </section>;
  if (block.kind === "heading") return createElement(`h${String(block.level)}`, {}, inline(block.text));
  if (block.kind === "list") return createElement(block.ordered ? "ol" : "ul", {}, block.items.map((item, index) => <li key={index}>{inline(item)}</li>));
  if (block.kind === "table") return <div class="markdown-table-wrap"><table><thead><tr>{block.rows[0]?.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead><tbody>{block.rows.slice(1).map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>;
  if (block.kind === "blockquote") return <blockquote>{inline(block.text)}</blockquote>;
  return <p>{inline(block.text)}</p>;
}

function inline(text: string): ComponentChildren {
  const nodes: ComponentChildren[] = [];
  const expression = /(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*)/gu;
  let cursor = 0;
  for (const match of text.matchAll(expression)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) nodes.push(<code>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) nodes.push(<strong>{token.slice(2, -2)}</strong>);
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token)!;
      const href = safeHref(link[2]!);
      nodes.push(href ? <a href={href} target="_blank" rel="noreferrer noopener">{link[1]}</a> : link[1]);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes as VNode[];
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

function startsBlock(line: string): boolean {
  return /^(```|#{1,3}\s|>\s?|\s*(?:[-*+] |\d+\. ))/u.test(line);
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
