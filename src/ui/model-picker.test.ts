import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AirshipModel } from "../models";
import { catalogTokens, facetCounts, facetModels, modelFacts, MODEL_PICKER_PROVENANCE, nextModelIndex, visibleModelCount } from "./model-picker";
import { TRUST_LABEL_CONNECT_TRUST_READINESS } from "./trust-language";

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

  it("carries availability and trust readiness on the row, as words", () => {
    // Both were catalogue facts that existed only in the tile grid *outside*
    // this control, so two models could not be compared on them without
    // choosing one first. `metadata conflict` is the arm that decides a choice.
    expect(catalogTokens(model({ availability: "hot" }))).toEqual(["hot", "evidence candidate"]);
    expect(catalogTokens(model({
      trust: { confidentialCompute: "unknown", verification: "unverified", consistency: "conflict" } as AirshipModel["trust"],
    }))).toEqual(["warm", "metadata conflict"]);
    expect(source).toContain('catalogTokens(model).map((label) => <span key={label} class="model-row-catalog">{label}</span>)');
  });
});

describe("the catalogue metadata travels with the model", () => {
  const facts = modelFacts(model({
    availability: "hot",
    contextTokens: 41_000,
    maxOutputTokens: 41_000,
    pricing: { input: { usdPerMillion: 0.104 }, output: { usdPerMillion: 0.416 } },
  } as Partial<AirshipModel>));

  it("keeps all four tiles, every value and every provenance caption", () => {
    // The tile grid this replaces sat beside the picker at 210px desktop /
    // 306px phone, and the open popover then covered it. Not one cell of it may
    // be lost in the move: these are the exact four labels and the exact
    // captions, including the caveat that stops `evidence candidate` reading as
    // a verdict.
    expect(facts.map((fact) => fact.label)).toEqual(["Availability", "Context", "Input / output", "Trust readiness"]);
    expect(facts[0]!.value).toBe("hot");
    expect(facts[0]!.captions).toEqual(["provider management snapshot"]);
    expect(facts[1]!.captions).toEqual(["41K max output"]);
    expect(facts[2]!.captions).toEqual(["USD per million tokens"]);
    expect(facts[3]!.value).toBe("evidence candidate");
    // "verification remains unverified" is a retired name (RETIRED_TRUST_LABELS)
    // and was assembled by interpolating a literal enum, so no whole-string
    // search could find it here. Its written successor carries BOTH facts the
    // two captions carried — the readiness, and "catalog metadata is not proof"
    // verbatim — which is why one caption now stands where two did. The caveat
    // that stops `evidence candidate` reading as a verdict is still on screen.
    expect(facts[3]!.captions).toEqual([TRUST_LABEL_CONNECT_TRUST_READINESS]);
    expect(facts[3]!.captions[0]).toContain("catalog metadata is not proof");
  });

  it("names an unavailable availability source rather than implying a live read", () => {
    const stale = modelFacts(model({
      provenance: { capabilities: "llm-models", availability: "unavailable", pricing: "llm-models" },
    } as Partial<AirshipModel>));
    expect(stale[0]!.captions).toEqual(["live status unavailable"]);
    const noContext = modelFacts(model({ contextTokens: undefined, maxModelTokens: undefined } as Partial<AirshipModel>));
    expect(noContext[1]!.value).toBe("unknown");
    expect(noContext[1]!.captions).toEqual(["output limit unavailable"]);
  });

  it("renders those facts inside the control, so they move when the model does", () => {
    expect(source).toContain("{attachFacts && selected ? <ModelFactStrip model={selected} /> : null}");
    expect(source).toContain('<dl class="model-picker-meta"');
    // Captions wrap in full: a provenance line cut in half is a claim with its
    // qualifier removed.
    expect(styles).toContain(".model-picker-meta small {");
    expect(styles).toMatch(/\.model-picker-meta small \{[^}]*overflow-wrap:anywhere/u);
    expect(styles).not.toMatch(/\.model-picker-meta small \{[^}]*text-overflow:ellipsis/u);
  });
});
