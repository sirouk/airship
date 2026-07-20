import { describe, expect, it } from "vitest";
import {
  DEFAULT_AIRSHIP_MODEL_REQUIREMENTS,
  filterModels,
  modelInputModalityCapability,
  modelPopularitySignal,
  selectModel,
  sortModels,
} from "./domain";
import {
  CatalogPayloadError,
  mergeModelCatalog,
  parseInferenceCatalog,
  parseManagementCatalog,
} from "./parser";
import { parseUtilizationCatalog } from "./telemetry";

describe("model catalog normalization", () => {
  it("keeps field authority and proof readiness explicit while merging live status", () => {
    const inference = parseInferenceCatalog({
      object: "list",
      data: [
        rawModel("provider/zeta", "chute-z", {
          confidential_compute: true,
          pricing: { prompt: 0.2, completion: 0.8, input_cache_read: 0.1 },
          price: {
            input: { usd: 0.2, tao: 0.001 },
            output: { usd: 0.8, tao: 0.004 },
            input_cache_read: { usd: 0.1, tao: 0.0005 },
          },
        }),
        rawModel("provider/alpha", "chute-a", { confidential_compute: true }),
      ],
    });
    const management = parseManagementCatalog({
      total: 2,
      page: 0,
      limit: 500,
      items: [
        {
          chute_id: "chute-z",
          name: "provider/zeta",
          slug: "provider-zeta",
          tagline: "A useful model",
          public: true,
          tee: true,
          hot: true,
          invocation_count: 99,
          current_estimated_price: {
            per_million_tokens: {
              input: { usd: 0.2 },
              output: { usd: 0.8 },
              input_cache_read: { usd: 0.1 },
            },
          },
        },
        { chute_id: "chute-a", name: "provider/alpha", tee: false, hot: false },
      ],
    });

    const models = mergeModelCatalog(inference, management);
    expect(models.map((model) => model.id)).toEqual(["provider/alpha", "provider/zeta"]);
    const zeta = models[1]!;
    expect(zeta).toMatchObject({
      chuteId: "chute-z",
      provider: "provider",
      availability: "hot",
      public: true,
      slug: "provider-zeta",
      pricing: {
        authority: "llm-models",
        consistency: "consistent",
        input: { usdPerMillion: 0.2, taoPerMillion: 0.001 },
      },
      trust: {
        confidentialCompute: "asserted",
        teeDeployment: "asserted",
        consistency: "consistent",
        e2ee: "candidate",
        attestation: "candidate",
        verification: "unverified",
        evidencePath: "/chutes/chute-z/evidence",
      },
      provenance: {
        identity: "llm-models",
        capabilities: "llm-models",
        availability: "chutes-management",
        provider: "inferred-from-model-id",
        runtimeOwner: "llm-models",
      },
    });
    expect(models[0]!.trust).toMatchObject({
      consistency: "conflict",
      e2ee: "conflict",
      attestation: "conflict",
      verification: "unverified",
    });
  });

  it("uses management token pricing only as an explicitly marked fallback", () => {
    const inference = parseInferenceCatalog({ data: [rawModel("p/model", "c-1", { pricing: undefined, price: undefined })] });
    const management = parseManagementCatalog({
      total: 1,
      items: [{
        chute_id: "c-1",
        tee: true,
        hot: true,
        current_estimated_price: {
          per_million_tokens: { input: { usd: 1.25 }, output: { usd: 2.5 } },
        },
      }],
    });
    const model = mergeModelCatalog(inference, management)[0]!;
    expect(model.pricing).toMatchObject({
      authority: "chutes-management",
      consistency: "partial",
      input: { usdPerMillion: 1.25 },
      output: { usdPerMillion: 2.5 },
    });
  });

  it("normalizes advisory utilization with explicit provenance and no trust promotion", () => {
    const inference = parseInferenceCatalog({ data: [rawModel("source/model", "c-1")] });
    const utilization = parseUtilizationCatalog([{
      chute_id: "c-1",
      timestamp: "2026-07-18T12:00:00Z",
      utilization_current: 0.3,
      utilization_1h: 0.25,
      rate_limit_ratio_1h: 0.01,
      total_requests_1h: 123.5,
      active_instance_count: 2,
      total_instance_count: 3,
      target_count: 4,
      scalable: true,
      scale_allowance: 2,
    }], Date.parse("2026-07-18T12:01:00Z"));
    const model = mergeModelCatalog(inference, undefined, utilization)[0]!;
    expect(model.telemetry).toEqual({
      observedAt: "2026-07-18T12:00:00.000Z",
      freshness: "fresh",
      utilization: { current: 0.3, oneHour: 0.25 },
      rateLimitRatio: { oneHour: 0.01 },
      requests: { oneHour: 123.5 },
      instances: { active: 2, total: 3, target: 4, scaleAllowance: 2, scalable: true },
    });
    expect(model.provenance).toMatchObject({
      utilization: "chutes-utilization",
      popularity: "chutes-utilization",
      tags: "derived-from-declared-metadata",
    });
    expect(model.tags).toContain("feature:tools");
    expect(model.trust.verification).toBe("unverified");
  });

  it("bounds collection sizes and skips malformed records without echoing them", () => {
    expect(() => parseInferenceCatalog({ data: Array.from({ length: 10_001 }, () => ({})) }))
      .toThrowError(CatalogPayloadError);
    try {
      parseInferenceCatalog({ data: Array.from({ length: 10_001 }, () => ({})) });
    } catch (error) {
      expect(error).toMatchObject({ code: "response-too-large" });
    }

    const parsed = parseInferenceCatalog({
      data: [
        rawModel("valid/model", "valid-chute"),
        rawModel("valid/model", "duplicate-chute"),
        { id: "x".repeat(513), chute_id: "invalid" },
        { id: "missing-chute" },
      ],
    });
    expect(parsed.models.map((model) => model.id)).toEqual(["valid/model"]);
    expect(parsed).toMatchObject({ records: 4, skipped: 3 });
  });
});

describe("model filtering and selection", () => {
  const models = mergeModelCatalog(
    parseInferenceCatalog({
      data: [
        rawModel("provider/expensive", "c-expensive", {
          context_length: 262_144,
          pricing: { prompt: 1, completion: 4 },
          confidential_compute: true,
        }),
        rawModel("provider/cheap", "c-cheap", {
          context_length: 131_072,
          pricing: { prompt: 0.1, completion: 0.4 },
          confidential_compute: true,
        }),
        rawModel("provider/unknown-proof", "c-unknown", {
          context_length: 500_000,
          pricing: { prompt: 0.01, completion: 0.01 },
          confidential_compute: undefined,
        }),
      ],
    }),
    parseManagementCatalog({
      total: 3,
      items: [
        { chute_id: "c-expensive", tee: true, hot: true },
        { chute_id: "c-cheap", tee: true, hot: true },
        { chute_id: "c-unknown", tee: true, hot: true },
      ],
    }),
  );

  it("reports image input support only from complete Chutes inference metadata", () => {
    const complete = models[0]!;
    expect(modelInputModalityCapability(complete, "image")).toBe("supported");
    expect(modelInputModalityCapability(complete, "audio")).toBe("unsupported");
    expect(modelInputModalityCapability({
      ...complete,
      provenance: { ...complete.provenance, capabilities: "partial" },
    }, "image")).toBe("unknown");
  });

  it("fails closed when a required capability, price, or trust claim is unknown", () => {
    expect(filterModels(models, DEFAULT_AIRSHIP_MODEL_REQUIREMENTS).map((model) => model.id)).toEqual([
      "provider/cheap",
      "provider/expensive",
    ]);
    expect(filterModels(models, {
      features: ["tools", "structured_outputs"],
      inputModalities: ["image"],
      minContextTokens: 200_000,
      maxInputUsdPerMillion: 2,
      confidentialCompute: "required",
      requireAttestationCandidate: true,
    }).map((model) => model.id)).toEqual(["provider/expensive"]);
    expect(filterModels(models, {
      maxInputUsdPerMillion: 0.05,
      confidentialCompute: "required",
    })).toEqual([]);

    const missingLimitsAndPrice = mergeModelCatalog(parseInferenceCatalog({
      data: [rawModel("provider/partial", "c-partial", {
        context_length: undefined,
        max_model_len: undefined,
        pricing: undefined,
        price: undefined,
      })],
    }));
    expect(filterModels(missingLimitsAndPrice, { minContextTokens: 1 })).toEqual([]);
    expect(filterModels(missingLimitsAndPrice, { maxInputUsdPerMillion: 10 })).toEqual([]);
  });

  it("uses ordered preferences, then a configured default, then stable policy ranking", () => {
    const preferred = selectModel(models, {
      preferredModelIds: ["missing/model", "provider/expensive"],
    });
    expect(preferred.model?.id).toBe("provider/expensive");
    expect(preferred.reason).toBe("preferred");
    expect(preferred.rejectedPreferredModelIds).toEqual(["missing/model"]);

    const configured = selectModel(models, { defaultModelId: "provider/expensive" });
    expect(configured.model?.id).toBe("provider/expensive");
    expect(configured.reason).toBe("configured-default");

    const fallbackA = selectModel(models);
    const fallbackB = selectModel([...models].reverse());
    expect(fallbackA.model?.id).toBe("provider/cheap");
    expect(fallbackB.model?.id).toBe("provider/cheap");
    expect(fallbackA.reason).toBe("deterministic-fallback");
  });

  it("reports an honest empty selection instead of weakening privacy requirements", () => {
    const result = selectModel(models, {
      requirements: { features: ["audio-generation"], confidentialCompute: "required" },
      preferredModelIds: ["provider/cheap"],
    });
    expect(result.model).toBeUndefined();
    expect(result.reason).toBe("no-compatible-model");
    expect(result.compatible).toEqual([]);
    expect(result.rejectedPreferredModelIds).toEqual(["provider/cheap"]);
  });

  it("filters and stably sorts declared tags, popularity, and advisory utilization", () => {
    const inference = parseInferenceCatalog({ data: [
      rawModel("provider/busy", "c-busy"),
      rawModel("provider/quiet", "c-quiet"),
      rawModel("provider/unknown", "c-unknown"),
    ] });
    const management = parseManagementCatalog({ items: [
      { chute_id: "c-busy", invocation_count: 100 },
      { chute_id: "c-quiet", invocation_count: 20 },
      { chute_id: "c-unknown" },
    ] });
    const utilization = parseUtilizationCatalog([
      { chute_id: "c-busy", timestamp: "2026-07-18T12:00:00Z", utilization_1h: 0.9, total_requests_1h: 50 },
      { chute_id: "c-quiet", timestamp: "2026-07-18T12:00:00Z", utilization_1h: 0.1, total_requests_1h: 200 },
    ], Date.parse("2026-07-18T12:01:00Z"));
    const ranked = mergeModelCatalog(inference, management, utilization);
    expect(filterModels(ranked, {
      tags: ["feature:tools", "input:image"],
      minInvocationCount: 10,
      maxUtilizationOneHour: 0.5,
    }).map((model) => model.id)).toEqual(["provider/quiet"]);
    expect(sortModels([...ranked].reverse(), "popularity").map((model) => model.id)).toEqual([
      "provider/quiet", "provider/busy", "provider/unknown",
    ]);
    expect(modelPopularitySignal(ranked.find((model) => model.id === "provider/quiet")!)).toEqual({
      value: 200,
      basis: "requests-one-hour",
      source: "chutes-utilization",
      observedAt: "2026-07-18T12:00:00.000Z",
    });
    expect(sortModels([...ranked].reverse(), "utilization").map((model) => model.id)).toEqual([
      "provider/quiet", "provider/busy", "provider/unknown",
    ]);
  });
});

function rawModel(id: string, chuteId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    chute_id: chuteId,
    object: "model",
    root: `${id}-root`,
    owned_by: "vllm",
    quantization: "fp8",
    created: 1_800_000_000,
    context_length: 131_072,
    max_model_len: 131_072,
    max_output_length: 32_768,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supported_features: ["tools", "reasoning", "structured_outputs"],
    supported_sampling_parameters: ["temperature", "top_p"],
    confidential_compute: true,
    pricing: { prompt: 0.5, completion: 1 },
    ...overrides,
  };
}
