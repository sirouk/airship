import type { InferenceTransport } from "../../core/contracts";
import type {
  InferenceModelDescriptor,
  ModelCapability,
  ModelCapabilityEvidence,
} from "../providers/contracts";
import type {
  BrowserLocalModelProvider,
  CapabilityState,
  LocalModelDescriptor,
  LocalModelDiscovery,
} from "./contracts";

/**
 * A local provider may be connected with several different model kinds in its
 * directory (for example, an embedding model alongside chat models). Never
 * choose by catalog order or by a model-name convention. Automatic activation
 * is only unambiguous when the provider returned exactly one model and its own
 * evidence says that model accepts and produces text.
 */
export function selectSingleTextGenerationModel(
  models: readonly InferenceModelDescriptor[],
): InferenceModelDescriptor | undefined {
  if (models.length !== 1) return undefined;
  const model = models[0];
  return model
    && model.capabilities["text-input"]?.state === "supported"
    && model.capabilities["text-output"]?.state === "supported"
    ? model
    : undefined;
}

export type LocalCatalogBinding = Readonly<{
  connectionId: string;
  connectionGeneration: number;
  providerId: string;
}>;

export type ConnectedLocalProvider = Readonly<{
  discovery: LocalModelDiscovery;
  models: readonly InferenceModelDescriptor[];
  transport: InferenceTransport;
}>;

/**
 * Exact bridge from a browser-local provider into the multi-provider catalog.
 * Discovery and transport share the same provider instance and exact origin.
 */
export async function connectLocalProvider(
  provider: BrowserLocalModelProvider,
  binding: LocalCatalogBinding,
  signal?: AbortSignal,
): Promise<ConnectedLocalProvider> {
  const discovery = await provider.discoverModels(signal);
  return Object.freeze({
    discovery,
    models: toInferenceModelDescriptors(discovery, binding),
    transport: provider.createTransport(),
  });
}

export function toInferenceModelDescriptors(
  discovery: LocalModelDiscovery,
  binding: LocalCatalogBinding,
): readonly InferenceModelDescriptor[] {
  return Object.freeze(discovery.models.map((model) =>
    toInferenceModelDescriptor(model, discovery.fetchedAt, binding)
  ));
}

function toInferenceModelDescriptor(
  model: LocalModelDescriptor,
  observedAt: string,
  binding: LocalCatalogBinding,
): InferenceModelDescriptor {
  const local = new Map(model.capabilities.map((item) => [item.capability, item.state]));
  const textGeneration = local.get("text-generation") ?? "unknown";
  const embeddings = local.get("embeddings") ?? "unknown";
  const capabilities: Partial<Record<ModelCapability, ModelCapabilityEvidence>> = {
    "text-input": evidence(textGeneration, observedAt),
    "text-output": evidence(textGeneration, observedAt),
    "image-input": evidence(local.get("vision") ?? "unknown", observedAt),
    "tool-calling": evidence(local.get("tools") ?? "unknown", observedAt),
    reasoning: evidence(local.get("thinking") ?? "unknown", observedAt),
    embeddings: evidence(embeddings, observedAt),
  };
  return Object.freeze({
    version: 1,
    connectionId: binding.connectionId,
    connectionGeneration: binding.connectionGeneration,
    providerId: binding.providerId,
    id: model.id,
    label: model.id,
    capabilities: Object.freeze(capabilities),
    availability: Object.freeze({
      // A native catalog row means the model is available to the local
      // provider. `not-loaded` is still available through JIT loading.
      state: "available",
      source: "local-discovery",
      observedAt,
      ...(model.state === "loaded" ? { code: "loaded" } : model.state === "not-loaded" ? { code: "jit-load" } : {}),
    }),
    ...(model.contextTokens ? { contextWindowTokens: model.contextTokens } : {}),
    source: Object.freeze({
      kind: "local-discovery",
      observedAt,
    }),
  });
}

function evidence(
  state: CapabilityState,
  observedAt: string,
): ModelCapabilityEvidence {
  return Object.freeze({
    state,
    source: "local-discovery",
    observedAt,
  });
}
