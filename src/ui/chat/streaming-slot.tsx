import { useEffect, useRef, useState } from "preact/hooks";
import { IncrementalMarkdownView } from "./markdown";
import { useReasoningVisibility } from "./reasoning-visibility";

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

  /**
   * Re-address a slot, keeping whatever it already holds.
   *
   * A turn's rows are created optimistically under a client-minted id, before
   * the journal has issued the turn one. From `turn.requested` onward the
   * journal's id is the row's real address — it is what `presentSessionMessages`
   * rebuilds the row under when the conversation is re-opened — so the slot
   * has to move with it or the stream is filed under a name nothing looks up
   * again. Appends onto the destination rather than replacing it: the
   * destination is normally empty, and silently dropping buffered text would
   * be the same defect one layer down.
   */
  rename(from: string, to: string): void {
    if (from === to) return;
    const value = this.#values.get(from);
    if (value === undefined) return;
    this.#values.delete(from);
    this.#values.set(to, this.read(to) + value);
    for (const listener of this.#listeners.get(from) ?? []) listener();
    for (const listener of this.#listeners.get(to) ?? []) listener();
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

/** One message's slot value, re-read on every append to that message alone. */
export function useTranscriptStream(store: TranscriptStreamStore, messageId: string): string {
  const [content, setContent] = useState(() => store.read(messageId));
  useEffect(() => {
    setContent(store.read(messageId));
    return store.subscribe(messageId, () => setContent(store.read(messageId)));
  }, [messageId, store]);
  return content;
}

/**
 * Whether a slot has taken its first byte — the question the reasoning fold
 * asks of the *answer* stream. Deliberately not `useTranscriptStream`: this
 * flips once and then holds, so a subscriber asking only this re-renders on
 * the delta that starts the answer rather than on every delta after it.
 */
function useStreamStarted(store: TranscriptStreamStore, messageId: string): boolean {
  const [started, setStarted] = useState(() => store.read(messageId).length > 0);
  useEffect(() => {
    const sync = () => setStarted(store.read(messageId).length > 0);
    sync();
    return store.subscribe(messageId, sync);
  }, [messageId, store]);
  return started;
}

export function StreamingMessageSlot({ store, messageId, active }: {
  store: TranscriptStreamStore;
  messageId: string;
  active: boolean;
}) {
  const content = useTranscriptStream(store, messageId);
  // Monotone, and mutated in render on purpose: it decides whether this slot is
  // in the DOM before the settle commit, one commit earlier than an effect
  // could.
  const streamedThisMount = useRef(false);
  if (active) streamedThisMount.current = true;

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

/** Pinned to the tail while it streams, free to be scrolled once it is not. */
function ReasoningText({ text, follow }: { text: string; follow: boolean }) {
  const node = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!follow) return;
    const element = node.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [text, follow]);
  return <pre ref={node} class="reasoning-aside__body">{text}</pre>;
}

/**
 * The live reasoning slot: what the provider is exposing *while it thinks*.
 *
 * Reasoning that appears only once the turn settles is reasoning nobody was
 * waiting on — the wait is exactly when it is worth reading. So this slot is
 * open while reasoning is the only thing arriving, and folds to its headline
 * the moment the answer or a tool call starts, which is the moment reasoning
 * stops being the thing you are waiting for. It never folds to *nothing*: the
 * row keeps a summary line that opens on demand, and an explicit toggle by the
 * reader outranks the automatic fold for the rest of that row's turn.
 *
 * The Profile's `reasoningVisibility` is read as the *fold* preference and
 * never as a hide — "expanded" keeps the whole text open once the answer
 * lands, "collapsed" folds it to the headline. Neither setting can take the
 * block off the row, and neither is consulted while it is still streaming.
 *
 * The settled counterpart is the `reasoning-summary` part in
 * `message-parts-view.tsx`, projected from the durable `turn.reasoning`
 * record. This slot clears when the turn does, so exactly one of the two is
 * ever on the row.
 */
export function StreamingReasoningSlot({ store, answerStore, messageId, active, settled }: {
  store: TranscriptStreamStore;
  /** The answer stream, asked only whether it has begun. */
  answerStore: TranscriptStreamStore;
  messageId: string;
  active: boolean;
  /** Durable parts have begun landing on this row — a tool call, or the answer. */
  settled: boolean;
}) {
  const text = useTranscriptStream(store, messageId);
  const answerStarted = useStreamStarted(answerStore, messageId);
  const visibility = useReasoningVisibility();
  const [readerOpen, setReaderOpen] = useState<boolean>();
  // A new row is a new turn's reasoning: the previous turn's manual fold is
  // not allowed to decide this one's.
  useEffect(() => { setReaderOpen(undefined); }, [messageId]);

  if (!text) return null;
  const folded = (answerStarted || settled) && visibility !== "expanded";
  const open = readerOpen ?? !folded;
  const streaming = active && !folded;
  return (
    <details
      class={streaming ? "reasoning-aside reasoning-aside--streaming" : "reasoning-aside"}
      open={open}
      onToggle={(event) => setReaderOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      {/*
        One line, and deliberately not the four-column grid the settled part's
        summary used to be. That grid gave column 3 to both a `<small>` and the
        `::after` marker, and `<small>` inside a summary is in the shell's
        uppercase-eyebrow list — so a whole sentence of reasoning headline
        rendered as a three-line block of uppercase mono sitting on top of the
        word "Reasoning". A label and a short measure are all this row needs;
        the reasoning itself is one line below it.
        Not a live region: one utterance per delta is unusable, and the turn's
        arrival is already narrated by `chat/turn-narration.ts`.
      */}
      <summary>
        <span class="reasoning-aside__label">Thought process</span>
        <span class="reasoning-aside__meta">
          {streaming ? "live" : `${text.length.toLocaleString()} characters`}
        </span>
      </summary>
      <ReasoningText text={text} follow={streaming} />
    </details>
  );
}
