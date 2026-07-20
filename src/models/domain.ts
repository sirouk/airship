import type {
  AirshipModel,
  ModelAvailability,
  ModelCapabilityFilter,
  ModelModalityCapability,
  ModelPopularitySignal,
  ModelSelection,
  ModelSelectionPolicy,
  ModelSort,
  ReadinessState,
} from "./types";

/**
 * Interpret modality support only when the Chutes `/v1/models` capability
 * record was complete. A missing or partial record is unknown, never a
 * trustworthy negative claim.
 */
export function modelInputModalityCapability(
  model: AirshipModel,
  modality: string,
): ModelModalityCapability {
  const normalized = modality.trim().toLowerCase();
  if (!normalized || model.provenance.capabilities !== "llm-models") return "unknown";
  return model.inputModalities.some((value) => value.toLowerCase() === normalized)
    ? "supported"
    : "unsupported";
}

/** Privacy-first baseline for an interactive, tool-capable Airship agent. */
export const DEFAULT_AIRSHIP_MODEL_REQUIREMENTS = Object.freeze({
  features: Object.freeze(["tools"]),
  inputModalities: Object.freeze(["text"]),
  outputModalities: Object.freeze(["text"]),
  confidentialCompute: "required",
  requireE2eeCandidate: true,
  requireAttestationCandidate: true,
} satisfies ModelCapabilityFilter);

export function filterModels(
  models: readonly AirshipModel[],
  filters: ModelCapabilityFilter = {},
): readonly AirshipModel[] {
  const query = normalizeSearch(filters.query);
  const features = normalizedSet(filters.features);
  const inputModalities = normalizedSet(filters.inputModalities);
  const outputModalities = normalizedSet(filters.outputModalities);
  const samplingParameters = normalizedSet(filters.samplingParameters);
  const tags = normalizedSet(filters.tags);
  const availability = new Set(filters.availability ?? []);

  return Object.freeze(models.filter((model) => {
    if (query && !searchText(model).includes(query)) return false;
    if (!containsAll(model.features, features)) return false;
    if (!containsAll(model.inputModalities, inputModalities)) return false;
    if (!containsAll(model.outputModalities, outputModalities)) return false;
    if (!containsAll(model.samplingParameters, samplingParameters)) return false;
    if (!containsAll(model.tags, tags)) return false;

    const contextTokens = model.contextTokens ?? model.maxModelTokens;
    if (isNonNegative(filters.minContextTokens)) {
      if (contextTokens === undefined || contextTokens < filters.minContextTokens) return false;
    }
    if (isNonNegative(filters.minOutputTokens)) {
      if (model.maxOutputTokens === undefined || model.maxOutputTokens < filters.minOutputTokens) {
        return false;
      }
    }
    if (isNonNegative(filters.maxInputUsdPerMillion)) {
      const price = model.pricing.input.usdPerMillion;
      if (price === undefined || price > filters.maxInputUsdPerMillion) return false;
    }
    if (isNonNegative(filters.maxOutputUsdPerMillion)) {
      const price = model.pricing.output.usdPerMillion;
      if (price === undefined || price > filters.maxOutputUsdPerMillion) return false;
    }

    if (filters.confidentialCompute === "required" && model.trust.confidentialCompute !== "asserted") {
      return false;
    }
    if (filters.confidentialCompute === "excluded" && model.trust.confidentialCompute !== "denied") {
      return false;
    }
    if (filters.requireE2eeCandidate && model.trust.e2ee !== "candidate") return false;
    if (filters.requireAttestationCandidate && model.trust.attestation !== "candidate") return false;
    if (availability.size > 0 && !availability.has(model.availability)) return false;
    if (isNonNegative(filters.minInvocationCount)) {
      if (model.invocationCount === undefined || model.invocationCount < filters.minInvocationCount) return false;
    }
    if (isRatio(filters.maxUtilizationOneHour)) {
      const utilization = model.telemetry?.freshness === "fresh"
        ? model.telemetry.utilization.oneHour
        : undefined;
      if (utilization === undefined || utilization > filters.maxUtilizationOneHour) return false;
    }
    return true;
  }));
}

/** Stable, provider-neutral picker ordering. Missing advisory data always sorts last. */
export function sortModels(
  models: readonly AirshipModel[],
  sort: ModelSort = "recommended",
  inputPriceWeight = 0.8,
): readonly AirshipModel[] {
  const weight = normalizedWeight(inputPriceWeight);
  return Object.freeze([...models].sort((left, right) => {
    let result = 0;
    if (sort === "recommended") result = compareFallback(left, right, weight);
    if (sort === "popularity") result = compareNumber(
      modelPopularitySignal(left)?.value,
      modelPopularitySignal(right)?.value,
      true,
    );
    if (sort === "utilization") result = compareNumber(
      freshUtilization(left),
      freshUtilization(right),
    );
    if (sort === "price") result = compareNumber(blendedPrice(left, weight), blendedPrice(right, weight));
    if (sort === "context") result = compareNumber(
      left.contextTokens ?? left.maxModelTokens,
      right.contextTokens ?? right.maxModelTokens,
      true,
    );
    if (sort === "name") result = compareText(left.id, right.id);
    return result || compareText(left.id, right.id);
  }));
}

/** Current demand first, lifetime management count only when fresh telemetry is unavailable. */
export function modelPopularitySignal(model: AirshipModel): ModelPopularitySignal | undefined {
  const telemetry = model.telemetry;
  if (telemetry?.freshness === "fresh") {
    const windows = [
      [telemetry.requests.oneHour, "requests-one-hour", 1],
      [telemetry.requests.fifteenMinutes, "requests-fifteen-minutes", 4],
      [telemetry.requests.fiveMinutes, "requests-five-minutes", 12],
    ] as const;
    for (const [value, basis, hourlyMultiplier] of windows) {
      if (value !== undefined) {
        return Object.freeze({
          value: value * hourlyMultiplier,
          basis,
          source: "chutes-utilization",
          observedAt: telemetry.observedAt,
        });
      }
    }
  }
  return model.invocationCount === undefined
    ? undefined
    : Object.freeze({
        value: model.invocationCount,
        basis: "lifetime-invocations",
        source: "chutes-management",
      });
}

function freshUtilization(model: AirshipModel): number | undefined {
  return model.telemetry?.freshness === "fresh" ? model.telemetry.utilization.oneHour : undefined;
}

/**
 * Selects without relying on provider response order. Explicit preferences win;
 * fallback ranking is trust, live state, complete metadata, price, context, ID.
 */
export function selectModel(
  models: readonly AirshipModel[],
  policy: ModelSelectionPolicy = {},
): ModelSelection {
  const compatible = filterModels(models, policy.requirements ?? DEFAULT_AIRSHIP_MODEL_REQUIREMENTS);
  const byId = new Map(compatible.map((model) => [model.id, model]));
  const preferences = uniqueBoundedIds(policy.preferredModelIds);
  const rejectedPreferredModelIds: string[] = [];

  for (const id of preferences) {
    const model = byId.get(id);
    if (model) {
      return freezeSelection(model, "preferred", compatible, rejectedPreferredModelIds);
    }
    rejectedPreferredModelIds.push(id);
  }

  const defaultId = normalizeModelId(policy.defaultModelId);
  if (defaultId) {
    const model = byId.get(defaultId);
    if (model) {
      return freezeSelection(model, "configured-default", compatible, rejectedPreferredModelIds);
    }
  }

  if (compatible.length === 0) {
    return Object.freeze({
      reason: "no-compatible-model",
      compatible,
      rejectedPreferredModelIds: Object.freeze(rejectedPreferredModelIds),
    });
  }

  const inputWeight = normalizedWeight(policy.inputPriceWeight);
  const ranked = sortModels(compatible, "recommended", inputWeight);
  return freezeSelection(
    ranked[0]!,
    "deterministic-fallback",
    Object.freeze(ranked),
    rejectedPreferredModelIds,
  );
}

function freezeSelection(
  model: AirshipModel,
  reason: ModelSelection["reason"],
  compatible: readonly AirshipModel[],
  rejectedPreferredModelIds: string[],
): ModelSelection {
  return Object.freeze({
    model,
    reason,
    compatible,
    rejectedPreferredModelIds: Object.freeze([...rejectedPreferredModelIds]),
  });
}

function compareFallback(left: AirshipModel, right: AirshipModel, inputWeight: number): number {
  const trust = readinessRank(right.trust.attestation) - readinessRank(left.trust.attestation);
  if (trust !== 0) return trust;
  const availability = availabilityRank(right.availability) - availabilityRank(left.availability);
  if (availability !== 0) return availability;
  const provenance = capabilityRank(right) - capabilityRank(left);
  if (provenance !== 0) return provenance;

  const leftPrice = blendedPrice(left, inputWeight);
  const rightPrice = blendedPrice(right, inputWeight);
  if (leftPrice !== rightPrice) return leftPrice - rightPrice;

  const context = (right.contextTokens ?? right.maxModelTokens ?? 0) -
    (left.contextTokens ?? left.maxModelTokens ?? 0);
  if (context !== 0) return context;
  return compareText(left.id, right.id);
}

function blendedPrice(model: AirshipModel, inputWeight: number): number {
  const input = model.pricing.input.usdPerMillion;
  const output = model.pricing.output.usdPerMillion;
  if (input === undefined || output === undefined) return Number.POSITIVE_INFINITY;
  return input * inputWeight + output * (1 - inputWeight);
}

function readinessRank(value: ReadinessState): number {
  return value === "candidate" ? 2 : value === "not-ready" ? 1 : 0;
}

function availabilityRank(value: ModelAvailability): number {
  return value === "hot" ? 2 : value === "unknown" ? 1 : 0;
}

function capabilityRank(model: AirshipModel): number {
  return model.provenance.capabilities === "llm-models" ? 1 : 0;
}

function containsAll(actual: readonly string[], required: Set<string>): boolean {
  if (required.size === 0) return true;
  const normalizedActual = new Set(actual.map((item) => item.toLowerCase()));
  for (const item of required) {
    if (!normalizedActual.has(item)) return false;
  }
  return true;
}

function normalizedSet(values: readonly string[] | undefined): Set<string> {
  const result = new Set<string>();
  for (const value of values ?? []) {
    const normalized = value.trim().toLowerCase();
    if (normalized && normalized.length <= 128) result.add(normalized);
  }
  return result;
}

function searchText(model: AirshipModel): string {
  return [
    model.id,
    model.root,
    model.provider,
    model.engine,
    model.quantization,
    model.slug,
    model.tagline,
    ...model.features,
    ...model.inputModalities,
    ...model.outputModalities,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
}

function normalizeSearch(value: string | undefined): string {
  if (!value) return "";
  return value.trim().slice(0, 512).toLowerCase();
}

function uniqueBoundedIds(values: readonly string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values?.slice(0, 128) ?? []) {
    const id = normalizeModelId(value);
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function normalizeModelId(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 512 ? trimmed : undefined;
}

function normalizedWeight(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 0.8;
}

function isNonNegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRatio(value: number | undefined): value is number {
  return isNonNegative(value) && value <= 1;
}

function compareNumber(left: number | undefined, right: number | undefined, descending = false): number {
  const leftValid = typeof left === "number" && Number.isFinite(left);
  const rightValid = typeof right === "number" && Number.isFinite(right);
  if (!leftValid) return rightValid ? 1 : 0;
  if (!rightValid) return -1;
  return descending ? right! - left! : left! - right!;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
