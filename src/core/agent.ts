import type { ConversationReceipt } from "../receipts/types";
import { createLocalReceipt } from "../receipts/types";
import type { ToolRegistry } from "../tools/registry";
import type {
  ApprovalPolicy,
  CanonicalMessage,
  InferenceTransport,
  JsonValue,
  SessionManifest,
  ToolCall,
  ToolDefinition,
} from "./contracts";
import { sha256, stableStringify } from "./hash";
import { randomUuid } from "./id";
import type { DurableEvent, EventDraft } from "./journal";
import { EventJournal } from "./journal";
import { approvalProvenance } from "../approvals/modes";
import { boundInferenceHistoryImages, canonicalImageInputs } from "./multimodal";
import { canonicalContextSelection, injectContextSelection } from "./context-selection";

export type AgentSignal =
  | { type: "durable"; events: DurableEvent[] }
  | { type: "text-delta"; turnId: string; text: string }
  | { type: "status"; turnId: string; status: string };

export type RunTurnOptions = {
  sessionId: string;
  content: string;
  /** Inline, bounded images prepared with prepareCanonicalImageInputs(). */
  images?: CanonicalMessage["images"];
  transport: InferenceTransport;
  tools: ToolRegistry;
  journal: EventJournal;
  approvalPolicy: ApprovalPolicy;
  signal: AbortSignal;
  maxSteps?: number;
  onSignal?: (signal: AgentSignal) => void;
};

export type TurnResult = {
  turnId: string;
  content: string;
  receipt: ConversationReceipt;
  events: DurableEvent[];
};

const MAX_TOOL_CALLS_PER_STEP = 64;
const MAX_OPERATION_ID_CHARS = 512;
const UNSAFE_OPERATION_ID = /[\u0000-\u001F\u007F]/u;

export async function createSessionManifest(args: {
  systemPrompt: string;
  providerId: string;
  model: string;
  tools: ToolDefinition[];
  workspaceId: string;
  profile?: SessionManifest["profile"];
  securityPosture?: SessionManifest["securityPosture"];
  lineage?: SessionManifest["lineage"];
  capabilityTier?: SessionManifest["capabilityTier"];
  now?: string;
}): Promise<SessionManifest> {
  const tools = structuredClone(args.tools).sort((left, right) => left.name.localeCompare(right.name));
  return {
    protocolVersion: 1,
    systemPrompt: args.systemPrompt,
    systemPromptDigest: await sha256(args.systemPrompt),
    providerId: args.providerId,
    model: args.model,
    toolManifestDigest: await sha256(stableStringify(tools as unknown as JsonValue)),
    tools,
    workspaceId: args.workspaceId,
    capabilityTier: args.capabilityTier ?? "web-baseline",
    ...(args.securityPosture ? { securityPosture: args.securityPosture } : {}),
    ...(args.profile ? { profile: structuredClone(args.profile) } : {}),
    ...(args.lineage ? { lineage: structuredClone(args.lineage) } : {}),
    createdAt: args.now ?? new Date().toISOString(),
  };
}

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const maxSteps = options.maxSteps ?? 8;
  const session = await options.journal.getSession(options.sessionId, options.signal);
  if (!session) throw new Error(`Unknown session: ${options.sessionId}`);
  if (session.manifest.providerId !== options.transport.id) {
    throw new Error(
      `Session provider is pinned to ${session.manifest.providerId}; fork the session to use ${options.transport.id}.`,
    );
  }
  const currentToolDigest = await sha256(
    stableStringify(options.tools.definitions() as unknown as JsonValue),
  );
  if (currentToolDigest !== session.manifest.toolManifestDigest) {
    throw new Error("The tool manifest changed. Fork the session before using a different tool set.");
  }
  const reservedOperationIds = new Set(
    (await options.journal.readEvents(options.sessionId, 0, options.signal))
      .flatMap((event) => event.operationId ? [event.operationId] : []),
  );
  const images = canonicalImageInputs(options.images);
  if (!images) throw new TypeError("Turn images do not satisfy the canonical multimodal contract.");
  const contextSelection = options.content.trim()
    ? await options.tools.getContextRuntime()?.selectForTurn(options.content, options.signal)
    : undefined;

  const turnId = randomUuid();
  const emitted: DurableEvent[] = [];
  const append = async (drafts: EventDraft[]) => {
    const durable = await options.journal.append(options.sessionId, drafts, options.signal);
    emitted.push(...durable);
    options.onSignal?.({ type: "durable", events: durable });
    return durable;
  };

  await append([
    {
      type: "turn.requested",
      turnId,
      payload: {
        content: options.content,
        ...(images.length ? { images: images as unknown as JsonValue } : {}),
        ...(contextSelection ? { contextSelection: contextSelection as unknown as JsonValue } : {}),
      },
    },
  ]);

  try {
    for (let step = 0; step < maxSteps; step += 1) {
      throwIfAborted(options.signal);
      const history = await options.journal.readEvents(options.sessionId, 0, options.signal);
      const messages = materializeMessages(history);
      const requestId = randomUuid();
      if (reservedOperationIds.has(requestId)) throw new Error("Generated inference operation ID was already used.");
      reservedOperationIds.add(requestId);
      const idempotencyKey = `${options.sessionId}:${turnId}:${step}`;
      const requestDigest = await sha256(
        stableStringify({
          model: session.manifest.model,
          systemPromptDigest: session.manifest.systemPromptDigest,
          messages,
          tools: session.manifest.tools,
          idempotencyKey,
        } as unknown as JsonValue),
      );
      await append([
        {
          type: "inference.started",
          turnId,
          operationId: requestId,
          payload: {
            step,
            providerId: options.transport.id,
            model: session.manifest.model,
            posture: options.transport.posture,
            requestDigest,
            idempotencyKey,
          },
        },
      ]);
      options.onSignal?.({ type: "status", turnId, status: "thinking" });

      let content = "";
      const toolCalls: ToolCall[] = [];
      let completed: Extract<Awaited<ReturnType<typeof collectInference>>, { completed: true }> | undefined;
      const collected = await collectInference(
        options.transport,
        {
          requestId,
          sessionId: options.sessionId,
          turnId,
          model: session.manifest.model,
          systemPrompt: session.manifest.systemPrompt,
          messages,
          tools: session.manifest.tools,
          idempotencyKey,
        },
        options.signal,
        (text) => {
          content += text;
          options.onSignal?.({ type: "text-delta", turnId, text });
        },
        (toolCall) => toolCalls.push(toolCall),
        async (usage) => {
          await append([{ type: "inference.usage", turnId, operationId: requestId, payload: usage }]);
        },
        (phase) => {
          if (phase === "reasoning") {
            options.onSignal?.({ type: "status", turnId, status: "reasoning privately in enclave" });
          }
        },
      );
      if (collected.completed) completed = collected;
      if (!completed) throw new Error("Inference ended without a terminal completion event.");

      if (toolCalls.length) {
        reserveToolCallBatch(toolCalls, reservedOperationIds);
        const assistantMessage: CanonicalMessage = { role: "assistant", content, toolCalls };
        const drafts: EventDraft[] = [
          {
            type: "assistant.completed",
            turnId,
            operationId: requestId,
            payload: { message: assistantMessage as unknown as JsonValue, finishReason: "tool-calls" },
          },
          ...toolCalls.map(
            (call): EventDraft => ({
              type: "tool.requested",
              turnId,
              operationId: call.id,
              payload: { call: call as unknown as JsonValue },
            }),
          ),
        ];
        await append(drafts);

        for (const call of toolCalls) {
          throwIfAborted(options.signal);
          const context = { sessionId: options.sessionId, turnId, operationId: call.id, signal: options.signal };
          let decision: "allow" | "deny";
          try {
            decision = await options.tools.review(call.name, call.arguments, context, options.approvalPolicy);
          } catch (error) {
            await append([
              {
                type: "tool.failed",
                turnId,
                operationId: call.id,
                payload: { callId: call.id, name: call.name, content: errorMessage(error) },
              },
            ]);
            continue;
          }
          const provenance = approvalProvenance(options.approvalPolicy, context);
          if (decision === "deny") {
            await append([
              {
                type: "tool.denied",
                turnId,
                operationId: call.id,
                payload: { callId: call.id, name: call.name, content: `Permission denied for ${call.name}.`, approval: provenance ?? null },
              },
            ]);
            continue;
          }
          await append([
            {
              type: "tool.approved",
              turnId,
              operationId: call.id,
              payload: { callId: call.id, name: call.name, approval: provenance ?? null },
            },
          ]);
          options.onSignal?.({ type: "status", turnId, status: `running ${call.name}` });
          try {
            const execution = await options.tools.executeApproved(call.name, call.arguments, context);
            await append([
              {
                type: "tool.resulted",
                turnId,
                operationId: call.id,
                payload: {
                  callId: call.id,
                  name: call.name,
                  content: execution.content,
                  isError: execution.isError ?? false,
                  metadata: execution.metadata ?? null,
                },
              },
            ]);
          } catch (error) {
            await append([
              {
                type: "tool.failed",
                turnId,
                operationId: call.id,
                payload: { callId: call.id, name: call.name, content: errorMessage(error) },
              },
            ]);
          }
        }
        continue;
      }

      if (completed.finishReason === "tool-calls") {
        throw new Error("Provider ended for tool calls without producing a complete tool call.");
      }
      const responseDigest = await sha256(content);
      const receipt = completed.receipt
        ? finalizeProviderReceipt(completed.receipt, options.transport.id, requestDigest, responseDigest)
        : createLocalReceipt({
            sessionId: options.sessionId,
            turnId,
            provider: options.transport.id,
            model: session.manifest.model,
            requestDigest,
            responseDigest,
          });
      await append([
        {
          type: "assistant.completed",
          turnId,
          operationId: requestId,
          payload: {
            message: { role: "assistant", content } as unknown as JsonValue,
            finishReason: completed.finishReason,
            responseDigest,
            receipt: receipt as unknown as JsonValue,
          },
        },
        {
          type: "turn.completed",
          turnId,
          payload: { responseDigest, receiptId: receipt.receiptId },
        },
      ]);
      options.onSignal?.({ type: "status", turnId, status: "complete" });
      return { turnId, content, receipt, events: emitted };
    }

    throw new Error(`Agent exceeded the ${maxSteps}-step turn limit.`);
  } catch (error) {
    const cancelled = options.signal.aborted || isAbortError(error);
    await append([
      {
        type: cancelled ? "turn.cancelled" : "turn.failed",
        turnId,
        payload: { error: errorMessage(error) },
      },
    ]).catch(() => undefined);
    throw error;
  }
}

function reserveToolCallBatch(toolCalls: readonly ToolCall[], reserved: Set<string>): void {
  if (toolCalls.length > MAX_TOOL_CALLS_PER_STEP) {
    throw new Error(`Provider exceeded the ${MAX_TOOL_CALLS_PER_STEP}-tool-call step limit.`);
  }
  const batch = new Set<string>();
  for (const call of toolCalls) {
    if (
      typeof call.id !== "string" ||
      call.id.length === 0 ||
      call.id.length > MAX_OPERATION_ID_CHARS ||
      UNSAFE_OPERATION_ID.test(call.id)
    ) {
      throw new Error("Provider emitted an invalid tool-call operation ID.");
    }
    if (reserved.has(call.id) || batch.has(call.id)) {
      throw new Error("Provider emitted a duplicate or reused tool-call operation ID.");
    }
    batch.add(call.id);
  }
  for (const operationId of batch) reserved.add(operationId);
}

/**
 * Adds only the canonical client-owned transcript bindings to a provider
 * receipt. Provider ciphertext/evidence commitments and proof claims remain
 * unchanged; these local digests do not upgrade the receipt's proof level.
 */
function finalizeProviderReceipt(
  receipt: ConversationReceipt,
  providerId: string,
  requestDigest: string,
  responseDigest: string,
): ConversationReceipt {
  const finalized = structuredClone(receipt);
  removeUndefinedReceiptProperties(finalized);
  return {
    ...finalized,
    provider: providerId,
    bindings: {
      ...finalized.bindings,
      algorithm: "SHA-256",
      requestDigest,
      responseDigest,
    },
  };
}

function removeUndefinedReceiptProperties(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === undefined) throw new Error("Provider receipt arrays cannot contain undefined values.");
      removeUndefinedReceiptProperties(item);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      delete (value as Record<string, unknown>)[key];
    } else {
      removeUndefinedReceiptProperties(item);
    }
  }
}

async function collectInference(
  transport: InferenceTransport,
  request: Parameters<InferenceTransport["stream"]>[0],
  signal: AbortSignal,
  onText: (text: string) => void,
  onToolCall: (call: ToolCall) => void,
  onUsage: (usage: JsonValue) => Promise<void>,
  onProgress: (phase: "reasoning") => void,
): Promise<
  | { completed: false }
  | { completed: true; finishReason: "stop" | "tool-calls" | "length"; receipt?: ConversationReceipt }
> {
  let terminal:
    | { completed: true; finishReason: "stop" | "tool-calls" | "length"; receipt?: ConversationReceipt }
    | undefined;
  for await (const event of transport.stream(request, signal)) {
    throwIfAborted(signal);
    if (terminal) throw new Error("Provider emitted events after completion.");
    if (event.type === "text-delta") onText(event.text);
    if (event.type === "tool-call") onToolCall(event.call);
    if (event.type === "usage") await onUsage(event as unknown as JsonValue);
    if (event.type === "progress") onProgress(event.phase);
    if (event.type === "completed") {
      terminal = { completed: true, finishReason: event.finishReason, receipt: event.receipt };
    }
  }
  return terminal ?? { completed: false };
}

export function materializeMessages(events: DurableEvent[]): CanonicalMessage[] {
  // Failed and cancelled turns remain in the durable journal for audit and
  // recovery, but they are not provider conversation history. Omitting the
  // complete turn avoids replaying its user intent (or a partial tool phase)
  // as actionable context when a later turn begins.
  const nonActionableTurns = new Set(
    events
      .filter((event) =>
        (event.type === "turn.cancelled" || event.type === "turn.failed") &&
        typeof event.turnId === "string",
      )
      .map((event) => event.turnId as string),
  );
  const messages: CanonicalMessage[] = [];
  const latestRequest = [...events].reverse().find((event) =>
    event.type === "turn.requested" && event.turnId && !nonActionableTurns.has(event.turnId),
  );
  for (const event of events) {
    if (event.turnId && nonActionableTurns.has(event.turnId)) continue;
    const payload = record(event.payload);
    if (event.type === "turn.requested" && typeof payload?.content === "string") {
      const images = canonicalImageInputs(payload.images);
      const contextSelection = payload.contextSelection === undefined
        ? undefined
        : canonicalContextSelection(payload.contextSelection);
      if (images && (payload.contextSelection === undefined || contextSelection)) {
        messages.push({
          role: "user",
          content: event.eventId === latestRequest?.eventId
            ? injectContextSelection(payload.content, contextSelection)
            : payload.content,
          ...(images.length ? { images: [...images] } : {}),
        });
      }
    }
    if (event.type === "assistant.completed") {
      const message = record(payload?.message);
      if (message?.role === "assistant" && typeof message.content === "string") {
        const toolCalls = Array.isArray(message.toolCalls) ? (message.toolCalls as unknown as ToolCall[]) : undefined;
        messages.push({
          role: "assistant",
          content: message.content,
          ...(toolCalls?.length ? { toolCalls } : {}),
        });
      }
    }
    if (["tool.resulted", "tool.failed", "tool.denied"].includes(event.type)) {
      if (typeof payload?.callId === "string" && typeof payload.content === "string") {
        messages.push({ role: "tool", toolCallId: payload.callId, content: payload.content });
      }
    }
  }
  return boundInferenceHistoryImages(messages);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
