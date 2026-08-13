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

/*
 * `rename` is what carries a turn's stream from the client id its row was
 * created under to the journal's `message:<turnId>:assistant`, which is the id
 * the row comes back as when the conversation is re-opened mid-turn. Get this
 * wrong and the answer streams into a slot nothing on screen reads.
 */
describe("re-addressing a slot to the journal's id", () => {
  it("carries the content and wakes both ends", () => {
    const store = new TranscriptStreamStore();
    const from = vi.fn();
    const to = vi.fn();
    store.append("optimistic", "half an answer");
    store.subscribe("optimistic", from);
    store.subscribe("message:turn-1:assistant", to);

    store.rename("optimistic", "message:turn-1:assistant");

    expect(store.read("message:turn-1:assistant")).toBe("half an answer");
    expect(store.read("optimistic")).toBe("");
    // The old slot has to hear about it too: its subscriber is still mounted
    // for the commit that re-keys the row, and would otherwise keep painting
    // text the store no longer holds.
    expect(from).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledTimes(1);
  });

  it("appends onto the destination rather than dropping either side", () => {
    const store = new TranscriptStreamStore();
    store.append("optimistic", "second");
    store.append("message:turn-1:assistant", "first ");
    store.rename("optimistic", "message:turn-1:assistant");
    expect(store.read("message:turn-1:assistant")).toBe("first second");
  });

  it("is inert when there is nothing to move, or nowhere to move it", () => {
    const store = new TranscriptStreamStore();
    const listener = vi.fn();
    store.subscribe("message:turn-1:assistant", listener);
    // No such source slot: the turn streamed nothing before its id landed,
    // which is the ordinary case.
    store.rename("optimistic", "message:turn-1:assistant");
    expect(store.read("message:turn-1:assistant")).toBe("");
    expect(listener).not.toHaveBeenCalled();
    // Same id both ends is a no-op, not a self-append.
    store.append("message:turn-1:assistant", "answer");
    store.rename("message:turn-1:assistant", "message:turn-1:assistant");
    expect(store.read("message:turn-1:assistant")).toBe("answer");
  });
});

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

describe("the stream is not a live region, and announces nothing itself", () => {
  /*
   * `aria-live="polite"` on the streaming container turned every text delta
   * into a queued screen-reader utterance: a fast stream left the reader
   * minutes behind, narrating half-written sentences over everything else on
   * the page. Removing it was right; the settle-time region that replaced it
   * was written here, per message, and could only ever quote the stream buffer
   * — empty on the demo provider and every non-streaming path, which is why the
   * promised excerpt was never spoken on the journey every cold visitor takes.
   * `turn-narration.ts` owns the whole lifecycle now, from the settled body, so
   * what is pinned here is that this slot carries no announcement at all.
   */
  // Comments are stripped first — this repo's prose names the very attribute it
  // constrains (`terminalViewCode()` in `terminal-view.test.ts` sets the
  // precedent), and the explanation must not become the violation.
  const codeOnly = (text: string) => text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, "")
    .replace(/(^|\s)\/\/[^\n]*/gu, "$1");

  it("keeps aria-live off both streaming containers", async () => {
    const slot = codeOnly(await streamingSlotSource());
    const streamingCard = slot.slice(slot.indexOf('class="message-part text text--answer streaming"'));
    expect(streamingCard.slice(0, streamingCard.indexOf("</div>"))).not.toContain("aria-live");
    // The announcement that replaced the dwelling dots stays put.
    expect(slot).toContain('aria-label="Airship is composing a reply"');
    const tail = codeOnly(await readFile(new URL("./message-parts-view.tsx", import.meta.url), "utf8"));
    const streaming = tail.slice(tail.indexOf("text--answer streaming"));
    expect(streaming.slice(0, streaming.indexOf("<MarkdownView"))).not.toContain("aria-live");
  });

  it("carries no live region of its own, so the lifecycle has exactly one speaker", async () => {
    const slot = codeOnly(await streamingSlotSource());
    expect(slot.match(/aria-live=/gu) ?? []).toHaveLength(0);
    // The per-message arrival region and everything that fed it are gone, not
    // merely quiet: two of them mutated in the same frame as the shell's status
    // mirror at settle time.
    expect(slot).not.toContain("arrivalAnnouncement");
    expect(slot).not.toContain("setArrival");
  });

  it("still mounts from turn start, because a card that appears with its text is announced by nothing", async () => {
    const slot = codeOnly(await streamingSlotSource());
    expect(slot).toContain("if (!streamedThisMount.current) return null;");
    expect(slot).toContain("if (active) streamedThisMount.current = true;");
  });
});
