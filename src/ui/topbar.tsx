import { Seal, type SealState } from "./seal";
import { worstTrustAxis, trustAxesInScope, type TrustAxis } from "./platform-shell";

/**
 * The topbar's whole posture, in one chip, at every width.
 *
 * The centre band used to render one pill per axis — four of them, 398px, with
 * the fourth truncated to `Secure hardware not c…` on a laptop and the whole
 * band replaced by a different component on a phone. A truncated claim is worse
 * than a disclosed one, and two components for one fact is how the vocabulary
 * fragmented in the first place.
 *
 * So: the weakest axis states itself in full, the count states how many claims
 * are behind it, and one tap opens the sheet where all of them are rendered
 * verbatim. `TrustPostureSheet` has always said "The weakest claim is shown in
 * the topbar"; this is the first build where that sentence is true on desktop.
 *
 * What this build adds is the *scope* rule. The chip now speaks only for the
 * claims that are true of this browser tab. It used to speak for all four axes,
 * which meant a turn whose endpoint evidence could not be fetched rendered
 * "Evidence unavailable" here and "Evidence unavailable · this session" in the
 * session bar 40px below — the same fact, in two bands, in two sentences, and
 * the topbar's copy silently dropped the scope word that made it true. The
 * conversation's own claims did not move out of reach: they are stated at rest
 * in the session bar, in full in the sheet this chip opens, and by count in the
 * chip's accessible name — and if one of them is failing, a trailing clause
 * says so here, because the routes with no session bar would otherwise leave
 * this chip looking healthy while a claim behind it was not.
 */
export function TopbarPostureChip({
  axes,
  onOpen,
}: Readonly<{ axes: readonly TrustAxis[]; onOpen(): void }>) {
  const tabAxes = trustAxesInScope(axes, "tab");
  const conversationAxes = trustAxesInScope(axes, "conversation");
  // Falls back to the whole set rather than rendering nothing: a build that
  // stopped tagging scopes must lose the partition, never the posture.
  const worst = worstTrustAxis(tabAxes.length > 0 ? tabAxes : axes) ?? axes[0];
  if (!worst) return null;
  const elsewhere = conversationAxesNote(conversationAxes);
  return (
    <button
      class="topbar-posture-chip"
      type="button"
      data-state={worst.state}
      // The count is honest about its own cost: a chip standing in front of
      // four claims says four, so the affordance never understates what it
      // hides — including the two it defers to another band rather than states.
      aria-label={`Runtime trust for this browser tab. Weakest claim: ${worst.label}. ${worst.detail} ${String(axes.length)} axes.${elsewhere ? ` ${elsewhere.spoken}` : ""}`}
      onClick={onOpen}
    >
      {/* The label is never shortened here. §5.1 sketches a 14-character cap,
          but `Browser / Edge runtime` is 22 and is the resting claim on every
          disconnected tab — clipping it would reintroduce the exact defect the
          band collapse exists to remove. The count is what buys the width back. */}
      <Seal state={worst.state} acting={worst.state === "checking"} label={worst.label} detail={worst.detail} size={16} />
      <small class="topbar-posture-chip__count">{axes.length} axes</small>
      {elsewhere?.text ? (
        // Never a second verdict, always a pointer with a count — and only when
        // a deferred claim is actually alarming. A reference that stays silent
        // through a failure is a burial; one that shouts on every healthy turn
        // stops being read, and the healthy case is already carried by the
        // `4 axes` count, the accessible name and the sheet's own grouping.
        <span class="topbar-posture-chip__elsewhere" data-state={elsewhere.state}>
          <Seal state={elsewhere.state} density="dot" size={16} label={elsewhere.sealLabel} />
          {elsewhere.text}
        </span>
      ) : null}
    </button>
  );
}

export type ConversationAxesNote = Readonly<{
  /** `none` whenever nothing deferred is alarming; the reference stays quiet. */
  state: SealState;
  /**
   * The visible clause, present only when a deferred claim is alarming.
   *
   * Always a count and a destination, never a claim: the words belong to the
   * session bar and restating them here would be the duplication this package
   * removes. Absent in the healthy case, where `4 axes` and `spoken` already
   * account for every claim behind the chip.
   */
  text?: string;
  /** The seal's own word, so colour is never the sole carrier of the alarm. */
  sealLabel: string;
  /** The same fact for the chip's accessible name, as a sentence. Always present. */
  spoken: string;
}>;

/**
 * The clause that points at the band which owns the conversation's claims.
 *
 * It states a number and a place, never a verdict: the session bar 40px below
 * is where the words are. The one thing it does raise is an alarm — a `failed`
 * or `attention` axis is escalated, and escalated visibly, because the routes
 * that have no session bar would otherwise leave the topbar looking healthy
 * while a claim behind it was not.
 */
export function conversationAxesNote(axes: readonly TrustAxis[]): ConversationAxesNote | undefined {
  if (axes.length === 0) return undefined;
  const failed = axes.filter((axis) => axis.state === "failed");
  const attention = axes.filter((axis) => axis.state === "attention");
  const alarming = failed.length > 0 ? failed : attention;
  if (alarming.length === 0) {
    return Object.freeze({
      state: "none" as const,
      sealLabel: "Not alarming",
      spoken: `${String(axes.length)} of them are scoped to this conversation and are stated in the session bar.`,
    });
  }
  const state: SealState = failed.length > 0 ? "failed" : "attention";
  const word = failed.length > 0 ? "failed" : "needs attention";
  return Object.freeze({
    state,
    text: `${String(alarming.length)} of ${String(axes.length)} in this conversation ${word}`,
    sealLabel: failed.length > 0 ? "Failed" : "Attention",
    spoken: `${String(alarming.length)} of ${String(axes.length)} claims scoped to this conversation ${word}. They are stated in the session bar and in this sheet.`,
  });
}
