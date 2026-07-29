import { useEffect, useState } from "preact/hooks";
import {
  RUNTIME_LOAD_BOUNDARY,
  getRuntimeLoadMonitor,
  runtimeLoadIndicatorLabel,
  type RuntimeLoadMonitor,
} from "../capabilities/runtime-load";
import "./runtime-load-indicator.css";

/**
 * The shell's live utilisation reading, on every route.
 *
 * The Capabilities route already expanded these counts, but a route the reader
 * has to navigate to is not an indicator — the whole point of asking "what is
 * this thing doing right now" is that you ask it while doing something else. So
 * this sits in the rail, which every route renders, and states the one number
 * the page can defend: runs Airship itself started and has not seen finish.
 *
 * It deliberately shows no bar, no percentage and no colour ramp. There is no
 * browser API that tells a page its share of the machine, and a chip that looks
 * like a CPU meter is read as one — which is the exact failure the monitor's own
 * `not-measurable` states exist to prevent. `Idle` and `2 running` are counts,
 * and the accessible name carries the boundary sentence with them.
 */
export function RuntimeLoadIndicator({ monitor = getRuntimeLoadMonitor() }: Readonly<{ monitor?: RuntimeLoadMonitor }> = {}) {
  // Seeded from the snapshot rather than from `undefined`, so the indicator is
  // in the DOM on first paint instead of appearing one frame later: an element
  // that flickers into a rail is worse than one that starts at zero, and zero
  // is the true reading before anything has run.
  const [report, setReport] = useState(() => monitor.snapshot());
  useEffect(() => monitor.subscribe(setReport), [monitor]);

  const { text, spoken } = runtimeLoadIndicatorLabel(report);
  return (
    <div
      class="rail-load"
      role="status"
      data-running={report.current > 0 ? "true" : undefined}
      aria-label={`Live in-page execution load. ${spoken}`}
      title={RUNTIME_LOAD_BOUNDARY}
    >
      {/* The count keeps its own element so the icon rail can clip the words
          without taking the number — or the accessible name — off the row. */}
      <span class="rail-load__count" aria-hidden="true">{report.current}</span>
      <span class="rail-load__label" aria-hidden="true">{text}</span>
    </div>
  );
}
