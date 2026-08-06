import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "../event-stream";
import { sseRecords } from "../sse";
import { parseJsonWithRepair } from "../stream-json";
import type {
  Api,
  ApiProvider,
  AssistantMessage,
  CacheRetention,
  Context,
  Model,
  OpenAIResponsesCompat,
  ServiceTier,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  Usage,
} from "../types";
import { resolveApiKey, type ApiKeyResolver } from "./api-key";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers";
import { fetchWithRetry, headersToRecord } from "./http";
import { clampThinkingLevel } from "./model-util";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
  type ResponsesInput,
  type ResponsesStreamEvent,
  type ResponsesToolParam,
} from "./openai-responses-shared";
import { buildBaseOptions } from "./simple-options";
import {
  formatStreamFailureMessage,
  recordStreamFailure,
  StreamFailureError,
  streamFailureFromStopReason,
} from "./stream-failure";

/**
 * Port of prime-agent packages/ai/src/providers/openai-responses.ts.
 *
 * The upstream builds requests through the `openai` SDK Responses client;
 * the port speaks fetch + SSE directly. Payload construction, session-cache
 * affinity headers, usage/cost semantics including service-tier pricing, and
 * the full stream lifecycle from ./openai-responses-shared.ts are preserved.
 * Deliberately excluded (see PORT.md): background mode, websocket
 * transports, the codex variant (OAuth), and the azure variant.
 */

const OPENAI_TOOL_CALL_PROVIDERS: ReadonlySet<string> = new Set(["openai", "openai-codex", "opencode"]);

/**
 * Resolve the cache retention preference. Upstream also read the
 * PI_CACHE_RETENTION env var; the browser port has no environment to read.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
  return cacheRetention ?? "short";
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
  return {
    sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
  };
}

function getPromptCacheRetention(compat: Required<OpenAIResponsesCompat>, cacheRetention: CacheRetention): "24h" | undefined {
  return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  /** Host-injected credential lookup; consulted only when apiKey is absent. */
  resolveApiKey?: ApiKeyResolver;
}

/** SimpleStreamOptions plus the browser credential resolver. */
export type OpenAIResponsesSimpleOptions = SimpleStreamOptions & { resolveApiKey?: ApiKeyResolver };

export interface OpenAIResponsesRequestParams {
  model: string;
  input: ResponsesInput;
  stream: true;
  prompt_cache_key?: string;
  prompt_cache_retention?: "24h";
  store?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  service_tier?: Exclude<ServiceTier, null>;
  tools?: ResponsesToolParam[];
  reasoning?: {
    effort: string;
    summary?: "auto" | "detailed" | "concise";
  };
  include?: string[];
  [key: string]: unknown;
}

function buildRequestConfig(
  model: Model<"openai-responses">,
  context: Context,
  apiKey: string,
  optionsHeaders: Record<string, string> | undefined,
  sessionId: string | undefined,
): { url: string; headers: Record<string, string> } {
  const compat = getCompat(model);
  const headers: Record<string, string> = { ...model.headers };

  if (model.provider === "github-copilot") {
    const hasImages = hasCopilotVisionInput(context.messages);
    Object.assign(
      headers,
      buildCopilotDynamicHeaders({
        messages: context.messages,
        hasImages,
      }),
    );
  }

  if (sessionId) {
    if (compat.sendSessionIdHeader) {
      headers.session_id = sessionId;
    }
    headers["x-client-request-id"] = sessionId;
  }

  if (optionsHeaders) {
    // Caller headers merge last so they can override every default.
    Object.assign(headers, optionsHeaders);
  }

  headers["content-type"] = headers["content-type"] ?? "application/json";

  if (model.provider === "cloudflare-ai-gateway") {
    // cf-aig-authorization replaces key-derived Authorization for AI Gateway
    // upstreams; a caller-provided Authorization survives verbatim.
    headers["cf-aig-authorization"] = `Bearer ${apiKey}`;
  } else if (apiKey) {
    headers.Authorization = headers.Authorization ?? `Bearer ${apiKey}`;
  }

  const baseUrl = isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl;
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
  return { url, headers };
}

function buildParams(model: Model<"openai-responses">, context: Context, options?: OpenAIResponsesOptions): OpenAIResponsesRequestParams {
  const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS);

  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const compat = getCompat(model);
  const params: OpenAIResponsesRequestParams = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
    prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
    store: false,
  };

  if (options?.maxTokens) {
    params.max_output_tokens = options.maxTokens;
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  if (options?.serviceTier !== undefined && options.serviceTier !== null) {
    params.service_tier = options.serviceTier;
  }

  if (context.tools && context.tools.length > 0) {
    params.tools = convertResponsesTools(context.tools);
  }

  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoningSummary) {
      const effort = options?.reasoningEffort
        ? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
        : "medium";
      params.reasoning = {
        effort,
        summary: options?.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
      params.reasoning = {
        effort: model.thinkingLevelMap?.off ?? "none",
      };
    }
  }

  return params;
}

function getServiceTierCostMultiplier(model: Pick<Model<"openai-responses">, "id">, serviceTier: ServiceTier | undefined): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return model.id === "gpt-5.5" ? 2.5 : 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(usage: Usage, serviceTier: ServiceTier | undefined, model: Pick<Model<"openai-responses">, "id">): void {
  const multiplier = getServiceTierCostMultiplier(model, serviceTier);
  if (multiplier === 1) return;

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

/**
 * Parse the Responses SSE stream into typed lifecycle events. The `event:`
 * names and the payload `type` fields are redundant; the payload wins.
 */
async function* iterateResponsesEvents(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncGenerator<ResponsesStreamEvent> {
  if (!response.body) {
    throw new Error("Attempted to iterate over an OpenAI responses stream with no body");
  }

  for await (const record of sseRecords(response.body, signal)) {
    const data = record.data;
    if (data === "[DONE]") return;
    if (data.trim().length === 0) continue;
    let event: ResponsesStreamEvent;
    try {
      event = parseJsonWithRepair<ResponsesStreamEvent>(data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new StreamFailureError(`Could not parse OpenAI responses SSE event ${record.event}: ${detail}; data=${data}`, {
        kind: "malformed_response",
      });
    }
    yield event;
  }
}

export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as Api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const apiKey = resolveApiKey(options, model.provider) ?? "";
      if (!apiKey) {
        throw new Error(`${model.provider} API key is required. Pass it via options.apiKey or options.resolveApiKey.`);
      }
      const cacheRetention = resolveCacheRetention(options?.cacheRetention);
      const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
      const request = buildRequestConfig(model, context, apiKey, options?.headers, cacheSessionId);
      let params: Record<string, unknown> = { ...buildParams(model, context, options) };
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as Record<string, unknown>;
      }

      const response = await fetchWithRetry({
        url: request.url,
        headers: request.headers,
        body: params,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
        maxRetries: options?.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs,
      });
      await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
      const requestId = response.headers.get("x-request-id") ?? undefined;
      stream.push({ type: "start", partial: output });

      await processResponsesStream(iterateResponsesEvents(response, options?.signal), output, stream, model, {
        serviceTier: options?.serviceTier,
        applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
      });

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw streamFailureFromStopReason(output.stopReasonRaw, { requestId });
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as { partialJson?: string }).partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatStreamFailureMessage(error);
      recordStreamFailure(model, output, error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesSimpleOptions> = (
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesSimpleOptions,
): AssistantMessageEventStream => {
  const apiKey = resolveApiKey(options, model.provider);
  if (!apiKey) {
    // Config-level failure: allowed to throw synchronously, mirroring
    // upstream. streamSimple() in stream.ts catches it into an error event.
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
  const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

  return streamOpenAIResponses(model, context, {
    ...base,
    reasoningEffort,
  });
};

/**
 * The provider object registered for "openai-responses". The registry
 * resolves providers by model.api, so the api is guaranteed to match — the
 * wrapper only narrows the Model/Options generics.
 */
export const openAIResponsesProvider: ApiProvider = {
  api: "openai-responses",
  stream: (model, context, options) =>
    streamOpenAIResponses(model as Model<"openai-responses">, context, options as OpenAIResponsesOptions | undefined),
  streamSimple: (model, context, options) =>
    streamSimpleOpenAIResponses(
      model as Model<"openai-responses">,
      context,
      options as OpenAIResponsesSimpleOptions | undefined,
    ),
};
