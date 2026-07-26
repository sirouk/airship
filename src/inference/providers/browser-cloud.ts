import type {
  CanonicalMessage,
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  JsonValue,
  ToolCall,
  ToolDefinition,
} from "../../core/contracts";
import {
  MAX_MODEL_OUTPUT_TOKENS,
  type InferenceModelDescriptor,
  type ModelCapability,
  type ModelCapabilityEvidence,
} from "./contracts";
import type { InferenceConnectionRegistry } from "./connection-registry";
import { ExtensionBridgeClient, pageExtensionBridge } from "../bridge/client";
import {
  ANTHROPIC_OAUTH_INFERENCE_HEADERS,
  ExtensionBridgeError,
  type BridgeProviderId,
} from "../bridge/protocol";

export type ProviderApiKeyGetter = () => string | Promise<string>;
export type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * What a transport actually borrowed for one request. The kind decides the
 * route: API keys keep the direct browser path they have always used, while an
 * OAuth token for a provider that refuses browser-shaped requests can only
 * leave through the extension bridge.
 */
type LeasedCredential = Readonly<{
  kind: "api-key" | "oauth-access-token";
  value: string;
}>;

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
  /**
   * Per-model output ceiling for providers that require an explicit one.
   *
   * A transport is constructed once per connection, before any model has been
   * selected, so a single `maxOutputTokens` cannot express a per-model limit.
   * Return `undefined` when nothing has been declared for that model; the
   * connection-wide default then applies.
   */
  maxOutputTokensForModel?: (modelId: string) => number | undefined;
  /**
   * Page-side extension bridge for OAuth-token routes.
   *
   * Left unset, the page's own client is used when this runtime has a window to
   * relay through — holding a client is not a claim that an extension exists,
   * which only the live handshake can answer. Pass `null` to state that no
   * bridge may be used at all, which is what proves the honest `unavailable`
   * path.
   */
  bridge?: ExtensionBridgeClient | null;
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
  | "tool-call-invalid"
  /** No extension answered, or it will not carry this provider. Never a network verdict. */
  | "bridge-unavailable"
  /** The bridge exists and declined this exchange. */
  | "bridge-refused"
  /** The bridge answered with something the wire contract rejects. */
  | "bridge-protocol";

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
  withCredential: <T>(
    signal: AbortSignal,
    use: (credential: LeasedCredential) => Promise<T>,
  ) => Promise<T>;
  bridge?: ExtensionBridgeClient;
  fetch: ProviderFetch;
  totalTimeoutMs: number;
  maxJsonBytes: number;
  maxErrorBytes: number;
  maxSseEventChars: number;
  maxToolCalls: number;
  maxToolArgumentChars: number;
  maxOutputTokens: number;
  maxOutputTokensForModel?: (modelId: string) => number | undefined;
  now: () => number;
}>;

type CloudProviderDefinition = Readonly<{
  providerId: "openai" | "xai";
  displayName: "OpenAI" | "xAI";
  transportId: "openai-responses-v1" | "xai-responses-v1";
  origin: "https://api.openai.com" | "https://api.x.ai";
  catalogPath: "/v1/models" | "/v1/language-models";
  /**
   * Set only where a page genuinely cannot reach the provider with an OAuth
   * token. `https://api.x.ai` sends no `access-control-allow-origin`, so the
   * browser discards the reply even though the request is sent; OpenAI's token
   * host answers `*`, so its OAuth path stays direct and needs no extension.
   */
  oauthBridgeProvider?: BridgeProviderId;
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
  oauthBridgeProvider: "xai",
});

const DEFAULTS = Object.freeze({
  totalTimeoutMs: 300_000,
  maxJsonBytes: 4 * 1024 * 1024,
  maxErrorBytes: 16 * 1024,
  maxSseEventChars: 4 * 1024 * 1024,
  maxToolCalls: 128,
  maxToolArgumentChars: 4 * 1024 * 1024,
  /*
   * Anthropic requires `max_tokens` on every Messages request, and this
   * transport is bound to a connection rather than to a model, so one number
   * has to stand in before any model is chosen.
   *
   * This is deliberately NOT a claimed ceiling — Anthropic's directory
   * publishes no per-model limit and Airship refuses to infer one from a model
   * name. It is the output budget a turn asks for when nothing better is
   * known, and it is generous on purpose: a budget below a model's real limit
   * quietly shortens every reply, whereas a budget above it is refused, per
   * Anthropic's published Messages contract, with a 400 that states the real
   * limit. `AnthropicBrowserTransport` adopts that stated limit and retries
   * once, so an over-ask self-corrects while an under-ask would not.
   */
  maxOutputTokens: 64_000,
});

/** Distinct models one Anthropic connection may remember a stated ceiling for. */
const MAX_OBSERVED_OUTPUT_CEILINGS = 256;

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
        false,
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
        true,
      );
      requireEventStream(response, this.provider.displayName);
      const assembler = new ResponsesStreamAssembler(this.options);
      for await (const message of parseSse(
        response,
        lifetime.signal,
        this.options.maxSseEventChars,
        this.provider.displayName,
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
    streaming: boolean,
  ): Promise<Response> {
    return this.options.withCredential(signal, async (credential) => {
      /*
       * Both credential kinds present the same bearer header; only the route
       * differs. An xAI OAuth token cannot travel the direct path at all — the
       * browser discards a reply that carries no CORS grant — so it goes
       * through the bridge or the request honestly fails as unavailable.
       */
      const headers = {
        ...objectHeaders(init.headers),
        authorization: `Bearer ${credential.value}`,
      };
      const response = await sendProviderRequest({
        options: this.options,
        displayName: this.provider.displayName,
        bridgeProvider: credential.kind === "oauth-access-token"
          ? this.provider.oauthBridgeProvider
          : undefined,
        url,
        init,
        headers,
        signal,
        streaming,
      });
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
  /**
   * Per-model output ceilings Anthropic itself stated while refusing a
   * request, keyed by model ID.
   *
   * This is the only per-model ceiling Airship can obtain without a person
   * asserting one, so it is remembered for the life of the connection rather
   * than re-earned on every turn. It is deliberately not written back into the
   * model catalog: that row's `source` describes the directory listing that
   * produced its ID and label, and a request refusal is not that listing.
   */
  private readonly observedOutputCeilings = new Map<string, number>();

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
        const response = await this.request(url.toString(), { method: "GET" }, lifetime.signal, {});
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
      const response = await this.openMessages(request, lifetime.signal);
      requireEventStream(response, "Anthropic");
      const assembler = new AnthropicStreamAssembler(this.options);
      for await (const message of parseSse(
        response,
        lifetime.signal,
        this.options.maxSseEventChars,
        "Anthropic",
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

  /**
   * Open the Messages stream, allowing at most one corrected re-send.
   *
   * The first send carries whatever ceiling Airship currently holds for this
   * model. Only when Anthropic refuses it by naming the model's own limit is a
   * second sent, and that second carries a number the vendor itself supplied —
   * so a second refusal is a real failure and is raised untouched. There is no
   * third attempt and no fallback to a number nobody chose.
   *
   * An operator declaration outranks an observed ceiling, so a declared model
   * would re-send the identical number and be refused identically. That send
   * is skipped: the operator's number is authoritative and its refusal is
   * theirs to see, not something to quietly correct.
   */
  private async openMessages(
    request: InferenceRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const first = await this.sendMessages(request, signal);
    if (first.kind === "response") return first.response;
    if (this.options.maxOutputTokensForModel?.(request.model) !== undefined) throw first.error;
    /*
     * One connection is not expected to exercise anywhere near this many
     * models, but the map is fed by request traffic, so it gets a ceiling like
     * every other input. Past it the oldest entry is dropped; the only cost of
     * dropping one is a single re-learning round trip.
     */
    if (this.observedOutputCeilings.size >= MAX_OBSERVED_OUTPUT_CEILINGS) {
      const oldest = this.observedOutputCeilings.keys().next();
      if (!oldest.done) this.observedOutputCeilings.delete(oldest.value);
    }
    this.observedOutputCeilings.set(request.model, first.statedCeiling);
    const second = await this.sendMessages(request, signal);
    if (second.kind === "response") return second.response;
    throw second.error;
  }

  private async sendMessages(
    request: InferenceRequest,
    signal: AbortSignal,
  ): Promise<AnthropicMessagesAttempt> {
    const maxOutputTokens = resolveRequestOutputTokens(
      this.options,
      request.model,
      this.observedOutputCeilings,
    );
    const refusal: { body: string | undefined } = { body: undefined };
    try {
      const response = await this.request(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildAnthropicPayload(request, maxOutputTokens)),
        },
        signal,
        {
          streaming: true,
          captureErrorBody: (body) => {
            refusal.body = body;
          },
        },
      );
      return { kind: "response", response };
    } catch (error) {
      if (!(error instanceof ProviderTransportError) || error.status !== 400 || !refusal.body) {
        throw error;
      }
      const statedCeiling = anthropicStatedOutputCeiling(refusal.body, maxOutputTokens);
      if (statedCeiling === undefined) throw error;
      return { kind: "ceiling-refused", statedCeiling, error };
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    options: Readonly<{ streaming?: boolean; captureErrorBody?: (body: string) => void }>,
  ): Promise<Response> {
    return this.options.withCredential(signal, async (credential) => {
      const oauth = credential.kind === "oauth-access-token";
      const headers = oauth
        ? {
            ...objectHeaders(init.headers),
            authorization: `Bearer ${credential.value}`,
            "anthropic-version": "2023-06-01",
            /*
             * The CLI fingerprint. Anthropic serves the OAuth inference path to
             * Claude Code, and `user-agent` is a forbidden header name in
             * JavaScript, so this set exists only because the bridge sets it —
             * which is exactly why the OAuth route has no direct fallback.
             */
            ...ANTHROPIC_OAUTH_INFERENCE_HEADERS,
          }
        : {
            ...objectHeaders(init.headers),
            "x-api-key": credential.value,
            "anthropic-version": "2023-06-01",
            // Anthropic requires an explicit acknowledgement for direct browser
            // API use. Airship still treats this as a user-opted compatibility path.
            "anthropic-dangerous-direct-browser-access": "true",
          };
      const response = await sendProviderRequest({
        options: this.options,
        displayName: "Anthropic",
        bridgeProvider: oauth ? "anthropic" : undefined,
        url,
        init,
        headers,
        signal,
        streaming: options.streaming === true,
      });
      const captureErrorBody = options.captureErrorBody;
      if (!response.ok) {
        /*
         * The refusal body is read only when a caller asked to inspect it, and
         * even then it never reaches the thrown error: the caller sees the
         * status plus Airship's own sentence, exactly as before.
         */
        if (captureErrorBody) {
          captureErrorBody(await readErrorBody(response, this.options.maxErrorBytes));
        } else {
          await discardBounded(response, this.options.maxErrorBytes);
        }
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

/** One Messages send: either a stream, or a refusal that named the real ceiling. */
type AnthropicMessagesAttempt =
  | Readonly<{ kind: "response"; response: Response }>
  | Readonly<{ kind: "ceiling-refused"; statedCeiling: number; error: ProviderTransportError }>;

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
  const tools = request.tools.map(toResponsesTool);
  return {
    model: request.model,
    instructions: request.systemPrompt,
    input,
    stream: true,
    store: false,
    /*
     * `tool_choice` and `parallel_tool_calls` are only meaningful alongside a
     * non-empty `tools` array, and the Responses contract validates a
     * tool-selection field against the declared list — so a request that sends
     * them with `tools: []` is one OpenAI or xAI would be entitled to refuse.
     * Whether either actually refuses it has never been observed here (no
     * vendor key exists in this repository), which is precisely why the whole
     * tool block is omitted rather than left to chance: the fabric's mandatory
     * activation probe (fabric.ts verifyInvocation) is exactly such a request.
     * This is the same boundary the proven Chutes payload builder already
     * enforces (chutes/openai.ts).
     */
    ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
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
  const tools = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  return {
    model: request.model,
    system: request.systemPrompt,
    max_tokens: maxOutputTokens,
    messages: request.messages.map(toAnthropicMessage),
    stream: true,
    /*
     * Messages requests validate `tool_choice` against the declared tool list,
     * so a toolless turn — including the fabric's mandatory activation probe
     * (fabric.ts verifyInvocation) — must send neither field.
     */
    ...(tools.length ? { tools, tool_choice: { type: "auto" } } : {}),
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

/**
 * Precedence for one request's `max_tokens`: an operator declaration, then a
 * ceiling the vendor stated while refusing an earlier send, then the
 * connection-wide budget.
 *
 * A declaration wins outright even when it exceeds an observed ceiling — the
 * operator's number is authoritative and its refusal is theirs to see. A
 * resolver that answers with something other than a usable token count is a
 * configuration defect, so it fails the request instead of quietly falling
 * back to a number the operator did not choose. Its bound is the same
 * `MAX_MODEL_OUTPUT_TOKENS` the model catalog validates against, so no
 * declaration can be accepted there and rejected here.
 */
function resolveRequestOutputTokens(
  options: ResolvedBrowserOptions,
  modelId: string,
  observedCeilings: ReadonlyMap<string, number>,
): number {
  const declared = options.maxOutputTokensForModel?.(modelId);
  if (declared === undefined) return observedCeilings.get(modelId) ?? options.maxOutputTokens;
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_MODEL_OUTPUT_TOKENS) {
    throw new TypeError(`The declared maximum output for model ${modelId} is invalid.`);
  }
  return declared;
}

/**
 * Recover the model's own output ceiling from an Anthropic refusal, or nothing.
 *
 * Anthropic's published Messages contract answers an over-large `max_tokens`
 * with a 400 `invalid_request_error` whose message states the model's limit,
 * in the shape `max_tokens: <asked> > <limit>, which is the maximum allowed
 * number of output tokens for <model>`. No such response has been observed in
 * this repository — no Anthropic key exists here — so the match is deliberately
 * narrow, and anything that does not match returns `undefined`, leaving the
 * original refusal to propagate. Checked: the error envelope and its
 * `invalid_request_error` type, the bounded message length, the
 * `max_tokens: <asked> > <limit>` prefix, the literal
 * "maximum allowed number of output tokens" clause that must follow it, and
 * `<asked>` being exactly the value this request sent. Deliberately *not*
 * checked: the trailing model name, because Anthropic may echo a resolved alias
 * rather than the id that was requested and this repository has no observation
 * to settle that on. The stated limit must also be strictly below what was
 * asked, which is what makes the single retry terminate.
 */
function anthropicStatedOutputCeiling(body: string, requested: number): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
  if (parsed.error.type !== "invalid_request_error") return undefined;
  const message = parsed.error.message;
  if (typeof message !== "string" || message.length > 4_096) return undefined;
  // The bounded gap keeps the lazy quantifier linear against the 4 KiB cap
  // above; the published clause sits 16 characters after the limit.
  const stated = /max_tokens:\s*(\d{1,9})\s*>\s*(\d{1,9})\b[\s\S]{0,120}?maximum allowed number of output tokens/u.exec(message);
  if (!stated || Number(stated[1]) !== requested) return undefined;
  const ceiling = Number(stated[2]);
  return Number.isSafeInteger(ceiling) && ceiling >= 1 && ceiling < requested ? ceiling : undefined;
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
  const withCredential: ResolvedBrowserOptions["withCredential"] = options.connections
    ? async (signal, use) => options.connections!.useCredential(
        connectionId,
        { expectedGeneration: connectionGeneration, signal },
        (leased) => {
          if (leased.kind === "local-none") {
            throw new TypeError(
              `Inference connection ${connectionId} does not contain a cloud credential.`,
            );
          }
          return use(Object.freeze({ kind: leased.kind, value: leased.value }));
        },
      )
    : async (signal, use) => use(Object.freeze({
        kind: "api-key",
        value: await resolveApiKey(options.getApiKey!, signal),
      }));
  if (!globalThis.fetch && !options.fetch) throw new TypeError("Fetch is unavailable.");
  /*
   * `undefined` means "use whatever relay this page has"; `null` means "no
   * bridge may be used". Neither is a claim about an installed extension —
   * only the live handshake inside the client answers that.
   */
  const bridge = options.bridge === undefined
    ? pageExtensionBridge()
    : options.bridge ?? undefined;
  return Object.freeze({
    connectionId,
    connectionGeneration,
    withCredential,
    ...(bridge ? { bridge } : {}),
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
    ...(options.maxOutputTokensForModel
      ? { maxOutputTokensForModel: options.maxOutputTokensForModel }
      : {}),
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

type ProviderSend = Readonly<{
  options: ResolvedBrowserOptions;
  displayName: string;
  /** Present only when this exact request must leave through the extension. */
  bridgeProvider?: BridgeProviderId;
  url: string;
  init: RequestInit;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  streaming: boolean;
}>;

/**
 * The one place a request chooses its route.
 *
 * Without `bridgeProvider` this is byte-for-byte the direct browser fetch
 * Airship has always issued, including every API-key path. With it, the
 * request is one a page cannot make at all, so there is deliberately no
 * fallback to the direct path: an absent bridge is reported as `unavailable`
 * with its cause named, never as a network failure and never silently.
 */
async function sendProviderRequest(request: ProviderSend): Promise<Response> {
  if (!request.bridgeProvider) {
    try {
      return await request.options.fetch(request.url, {
        ...request.init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: request.signal,
        headers: { ...request.headers },
      });
    } catch (error) {
      throw normalizeFetchFailure(error, request.signal, request.displayName);
    }
  }
  const bridge = request.options.bridge;
  if (!bridge) {
    throw new ProviderTransportError(
      "bridge-unavailable",
      `${request.displayName} OAuth requests cannot be made from a page and require the Airship browser extension. This page has no extension bridge relay, so the OAuth route is unavailable; the API-key route is unaffected.`,
    );
  }
  const method = request.init.method === "POST" ? "POST" : "GET";
  if (request.init.body !== undefined && request.init.body !== null
    && typeof request.init.body !== "string") {
    throw new TypeError("A bridged provider request body must be a string.");
  }
  try {
    return await bridge.fetch({
      provider: request.bridgeProvider,
      url: request.url,
      method,
      headers: request.headers,
      ...(typeof request.init.body === "string" ? { body: request.init.body } : {}),
      stream: request.streaming,
      signal: request.signal,
    });
  } catch (error) {
    throw normalizeBridgeFailure(error, request.displayName, request.signal);
  }
}

/**
 * Map a bridge failure onto this transport's vocabulary without ever letting it
 * read as a network verdict: "no extension answered" is a different fact from
 * "the provider could not be reached", and conflating them would tell an
 * operator to debug their network.
 */
function normalizeBridgeFailure(
  error: unknown,
  provider: string,
  signal?: AbortSignal,
): ProviderTransportError {
  if (error instanceof ProviderTransportError) return error;
  if (!(error instanceof ExtensionBridgeError)) {
    if (signal?.aborted) return normalizedAbort(signal);
    return new ProviderTransportError(
      "bridge-protocol",
      `The extension bridge failed the ${provider} request in a way this client does not recognize.`,
      undefined,
      { cause: error },
    );
  }
  switch (error.code) {
    case "bridge-unavailable":
      return new ProviderTransportError(
        "bridge-unavailable",
        `${provider} OAuth requests require the Airship browser extension. ${error.message}`,
        undefined,
        { cause: error },
      );
    case "bridge-refused":
    case "bridge-busy":
    case "bridge-error":
      return new ProviderTransportError(
        "bridge-refused",
        `The extension bridge declined or could not complete the ${provider} request. ${error.message}`,
        undefined,
        { cause: error },
      );
    case "bridge-too-large":
      return new ProviderTransportError(
        "response-too-large",
        `The bridged ${provider} exchange exceeds a client limit. ${error.message}`,
        undefined,
        { cause: error },
      );
    case "bridge-timeout":
      return new ProviderTransportError(
        "timeout",
        `The bridged ${provider} request timed out.`,
        undefined,
        { cause: error },
      );
    case "bridge-cancelled":
      return signal?.aborted
        ? normalizedAbort(signal)
        : new ProviderTransportError(
            "cancelled",
            `The bridged ${provider} request was cancelled.`,
            undefined,
            { cause: error },
          );
    default:
      return new ProviderTransportError(
        "bridge-protocol",
        `The extension bridge broke the ${provider} exchange. ${error.message}`,
        undefined,
        { cause: error },
      );
  }
}

function normalizeFetchFailure(
  error: unknown,
  signal: AbortSignal,
  provider: string,
): ProviderTransportError {
  if (signal.aborted) return normalizedAbort(signal);
  // A bridged failure that reached here is already a named cause; re-labelling
  // it "network or CORS" would be a guess the client did not make.
  if (error instanceof ProviderTransportError || error instanceof ExtensionBridgeError) {
    return normalizeBridgeFailure(error, provider, signal);
  }
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
  provider: string,
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
    // A bridged stream reports its own failure through the body, so the cause
    // arrives here rather than at the request call; it must keep its name.
    if (error instanceof ExtensionBridgeError) throw normalizeBridgeFailure(error, provider, signal);
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
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (error) {
        // A bridged body fails through the stream. Keep the bridge's own cause
        // rather than letting it surface as an unclassified read error.
        if (error instanceof ExtensionBridgeError) throw normalizeBridgeFailure(error, "The provider");
        throw error;
      }
      if (done) break;
      if (!value) continue;
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

/**
 * Read a bounded refusal body for Airship's own inspection.
 *
 * A body that is oversized, truncated, or not decodable degrades to an empty
 * string rather than replacing the refusal with a parse failure: the caller's
 * original error is what the operator must see.
 */
async function readErrorBody(response: Response, maxBytes: number): Promise<string> {
  try {
    return await readBoundedText(response, maxBytes);
  } catch {
    void response.body?.cancel();
    return "";
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
