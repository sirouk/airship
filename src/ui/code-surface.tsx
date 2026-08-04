import type { ComponentChildren, Ref, VNode } from "preact";
import { useMemo } from "preact/hooks";
import { highlightSpans } from "./chat/highlight";

/**
 * The painted twin of the editing textarea.
 *
 * A `<textarea>` cannot colour its own contents, and replacing it with a
 * contenteditable surface would trade real text editing — native undo,
 * spellcheck suppression, IME, autoscroll, `selectionStart`, the browser's own
 * caret — for a colour. So the textarea stays the one real control and this
 * `<pre>` sits directly behind it holding the same characters in the same
 * metrics, with the textarea's own glyphs painted transparent above it.
 *
 * Everything that makes the two boxes identical is load-bearing and paired in
 * `workspace-view.css`: font, line height, padding, `tab-size`, `white-space`
 * and the wrap mode. The pre is `aria-hidden` because the accessible text is
 * the textarea's value; a screen reader that met both would read the file
 * twice.
 */

/**
 * The highlighter is keyed by language name and already answers "I do not know
 * this one" with no spans, so the file extension can be handed to it raw: an
 * unknown or absent extension renders as plain monospace rather than as a
 * guess about what the file is.
 */
export function editorHighlightLanguage(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

export function CodeHighlightLayer({
  text,
  path,
  wrap,
  layer,
}: Readonly<{
  text: string;
  path: string;
  wrap: boolean;
  layer: Ref<HTMLPreElement>;
}>) {
  const nodes = useMemo(() => highlightedSource(editorHighlightLanguage(path), text), [path, text]);
  return <pre class="code-highlight" data-wrap={wrap ? "on" : "off"} aria-hidden="true" ref={layer}>{nodes}</pre>;
}

/**
 * Concatenating the emitted text must reproduce the buffer exactly, or the
 * painted line and the line the caret is on stop being the same line.
 *
 * Two places where that is easy to get wrong are handled here. A buffer longer
 * than the scanner's bound yields spans only over its prefix, so the tail is
 * appended verbatim rather than dropped. And a buffer ending in a newline
 * gets one trailing space: a textarea reserves a line box for the empty final
 * line and a `<pre>` does not, which would leave the last visible row of a
 * file painted one row too high.
 */
export function highlightedSource(language: string | undefined, text: string): ComponentChildren {
  const body = text.endsWith("\n") ? `${text} ` : text;
  const spans = highlightSpans(language, body);
  if (spans.length === 0) return body;
  const nodes: ComponentChildren[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) nodes.push(body.slice(cursor, span.start));
    nodes.push(<span class={`tok-${span.kind}`}>{body.slice(span.start, span.end)}</span>);
    cursor = span.end;
  }
  if (cursor < body.length) nodes.push(body.slice(cursor));
  return nodes as VNode[];
}
