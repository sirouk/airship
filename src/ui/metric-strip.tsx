import type { ComponentChildren } from "preact";
import { Seal, SEAL_LABELS, type SealState } from "./seal";

/**
 * USAGE — the one way Airship presents a number.
 *
 *   <MetricStrip label="Memory graph">
 *     <Metric label="Nodes" value={metricQuantity(152)} caption="real page inputs + derived terms" />
 *     <Metric label="Relationships" value={metricQuantity(647)} caption="typed, bounded edges" />
 *     <Metric label="Components" value={metricQuantity(4)} caption="current relationship islands" />
 *     <Metric label="TEE verification"
 *             value={metricState("failed", "Not established")}
 *             caption="production remote mode must fail closed" />
 *   </MetricStrip>
 *
 * Three rules the type enforces so five stat grammars cannot grow back:
 * 1. The label is always `--fs-micro` mono uppercase. The serif never sets a
 *    label.
 * 2. The value is either a *quantity* — `--fs-title` Inter with
 *    `font-variant-numeric: tabular-nums`, so a column of figures aligns — or
 *    a *state*, which is a `chip` Seal and never a serif word. There is no
 *    third kind, which is why `MetricValue` is a union rather than a string.
 *    Per conflict 9 the display serif does **not** get this job: Georgia's
 *    figures are oldstyle proportional and cannot deliver the alignment that
 *    was the only argument for putting a serif here.
 * 3. The caption is `--fs-caption` `--ink-faint` and is where provenance
 *    lives. It wraps rather than ellipsising: a provenance line cut in half is
 *    a claim with its qualifier removed.
 */

export type MetricValue =
  | Readonly<{ kind: "quantity"; text: string }>
  | Readonly<{ kind: "state"; state: SealState; label?: string; detail?: string }>;

/** A number, a byte size, a duration — anything that reads as a figure. */
export function metricQuantity(text: string | number): MetricValue {
  return Object.freeze({ kind: "quantity", text: typeof text === "number" ? String(text) : text });
}

/**
 * A state, which is a chip Seal.
 *
 * `label` overrides the seal's own word when the surface has a more specific
 * one ("Not established", "Not observed"); `detail` is the sentence the chip
 * carries into its expansion, so a caveat that reads as prose today keeps its
 * words instead of being flattened into a status noun.
 */
export function metricState(state: SealState, label?: string, detail?: string): MetricValue {
  return Object.freeze({ kind: "state", state, label, detail });
}

/**
 * The text a value contributes to reading order, with no markup.
 *
 * A state with no label of its own falls back to the seal's frozen word rather
 * than to a second vocabulary — the status family has exactly seven words and
 * a metric cell is not allowed an eighth.
 */
export function metricValueText(value: MetricValue): string {
  return value.kind === "quantity" ? value.text : value.label ?? SEAL_LABELS[value.state];
}

export type MetricStripProps = Readonly<{
  /** Accessible name for the group of cells. */
  label?: string;
  children: ComponentChildren;
  class?: string;
}>;

/**
 * A row of equal-width cells, separated by one hairline, holding one number
 * each.
 *
 * It is a description list because that is what it is: a set of labels and the
 * values they name. The ad-hoc `<dl>` grids it replaces disagreed about label
 * type, value type and caption type; #memory ran two of them on one page and
 * they printed contradictory counts for the same data.
 */
export function MetricStrip({ label, children, class: className }: MetricStripProps) {
  return (
    <dl class={["metric-strip", className].filter(Boolean).join(" ")} aria-label={label}>
      {children}
    </dl>
  );
}

export type MetricProps = Readonly<{
  label: string;
  value: MetricValue;
  /** Provenance, in one sentence. Rendered in full, never truncated. */
  caption?: string;
  class?: string;
}>;

export function Metric({ label, value, caption, class: className }: MetricProps) {
  return (
    <div class={["metric-strip__cell", className].filter(Boolean).join(" ")} data-kind={value.kind}>
      <dt class="metric-strip__label">{label}</dt>
      <dd class="metric-strip__value">
        {value.kind === "quantity"
          ? <strong class="metric-strip__quantity">{value.text}</strong>
          : <Seal state={value.state} label={value.label} detail={value.detail} density="chip" />}
        {caption ? <small class="metric-strip__caption">{caption}</small> : null}
      </dd>
    </div>
  );
}
