import {
  MAX_MODEL_CONTEXT_WINDOW_TOKENS,
  MAX_MODEL_OUTPUT_TOKENS,
  MODEL_CAPABILITIES,
  type InferenceModelDescriptor,
  type ModelAvailability,
  type ModelCapability,
  type ModelCapabilityEvidence,
  type ModelCatalogSnapshot,
} from "./contracts";
import type { InferenceProviderCatalog } from "./provider-catalog";
import {
  boundedText,
  canonicalTimestamp,
  deepFreeze,
  httpsUrl,
  identifier,
  opaqueIdentifier,
  optionalCode,
  positiveInteger,
} from "./validation";

const MODEL_CAPABILITY_SET = new Set(MODEL_CAPABILITIES);

export class InferenceModelCatalog {
  readonly #modelsByConnection = new Map<
    string,
    Readonly<{
      providerId: string;
      generation: number;
      models: Map<string, InferenceModelDescriptor>;
    }>
  >();
  #revision = 0;

  constructor(readonly providers: InferenceProviderCatalog) {}

  replaceConnectionModels(
    connectionIdValue: string,
    connectionGenerationValue: number,
    providerId: string,
    rawModels: readonly InferenceModelDescriptor[],
  ): ModelCatalogSnapshot {
    this.providers.require(providerId);
    const connectionId = identifier(connectionIdValue, "Model connection ID");
    const connectionGeneration = positiveInteger(
      connectionGenerationValue,
      "Model connection generation",
      Number.MAX_SAFE_INTEGER,
    );
    if (!Array.isArray(rawModels) || rawModels.length > 10_000) {
      throw new TypeError("The connection model directory is too large.");
    }
    const models = new Map<string, InferenceModelDescriptor>();
    for (const rawModel of rawModels) {
      if (rawModel.providerId !== providerId) {
        throw new TypeError("A model directory cannot contain another provider's models.");
      }
      if (rawModel.connectionId !== connectionId) {
        throw new TypeError("A model directory cannot contain another connection's models.");
      }
      if (rawModel.connectionGeneration !== connectionGeneration) {
        throw new TypeError(
          "A model directory cannot contain another credential generation's models.",
        );
      }
      const model = normalizeModel(rawModel);
      if (models.has(model.id)) throw new TypeError("Model IDs must be unique per connection.");
      models.set(model.id, model);
    }
    this.#modelsByConnection.set(connectionId, {
      providerId,
      generation: connectionGeneration,
      models,
    });
    this.#revision += 1;
    return this.snapshot();
  }

  get(
    connectionId: string,
    connectionGeneration: number,
    modelId: string,
  ): InferenceModelDescriptor | undefined {
    const entry = this.#modelsByConnection.get(connectionId);
    return entry?.generation === connectionGeneration
      ? entry.models.get(modelId)
      : undefined;
  }

  require(
    connectionId: string,
    connectionGeneration: number,
    modelId: string,
  ): InferenceModelDescriptor {
    const model = this.get(connectionId, connectionGeneration, modelId);
    if (!model) {
      throw new Error(
        `Inference model ${connectionId}@${connectionGeneration}/${modelId} is not cataloged.`,
      );
    }
    return model;
  }

  forConnection(
    connectionId: string,
    connectionGeneration: number,
  ): readonly InferenceModelDescriptor[] {
    const entry = this.#modelsByConnection.get(connectionId);
    return Object.freeze(
      [...(entry?.generation === connectionGeneration ? entry.models.values() : [])]
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  clearConnection(connectionIdValue: string): boolean {
    const connectionId = identifier(connectionIdValue, "Model connection ID");
    const deleted = this.#modelsByConnection.delete(connectionId);
    if (deleted) this.#revision += 1;
    return deleted;
  }

  snapshot(): ModelCatalogSnapshot {
    return deepFreeze({
      version: 1,
      revision: this.#revision,
      models: [...this.#modelsByConnection.values()]
        .flatMap((entry) => [...entry.models.values()])
        .sort((left, right) =>
          left.connectionId.localeCompare(right.connectionId) || left.id.localeCompare(right.id)
        ),
    }) as ModelCatalogSnapshot;
  }
}

export function normalizeModel(raw: InferenceModelDescriptor): InferenceModelDescriptor {
  if (!raw || typeof raw !== "object" || raw.version !== 1) {
    throw new TypeError("Inference model metadata has an unsupported version.");
  }
  const capabilities: Partial<Record<ModelCapability, ModelCapabilityEvidence>> = {};
  for (const [key, value] of Object.entries(raw.capabilities)) {
    if (!MODEL_CAPABILITY_SET.has(key as ModelCapability) || !value) {
      throw new TypeError("Model capability metadata is invalid.");
    }
    capabilities[key as ModelCapability] = normalizeCapabilityEvidence(value);
  }
  const contextWindowTokens = raw.contextWindowTokens === undefined
    ? undefined
    : positiveInteger(
      raw.contextWindowTokens,
      "Model context window",
      MAX_MODEL_CONTEXT_WINDOW_TOKENS,
    );
  /*
   * The output ceiling is bounded by the same constant the cloud transports
   * enforce at request time, so a declaration this catalog accepts can never
   * be one the next request rejects.
   */
  const maxOutputTokens = raw.maxOutputTokens === undefined
    ? undefined
    : positiveInteger(raw.maxOutputTokens, "Model maximum output", MAX_MODEL_OUTPUT_TOKENS);
  const observedAt = canonicalTimestamp(raw.source.observedAt, "Model source timestamp");
  const sourceKinds = new Set(["provider-directory", "live-probe", "manual", "local-discovery"]);
  if (!sourceKinds.has(raw.source.kind)) throw new TypeError("The model source kind is invalid.");

  return deepFreeze({
    version: 1,
    connectionId: identifier(raw.connectionId, "Model connection ID"),
    connectionGeneration: positiveInteger(
      raw.connectionGeneration,
      "Model connection generation",
      Number.MAX_SAFE_INTEGER,
    ),
    providerId: opaqueIdentifier(raw.providerId, "Model provider ID"),
    id: opaqueIdentifier(raw.id, "Model ID"),
    label: boundedText(raw.label, "Model label", 256),
    capabilities,
    availability: normalizeAvailability(raw.availability),
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    source: {
      kind: raw.source.kind,
      observedAt,
      ...(raw.source.sourceUrl
        ? { sourceUrl: httpsUrl(raw.source.sourceUrl, "Model source URL") }
        : {}),
    },
  }) as InferenceModelDescriptor;
}

function normalizeCapabilityEvidence(raw: ModelCapabilityEvidence): ModelCapabilityEvidence {
  const states = new Set(["supported", "unsupported", "unknown"]);
  const sources = new Set(["provider-directory", "live-probe", "manual", "local-discovery"]);
  if (!states.has(raw.state) || !sources.has(raw.source)) {
    throw new TypeError("Model capability evidence is invalid.");
  }
  return deepFreeze({
    state: raw.state,
    source: raw.source,
    ...(raw.observedAt
      ? { observedAt: canonicalTimestamp(raw.observedAt, "Capability observation timestamp") }
      : {}),
  });
}

function normalizeAvailability(raw: ModelAvailability): ModelAvailability {
  const states = new Set(["available", "unavailable", "unknown"]);
  const sources = new Set(["provider-directory", "live-probe", "manual", "local-discovery"]);
  if (!states.has(raw.state) || !sources.has(raw.source)) {
    throw new TypeError("Model availability evidence is invalid.");
  }
  const code = optionalCode(raw.code, "Model availability code");
  return deepFreeze({
    state: raw.state,
    source: raw.source,
    ...(raw.observedAt
      ? { observedAt: canonicalTimestamp(raw.observedAt, "Model availability timestamp") }
      : {}),
    ...(code ? { code } : {}),
  });
}
