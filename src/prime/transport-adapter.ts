import type {
  CanonicalImageInput,
  CanonicalMessage,
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  JsonValue,
  SecurityPosture,
  ToolCall as CanonicalToolCall,
  ToolDefinition,
} from "../core/contracts";
import { usageCost } from "./ai/cost";
import { AssistantMessageEventStream } from "./ai/event-stream";
import type {
  Api,
  AssistantMessage,
  AssistantMessageDiagnostic,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Message,
  Model,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  Tool as PrimeTool,
  ToolCall as PrimeToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "./ai/types";

/**
 * Transport bridge between the two streaming vocabularies this repository now
 * speaks.
 *
 * `InferenceTransport` (src/core/contracts.ts) is airship's evidence-bearing
 * wire: five event kinds, whole tool calls, optional receipts, structural
 * failure naming. `StreamFunction` (src/prime/ai/types.ts) is the ported
 * prime-agent vocabulary: block-scoped deltas (text / thinking / tool calls),
 * usage with cost accounting, and terminal `done` / `error` frames carrying
 * the final AssistantMessage. This module maps both directions so either side
 * can serve the other without either vocabulary leaking across the seam.
 *
 * Layering: this file type-imports from `../core/contracts` only and must not
 * import from `src/inference` — the same rule `core/inference-retry.ts`
 * follows when it reads transport failures structurally instead of importing
 * the error classes that carry them. The receipt type is extracted from the
 * `completed` event for the same reason, so `src/receipts` stays a one-way
 * dependency of `src/core`.
 */

/** Non-retryable verdict code used when a failure declined to name itself.
 * Exported because the producer and the validator must agree on the string. */
export const UNNAMED_TRANSPORT_FAILURE_CODE = "unnamed-transport-error";

/** Receipt carried by a canonical `completed` event, extracted so this module
 * never imports the receipts module the core contracts already depend on. */
export type PrimeBridgeReceipt = NonNullable<Extract<InferenceEvent, { type: "completed" }>["receipt"]>;

/**
 * Structural twin of `ProviderTransportError` (src/inference/providers/
 * browser-cloud.ts). The retry layer in src/core reads failures by shape —
 * `error instanceof Error` plus a string `code`, optional integer `status`,
 * optional `Retry-After` string — and this module cannot import that class
 * without breaking the `src/prime` → `src/inference` layering. Anything this
 * adapter throws at the canonical boundary is thrown in this shape so
 * `withInferenceRetry` keeps working unchanged.
 */
export class PrimeBridgeTransportError extends Error {
  readonly retryAfter?: string;

  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    options: { cause?: unknown; retryAfter?: string } = {},
  ) {
    super(message, options);
    this.name = "PrimeBridgeTransportError";
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

export type PrimeModelStreamOptions = Readonly<{
  /**
   * Canonical request identity. The prime `Context` carries no session or
   * turn ids, so callers that need receipts bound to a real session must pin
   * them here (per call, `StreamOptions.sessionId` overrides `sessionId`).
   * Defaults exist only so the adapter is total: `turnId` falls back to the
   * per-call request id, which makes every stream its own degenerate turn.
   */
  sessionId?: string;
  turnId?: string;
  /**
   * Verbatim idempotency key for every request. Defaults to
   * `sessionId:turnId:requestId`, the same three-part shape
   * `core/agent.ts` pins (`sessionId:turnId:step`).
   */
  idempotencyKey?: string;
  /**
   * `ToolDefinition.effect` has no prime counterpart — prime tools describe
   * schemas, not privilege. The canonical field is inert on the wire (no
   * transport reads it; approval gating reads the registry's own
   * definitions), so the default names the honest middle: the tool may
   * change state. Callers that know better declare it per tool.
   */
  toolEffect?: (tool: PrimeTool) => ToolDefinition["effect"];
  /**
   * Out-channel for the one thing the prime message vocabulary cannot hold:
   * the receipt a canonical `completed` event may carry. `AssistantMessage`
   * has no receipt field by design, so the receipt travels beside the stream
   * instead of being smuggled into it.
   */
  onReceipt?: (receipt: PrimeBridgeReceipt) => void;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}>;

export type PrimeModelStreamFunction = StreamFunction<Api, StreamOptions> & {
  /**
   * Receipt from the most recently completed stream, or undefined when that
   * stream ended in error, was aborted, or its transport simply minted none.
   * Reset at the start of every call: a failed call must never surface the
   * receipt of an earlier, unrelated success.
   */
  getLastReceipt(): PrimeBridgeReceipt | undefined;
};

export type PrimeStreamTransportOptions = Readonly<{
  /**
   * Canonical requests name a model by string; prime stream functions want a
   * hydrated `Model`. Fields the canonical vocabulary cannot express (api,
   * provider, baseUrl, cost table) default to honest placeholders and may be
   * pinned here when the wrapped stream function actually needs them (a real
   * provider stream reads `baseUrl`).
   */
  model?: Readonly<Partial<Model<Api>>>;
  /** Clock injection for deterministic timestamps in rebuilt history. */
  now?: () => number;
}>;

const FINISH_REASON_TO_STOP_REASON: Readonly<
  Record<"stop" | "tool-calls" | "length", Extract<StopReason, "stop" | "toolUse" | "length">>
> = Object.freeze({
  stop: "stop",
  "tool-calls": "toolUse",
  length: "length",
} as const);

const STOP_REASON_TO_FINISH_REASON: Readonly<
  Record<"stop" | "toolUse" | "length", "stop" | "tool-calls" | "length">
> = Object.freeze({
  stop: "stop",
  toolUse: "tool-calls",
  length: "length",
} as const);

/**
 * Wrap an airship `InferenceTransport` as a prime `StreamFunction`.
 *
 * The returned function never throws — per the prime streaming contract every
 * failure is returned inside the stream as a terminal `error` event carrying
 * the final AssistantMessage with `stopReason` `"error"` or `"aborted"`.
 * Structural failure names (`code` / `status` / `retryAfter`) survive into
 * `AssistantMessage.diagnostics` and into the `errorMessage` text, so the
 * reverse bridge can fold them back into the shape `withInferenceRetry`
 * reads.
 */
export function createTransportForPrimeModel(
  model: Model<Api>,
  transport: InferenceTransport,
  options?: PrimeModelStreamOptions,
): PrimeModelStreamFunction {
  const now = options?.now ?? (() => Date.now());
  let lastReceipt: PrimeBridgeReceipt | undefined;

  const streamFn = ((boundModel: Model<Api>, context: Context, callOptions?: StreamOptions) => {
    // The closure model is authoritative: cost recomputation, api/provider
    // labeling, and the transport binding all belong to it. The model the
    // caller passes to a StreamFunction is contractually the same object.
    void boundModel;
    const out = new AssistantMessageEventStream();
    const signal = callOptions?.signal ?? new AbortController().signal;
    const requestId = randomUuid();
    const sessionId = callOptions?.sessionId ?? options?.sessionId ?? "prime";
    const turnId = options?.turnId ?? requestId;
    lastReceipt = undefined;
    const request: InferenceRequest = {
      requestId,
      sessionId,
      turnId,
      model: model.id,
      systemPrompt: context.systemPrompt ?? "",
      messages: context.messages.map(toCanonicalMessage),
      tools: (context.tools ?? []).map((tool) => toToolDefinition(tool, options?.toolEffect)),
      idempotencyKey: options?.idempotencyKey ?? `${sessionId}:${turnId}:${requestId}`,
    };
    void pumpTransportIntoPrimeStream(out, model, transport, request, signal, now, (receipt) => {
      lastReceipt = receipt;
      options?.onReceipt?.(receipt);
    });
    return out;
  }) as PrimeModelStreamFunction;

  streamFn.getLastReceipt = () => lastReceipt;
  return streamFn;
}

/** One open prime content block. Airship's vocabulary has no block
 * boundaries — a reasoning phase and its text are one flat sequence — so the
 * boundaries are derived: a block opens at its first event and closes when
 * the next event no longer belongs in it. The block holds its pushed content
 * entry so partial consumers see the same live-mutating object the prime
 * provider streams expose. */
type OpenBlock =
  | { kind: "text"; contentIndex: number; content: TextContent }
  | { kind: "thinking"; contentIndex: number; content: { type: "thinking"; thinking: string } };

async function pumpTransportIntoPrimeStream(
  out: AssistantMessageEventStream,
  model: Model<Api>,
  transport: InferenceTransport,
  request: InferenceRequest,
  signal: AbortSignal,
  now: () => number,
  receiveReceipt: (receipt: PrimeBridgeReceipt) => void,
): Promise<void> {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: now(),
  };
  let block: OpenBlock | undefined;
  let usageInput = 0;
  let usageOutput = 0;
  let completed: Extract<InferenceEvent, { type: "completed" }> | undefined;

  const closeBlock = () => {
    if (!block) return;
    if (block.kind === "text") {
      out.push({ type: "text_end", contentIndex: block.contentIndex, content: block.content.text, partial: output });
    } else {
      out.push({ type: "thinking_end", contentIndex: block.contentIndex, content: block.content.thinking, partial: output });
    }
    block = undefined;
  };

  try {
    out.push({ type: "start", partial: output });
    for await (const event of transport.stream(request, signal)) {
      if (event.type === "text-delta") {
        if (block?.kind !== "text") {
          closeBlock();
          const entry: TextContent = { type: "text", text: "" };
          output.content.push(entry);
          out.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
          block = { kind: "text", contentIndex: output.content.length - 1, content: entry };
        }
        block.content.text += event.text;
        out.push({ type: "text_delta", contentIndex: block.contentIndex, delta: event.text, partial: output });
      } else if (event.type === "progress") {
        /*
         * The canonical vocabulary marks a reasoning *phase* but carries no
         * reasoning text, so the honest prime counterpart is thinking block
         * boundaries with empty content — never a fabricated thinking_delta,
         * which would put words in the model's mouth.
         */
        if (event.phase === "reasoning" && block?.kind !== "thinking") {
          closeBlock();
          const entry = { type: "thinking" as const, thinking: "" };
          output.content.push(entry);
          out.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          block = { kind: "thinking", contentIndex: output.content.length - 1, content: entry };
        }
      } else if (event.type === "tool-call") {
        closeBlock();
        const toolCall: PrimeToolCall = {
          type: "toolCall",
          id: event.call.id,
          name: event.call.name,
          arguments: argumentsRecord(event.call.arguments),
        };
        output.content.push(toolCall);
        const contentIndex = output.content.length - 1;
        out.push({ type: "toolcall_start", contentIndex, partial: output });
        // The call arrived whole; the single delta is how the full argument
        // document surfaces to consumers that render arguments progressively.
        const argumentsJson = safeJson(event.call.arguments);
        if (argumentsJson !== undefined && argumentsJson !== "") {
          out.push({ type: "toolcall_delta", contentIndex, delta: argumentsJson, partial: output });
        }
        out.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
      } else if (event.type === "usage") {
        // Each usage event is a snapshot, not a delta: last value per field
        // wins. Cost is always recomputed client-side from the model table —
        // the canonical wire has no cost fields, and none are invented.
        if (event.inputTokens !== undefined) usageInput = event.inputTokens;
        if (event.outputTokens !== undefined) usageOutput = event.outputTokens;
        output.usage = usageFor(model, usageInput, usageOutput);
      } else if (event.type === "completed") {
        completed = event;
        break;
      }
    }
  } catch (error) {
    closeBlock();
    if (isAbortLike(error, signal)) {
      output.stopReason = "aborted";
      output.errorMessage = abortMessage(signal, error);
      out.push({ type: "error", reason: "aborted", error: output });
      return;
    }
    const failure = describeTransportFailure(error);
    output.stopReason = "error";
    output.errorMessage = failure.errorMessage;
    output.diagnostics = failure.diagnostics;
    out.push({ type: "error", reason: "error", error: output });
    return;
  }

  closeBlock();
  if (!completed) {
    // A transport that stops iterating without `completed` violated its own
    // contract; the failure is named with the retry vocabulary's own code
    // for a body that stopped arriving.
    const failure = describeTransportFailure(
      new PrimeBridgeTransportError("stream-truncated", "Inference stream ended without a terminal completed event."),
    );
    output.stopReason = "error";
    output.errorMessage = failure.errorMessage;
    output.diagnostics = failure.diagnostics;
    out.push({ type: "error", reason: "error", error: output });
    return;
  }

  const reason = FINISH_REASON_TO_STOP_REASON[completed.finishReason];
  output.stopReason = reason;
  if (completed.receipt) receiveReceipt(completed.receipt);
  out.push({ type: "done", reason, message: output });
}

/**
 * Wrap a prime `StreamFunction` as an airship `InferenceTransport`.
 *
 * The stream contract says a prime stream terminates with exactly one `done`
 * or `error`; this adapter enforces the canonical side of that guarantee —
 * exactly one terminal, nothing after it — and throws when the stream
 * violates it, because a canonical consumer (`collectInference`) treats a
 * missing `completed` as an incomplete answer, not as an error it can name.
 */
export function createInferenceTransportForPrimeStream(
  streamFn: StreamFunction,
  id: string,
  posture: SecurityPosture,
  options?: PrimeStreamTransportOptions,
): InferenceTransport {
  const now = options?.now ?? (() => Date.now());
  return {
    id,
    posture,
    stream(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent> {
      return iteratePrimeStreamAsInference(streamFn, request, signal, options?.model, now);
    },
  };
}

async function* iteratePrimeStreamAsInference(
  streamFn: StreamFunction,
  request: InferenceRequest,
  signal: AbortSignal,
  modelTemplate: Readonly<Partial<Model<Api>>> | undefined,
  now: () => number,
): AsyncGenerator<InferenceEvent> {
  throwIfAborted(signal);
  const model = bridgeModel(request, modelTemplate);
  const context = bridgeContext(request, model, now);

  let events: AsyncIterable<AssistantMessageEvent>;
  try {
    events = streamFn(model, context, { signal });
  } catch (error) {
    // A synchronous throw already violates the prime contract ("a
    // StreamFunction must never throw"), but the failure still has to leave
    // this boundary in the shape the retry layer reads.
    throw foldThrownError(error, signal);
  }

  let terminal = false;
  try {
    for await (const event of events) {
      throwIfAborted(signal);
      if (terminal) break;
      if (event.type === "text_delta") {
        yield { type: "text-delta", text: event.delta };
      } else if (event.type === "thinking_start") {
        // Real reasoning happened; its *content* has no canonical home, so
        // only the phase marker crosses. thinking_delta text never does.
        yield { type: "progress", phase: "reasoning" };
      } else if (event.type === "toolcall_end") {
        // Canonical tool calls are whole-proposition events: the deltas are
        // assembled by the producing stream, and this boundary is where the
        // assembled call becomes one atomic record.
        yield {
          type: "tool-call",
          call: {
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments as JsonValue,
          },
        };
      } else if (event.type === "done") {
        terminal = true;
        const usage = event.message.usage;
        // Usage crosses only when the provider actually reported tokens; a
        // zeroed usage block is the absence of a report, not a report of
        // zero.
        if (usage.input > 0 || usage.output > 0) {
          yield { type: "usage", inputTokens: usage.input, outputTokens: usage.output };
        }
        yield { type: "completed", finishReason: STOP_REASON_TO_FINISH_REASON[event.reason] };
      } else if (event.type === "error") {
        terminal = true;
        throw foldPrimeErrorEvent(event.reason, event.error, signal);
      }
      // start, text_start/text_end, thinking_delta/thinking_end,
      // toolcall_start/toolcall_delta have no canonical counterpart; block
      // boundaries are implied by event order on the canonical side.
    }
  } catch (error) {
    if (error instanceof PrimeBridgeTransportError) throw error;
    throw foldThrownError(error, signal);
  }

  if (!terminal) {
    throw new PrimeBridgeTransportError(
      "stream-truncated",
      "Prime stream ended without a terminal done or error event.",
    );
  }
}

/**
 * Shared error folding for both directions: read the structural failure name
 * the way `core/inference-retry.ts` does (`code` on the error or on a
 * `diagnostic` sub-record, integer `status`, string `retryAfter`) and render
 * it as prime diagnostics. A failure that declined to name itself is named
 * here as exactly that — it remains non-retryable, which is the right
 * default for an error nobody classified.
 */
export function primeDiagnosticsFromError(error: unknown): AssistantMessageDiagnostic[] {
  return describeTransportFailure(error).diagnostics;
}

type DescribedFailure = Readonly<{
  errorMessage: string;
  diagnostics: AssistantMessageDiagnostic[];
}>;

function describeTransportFailure(error: unknown): DescribedFailure {
  const message = error instanceof Error ? error.message : String(error);
  const named = structuralFailureName(error);
  if (!named) {
    return Object.freeze({
      errorMessage: `${message} [code=${UNNAMED_TRANSPORT_FAILURE_CODE}]`,
      diagnostics: [{ code: UNNAMED_TRANSPORT_FAILURE_CODE, message }],
    });
  }
  const parts = [`code=${named.code}`];
  if (named.status !== undefined) parts.push(`status=${named.status}`);
  if (named.retryAfter !== undefined) parts.push(`retryAfter=${named.retryAfter}`);
  const detailParts: string[] = [];
  if (named.status !== undefined) detailParts.push(`status=${named.status}`);
  if (named.retryAfter !== undefined) detailParts.push(`retryAfter=${named.retryAfter}`);
  return Object.freeze({
    errorMessage: `${message} [${parts.join(" ")}]`,
    diagnostics: [
      {
        code: named.code,
        message,
        ...(detailParts.length > 0 ? { detail: detailParts.join("; ") } : {}),
      },
    ],
  });
}

/**
 * Structural read mirroring `namedTransportFailure` in core/inference-retry.
 * The duplication is deliberate: importing that module would give a
 * presentation-layer port a runtime dependency on the core that the core
 * itself refuses to have on the transports.
 */
function structuralFailureName(
  error: unknown,
): Readonly<{ code: string; status?: number; retryAfter?: string }> | undefined {
  if (!(error instanceof Error)) return undefined;
  const carrier = error as unknown as Record<string, unknown>;
  const named = typeof carrier.code === "string" ? carrier : isRecord(carrier.diagnostic) ? carrier.diagnostic : undefined;
  const code = named?.code;
  if (typeof code !== "string") return undefined;
  const status = named?.status;
  const retryAfter = carrier.retryAfter;
  return Object.freeze({
    code,
    ...(typeof status === "number" && Number.isInteger(status) ? { status } : {}),
    ...(typeof retryAfter === "string" ? { retryAfter } : {}),
  });
}

function foldPrimeErrorEvent(
  reason: "aborted" | "error",
  message: AssistantMessage,
  signal: AbortSignal,
): Error {
  const text = message.errorMessage?.trim()
    ? message.errorMessage
    : "The prime stream ended in an error without a message.";
  if (reason === "aborted") {
    // The caller's own abort is the caller's verdict, not the provider's —
    // the retry layer must see the signal's reason, not a wrapped rename.
    if (signal.aborted) return asError(signal.reason) ?? new DOMException("Aborted", "AbortError");
    return new PrimeBridgeTransportError("cancelled", text);
  }
  // A status is structural on the canonical side but prime diagnostics
  // carry it only as text; the honest recovery is to read it back from
  // the message — which (by construction of the forward bridge) preserves
  // it — and never to guess one.
  const httpMatch = /HTTP\s+(\d{3})/iu.exec(text);
  const status = httpMatch?.[1] === undefined ? undefined : Number(httpMatch[1]);
  const diagnostic = message.diagnostics?.[0];
  if (diagnostic) {
    return new PrimeBridgeTransportError(diagnostic.code, text, status);
  }
  if (status !== undefined) {
    return new PrimeBridgeTransportError("http", text, status);
  }
  return new PrimeBridgeTransportError("stream-interrupted", text);
}

function foldThrownError(error: unknown, signal: AbortSignal): Error {
  throwIfAborted(signal);
  if (error instanceof PrimeBridgeTransportError) return error;
  // A failure that already named itself structurally passes through
  // untouched: the retry layer reads the name off the original error.
  if (structuralFailureName(error)) return error as Error;
  return new PrimeBridgeTransportError(
    "stream-interrupted",
    error instanceof Error ? error.message : String(error),
    undefined,
    { cause: error },
  );
}

function isAbortLike(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function abortMessage(signal: AbortSignal, error: unknown): string {
  // Port invariant: aborts are values. When the caller attached a reason,
  // its message is the honest one; otherwise the prime providers' own
  // terminal string is reproduced verbatim.
  if (signal.reason instanceof Error) return signal.reason.message;
  if (error instanceof Error && error.name !== "AbortError") return error.message;
  return "Request was aborted";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw (signal.reason ?? new DOMException("Aborted", "AbortError"));
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

function bridgeModel(
  request: InferenceRequest,
  template: Readonly<Partial<Model<Api>>> | undefined,
): Model<Api> {
  return {
    id: request.model,
    name: request.model,
    api: "unknown",
    provider: "unknown",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    ...template,
  };
}

function bridgeContext(request: InferenceRequest, model: Model<Api>, now: () => number): Context {
  return {
    systemPrompt: request.systemPrompt,
    messages: toPrimeMessages(request.messages, model, now),
    ...(request.tools.length > 0 ? { tools: request.tools.map(toPrimeTool) } : {}),
  };
}

function toPrimeMessages(messages: readonly CanonicalMessage[], model: Model<Api>, now: () => number): Message[] {
  // Canonical tool messages carry no tool name; the name is recovered from
  // the assistant call it answers (every provider's own pairing), and only
  // an orphan falls back to the honest placeholder.
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
  }
  return messages.map((message) => {
    if (message.role === "user") return canonicalUserToPrime(message, now);
    if (message.role === "assistant") return canonicalAssistantToPrime(message, model, now);
    return canonicalToolToPrime(message, toolNames, now);
  });
}

function canonicalUserToPrime(message: CanonicalMessage, now: () => number): UserMessage {
  const images = (message.images ?? []).map(toPrimeImage);
  const content: string | (TextContent | ImageContent)[] = images.length
    ? [...(message.content ? [{ type: "text", text: message.content } satisfies TextContent] : []), ...images]
    : message.content;
  return { role: "user", content, timestamp: now() };
}

function canonicalAssistantToPrime(message: CanonicalMessage, model: Model<Api>, now: () => number): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.toolCalls ?? []) {
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: argumentsRecord(call.arguments) });
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    // Historical usage is unrecoverable from the canonical transcript and
    // is honestly zero rather than estimated.
    usage: zeroUsage(),
    stopReason: message.toolCalls?.length ? "toolUse" : "stop",
    timestamp: now(),
  };
}

function canonicalToolToPrime(
  message: CanonicalMessage,
  toolNames: ReadonlyMap<string, string>,
  now: () => number,
): ToolResultMessage {
  const content: (TextContent | ImageContent)[] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const image of message.images ?? []) content.push(toPrimeImage(image));
  const callId = message.toolCallId ?? "";
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: toolNames.get(callId) ?? "unknown",
    content,
    // The canonical vocabulary has no error flag, so nothing here is known
    // to be an error — `false` names that absence, not a verdict of success.
    isError: false,
    timestamp: now(),
  };
}

function toPrimeImage(image: CanonicalImageInput): ImageContent {
  // The canonical contract guarantees inline data URLs; the byte after the
  // first comma is the payload either way, so an unprefixed string degrades
  // to itself rather than to a guess.
  const comma = image.dataUrl.indexOf(",");
  return {
    type: "image",
    data: comma >= 0 ? image.dataUrl.slice(comma + 1) : image.dataUrl,
    mimeType: image.mediaType,
  };
}

function toPrimeTool(definition: ToolDefinition): PrimeTool {
  return {
    name: definition.name,
    description: definition.description,
    // `JsonValue` is wider than a schema object; a scalar or array schema
    // was never a valid tool schema, so it degrades to the empty object
    // schema instead of being forwarded as a lie.
    parameters: isRecord(definition.inputSchema) ? definition.inputSchema : {},
    // `effect` is an airship approval concern and has no prime counterpart.
  };
}

function toCanonicalMessage(message: Message): CanonicalMessage {
  if (message.role === "user") return primeUserToCanonical(message);
  if (message.role === "assistant") return primeAssistantToCanonical(message);
  return primeToolResultToCanonical(message);
}

function primeUserToCanonical(message: UserMessage): CanonicalMessage {
  if (typeof message.content === "string") return { role: "user", content: message.content };
  let text = "";
  const images: CanonicalImageInput[] = [];
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
    if (block.type === "image") images.push(toCanonicalImage(block, images.length));
  }
  return { role: "user", content: text, ...(images.length > 0 ? { images } : {}) };
}

function primeAssistantToCanonical(message: AssistantMessage): CanonicalMessage {
  let text = "";
  const toolCalls: CanonicalToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
    if (block.type === "toolCall") {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments as JsonValue });
    }
    // ThinkingContent has no canonical home — airship's own transcript
    // carries no reasoning either — so it drops here exactly the way it
    // drops in materializeMessages.
  }
  return { role: "assistant", content: text, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
}

function primeToolResultToCanonical(message: ToolResultMessage): CanonicalMessage {
  let text = "";
  const images: CanonicalImageInput[] = [];
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
    if (block.type === "image") images.push(toCanonicalImage(block, images.length));
  }
  return {
    role: "tool",
    toolCallId: message.toolCallId,
    content: text,
    ...(images.length > 0 ? { images } : {}),
  };
}

function toCanonicalImage(image: ImageContent, index: number): CanonicalImageInput {
  return {
    type: "image",
    name: `image-${index + 1}`,
    mediaType: image.mimeType,
    dataUrl: `data:${image.mimeType};base64,${image.data}`,
    sizeBytes: base64DecodedBytes(image.data),
  };
}

function toToolDefinition(
  tool: PrimeTool,
  toolEffect: ((tool: PrimeTool) => ToolDefinition["effect"]) | undefined,
): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: isRecord(tool.parameters) ? (tool.parameters as JsonValue) : {},
    effect: toolEffect?.(tool) ?? "write",
  };
}

function argumentsRecord(value: JsonValue): Record<string, unknown> {
  // Prime types tool arguments as a record; the canonical type is the wider
  // JsonValue. Non-record arguments only occur for a provider that already
  // broke the object convention, and fabricating a wrapper key for them
  // would be invented data — an empty record names their absence instead.
  return isRecord(value) ? { ...value } : {};
}

function base64DecodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function zeroUsage(): Usage {
  // Kept local rather than imported from ./ai/stream: that module pulls the
  // provider registry into any chunk that touches it, and this adapter is
  // on the path of bundles that must stay cold.
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function usageFor(model: Model<Api>, input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: usageCost(model, { input, output, cacheRead: 0, cacheWrite: 0 }),
  };
}

function safeJson(value: JsonValue): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    // JSON.stringify on a JsonValue cannot throw; the guard exists so a
    // producer violating the type degrades to no delta rather than to a
    // thrown adapter.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 4122 UUIDv4 from Web Crypto, mirroring core/id's fallback for
 * non-secure contexts that omit randomUUID but expose getRandomValues. */
function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
