import { useEffect, useState } from "preact/hooks";
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
  useEffect(() => {
    setContent(store.read(messageId));
    return store.subscribe(messageId, () => setContent(store.read(messageId)));
  }, [messageId, store]);
  if (!active) return null;
  if (!content) {
    return (
      <div class="message-thinking" role="status" aria-label="Airship is composing a reply">
        <span class="message-thinking__dot" />
        <span class="message-thinking__dot" />
        <span class="message-thinking__dot" />
      </div>
    );
  }
  return <div class="message-part text streaming" aria-live="polite"><IncrementalMarkdownView source={content} /></div>;
}
