export const CHUTES_LLM_MODELS_URL = "https://llm.chutes.ai/v1/models";
export const CHUTES_API_BASE = "https://api.chutes.ai";

export type ModelCatalogSource = "llm-models" | "chutes-management" | "chutes-utilization";

export type ModelCatalogIssueCode =
  | "network"
  | "timeout"
  | "http"
  | "invalid-content-type"
  | "response-too-large"
  | "invalid-json"
  | "invalid-payload"
  | "invalid-records"
  | "truncated";

export type ModelCatalogIssue = Readonly<{
  source: ModelCatalogSource;
  code: ModelCatalogIssueCode;
  message: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
  count?: number;
}>;

export type ModelSourceState = "fresh" | "failed" | "disabled";

export type ModelCatalogSources = Readonly<{
  inference: ModelSourceState;
  management: ModelSourceState;
  utilization: ModelSourceState;
}>;

export type ModelAvailability = "hot" | "cold" | "unknown";
export type ModelModalityCapability = "supported" | "unsupported" | "unknown";
export type ClaimState = "asserted" | "denied" | "unknown";
export type ClaimConsistency = "consistent" | "partial" | "conflict";
export type ReadinessState = "candidate" | "not-ready" | "conflict";

/**
 * Catalog metadata can make a model eligible for a later proof attempt; it can
 * never prove an endpoint, model artifact, request, or transcript by itself.
 */
export type ModelTrust = Readonly<{
  confidentialCompute: ClaimState;
  teeDeployment: ClaimState;
  consistency: ClaimConsistency;
  e2ee: ReadinessState;
  attestation: ReadinessState;
  verification: "unverified";
  evidencePath?: string;
}>;

export type TokenUnitPrice = Readonly<{
  usdPerMillion?: number;
  taoPerMillion?: number;
}>;

export type ModelTokenPricing = Readonly<{
  input: TokenUnitPrice;
  output: TokenUnitPrice;
  inputCacheRead: TokenUnitPrice;
  authority: "llm-models" | "chutes-management" | "mixed" | "unavailable";
  consistency: "consistent" | "partial" | "changed";
}>;

export type ModelFieldProvenance = Readonly<{
  identity: "llm-models" | "local-discovery";
  capabilities: "llm-models" | "partial" | "local-discovery";
  pricing: ModelTokenPricing["authority"];
  availability: "chutes-management" | "unavailable";
  provider: "inferred-from-model-id" | "local-discovery";
  runtimeOwner: "llm-models" | "unavailable";
  tags: "derived-from-declared-metadata";
  popularity: "chutes-utilization" | "chutes-management" | "unavailable";
  utilization: "chutes-utilization" | "unavailable";
}>;

/** Advisory provider telemetry. It is never attestation evidence or a trust input. */
export type ModelOperationalTelemetry = Readonly<{
  observedAt: string;
  freshness: "fresh" | "stale" | "future";
  utilization: Readonly<{
    current?: number;
    fiveMinutes?: number;
    fifteenMinutes?: number;
    oneHour?: number;
  }>;
  rateLimitRatio: Readonly<{
    fiveMinutes?: number;
    fifteenMinutes?: number;
    oneHour?: number;
  }>;
  requests: Readonly<{
    fiveMinutes?: number;
    fifteenMinutes?: number;
    oneHour?: number;
  }>;
  instances: Readonly<{
    active?: number;
    total?: number;
    target?: number;
    scalable?: boolean;
    scaleAllowance?: number;
  }>;
}>;

export type AirshipModel = Readonly<{
  /** Exact value accepted by the shared OpenAI-compatible LLM gateway. */
  id: string;
  chuteId: string;
  root?: string;
  provider: string;
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
  /** Namespaced, deterministic facets derived only from declared metadata. */
  tags: readonly string[];
  pricing: ModelTokenPricing;
  availability: ModelAvailability;
  public?: boolean;
  slug?: string;
  tagline?: string;
  invocationCount?: number;
  telemetry?: ModelOperationalTelemetry;
  /** Chutes logo asset id; the rendered URL is https://logos.chutes.ai/logos/{logoId}.webp. */
  logoId?: string;
  trust: ModelTrust;
  provenance: ModelFieldProvenance;
}>;

export type ModelCatalogSnapshot = Readonly<{
  fetchedAt: string;
  cache: "network" | "memory" | "stale-memory";
  models: readonly AirshipModel[];
  inferenceRecords: number;
  managementRecords?: number;
  managementTotal?: number;
  utilizationRecords?: number;
  sources: ModelCatalogSources;
  issues: readonly ModelCatalogIssue[];
  complete: boolean;
}>;

export type ModelConfidentialityFilter = "any" | "required" | "excluded";

export type ModelCapabilityFilter = Readonly<{
  query?: string;
  features?: readonly string[];
  inputModalities?: readonly string[];
  outputModalities?: readonly string[];
  samplingParameters?: readonly string[];
  minContextTokens?: number;
  minOutputTokens?: number;
  maxInputUsdPerMillion?: number;
  maxOutputUsdPerMillion?: number;
  confidentialCompute?: ModelConfidentialityFilter;
  requireE2eeCandidate?: boolean;
  requireAttestationCandidate?: boolean;
  availability?: readonly ModelAvailability[];
  tags?: readonly string[];
  minInvocationCount?: number;
  maxUtilizationOneHour?: number;
}>;

export type ModelSort =
  | "recommended"
  | "popularity"
  | "utilization"
  | "price"
  | "context"
  | "name";

export type ModelPopularitySignal = Readonly<{
  value: number;
  basis: "requests-one-hour" | "requests-fifteen-minutes" | "requests-five-minutes" | "lifetime-invocations";
  source: "chutes-utilization" | "chutes-management";
  observedAt?: string;
}>;

export type ModelSelectionPolicy = Readonly<{
  requirements?: ModelCapabilityFilter;
  /** Exact IDs, evaluated in caller-specified order. */
  preferredModelIds?: readonly string[];
  /** Used after preferred IDs, before deterministic policy ranking. */
  defaultModelId?: string;
  /** Weight used only for deterministic price ranking. Defaults to 0.8. */
  inputPriceWeight?: number;
}>;

export type ModelSelectionReason =
  | "preferred"
  | "configured-default"
  | "deterministic-fallback"
  | "no-compatible-model";

export type ModelSelection = Readonly<{
  model?: AirshipModel;
  reason: ModelSelectionReason;
  compatible: readonly AirshipModel[];
  rejectedPreferredModelIds: readonly string[];
}>;
