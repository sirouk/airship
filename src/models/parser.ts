import type {
  AirshipModel,
  ClaimState,
  ModelAvailability,
  ModelOperationalTelemetry,
  ModelTokenPricing,
  TokenUnitPrice,
} from "./types";
import type { ParsedUtilizationCatalog } from "./telemetry";

const MAX_MODEL_RECORDS = 10_000;
const MAX_MANAGEMENT_RECORDS = 5_000;
const MAX_ID_LENGTH = 512;
const MAX_CHUTE_ID_LENGTH = 256;
const MAX_SHORT_STRING = 512;
const MAX_TAGLINE_LENGTH = 4_096;
const MAX_CAPABILITY_ITEMS = 128;
const MAX_CAPABILITY_LENGTH = 128;
const MAX_TOKEN_LIMIT = 100_000_000;
const MAX_UNIT_PRICE = 1_000_000;

export type CatalogPayloadErrorCode = "invalid-payload" | "response-too-large";

export class CatalogPayloadError extends Error {
  constructor(
    readonly code: CatalogPayloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CatalogPayloadError";
  }
}

type ParsedPrice = Readonly<{
  input: TokenUnitPrice;
  output: TokenUnitPrice;
  inputCacheRead: TokenUnitPrice;
  internallyChanged: boolean;
}>;

export type ParsedInferenceModel = Readonly<{
  id: string;
  chuteId: string;
  root?: string;
  engine?: string;
  quantization?: string;
  created?: number;
  contextTokens?: number;
  maxModelTokens?: number;
  maxOutputTokens?: number;
  inputModalities: readonly string[];
  outputModalities: readonly string[];
  features: readonly string[];
  samplingParameters: readonly string[];
  capabilitiesComplete: boolean;
  confidentialCompute?: boolean;
  pricing: ParsedPrice;
}>;

export type ParsedManagementChute = Readonly<{
  chuteId: string;
  name?: string;
  slug?: string;
  tagline?: string;
  public?: boolean;
  tee?: boolean;
  hot?: boolean;
  invocationCount?: number;
  logoId?: string;
  pricing: ParsedPrice;
}>;

export type ParsedInferenceCatalog = Readonly<{
  models: readonly ParsedInferenceModel[];
  records: number;
  skipped: number;
}>;

export type ParsedManagementCatalog = Readonly<{
  chutes: readonly ParsedManagementChute[];
  records: number;
  total?: number;
  skipped: number;
  truncated: boolean;
}>;


export function parseInferenceCatalog(value: unknown): ParsedInferenceCatalog {
  const record = requireRecord(value, "model catalog");
  if (!Array.isArray(record.data)) {
    throw new CatalogPayloadError("invalid-payload", "Chutes model catalog has no data array.");
  }
  if (record.data.length > MAX_MODEL_RECORDS) {
    throw new CatalogPayloadError(
      "response-too-large",
      `Chutes model catalog exceeds ${MAX_MODEL_RECORDS} records.`,
    );
  }

  const models: ParsedInferenceModel[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of record.data) {
    const model = parseInferenceModel(item);
    if (!model || seen.has(model.id)) {
      skipped += 1;
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  models.sort((left, right) => compareText(left.id, right.id));
  return Object.freeze({
    models: Object.freeze(models),
    records: record.data.length,
    skipped,
  });
}

export function parseManagementCatalog(value: unknown): ParsedManagementCatalog {
  const record = requireRecord(value, "chute catalog");
  if (!Array.isArray(record.items)) {
    throw new CatalogPayloadError("invalid-payload", "Chutes management catalog has no items array.");
  }
  if (record.items.length > MAX_MANAGEMENT_RECORDS) {
    throw new CatalogPayloadError(
      "response-too-large",
      `Chutes management catalog exceeds ${MAX_MANAGEMENT_RECORDS} records.`,
    );
  }

  const chutes: ParsedManagementChute[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of record.items) {
    const chute = parseManagementChute(item);
    if (!chute || seen.has(chute.chuteId)) {
      skipped += 1;
      continue;
    }
    seen.add(chute.chuteId);
    chutes.push(chute);
  }
  chutes.sort((left, right) => compareText(left.chuteId, right.chuteId));
  const total = boundedInteger(record.total, 0, MAX_MANAGEMENT_RECORDS * 100);
  return Object.freeze({
    chutes: Object.freeze(chutes),
    records: record.items.length,
    ...(total !== undefined ? { total } : {}),
    skipped,
    truncated: total !== undefined && total > record.items.length,
  });
}

export function mergeModelCatalog(
  inference: ParsedInferenceCatalog,
  management?: ParsedManagementCatalog,
  utilization?: ParsedUtilizationCatalog,
): readonly AirshipModel[] {
  const chuteById = new Map(management?.chutes.map((chute) => [chute.chuteId, chute]) ?? []);
  const telemetryById = new Map(utilization?.entries.map((entry) => [entry.chuteId, entry.telemetry]) ?? []);
  const models = inference.models.map((model) => mergeModel(
    model,
    chuteById.get(model.chuteId),
    telemetryById.get(model.chuteId),
  ));
  models.sort((left, right) => compareText(left.id, right.id));
  return Object.freeze(models);
}

function parseInferenceModel(value: unknown): ParsedInferenceModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedString(value.id, MAX_ID_LENGTH);
  const chuteId = boundedString(value.chute_id, MAX_CHUTE_ID_LENGTH);
  if (!id || !chuteId) return undefined;

  const inputModalities = stringList(value.input_modalities);
  const outputModalities = stringList(value.output_modalities);
  const features = stringList(value.supported_features);
  const samplingParameters = stringList(value.supported_sampling_parameters);
  const contextTokens = tokenLimit(value.context_length);
  const maxModelTokens = tokenLimit(value.max_model_len);
  const maxOutputTokens = tokenLimit(value.max_output_length);
  const capabilitiesComplete =
    inputModalities.valid &&
    outputModalities.valid &&
    features.valid &&
    samplingParameters.valid &&
    (contextTokens !== undefined || maxModelTokens !== undefined);

  return Object.freeze({
    id,
    chuteId,
    ...(boundedString(value.root, MAX_ID_LENGTH) ? { root: boundedString(value.root, MAX_ID_LENGTH) } : {}),
    ...(boundedString(value.owned_by, MAX_SHORT_STRING)
      ? { engine: boundedString(value.owned_by, MAX_SHORT_STRING) }
      : {}),
    ...(boundedString(value.quantization, MAX_SHORT_STRING)
      ? { quantization: boundedString(value.quantization, MAX_SHORT_STRING) }
      : {}),
    ...(boundedInteger(value.created, 0, Number.MAX_SAFE_INTEGER) !== undefined
      ? { created: boundedInteger(value.created, 0, Number.MAX_SAFE_INTEGER) }
      : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(maxModelTokens !== undefined ? { maxModelTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    inputModalities: inputModalities.items,
    outputModalities: outputModalities.items,
    features: features.items,
    samplingParameters: samplingParameters.items,
    capabilitiesComplete,
    ...(typeof value.confidential_compute === "boolean"
      ? { confidentialCompute: value.confidential_compute }
      : {}),
    pricing: parseInferencePricing(value),
  });
}

function parseManagementChute(value: unknown): ParsedManagementChute | undefined {
  if (!isRecord(value)) return undefined;
  const chuteId = boundedString(value.chute_id, MAX_CHUTE_ID_LENGTH);
  if (!chuteId) return undefined;
  const name = boundedString(value.name, MAX_ID_LENGTH);
  const slug = boundedString(value.slug, MAX_ID_LENGTH);
  const tagline = boundedString(value.tagline, MAX_TAGLINE_LENGTH);
  const invocationCount = boundedInteger(value.invocation_count, 0, Number.MAX_SAFE_INTEGER);
  const logoId = boundedString(value.logo_id, MAX_ID_LENGTH);

  return Object.freeze({
    chuteId,
    ...(name ? { name } : {}),
    ...(slug ? { slug } : {}),
    ...(tagline ? { tagline } : {}),
    ...(typeof value.public === "boolean" ? { public: value.public } : {}),
    ...(typeof value.tee === "boolean" ? { tee: value.tee } : {}),
    ...(typeof value.hot === "boolean" ? { hot: value.hot } : {}),
    ...(invocationCount !== undefined ? { invocationCount } : {}),
    ...(logoId ? { logoId } : {}),
    pricing: parseManagementPricing(value.current_estimated_price),
  });
}

function parseInferencePricing(value: Record<string, unknown>): ParsedPrice {
  const pricing = isRecord(value.pricing) ? value.pricing : undefined;
  const price = isRecord(value.price) ? value.price : undefined;
  const priceInput = price && isRecord(price.input) ? price.input : undefined;
  const priceOutput = price && isRecord(price.output) ? price.output : undefined;
  const priceCache = price && isRecord(price.input_cache_read) ? price.input_cache_read : undefined;

  const flatInput = unitPrice(pricing?.prompt);
  const flatOutput = unitPrice(pricing?.completion);
  const flatCache = unitPrice(pricing?.input_cache_read);
  const nestedInput = unitPrice(priceInput?.usd);
  const nestedOutput = unitPrice(priceOutput?.usd);
  const nestedCache = unitPrice(priceCache?.usd);
  return Object.freeze({
    input: Object.freeze({
      ...(flatInput ?? nestedInput) !== undefined ? { usdPerMillion: flatInput ?? nestedInput } : {},
      ...(unitPrice(priceInput?.tao) !== undefined ? { taoPerMillion: unitPrice(priceInput?.tao) } : {}),
    }),
    output: Object.freeze({
      ...(flatOutput ?? nestedOutput) !== undefined ? { usdPerMillion: flatOutput ?? nestedOutput } : {},
      ...(unitPrice(priceOutput?.tao) !== undefined ? { taoPerMillion: unitPrice(priceOutput?.tao) } : {}),
    }),
    inputCacheRead: Object.freeze({
      ...(flatCache ?? nestedCache) !== undefined ? { usdPerMillion: flatCache ?? nestedCache } : {},
      ...(unitPrice(priceCache?.tao) !== undefined ? { taoPerMillion: unitPrice(priceCache?.tao) } : {}),
    }),
    internallyChanged:
      differs(flatInput, nestedInput) || differs(flatOutput, nestedOutput) || differs(flatCache, nestedCache),
  });
}

function parseManagementPricing(value: unknown): ParsedPrice {
  const pricing = isRecord(value) ? value : undefined;
  const perMillion = pricing && isRecord(pricing.per_million_tokens)
    ? pricing.per_million_tokens
    : undefined;
  return Object.freeze({
    input: nestedUnitPrice(perMillion?.input),
    output: nestedUnitPrice(perMillion?.output),
    inputCacheRead: nestedUnitPrice(perMillion?.input_cache_read),
    internallyChanged: false,
  });
}

function mergeModel(
  model: ParsedInferenceModel,
  chute?: ParsedManagementChute,
  telemetry?: ModelOperationalTelemetry,
): AirshipModel {
  const pricing = mergePricing(model.pricing, chute?.pricing);
  const confidentialCompute = claimState(model.confidentialCompute);
  const teeDeployment = claimState(chute?.tee);
  const consistency =
    confidentialCompute === "unknown" || teeDeployment === "unknown"
      ? "partial"
      : confidentialCompute === teeDeployment
        ? "consistent"
        : "conflict";
  const readiness =
    consistency === "conflict"
      ? "conflict"
      : confidentialCompute === "asserted"
        ? "candidate"
        : "not-ready";
  const availability: ModelAvailability =
    chute?.hot === true ? "hot" : chute?.hot === false ? "cold" : "unknown";
  const provider = model.id.includes("/") ? model.id.slice(0, model.id.indexOf("/")) : "unknown";
  const tags = declaredTags(model);

  return Object.freeze({
    id: model.id,
    chuteId: model.chuteId,
    ...(model.root ? { root: model.root } : {}),
    provider,
    ...(model.engine ? { engine: model.engine } : {}),
    ...(model.quantization ? { quantization: model.quantization } : {}),
    ...(model.created !== undefined ? { created: model.created } : {}),
    ...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
    ...(model.maxModelTokens !== undefined ? { maxModelTokens: model.maxModelTokens } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    inputModalities: model.inputModalities,
    outputModalities: model.outputModalities,
    features: model.features,
    samplingParameters: model.samplingParameters,
    tags,
    pricing,
    availability,
    ...(chute?.public !== undefined ? { public: chute.public } : {}),
    ...(chute?.slug ? { slug: chute.slug } : {}),
    ...(chute?.tagline ? { tagline: chute.tagline } : {}),
    ...(chute?.invocationCount !== undefined ? { invocationCount: chute.invocationCount } : {}),
    ...(telemetry ? { telemetry } : {}),
    ...(chute?.logoId ? { logoId: chute.logoId } : {}),
    trust: Object.freeze({
      confidentialCompute,
      teeDeployment,
      consistency,
      e2ee: readiness,
      attestation: readiness,
      verification: "unverified",
      ...(readiness === "candidate"
        ? { evidencePath: `/chutes/${encodeURIComponent(model.chuteId)}/evidence` }
        : {}),
    }),
    provenance: Object.freeze({
      identity: "llm-models",
      capabilities: model.capabilitiesComplete ? "llm-models" : "partial",
      pricing: pricing.authority,
      availability: chute?.hot === undefined ? "unavailable" : "chutes-management",
      provider: "inferred-from-model-id",
      runtimeOwner: model.engine ? "llm-models" : "unavailable",
      tags: "derived-from-declared-metadata",
      popularity: telemetry?.freshness === "fresh" && Object.keys(telemetry.requests).length > 0
        ? "chutes-utilization"
        : chute?.invocationCount === undefined ? "unavailable" : "chutes-management",
      utilization: telemetry ? "chutes-utilization" : "unavailable",
    }),
  });
}

function declaredTags(model: ParsedInferenceModel): readonly string[] {
  return Object.freeze([...new Set([
    ...model.features.map((value) => `feature:${value.toLowerCase()}`),
    ...model.inputModalities.map((value) => `input:${value.toLowerCase()}`),
    ...model.outputModalities.map((value) => `output:${value.toLowerCase()}`),
    ...(model.engine ? [`engine:${model.engine.toLowerCase()}`] : []),
    ...(model.quantization ? [`quantization:${model.quantization.toLowerCase()}`] : []),
  ])].sort(compareText));
}

function mergePricing(primary: ParsedPrice, fallback?: ParsedPrice): ModelTokenPricing {
  const primaryPresent = hasPrice(primary);
  const fallbackPresent = fallback ? hasPrice(fallback) : false;
  const input = mergeUnitPrice(primary.input, fallback?.input);
  const output = mergeUnitPrice(primary.output, fallback?.output);
  const inputCacheRead = mergeUnitPrice(primary.inputCacheRead, fallback?.inputCacheRead);
  const usedFallback = fallback
    ? unitUsesFallback(primary.input, fallback.input) ||
      unitUsesFallback(primary.output, fallback.output) ||
      unitUsesFallback(primary.inputCacheRead, fallback.inputCacheRead)
    : false;
  const changed =
    primary.internallyChanged ||
    (primaryPresent && fallbackPresent &&
      (unitChanged(primary.input, fallback!.input) ||
        unitChanged(primary.output, fallback!.output) ||
        unitChanged(primary.inputCacheRead, fallback!.inputCacheRead)));
  return Object.freeze({
    input,
    output,
    inputCacheRead,
    authority: primaryPresent
      ? usedFallback ? "mixed" : "llm-models"
      : fallbackPresent ? "chutes-management" : "unavailable",
    consistency: changed ? "changed" : primaryPresent && fallbackPresent ? "consistent" : "partial",
  });
}

function nestedUnitPrice(value: unknown): TokenUnitPrice {
  const record = isRecord(value) ? value : undefined;
  const usd = unitPrice(record?.usd);
  const tao = unitPrice(record?.tao);
  return Object.freeze({
    ...(usd !== undefined ? { usdPerMillion: usd } : {}),
    ...(tao !== undefined ? { taoPerMillion: tao } : {}),
  });
}

function mergeUnitPrice(primary: TokenUnitPrice, fallback?: TokenUnitPrice): TokenUnitPrice {
  return Object.freeze({
    ...(primary.usdPerMillion ?? fallback?.usdPerMillion) !== undefined
      ? { usdPerMillion: primary.usdPerMillion ?? fallback?.usdPerMillion }
      : {},
    ...(primary.taoPerMillion ?? fallback?.taoPerMillion) !== undefined
      ? { taoPerMillion: primary.taoPerMillion ?? fallback?.taoPerMillion }
      : {},
  });
}

function hasPrice(value: ParsedPrice): boolean {
  return [value.input, value.output, value.inputCacheRead].some(
    (unit) => unit.usdPerMillion !== undefined || unit.taoPerMillion !== undefined,
  );
}

function unitChanged(left: TokenUnitPrice, right: TokenUnitPrice): boolean {
  return differs(left.usdPerMillion, right.usdPerMillion) || differs(left.taoPerMillion, right.taoPerMillion);
}

function unitUsesFallback(primary: TokenUnitPrice, fallback: TokenUnitPrice): boolean {
  return (primary.usdPerMillion === undefined && fallback.usdPerMillion !== undefined) ||
    (primary.taoPerMillion === undefined && fallback.taoPerMillion !== undefined);
}

function differs(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return Math.abs(left - right) > Math.max(1e-9, Math.abs(left) * 1e-6);
}

function claimState(value: boolean | undefined): ClaimState {
  return value === true ? "asserted" : value === false ? "denied" : "unknown";
}

function tokenLimit(value: unknown): number | undefined {
  return boundedInteger(value, 1, MAX_TOKEN_LIMIT);
}

function unitPrice(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_UNIT_PRICE
    ? value
    : undefined;
}


function stringList(value: unknown): { items: readonly string[]; valid: boolean } {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITY_ITEMS) {
    return { items: Object.freeze([]), valid: false };
  }
  const items: string[] = [];
  const seen = new Set<string>();
  let valid = true;
  for (const item of value) {
    const parsed = boundedString(item, MAX_CAPABILITY_LENGTH);
    if (!parsed) {
      valid = false;
      continue;
    }
    if (!seen.has(parsed)) {
      seen.add(parsed);
      items.push(parsed);
    }
  }
  return { items: Object.freeze(items), valid };
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CatalogPayloadError("invalid-payload", `Chutes ${label} must be a JSON object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
