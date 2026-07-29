import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { TranscriptStreamStore } from "./streaming-slot";

/**
 * The class of bug this file exists to stop hiding.
 *
 * `chat.css` styled the caret as `.message-parts .message-part.text.streaming`
 * for a year while `StreamingMessageSlot` rendered `.message-part.text
 * .streaming` as a root element. Both halves read correct in isolation; the
 * rule simply never matched, so the product's only in-flight indicator was
 * never once painted. A selector whose correctness depends on markup in another
 * file is only assertable by reading both, which is what these two tests do.
 */
async function chatStyles(): Promise<string> {
  return readFile(new URL("../chat.css", import.meta.url), "utf8");
}

async function streamingSlotSource(): Promise<string> {
  return readFile(new URL("./streaming-slot.tsx", import.meta.url), "utf8");
}

describe("isolated transcript stream slots", () => {
  it("notifies only the in-flight message subscriber", () => {
    const store = new TranscriptStreamStore();
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe("first", first);
    store.subscribe("second", second);
    store.append("second", "token");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(store.read("second")).toBe("token");
  });

  it("atomically drains partial output for terminal recovery", () => {
    const store = new TranscriptStreamStore();
    store.append("turn", "partial");
    expect(store.take("turn")).toBe("partial");
    expect(store.read("turn")).toBe("");
  });
});

describe("the streaming caret", () => {
  it("is selected without an ancestor, because the slot renders no ancestor", async () => {
    const styles = await chatStyles();
    const selectors = [...styles.matchAll(/^([^\n{}]*)\.message-part\.text\.streaming::after\s*\{/gmu)];
    expect(selectors.length, "the caret rule must exist in chat.css").toBeGreaterThan(0);
    // Everything before `.message-part` on each winning selector must be empty:
    // a descendant, child or sibling combinator here is the whole bug.
    expect(selectors.map((match) => match[1]?.trim() ?? "")).toEqual(selectors.map(() => ""));
  });

  it("renders the class the caret rule names, as the slot's own root", async () => {
    const source = await streamingSlotSource();
    // `text--answer` rides along because in-flight prose is the answer; the
    // three classes the caret rule names are what this assertion is about.
    expect(source).toContain('class="message-part text text--answer streaming"');
  });

  it("keeps the caret painted with the blink removed under reduced motion", async () => {
    const styles = await chatStyles();
    const reduced = styles.slice(styles.indexOf("@keyframes stream-caret"));
    expect(reduced).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.message-part\.text\.streaming::after \{ animation: none; \}/u,
    );
    // `display: none` would remove the mark rather than the movement.
    expect(reduced).not.toMatch(/\.message-part\.text\.streaming::after \{ display: none/u);
  });
});
