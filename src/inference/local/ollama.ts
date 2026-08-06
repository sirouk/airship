import type {
  BrowserLocalModelProvider,
  LocalCapabilityEvidence,
  LocalModelDescriptor,
  LocalModelDiscovery,
  LocalProviderDiagnostic,
  LocalProviderHealth,
  LocalProviderOptions,
} from "./contracts";
import { LocalProviderError, directFetchDiagnostic, providerDiagnostic, resolveLocalEndpoint } from "./endpoint-policy";
import { boundedInteger, boundedJson, boundedOptions, isRecord, LOCAL_GENERATION_BUDGET_MS } from "./http";
import { LocalOpenAiTransport } from "./openai-transport";

export const OLLAMA_DEFAULT_ENDPOINT = "http://127.0.0.1:11434";

export class OllamaBrowserProvider implements BrowserLocalModelProvider {
  readonly kind = "ollama" as const;
  readonly endpoint: URL;
  private readonly initialDiagnostics: readonly LocalProviderDiagnostic[];
  private readonly http: ReturnType<typeof boundedOptions>;
  private readonly maxModels: number;

  constructor(options: LocalProviderOptions = {}) {
    const endpoint = resolveLocalEndpoint(options.endpoint ?? OLLAMA_DEFAULT_ENDPOINT, options);
    this.endpoint = endpoint.url;
    this.initialDiagnostics = endpoint.diagnostics;
    this.http = boundedOptions(options);
    this.maxModels = boundedInteger(options.maxModels, 64, 1, 256);
  }

  async probeHealth(signal = new AbortController().signal): Promise<LocalProviderHealth> {
    rejectBlocking(this.initialDiagnostics);
    const payload = await boundedJson(
      new URL("api/version", this.endpoint),
      { method: "GET" },
      this.http,
      signal,
    );
    if (!isRecord(payload)) throw invalidPayload("Ollama /api/version did not return an object.");
    const version = stringField(payload.version);
    return Object.freeze({
      provider: this.kind,
      endpoint: this.endpoint.origin,
      state: "ready",
      checkedAt: new Date().toISOString(),
      ...(version ? { version } : {}),
      cors: "confirmed",
    });
  }

  async discoverModels(signal = new AbortController().signal): Promise<LocalModelDiscovery> {
    rejectBlocking(this.initialDiagnostics);
    let payload: unknown;
    try {
      payload = await boundedJson(
        new URL("api/tags", this.endpoint),
        { method: "GET" },
        this.http,
        signal,
      );
    } catch (error) {
      if (error instanceof LocalProviderError) throw error;
      throw new LocalProviderError(directFetchDiagnostic(error), { cause: error });
    }
    if (!isRecord(payload) || !Array.isArray(payload.models)) {
      throw invalidPayload("Ollama /api/tags did not return a models array.");
    }

    const records = payload.models.slice(0, this.maxModels);
    const normalizedRecords = records
      .filter(isRecord)
      .map((record) => ({
        record,
        id: stringField(record.model) ?? stringField(record.name),
      }))
      .filter((item): item is { record: Record<string, unknown>; id: string } => !!item.id)
      .filter(({ id }, index, values) => values.findIndex((candidate) => candidate.id === id) === index);
    /*
     * `/api/tags` is the provider's advertised directory. Do not follow it
     * with one `/api/show` request per row: `show` can load a model into
     * Ollama's runtime, so a directory refresh could page every installed
     * model into memory before the person has chosen one. Keep only fields
     * the directory itself returned; capability evidence that is not present
     * there remains unknown and is checked only for the model the person
     * explicitly activates.
     */
    const models = normalizedRecords.map(({ id, record }) => modelFromOllama(id, record));
    return Object.freeze({
      provider: this.kind,
      endpoint: this.endpoint.origin,
      fetchedAt: new Date().toISOString(),
      models: Object.freeze(models),
      diagnostics: this.initialDiagnostics,
      complete: payload.models.length <= this.maxModels,
    });
  }

  createTransport(): LocalOpenAiTransport {
    rejectBlocking(this.initialDiagnostics);
    return new LocalOpenAiTransport({
      id: "ollama-openai-local-v1",
      endpoint: this.endpoint,
      credential: this.http.credential,
      fetch: this.http.fetchImpl,
      // The probe budget is not the generation budget — see
      // `LOCAL_GENERATION_BUDGET_MS`, and the 30-second cap it replaced.
      totalTimeoutMs: LOCAL_GENERATION_BUDGET_MS,
      maxStreamBytes: this.http.maxResponseBytes * 16,
    });
  }
}

function modelFromOllama(
  id: string,
  tags: Record<string, unknown>,
): LocalModelDescriptor {
  const details = isRecord(tags.details) ? tags.details : undefined;
  const rawCapabilities = Array.isArray(tags.capabilities)
    ? tags.capabilities.filter((item): item is string => typeof item === "string").map(normalize)
    : undefined;
  const modelInfo = isRecord(tags.model_info) ? tags.model_info : undefined;
  return Object.freeze({
    id,
    provider: "ollama",
    state: "unknown",
    capabilities: Object.freeze([
      capability("text-generation", rawCapabilities, ["completion"], "/api/tags:capabilities"),
      capability("tools", rawCapabilities, ["tools"], "/api/tags:capabilities"),
      capability("vision", rawCapabilities, ["vision"], "/api/tags:capabilities"),
      capability("embeddings", rawCapabilities, ["embedding"], "/api/tags:capabilities"),
      capability("thinking", rawCapabilities, ["thinking"], "/api/tags:capabilities"),
    ]),
    ...optional("contextTokens", contextLength(modelInfo)),
    ...optional("format", stringField(details?.format)),
    ...optional("architecture", stringField(details?.family)),
    ...optional("quantization", stringField(details?.quantization_level)),
    ...optional("parameterSize", stringField(details?.parameter_size)),
    ...optional("sizeBytes", nonNegativeInteger(tags.size)),
    ...optional("digest", stringField(tags.digest)),
    ...optional("modifiedAt", stringField(tags.modified_at)),
  });
}

function contextLength(info: Record<string, unknown> | undefined): number | undefined {
  if (!info) return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length")) {
      const count = nonNegativeInteger(value);
      if (count) return count;
    }
  }
  return undefined;
}

function capability(
  name: LocalCapabilityEvidence["capability"],
  values: string[] | undefined,
  supportedNames: string[],
  source: string,
): LocalCapabilityEvidence {
  return Object.freeze({
    capability: name,
    state: values ? (supportedNames.some((item) => values.includes(item)) ? "supported" : "unsupported") : "unknown",
    source,
  });
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function invalidPayload(message: string): LocalProviderError {
  return new LocalProviderError(providerDiagnostic("invalid-payload", message));
}

function rejectBlocking(diagnostics: readonly LocalProviderDiagnostic[]): void {
  const blocking = diagnostics.find((item) => item.blocking);
  if (blocking) throw new LocalProviderError(blocking);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.trim().length <= 512
    ? value.trim()
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}
