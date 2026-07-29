import type { InferenceTransport, JsonValue, ToolContext, ToolDefinition } from "../core/contracts";
import { stableStringify } from "../core/hash";
import { randomUuid } from "../core/id";
import { redactForDisplay } from "./broker";
import type { SafetyReviewResult } from "./modes";

const MAX_REVIEW_RESPONSE = 8_192;
const PRIVATE_PAYLOAD_KEY = /(?:content|body|payload|data|bytes|old[_-]?text|new[_-]?text|patch|message)/iu;
const REVIEW_SYSTEM_PROMPT = `You are a tool-action safety gate. Assess only the proposed action against the stated bounded browser environment. Return exactly one JSON object with keys "verdict" ("safe" or "unsafe") and "reason" (a short string). Never call tools, request more data, or wrap JSON in markdown. Mark unsafe when the action is destructive, exceeds the described intent, leaks data unexpectedly, or its bounded effect cannot be established.`;

export async function reviewToolActionWithModel(options: Readonly<{
  transport: InferenceTransport;
  model: string;
  tool: ToolDefinition;
  argumentsValue: JsonValue;
  context: ToolContext;
}>): Promise<SafetyReviewResult> {
  const requestId = `approval-review-${randomUuid()}`;
  const proposal = stableStringify({
    tool: {
      name: options.tool.name,
      description: options.tool.description,
      effect: options.tool.effect,
    },
    arguments: withholdPrivatePayloads(redactForDisplay(options.argumentsValue)),
    boundary: "Existing Airship browser tools only; no capability expansion is authorized.",
  });
  let text = "";
  let completed = false;
  // The review is a billed provider request like any other. Its usage was
  // dropped on the floor, which made the only inference a person cannot see in
  // the transcript also the only one whose cost was unrecordable.
  let usage: Readonly<{ inputTokens?: number; outputTokens?: number }> | undefined;
  for await (const event of options.transport.stream({
    requestId,
    sessionId: options.context.sessionId,
    turnId: `${options.context.turnId}:approval-review`,
    model: options.model,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    messages: [{ role: "user", content: proposal }],
    tools: [],
    idempotencyKey: requestId,
  }, options.context.signal)) {
    if (event.type === "tool-call") {
      return { verdict: "indeterminate", reason: "Safety reviewer attempted a recursive tool call.", requestId, model: options.model, ...usageOf(usage) };
    }
    if (event.type === "text-delta") {
      text += event.text;
      if (text.length > MAX_REVIEW_RESPONSE) {
        return { verdict: "indeterminate", reason: "Safety-review response exceeded its bound.", requestId, model: options.model, ...usageOf(usage) };
      }
    }
    if (event.type === "usage") usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
    if (event.type === "completed") completed = event.finishReason === "stop";
  }
  if (!completed) return { verdict: "indeterminate", reason: "Safety reviewer did not complete normally.", requestId, model: options.model, ...usageOf(usage) };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isVerdict(parsed)) throw new Error("invalid verdict schema");
    return { verdict: parsed.verdict, reason: parsed.reason.slice(0, 512), requestId, model: options.model, ...usageOf(usage) };
  } catch {
    return { verdict: "indeterminate", reason: "Safety reviewer returned malformed structured output.", requestId, model: options.model, ...usageOf(usage) };
  }
}

/** Token counts only when the transport reported them; never invented zeroes. */
function usageOf(usage: Readonly<{ inputTokens?: number; outputTokens?: number }> | undefined): Readonly<{ inputTokens?: number; outputTokens?: number }> {
  if (!usage) return {};
  return {
    ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
  };
}

/**
 * What the reviewer is not shown, and — just as deliberately — what it is.
 *
 * File-content-shaped fields are replaced by their shape, because a review does
 * not need the bytes of a document to judge whether writing it is in scope. The
 * action body is *not* withheld: a `script`, `command` or `url` is the thing
 * being adjudicated, so withholding it would leave the reviewer approving a
 * name. Exported so the boundary is pinned by a test rather than described by
 * user-facing copy that can drift away from it.
 */
export function withholdPrivatePayloads(value: JsonValue, key = ""): JsonValue {
  if (key && PRIVATE_PAYLOAD_KEY.test(key)) {
    if (typeof value === "string") return `[withheld string: ${value.length} characters]`;
    if (Array.isArray(value)) return `[withheld array: ${value.length} items]`;
    return "[withheld private payload]";
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => withholdPrivatePayloads(item));
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [childKey, child] of Object.entries(value)) result[childKey] = withholdPrivatePayloads(child, childKey);
  return result;
}

function isVerdict(value: unknown): value is { verdict: "safe" | "unsafe"; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && (record.verdict === "safe" || record.verdict === "unsafe")
    && typeof record.reason === "string"
    && record.reason.length > 0
    && record.reason.length <= 2_048;
}
