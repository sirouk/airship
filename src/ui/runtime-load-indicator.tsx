import type { SessionActivityReport } from "../capabilities/runtime-load";
import { densityAllows, usePresentationDensity } from "./density";
import "./runtime-load-indicator.css";

/**
 * Where the reading is mounted. Both placements render the same element and the
 * same words; only the box differs, because the desktop rail and the phone tab
 * bar are the two bands the shell renders on every route at their own width.
 */
export type RuntimeLoadPlacement = "rail" | "nav";

/**
 * The shell's live conversation reading, on every route and at every width.
 *
 * The Capabilities route already expanded these counts, but a route the reader
 * has to navigate to is not an indicator — the whole point of asking "what is
 * this thing doing right now" is that you ask it while doing something else. So
 * this sits in the two bands every route renders: the rail on desktop, and the
 * mobile tab bar below the phone breakpoint, where `.sidebar` is
 * `display: none` and a rail-only indicator would leave the phone with the
 * original complaint intact.
 *
 * It deliberately shows no bar, no percentage and no colour ramp. The count is
 * the number of active model turns this page owns; the sentence beside it is
 * the durable event count represented by the conversations in the rail.
 *
 * The accessibility structure is load-bearing, not decoration. A live region is
 * announced from its own accessible contents, and `aria-hidden` descendants are
 * not in the accessibility tree — so the earlier shape (an `aria-label` over two
 * `aria-hidden` spans) announced nothing at all when the count changed, and left
 * a browse-mode reader on an empty container. The visible glyphs stay hidden so
 * the count is not read twice, and the region's real content is text: the
 * changing reading, then the boundary sentence as a static sibling that never
 * mutates and is therefore never re-announced.
 */
export function RuntimeLoadIndicator({
  placement = "rail",
  activity,
}: Readonly<{
  placement?: RuntimeLoadPlacement;
  activity?: SessionActivityReport;
}> = {}) {
  /*
   * The count-band itself is density-tagged telemetry: at a minimal Profile
   * this indicator unmounts entirely, and the topbar's runtime line remains
   * the one sentence that says whether anything is running. Nothing about the
   * counters changes — only whether this strip spends pixels on them.
   */
  const density = usePresentationDensity();
  const current = activity?.[0] ?? 0;
  const text = activity?.[1] ?? "0 active · 0 events";
  if (!densityAllows("telemetry", density) && current === 0) return null;
  return (
    <div
      class="load-indicator"
      data-placement={placement}
      role="status"
      // `status` implies `aria-atomic="true"`, which would re-announce the whole
      // region — boundary sentence and all — every time a run starts or ends.
      // Stated as false so an announcement is the node that changed: the
      // reading.
      aria-atomic="false"
      data-running={current > 0 ? "true" : undefined}
      title="Activity."
    >
      {/* The count keeps its own element so the icon rail and the narrow nav
          column can clip the words without taking the number off the row. Both
          are hidden from assistive technology because the two text nodes below
          state the same reading in full sentences. */}
      <span class="load-indicator__count" aria-hidden="true">{current}</span>
      <span class="load-indicator__label" aria-hidden="true">{text}</span>
      <span class="sr-only">{text}</span>
    </div>
  );
}
