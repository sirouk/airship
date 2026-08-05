import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { metricQuantity, metricState, metricValueText } from "./metric-strip";

const routeStyles = await readFile(new URL("./routes.css", import.meta.url), "utf8");

describe("a metric value is a figure or a state, and nothing else", () => {
  it("carries a figure as text so the cell never formats a number twice", () => {
    expect(metricQuantity(152)).toEqual({ kind: "quantity", text: "152" });
    expect(metricQuantity("0.056")).toEqual({ kind: "quantity", text: "0.056" });
    expect(metricValueText(metricQuantity(647))).toBe("647");
  });

  it("keeps the surface's own state word, with the claim it expands into", () => {
    const value = metricState("failed", "Not established", "production remote mode must fail closed");
    expect(metricValueText(value)).toBe("Not established");
    expect(value).toEqual({
      kind: "state",
      state: "failed",
      label: "Not established",
      detail: "production remote mode must fail closed",
    });
  });

  it("falls back to the seal's frozen word rather than inventing an eighth", () => {
    expect(metricValueText(metricState("none"))).toBe("Not checked");
    expect(metricValueText(metricState("verified"))).toBe("Verified");
  });

  it("freezes what it returns, so one cell cannot rewrite another's value", () => {
    expect(Object.isFrozen(metricQuantity(1))).toBe(true);
    expect(Object.isFrozen(metricState("asserted"))).toBe(true);
  });
});

describe("the metric grammar", () => {
  it("sets figures in Inter with tabular figures, not in the display serif", () => {
    // Conflict 9: Georgia's default figures are oldstyle and proportional, so
    // the serif cannot deliver the column alignment that was the only reason
    // anyone wanted it here. The serif's one job is the route title.
    const quantity = routeStyles.match(/\.metric-strip__quantity \{([^}]+)\}/u)?.[1] ?? "";
    expect(quantity).toContain("font-variant-numeric: tabular-nums");
    expect(quantity).toContain("var(--font-body)");
    expect(quantity).not.toContain("var(--font-display)");
    expect(quantity).toContain("var(--fs-title)");
  });

  it("sets every label in the one mono micro step", () => {
    const label = routeStyles.match(/\.metric-strip__label \{([^}]+)\}/u)?.[1] ?? "";
    expect(label).toContain("var(--fs-micro)");
    expect(label).toContain("var(--font-mono)");
    expect(label).toContain("text-transform: uppercase");
    expect(label).toContain("overflow-wrap: anywhere");
    expect(label).not.toContain("var(--font-display)");
  });

  it("lets the provenance caption wrap, because half a source is not a source", () => {
    const caption = routeStyles.match(/\.metric-strip__caption \{([^}]+)\}/u)?.[1] ?? "";
    expect(caption).toContain("var(--fs-caption)");
    expect(caption).toContain("var(--ink-faint)");
    expect(caption).not.toContain("text-overflow");
    expect(caption).not.toContain("white-space: nowrap");
    expect(caption).not.toContain("-webkit-line-clamp");
  });

  it("separates cells with one hairline that follows them when they wrap", () => {
    const strip = routeStyles.match(/\n\.metric-strip \{([^}]+)\}/u)?.[1] ?? "";
    expect(strip).toContain("grid-auto-flow: column");
    expect(strip).toContain("grid-auto-columns: 1fr");
    expect(routeStyles).toContain(".metric-strip__cell + .metric-strip__cell {\n  border-left: 1px solid var(--line);");
    // Four cells in a phone column would clip four captions; two per row keeps
    // every provenance sentence readable, and the rule moves with them.
    expect(routeStyles).toMatch(/\.metric-strip__cell:nth-child\(n \+ 3\) \{\n\s*border-top: 1px solid var\(--line\)/u);
  });
});
