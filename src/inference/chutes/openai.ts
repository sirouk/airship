import type {
  CanonicalMessage,
  InferenceEvent,
  InferenceRequest,
  JsonValue,
  ToolCall,
  ToolDefinition,
} from "../../core/contracts";
import { ChutesTransportError } from "./errors";

type ToolAccumulator = {
  index: number;
  id: string;
  name: string;
  argumentsJson: string;
};

export type OpenAiStreamLimits = {
  maxToolCalls: number;
  maxToolArgumentsChars: number;
};

export class OpenAiStreamAssembler {
  private readonly tools = new Map<number, ToolAccumulator>();
  private finishReason?: "stop" | "tool-calls" | "length";
  private finalized = false;
  private sawPrivateReasoning = false;
  private reportedPrivateReasoning = false;
  private sawVisibleContent = false;

  constructor(private readonly limits: OpenAiStreamLimits) {}

  /** True only after an authenticated OpenAI choice supplied a terminal reason. */
  get hasFinishReason(): boolean {
    return this.finishReason !== undefined;
  }

  consume(data: string): InferenceEvent[] {
    if (this.finalized) {
      throw new ChutesTransportError("INVALID_RESPONSE", "Received model data after stream finalization.");
    }

    const parsed = parseJson(data, "OpenAI stream event");
    if (!isRecord(parsed)) {
      throw new ChutesTransportError("INVALID_RESPONSE", "OpenAI stream event must be a JSON object.");
    }

    const events: InferenceEvent[] = [];
    const usage = parsed.usage;
    if (isRecord(usage)) {
      const inputTokens = optionalTokenCount(usage.prompt_tokens);
      const outputTokens = optionalTokenCount(usage.completion_tokens);
      if (inputTokens !== undefined || outputTokens !== undefined) {
        events.push({ type: "usage", inputTokens, outputTokens });
      }
    }

    if (!Array.isArray(parsed.choices)) return events;
    for (const rawChoice of parsed.choices) {
      if (!isRecord(rawChoice)) continue;
      if (typeof rawChoice.index === "number" && rawChoice.index !== 0) continue;
      const delta = rawChoice.delta;
      if (isRecord(delta)) {
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          this.sawPrivateReasoning = true;
          if (!this.reportedPrivateReasoning) {
            this.reportedPrivateReasoning = true;
            events.push({ type: "progress", phase: "reasoning" });
          }
          // The phase signal says reasoning is happening; this carries what
          // the provider let the person see of it, for the reasoning record the transcript carries.
          events.push({ type: "reasoning-delta", text: delta.reasoning_content });
        }
        if (typeof delta.content === "string" && delta.content) {
          this.sawVisibleContent = true;
          events.push({ type: "text-delta", text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) this.consumeToolDeltas(delta.tool_calls);
      }
      this.consumeFinishReason(rawChoice.finish_reason);
    }
    return events;
  }

  finalize(): { toolCalls: ToolCall[]; finishReason: "stop" | "tool-calls" | "length" } {
    if (this.finalized) {
      throw new ChutesTransportError("INVALID_RESPONSE", "OpenAI stream was finalized more than once.");
    }
    this.finalized = true;

    const toolCalls = [...this.tools.values()]
      .sort((left, right) => left.index - right.index)
      .map((tool): ToolCall => {
        if (!tool.id || !tool.name) {
          throw new ChutesTransportError(
            "INVALID_TOOL_CALL",
            `OpenAI tool call at index ${tool.index} is missing its id or function name.`,
          );
        }
        const argumentsValue = parseJson(
          tool.argumentsJson || "{}",
          `tool call ${tool.id} arguments`,
          "INVALID_TOOL_CALL",
        );
        if (!isJsonValue(argumentsValue)) {
          throw new ChutesTransportError(
            "INVALID_TOOL_CALL",
            `OpenAI tool call ${tool.id} arguments are not a valid JSON value.`,
          );
        }
        return { id: tool.id, name: tool.name, arguments: argumentsValue };
      });

    if (this.sawPrivateReasoning && !this.sawVisibleContent && toolCalls.length === 0) {
      throw new ChutesTransportError(
        "INVALID_RESPONSE",
        "The model completed private reasoning without a user-visible response or tool call.",
      );
    }

    return {
      toolCalls,
      finishReason: this.finishReason ?? (toolCalls.length ? "tool-calls" : "stop"),
    };
  }

  private consumeToolDeltas(rawCalls: unknown[]) {
    for (const rawCall of rawCalls) {
      if (!isRecord(rawCall) || !Number.isSafeInteger(rawCall.index) || (rawCall.index as number) < 0) {
        throw new ChutesTransportError("INVALID_TOOL_CALL", "OpenAI tool-call delta has an invalid index.");
      }
      const index = rawCall.index as number;
      let tool = this.tools.get(index);
      if (!tool) {
        if (this.tools.size >= this.limits.maxToolCalls) {
          throw new ChutesTransportError(
            "INVALID_TOOL_CALL",
            `OpenAI stream exceeds the configured ${this.limits.maxToolCalls}-tool-call limit.`,
          );
        }
        tool = { index, id: "", name: "", argumentsJson: "" };
        this.tools.set(index, tool);
      }

      if (typeof rawCall.id === "string") tool.id += rawCall.id;
      if (rawCall.type !== undefined && rawCall.type !== "function") {
        throw new ChutesTransportError("INVALID_TOOL_CALL", "OpenAI returned a non-function tool call.");
      }
      const fn = rawCall.function;
      if (isRecord(fn)) {
        if (typeof fn.name === "string") tool.name += fn.name;
        if (typeof fn.arguments === "string") {
          tool.argumentsJson += fn.arguments;
          if (tool.argumentsJson.length > this.limits.maxToolArgumentsChars) {
            throw new ChutesTransportError(
              "INVALID_TOOL_CALL",
              `Tool call ${tool.id || index} exceeds the configured argument limit.`,
            );
          }
        }
      }
    }
  }

  private consumeFinishReason(value: unknown) {
    if (value === null || value === undefined) return;
    if (value === "stop") this.finishReason = "stop";
    else if (value === "tool_calls") this.finishReason = "tool-calls";
    else if (value === "length") this.finishReason = "length";
    else {
      throw new ChutesTransportError(
        "INVALID_RESPONSE",
        `Unsupported OpenAI finish reason: ${String(value).slice(0, 80)}`,
      );
    }
  }
}

export function buildOpenAiPayload(request: InferenceRequest) {
  const messages = [
    { role: "system", content: request.systemPrompt },
    ...request.messages.map(toOpenAiMessage),
  ];
  const tools = request.tools.map(toOpenAiTool);
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length
      ? {
          tools,
          tool_choice: "auto",
          parallel_tool_calls: true,
        }
      : {}),
  };
}

function toOpenAiMessage(message: CanonicalMessage): Record<string, unknown> {
  if (message.role === "tool") {
    if (!message.toolCallId) {
      throw new ChutesTransportError(
        "INVALID_RESPONSE",
        "Canonical tool messages must include toolCallId before inference.",
      );
    }
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  if (message.images?.length) {
    if (message.role !== "user") {
      throw new ChutesTransportError(
        "INVALID_RESPONSE",
        "Canonical image inputs are only valid on user messages.",
      );
    }
    return {
      role: "user",
      content: [
        { type: "text", text: message.content },
        ...message.images.map((image) => ({
          type: "image_url",
          image_url: { url: image.dataUrl },
        })),
      ],
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAiTool(tool: ToolDefinition) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function parseJson(
  value: string,
  label: string,
  code: "INVALID_RESPONSE" | "INVALID_TOOL_CALL" = "INVALID_RESPONSE",
): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ChutesTransportError(code, `${label} is not valid JSON.`, { cause: error });
  }
}

function optionalTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
