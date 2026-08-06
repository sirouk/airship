import { shortHash } from "../hash";
import { sanitizeSurrogates } from "../sanitize";
import { parseStreamingJson } from "../stream-json";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  StopReason,
  TextContent,
  TextSignatureV1,
  ThinkingContent,
  Tool,
  ToolCall,
  Usage,
} from "../types";
import type { AssistantMessageEventStream } from "../event-stream";
import type { ServiceTier } from "../types";
import { applyUsageCost } from "./model-util";
import { classifyStreamFailure, StreamFailureError } from "./stream-failure";
import { transformMessages } from "./transform";

/**
 * Port of prime-agent packages/ai/src/providers/openai-responses-shared.ts:
 * the message/tool conversion and stream-processing core shared by the
 * OpenAI Responses provider (and, upstream, by codex/azure variants that
 * this port excludes — see PORT.md).
 *
 * Signature round-trips are the point of this module: reasoning items are
 * replayed verbatim through `thinkingSignature` (a JSON-serialized reasoning
 * item), assistant text carries its response item id (and phase) as a
 * `TextSignatureV1` JSON string in `textSignature`, and tool call ids keep
 * the `${call_id}|${item_id}` pipe form — all so encrypted reasoning and
 * item pairing survive replay across turns.
 */

// =============================================================================
// Utilities
// =============================================================================

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
  const payload: TextSignatureV1 = { v: 1, id };
  if (phase) payload.phase = phase;
  return JSON.stringify(payload);
}

function parseTextSignature(signature: string | undefined): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
  if (!signature) return undefined;
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
      if (parsed.v === 1 && typeof parsed.id === "string") {
        if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
          return { id: parsed.id, phase: parsed.phase };
        }
        return { id: parsed.id };
      }
    } catch {
      // Fall through to legacy plain-string handling.
    }
  }
  return { id: signature };
}

export interface OpenAIResponsesStreamOptions {
  serviceTier?: ServiceTier;
  resolveServiceTier?: (
    responseServiceTier: ServiceTier | undefined,
    requestServiceTier: ServiceTier | undefined,
  ) => ServiceTier | undefined;
  applyServiceTierPricing?: (usage: Usage, serviceTier: ServiceTier | undefined) => void;
}

export interface ConvertResponsesMessagesOptions {
  includeSystemPrompt?: boolean;
}

export interface ConvertResponsesToolsOptions {
  strict?: boolean | null;
}

// =============================================================================
// Wire payload types (the Responses API subset we speak and read)
// =============================================================================

export interface ResponsesInputText {
  type: "input_text";
  text: string;
}

export interface ResponsesInputImage {
  type: "input_image";
  detail: "auto";
  image_url: string;
}

export type ResponsesInputContent = ResponsesInputText | ResponsesInputImage;

export interface ResponsesInputMessage {
  role: "user" | "system" | "developer";
  content: string | ResponsesInputContent[];
}

export interface ResponsesOutputTextPart {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

export interface ResponsesOutputMessageItem {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed";
  content: ResponsesOutputTextPart[];
  phase?: "commentary" | "final_answer";
}

export interface ResponsesReasoningItem {
  type: "reasoning";
  id?: string;
  summary?: { type: "summary_text"; text: string }[];
  content?: { type: "reasoning_text"; text: string }[];
  encrypted_content?: string | null;
}

export interface ResponsesFunctionCallItem {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string | ResponsesInputContent[];
}

export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesOutputMessageItem
  | ResponsesReasoningItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

export type ResponsesInput = ResponsesInputItem[];

export interface ResponsesToolParam {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
  strict: boolean | null;
}

// Stream item shapes as they arrive inside SSE events.
interface ResponsesStreamReasoningSummaryPart {
  type: string;
  text: string;
}

interface ResponsesStreamMessageContentPart {
  type: "output_text" | "refusal";
  text?: string;
  refusal?: string;
  annotations?: unknown[];
}

interface ResponsesStreamReasoning {
  type: "reasoning";
  id?: string;
  summary?: ResponsesStreamReasoningSummaryPart[];
  content?: { type: "reasoning_text"; text: string }[];
  encrypted_content?: string | null;
}

interface ResponsesStreamMessage {
  type: "message";
  id: string;
  phase?: "commentary" | "final_answer" | null;
  content?: ResponsesStreamMessageContentPart[];
}

interface ResponsesStreamFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments?: string;
}

type ResponsesStreamItem = ResponsesStreamReasoning | ResponsesStreamMessage | ResponsesStreamFunctionCall;

interface ResponsesUsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

interface ResponsesCompletedResponse {
  id?: string;
  usage?: ResponsesUsagePayload;
  service_tier?: "auto" | "default" | "flex" | "scale" | "priority";
  status?: ResponsesStatus;
}

type ResponsesStatus = "completed" | "incomplete" | "failed" | "cancelled" | "in_progress" | "queued";

/**
 * The Responses SSE event vocabulary this port consumes. Background mode
 * and websocket transports are excluded (PORT.md); only the SSE lifecycle
 * events appear here.
 */
export type ResponsesStreamEvent =
  | { type: "response.created"; response: { id?: string } }
  | { type: "response.output_item.added"; item: ResponsesStreamItem }
  | { type: "response.reasoning_summary_part.added"; part: ResponsesStreamReasoningSummaryPart }
  | { type: "response.reasoning_summary_text.delta"; delta: string }
  | { type: "response.reasoning_summary_part.done" }
  | { type: "response.reasoning_text.delta"; delta: string }
  | { type: "response.content_part.added"; part: ResponsesStreamMessageContentPart }
  | { type: "response.output_text.delta"; delta: string }
  | { type: "response.refusal.delta"; delta: string }
  | { type: "response.function_call_arguments.delta"; delta: string }
  | { type: "response.function_call_arguments.done"; arguments: string }
  | { type: "response.output_item.done"; item: ResponsesStreamItem }
  | { type: "response.completed"; response: ResponsesCompletedResponse | undefined }
  | { type: "error"; code?: string | null; message?: string }
  | {
      type: "response.failed";
      response?: {
        error?: { code?: string; message?: string };
        incomplete_details?: { reason?: string };
      };
    };

// =============================================================================
// Message conversion
// =============================================================================

export function convertResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
): ResponsesInput {
  const messages: ResponsesInput = [];

  const normalizeIdPart = (part: string): string => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };

  const buildForeignResponsesItemId = (itemId: string): string => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };

  const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
    if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
    if (!id.includes("|")) return normalizeIdPart(id);
    const [callId, itemId] = id.split("|");
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
    // OpenAI Responses API requires item ids to start with "fc"
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };

  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    const role = model.reasoning ? "developer" : "system";
    messages.push({
      role,
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
        });
      } else {
        const content: ResponsesInputContent[] = msg.content.map((item): ResponsesInputContent => {
          if (item.type === "text") {
            return {
              type: "input_text",
              text: sanitizeSurrogates(item.text),
            };
          }
          return {
            type: "input_image",
            detail: "auto",
            image_url: `data:${item.mimeType};base64,${item.data}`,
          };
        });
        if (content.length === 0) continue;
        messages.push({
          role: "user",
          content,
        });
      }
    } else if (msg.role === "assistant") {
      const output: ResponsesInput = [];
      const assistantMsg = msg as AssistantMessage;
      // Different model id but same provider+api: OpenAI tracks which fc_xxx
      // ids were paired with rs_xxx reasoning items, so the id is omitted to
      // dodge that pairing validation.
      const isDifferentModel = isDifferentModelSameProvider(assistantMsg, model);

      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            // Replay the serialized reasoning item verbatim: encrypted
            // reasoning content only validates when it round-trips as-is.
            const reasoningItem = JSON.parse(block.thinkingSignature) as ResponsesReasoningItem;
            output.push(reasoningItem);
          }
        } else if (block.type === "text") {
          const textBlock = block as TextContent;
          const parsedSignature = parseTextSignature(textBlock.textSignature);
          // OpenAI requires id to be max 64 characters
          let msgId = parsedSignature?.id;
          if (!msgId) {
            msgId = `msg_${msgIndex}`;
          } else if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
            status: "completed",
            id: msgId,
            phase: parsedSignature?.phase,
          } satisfies ResponsesOutputMessageItem);
        } else if (block.type === "toolCall") {
          const toolCall = block as ToolCall;
          const [callId, itemIdRaw] = toolCall.id.split("|");
          let itemId: string | undefined = itemIdRaw;

          if (isDifferentModel && itemId?.startsWith("fc_")) {
            itemId = undefined;
          }

          output.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          });
        }
      }
      if (output.length === 0) continue;
      messages.push(...output);
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
      const hasText = textResult.length > 0;
      const [callId] = msg.toolCallId.split("|");

      let output: string | ResponsesInputContent[];
      if (hasImages && model.input.includes("image")) {
        const contentParts: ResponsesInputContent[] = [];

        if (hasText) {
          contentParts.push({
            type: "input_text",
            text: sanitizeSurrogates(textResult),
          });
        }

        for (const block of msg.content) {
          if (block.type === "image") {
            contentParts.push({
              type: "input_image",
              detail: "auto",
              image_url: `data:${block.mimeType};base64,${block.data}`,
            });
          }
        }

        output = contentParts;
      } else {
        output = sanitizeSurrogates(hasText ? textResult : hasImages ? "(see attached image)" : "");
      }

      messages.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }
    msgIndex++;
  }

  return messages;
}

function isDifferentModelSameProvider<TApi extends Api>(assistantMsg: AssistantMessage, model: Model<TApi>): boolean {
  return assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): ResponsesToolParam[] {
  const strict = options?.strict === undefined ? false : options.strict;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict,
  }));
}

// =============================================================================
// Stream processing
// =============================================================================

export async function processResponsesStream<TApi extends Api>(
  responsesStream: AsyncIterable<ResponsesStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
  options?: OpenAIResponsesStreamOptions,
): Promise<void> {
  let currentItem: ResponsesStreamItem | null = null;
  let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;

  for await (const event of responsesStream) {
    if (event.type === "response.created") {
      output.responseId = event.response.id;
    } else if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: {},
          partialJson: item.arguments || "",
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      }
    } else if (event.type === "response.reasoning_summary_part.added") {
      if (currentItem && currentItem.type === "reasoning") {
        currentItem.summary = currentItem.summary || [];
        currentItem.summary.push(event.part);
      }
    } else if (event.type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.reasoning_summary_part.done") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += "\n\n";
          lastPart.text += "\n\n";
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: "\n\n",
            partial: output,
          });
        }
      }
    } else if (event.type === "response.reasoning_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking += event.delta;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
        });
      }
    } else if (event.type === "response.content_part.added") {
      if (currentItem?.type === "message") {
        currentItem.content = currentItem.content || [];
        // Only output_text and refusal parts are tracked; reasoning_text
        // parts belong to reasoning items.
        if (event.part.type === "output_text" || event.part.type === "refusal") {
          currentItem.content.push(event.part);
        }
      }
    } else if (event.type === "response.output_text.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "output_text") {
          currentBlock.text += event.delta;
          lastPart.text = (lastPart.text ?? "") + event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "refusal") {
          currentBlock.text += event.delta;
          lastPart.refusal = (lastPart.refusal ?? "") + event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson += event.delta;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
        });
      }
    } else if (event.type === "response.function_call_arguments.done") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        const previousPartialJson = currentBlock.partialJson;
        currentBlock.partialJson = event.arguments;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);

        if (event.arguments.startsWith(previousPartialJson)) {
          const delta = event.arguments.slice(previousPartialJson.length);
          if (delta.length > 0) {
            stream.push({
              type: "toolcall_delta",
              contentIndex: blockIndex(),
              delta,
              partial: output,
            });
          }
        }
      }
    } else if (event.type === "response.output_item.done") {
      const item = event.item;

      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
        const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
        currentBlock.thinking = summaryText || contentText || currentBlock.thinking;
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = (item.content ?? [])
          .map((c) => (c.type === "output_text" ? c.text ?? "" : c.refusal ?? ""))
          .join("");
        currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const args =
          currentBlock?.type === "toolCall" && currentBlock.partialJson
            ? parseStreamingJson(currentBlock.partialJson)
            : parseStreamingJson(item.arguments || "{}");

        let toolCall: ToolCall;
        if (currentBlock?.type === "toolCall") {
          // Finalize in-place and strip the scratch buffer so replay only
          // carries parsed arguments.
          currentBlock.arguments = args;
          delete (currentBlock as { partialJson?: string }).partialJson;
          toolCall = currentBlock;
        } else {
          toolCall = {
            type: "toolCall",
            id: `${item.call_id}|${item.id}`,
            name: item.name,
            arguments: args,
          };
        }

        currentBlock = null;
        stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
      }
    } else if (event.type === "response.completed") {
      const response = event.response;
      if (response?.id) {
        output.responseId = response.id;
      }
      if (response?.usage) {
        const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          // OpenAI includes cached tokens in input_tokens; subtract to get
          // non-cached input.
          input: (response.usage.input_tokens || 0) - cachedTokens,
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: response.usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      applyUsageCost(model, output.usage);
      if (options?.applyServiceTierPricing) {
        const serviceTier = options.resolveServiceTier
          ? options.resolveServiceTier(response?.service_tier, options.serviceTier)
          : (response?.service_tier ?? options.serviceTier);
        options.applyServiceTierPricing(output.usage, serviceTier);
      }
      // Map status to stop reason
      output.stopReason = mapStopReason(response?.status);
      if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
      if (output.stopReason === "error" && response?.status) {
        output.stopReasonRaw = response.status;
      }
    } else if (event.type === "error") {
      throw new StreamFailureError(`Error Code ${event.code}: ${event.message}`, {
        kind: classifyStreamFailure(event.code ?? undefined),
        providerErrorType: event.code ?? undefined,
      });
    } else if (event.type === "response.failed") {
      const error = event.response?.error;
      const details = event.response?.incomplete_details;
      const providerErrorType = error?.code ?? details?.reason;
      const msg = error
        ? `${error.code || "unknown"}: ${error.message || "no message"}`
        : details?.reason
          ? `incomplete: ${details.reason}`
          : "Unknown error (no error details in response)";
      throw new StreamFailureError(msg, {
        kind: classifyStreamFailure(providerErrorType),
        providerErrorType,
      });
    }
  }
}

function mapStopReason(status: ResponsesStatus | undefined): StopReason {
  if (!status) return "stop";
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    // These two are wonky snapshots, not terminal states; treat as stop.
    case "in_progress":
    case "queued":
      return "stop";
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled stop reason: ${_exhaustive as string}`);
    }
  }
}
