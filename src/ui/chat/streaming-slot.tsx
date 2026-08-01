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

export function StreamingMessageSlot({ store, messageId, active }: {
  store: TranscriptStreamStore;
  messageId: string;
  active: boolean;
}) {
  const [content, setContent] = useState(() => store.read(messageId));
  // Monotone, and mutated in render on purpose: it decides whether this slot is
  // in the DOM before the settle commit, one commit earlier than an effect
  // could.
  const streamedThisMount = useRef(false);
  if (active) streamedThisMount.current = true;

  useEffect(() => {
    setContent(store.read(messageId));
    return store.subscribe(messageId, () => setContent(store.read(messageId)));
  }, [messageId, store]);

  if (!streamedThisMount.current) return null;

  return (
    <>
      {/*
        No announcement lives here any more. This slot could only ever quote the
        stream buffer, which the demo provider and every non-streaming path
        leave empty, so the promised excerpt was blank on the default path every
        cold visitor takes; and a per-message region mounted and unmounted with
        its turn is what let the settle sentence race the shell's status mirror.
        `chat/turn-narration.ts` owns the whole lifecycle now and is fed the
        settled message body.
      */}
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
