import type { JSX } from "preact";

export const STATUS_MARK_STATES = [
  "none",
  "checking",
  "stale",
  "verified",
  "asserted",
  "attention",
  "failed",
] as const;

export type StatusMarkState = (typeof STATUS_MARK_STATES)[number];

export const STATUS_MARK_LABELS: Readonly<Record<StatusMarkState, string>> = Object.freeze({
  none: "Not checked",
  checking: "Checking",
  stale: "Stale",
  verified: "Ready",
  asserted: "Recorded",
  attention: "Attention",
  failed: "Failed",
});

export const STATUS_MARK_DENSITIES = ["dot", "chip", "hero"] as const;

export type StatusMarkDensity = (typeof STATUS_MARK_DENSITIES)[number];

export type StatusMarkProps = Readonly<{
  state: StatusMarkState;
  label?: string;
  detail?: string;
  size?: number;
  /** Container weight. `chip` is the default because a status is a chip. */
  density?: StatusMarkDensity;
  compact?: boolean;
  origin?: "local" | "remote";
  acting?: boolean;
  class?: string;
}>;

export function statusMarkRenderedSize(size: number): number {
  return Math.max(16, size);
}

/**
 * The well a density renders in, honoring an explicit override and the floor.
 *
 * `dot` is not an exception to the 16px legibility floor, it *is* the floor:
 * the density that hides its label still renders a full-size mark, because the
 * label is what scales down the ladder, never the glyph. Only `hero` — the one
 * per route — is larger.
 */
export function statusMarkDensitySize(density: StatusMarkDensity, size?: number): number {
  return statusMarkRenderedSize(size ?? (density === "hero" ? 28 : 16));
}

/**
 * Airship's single status mark.
 *
 * Six SVG shapes express seven named states: checking and stale deliberately
 * share the arc shape, with stale rendered as the static dashed variant.
 * The adjacent word is part of the component contract so color is never the
 * only carrier of meaning — which is why `dot` clips its label out of the
 * layout rather than dropping it: the word stays in the accessible name.
 *
 * `hero` is the only density that renders `detail` as visible text. Elsewhere
 * the detail is the popover body the chip expands into, so promoting it here
 * would restate on the resting surface what the ladder already owns.
 */
export function StatusMark({
  state,
  label = STATUS_MARK_LABELS[state],
  detail,
  size,
  density = "chip",
  compact = false,
  origin,
  acting = false,
  class: className,
}: StatusMarkProps) {
  const renderedSize = statusMarkDensitySize(density, size);
  const accessibleLabel = detail ? `${label}. ${detail}` : label;
  return (
    <span
      class={["status-mark", compact ? "status-mark--compact" : undefined, className].filter(Boolean).join(" ")}
      data-state={state}
      data-density={density}
      data-origin={origin}
      data-acting={acting ? "true" : "false"}
      title={detail}
      role="img"
      aria-label={accessibleLabel}
    >
      <svg
        class="status-mark__svg"
        height={renderedSize}
        viewBox="0 0 24 24"
        width={renderedSize}
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.65"
      >
        {statusMarkShape(state)}
      </svg>
      <span class="status-mark__label">{label}</span>
      {density === "hero" && detail ? <small class="status-mark__detail">{detail}</small> : null}
    </span>
  );
}

export function statusMarkStateForRuntimeStatus(
  status: "checking" | "loading" | "stale" | "degraded" | "conflicted" | "attention" | undefined,
): StatusMarkState {
  if (status === "checking" || status === "loading") return "checking";
  if (status === "stale") return "stale";
  if (status === "degraded" || status === "conflicted" || status === "attention") return "attention";
  return "none";
}

function statusMarkShape(state: StatusMarkState): JSX.Element {
  switch (state) {
    case "verified":
      return <path d="M5 12.5 9.2 16.5 19 7.5" />;
    case "failed":
      return <path d="m7 7 10 10m0-10L7 17" />;
    case "attention":
      return <path d="M12 5.5v7m0 4.5h.01" />;
    case "asserted":
      return <path d="M6.5 12h11M12 6.5V12" />;
    case "checking":
      return <path class="status-mark__arc--checking" d="M7 12a5 5 0 1 1 5 5" stroke-dasharray="4 2" />;
    case "stale":
      return <path class="status-mark__arc--stale" d="M7 12a5 5 0 1 1 5 5" />;
    case "none":
    default:
      return <circle cx="12" cy="12" r="4.5" />;
  }
}
