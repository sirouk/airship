import type {
  CanonicalMessage,
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  JsonValue,
  ToolCall,
  ToolDefinition,
} from "../../core/contracts";
import type {
  InferenceModelDescriptor,
  ModelCapability,
  ModelCapabilityEvidence,
} from "./contracts";
import type { InferenceConnectionRegistry } from "./connection-registry";

export type ProviderApiKeyGetter = () => string | Promise<string>;
export type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type BrowserCloudTransportOptions = Readonly<{
  connectionId: string;
  /** Credential generation this transport and its model directory are bound to. */
  connectionGeneration: number;
  /** Compatibility hook. Prefer `connections` so custody stays centralized. */
  getApiKey?: ProviderApiKeyGetter;
  /** Page-memory authority; the transport borrows the key only per request. */
  connections?: InferenceConnectionRegistry;
  fetch?: ProviderFetch;
  totalTimeoutMs?: number;
  maxJsonBytes?: number;
  maxErrorBytes?: number;
  maxSseEventChars?: number;
  maxToolCalls?: number;
  maxToolArgumentChars?: number;
  maxOutputTokens?: number;
  now?: () => number;
}>;

export type ProviderTransportErrorCode =
  | "cancelled"
  | "timeout"
  | "network-or-cors"
  | "http"
  | "invalid-content-type"
  | "response-too-large"
  | "invalid-response"
  | "stream-truncated"
  | "tool-call-invalid";

export class ProviderTransportError extends Error {
  constructor(
    readonly code: ProviderTransportErrorCode,
    message: string,
    readonly status?: number,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ProviderTransportError";
  }
}

type ResolvedBrowserOptions = Readonly<{
  connectionId: string;
  connectionGeneration: number;
  withApiKey: <T>(
    signal: AbortSignal,
    use: (apiKey: string) => Promise<T>,
  ) => Promise<T>;
  fetch: ProviderFetch;
  totalTimeoutMs: number;
  maxJsonBytes: number;
  maxErrorBytes: number;
  maxSseEventChars: number;
  maxToolCalls: number;
  maxToolArgumentChars: number;
  maxOutputTokens: number;
  now: () => number;
}>;

type CloudProviderDefinition = Readonly<{
  providerId: "openai" | "xai";
  displayName: "OpenAI" | "xAI";
  transportId: "openai-responses-v1" | "xai-responses-v1";
  origin: "https://api.openai.com" | "https://api.x.ai";
  catalogPath: "/v1/models" | "/v1/language-models";
}>;

const OPENAI: CloudProviderDefinition = Object.freeze({
  providerId: "openai",
  displayName: "OpenAI",
  transportId: "openai-responses-v1",
  origin: "https://api.openai.com",
  catalogPath: "/v1/models",
});

const XAI: CloudProviderDefinition = Object.freeze({
  providerId: "xai",
  displayName: "xAI",
  transportId: "xai-responses-v1",
  origin: "https://api.x.ai",
  catalogPath: "/v1/language-models",
});

const DEFAULTS = Object.freeze({
  totalTimeoutMs: 300_000,
  maxJsonBytes: 4 * 1024 * 1024,
  maxErrorBytes: 16 * 1024,
  maxSseEventChars: 4 * 1024 * 1024,
  maxToolCalls: 128,
  maxToolArgumentChars: 4 * 1024 * 1024,
  maxOutputTokens: 8_192,
});

export class OpenAiBrowserTransport implements InferenceTransport {
  readonly id = OPENAI.transportId;
  readonly posture = "plaintext-remote" as const;
  private readonly delegate: OpenAiResponsesBrowserTransport;

  constructor(options: BrowserCloudTransportOptions) {
    this.delegate = new OpenAiResponsesBrowserTransport(OPENAI, options);
  }

  listModels(signal?: AbortSignal): Promise<readonly InferenceModelDescriptor[]> {
    return this.delegate.listModels(signal);
  }

  stream(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent> {
    return this.delegate.stream(request, signal);
  }
}

export class XaiBrowserTransport implements InferenceTransport {
  readonly id = XAI.transportId;
  readonly posture = "plaintext-remote" as const;
  private readonly delegate: OpenAiResponsesBrowserTransport;

  constructor(options: BrowserCloudTransportOptions) {
    this.delegate = new OpenAiResponsesBrowserTransport(XAI, options);
  }

  listModels(signal?: AbortSignal): Promise<readonly InferenceModelDescriptor[]> {
    return this.delegate.listModels(signal);
  }

  stream(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent> {
    return this.delegate.stream(request, signal);
  }
}

class OpenAiResponsesBrowserTransport implements InferenceTransport {
  readonly id: string;
  readonly posture = "plaintext-remote" as const;
  private readonly options: ResolvedBrowserOptions;

  constructor(
    private readonly provider: CloudProviderDefinition,
    options: BrowserCloudTransportOptions,
  ) {
    this.id = provider.transportId;
    this.options = resolveOptions(options);
  }

  async listModels(
    parentSignal: AbortSignal = new AbortController().signal,
  ): Promise<readonly InferenceModelDescriptor[]> {
    const lifetime = new RequestLifetime(parentSignal, this.options.totalTimeoutMs);
    try {
      const response = await this.request(
        `${this.provider.origin}${this.provider.catalogPath}`,
        { method: "GET" },
        lifetime.signal,
      );
      const payload = await readJson(response, this.options.maxJsonBytes, this.provider.displayName);
      const observedAt = new Date(this.options.now()).toISOString();
      const records = this.provider.providerId === "xai"
        ? recordArray(payload, "models")
        : recordArray(payload, "data");
      return Object.freeze(
        records.slice(0, 2_048).flatMap((record) => {
          const id = boundedString(record.id, 512);
          if (!id) return [];
          const capabilities =
            this.provider.providerId === "xai"
              ? xaiCapabilities(record, observedAt)
              : openAiUnknownCapabilities();
          return [
            Object.freeze({
              version: 1 as const,
              connectionId: this.options.connectionId,
              connectionGeneration: this.options.connectionGeneration,
              providerId: this.provider.providerId,
              id,
              label: id,
              capabilities,
              availability: Object.freeze({
                state: "unknown" as const,
                source: "provider-directory" as const,
                observedAt,
              }),
              source: Object.freeze({
                kind: "provider-directory" as const,
                observedAt,
                sourceUrl: `${this.provider.origin}${this.provider.catalogPath}`,
              }),
            }),
          ];
        }),
      );
    } finally {
      lifetime.dispose();
    }
  }

  async *stream(
    request: InferenceRequest,
    parentSignal: AbortSignal,
  ): AsyncIterable<InferenceEvent> {
    const lifetime = new RequestLifetime(parentSignal, this.options.totalTimeoutMs);
    let completed = false;
    try {
      const response = await this.request(
        `${this.provider.origin}/v1/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildResponsesPayload(request)),
        },
        lifetime.signal,
      );
      requireEventStream(response, this.provider.displayName);
      const assembler = new ResponsesStreamAssembler(this.options);
      for await (const message of parseSse(
        response,
        lifetime.signal,
        this.options.maxSseEventChars,
      )) {
        for (const event of assembler.consume(message)) {
          if (event.type === "completed") completed = true;
          yield event;
        }
      }
      if (!completed) {
        throw new ProviderTransportError(
          "stream-truncated",
          `${this.provider.displayName} ended its response before a terminal event.`,
        );
      }
    } finally {
      lifetime.dispose();
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.options.withApiKey(signal, async (apiKey) => {
      let response: Response;
      try {
        response = await this.options.fetch(url, {
          ...init,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal,
          headers: {
            ...objectHeaders(init.headers),
            authorization: `Bearer ${apiKey}`,
          },
        });
      } catch (error) {
        throw normalizeFetchFailure(error, signal, this.provider.displayName);
      }
      if (!response.ok) {
        await discardBounded(response, this.options.maxErrorBytes);
        throw new ProviderTransportError(
          "http",
          `${this.provider.displayName} rejected the request with HTTP ${response.status}.`,
          response.status,
        );
      }
      return response;
    });
  }
}

export class AnthropicBrowserTransport implements InferenceTransport {
  readonly id = "anthropic-messages-v1";
  readonly posture = "plaintext-remote" as const;
  private readonly options: ResolvedBrowserOptions;

  constructor(options: BrowserCloudTransportOptions) {
    this.options = resolveOptions(options);
  }

  async listModels(
    parentSignal: AbortSignal = new AbortController().signal,
  ): Promise<readonly InferenceModelDescriptor[]> {
    const lifetime = new RequestLifetime(parentSignal, this.options.totalTimeoutMs);
    try {
      const records: Record<string, unknown>[] = [];
      let afterId: string | undefined;
      for (let page = 0; page < 16 && records.length < 2_048; page += 1) {
        const url = new URL("https://api.anthropic.com/v1/models");
        url.searchParams.set("limit", "100");
        if (afterId) url.searchParams.set("after_id", afterId);
        const response = await this.request(url.toString(), { method: "GET" }, lifetime.signal);
        const payload = await readJson(response, this.options.maxJsonBytes, "Anthropic");
        const pageRecords = recordArray(payload, "data");
        records.push(...pageRecords);
        if (!isRecord(payload) || payload.has_more !== true) break;
        afterId = boundedString(payload.last_id, 512);
        if (!afterId || pageRecords.length === 0) {
          throw new ProviderTransportError(
            "invalid-response",
            "Anthropic returned a non-progressing model catalog page.",
          );
        }
      }
      if (records.length > 2_048) {
        throw new ProviderTransportError(
          "response-too-large",
          "Anthropic returned more model records than the client accepts.",
        );
      }
      const observedAt = new Date(this.options.now()).toISOString();
      return Object.freeze(
        records.flatMap((record) => {
          const id = boundedString(record.id, 512);
          if (!id) return [];
          return [
            Object.freeze({
              version: 1 as const,
              connectionId: this.options.connectionId,
              connectionGeneration: this.options.connectionGeneration,
              providerId: "anthropic",
              id,
              label: boundedString(record.display_name, 160) ?? id,
              capabilities: Object.freeze({}),
              availability: Object.freeze({
                state: "unknown" as const,
                source: "provider-directory" as const,
                observedAt,
              }),
              source: Object.freeze({
                kind: "provider-directory" as const,
                observedAt,
                sourceUrl: "https://api.anthropic.com/v1/models",
              }),
            }),
          ];
        }),
      );
    } finally {
      lifetime.dispose();
    }
  }

  async *stream(
    request: InferenceRequest,
    parentSignal: AbortSignal,
  ): AsyncIterable<InferenceEvent> {
    const lifetime = new RequestLifetime(parentSignal, this.options.totalTimeoutMs);
    let completed = false;
    try {
      const response = await this.request(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildAnthropicPayload(request, this.options.maxOutputTokens)),
        },
        lifetime.signal,
      );
      requireEventStream(response, "Anthropic");
      const assembler = new AnthropicStreamAssembler(this.options);
      for await (const message of parseSse(
        response,
        lifetime.signal,
        this.options.maxSseEventChars,
      )) {
        for (const event of assembler.consume(message)) {
          if (event.type === "completed") completed = true;
          yield event;
        }
      }
      if (!completed) {
        throw new ProviderTransportError(
          "stream-truncated",
          "Anthropic ended its response before message_stop.",
        );
      }
    } finally {
      lifetime.dispose();
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.options.withApiKey(signal, async (apiKey) => {
      let response: Response;
      try {
        response = await this.options.fetch(url, {
          ...init,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal,
          headers: {
            ...objectHeaders(init.headers),
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            // Anthropic requires an explicit acknowledgement for direct browser
            // API use. Airship still treats this as a user-opted compatibility path.
            "anthropic-dangerous-direct-browser-access": "true",
          },
        });
      } catch (error) {
        throw normalizeFetchFailure(error, signal, "Anthropic");
      }
      if (!response.ok) {
        await discardBounded(response, this.options.maxErrorBytes);
        throw new ProviderTransportError(
          "http",
          `Anthropic rejected the request with HTTP ${response.status}.`,
          response.status,
        );
      }
      return response;
    });
  }
}

type SseMessage = Readonly<{ event?: string; data: string }>;

class ResponsesStreamAssembler {
  private readonly toolCalls = new Map<string, { id: string; name: string; argumentsJson: string }>();
  private sawTerminal = false;

  constructor(private readonly options: ResolvedBrowserOptions) {}

  consume(message: SseMessage): InferenceEvent[] {
    if (message.data.trim() === "[DONE]") return [];
    if (this.sawTerminal) {
      throw new ProviderTransportError("invalid-response", "Provider sent data after a terminal event.");
    }
    const payload = parseRecord(message.data, "Responses stream event");
    const type = boundedString(payload.type, 128) ?? message.event;
    if (type === "error") {
      throw new ProviderTransportError("invalid-response", "Provider returned a streaming error.");
    }
    if (type === "response.output_text.delta") {
      return typeof payload.delta === "string" && payload.delta
        ? [{ type: "text-delta", text: payload.delta }]
        : [];
    }
    if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") {
      return [{ type: "progress", phase: "reasoning" }];
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = isRecord(payload.item) ? payload.item : undefined;
      if (item?.type === "function_call") this.captureToolItem(item, type.endsWith(".done"));
      return [];
    }
    if (type === "response.function_call_arguments.delta") {
      const id = toolIdentity(payload);
      const tool = this.requireTool(id);
      if (typeof payload.delta === "string") {
        tool.argumentsJson += payload.delta;
        this.checkArguments(tool);
      }
      return [];
    }
    if (type === "response.completed" || type === "response.incomplete") {
      this.sawTerminal = true;
      const response = isRecord(payload.response) ? payload.response : payload;
      const events: InferenceEvent[] = [];
      const usage = isRecord(response.usage) ? response.usage : undefined;
      const inputTokens = tokenCount(usage?.input_tokens);
      const outputTokens = tokenCount(usage?.output_tokens);
      if (inputTokens !== undefined || outputTokens !== undefined) {
        events.push({ type: "usage", inputTokens, outputTokens });
      }
      const calls = [...this.toolCalls.values()].map(parseToolCall);
      events.push(...calls.map((call): InferenceEvent => ({ type: "tool-call", call })));
      events.push({
        type: "completed",
        finishReason:
          type === "response.incomplete" ? "length" : calls.length > 0 ? "tool-calls" : "stop",
      });
      return events;
    }
    return [];
  }

  private captureToolItem(item: Record<string, unknown>, completed: boolean) {
    const id = toolIdentity(item);
    let tool = this.toolCalls.get(id);
    if (!tool) {
      if (this.toolCalls.size >= this.options.maxToolCalls) {
        throw new ProviderTransportError("tool-call-invalid", "Provider returned too many tool calls.");
      }
      tool = {
        id: boundedString(item.call_id, 512) ?? id,
        name: boundedString(item.name, 512) ?? "",
        argumentsJson: "",
      };
      this.toolCalls.set(id, tool);
    }
    if (boundedString(item.name, 512)) tool.name = boundedString(item.name, 512)!;
    if (completed && typeof item.arguments === "string") tool.argumentsJson = item.arguments;
    this.checkArguments(tool);
  }

  private requireTool(id: string) {
    let tool = this.toolCalls.get(id);
    if (!tool) {
      if (this.toolCalls.size >= this.options.maxToolCalls) {
        throw new ProviderTransportError("tool-call-invalid", "Provider returned too many tool calls.");
      }
      tool = { id, name: "", argumentsJson: "" };
      this.toolCalls.set(id, tool);
    }
    return tool;
  }

  private checkArguments(tool: { argumentsJson: string }) {
    if (tool.argumentsJson.length > this.options.maxToolArgumentChars) {
      throw new ProviderTransportError("tool-call-invalid", "Provider tool arguments exceed the client limit.");
    }
  }
}

class AnthropicStreamAssembler {
  private readonly tools = new Map<number, { id: string; name: string; argumentsJson: string }>();
  private stopReason: string | undefined;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private reportedReasoning = false;
  private sawTerminal = false;

  constructor(private readonly options: ResolvedBrowserOptions) {}

  consume(message: SseMessage): InferenceEvent[] {
    if (this.sawTerminal) {
      throw new ProviderTransportError("invalid-response", "Anthropic sent data after message_stop.");
    }
    const payload = parseRecord(message.data, "Anthropic stream event");
    const type = boundedString(payload.type, 128) ?? message.event;
    if (type === "error") {
      throw new ProviderTransportError("invalid-response", "Anthropic returned a streaming error.");
    }
    if (type === "message_start") {
      const root = isRecord(payload.message) ? payload.message : undefined;
      const usage = isRecord(root?.usage) ? root.usage : undefined;
      this.inputTokens = tokenCount(usage?.input_tokens);
      return [];
    }
    if (type === "content_block_start") {
      const index = streamIndex(payload.index);
      const block = isRecord(payload.content_block) ? payload.content_block : undefined;
      if (block?.type === "tool_use") {
        if (this.tools.size >= this.options.maxToolCalls) {
          throw new ProviderTransportError("tool-call-invalid", "Anthropic returned too many tool calls.");
        }
        const id = boundedString(block.id, 512);
        const name = boundedString(block.name, 512);
        if (!id || !name) {
          throw new ProviderTransportError("tool-call-invalid", "Anthropic tool call has no ID or name.");
        }
        const initial = isJsonValue(block.input) ? JSON.stringify(block.input) : "";
        this.tools.set(index, { id, name, argumentsJson: initial === "{}" ? "" : initial });
      }
      return [];
    }
    if (type === "content_block_delta") {
      const delta = isRecord(payload.delta) ? payload.delta : undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        return [{ type: "text-delta", text: delta.text }];
      }
      if (delta?.type === "thinking_delta") {
        if (this.reportedReasoning) return [];
        this.reportedReasoning = true;
        return [{ type: "progress", phase: "reasoning" }];
      }
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const tool = this.tools.get(streamIndex(payload.index));
        if (!tool) {
          throw new ProviderTransportError("tool-call-invalid", "Anthropic streamed arguments before a tool call.");
        }
        tool.argumentsJson += delta.partial_json;
        if (tool.argumentsJson.length > this.options.maxToolArgumentChars) {
          throw new ProviderTransportError("tool-call-invalid", "Anthropic tool arguments exceed the client limit.");
        }
      }
      return [];
    }
    if (type === "message_delta") {
      const delta = isRecord(payload.delta) ? payload.delta : undefined;
      this.stopReason = boundedString(delta?.stop_reason, 128) ?? this.stopReason;
      const usage = isRecord(payload.usage) ? payload.usage : undefined;
      this.outputTokens = tokenCount(usage?.output_tokens) ?? this.outputTokens;
      return [];
    }
    if (type === "message_stop") {
      this.sawTerminal = true;
      const calls = [...this.tools.values()].map(parseToolCall);
      const events: InferenceEvent[] = [];
      if (this.inputTokens !== undefined || this.outputTokens !== undefined) {
        events.push({
          type: "usage",
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
        });
      }
      events.push(...calls.map((call): InferenceEvent => ({ type: "tool-call", call })));
      events.push({
        type: "completed",
        finishReason:
          this.stopReason === "max_tokens"
            ? "length"
            : calls.length > 0 || this.stopReason === "tool_use"
              ? "tool-calls"
              : "stop",
      });
      return events;
    }
    return [];
  }
}

function buildResponsesPayload(request: InferenceRequest): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const message of request.messages) input.push(...toResponsesInput(message));
  return {
    model: request.model,
    instructions: request.systemPrompt,
    input,
    tools: request.tools.map(toResponsesTool),
    tool_choice: "auto",
    parallel_tool_calls: true,
    stream: true,
    store: false,
  };
}

function toResponsesInput(message: CanonicalMessage): Record<string, unknown>[] {
  if (message.role === "tool") {
    if (!message.toolCallId) {
      throw new ProviderTransportError("invalid-response", "A tool result has no call ID.");
    }
    return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  }
  const output: Record<string, unknown>[] = [];
  if (message.role === "assistant" && message.toolCalls?.length) {
    if (message.content) output.push({ role: "assistant", content: message.content });
    output.push(
      ...message.toolCalls.map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })),
    );
    return output;
  }
  if (message.images?.length) {
    if (message.role !== "user") {
      throw new ProviderTransportError("invalid-response", "Only user messages may contain images.");
    }
    return [{
      role: "user",
      content: [
        { type: "input_text", text: message.content },
        ...message.images.map((image) => ({
          type: "input_image",
          image_url: image.dataUrl,
          detail: "auto",
        })),
      ],
    }];
  }
  return [{ role: message.role, content: message.content }];
}

function toResponsesTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
}

function buildAnthropicPayload(
  request: InferenceRequest,
  maxOutputTokens: number,
): Record<string, unknown> {
  return {
    model: request.model,
    system: request.systemPrompt,
    max_tokens: maxOutputTokens,
    messages: request.messages.map(toAnthropicMessage),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
    tool_choice: { type: "auto" },
    stream: true,
  };
}

function toAnthropicMessage(message: CanonicalMessage): Record<string, unknown> {
  if (message.role === "tool") {
    if (!message.toolCallId) {
      throw new ProviderTransportError("invalid-response", "A tool result has no call ID.");
    }
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }],
    };
  }
  const content: Record<string, unknown>[] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  if (message.images?.length) {
    if (message.role !== "user") {
      throw new ProviderTransportError("invalid-response", "Only user messages may contain images.");
    }
    content.push(
      ...message.images.map((image) => ({
        type: "image",
        source: anthropicImageSource(image.dataUrl),
      })),
    );
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    content.push(
      ...message.toolCalls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.arguments,
      })),
    );
  }
  return { role: message.role, content };
}

function anthropicImageSource(dataUrl: string): Record<string, unknown> {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUrl);
  if (!match) {
    throw new ProviderTransportError("invalid-response", "Anthropic image input has an unsupported data URL.");
  }
  return { type: "base64", media_type: match[1], data: match[2] };
}

function openAiUnknownCapabilities(): Readonly<
  Partial<Record<ModelCapability, ModelCapabilityEvidence>>
> {
  return Object.freeze({});
}

function xaiCapabilities(
  record: Record<string, unknown>,
  observedAt: string,
): Readonly<Partial<Record<ModelCapability, ModelCapabilityEvidence>>> {
  const input = stringArray(record.input_modalities);
  const output = stringArray(record.output_modalities);
  const capabilities: Partial<Record<ModelCapability, ModelCapabilityEvidence>> = {};
  if (input) {
    capabilities["text-input"] = capabilityEvidence(input.includes("text"), observedAt);
    capabilities["image-input"] = capabilityEvidence(input.includes("image"), observedAt);
    capabilities["audio-input"] = capabilityEvidence(input.includes("audio"), observedAt);
  }
  if (output) {
    capabilities["text-output"] = capabilityEvidence(output.includes("text"), observedAt);
    capabilities["audio-output"] = capabilityEvidence(output.includes("audio"), observedAt);
  }
  return Object.freeze(capabilities);
}

function capabilityEvidence(
  supported: boolean,
  observedAt: string,
): ModelCapabilityEvidence {
  return Object.freeze({
    state: supported ? "supported" : "unsupported",
    source: "provider-directory",
    observedAt,
  });
}

function resolveOptions(options: BrowserCloudTransportOptions): ResolvedBrowserOptions {
  if ((typeof options.getApiKey === "function") === (options.connections !== undefined)) {
    throw new TypeError("Provide exactly one page-memory connection registry or API-key getter.");
  }
  const connectionId = requiredString(options.connectionId, "Connection ID", 512);
  const connectionGeneration = positiveInteger(
    options.connectionGeneration,
    "connectionGeneration",
  );
  const withApiKey: ResolvedBrowserOptions["withApiKey"] = options.connections
    ? async (signal, use) => options.connections!.useCredential(
        connectionId,
        { expectedGeneration: connectionGeneration, signal },
        (leased) => {
          if (leased.kind !== "api-key") {
            throw new TypeError(
              `Inference connection ${connectionId} does not contain an API key.`,
            );
          }
          return use(leased.value);
        },
      )
    : async (signal, use) => use(await resolveApiKey(options.getApiKey!, signal));
  if (!globalThis.fetch && !options.fetch) throw new TypeError("Fetch is unavailable.");
  return Object.freeze({
    connectionId,
    connectionGeneration,
    withApiKey,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    totalTimeoutMs: positiveInteger(options.totalTimeoutMs ?? DEFAULTS.totalTimeoutMs, "totalTimeoutMs"),
    maxJsonBytes: positiveInteger(options.maxJsonBytes ?? DEFAULTS.maxJsonBytes, "maxJsonBytes"),
    maxErrorBytes: positiveInteger(options.maxErrorBytes ?? DEFAULTS.maxErrorBytes, "maxErrorBytes"),
    maxSseEventChars: positiveInteger(
      options.maxSseEventChars ?? DEFAULTS.maxSseEventChars,
      "maxSseEventChars",
    ),
    maxToolCalls: positiveInteger(options.maxToolCalls ?? DEFAULTS.maxToolCalls, "maxToolCalls"),
    maxToolArgumentChars: positiveInteger(
      options.maxToolArgumentChars ?? DEFAULTS.maxToolArgumentChars,
      "maxToolArgumentChars",
    ),
    maxOutputTokens: positiveInteger(
      options.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
      "maxOutputTokens",
    ),
    now: options.now ?? Date.now,
  });
}

class RequestLifetime {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timeout: ReturnType<typeof setTimeout>;
  private readonly abortFromParent: () => void;
  private readonly parent: AbortSignal;

  constructor(parent: AbortSignal, timeoutMs: number) {
    this.parent = parent;
    this.signal = this.controller.signal;
    this.abortFromParent = () =>
      this.controller.abort(parent.reason ?? new DOMException("Inference cancelled.", "AbortError"));
    if (parent.aborted) this.abortFromParent();
    else parent.addEventListener("abort", this.abortFromParent, { once: true });
    this.timeout = setTimeout(
      () => this.controller.abort(new ProviderTransportError("timeout", "Provider request timed out.")),
      timeoutMs,
    );
  }

  dispose() {
    clearTimeout(this.timeout);
    this.parent.removeEventListener("abort", this.abortFromParent);
  }
}

async function resolveApiKey(getter: ProviderApiKeyGetter, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw normalizedAbort(signal);
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(normalizedAbort(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const key = await Promise.race([Promise.resolve().then(getter), abort]);
    return requiredString(key, "Provider API key", 16 * 1024);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function normalizeFetchFailure(
  error: unknown,
  signal: AbortSignal,
  provider: string,
): ProviderTransportError {
  if (signal.aborted) return normalizedAbort(signal);
  return new ProviderTransportError(
    "network-or-cors",
    `${provider} could not be reached from this browser. The cause may be network reachability, provider availability, or CORS policy; no inference completion was accepted.`,
    undefined,
    { cause: error },
  );
}

function normalizedAbort(signal: AbortSignal): ProviderTransportError {
  return signal.reason instanceof ProviderTransportError
    ? signal.reason
    : new ProviderTransportError("cancelled", "Provider request was cancelled.", undefined, {
        cause: signal.reason,
      });
}

async function readJson(response: Response, maxBytes: number, provider: string): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    await discardBounded(response, maxBytes);
    throw new ProviderTransportError(
      "invalid-content-type",
      `${provider} returned a non-JSON catalog response.`,
    );
  }
  const text = await readBoundedText(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProviderTransportError(
      "invalid-response",
      `${provider} returned invalid JSON.`,
      undefined,
      { cause: error },
    );
  }
}

function requireEventStream(response: Response, provider: string) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    void response.body?.cancel();
    throw new ProviderTransportError(
      "invalid-content-type",
      `${provider} returned a non-SSE inference response.`,
    );
  }
  if (!response.body) {
    throw new ProviderTransportError("invalid-response", `${provider} returned no response body.`);
  }
}

async function* parseSse(
  response: Response,
  signal: AbortSignal,
  maxEventChars: number,
): AsyncIterable<SseMessage> {
  if (!response.body) throw new ProviderTransportError("invalid-response", "SSE body is missing.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parser = new ProviderSseParser(maxEventChars);
  try {
    for (;;) {
      if (signal.aborted) throw normalizedAbort(signal);
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parser.push(decoder.decode(value, { stream: true }))) yield message;
    }
    for (const message of parser.push(decoder.decode(), true)) yield message;
  } catch (error) {
    if (signal.aborted) throw normalizedAbort(signal);
    if (error instanceof ProviderTransportError) throw error;
    throw new ProviderTransportError("invalid-response", "Provider SSE decoding failed.", undefined, {
      cause: error,
    });
  } finally {
    reader.releaseLock();
  }
}

class ProviderSseParser {
  private buffer = "";
  private data: string[] = [];
  private event?: string;
  private eventChars = 0;

  constructor(private readonly maxEventChars: number) {}

  push(chunk: string, final = false): SseMessage[] {
    this.buffer += chunk;
    if (this.buffer.length + this.eventChars > this.maxEventChars) this.limit();
    const messages: SseMessage[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/u.exec(this.buffer);
      if (!match) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line, messages);
    }
    if (final) {
      if (this.buffer) this.line(this.buffer, messages);
      this.buffer = "";
      this.dispatch(messages);
    }
    return messages;
  }

  private line(line: string, messages: SseMessage[]) {
    if (!line) {
      this.dispatch(messages);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    if (field === "data") {
      this.eventChars += value.length + 1;
      if (this.eventChars > this.maxEventChars) this.limit();
      this.data.push(value);
    }
  }

  private dispatch(messages: SseMessage[]) {
    if (this.data.length) {
      messages.push(Object.freeze({ ...(this.event ? { event: this.event } : {}), data: this.data.join("\n") }));
    }
    this.data = [];
    this.event = undefined;
    this.eventChars = 0;
  }

  private limit(): never {
    throw new ProviderTransportError("response-too-large", "Provider SSE event exceeds the client limit.");
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel();
    throw new ProviderTransportError("response-too-large", "Provider response exceeds the client limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel();
        throw new ProviderTransportError("response-too-large", "Provider response exceeds the client limit.");
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function discardBounded(response: Response, maxBytes: number): Promise<void> {
  try {
    await readBoundedText(response, maxBytes);
  } catch {
    void response.body?.cancel();
  }
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ProviderTransportError("invalid-response", `${label} is invalid JSON.`, undefined, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new ProviderTransportError("invalid-response", `${label} must be an object.`);
  }
  return parsed;
}

function recordArray(payload: unknown, field: string): Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload[field])) {
    throw new ProviderTransportError("invalid-response", `Model catalog has no ${field} array.`);
  }
  return payload[field].filter(isRecord);
}

function parseToolCall(tool: { id: string; name: string; argumentsJson: string }): ToolCall {
  if (!tool.id || !tool.name) {
    throw new ProviderTransportError("tool-call-invalid", "Provider tool call has no ID or name.");
  }
  let args: unknown;
  try {
    args = JSON.parse(tool.argumentsJson || "{}");
  } catch (error) {
    throw new ProviderTransportError("tool-call-invalid", "Provider tool arguments are invalid JSON.", undefined, {
      cause: error,
    });
  }
  if (!isJsonValue(args)) {
    throw new ProviderTransportError("tool-call-invalid", "Provider tool arguments are not JSON.");
  }
  return { id: tool.id, name: tool.name, arguments: args };
}

function toolIdentity(value: Record<string, unknown>): string {
  const id =
    boundedString(value.item_id, 512) ??
    boundedString(value.id, 512) ??
    boundedString(value.call_id, 512);
  if (!id) throw new ProviderTransportError("tool-call-invalid", "Provider tool event has no identity.");
  return id;
}

function streamIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderTransportError("invalid-response", "Provider stream index is invalid.");
  }
  return value as number;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value.map((item) => item.toLowerCase());
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u0020\u007f]/u.test(normalized)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function objectHeaders(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
