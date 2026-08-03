import type {
  BrowserLocalModelProvider,
  LocalCapabilityEvidence,
  LocalModelDescriptor,
  LocalModelDiscovery,
  LocalProviderDiagnostic,
  LocalProviderHealth,
  LocalProviderOptions,
} from "./contracts";
import { LocalProviderError, providerDiagnostic, resolveLocalEndpoint } from "./endpoint-policy";
import { boundedInteger, boundedJson, boundedOptions, isRecord, LOCAL_GENERATION_BUDGET_MS } from "./http";
import { LocalOpenAiTransport } from "./openai-transport";

export const LM_STUDIO_DEFAULT_ENDPOINT = "http://127.0.0.1:1234";

export class LmStudioBrowserProvider implements BrowserLocalModelProvider {
  readonly kind = "lm-studio" as const;
  readonly endpoint: URL;
  private readonly initialDiagnostics: readonly LocalProviderDiagnostic[];
  private readonly http: ReturnType<typeof boundedOptions>;
  private readonly maxModels: number;

  constructor(options: LocalProviderOptions = {}) {
    const endpoint = resolveLocalEndpoint(options.endpoint ?? LM_STUDIO_DEFAULT_ENDPOINT, options);
    this.endpoint = endpoint.url;
    this.initialDiagnostics = endpoint.diagnostics;
    this.http = boundedOptions(options);
    this.maxModels = boundedInteger(options.maxModels, 128, 1, 512);
  }

  async probeHealth(signal = new AbortController().signal): Promise<LocalProviderHealth> {
    rejectBlocking(this.initialDiagnostics);
    const catalog = await loadLmStudioCatalog(this.endpoint, this.http, signal);
    if (
      !isRecord(catalog.payload)
      || !Array.isArray(catalog.version === "v1" ? catalog.payload.models : catalog.payload.data)
    ) {
      throw new LocalProviderError(providerDiagnostic(
        "invalid-payload",
        `LM Studio /api/${catalog.version}/models did not return its documented model array.`,
      ));
    }
    return Object.freeze({
      provider: this.kind,
      endpoint: this.endpoint.origin,
      state: "ready",
      checkedAt: new Date().toISOString(),
      cors: "confirmed",
    });
  }

  async discoverModels(signal = new AbortController().signal): Promise<LocalModelDiscovery> {
    rejectBlocking(this.initialDiagnostics);
    const catalog = await loadLmStudioCatalog(this.endpoint, this.http, signal);
    const records = isRecord(catalog.payload)
      ? catalog.version === "v1" ? catalog.payload.models : catalog.payload.data
      : undefined;
    if (!Array.isArray(records)) {
      throw new LocalProviderError(providerDiagnostic(
        "invalid-payload",
        `LM Studio /api/${catalog.version}/models did not return its documented model array.`,
      ));
    }
    const models = records
      .slice(0, this.maxModels)
      .filter(isRecord)
      .map(catalog.version === "v1" ? modelFromLmStudioV1 : modelFromLmStudioV0)
      .filter((model): model is LocalModelDescriptor => !!model)
      .filter((model, index, values) => values.findIndex((candidate) => candidate.id === model.id) === index);
    return Object.freeze({
      provider: this.kind,
      endpoint: this.endpoint.origin,
      fetchedAt: new Date().toISOString(),
      models: Object.freeze(models),
      diagnostics: this.initialDiagnostics,
      complete: records.length <= this.maxModels,
    });
  }

  createTransport(): LocalOpenAiTransport {
    rejectBlocking(this.initialDiagnostics);
    return new LocalOpenAiTransport({
      id: "lm-studio-openai-local-v1",
      endpoint: this.endpoint,
      credential: this.http.credential,
      fetch: this.http.fetchImpl,
      // Not `this.http.timeoutMs`. That is the catalog-probe budget — 30 s by
      // default — and handing it to a streaming generation hard-capped every
      // local answer at 30 seconds of wall clock, measured killing an
      // unattended turn at t+32 s with 93 lines already on screen. A 35B model
      // on consumer hardware routinely needs more, and no surface in the
      // product raised the ceiling. A generation is not a probe.
      totalTimeoutMs: LOCAL_GENERATION_BUDGET_MS,
      maxStreamBytes: this.http.maxResponseBytes * 16,
    });
  }
}

function modelFromLmStudioV0(value: Record<string, unknown>): LocalModelDescriptor | undefined {
  const id = stringField(value.id);
  if (!id) return undefined;
  const type = stringField(value.type)?.toLowerCase();
  const rawCapabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((item): item is string => typeof item === "string").map(normalize)
    : undefined;
  return Object.freeze({
    id,
    provider: "lm-studio",
    state: value.state === "loaded" ? "loaded" : value.state === "not-loaded" ? "not-loaded" : "unknown",
    capabilities: Object.freeze([
      typeCapability("text-generation", type, rawCapabilities, ["completion", "chat"], ["llm", "vlm"], ["embeddings"]),
      sourceCapability("tools", rawCapabilities, ["tool_use", "tools", "function_calling"]),
      typeCapability("vision", type, rawCapabilities, ["vision"], ["vlm"], ["llm", "embeddings"]),
      typeCapability("embeddings", type, rawCapabilities, ["embedding", "embeddings"], ["embeddings"], ["llm", "vlm"]),
      sourceCapability("thinking", rawCapabilities, ["thinking", "reasoning"]),
    ]),
    ...optional("contextTokens", nonNegativeInteger(value.max_context_length)),
    ...optional("format", stringField(value.compatibility_type)),
    ...optional("architecture", stringField(value.arch)),
    ...optional("quantization", stringField(value.quantization)),
  });
}

function modelFromLmStudioV1(value: Record<string, unknown>): LocalModelDescriptor | undefined {
  const id = stringField(value.key);
  if (!id) return undefined;
  const type = stringField(value.type)?.toLowerCase();
  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
  const reasoning = isRecord(capabilities?.reasoning);
  const loadedInstances = Array.isArray(value.loaded_instances) ? value.loaded_instances : undefined;
  const quantization = isRecord(value.quantization) ? value.quantization : undefined;
  return Object.freeze({
    id,
    provider: "lm-studio",
    state: loadedInstances ? (loadedInstances.length ? "loaded" : "not-loaded") : "unknown",
    capabilities: Object.freeze([
      explicitTypeCapability("text-generation", type, "llm", ["embedding"]),
      explicitBooleanCapability("tools", capabilities?.trained_for_tool_use, "/api/v1/models:capabilities.trained_for_tool_use"),
      explicitBooleanCapability("vision", capabilities?.vision, "/api/v1/models:capabilities.vision"),
      explicitTypeCapability("embeddings", type, "embedding", ["llm"]),
      Object.freeze({
        capability: "thinking" as const,
        state: reasoning ? "supported" as const : capabilities ? "unsupported" as const : "unknown" as const,
        source: "/api/v1/models:capabilities.reasoning",
      }),
    ]),
    ...optional("contextTokens", nonNegativeInteger(value.max_context_length)),
    ...optional("format", stringField(value.format)),
    ...optional("architecture", stringField(value.architecture)),
    ...optional("quantization", stringField(quantization?.name)),
    ...optional("parameterSize", stringField(value.params_string)),
    ...optional("sizeBytes", nonNegativeInteger(value.size_bytes)),
  });
}

function explicitBooleanCapability(
  capability: LocalCapabilityEvidence["capability"],
  value: unknown,
  source: string,
): LocalCapabilityEvidence {
  return Object.freeze({
    capability,
    state: typeof value === "boolean" ? (value ? "supported" : "unsupported") : "unknown",
    source,
  });
}

function explicitTypeCapability(
  capability: LocalCapabilityEvidence["capability"],
  actual: string | undefined,
  supported: string,
  explicitlyUnsupported: readonly string[],
): LocalCapabilityEvidence {
  return Object.freeze({
    capability,
    state: actual === supported
      ? "supported"
      : actual && explicitlyUnsupported.includes(actual)
        ? "unsupported"
        : "unknown",
    source: "/api/v1/models:type",
  });
}

function sourceCapability(
  capability: LocalCapabilityEvidence["capability"],
  raw: string[] | undefined,
  names: string[],
): LocalCapabilityEvidence {
  return Object.freeze({
    capability,
    state: raw ? (names.some((name) => raw.includes(name)) ? "supported" : "unsupported") : "unknown",
    source: "/api/v0/models:capabilities",
  });
}

function typeCapability(
  capability: LocalCapabilityEvidence["capability"],
  type: string | undefined,
  raw: string[] | undefined,
  names: string[],
  supportedTypes: string[],
  unsupportedTypes: string[],
): LocalCapabilityEvidence {
  if (raw && names.some((name) => raw.includes(name))) {
    return Object.freeze({ capability, state: "supported", source: "/api/v0/models:capabilities" });
  }
  if (type) {
    return Object.freeze({
      capability,
      state: supportedTypes.includes(type)
        ? "supported"
        : unsupportedTypes.includes(type)
          ? "unsupported"
          : "unknown",
      source: "/api/v0/models:type",
    });
  }
  return Object.freeze({ capability, state: "unknown", source: "/api/v0/models" });
}

async function loadLmStudioCatalog(
  endpoint: URL,
  http: ReturnType<typeof boundedOptions>,
  signal: AbortSignal,
): Promise<Readonly<{ version: "v1" | "v0"; payload: unknown }>> {
  try {
    return Object.freeze({
      version: "v1" as const,
      payload: await boundedJson(
        new URL("api/v1/models", endpoint),
        { method: "GET" },
        http,
        signal,
      ),
    });
  } catch (error) {
    if (
      !(error instanceof LocalProviderError)
      || error.diagnostic.code !== "http"
      || (error.diagnostic.status !== 404 && error.diagnostic.status !== 405)
    ) {
      throw error;
    }
    return Object.freeze({
      version: "v0" as const,
      payload: await boundedJson(
        new URL("api/v0/models", endpoint),
        { method: "GET" },
        http,
        signal,
      ),
    });
  }
}

function rejectBlocking(diagnostics: readonly LocalProviderDiagnostic[]): void {
  const blocking = diagnostics.find((item) => item.blocking);
  if (blocking) throw new LocalProviderError(blocking);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
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
