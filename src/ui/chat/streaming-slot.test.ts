import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { arrivalAnnouncement, TranscriptStreamStore } from "./streaming-slot";

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

describe("the stream is not a live region, and the settled turn is announced once", () => {
  /*
   * `aria-live="polite"` on the streaming container turned every text delta
   * into a queued screen-reader utterance: a fast stream left the reader
   * minutes behind, narrating half-written sentences over everything else on
   * the page. Removing it was right; removing it and putting nothing at settle
   * time was not — turn start was still announced ("Airship is composing a
   * reply") and arrival was announced by nothing at all, leaving the topbar's
   * "Local kernel ready" as the only signal a reply had landed. So both halves
   * are pinned here: no live region on either streaming container, and exactly
   * one settle-time region that carries the words.
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

  it("carries exactly one polite region, sr-only and fed only at settle time", async () => {
    const slot = codeOnly(await streamingSlotSource());
    expect(slot.match(/aria-live=/gu) ?? []).toHaveLength(1);
    expect(slot).toContain('<span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{arrival}</span>');
    // `arrival` is written in exactly two places: the settle branch, and the
    // resets (turn start, and the timer that retires the sentence). Anything
    // that wrote it from the delta subscription would be the old defect back.
    expect(slot).toContain("setArrival(arrivalAnnouncement(streamed.current));");
    expect(slot).toMatch(/if \(active\) \{\s*setArrival\(""\);/u);
    expect(slot).toContain('setTimeout(() => setArrival(""), ARRIVAL_ANNOUNCEMENT_MS)');
    expect(slot).not.toMatch(/subscribe\([^)]*\)[^;]*setArrival/u);
  });

  it("mounts the region before the settle commit, because a region inserted with its text is not reliably read", async () => {
    const slot = codeOnly(await streamingSlotSource());
    // The gate on rendering anything is "was this message ever live in this
    // mount", not "is it live now": if it were `active`, the region would
    // unmount in the same commit that ends the turn and remount with the
    // sentence already in it, which several screen readers do not announce.
    expect(slot).toContain("if (!streamedThisMount.current) return null;");
    expect(slot).toContain("if (active) streamedThisMount.current = true;");
  });

  it("says the turn ended and quotes what landed, without claiming success", () => {
    // The slot cannot see a failed turn — `status` is cleared either way — so
    // the sentence may not assert one. It states the event and hands over the
    // words; the card and the runtime line carry the disposition.
    expect(arrivalAnnouncement("The three files are listed below."))
      .toBe("Airship’s turn ended. The three files are listed below.");
    expect(arrivalAnnouncement("")).toBe("Airship’s turn ended.");
    expect(arrivalAnnouncement("   \n  ")).toBe("Airship’s turn ended.");
    // Markdown is punctuation to a synthesiser, and a heading hash or a fence
    // gets read out loud or swallows the word after it.
    expect(arrivalAnnouncement("## Result\n\n`ok` and **done**"))
      .toBe("Airship’s turn ended. Result ok and done");
    expect(arrivalAnnouncement("```ts\nconst x = 1;\n```"))
      .toBe("Airship’s turn ended. const x = 1;");
  });

  it("truncates a long reply at a word boundary instead of speaking the whole answer", () => {
    const long = `${"alpha ".repeat(60)}omega`;
    const spoken = arrivalAnnouncement(long);
    expect(spoken.endsWith("…")).toBe(true);
    expect(spoken).not.toContain("omega");
    // The excerpt is bounded, and the break is not mid-word.
    const excerpt = spoken.replace("Airship’s turn ended. ", "").replace("…", "");
    expect(excerpt.length).toBeLessThanOrEqual(200);
    expect(excerpt.endsWith("alpha")).toBe(true);
  });
});
