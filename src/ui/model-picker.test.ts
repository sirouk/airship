import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AirshipModel } from "../models";
import { facetCounts, facetModels, MODEL_PICKER_PROVENANCE, nextModelIndex, visibleModelCount } from "./model-picker";

const source = readFileSync(new URL("./model-picker.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./model-picker.css", import.meta.url), "utf8");

function model(overrides: Partial<AirshipModel> = {}): AirshipModel {
  return {
    id: "vendor/model-TEE",
    provider: "chutes",
    availability: "warm",
    inputModalities: ["text"],
    outputModalities: ["text"],
    features: [],
    pricing: { input: { usdPerMillion: 1 }, output: { usdPerMillion: 2 } },
    trust: { confidentialCompute: "unknown", verification: "unverified", consistency: "consistent" },
    provenance: { capabilities: "llm-models", availability: "llm-models", pricing: "llm-models" },
    ...overrides,
  } as AirshipModel;
}

describe("ModelPicker bounds", () => {
  it("renders at most thirty rows before explicit expansion", () => { expect(visibleModelCount(150, false)).toBe(30); expect(visibleModelCount(150, true)).toBe(150); });
  it("wraps keyboard option navigation", () => { expect(nextModelIndex(4, 3, 1)).toBe(0); expect(nextModelIndex(4, 0, -1)).toBe(3); });
  it("keeps pagination, which is the only thing bounding a 40-model list", () => {
    // At three-line rows and 40+ models an unpaged list is roughly 5,000px, and
    // the keyboard cursor would roam an unbounded set.
    expect(source).toContain("const PAGE_SIZE = 30");
    expect(source).toContain("Show all {eligible.length}");
  });
});

describe("facet counts", () => {
  const catalog = [
    model({ id: "a", inputModalities: ["text", "image"], features: ["tools"], availability: "hot" }),
    model({ id: "b", trust: { confidentialCompute: "asserted", verification: "unverified", consistency: "consistent" } as AirshipModel["trust"] }),
    model({ id: "c" }),
  ];

  it("counts what each chip would leave, so a chip that excludes nothing says so", () => {
    const counts = facetCounts(catalog);
    expect(counts.all).toBe(3);
    expect(counts.vision).toBe(1);
    expect(counts.tools).toBe(1);
    expect(counts.hot).toBe(1);
    expect(counts.confidential).toBe(1);
  });

  it("applies a facet to the same set the count was taken from", () => {
    expect(facetModels(catalog, "vision").map((entry) => entry.id)).toEqual(["a"]);
    expect(facetModels(catalog, "all")).toHaveLength(3);
  });

  it("leaves every facet interactive rather than moving the fact into a title", () => {
    // A `disabled` chip with a `title` is a fact a thumb cannot read; the
    // visible count is what says "this one excludes nothing".
    expect(source).not.toMatch(/disabled=\{[^}]*counts/u);
    expect(source).toContain("<small>{counts[item]}</small>");
  });
});

describe("row honesty", () => {
  it("keeps every capability as a readable word, never a bare glyph", () => {
    // A glyph's absence is a silent negative the first time a non-confidential
    // model appears, and today every row in this catalogue is confidential.
    expect(source).toContain('labels.push("Confidential candidate")');
    expect(source).toContain('labels.push("Vision")');
    expect(source).toContain("Capabilities not declared");
    expect(source).toContain("capabilityLabels(model).map((label) => <span key={label}>{label}</span>)");
  });

  it("never paints unverified provider telemetry in the verification colour", () => {
    expect(styles).toContain(".model-row-metrics { color:var(--ink-faint)");
    expect(styles).not.toMatch(/\.model-row-metrics[^}]*--v-verified/u);
    expect(styles).not.toMatch(/\.model-picker-list em \{[^}]*--v-verified/u);
  });

  it("states the provenance caveat where it cannot scroll away", () => {
    expect(MODEL_PICKER_PROVENANCE).toContain("catalog metadata is not proof");
    expect(MODEL_PICKER_PROVENANCE).toContain("fresh provider telemetry when available");
    expect(source).toContain('<div class="model-picker-footer">');
    expect(source).toContain("{MODEL_PICKER_PROVENANCE}");
    // Only the list scrolls; the header and footer are outside it.
    expect(styles).toMatch(/\.model-picker-list \{[^}]*overflow:auto/u);
  });

  it("marks the recommendation from the caller's claim, not from row order", () => {
    expect(source).toContain("recommendedModelId");
    expect(source).not.toContain('class={index === 0 ? "recommended" : ""}');
  });
});
