import type { AssistantMessageEventStream } from "./event-stream";

export type { AssistantMessageEventStream } from "./event-stream";

/**
 * Port of prime-agent packages/ai/src/types.ts.
 *
 * The message/event vocabulary is preserved exactly so that transcripts,
 * receipts, and provider handlers behave identically to prime-agent. What
 * changes: tool parameter schemas are plain JSON Schema objects (no typebox
 * runtime dependency), and provider routing knobs that only matter to hosted
 * gateways are kept as data but never required by this library.
 */

export type KnownApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "mistral-conversations"
  | "bedrock-converse-stream"
  | "google-vertex";

export type Api = KnownApi | (string & {});

export type KnownProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "google-vertex"
  | "amazon-bedrock"
  | "azure-openai-responses"
  | "openai-codex"
  | "prime-inference"
  | "deepseek"
  | "github-copilot"
  | "xai"
  | "groq"
  | "cerebras"
  | "openrouter"
  | "vercel-ai-gateway"
  | "zai"
  | "mistral"
  | "minimax"
  | "moonshotai"
  | "kimi-coding"
  | "huggingface"
  | "chutes"
  | "fireworks"
  | "opencode"
  | "cloudflare-workers-ai"
  | "cloudflare-ai-gateway"
  | "ollama"
  | "lmstudio"
  | "local-demo";

export type Provider = KnownProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export type CacheRetention = "none" | "short" | "long";
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | null;

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  transport?: Transport;
  serviceTier?: ServiceTier;
  cacheRetention?: CacheRetention;
  sessionId?: string;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
  onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

/**
 * The streaming contract every provider implements. A StreamFunction must
 * never throw for request/model/runtime failures: failures are encoded in the
 * returned stream as an `error` event carrying the final AssistantMessage with
 * stopReason "error" or "aborted".
 */
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;

export interface TextSignatureV1 {
  v: 1;
  id: string;
  phase?: "commentary" | "final_answer";
}

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessageDiagnostic {
  code: string;
  message: string;
  detail?: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: StopReason;
  stopReasonRaw?: string;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * Tool parameter schemas are plain JSON Schema objects. Validation uses this
 * library's schema-lite checker (validate.ts); providers forward the schema
 * verbatim to the API.
 */
export type JsonSchema = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

/**
 * Stream protocol preserved from prime-agent. Streams emit `start`, then
 * partial updates, then terminate with exactly one `done` or `error` event.
 */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export interface OpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "zai" | "qwen" | "qwen-chat-template";
  supportsStrictMode?: boolean;
  cacheControlFormat?: "anthropic";
  sendSessionAffinityHeaders?: boolean;
  supportsLongCacheRetention?: boolean;
}

export interface OpenAIResponsesCompat {
  sendSessionIdHeader?: boolean;
  supportsLongCacheRetention?: boolean;
}

export interface AnthropicMessagesCompat {
  supportsEagerToolInputStreaming?: boolean;
  supportsLongCacheRetention?: boolean;
  /**
   * Anthropic requires `anthropic-dangerous-direct-browser-access: true` to
   * accept CORS requests from browser origins. Upstream prime-agent sets this
   * by default for api.anthropic.com; set to false when proxying.
   */
  directBrowserAccess?: boolean;
}

/** Compatibility metadata accepted by each wire protocol. */
export type ApiCompat<TApi extends Api> = TApi extends "openai-completions"
  ? OpenAICompletionsCompat
  : TApi extends "openai-responses"
    ? OpenAIResponsesCompat
    : TApi extends "anthropic-messages"
      ? AnthropicMessagesCompat
      : never;

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  featured?: boolean;
  headers?: Record<string, string>;
  compat?: ApiCompat<TApi>;
}

/**
 * Provider-wide wire defaults. They are keyed by provider and API rather than
 * by endpoint hostname, so the same declaration works through a custom proxy.
 * Per-model `compat` metadata remains authoritative over these defaults.
 */
export interface ProviderDescriptor<TApi extends Api = Api> {
  api: TApi;
  provider: Provider;
  compat?: ApiCompat<TApi>;
}

/** The registry maps an api id to a provider implementation. */
export interface ApiProvider {
  api: Api;
  stream: StreamFunction<Api, StreamOptions>;
  streamSimple: StreamFunction<Api, SimpleStreamOptions>;
}
