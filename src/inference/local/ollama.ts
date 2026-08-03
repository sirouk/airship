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
  private readonly capabilityProbeConcurrency: number;

  constructor(options: LocalProviderOptions = {}) {
    const endpoint = resolveLocalEndpoint(options.endpoint ?? OLLAMA_DEFAULT_ENDPOINT, options);
    this.endpoint = endpoint.url;
    this.initialDiagnostics = endpoint.diagnostics;
    this.http = boundedOptions(options);
    this.maxModels = boundedInteger(options.maxModels, 64, 1, 256);
    this.capabilityProbeConcurrency = boundedInteger(options.capabilityProbeConcurrency, 4, 1, 16);
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
    const diagnostics: LocalProviderDiagnostic[] = [...this.initialDiagnostics];
    const normalizedRecords = records
      .filter(isRecord)
      .map((record) => ({
        record,
        id: stringField(record.model) ?? stringField(record.name),
      }))
      .filter((item): item is { record: Record<string, unknown>; id: string } => !!item.id)
      .filter(({ id }, index, values) => values.findIndex((candidate) => candidate.id === id) === index);
    const models = await parallelMap(
      normalizedRecords,
      this.capabilityProbeConcurrency,
      async ({ id, record }) => {
        if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled.", "AbortError");
        let show: unknown;
        try {
          show = await boundedJson(
            new URL("api/show", this.endpoint),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: id, verbose: false }),
            },
            this.http,
            signal,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          diagnostics.push(providerDiagnostic(
            "model-details-unavailable",
            `Ollama did not provide capability details for ${id}.`,
            { severity: "warning", blocking: false, modelId: id },
          ));
        }
        return modelFromOllama(id, record, show);
      },
    );
    return Object.freeze({
      provider: this.kind,
      endpoint: this.endpoint.origin,
      fetchedAt: new Date().toISOString(),
      models: Object.freeze(models),
      diagnostics: Object.freeze(diagnostics),
      complete: payload.models.length <= this.maxModels &&
        !diagnostics.some((item) => item.code === "model-details-unavailable"),
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
  rawShow: unknown,
): LocalModelDescriptor {
  const show = isRecord(rawShow) ? rawShow : undefined;
  const details = isRecord(show?.details) ? show.details : isRecord(tags.details) ? tags.details : undefined;
  const rawCapabilities = Array.isArray(show?.capabilities)
    ? show.capabilities.filter((item): item is string => typeof item === "string").map(normalize)
    : undefined;
  const modelInfo = isRecord(show?.model_info) ? show.model_info : undefined;
  return Object.freeze({
    id,
    provider: "ollama",
    state: "unknown",
    capabilities: Object.freeze([
      capability("text-generation", rawCapabilities, ["completion"], "/api/show:capabilities"),
      capability("tools", rawCapabilities, ["tools"], "/api/show:capabilities"),
      capability("vision", rawCapabilities, ["vision"], "/api/show:capabilities"),
      capability("embeddings", rawCapabilities, ["embedding"], "/api/show:capabilities"),
      capability("thinking", rawCapabilities, ["thinking"], "/api/show:capabilities"),
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

async function parallelMap<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        result[index] = await operation(values[index]!);
      }
    },
  ));
  return result;
}
