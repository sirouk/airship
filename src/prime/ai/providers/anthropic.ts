import type { AnthropicCacheCreationUsage } from "../cost";
import { getAnthropicCacheWriteCost, hasStandardAnthropicCachePricing } from "../cost";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "../event-stream";
import { sanitizeSurrogates } from "../sanitize";
import { sseRecords } from "../sse";
import { parseJsonWithRepair, parseStreamingJson } from "../stream-json";
import type {
  AnthropicMessagesCompat,
  Api,
  ApiProvider,
  AssistantMessage,
  CacheRetention,
  Context,
  ImageContent,
  Message,
  Model,
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
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options";
import {
  classifyStreamFailure,
  formatStreamFailureMessage,
  recordStreamFailure,
  StreamFailureError,
  streamFailureFromStopReason,
  streamFailureMessage,
  truncateRawPayload,
} from "./stream-failure";
import { transformMessages } from "./transform";

/**
 * Port of prime-agent packages/ai/src/providers/anthropic.ts.
 *
 * The upstream builds requests through the @anthropic-ai/sdk client; the
 * port speaks fetch directly (the SDK exists chiefly for Node niceties —
 * retries, timeouts, connection pooling — which this port implements in
 * ./http.ts). The API surface of payloads, headers, and event semantics is
 * preserved one-to-one, with these documented deltas:
 *
 *  - API keys come from options.apiKey or an injected resolveApiKey
 *    resolver, never process.env. The PI_CACHE_RETENTION env fallback is
 *    gone; the cacheRetention default stays "short".
 *  - OAuth token handling (sk-ant-oat detection, Claude Code identity
 *    system block, claude-cli user-agent, Claude Code tool-name
 *    canonicalization) is NOT ported — documented gap, see PORT.md.
 *  - `anthropic-dangerous-direct-browser-access: true` is sent by default
 *    for api.anthropic.com so CORS preflights succeed from a browser page;
 *    set compat.directBrowserAccess to control it explicitly (copilot and
 *    cloudflare gateway branches keep upstream's unconditional header).
 *  - The SDK `client` injection option is gone (there is no SDK client);
 *    tests inject behavior by stubbing globalThis.fetch.
 */

/** Sent verbatim; Anthropic pins the wire protocol revision. */
const ANTHROPIC_VERSION = "2023-06-01";
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface AnthropicOptions extends StreamOptions {
  /**
   * Enable extended thinking. Adaptive-thinking models (Opus 4.6+, Sonnet
   * 4.6, Fable/Mythos families) decide when/how much to think; older models
   * use budget-based thinking via thinkingBudgetTokens.
   */
  thinkingEnabled?: boolean;
  /** Token budget for extended thinking (budget-based models only). */
  thinkingBudgetTokens?: number;
  /** Effort level for adaptive thinking models. */
  effort?: AnthropicEffort;
  /**
   * Controls how thinking content is returned. "summarized" keeps older
   * Claude 4 behavior; "omitted" returns empty thinking text while the
   * signature still round-trips for multi-turn continuity.
   */
  thinkingDisplay?: AnthropicThinkingDisplay;
  interleavedThinking?: boolean;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  /** Host-injected credential lookup; consulted only when apiKey is absent. */
  resolveApiKey?: ApiKeyResolver;
}

/** SimpleStreamOptions plus the browser credential resolver. */
export type AnthropicSimpleOptions = SimpleStreamOptions & { resolveApiKey?: ApiKeyResolver };

// ---------------------------------------------------------------------------
// Wire payload types (the subset of the Anthropic Messages API we speak)
// ---------------------------------------------------------------------------

export interface AnthropicTextBlockParam {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicImageBlockParam {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicThinkingBlockParam {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface AnthropicRedactedThinkingBlockParam {
  type: "redacted_thinking";
  data: string;
}

export interface AnthropicToolUseBlockParam {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content: string | (AnthropicTextBlockParam | AnthropicImageBlockParam)[];
  is_error?: boolean;
  cache_control?: AnthropicCacheControl;
}

export type AnthropicContentBlockParam =
  | AnthropicTextBlockParam
  | AnthropicImageBlockParam
  | AnthropicThinkingBlockParam
  | AnthropicRedactedThinkingBlockParam
  | AnthropicToolUseBlockParam
  | AnthropicToolResultBlockParam;

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlockParam[];
}

export interface AnthropicToolParam {
  name: string;
  description: string;
  eager_input_streaming?: boolean;
  input_schema: {
    type: "object";
    properties: unknown;
    required: string[];
  };
  cache_control?: AnthropicCacheControl;
}

export type AnthropicThinkingParam =
  | { type: "adaptive"; display?: AnthropicThinkingDisplay }
  | { type: "enabled"; budget_tokens: number; display?: AnthropicThinkingDisplay }
  | { type: "disabled" };

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessageParam[];
  max_tokens: number;
  stream: true;
  system?: AnthropicTextBlockParam[];
  temperature?: number;
  tools?: AnthropicToolParam[];
  thinking?: AnthropicThinkingParam;
  output_config?: { effort: AnthropicEffort };
  metadata?: { user_id?: string };
  tool_choice?: { type: "auto" | "any" | "none" } | { type: "tool"; name: string };
}

// ---------------------------------------------------------------------------
// Wire stream event types (the subset of the Anthropic SSE protocol we read)
// ---------------------------------------------------------------------------

interface AnthropicUsagePayload {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: AnthropicCacheCreationUsage | null;
}

type AnthropicStreamContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> | null };

type AnthropicStreamDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "signature_delta"; signature: string };

type AnthropicStreamEvent =
  | { type: "message_start"; message: { id: string; usage: AnthropicUsagePayload } }
  | { type: "content_block_start"; index: number; content_block: AnthropicStreamContentBlock }
  | { type: "content_block_delta"; index: number; delta: AnthropicStreamDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: string | null; stop_sequence?: string | null }; usage: AnthropicUsagePayload }
  | { type: "message_stop" };

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);

// ---------------------------------------------------------------------------
// Cache retention
// ---------------------------------------------------------------------------

/**
 * Resolve the cache retention preference. Upstream also read the
 * PI_CACHE_RETENTION env var; the browser port has no environment to read,
 * so the option default "short" is unconditional.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
  return cacheRetention ?? "short";
}

function getCacheControl(
  model: Model<"anthropic-messages">,
  cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: AnthropicCacheControl } {
  const retention = resolveCacheRetention(cacheRetention);
  if (retention === "none") {
    return { retention };
  }
  const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
  return {
    retention,
    cacheControl: { type: "ephemeral", ...(ttl ? { ttl } : {}) },
  };
}

function getAnthropicCompat(model: Model<"anthropic-messages">): Required<Omit<AnthropicMessagesCompat, "directBrowserAccess">> {
  return {
    supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
  };
}

/**
 * Anthropic requires `anthropic-dangerous-direct-browser-access: true` to
 * accept CORS requests from browser origins. The page IS a browser origin,
 * so the header is on by default for api.anthropic.com; hosts proxying the
 * API turn it off via compat.directBrowserAccess.
 */
function wantsDirectBrowserAccess(model: Model<"anthropic-messages">): boolean {
  const direct = model.compat?.directBrowserAccess;
  if (direct !== undefined) return direct;
  try {
    return new URL(model.baseUrl).hostname === "api.anthropic.com";
  } catch {
    return model.baseUrl.includes("api.anthropic.com");
  }
}

// ---------------------------------------------------------------------------
// Content conversion
// ---------------------------------------------------------------------------

/**
 * Convert tool result content blocks to Anthropic API format: a joined
 * string for text-only results, a content block array when images are
 * present (with a placeholder block for image-only results).
 */
function convertContentBlocks(
  content: (TextContent | ImageContent)[],
): string | (AnthropicTextBlockParam | AnthropicImageBlockParam)[] {
  // If only text blocks, return as concatenated string for simplicity
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
  }

  // If we have images, convert to content block array
  const blocks = content.map((block): AnthropicTextBlockParam | AnthropicImageBlockParam => {
    if (block.type === "text") {
      return {
        type: "text",
        text: sanitizeSurrogates(block.text),
      };
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: block.data,
      },
    };
  });

  // If only images (no text), add placeholder text block
  const hasText = blocks.some((b) => b.type === "text");
  if (!hasText) {
    blocks.unshift({
      type: "text",
      text: "(see attached image)",
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Header construction (browser port of createClient's auth/identity matrix)
// ---------------------------------------------------------------------------

/**
 * Merge header sources left-to-right; a null value deletes the key (the
 * SDK-header removal semantics upstream relied on for the gateway branches).
 */
function mergeHeaders(...headerSources: (Record<string, string | null> | undefined)[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const headers of headerSources) {
    if (!headers) continue;
    for (const [key, value] of Object.entries(headers)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function buildRequestConfig(
  model: Model<"anthropic-messages">,
  apiKey: string,
  interleavedThinking: boolean,
  useFineGrainedToolStreamingBeta: boolean,
  optionsHeaders?: Record<string, string>,
  dynamicHeaders?: Record<string, string>,
): { url: string; headers: Record<string, string> } {
  // Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
  // The beta header is deprecated on Opus 4.6 and redundant on Sonnet 4.6, so skip it.
  const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinking(model.id);
  const betaFeatures: string[] = [];
  if (useFineGrainedToolStreamingBeta) {
    betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  if (needsInterleavedBeta) {
    betaFeatures.push(INTERLEAVED_THINKING_BETA);
  }

  const baseUrl = isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl;
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;

  if (model.provider === "cloudflare-ai-gateway") {
    const headers = mergeHeaders(
      {
        accept: "application/json",
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
        "cf-aig-authorization": `Bearer ${apiKey}`,
        "x-api-key": null,
        Authorization: null,
        ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
      },
      model.headers,
      optionsHeaders,
    );
    return { url, headers };
  }

  // Copilot: Bearer auth, selective betas.
  if (model.provider === "github-copilot") {
    const headers = mergeHeaders(
      {
        accept: "application/json",
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
        Authorization: `Bearer ${apiKey}`,
        ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
      },
      model.headers,
      dynamicHeaders,
      optionsHeaders,
    );
    return { url, headers };
  }

  // API key auth. OAuth identity headers are deliberately absent: see PORT.md.
  const headers = mergeHeaders(
    {
      accept: "application/json",
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      ...(wantsDirectBrowserAccess(model) ? { "anthropic-dangerous-direct-browser-access": "true" } : {}),
      ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
    },
    model.headers,
    optionsHeaders,
  );
  return { url, headers };
}

// ---------------------------------------------------------------------------
// Request body construction
// ---------------------------------------------------------------------------

/**
 * Fable/Mythos models think every turn and reject an explicit
 * `thinking: {type: "disabled"}` (and any sampling params) with a 400.
 */
function isAlwaysOnAdaptiveThinkingModel(modelId: string): boolean {
  return modelId.includes("fable-5") || modelId.includes("mythos-5") || modelId.includes("mythos-preview");
}

/** Adaptive thinking models (Opus 4.6+, Sonnet 4.6, Fable/Mythos families). */
function supportsAdaptiveThinking(modelId: string): boolean {
  // Adaptive-thinking model IDs (with or without date suffix).
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4.6") ||
    modelId.includes("opus-5") ||
    modelId.includes("opus-4-7") ||
    modelId.includes("opus-4.7") ||
    modelId.includes("opus-4-8") ||
    modelId.includes("opus-4.8") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6") ||
    modelId.includes("sonnet-5") ||
    modelId.includes("fable-5") ||
    modelId.includes("mythos-5") ||
    modelId.includes("mythos-preview")
  );
}

/**
 * Map ThinkingLevel to Anthropic effort for adaptive thinking. The effort is
 * driven by each model's thinkingLevelMap; the switch is a fallback for
 * levels without an explicit mapping.
 */
function mapThinkingLevelToEffort(
  model: Model<"anthropic-messages">,
  level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
  // Clamp to what the model actually supports so callers that bypass
  // clampThinkingLevel (e.g. passing reasoning: "xhigh" directly) can't send
  // an effort the model lacks — xhigh on a max-only model resolves to max,
  // not xhigh.
  const effective = level ? clampThinkingLevel(model, level) : undefined;
  const mapped = effective ? model.thinkingLevelMap?.[effective] : undefined;
  if (typeof mapped === "string") return mapped as AnthropicEffort;

  switch (effective) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return "high";
  }
}

function buildParams(
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
  cacheControl?: AnthropicCacheControl,
): AnthropicMessagesRequest {
  const params: AnthropicMessagesRequest = {
    model: model.id,
    messages: convertMessages(context.messages, model, cacheControl),
    max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
    stream: true,
  };

  if (context.systemPrompt) {
    // Add cache control to the system prompt so the instruction prefix caches.
    params.system = [
      {
        type: "text",
        text: sanitizeSurrogates(context.systemPrompt),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      },
    ];
  }

  // Temperature is incompatible with extended thinking (adaptive or
  // budget-based), and always-on models reject sampling params outright.
  if (options?.temperature !== undefined && !options?.thinkingEnabled && !isAlwaysOnAdaptiveThinkingModel(model.id)) {
    params.temperature = options.temperature;
  }

  if (context.tools && context.tools.length > 0) {
    params.tools = convertTools(context.tools, getAnthropicCompat(model).supportsEagerToolInputStreaming, cacheControl);
  }

  // Configure thinking mode: adaptive (Opus 4.6+/Sonnet 4.6/Fable/Mythos),
  // budget-based (older models), or explicitly disabled.
  if (model.reasoning) {
    if (options?.thinkingEnabled) {
      // Default to "summarized" so models whose API default is "omitted"
      // behave like older Claude 4 models.
      const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
      if (supportsAdaptiveThinking(model.id)) {
        // Adaptive thinking: Claude decides when and how much to think.
        params.thinking = { type: "adaptive", display };
        if (options.effort) {
          params.output_config = { effort: options.effort };
        }
      } else {
        // Budget-based thinking for older models
        params.thinking = {
          type: "enabled",
          budget_tokens: options.thinkingBudgetTokens || 1024,
          display,
        };
      }
    } else if (options?.thinkingEnabled === false && !isAlwaysOnAdaptiveThinkingModel(model.id)) {
      params.thinking = { type: "disabled" };
    }
  }

  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
  }

  if (options?.toolChoice) {
    if (typeof options.toolChoice === "string") {
      params.tool_choice = { type: options.toolChoice };
    } else {
      params.tool_choice = options.toolChoice;
    }
  }

  return params;
}

// Normalize tool call IDs to match Anthropic's required pattern and length.
function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
  messages: Message[],
  model: Model<"anthropic-messages">,
  cacheControl?: AnthropicCacheControl,
): AnthropicMessageParam[] {
  const params: AnthropicMessageParam[] = [];

  // Transform messages for cross-provider compatibility; tool call ids are
  // normalized to Anthropic's [a-zA-Z0-9_-]{1,64} alphabet with a first-pass
  // map so tool results are rewritten to match their calls.
  const transformedMessages = transformMessages(messages, model, (id) => normalizeToolCallId(id));

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({
            role: "user",
            content: sanitizeSurrogates(msg.content),
          });
        }
      } else {
        const blocks: AnthropicContentBlockParam[] = msg.content.map((item) => {
          if (item.type === "text") {
            return {
              type: "text",
              text: sanitizeSurrogates(item.text),
            };
          }
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: item.data,
            },
          };
        });
        const filteredBlocks = blocks.filter((b) => {
          if (b.type === "text") {
            return (b as AnthropicTextBlockParam).text.trim().length > 0;
          }
          return true;
        });
        if (filteredBlocks.length === 0) continue;
        params.push({
          role: "user",
          content: filteredBlocks,
        });
      }
    } else if (msg.role === "assistant") {
      const blocks: AnthropicContentBlockParam[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(block.text),
          });
        } else if (block.type === "thinking") {
          // Redacted thinking: pass the opaque payload back as redacted_thinking.
          if (block.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature ?? "",
            });
            continue;
          }
          if (block.thinking.trim().length === 0) continue;
          // If thinking signature is missing/empty (e.g., from an aborted
          // stream), convert to a plain text block without thinking tags to
          // avoid API rejection and prevent the model mimicking the tags.
          if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
            blocks.push({
              type: "text",
              text: sanitizeSurrogates(block.thinking),
            });
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: block.thinkingSignature,
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments ?? {},
          });
        }
      }
      if (blocks.length === 0) continue;
      params.push({
        role: "assistant",
        content: blocks,
      });
    } else if (msg.role === "toolResult") {
      // Collect all consecutive toolResult messages (z.ai Anthropic endpoint
      // compatibility) into one user message with per-result blocks.
      const toolResults: AnthropicContentBlockParam[] = [];

      // Add the current tool result
      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: convertContentBlocks(msg.content),
        is_error: msg.isError,
      });

      // Look ahead for consecutive toolResult messages
      let j = i + 1;
      while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
        const nextMsg = transformedMessages[j] as ToolResultMessage;
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: convertContentBlocks(nextMsg.content),
          is_error: nextMsg.isError,
        });
        j++;
      }

      // Skip the messages we've already processed
      i = j - 1;

      // Add a single user message with all tool results
      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }

  // Add cache_control to the last user message to cache conversation history
  if (cacheControl && params.length > 0) {
    const lastMessage = params[params.length - 1];
    if (lastMessage.role === "user") {
      if (Array.isArray(lastMessage.content)) {
        const lastBlock = lastMessage.content[lastMessage.content.length - 1];
        if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")) {
          (lastBlock as AnthropicTextBlockParam | AnthropicImageBlockParam | AnthropicToolResultBlockParam).cache_control =
            cacheControl;
        }
      } else if (typeof lastMessage.content === "string") {
        lastMessage.content = [
          {
            type: "text",
            text: lastMessage.content,
            cache_control: cacheControl,
          },
        ];
      }
    }
  }

  return params;
}

function convertTools(
  tools: Tool[],
  supportsEagerToolInputStreaming: boolean,
  cacheControl?: AnthropicCacheControl,
): AnthropicToolParam[] {
  return tools.map((tool, index) => {
    const schema = tool.parameters as { properties?: unknown; required?: string[] };

    return {
      name: tool.name,
      description: tool.description,
      ...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
      input_schema: {
        type: "object",
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      },
      ...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
    };
  });
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
  return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

// ---------------------------------------------------------------------------
// Stream event handling
// ---------------------------------------------------------------------------

/** Turn an in-stream `error` SSE event (how Anthropic delivers overloads etc.) into a classified failure. */
function anthropicSseError(data: string, requestId?: string): StreamFailureError {
  let errorType: string | undefined;
  let detail: string | undefined;
  try {
    const parsed = parseJsonWithRepair<{ error?: { type?: string; message?: string }; request_id?: string }>(data);
    errorType = parsed.error?.type;
    detail = parsed.error?.message;
    // Proxies may strip the request-id header; the error body carries it too.
    requestId ??= typeof parsed.request_id === "string" ? parsed.request_id : undefined;
  } catch {
    detail = data;
  }
  const info = {
    kind: classifyStreamFailure(errorType),
    providerErrorType: errorType,
    requestId,
    raw: truncateRawPayload(data),
  };
  return new StreamFailureError(streamFailureMessage(info, detail), info);
}

/**
 * Iterate Anthropic SSE events from a streaming response. Unknown events
 * (proxy stats, done sentinels) are skipped. Integrity invariant: a stream
 * that saw message_start but never message_stop is treated as malformed,
 * never as a clean finish.
 */
async function* iterateAnthropicEvents(
  response: Response,
  signal: AbortSignal | undefined,
  requestId: string | undefined,
): AsyncGenerator<AnthropicStreamEvent> {
  if (!response.body) {
    throw new Error("Attempted to iterate over an Anthropic response with no body");
  }

  let sawMessageStart = false;
  let sawMessageEnd = false;

  for await (const sse of sseRecords(response.body, signal)) {
    if (sse.event === "error") {
      throw anthropicSseError(sse.data, requestId);
    }

    if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
      continue;
    }

    try {
      const event = parseJsonWithRepair<AnthropicStreamEvent>(sse.data);
      if (event.type === "message_start") {
        sawMessageStart = true;
      } else if (event.type === "message_stop") {
        sawMessageEnd = true;
      }
      yield event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StreamFailureError(`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}`, {
        kind: "malformed_response",
        requestId,
        raw: truncateRawPayload(sse.data),
      });
    }
  }

  if (signal?.aborted) {
    // An abort wins over the integrity check: a caller-cancelled stream that
    // never saw message_stop is "aborted", never "malformed".
    throw new Error("Request was aborted");
  }

  if (sawMessageStart && !sawMessageEnd) {
    throw new StreamFailureError("Anthropic stream ended before message_stop", {
      kind: "malformed_response",
      requestId,
    });
  }
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "error";
    case "pause_turn": // Stop is good enough -> resubmit
      return "stop";
    case "stop_sequence":
      return "stop"; // We don't supply stop sequences, so this should never happen
    case "sensitive": // Content flagged by safety filters
      return "error";
    default:
      // Genuinely novel stop reasons hard-fail the stream into a
      // malformed_response-classified terminal error rather than silently
      // degrading to a wrong stop reason.
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Streaming entry points
// ---------------------------------------------------------------------------

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
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

      let copilotDynamicHeaders: Record<string, string> | undefined;
      if (model.provider === "github-copilot") {
        const hasImages = hasCopilotVisionInput(context.messages);
        copilotDynamicHeaders = buildCopilotDynamicHeaders({
          messages: context.messages,
          hasImages,
        });
      }

      const request = buildRequestConfig(
        model,
        apiKey,
        options?.interleavedThinking ?? true,
        shouldUseFineGrainedToolStreamingBeta(model, context),
        options?.headers,
        copilotDynamicHeaders,
      );

      const { cacheControl } = getCacheControl(model, options?.cacheRetention);
      const usesAnthropicCachePricing = hasStandardAnthropicCachePricing(model);
      let cacheWriteCost =
        cacheControl && usesAnthropicCachePricing
          ? getAnthropicCacheWriteCost(model.cost.input, cacheControl.ttl === "1h" ? "1h" : "5m")
          : undefined;
      let params: Record<string, unknown> = { ...buildParams(model, context, options, cacheControl) };
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
      const requestId = response.headers.get("request-id") ?? undefined;
      stream.push({ type: "start", partial: output });

      type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
      const blocks = output.content as unknown as Block[];

      for await (const event of iterateAnthropicEvents(response, options?.signal, requestId)) {
        if (event.type === "message_start") {
          output.responseId = event.message.id;
          // Capture initial token usage from message_start. This ensures we
          // have input token counts even if the stream is aborted early.
          output.usage.input = event.message.usage.input_tokens || 0;
          output.usage.output = event.message.usage.output_tokens || 0;
          output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
          output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
          // Anthropic doesn't provide total_tokens; compute from components.
          output.usage.totalTokens =
            output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          if (cacheControl && usesAnthropicCachePricing) {
            cacheWriteCost = getAnthropicCacheWriteCost(
              model.cost.input,
              cacheControl.ttl === "1h" ? "1h" : "5m",
              event.message.usage.cache_creation,
            );
          }
          applyUsageCost(model, output.usage, cacheWriteCost === undefined ? undefined : { cacheWrite: cacheWriteCost });
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            const block: Block = {
              type: "text",
              text: "",
              index: event.index,
            };
            output.content.push(block);
            stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "thinking") {
            const block: Block = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
              index: event.index,
            };
            output.content.push(block);
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "redacted_thinking") {
            const block: Block = {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: event.content_block.data,
              redacted: true,
              index: event.index,
            };
            output.content.push(block);
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "tool_use") {
            const block: Block = {
              type: "toolCall",
              id: event.content_block.id,
              name: event.content_block.name,
              arguments: event.content_block.input ?? {},
              partialJson: "",
              index: event.index,
            };
            output.content.push(block);
            stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "text") {
              block.text += event.delta.text;
              stream.push({
                type: "text_delta",
                contentIndex: index,
                delta: event.delta.text,
                partial: output,
              });
            }
          } else if (event.delta.type === "thinking_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "thinking") {
              block.thinking += event.delta.thinking;
              stream.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: event.delta.thinking,
                partial: output,
              });
            }
          } else if (event.delta.type === "input_json_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "toolCall") {
              block.partialJson += event.delta.partial_json;
              block.arguments = parseStreamingJson(block.partialJson);
              stream.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: event.delta.partial_json,
                partial: output,
              });
            }
          } else if (event.delta.type === "signature_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "thinking") {
              // Signature deltas only accumulate the round-trip cursor; no
              // stream event is emitted for them.
              block.thinkingSignature = block.thinkingSignature || "";
              block.thinkingSignature += event.delta.signature;
            }
          }
        } else if (event.type === "content_block_stop") {
          const index = blocks.findIndex((b) => b.index === event.index);
          const block = blocks[index];
          if (block) {
            delete (block as { index?: number }).index;
            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex: index,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
                partial: output,
              });
            } else if (block.type === "toolCall") {
              block.arguments = parseStreamingJson(block.partialJson);
              // Finalize in-place and strip the scratch buffer so replay
              // only carries parsed arguments.
              delete (block as { partialJson?: string }).partialJson;
              stream.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: block,
                partial: output,
              });
            }
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) {
            output.stopReason = mapStopReason(event.delta.stop_reason);
            if (output.stopReason === "error") {
              output.stopReasonRaw = event.delta.stop_reason;
            }
          }
          // Only update usage fields when present (not null). Preserves
          // input_tokens from message_start when proxies omit it here.
          if (event.usage.input_tokens != null) {
            output.usage.input = event.usage.input_tokens;
          }
          if (event.usage.output_tokens != null) {
            output.usage.output = event.usage.output_tokens;
          }
          if (event.usage.cache_read_input_tokens != null) {
            output.usage.cacheRead = event.usage.cache_read_input_tokens;
          }
          if (event.usage.cache_creation_input_tokens != null) {
            output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
          }
          // Anthropic doesn't provide total_tokens; compute from components.
          output.usage.totalTokens =
            output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          applyUsageCost(model, output.usage, cacheWriteCost === undefined ? undefined : { cacheWrite: cacheWriteCost });
        }
      }

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

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", AnthropicSimpleOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicSimpleOptions,
): AssistantMessageEventStream => {
  const apiKey = resolveApiKey(options, model.provider);
  if (!apiKey) {
    // Config-level failure: allowed to throw synchronously, mirroring
    // upstream. streamSimple() in stream.ts catches it into an error event.
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  if (!options?.reasoning) {
    return streamAnthropic(model, context, { ...base, thinkingEnabled: false });
  }

  // Adaptive models use effort levels; older models use budget-based thinking.
  if (supportsAdaptiveThinking(model.id)) {
    const effort = mapThinkingLevelToEffort(model, options.reasoning);
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: true,
      effort,
    });
  }

  const adjusted = adjustMaxTokensForThinking(
    base.maxTokens || 0,
    model.maxTokens,
    options.reasoning,
    options.thinkingBudgets,
  );

  return streamAnthropic(model, context, {
    ...base,
    maxTokens: adjusted.maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: adjusted.thinkingBudget,
  });
};

/**
 * The provider object registered for "anthropic-messages". The registry
 * resolves providers by model.api, so the api is guaranteed to match — the
 * wrapper only narrows the Model/Options generics.
 */
export const anthropicProvider: ApiProvider = {
  api: "anthropic-messages",
  stream: (model, context, options) =>
    streamAnthropic(model as Model<"anthropic-messages">, context, options as AnthropicOptions | undefined),
  streamSimple: (model, context, options) =>
    streamSimpleAnthropic(model as Model<"anthropic-messages">, context, options as AnthropicSimpleOptions | undefined),
};
