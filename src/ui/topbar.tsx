import { Seal } from "./seal";
import { worstTrustAxis, type TrustAxis } from "./platform-shell";

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
 */
export function TopbarPostureChip({
  axes,
  onOpen,
}: Readonly<{ axes: readonly TrustAxis[]; onOpen(): void }>) {
  const worst = worstTrustAxis(axes) ?? axes[0];
  if (!worst) return null;
  return (
    <button
      class="topbar-posture-chip"
      type="button"
      data-state={worst.state}
      // The count is honest about its own cost: a chip standing in front of
      // four claims says four, so the affordance never understates what it hides.
      aria-label={`Runtime trust. Weakest claim: ${worst.label}. ${worst.detail} ${String(axes.length)} axes.`}
      onClick={onOpen}
    >
      {/* The label is never shortened here. §5.1 sketches a 14-character cap,
          but `Browser / Edge runtime` is 22 and is the resting claim on every
          disconnected tab — clipping it would reintroduce the exact defect the
          band collapse exists to remove. The count is what buys the width back. */}
      <Seal state={worst.state} acting={worst.state === "checking"} label={worst.label} detail={worst.detail} size={16} />
      <small class="topbar-posture-chip__count">{axes.length} axes</small>
    </button>
  );
}
