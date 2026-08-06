import { getAnthropicCacheWriteCost, hasStandardAnthropicCachePricing } from "../cost";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "../event-stream";
import { sanitizeSurrogates } from "../sanitize";
import { sseRecords } from "../sse";
import { parseJsonWithRepair, parseStreamingJson } from "../stream-json";
import type {
  Api,
  ApiProvider,
  AssistantMessage,
  CacheRetention,
  Context,
  ImageContent,
  Message,
  Model,
  OpenAICompletionsCompat,
  Provider,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../types";
import { resolveApiKey, type ApiKeyResolver } from "./api-key";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers";
import { fetchWithRetry, headersToRecord } from "./http";
import { applyUsageCost, clampThinkingLevel } from "./model-util";
import { buildBaseOptions } from "./simple-options";
import { recordStreamFailure, StreamFailureError } from "./stream-failure";
import { transformMessages } from "./transform";

/**
 * Port of prime-agent packages/ai/src/providers/openai-completions.ts.
 *
 * The upstream builds requests through the `openai` SDK; the port speaks
 * fetch directly (fetch + SSE in ./http.ts and ../sse.ts). Payload shape,
 * the auto-detection compat table, message transformation, SSE event
 * mapping, and usage/cost semantics are preserved one-to-one, with these
 * documented deltas:
 *
 *  - API keys come from options.apiKey or an injected resolveApiKey
 *    resolver, never process.env. The PI_CACHE_RETENTION env fallback and
 *    the prime-inference X-Prime-Team-ID env header are gone.
 *  - Three compat knobs are excluded because this library's
 *    OpenAICompletionsCompat does not declare them: openRouterRouting,
 *    vercelGatewayRouting, zaiToolStream. See PORT.md.
 *  - Cloudflare baseUrl `{VAR}` placeholders fail closed (see cloudflare.ts).
 *  - Terminal failures additionally record a provider_stream_failure
 *    diagnostic — the deliberate normalization of upstream's inconsistency
 *    (only anthropic/responses recorded diagnostics upstream).
 */

export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Host-injected credential lookup; consulted only when apiKey is absent. */
  resolveApiKey?: ApiKeyResolver;
}

/** SimpleStreamOptions plus the browser credential resolver and tool choice passthrough. */
export type OpenAICompletionsSimpleOptions = SimpleStreamOptions & {
  resolveApiKey?: ApiKeyResolver;
  toolChoice?: OpenAICompletionsOptions["toolChoice"];
};

interface OpenAICompatCacheControl {
  type: "ephemeral";
  ttl?: string;
}

type ResolvedOpenAICompletionsCompat = Omit<Required<OpenAICompletionsCompat>, "cacheControlFormat"> & {
  cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

// ---------------------------------------------------------------------------
// Wire payload types (OpenAI Chat Completions plus compatible-provider
// extensions, which travel through the index signature as upstream's
// `(params as any)` writes did)
// ---------------------------------------------------------------------------

interface ChatCompletionTextPart {
  type: "text";
  text: string;
  cache_control?: OpenAICompatCacheControl;
}

interface ChatCompletionImagePart {
  type: "image_url";
  image_url: { url: string };
}

type ChatCompletionContentPart = ChatCompletionTextPart | ChatCompletionImagePart;

interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionMessageParam {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | ChatCompletionContentPart[] | null;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
  reasoning_details?: unknown[];
}

interface ChatCompletionToolParam {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
    strict?: boolean;
  };
  cache_control?: OpenAICompatCacheControl;
}

interface ChatCompletionRequestParams {
  model: string;
  messages: ChatCompletionMessageParam[];
  stream: true;
  prompt_cache_key?: string;
  prompt_cache_retention?: string;
  stream_options?: { include_usage: boolean };
  store?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  tools?: ChatCompletionToolParam[];
  tool_choice?: OpenAICompletionsOptions["toolChoice"];
  /** Provider-specific fields (reasoning knobs, tool_stream, ...) go here. */
  [key: string]: unknown;
}

interface ChatCompletionUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

interface ChatCompletionToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionEncryptedReasoningDetail {
  type?: string;
  id?: string;
  data?: string;
}

interface ChatCompletionDelta {
  content?: string | null;
  tool_calls?: ChatCompletionToolCallDelta[];
  reasoning_content?: string;
  reasoning?: string;
  reasoning_text?: string;
  reasoning_details?: ChatCompletionEncryptedReasoningDetail[];
}

interface ChatCompletionChoice {
  index?: number;
  delta?: ChatCompletionDelta;
  finish_reason?: string | null;
  usage?: ChatCompletionUsagePayload;
}

interface ChatCompletionChunk {
  id?: string;
  model?: string;
  choices?: ChatCompletionChoice[];
  usage?: ChatCompletionUsagePayload;
}

/**
 * Check if conversation messages contain tool calls or tool results. Needed
 * because Anthropic (via proxy) requires the tools param to be present when
 * messages include tool_calls or tool role messages.
 */
function hasToolHistory(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      return true;
    }
    if (msg.role === "assistant") {
      if (msg.content.some((block) => block.type === "toolCall")) {
        return true;
      }
    }
  }
  return false;
}

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
  return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
  return block.type === "toolCall";
}

function isImageContentBlock(block: { type: string }): block is ImageContent {
  return block.type === "image";
}

/**
 * Resolve the cache retention preference. Upstream also read the
 * PI_CACHE_RETENTION env var; the browser port has no environment to read.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
  return cacheRetention ?? "short";
}

// ---------------------------------------------------------------------------
// Compat auto-detection (the URL/provider heuristic table)
// ---------------------------------------------------------------------------

/**
 * Detect compatibility settings from provider and baseUrl for known
 * providers. Provider takes precedence over URL-based detection since it's
 * explicitly configured. Providers not special-cased here (groq, fireworks,
 * mistral, minimax, kimi-coding, huggingface, xiaomi-token, ...) ride the
 * standard defaults plus per-model compat overrides from the model catalog —
 * that is exactly what upstream's generated catalog does for them.
 */
function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
  const provider = model.provider;
  const baseUrl = model.baseUrl;

  const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
  const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
  const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
  const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
  const isPrimeInference = provider === "prime-inference" || baseUrl.includes("api.pinference.ai");

  const isNonStandard =
    provider === "cerebras" ||
    baseUrl.includes("cerebras.ai") ||
    provider === "xai" ||
    baseUrl.includes("api.x.ai") ||
    baseUrl.includes("chutes.ai") ||
    baseUrl.includes("deepseek.com") ||
    isZai ||
    isMoonshot ||
    provider === "opencode" ||
    baseUrl.includes("opencode.ai") ||
    isCloudflareWorkersAI ||
    isCloudflareAiGateway ||
    isPrimeInference;

  const useMaxTokens = baseUrl.includes("chutes.ai") || isMoonshot || isCloudflareAiGateway || isPrimeInference;

  const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
  const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com");
  const isAnthropicModel = model.id.startsWith("anthropic/");
  const cacheControlFormat =
    isAnthropicModel && (provider === "openrouter" || isPrimeInference) ? ("anthropic" as const) : undefined;

  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: !isGrok && !isZai && !isMoonshot && !isCloudflareAiGateway,
    supportsUsageInStreaming: true,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: isDeepSeek,
    thinkingFormat: isDeepSeek
      ? "deepseek"
      : isZai
        ? "zai"
        : provider === "openrouter" || baseUrl.includes("openrouter.ai")
          ? "openrouter"
          : "openai",
    supportsStrictMode: !isMoonshot && !isCloudflareAiGateway && !isPrimeInference,
    cacheControlFormat,
    sendSessionAffinityHeaders: false,
    supportsLongCacheRetention: !(isCloudflareWorkersAI || isCloudflareAiGateway),
  };
}

/** Resolved compat: explicit model.compat fields win over auto-detection. */
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
  const detected = detectCompat(model);
  if (!model.compat) return detected;

  return {
    supportsStore: model.compat.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
    supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    requiresReasoningContentOnAssistantMessages:
      model.compat.requiresReasoningContentOnAssistantMessages ?? detected.requiresReasoningContentOnAssistantMessages,
    thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
    supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
    cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
    sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
    supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
  };
}

function getCompatCacheControl(
  compat: ResolvedOpenAICompletionsCompat,
  cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
  if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
    return undefined;
  }

  const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
  return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

// ---------------------------------------------------------------------------
// Request headers
// ---------------------------------------------------------------------------

function buildRequestConfig(
  model: Model<"openai-completions">,
  context: Context,
  apiKey: string,
  optionsHeaders: Record<string, string> | undefined,
  sessionId: string | undefined,
  compat: ResolvedOpenAICompletionsCompat,
): { url: string; headers: Record<string, string> } {
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

  if (sessionId && compat.sendSessionAffinityHeaders) {
    headers.session_id = sessionId;
    headers["x-client-request-id"] = sessionId;
    headers["x-session-affinity"] = sessionId;
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
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return { url, headers };
}

// ---------------------------------------------------------------------------
// Request body construction
// ---------------------------------------------------------------------------

function applyAnthropicCacheControl(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionToolParam[] | undefined,
  cacheControl: OpenAICompatCacheControl,
): void {
  addCacheControlToSystemPrompt(messages, cacheControl);
  addCacheControlToLastTool(tools, cacheControl);
  addCacheControlToLastConversationMessage(messages, cacheControl);
}

function addCacheControlToSystemPrompt(
  messages: ChatCompletionMessageParam[],
  cacheControl: OpenAICompatCacheControl,
): void {
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      addCacheControlToTextContent(message, cacheControl);
      return;
    }
  }
}

function addCacheControlToLastConversationMessage(
  messages: ChatCompletionMessageParam[],
  cacheControl: OpenAICompatCacheControl,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" || message.role === "assistant") {
      if (addCacheControlToTextContent(message, cacheControl)) {
        return;
      }
    }
  }
}

function addCacheControlToLastTool(tools: ChatCompletionToolParam[] | undefined, cacheControl: OpenAICompatCacheControl): void {
  if (!tools || tools.length === 0) {
    return;
  }

  const lastTool = tools[tools.length - 1];
  lastTool.cache_control = cacheControl;
}

function addCacheControlToTextContent(message: ChatCompletionMessageParam, cacheControl: OpenAICompatCacheControl): boolean {
  const content = message.content;
  if (typeof content === "string") {
    if (content.length === 0) {
      return false;
    }
    message.content = [
      {
        type: "text",
        text: content,
        cache_control: cacheControl,
      },
    ];
    return true;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part?.type === "text") {
      part.cache_control = cacheControl;
      return true;
    }
  }

  return false;
}

function buildParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
  compat: ResolvedOpenAICompletionsCompat = getCompat(model),
  cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention),
  cacheControl: OpenAICompatCacheControl | undefined = getCompatCacheControl(compat, cacheRetention),
): ChatCompletionRequestParams {
  const messages = convertMessages(model, context, compat);

  const params: ChatCompletionRequestParams = {
    model: model.id,
    messages,
    stream: true,
    prompt_cache_key:
      (model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
      (cacheRetention === "long" && compat.supportsLongCacheRetention)
        ? options?.sessionId
        : undefined,
    prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
  };

  if (compat.supportsUsageInStreaming !== false) {
    params.stream_options = { include_usage: true };
  }

  if (compat.supportsStore) {
    params.store = false;
  }

  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      params.max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  if (context.tools && context.tools.length > 0) {
    params.tools = convertTools(context.tools, compat);
  } else if (hasToolHistory(context.messages)) {
    // Anthropic (via LiteLLM/proxy) requires tools param when conversation
    // has tool_calls/tool_results.
    params.tools = [];
  }

  if (cacheControl) {
    applyAnthropicCacheControl(messages, params.tools, cacheControl);
  }

  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }

  if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
  } else if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
  } else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
    params.chat_template_kwargs = {
      enable_thinking: !!options?.reasoningEffort,
      preserve_thinking: true,
    };
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    params.thinking = { type: options?.reasoningEffort ? "enabled" : "disabled" };
    if (options?.reasoningEffort) {
      params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    }
  } else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
    // OpenRouter normalizes reasoning across providers via a nested reasoning object.
    if (options?.reasoningEffort) {
      params.reasoning = {
        effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
      };
    } else if (model.thinkingLevelMap?.off !== null) {
      params.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
    }
  } else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    // OpenAI-style reasoning_effort
    params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
  } else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    const offValue = model.thinkingLevelMap?.off;
    if (typeof offValue === "string") {
      params.reasoning_effort = offValue;
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Context -> payload conversion
// ---------------------------------------------------------------------------

export function convertMessages(
  model: Model<"openai-completions">,
  context: Context,
  compat: ResolvedOpenAICompletionsCompat,
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];

  const normalizeToolCallId = (id: string): string => {
    // Handle pipe-separated IDs from the OpenAI Responses API:
    // {call_id}|{id} where {id} can be 400+ chars with special chars. These
    // come from providers like github-copilot, openai-codex, opencode.
    if (id.includes("|")) {
      const [callId] = id.split("|");
      // Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
      return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    }

    if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
    return id;
  };

  const transformedMessages = transformMessages(context.messages, model, (id) => normalizeToolCallId(id));

  if (context.systemPrompt) {
    const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
    const role = useDeveloperRole ? "developer" : "system";
    params.push({ role, content: sanitizeSurrogates(context.systemPrompt) });
  }

  let lastRole: string | null = null;

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    // Some providers don't allow user messages directly after tool results;
    // insert a synthetic assistant message to bridge the gap.
    if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
      params.push({
        role: "assistant",
        content: "I have processed the tool results.",
      });
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        params.push({
          role: "user",
          content: sanitizeSurrogates(msg.content),
        });
      } else {
        const content: ChatCompletionContentPart[] = msg.content.map((item): ChatCompletionContentPart => {
          if (item.type === "text") {
            return {
              type: "text",
              text: sanitizeSurrogates(item.text),
            };
          }
          return {
            type: "image_url",
            image_url: {
              url: `data:${item.mimeType};base64,${item.data}`,
            },
          };
        });
        if (content.length === 0) continue;
        params.push({
          role: "user",
          content,
        });
      }
    } else if (msg.role === "assistant") {
      // Some providers don't accept null content; use empty string instead.
      const assistantMsg: ChatCompletionMessageParam = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };

      const assistantTextParts: ChatCompletionTextPart[] = msg.content
        .filter(isTextContentBlock)
        .filter((block) => block.text.trim().length > 0)
        .map((block) => ({
          type: "text",
          text: sanitizeSurrogates(block.text),
        }));
      const assistantText = assistantTextParts.map((part) => part.text).join("");

      const nonEmptyThinkingBlocks = msg.content
        .filter(isThinkingContentBlock)
        .filter((block) => block.thinking.trim().length > 0);
      if (nonEmptyThinkingBlocks.length > 0) {
        if (compat.requiresThinkingAsText) {
          // Convert thinking blocks to plain text (no tags to avoid the model mimicking them).
          const thinkingText = nonEmptyThinkingBlocks.map((block) => sanitizeSurrogates(block.thinking)).join("\n\n");
          assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
        } else {
          // Always send assistant content as a plain string (the OpenAI Chat
          // Completions standard). An array of text parts is non-standard and
          // makes some providers (DeepSeek V3.2 via NVIDIA NIM) mirror the
          // content-block structure literally in their output.
          if (assistantText.length > 0) {
            assistantMsg.content = assistantText;
          }

          // thinkingSignature holds the field the provider streamed reasoning
          // in (reasoning_content / reasoning / reasoning_text), not a crypto
          // signature. Prefer reasoning_content when the provider requires it
          // (otherwise the reasoning_content="" default below would clobber
          // the trace); else round-trip into the recorded field; with
          // neither, keep the trace as text rather than inventing an
          // unsupported field.
          const reasoningText = nonEmptyThinkingBlocks.map((block) => sanitizeSurrogates(block.thinking)).join("\n");
          const reasoningField = compat.requiresReasoningContentOnAssistantMessages
            ? "reasoning_content"
            : nonEmptyThinkingBlocks[0].thinkingSignature || undefined;
          if (reasoningField === "reasoning_content") {
            assistantMsg.reasoning_content = reasoningText;
          } else if (reasoningField) {
            (assistantMsg as unknown as Record<string, unknown>)[reasoningField] = reasoningText;
          } else {
            assistantMsg.content = assistantText.length > 0 ? `${reasoningText}\n\n${assistantText}` : reasoningText;
          }
        }
      } else if (assistantText.length > 0) {
        assistantMsg.content = assistantText;
      }

      const toolCalls = msg.content.filter(isToolCallBlock);
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
        const reasoningDetails = toolCalls
          .filter((tc) => tc.thoughtSignature)
          .map((tc) => {
            try {
              return JSON.parse(tc.thoughtSignature as string);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        if (reasoningDetails.length > 0) {
          assistantMsg.reasoning_details = reasoningDetails;
        }
      }
      if (
        compat.requiresReasoningContentOnAssistantMessages &&
        model.reasoning &&
        assistantMsg.reasoning_content === undefined
      ) {
        assistantMsg.reasoning_content = "";
      }
      // Skip assistant messages that have no content and no tool calls.
      // Some providers require "either content or tool_calls, but not none";
      // others reject empty assistant messages entirely. This handles aborted
      // assistant responses that produced no content.
      const content = assistantMsg.content;
      const hasContent =
        content !== null && content !== undefined && (typeof content === "string" ? content.length > 0 : content.length > 0);
      if (!hasContent && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      const imageBlocks: ChatCompletionImagePart[] = [];
      let j = i;

      for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
        const toolMsg = transformedMessages[j] as ToolResultMessage;

        // Extract text and image content
        const textResult = toolMsg.content
          .filter(isTextContentBlock)
          .map((block) => block.text)
          .join("\n");
        const hasImages = toolMsg.content.some((c) => c.type === "image");

        // Always send tool result with text (or placeholder if only images).
        const hasText = textResult.length > 0;
        const toolResultMsg: ChatCompletionMessageParam = {
          role: "tool",
          content: sanitizeSurrogates(hasText ? textResult : hasImages ? "(see attached image)" : ""),
          tool_call_id: toolMsg.toolCallId,
        };
        if (compat.requiresToolResultName && toolMsg.toolName) {
          toolResultMsg.name = toolMsg.toolName;
        }
        params.push(toolResultMsg);

        if (hasImages && model.input.includes("image")) {
          for (const block of toolMsg.content) {
            if (isImageContentBlock(block)) {
              imageBlocks.push({
                type: "image_url",
                image_url: {
                  url: `data:${block.mimeType};base64,${block.data}`,
                },
              });
            }
          }
        }
      }

      i = j - 1;

      if (imageBlocks.length > 0) {
        if (compat.requiresAssistantAfterToolResult) {
          params.push({
            role: "assistant",
            content: "I have processed the tool results.",
          });
        }

        params.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Attached image(s) from tool result:",
            },
            ...imageBlocks,
          ],
        });
        lastRole = "user";
      } else {
        lastRole = "toolResult";
      }
      continue;
    }

    lastRole = msg.role;
  }

  return params;
}

function convertTools(tools: Tool[], compat: ResolvedOpenAICompletionsCompat): ChatCompletionToolParam[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // Only include strict when the provider supports it; some reject unknown fields.
      ...(compat.supportsStrictMode !== false ? { strict: false } : {}),
    },
  }));
}

// ---------------------------------------------------------------------------
// Usage + stop mapping
// ---------------------------------------------------------------------------

function parseChunkUsage(
  rawUsage: ChatCompletionUsagePayload,
  model: Model<"openai-completions">,
  cacheWriteCost?: number,
): AssistantMessage["usage"] {
  const promptTokens = rawUsage.prompt_tokens || 0;
  const reportedCachedTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
  const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

  // Normalize to pi-ai semantics:
  // - cacheRead: hits from cache created by previous requests only
  // - cacheWrite: tokens written to cache in this request
  // Some OpenAI-compatible providers (observed on OpenRouter) report
  // cached_tokens as (previous hits + current writes). In that case, remove
  // cacheWrite from cacheRead.
  const cacheReadTokens =
    cacheWriteTokens > 0 ? Math.max(0, reportedCachedTokens - cacheWriteTokens) : reportedCachedTokens;

  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  // OpenAI completion_tokens already includes reasoning_tokens.
  const outputTokens = rawUsage.completion_tokens || 0;
  const usage: AssistantMessage["usage"] = {
    input,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  applyUsageCost(model, usage, cacheWriteCost === undefined ? undefined : { cacheWrite: cacheWriteCost });
  return usage;
}

function mapStopReason(reason: string | null): { stopReason: StopReason; errorMessage?: string } {
  if (reason === null) return { stopReason: "stop" };
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return {
        stopReason: "error",
        errorMessage: `Provider finish_reason: ${reason}`,
      };
  }
}

// ---------------------------------------------------------------------------
// Streaming entry points
// ---------------------------------------------------------------------------

export const streamOpenAICompletions: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
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
      const compat = getCompat(model);
      const cacheRetention = resolveCacheRetention(options?.cacheRetention);
      const cacheControl = getCompatCacheControl(compat, cacheRetention);
      const cacheWriteCost =
        cacheControl && hasStandardAnthropicCachePricing(model)
          ? getAnthropicCacheWriteCost(model.cost.input, cacheControl.ttl === "1h" ? "1h" : "5m")
          : undefined;
      const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
      const request = buildRequestConfig(model, context, apiKey, options?.headers, cacheSessionId, compat);
      let params: Record<string, unknown> = { ...buildParams(model, context, options, compat, cacheRetention, cacheControl) };
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
      stream.push({ type: "start", partial: output });

      interface StreamingToolCallBlock extends ToolCall {
        partialArgs?: string;
        streamIndex?: number;
      }
      type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;

      let textBlock: TextContent | null = null;
      let thinkingBlock: ThinkingContent | null = null;
      const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
      const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
      const blocks = output.content as unknown as StreamingBlock[];
      const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);
      const finishBlock = (block: StreamingBlock) => {
        const contentIndex = getContentIndex(block);
        if (contentIndex === -1) {
          return;
        }
        if (block.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex,
            content: block.text,
            partial: output,
          });
        } else if (block.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex,
            content: block.thinking,
            partial: output,
          });
        } else if (block.type === "toolCall") {
          block.arguments = parseStreamingJson(block.partialArgs);
          // Finalize in-place and strip the scratch buffers so replay only
          // carries parsed arguments.
          delete block.partialArgs;
          delete block.streamIndex;
          stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall: block,
            partial: output,
          });
        }
      };
      const ensureTextBlock = () => {
        if (!textBlock) {
          textBlock = { type: "text", text: "" };
          blocks.push(textBlock);
          stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
        }
        return textBlock;
      };
      const ensureThinkingBlock = (thinkingSignature: string) => {
        if (!thinkingBlock) {
          thinkingBlock = {
            type: "thinking",
            thinking: "",
            thinkingSignature,
          };
          blocks.push(thinkingBlock);
          stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
        }
        return thinkingBlock;
      };
      const ensureToolCallBlock = (toolCall: ChatCompletionToolCallDelta) => {
        const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
        let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
        if (!block && toolCall.id) {
          block = toolCallBlocksById.get(toolCall.id);
        }
        if (!block) {
          block = {
            type: "toolCall",
            id: toolCall.id || "",
            name: toolCall.function?.name || "",
            arguments: {},
            partialArgs: "",
            streamIndex,
          };
          if (streamIndex !== undefined) {
            toolCallBlocksByIndex.set(streamIndex, block);
          }
          if (toolCall.id) {
            toolCallBlocksById.set(toolCall.id, block);
          }
          blocks.push(block);
          stream.push({
            type: "toolcall_start",
            contentIndex: getContentIndex(block),
            partial: output,
          });
        }
        if (streamIndex !== undefined && block.streamIndex === undefined) {
          block.streamIndex = streamIndex;
          toolCallBlocksByIndex.set(streamIndex, block);
        }
        if (toolCall.id) {
          toolCallBlocksById.set(toolCall.id, block);
        }
        return block;
      };

      if (!response.body) {
        throw new Error("Attempted to iterate over an OpenAI response with no body");
      }

      for await (const record of sseRecords(response.body, options?.signal)) {
        const data = record.data;
        if (data === "[DONE]") break;
        if (data.trim().length === 0) continue;

        let chunk: ChatCompletionChunk;
        try {
          chunk = parseJsonWithRepair<ChatCompletionChunk>(data);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new StreamFailureError(`Could not parse OpenAI SSE chunk: ${detail}; data=${data}`, {
            kind: "malformed_response",
          });
        }
        if (!chunk || typeof chunk !== "object") continue;

        // OpenAI documents ChatCompletionChunk.id as the unique completion
        // identifier; each chunk in a streamed completion carries the same id.
        output.responseId ||= chunk.id;
        if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
          output.responseModel ||= chunk.model;
        }
        if (chunk.usage) {
          output.usage = parseChunkUsage(chunk.usage, model, cacheWriteCost);
        }

        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        if (!choice) continue;

        // Fallback: some providers (e.g., Moonshot) return usage in
        // choice.usage instead of the standard chunk.usage.
        if (!chunk.usage && choice.usage) {
          output.usage = parseChunkUsage(choice.usage, model, cacheWriteCost);
        }

        if (choice.finish_reason) {
          const finishReasonResult = mapStopReason(choice.finish_reason);
          output.stopReason = finishReasonResult.stopReason;
          if (finishReasonResult.errorMessage) {
            output.errorMessage = finishReasonResult.errorMessage;
          }
        }

        const delta = choice.delta;
        if (delta) {
          if (delta.content !== null && delta.content !== undefined && delta.content.length > 0) {
            const block = ensureTextBlock();
            block.text += delta.content;
            stream.push({
              type: "text_delta",
              contentIndex: getContentIndex(block),
              delta: delta.content,
              partial: output,
            });
          }

          // Some endpoints return reasoning in reasoning_content (llama.cpp),
          // or reasoning (other openai-compatible endpoints). Use the first
          // non-empty reasoning field to avoid duplication (e.g., chutes.ai
          // returns both reasoning_content and reasoning with same content).
          const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
          let foundReasoningField: "reasoning_content" | "reasoning" | "reasoning_text" | null = null;
          for (const field of reasoningFields) {
            const value = delta[field];
            if (typeof value === "string" && value.length > 0) {
              foundReasoningField = field;
              break;
            }
          }

          if (foundReasoningField) {
            const reasoningDelta = delta[foundReasoningField];
            if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
              const block = ensureThinkingBlock(foundReasoningField);
              block.thinking += reasoningDelta;
              stream.push({
                type: "thinking_delta",
                contentIndex: getContentIndex(block),
                delta: reasoningDelta,
                partial: output,
              });
            }
          }

          if (delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              const block = ensureToolCallBlock(toolCall);
              if (!block.id && toolCall.id) {
                block.id = toolCall.id;
                toolCallBlocksById.set(toolCall.id, block);
              }
              if (!block.name && toolCall.function?.name) {
                block.name = toolCall.function.name;
              }

              let deltaText = "";
              if (toolCall.function?.arguments) {
                deltaText = toolCall.function.arguments;
                block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
                block.arguments = parseStreamingJson(block.partialArgs);
              }
              stream.push({
                type: "toolcall_delta",
                contentIndex: getContentIndex(block),
                delta: deltaText,
                partial: output,
              });
            }
          }

          const reasoningDetails = delta.reasoning_details;
          if (reasoningDetails && Array.isArray(reasoningDetails)) {
            for (const detail of reasoningDetails) {
              if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
                const matchingToolCall = output.content.find((b) => b.type === "toolCall" && b.id === detail.id) as
                  | ToolCall
                  | undefined;
                if (matchingToolCall) {
                  matchingToolCall.thoughtSignature = JSON.stringify(detail);
                }
              }
            }
          }
        }
      }

      for (const block of blocks) {
        finishBlock(block);
      }
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "error") {
        throw new Error(output.errorMessage || "Provider returned an error stop reason");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        // Streaming scratch buffers are only used during parsing; never persist them.
        delete (block as { partialArgs?: string }).partialArgs;
        delete (block as { streamIndex?: number }).streamIndex;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      // Some providers via OpenRouter give additional information in this field.
      const rawMetadata = (error as { error?: { metadata?: { raw?: unknown } } | null } | null)?.error?.metadata?.raw;
      if (typeof rawMetadata === "string") output.errorMessage += `\n${rawMetadata}`;
      // Deliberate normalization of upstream's inconsistency: completions now
      // records the structured diagnostic like anthropic/responses do.
      recordStreamFailure(model, output, error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimpleOpenAICompletions: StreamFunction<"openai-completions", OpenAICompletionsSimpleOptions> = (
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsSimpleOptions,
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
  const toolChoice = options?.toolChoice;

  return streamOpenAICompletions(model, context, {
    ...base,
    reasoningEffort,
    toolChoice,
  });
};

/**
 * The provider object registered for "openai-completions". The registry
 * resolves providers by model.api, so the api is guaranteed to match — the
 * wrapper only narrows the Model/Options generics.
 */
export const openAICompletionsProvider: ApiProvider = {
  api: "openai-completions",
  stream: (model, context, options) =>
    streamOpenAICompletions(model as Model<"openai-completions">, context, options as OpenAICompletionsOptions | undefined),
  streamSimple: (model, context, options) =>
    streamSimpleOpenAICompletions(
      model as Model<"openai-completions">,
      context,
      options as OpenAICompletionsSimpleOptions | undefined,
    ),
};
