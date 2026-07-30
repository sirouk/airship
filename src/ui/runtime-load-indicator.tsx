import { useEffect, useState } from "preact/hooks";
import {
  RUNTIME_LOAD_BOUNDARY,
  getRuntimeLoadMonitor,
  runtimeLoadIndicatorLabel,
  type RuntimeLoadMonitor,
} from "../capabilities/runtime-load";
import "./runtime-load-indicator.css";

/**
 * Where the reading is mounted. Both placements render the same element and the
 * same words; only the box differs, because the desktop rail and the phone tab
 * bar are the two bands the shell renders on every route at their own width.
 */
export type RuntimeLoadPlacement = "rail" | "nav";

/**
 * The shell's live utilisation reading, on every route and at every width.
 *
 * The Capabilities route already expanded these counts, but a route the reader
 * has to navigate to is not an indicator — the whole point of asking "what is
 * this thing doing right now" is that you ask it while doing something else. So
 * this sits in the two bands every route renders: the rail on desktop, and the
 * mobile tab bar below the phone breakpoint, where `.sidebar` is
 * `display: none` and a rail-only indicator would leave the phone with the
 * original complaint intact.
 *
 * It deliberately shows no bar, no percentage and no colour ramp. There is no
 * browser API that tells a page its share of the machine, and a chip that looks
 * like a CPU meter is read as one — which is the exact failure the monitor's own
 * `not-measurable` states exist to prevent. `Idle` and `2 running` are counts.
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
  monitor = getRuntimeLoadMonitor(),
  placement = "rail",
}: Readonly<{ monitor?: RuntimeLoadMonitor; placement?: RuntimeLoadPlacement }> = {}) {
  // Seeded from the snapshot rather than from `undefined`, so the indicator is
  // in the DOM on first paint instead of appearing one frame later: an element
  // that flickers into a rail is worse than one that starts at zero, and zero
  // is the true reading before anything has run.
  const [report, setReport] = useState(() => monitor.snapshot());
  useEffect(() => monitor.subscribe(setReport), [monitor]);

  const { text, reading } = runtimeLoadIndicatorLabel(report);
  return (
    <div
      class="load-indicator"
      data-placement={placement}
      role="status"
      // `status` implies `aria-atomic="true"`, which would re-announce the whole
      // region — boundary sentence and all — every time a run starts or ends.
      // Stated as false so an announcement is the node that changed: the
      // reading. The caveat below is still read whenever the region itself is,
      // and its text never mutates, so it is never announced twice.
      aria-atomic="false"
      data-running={report.current > 0 ? "true" : undefined}
      title={RUNTIME_LOAD_BOUNDARY}
    >
      {/* The count keeps its own element so the icon rail and the narrow nav
          column can clip the words without taking the number off the row. Both
          are hidden from assistive technology because the two text nodes below
          state the same reading in full sentences. */}
      <span class="load-indicator__count" aria-hidden="true">{report.current}</span>
      <span class="load-indicator__label" aria-hidden="true">{text}</span>
      <span class="sr-only">{reading}</span>
      <span class="sr-only">{RUNTIME_LOAD_BOUNDARY}</span>
    </div>
  );
}
