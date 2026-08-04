import type { ConversationReceipt } from "../receipts/types";
import { createLocalReceipt, finalizeProviderReceipt } from "../receipts/types";
import type { ToolRegistry } from "../tools/registry";
import type {
  ApprovalPolicy,
  CanonicalMessage,
  InferenceTransport,
  JsonValue,
  SessionManifest,
  ToolCall,
} from "./contracts";
import { sha256, stableStringify } from "./hash";
import { randomUuid } from "./id";
import type { DurableEvent, EventDraft } from "./journal";
import { EventJournal } from "./journal";
import { approvalProvenance } from "../approvals/modes";
import { boundInferenceHistoryImages, canonicalImageInputs } from "./multimodal";
import {
  canonicalContextSelection,
  canonicalTurnContextQuery,
  contextSelectionScopeMatches,
  injectContextSelection,
  verifyContextSelection,
  verifyContextSelectionQuery,
  type CanonicalContextSelection,
} from "./context-selection";
import {
  canonicalLiveEnvironmentSnapshot,
  injectLiveEnvironment,
  liveEnvironmentScopeMatches,
  sealLiveEnvironmentSnapshot,
  verifyLiveEnvironmentSnapshot,
  type LiveEnvironmentSnapshot,
} from "./live-environment";
import {
  FORK_CONTEXT_EVENT_TYPE,
  canonicalForkContextSeed,
  forkContextSeedMatchesScope,
  verifyForkContextSeed,
  type ForkContextScope,
} from "./fork-context";
import {
  calibrateBytesPerToken,
  contextCompressionOptionsFromPolicy,
  createInferenceTransportContextSummarizer,
  estimateInferenceTokens,
  materializeContextSummary,
  planContextCompression,
  resolveContextCompressionOptions,
  type ContextCompressionOptions,
} from "./context-compressor";

export { createSessionManifest } from "./session-manifest";

export type AgentSignal =
  | { type: "durable"; events: DurableEvent[] }
  | { type: "text-delta"; turnId: string; text: string }
  | { type: "tool-output"; turnId: string; operationId: string; stream: "stdout" | "stderr" | "combined"; text: string }
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
  /**
   * Deprecated assertion for direct callers. Automatic compression is driven
   * only by the immutable session contextPolicy; a supplied value must match it.
   */
  contextCompression?: ContextCompressionOptions;
  onSignal?: (signal: AgentSignal) => void;
};

export type TurnResult = {
  turnId: string;
  content: string;
  receipt: ConversationReceipt;
  events: DurableEvent[];
};

const MAX_TOOL_CALLS_PER_STEP = 64;
/**
 * Tokens held back from the in-loop tool budget so a step that fills the window
 * still leaves room for the assistant reply that has to read the results.
 */
const RESERVED_RESPONSE_TOKENS = 1_024;
/**
 * A turn whose opening request already exceeds the pinned window is not refused
 * on a bytes-per-token estimate — providers still accept many such turns. It is
 * granted this much room above where it opened so its tool results are truncated
 * with a marker rather than blanked to nothing and then failed one step later.
 * Bounded per turn, not per step: every step measures against the same ceiling,
 * so the whole loop can add at most this allowance minus the response reserve.
 */
const OVER_WINDOW_LOOP_ALLOWANCE_TOKENS = RESERVED_RESPONSE_TOKENS * 2;
/** Matches the compressor's fallback basis when no provider usage exists yet. */
const DEFAULT_BYTES_PER_TOKEN = 3.6;
const MAX_OPERATION_ID_CHARS = 512;
const MAX_ASSISTANT_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_INFERENCE_EVENTS_PER_STEP = 100_000;
const UNSAFE_OPERATION_ID = /[\u0000-\u001F\u007F]/u;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const maxSteps = options.maxSteps ?? 8;
  const session = await options.journal.getSession(options.sessionId, options.signal);
  if (!session) throw new Error(`Unknown session: ${options.sessionId}`);
  assertSupportedTurnManifest(session.manifest);
  if (session.manifest.protocolVersion === 1) {
    throw new Error("Protocol-v1 sessions are replay-only; fork the session before starting a new turn.");
  }
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
  const existingEvents = await options.journal.readEvents(options.sessionId, 0, options.signal);
  const unfinishedTurn = findUnfinishedProviderTurn(existingEvents);
  if (unfinishedTurn) {
    throw new Error(`Turn ${unfinishedTurn} has no durable terminal event; recover or fork the session before continuing.`);
  }
  assertContextHistoryCompatible(existingEvents, session.manifest);
  const verifiedForkContextDigest = await assertForkContextHistoryCompatible(existingEvents, {
    sessionId: session.id,
    lineage: session.manifest.lineage,
  });
  const reservedOperationIds = new Set(
    existingEvents.flatMap((event) => event.operationId ? [event.operationId] : []),
  );
  const images = canonicalImageInputs(options.images);
  if (!images) throw new TypeError("Turn images do not satisfy the canonical multimodal contract.");

  const liveEnvironment = await prepareLiveEnvironment({
    sessionId: options.sessionId,
    manifest: session.manifest,
    tools: options.tools,
    transportPosture: options.transport.posture,
    signal: options.signal,
  });

  const turnId = randomUuid();
  const emitted: DurableEvent[] = [];
  let terminalCommitted = false;
  const append = async (drafts: EventDraft[], useTurnSignal = true) => {
    const durable = await options.journal.append(
      options.sessionId,
      drafts,
      useTurnSignal ? options.signal : undefined,
    );
    emitted.push(...durable);
    if (durable.some((event) => isTerminalTurnEvent(event.type))) terminalCommitted = true;
    notifySignal(options.onSignal, { type: "durable", events: durable });
    return durable;
  };
  const reconcileTerminal = async (): Promise<boolean> => {
    const persisted = await options.journal.readEvents(options.sessionId, 0);
    const terminals = persisted.filter((event) =>
      event.turnId === turnId && isTerminalTurnEvent(event.type)
    );
    if (terminals.length > 1) {
      throw new Error(`Turn ${turnId} has multiple durable terminal events.`);
    }
    const terminal = terminals[0];
    if (!terminal) return false;
    terminalCommitted = true;
    if (!emitted.some((event) => event.eventId === terminal.eventId)) {
      emitted.push(terminal);
      notifySignal(options.onSignal, { type: "durable", events: [terminal] });
    }
    return true;
  };

  await append([
    {
      type: "turn.requested",
      turnId,
      payload: {
        content: options.content,
        ...(images.length ? { images: images as unknown as JsonValue } : {}),
        ...(liveEnvironment ? { liveEnvironment: liveEnvironment as unknown as JsonValue } : {}),
      },
    },
  ]);

  try {
    const contextSelection = await prepareTurnContext({
      content: options.content,
      sessionId: options.sessionId,
      manifest: session.manifest,
      tools: options.tools,
      signal: options.signal,
    });
    if (contextSelection) {
      await append([{
        type: "turn.context.selected",
        turnId,
        payload: { contextSelection: contextSelection as unknown as JsonValue },
      }]);
    }

    // A context window is immutable session semantics, never inferred from a
    // model name or re-read from a mutable catalog during an old-session replay.
    const pinnedContextCompression = session.manifest.contextPolicy
      ? contextCompressionOptionsFromPolicy(session.manifest.contextPolicy)
      : undefined;
    if (options.contextCompression) {
      const asserted = resolveContextCompressionOptions(options.contextCompression);
      if (!pinnedContextCompression || !sameContextCompressionOptions(asserted, pinnedContextCompression)) {
        throw new Error("Context compression options must exactly match the policy pinned in the session manifest.");
      }
    }
    // Ground truth for this session's tokenizer is already in the journal as
    // provider-reported prompt_tokens; the 3.6 bytes/token guess is only used
    // until the first usage event exists.
    const bytesPerToken = pinnedContextCompression
      ? calibrateBytesPerToken(existingEvents, {
        systemPrompt: session.manifest.systemPrompt,
        tools: session.manifest.tools,
        materialize: (events) => materializeMessages([...events], {
          allowEmbeddedContext: session.manifest.turnContext === undefined,
          allowSelectedContext: session.manifest.turnContext !== "disabled",
          forkContextScope: { sessionId: session.id, lineage: session.manifest.lineage },
          verifiedForkContextDigest,
        }),
      })
      : undefined;
    const contextSummary = pinnedContextCompression
      ? await planContextCompression({
        events: existingEvents,
        messages: materializeMessages(existingEvents, {
          injectLatestContext: false,
          allowEmbeddedContext: session.manifest.turnContext === undefined,
          allowSelectedContext: session.manifest.turnContext !== "disabled",
          forkContextScope: { sessionId: session.id, lineage: session.manifest.lineage },
          verifiedForkContextDigest,
        }),
        ...(bytesPerToken !== undefined ? { bytesPerToken } : {}),
        projectedUserContent: injectContextSelection(
          injectLiveEnvironment(options.content, liveEnvironment),
          contextSelection,
        ),
        systemPrompt: session.manifest.systemPrompt,
        tools: session.manifest.tools,
        options: pinnedContextCompression,
        ...(session.manifest.contextPolicy!.compression.summarizer.mode === "inference-transport" ? {
          summarizer: createInferenceTransportContextSummarizer({
            transport: options.transport,
            model: session.manifest.model,
            sessionId: session.id,
          }),
          summarizerFailure: session.manifest.contextPolicy!.compression.summarizer.onFailure === "extractive-fallback"
            ? "extractive-fallback" as const
            : "throw" as const,
        } : {}),
        signal: options.signal,
      })
      : undefined;
    if (contextSummary) {
      await append([{
        type: "context.summary.updated",
        turnId,
        payload: contextSummary as unknown as JsonValue,
      }]);
    }

    let turnBaselineTokens: number | undefined;
    for (let step = 0; step < maxSteps; step += 1) {
      throwIfAborted(options.signal);
      const history = await options.journal.readEvents(options.sessionId, 0, options.signal);
      const messages = materializeMessages(history, {
        allowEmbeddedContext: session.manifest.turnContext === undefined,
        allowSelectedContext: session.manifest.turnContext !== "disabled",
        forkContextScope: { sessionId: session.id, lineage: session.manifest.lineage },
        verifiedForkContextDigest,
      });
      // Compression only runs at turn boundaries, so a long tool loop can grow
      // the request past the window the boundary check just cleared.
      const projectedTokens = pinnedContextCompression
        ? estimateInferenceTokens({
          systemPrompt: session.manifest.systemPrompt,
          messages,
          tools: session.manifest.tools,
          ...(bytesPerToken !== undefined ? { bytesPerToken } : {}),
        })
        : undefined;
      if (step === 0) turnBaselineTokens = projectedTokens;
      // One ceiling drives both the refusal and the tool-output budget. Two
      // different ceilings is how a turn ends up handed zero bytes for its tool
      // results and then failed for spending them: the estimate is distrusted
      // enough not to refuse the turn at step 0, so it must also be distrusted
      // when deciding how much of the step's tool output to keep.
      const ceilingTokens = pinnedContextCompression && turnBaselineTokens !== undefined
        ? Math.max(
          pinnedContextCompression.contextWindowTokens,
          turnBaselineTokens > pinnedContextCompression.contextWindowTokens
            ? turnBaselineTokens + OVER_WINDOW_LOOP_ALLOWANCE_TOKENS
            : 0,
        )
        : undefined;
      if (
        pinnedContextCompression && projectedTokens !== undefined &&
        ceilingTokens !== undefined && projectedTokens > ceilingTokens
      ) {
        throw new Error(
          `This turn's accumulated tool output no longer fits the session's pinned ${pinnedContextCompression.contextWindowTokens}-token context window (projected ${projectedTokens} tokens). History is intact in the journal; start a new turn so compression can run at the boundary.`,
        );
      }
      // Bytes this step may still add before the next request would overflow.
      // Spending exactly this much keeps the next request inside the ceiling, so a
      // verbose tool costs its own tail instead of the user's whole turn.
      let remainingToolOutputBytes = ceilingTokens !== undefined && projectedTokens !== undefined
        ? Math.max(0, Math.floor(
          (ceilingTokens - RESERVED_RESPONSE_TOKENS - projectedTokens) *
          (bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN),
        ))
        : undefined;
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
      notifySignal(options.onSignal, { type: "status", turnId, status: "thinking" });

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
          notifySignal(options.onSignal, { type: "text-delta", turnId, text });
        },
        (toolCall) => toolCalls.push(toolCall),
        async (usage) => {
          await append([{ type: "inference.usage", turnId, operationId: requestId, payload: usage }]);
        },
        (phase) => {
          if (phase === "reasoning") {
            notifySignal(options.onSignal, { type: "status", turnId, status: "reasoning" });
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
          const context = {
            sessionId: options.sessionId,
            turnId,
            operationId: call.id,
            signal: options.signal,
            capabilityTier: session.manifest.capabilityTier,
            onOutput(chunk: Readonly<{ stream: "stdout" | "stderr" | "combined"; text: string }>) {
              notifySignal(options.onSignal, { type: "tool-output", turnId, operationId: call.id, ...chunk });
            },
          };
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
          notifySignal(options.onSignal, { type: "status", turnId, status: `running ${call.name}` });
          try {
            const execution = await options.tools.executeApproved(call.name, call.arguments, context);
            // A single verbose result must not cost the user the whole turn. What
            // is stored is exactly what the model will read, and the marker plus
            // metadata state that the tail was dropped.
            const bounded = boundToolResultContent(execution.content, remainingToolOutputBytes);
            if (remainingToolOutputBytes !== undefined) {
              remainingToolOutputBytes = Math.max(0, remainingToolOutputBytes - bounded.retainedBytes);
            }
            await append([
              {
                type: "tool.resulted",
                turnId,
                operationId: call.id,
                payload: {
                  callId: call.id,
                  name: call.name,
                  content: bounded.content,
                  isError: execution.isError ?? false,
                  metadata: bounded.truncated
                    ? {
                      ...(plainRecord(execution.metadata) ?? {}),
                      contextBudgetTruncated: true,
                      originalContentBytes: bounded.originalBytes,
                      retainedContentBytes: bounded.retainedBytes,
                    }
                    : execution.metadata ?? null,
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
      notifySignal(options.onSignal, { type: "status", turnId, status: "complete" });
      return { turnId, content, receipt, events: emitted };
    }

    throw new Error(`Agent exceeded the ${maxSteps}-step turn limit.`);
  } catch (error) {
    const cancelled = options.signal.aborted || isAbortError(error);
    if (!terminalCommitted) {
      try {
        terminalCommitted = await reconcileTerminal();
      } catch (reconciliationError) {
        throw new AggregateError(
          [error, reconciliationError],
          "The turn failed and its durable terminal state could not be reconciled.",
        );
      }
    }
    if (!terminalCommitted) {
      // Cancellation must not prevent its own durable terminal record. The
      // request signal only governs turn work, not the append-only audit trail.
      try {
        await append([
          {
            type: cancelled ? "turn.cancelled" : "turn.failed",
            turnId,
            payload: { error: errorMessage(error) },
          },
        ], false);
      } catch (terminalError) {
        let terminalRecovered: boolean;
        try {
          terminalRecovered = await reconcileTerminal();
        } catch (reconciliationError) {
          throw new AggregateError(
            [error, terminalError, reconciliationError],
            "The turn failed and its durable terminal state could not be reconciled.",
          );
        }
        if (terminalRecovered) throw error;
        throw new AggregateError(
          [error, terminalError],
          "The turn failed and its terminal audit event could not be persisted.",
        );
      }
    }
    throw error;
  }
}

async function prepareTurnContext(args: Readonly<{
  content: string;
  sessionId: string;
  manifest: SessionManifest;
  tools: ToolRegistry;
  signal: AbortSignal;
}>): Promise<CanonicalContextSelection | undefined> {
  const provider = args.tools.getTurnContextProvider();
  // Historical protocol-v1 manifests omitted the pin. Preserve their exact
  // provider-if-present behavior; createSessionManifest now always pins new
  // sessions so current turns are never governed by this compatibility path.
  const mode = args.manifest.turnContext ?? (provider ? "required" : "disabled");
  if (mode === "disabled") return undefined;
  if (!provider) throw new Error("This session requires turn-context retrieval, but no provider is attached.");
  const query = canonicalTurnContextQuery(args.content);
  if (!query) return undefined;
  const selected = await provider.selectForTurn(query, {
    sessionId: args.sessionId,
    signal: args.signal,
  });
  const canonical = canonicalContextSelection(selected);
  if (!canonical) throw new Error("The turn-context provider returned a non-canonical selection.");
  if (!await verifyContextSelection(canonical)) {
    throw new Error("The turn-context provider returned a selection whose commitments did not verify.");
  }
  if (!await verifyContextSelectionQuery(canonical, query)) {
    throw new Error("The turn-context provider returned a selection for a different canonical query.");
  }
  if (!contextSelectionScopeMatches(canonical, args.sessionId, args.manifest)) {
    throw new Error("The turn-context provider returned lineage outside this session's pinned scope.");
  }
  return canonical;
}

async function prepareLiveEnvironment(args: Readonly<{
  sessionId: string;
  manifest: SessionManifest;
  tools: ToolRegistry;
  transportPosture: InferenceTransport["posture"];
  signal: AbortSignal;
}>): Promise<LiveEnvironmentSnapshot | undefined> {
  const provider = args.tools.getLiveEnvironmentProvider();
  if (!provider) return undefined;
  args.signal.throwIfAborted();
  const observation = await provider.capture({ sessionId: args.sessionId, signal: args.signal });
  args.signal.throwIfAborted();
  const snapshot = await sealLiveEnvironmentSnapshot({
    sessionId: args.sessionId,
    manifest: args.manifest,
    toolDefinitions: args.tools.definitions(),
    transportPosture: args.transportPosture,
    observation,
  });
  if (!await verifyLiveEnvironmentSnapshot(snapshot)) {
    throw new Error("The sealed live-environment snapshot did not verify.");
  }
  if (!liveEnvironmentScopeMatches(snapshot, args.sessionId, args.manifest)) {
    throw new Error("The live-environment snapshot is outside this session's pinned scope.");
  }
  return snapshot;
}

/**
 * Bound one tool result to the bytes this turn can still send. An unbounded
 * result would overflow the pinned window and fail the whole turn at the
 * provider; a silent trim would misrepresent what the model was shown.
 *
 * Exported for the tools that have to survive it: it cuts the *tail*, so any
 * tool that puts a resume instruction at the end of its result is putting it
 * exactly where the cut lands. `src/tools/workspace-tools.test.ts` measures
 * `read_file`'s head notice through this function rather than assuming.
 */
export function boundToolResultContent(
  content: string,
  remainingBytes: number | undefined,
): Readonly<{ content: string; truncated: boolean; originalBytes: number; retainedBytes: number }> {
  const originalBytes = UTF8_ENCODER.encode(content).byteLength;
  if (remainingBytes === undefined || originalBytes <= remainingBytes) {
    return Object.freeze({ content, truncated: false, originalBytes, retainedBytes: originalBytes });
  }
  const marker = `\n[Airship truncated this tool result: ${originalBytes} bytes exceeded the ${remainingBytes} bytes left in this turn's pinned context window.]`;
  const budget = Math.max(0, remainingBytes - UTF8_ENCODER.encode(marker).byteLength);
  // Cut in the byte array, not by re-encoding a growing string: tool results run
  // to 1 MiB and a per-character re-encode would be quadratic on the hot path.
  const bytes = UTF8_ENCODER.encode(content);
  let cut = Math.min(budget, bytes.byteLength);
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  const bounded = `${UTF8_DECODER.decode(bytes.subarray(0, cut))}${marker}`;
  return Object.freeze({
    content: bounded,
    truncated: true,
    originalBytes,
    retainedBytes: UTF8_ENCODER.encode(bounded).byteLength,
  });
}

function plainRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function isTerminalTurnEvent(type: string): boolean {
  return type === "turn.completed" || type === "turn.failed" || type === "turn.cancelled";
}

function findUnfinishedProviderTurn(events: readonly DurableEvent[]): string | undefined {
  let active: string | undefined;
  for (const event of events) {
    if (event.type === "turn.requested" && event.turnId) active = event.turnId;
    if (active && event.turnId === active && isTerminalTurnEvent(event.type)) active = undefined;
  }
  return active;
}

function assertContextHistoryCompatible(
  events: readonly DurableEvent[],
  manifest: SessionManifest,
): void {
  if (manifest.turnContext !== undefined && events.some((event) =>
    event.type === "turn.requested" && record(event.payload)?.contextSelection !== undefined
  )) {
    throw new Error("This explicitly pinned session contains legacy request-embedded turn context.");
  }
  if (manifest.turnContext === "disabled" && events.some((event) => event.type === "turn.context.selected")) {
    throw new Error("This session disables turn-context retrieval but its history contains a selection event.");
  }
}

async function assertForkContextHistoryCompatible(
  events: readonly DurableEvent[],
  scope: ForkContextScope,
): Promise<string | undefined> {
  const seedEvents = events.filter((event) => event.type === FORK_CONTEXT_EVENT_TYPE);
  if (!scope.lineage) {
    if (seedEvents.length > 0) throw new Error("A non-fork session contains fork-context seed material.");
    return undefined;
  }
  const event = seedEvents.length === 1 ? seedEvents[0] : undefined;
  if (
    !event ||
    events[1]?.eventId !== event.eventId ||
    event.sessionId !== scope.sessionId ||
    event.turnId !== undefined ||
    event.operationId !== undefined
  ) throw new Error("A fork session is missing its unique initial context-seed commitment.");
  const seed = canonicalForkContextSeed(event.payload);
  if (
    !seed ||
    !forkContextSeedMatchesScope(seed, scope) ||
    !await verifyForkContextSeed(seed)
  ) throw new Error("The fork-context seed is malformed, out of scope, or has a digest mismatch.");
  return seed.contextDigest;
}

function notifySignal(onSignal: RunTurnOptions["onSignal"], signal: AgentSignal): void {
  try {
    onSignal?.(signal);
  } catch {
    // Observers cannot mutate or interrupt the durable turn state machine.
  }
}

function sameContextCompressionOptions(
  left: Required<ContextCompressionOptions>,
  right: Required<ContextCompressionOptions>,
): boolean {
  return left.contextWindowTokens === right.contextWindowTokens &&
    left.threshold === right.threshold &&
    left.targetRatio === right.targetRatio &&
    left.preserveRecentTurns === right.preserveRecentTurns &&
    left.maxSummaryDeltaBytes === right.maxSummaryDeltaBytes;
}

function assertSupportedTurnManifest(manifest: SessionManifest): void {
  const raw = manifest as SessionManifest & { protocolVersion?: unknown; turnContext?: unknown };
  if (raw.protocolVersion === 1) {
    if (raw.turnContext !== undefined) throw new Error("Protocol-v1 session manifests cannot pin turn-context policy.");
    return;
  }
  if (
    raw.protocolVersion !== 2 ||
    (raw.turnContext !== "required" && raw.turnContext !== "disabled")
  ) {
    throw new Error("The session manifest uses an unsupported protocol or turn-context policy.");
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
  let responseBytes = 0;
  let toolCallCount = 0;
  let eventCount = 0;
  for await (const event of transport.stream(request, signal)) {
    throwIfAborted(signal);
    eventCount += 1;
    if (eventCount > MAX_INFERENCE_EVENTS_PER_STEP) {
      throw new Error(`Provider exceeded the ${MAX_INFERENCE_EVENTS_PER_STEP}-event inference step limit.`);
    }
    if (terminal) throw new Error("Provider emitted events after completion.");
    if (event.type === "text-delta") {
      responseBytes += UTF8_ENCODER.encode(event.text).byteLength;
      if (responseBytes > MAX_ASSISTANT_RESPONSE_BYTES) {
        throw new Error(`Provider response exceeded the ${MAX_ASSISTANT_RESPONSE_BYTES}-byte turn limit.`);
      }
      onText(event.text);
    }
    if (event.type === "tool-call") {
      toolCallCount += 1;
      if (toolCallCount > MAX_TOOL_CALLS_PER_STEP) {
        throw new Error(`Provider exceeded the ${MAX_TOOL_CALLS_PER_STEP}-tool-call step limit.`);
      }
      onToolCall(event.call);
    }
    if (event.type === "usage") await onUsage(event as unknown as JsonValue);
    if (event.type === "progress") onProgress(event.phase);
    if (event.type === "completed") {
      terminal = { completed: true, finishReason: event.finishReason, receipt: event.receipt };
    }
  }
  return terminal ?? { completed: false };
}

export function materializeMessages(
  events: DurableEvent[],
  options: Readonly<{
    injectLatestContext?: boolean;
    allowEmbeddedContext?: boolean;
    allowSelectedContext?: boolean;
    /** Required before any inherited fork context is admitted to provider history. */
    forkContextScope?: ForkContextScope;
    /** Supplied only after the seed digest was asynchronously verified. */
    verifiedForkContextDigest?: string;
  }> = {},
): CanonicalMessage[] {
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
  const summary = materializeContextSummary(events);
  const visibleEvents = summary
    ? events.filter((event) => event.sequence > summary.coveredThroughSequence)
    : events;
  const seed = summary ? undefined : materializableForkContextSeed(
    events,
    options.forkContextScope,
    options.verifiedForkContextDigest,
  );
  const messages: CanonicalMessage[] = summary
    ? [structuredClone(summary.message)]
    : seed
      ? seed.messages.map((message) => structuredClone(message))
      : [];
  const requestMessageIndexes = new Map<string, number>();
  const latestRequest = [...visibleEvents].reverse().find((event) =>
    event.type === "turn.requested" && event.turnId && !nonActionableTurns.has(event.turnId),
  );
  for (const event of visibleEvents) {
    if (event.turnId && nonActionableTurns.has(event.turnId)) continue;
    const payload = record(event.payload);
    if (event.type === "turn.requested" && typeof payload?.content === "string") {
      const images = canonicalImageInputs(payload.images);
      const liveEnvironment = payload.liveEnvironment === undefined
        ? undefined
        : canonicalLiveEnvironmentSnapshot(payload.liveEnvironment);
      const contextSelection = payload.contextSelection === undefined || options.allowEmbeddedContext === false
        ? undefined
        : canonicalContextSelection(payload.contextSelection);
      if (images && (
        payload.liveEnvironment === undefined || liveEnvironment
      ) && (
        payload.contextSelection === undefined || options.allowEmbeddedContext === false || contextSelection
      )) {
        const messageIndex = messages.length;
        messages.push({
          role: "user",
          content: options.injectLatestContext !== false && event.eventId === latestRequest?.eventId
            ? injectContextSelection(injectLiveEnvironment(payload.content, liveEnvironment), contextSelection)
            : payload.content,
          ...(images.length ? { images: [...images] } : {}),
        });
        if (event.turnId) requestMessageIndexes.set(event.turnId, messageIndex);
      }
    }
    if (event.type === "turn.context.selected" && event.turnId && options.allowSelectedContext !== false) {
      const messageIndex = requestMessageIndexes.get(event.turnId);
      const contextSelection = canonicalContextSelection(payload?.contextSelection);
      const message = messageIndex === undefined ? undefined : messages[messageIndex];
      if (
        messageIndex !== undefined &&
        message?.role === "user" &&
        contextSelection &&
        options.injectLatestContext !== false &&
        event.turnId === latestRequest?.turnId
      ) {
        messages[messageIndex] = {
          ...message,
          content: injectContextSelection(message.content, contextSelection),
        };
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

function materializableForkContextSeed(
  events: readonly DurableEvent[],
  scope: ForkContextScope | undefined,
  verifiedDigest: string | undefined,
) {
  if (!scope?.lineage || !verifiedDigest) return undefined;
  const candidates = events.filter((event) => event.type === FORK_CONTEXT_EVENT_TYPE);
  const event = candidates.length === 1 ? candidates[0] : undefined;
  if (
    !event ||
    events[1]?.eventId !== event.eventId ||
    event.sessionId !== scope.sessionId ||
    event.turnId !== undefined ||
    event.operationId !== undefined
  ) return undefined;
  const seed = canonicalForkContextSeed(event.payload);
  return seed && seed.contextDigest === verifiedDigest && forkContextSeedMatchesScope(seed, scope)
    ? seed
    : undefined;
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
