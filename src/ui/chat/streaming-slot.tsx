import { useEffect, useRef, useState } from "preact/hooks";
import { IncrementalMarkdownView } from "./markdown";

type Listener = () => void;

/**
 * Per-message external stream slots. Appending one delta notifies only that
 * message's subscribers; the transcript array and sibling cards stay inert.
 */
export class TranscriptStreamStore {
  readonly #values = new Map<string, string>();
  readonly #listeners = new Map<string, Set<Listener>>();

  read(messageId: string): string { return this.#values.get(messageId) ?? ""; }

  append(messageId: string, text: string): void {
    if (!text) return;
    this.#values.set(messageId, this.read(messageId) + text);
    for (const listener of this.#listeners.get(messageId) ?? []) listener();
  }

  take(messageId: string): string {
    const value = this.read(messageId);
    this.clear(messageId);
    return value;
  }

  clear(messageId: string): void {
    if (!this.#values.delete(messageId)) return;
    for (const listener of this.#listeners.get(messageId) ?? []) listener();
  }

  subscribe(messageId: string, listener: Listener): () => void {
    const listeners = this.#listeners.get(messageId) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(messageId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(messageId);
    };
  }
}

/**
 * How long the settled turn's one-shot announcement stays in the DOM.
 *
 * Long enough for a polite region to be reached even behind a queued
 * utterance, short enough that the sentence is not still sitting in the
 * transcript as stray text when the reader arrows back through it later.
 */
const ARRIVAL_ANNOUNCEMENT_MS = 8_000;

/** The longest arrival announcement, before the ellipsis. */
const ARRIVAL_EXCERPT_CHARS = 200;

/**
 * What the reader hears when the turn settles.
 *
 * Deliberately outcome-neutral. This component cannot see a failure — a failed
 * turn clears `status` exactly like a successful one and puts its sentence in
 * the card — so it states the one thing it knows ("the turn ended") and then
 * hands over the words that actually landed. Claiming "reply complete" on a
 * turn that failed mid-stream would be the same class of defect as the topbar
 * announcing "Local kernel ready" and calling that an answer.
 */
export function arrivalAnnouncement(streamed: string): string {
  const prose = streamed
    // Markdown syntax is punctuation to a speech synthesiser: heading hashes,
    // emphasis runs and fences get read out or swallow the word after them.
    .replace(/```[^\n]*\n?/gu, " ")
    .replace(/[`*_>#|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!prose) return "Airship’s turn ended.";
  if (prose.length <= ARRIVAL_EXCERPT_CHARS) return `Airship’s turn ended. ${prose}`;
  const cut = prose.slice(0, ARRIVAL_EXCERPT_CHARS);
  const boundary = cut.lastIndexOf(" ");
  return `Airship’s turn ended. ${(boundary > ARRIVAL_EXCERPT_CHARS / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

export function StreamingMessageSlot({ store, messageId, active }: {
  store: TranscriptStreamStore;
  messageId: string;
  active: boolean;
}) {
  const [content, setContent] = useState(() => store.read(messageId));
  const [arrival, setArrival] = useState("");
  // The last text this message actually streamed. `content` is emptied when the
  // store is drained at settle time, which is the same commit the announcement
  // has to quote, so the words are held here instead of read back out.
  const streamed = useRef("");
  if (content) streamed.current = content;
  // Monotone, and mutated in render on purpose: it decides whether the live
  // region is in the DOM *before* the settle commit, and an effect would set it
  // one commit too late. A region inserted at the same moment as its text is
  // not reliably announced, so the region is mounted from turn start and only
  // its text changes.
  const streamedThisMount = useRef(false);
  if (active) streamedThisMount.current = true;

  useEffect(() => {
    setContent(store.read(messageId));
    return store.subscribe(messageId, () => setContent(store.read(messageId)));
  }, [messageId, store]);

  useEffect(() => {
    if (active) {
      setArrival("");
      return;
    }
    // A message that was never live in this mount is history, not an arrival.
    if (!streamedThisMount.current) return;
    setArrival(arrivalAnnouncement(streamed.current));
    const timer = window.setTimeout(() => setArrival(""), ARRIVAL_ANNOUNCEMENT_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!streamedThisMount.current) return null;

  return (
    <>
      {/*
        The turn's only arrival announcement.
        Turn start is announced by the composing block below; before this
        region existed, nothing announced that the answer had landed — the
        closest thing was the topbar runtime line saying "Local kernel ready",
        a sentence about the kernel that carries none of the reply. One polite
        utterance at settle time is the whole point: it replaces the per-token
        `aria-live` this slot used to carry, which queued one utterance per
        delta and left the reader minutes behind a fast stream.
      */}
      {/* A span, not a paragraph: `.message-body p` would style it, and the one
          element in the transcript that exists only to be spoken should not
          inherit the transcript's typography. */}
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{arrival}</span>
      {active ? content ? (
        // `text--answer` states what this part is, the same way the settled tail
        // in `message-parts-view.tsx` does. In-flight prose is the answer, not
        // the narration between steps, and the two render at different weights.
        //
        // Deliberately NOT a live region itself: every text delta mutating a
        // polite region is one queued screen-reader utterance per token.
        <div class="message-part text text--answer streaming"><IncrementalMarkdownView source={content} /></div>
      ) : (
        <div class="message-thinking" role="status" aria-label="Airship is composing a reply">
          <span class="message-thinking__dot" />
          <span class="message-thinking__dot" />
          <span class="message-thinking__dot" />
        </div>
      ) : null}
    </>
  );
}
