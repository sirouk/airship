import { useEffect, useRef, useState } from "preact/hooks";

/**
 * The turn's spoken channel: one owner, one vocabulary, one region.
 *
 * Measured on the shipped build, a whole turn spoke three sentences and none of
 * them was the answer: `t=68ms "Persisting turn intent"` (a storage operation),
 * then 1.5 s of silence, then — in the *same animation frame* — `t=1597ms
 * "Local kernel ready"` from the shell's status mirror and `t=1597ms "Airship’s
 * turn ended."` from the per-message arrival region. Two polite regions
 * mutating in one frame is the exact race the arrival region was written to
 * end, and the excerpt it promised was empty because it quoted the streaming
 * buffer, which the demo and every non-streaming provider never fill. The local
 * command lane was mute in both directions: `/help` and `/nonsense-command`
 * each announced nothing at all, so a screen-reader user could not tell a
 * completed command from a rejected one.
 *
 * So turn news is not a side effect of whatever component happens to re-render.
 * Every lifecycle utterance — working, arrived, failed, command finished,
 * command refused — is minted here, serialised through one region with a
 * minimum dwell, and sourced from the settled message body rather than from a
 * buffer that may never have existed.
 */

/**
 * The longest excerpt spoken after a lifecycle sentence, before the ellipsis.
 *
 * Enough to know what landed, short enough that a reader can interrupt and go
 * read the transcript, which holds the whole thing.
 */
export const NARRATION_EXCERPT_CHARS = 200;

/**
 * The floor between two utterances in this channel.
 *
 * A polite region that changes twice inside one frame drops one of the two, and
 * which one it drops is the screen reader's choice, not ours. Instant lanes hit
 * this: a local command can start and finish inside 30 ms.
 */
export const TURN_NARRATION_DWELL_MS = 900;

/**
 * How long the shell's ambient runtime line stays out of the polite channel
 * after this one speaks.
 *
 * "Airship is ready on this device" is telemetry about the runtime, not news
 * about the turn, and it is set at the same instant the turn settles. It still
 * paints in the topbar — a sighted user keeps it — it simply stops competing
 * for the announcement the person is actually waiting for.
 */
export const TURN_NARRATION_HOLD_MS = 2_500;

/**
 * How long a settled utterance stays in the DOM.
 *
 * Long enough to be reached behind a queued utterance, short enough that it is
 * not still sitting there as stray text when the reader arrows back later.
 */
export const NARRATION_RETENTION_MS = 8_000;

/**
 * Markdown is punctuation to a speech synthesiser: heading hashes, emphasis
 * runs and fences get read out or swallow the word after them.
 */
export function spokenExcerpt(body: string, limit = NARRATION_EXCERPT_CHARS): string {
  const prose = body
    .replace(/```[^\n]*\n?/gu, " ")
    .replace(/[`*_>#|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (prose.length <= limit) return prose;
  const cut = prose.slice(0, limit);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > limit / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * What the reader hears when the turn settles.
 *
 * Deliberately outcome-neutral: a turn that ends having said something is not
 * necessarily a turn that succeeded, and this sentence is spoken from the same
 * place on both paths. It states the one thing it knows and then hands over the
 * words that actually landed — which is why it is fed the settled body, not a
 * stream buffer.
 */
export function arrivalAnnouncement(body: string): string {
  const prose = spokenExcerpt(body);
  return prose ? `Airship’s turn ended. ${prose}` : "Airship’s turn ended.";
}

/**
 * The in-flight sentence, which has to name two things the old channel named
 * neither of: that the model is working, and that there is a way out.
 *
 * The stop control is only named when it is actually mounted — the composer
 * swaps Send for Stop while a turn is in flight — because an announced escape
 * hatch that is not in the tab order is worse than silence.
 */
export function workingAnnouncement(stoppable: boolean): string {
  return stoppable
    ? "Airship is answering. Stop turn is in the composer."
    : "Airship is answering.";
}

/** A turn that ended badly, in the words the card shows. */
export function failureAnnouncement(reason: string): string {
  const prose = spokenExcerpt(reason);
  return prose ? `Turn failed. ${prose}` : "Turn failed.";
}

/** A turn the person stopped, distinguished from one that failed on its own. */
export function stoppedAnnouncement(): string {
  return "Turn stopped. What had arrived is kept.";
}

export type LocalCommandOutcome = "completed" | "failed" | "denied" | "stopped";

const LOCAL_COMMAND_VERB: Readonly<Record<LocalCommandOutcome, string>> = Object.freeze({
  completed: "completed",
  failed: "failed",
  denied: "was denied",
  stopped: "was stopped",
});

/**
 * The local-command lane, which announced nothing at all in either direction.
 *
 * The command is named because this lane routinely runs several in a row, and
 * the detail is the sentence already written into the transcript, so audible
 * audible feedback and the durable record describe the same outcome.
 */
export function localCommandAnnouncement(
  command: string,
  outcome: LocalCommandOutcome,
  detail: string,
): string {
  const head = `Command /${command} ${LOCAL_COMMAND_VERB[outcome]}.`;
  const prose = spokenExcerpt(detail);
  return prose ? `${head} ${prose}` : head;
}

/**
 * The command a typed source line invoked, for the sentence that reports it.
 *
 * Bare of arguments: a `/write notes/x.md <body>` line can be a paragraph long,
 * and the body is already in the transcript and in the detail clause.
 */
export function spokenCommandName(source: string): string {
  return source.trim().replace(/^\//u, "").split(/\s+/u)[0] ?? "";
}

/** Zero-width, so a repeated utterance is a new string and the same sentence. */
const REPEAT_MARK = "\u200B";

function stripRepeatMark(value: string): string {
  return value.endsWith(REPEAT_MARK) ? value.slice(0, -REPEAT_MARK.length) : value;
}

export type TurnNarration = Readonly<{
  /** The text currently in the live region. */
  spoken: string;
  /** Speak one lifecycle sentence. Serialised against the previous one. */
  narrate: (utterance: string) => void;
  /**
   * True while this channel owns the polite lane, so the shell's ambient
   * runtime mirror can stand down instead of racing it.
   */
  holdsChannel: () => boolean;
}>;

/**
 * One region, fed serially.
 *
 * `pending` is what the product wants said; `spoken` is what the region holds.
 * They differ only while the dwell floor is being honoured, which is the whole
 * mechanism: two sentences produced in one frame are still two utterances.
 */
export function useTurnNarration(dwellMs = TURN_NARRATION_DWELL_MS): TurnNarration {
  const [pending, setPending] = useState("");
  const [spoken, setSpoken] = useState("");
  const spokenAt = useRef(0);
  const heldUntil = useRef(0);

  useEffect(() => {
    if (pending === spoken) return;
    const publish = () => {
      spokenAt.current = Date.now();
      setSpoken(pending);
    };
    const waited = Date.now() - spokenAt.current;
    if (waited >= dwellMs) {
      publish();
      return;
    }
    const timer = window.setTimeout(publish, dwellMs - waited);
    return () => window.clearTimeout(timer);
  }, [pending, spoken, dwellMs]);

  // Retire the sentence rather than leaving it in the DOM for a browse-mode
  // reader to meet again as stray text minutes later.
  useEffect(() => {
    if (!spoken) return;
    const timer = window.setTimeout(() => setPending((current) => (current === spoken ? "" : current)), NARRATION_RETENTION_MS);
    return () => window.clearTimeout(timer);
  }, [spoken]);

  return {
    spoken,
    narrate: (utterance: string) => {
      heldUntil.current = Date.now() + TURN_NARRATION_HOLD_MS;
      // A region only announces when its text *changes*, and the case that
      // matters most is a repeat: the same command failing the same way twice
      // is precisely when the reader has to hear it the second time. The
      // zero-width mark makes the string different without changing a word of
      // what is read.
      setPending((current) => (
        stripRepeatMark(current) === utterance
          ? (current.endsWith(REPEAT_MARK) ? utterance : `${utterance}${REPEAT_MARK}`)
          : utterance
      ));
    },
    holdsChannel: () => Date.now() < heldUntil.current,
  };
}
