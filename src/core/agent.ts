import type { ConversationReceipt } from "../receipts/types";
import { createLocalReceipt, finalizeProviderReceipt } from "../receipts/types";
import type { ToolRegistry } from "../tools/registry";
import type {
  ApprovalPolicy,
  CanonicalMessage,
  InferenceTransport,
  JsonValue,
  SessionManifest,
  TaskPlanEntry,
  ToolCall,
  ToolContext,
} from "./contracts";
import { sha256, stableStringify, toolArgumentsDigest } from "./hash";
import { randomUuid } from "./id";
import type { DurableEvent, EventDraft } from "./journal";
import { effectiveSessionContextPolicy, effectiveSessionModel, EventJournal } from "./journal";
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
import { withInferenceRetry, type InferenceRetryPolicy } from "./inference-retry";
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
  /**
   * Bounds the in-step redelivery of a transient provider refusal. Omitted, the
   * turn uses DEFAULT_INFERENCE_RETRY_POLICY; supplying `maxAttempts: 1` opts a
   * caller out entirely.
   */
  retry?: InferenceRetryPolicy;
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
 * Repeating a call that has already failed with byte-identical arguments is the
 * cheapest way to spend a 32-step turn on nothing. The first threshold says so
 * in the only channel the model reads — the tool message itself — and the
 * second ends the turn rather than letting it burn to the step limit.
 *
 * Two is deliberately early: one retry after a transient failure is legitimate,
 * a third attempt is not, and the warning costs a couple of hundred bytes.
 */
const REPEATED_FAILURE_WARN_AT = 2;
const REPEATED_FAILURE_STOP_AT = 5;
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
/**
 * Escaped rather than literal on purpose: a raw NUL in a source file makes the
 * whole file diff as binary, and a change nobody can read is a change nobody
 * reviewed.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]+/gu;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const maxSteps = options.maxSteps ?? 8;
  /*
   * Every provider call this turn makes — each step and the compaction
   * summarizer — goes through the retrying view, not the raw transport. It
   * reports the same `id` and `posture`, so the pin checks below are checking
   * the same authority they always were.
   */
  const transport = withInferenceRetry(options.transport, options.retry);
  const session = await options.journal.getSession(options.sessionId, options.signal);
  if (!session) throw new Error(`Unknown session: ${options.sessionId}`);
  assertSupportedTurnManifest(session.manifest);
  if (session.manifest.protocolVersion === 1) {
    throw new Error("Protocol-v1 sessions are replay-only; fork the session before starting a new turn.");
  }
  if (session.manifest.providerId !== transport.id) {
    throw new Error(
      `Session provider is pinned to ${session.manifest.providerId}; fork the session to use ${transport.id}.`,
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
    transportPosture: transport.posture,
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

    /*
     * A context window is pinned session semantics, read from the journal and
     * never inferred from a model name or re-read from a mutable catalog
     * during replay. The pin just stopped being "only the creation manifest":
     * a same-thread model switch projects its own policy event beside the
     * model it routes to — still journaled evidence down to which window the
     * summarizer is fed, still recomputable at any point of a replay.
     */
    const effectiveContextPolicy = effectiveSessionContextPolicy(session);
    const pinnedContextCompression = effectiveContextPolicy
      ? contextCompressionOptionsFromPolicy(effectiveContextPolicy)
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
        ...(effectiveContextPolicy?.compression.summarizer.mode === "inference-transport" ? {
          summarizer: createInferenceTransportContextSummarizer({
            transport,
            model: effectiveSessionModel(session),
            sessionId: session.id,
          }),
          summarizerFailure: effectiveContextPolicy.compression.summarizer.onFailure === "extractive-fallback"
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
      // A compaction is the one moment the plan can fall out of the prompt: the
      // file survives by construction, but nothing put it back, so a long turn
      // had to remember to call `list_tasks` in order to remember what it was
      // doing. Restated here it costs one bounded message per compaction.
      const planNote = await taskPlanNotePayload(options.tools, options.sessionId, options.signal);
      if (planNote) {
        await append([{ type: TASK_PLAN_NOTE_EVENT_TYPE, turnId, payload: planNote }]);
      }
    }

    let turnBaselineTokens: number | undefined;
    /*
     * Keyed on `(toolName, argumentsDigest, wasError)` for the whole turn, using
     * the broker's own definition of identical arguments. Only error outcomes
     * are counted, so the `error` component is pinned rather than dropped: a
     * call that succeeded twice and then failed starts its failure count at one.
     */
    const repeatedFailures = new Map<string, number>();
    let guardrailStop: string | undefined;
    /**
     * Record one failed outcome and return the guidance to append to the tool
     * message the model will read. Metadata is not enough — `payload.content` is
     * the entire tool message — so the warning has to ride in the content.
     */
    const noteFailedOutcome = async (call: ToolCall): Promise<string> => {
      const digest = await toolArgumentsDigest(call.arguments);
      const key = `${call.name.length}:${call.name}|${digest}|error`;
      const count = (repeatedFailures.get(key) ?? 0) + 1;
      repeatedFailures.set(key, count);
      if (count >= REPEATED_FAILURE_STOP_AT) {
        guardrailStop = `${call.name} failed ${count} times in this turn with identical arguments. `
          + "The turn was stopped instead of spending its remaining steps on a call that is not going to "
          + "start succeeding; change the arguments or the approach and send it again.";
        return "";
      }
      if (count < REPEATED_FAILURE_WARN_AT) return "";
      return `\n\n[Airship guardrail: ${call.name} has now failed ${count} times in this turn with identical `
        + "arguments, so repeating it unchanged will fail again. Change the arguments, use a different tool, "
        + `or tell the person what is blocking you. This turn stops at ${REPEATED_FAILURE_STOP_AT} identical failures.]`;
    };
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
          model: effectiveSessionModel(session),
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
            providerId: transport.id,
            model: effectiveSessionModel(session),
            posture: transport.posture,
            requestDigest,
            idempotencyKey,
          },
        },
      ]);
      notifySignal(options.onSignal, { type: "status", turnId, status: "thinking" });

      let content = "";
      let reasoningText = "";
      let reasoningTruncated = false;
      const toolCalls: ToolCall[] = [];
      let completed: Extract<Awaited<ReturnType<typeof collectInference>>, { completed: true }> | undefined;
      const collected = await collectInference(
        transport,
        {
          requestId,
          sessionId: options.sessionId,
          turnId,
          model: effectiveSessionModel(session),
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
        (reasoningDelta) => {
          if (reasoningText.length < MAX_TURN_REASONING_CHARS) {
            reasoningText = (reasoningText + reasoningDelta).slice(0, MAX_TURN_REASONING_CHARS);
          } else {
            reasoningTruncated = true;
          }
        },
      );
      if (collected.completed) completed = collected;
      if (reasoningText) {
        await append([{
          type: "turn.reasoning",
          turnId,
          operationId: requestId,
          payload: {
            text: reasoningText,
            ...(reasoningTruncated ? { truncated: true } : {}),
          },
        }]);
        reasoningText = "";
        reasoningTruncated = false;
      }
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

        for (let cursor = 0; cursor < toolCalls.length;) {
          throwIfAborted(options.signal);
          const batch = readEffectBatch(toolCalls, cursor, options.tools);
          cursor += batch.length;
          /*
           * Phase 1 — review, strictly in call order, one at a time. Nothing
           * here is parallelised: a person answering an approval prompt must be
           * asked the same questions in the same order they would have been
           * asked serially, and the journal has to read the same way too.
           */
          const admitted: { call: ToolCall; context: ToolContext }[] = [];
          for (const call of batch) {
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
                  payload: { callId: call.id, name: call.name, content: `${errorMessage(error)}${await noteFailedOutcome(call)}` },
                },
              ]);
              continue;
            }
            const provenance = approvalProvenance(options.approvalPolicy, context);
            if (decision === "deny") {
              // A denial counts as a failed outcome. Re-asking for the same
              // denied call is the loop with the highest cost of all, because
              // every lap of it interrupts a person who already answered.
              await append([
                {
                  type: "tool.denied",
                  turnId,
                  operationId: call.id,
                  payload: {
                    callId: call.id,
                    name: call.name,
                    content: `Permission denied for ${call.name}.${await noteFailedOutcome(call)}`,
                    approval: provenance ?? null,
                  },
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
            admitted.push({ call, context });
          }
          /*
           * Phase 2 — the only thing that overlaps. Six `read_file` calls used
           * to cost six sequential round trips through review and execute for
           * no reason: they declare `effect: "read"`, so none of them can
           * observe another's outcome. `allSettled`, not `all`, because one
           * rejection must not discard five results that already landed.
           */
          const outcomes = await Promise.allSettled(
            admitted.map(({ call, context }) => options.tools.executeApproved(call.name, call.arguments, context)),
          );
          /*
           * Phase 3 — journal in call order, whatever order they finished in.
           * The transcript the model reads, and the byte budget each result is
           * bounded against, must not depend on which disk read won a race.
           */
          for (let slot = 0; slot < admitted.length; slot += 1) {
            const call = admitted[slot]!.call;
            const outcome = outcomes[slot]!;
            if (outcome.status === "rejected") {
              await append([
                {
                  type: "tool.failed",
                  turnId,
                  operationId: call.id,
                  payload: {
                    callId: call.id,
                    name: call.name,
                    content: `${errorMessage(outcome.reason)}${await noteFailedOutcome(call)}`,
                  },
                },
              ]);
              continue;
            }
            const execution = outcome.value;
            // A single verbose result must not cost the user the whole turn. What
            // is stored is exactly what the model will read, and the marker plus
            // metadata state that the tail was dropped.
            const bounded = boundToolResultContent(execution.content, remainingToolOutputBytes);
            // Appended after the bound, not before it: a guardrail warning that
            // the truncator can eat is a guardrail the model never sees.
            const guidance = execution.isError === true ? await noteFailedOutcome(call) : "";
            if (remainingToolOutputBytes !== undefined) {
              remainingToolOutputBytes = Math.max(
                0,
                remainingToolOutputBytes - bounded.retainedBytes - UTF8_ENCODER.encode(guidance).byteLength,
              );
            }
            await append([
              {
                type: "tool.resulted",
                turnId,
                operationId: call.id,
                payload: {
                  callId: call.id,
                  name: call.name,
                  content: `${bounded.content}${guidance}`,
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
          }
        }
        // Thrown after the batch, never inside it. Stopping mid-batch would
        // leave a declared tool call with no tool message answering it, and a
        // dangling call is a history every provider rejects.
        if (guardrailStop) throw new Error(guardrailStop);
        continue;
      }

      if (completed.finishReason === "tool-calls") {
        throw new Error("Provider ended for tool calls without producing a complete tool call.");
      }
      const responseDigest = await sha256(content);
      const receipt = completed.receipt
        ? finalizeProviderReceipt(completed.receipt, transport.id, requestDigest, responseDigest)
        : createLocalReceipt({
            sessionId: options.sessionId,
            turnId,
            provider: transport.id,
            model: effectiveSessionModel(session),
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
 * The journal record of the work plan restated into the prompt after a
 * compaction. Named here beside the renderer that is the only thing allowed to
 * turn it into prompt text, because the turn loop writes it and the session
 * audit has to reproduce the exact message it became.
 */
export const TASK_PLAN_NOTE_EVENT_TYPE = "turn.plan.restated";
/** Bounds what one note can cost; the plan itself already caps at 64 tasks. */
const MAX_PLAN_NOTE_TASKS = 16;
const MAX_PLAN_NOTE_CONTENT_CHARS = 160;

async function taskPlanNotePayload(
  tools: ToolRegistry,
  sessionId: string,
  signal: AbortSignal,
): Promise<JsonValue | undefined> {
  const provider = tools.getTaskPlanProvider();
  if (!provider) return undefined;
  let tasks: readonly TaskPlanEntry[];
  try {
    tasks = await provider.openTasks({ sessionId, signal });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    // The plan file is the model's own to repair, and a turn that dies because
    // it wrote bad JSON into it cannot repair anything. Say what happened, in
    // the channel that can act on it.
    return { unreadable: errorMessage(error) };
  }
  if (!tasks.length) return undefined;
  return {
    // The true open count, carried separately from the bounded list.
    //
    // Without it the note said "These 16 item(s) are still open in your own
    // plan" while 30 were open — a false sentence in the one channel the model
    // reads, from the change that restates the plan so the model can trust it.
    // The cap is about note size; the count is about the plan, and conflating
    // them made the note lie about the thing it exists to report.
    openTaskCount: tasks.length,
    tasks: tasks.slice(0, MAX_PLAN_NOTE_TASKS).map((task) => ({
      id: task.id,
      content: task.content,
      status: task.status,
    })),
  } as unknown as JsonValue;
}

/**
 * Render a plan-note payload into the exact prompt text it becomes, or
 * `undefined` if the payload is not a canonical note.
 *
 * Exported because `auditSessionHistory` rebuilds the transcript this turn was
 * digested over and has to produce byte-identical text; two renderers would
 * make every compacting turn report a request-digest mismatch.
 */
export function canonicalTaskPlanNote(payload: unknown): string | undefined {
  const fields = record(payload);
  if (!fields) return undefined;
  if (typeof fields.unreadable === "string") {
    return "[Airship work plan: this turn compacted earlier history, and /workspace/.airship/tasks.json "
      + `could not be read to restate the plan (${planNoteText(fields.unreadable, 200)}). `
      + "Call update_tasks to rewrite the plan before relying on it.]";
  }
  const tasks = Array.isArray(fields.tasks) ? fields.tasks : undefined;
  if (!tasks || tasks.length === 0 || tasks.length > MAX_PLAN_NOTE_TASKS) return undefined;
  const lines: string[] = [];
  for (const value of tasks) {
    const task = record(value);
    const id = typeof task?.id === "string" ? planNoteText(task.id, 80) : "";
    const content = typeof task?.content === "string" ? planNoteText(task.content, MAX_PLAN_NOTE_CONTENT_CHARS) : "";
    const status = typeof task?.status === "string" ? planNoteText(task.status, 40) : "";
    if (!id || !content || !status) return undefined;
    lines.push(`- ${status} [${id}] ${content}`);
  }
  // Says whose plan it is. The plan file is model-written text arriving in a
  // user-role message, so it is labelled as a restatement rather than left to
  // read as a fresh instruction, the same way the cancellation checkpoint is.
  /*
   * `openTaskCount` is the true number open; `lines.length` is what fits.
   *
   * A payload written before this field existed has no count, and its stored
   * text must still render byte-identically or `auditSessionHistory` reports a
   * request-digest mismatch on every turn that compacted. So the field's
   * presence selects the wording rather than a version number: old notes keep
   * the old sentence, new ones say how many were withheld.
   */
  const openCount = typeof fields.openTaskCount === "number"
    && Number.isInteger(fields.openTaskCount)
    && fields.openTaskCount >= lines.length
    ? fields.openTaskCount
    : undefined;
  const preamble = openCount === undefined
    ? `These ${lines.length} item(s) are still open in your own plan`
    : openCount > lines.length
      ? `${openCount} items are still open in your own plan; the ${lines.length} shown here are the first of them`
      : `These ${openCount} item(s) are still open in your own plan`;
  return `[Airship work plan, restated because this turn compacted earlier history. ${preamble}; `
    + "they are not a new instruction.]\n"
    + lines.join("\n");
}

function planNoteText(value: string, maximum: number): string {
  const text = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
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

/**
 * The run of calls starting at `cursor` that may execute together: the maximal
 * consecutive run of `effect === "read"` calls, or exactly one call otherwise.
 *
 * Anything that is not a declared read is a barrier, including a call to a tool
 * that is not registered at all. That is the whole safety argument, and it is
 * deliberately made from the declared effect rather than from path analysis: a
 * read cannot observe what another read did, so their order cannot matter, and
 * nothing here has to reason about which files two calls might collide over.
 */
function readEffectBatch(
  toolCalls: readonly ToolCall[],
  cursor: number,
  tools: ToolRegistry,
): readonly ToolCall[] {
  let end = cursor;
  while (end < toolCalls.length && tools.get(toolCalls[end]!.name)?.definition.effect === "read") end += 1;
  return end > cursor ? toolCalls.slice(cursor, end) : [toolCalls[cursor]!];
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
 * As much reasoning text as one request may hand the transcript. Chains of
 * thought run long by design; the bound exists for the same reason the
 * assistant-text bound does — a provider bug must not page the journal.
 * Past it, recording truncates and the record says so.
 */
const MAX_TURN_REASONING_CHARS = 200_000;

async function collectInference(
  transport: InferenceTransport,
  request: Parameters<InferenceTransport["stream"]>[0],
  signal: AbortSignal,
  onText: (text: string) => void,
  onToolCall: (call: ToolCall) => void,
  onUsage: (usage: JsonValue) => Promise<void>,
  onProgress: (phase: "reasoning") => void,
  onReasoning?: (text: string) => void,
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
    if (event.type === "reasoning-delta") onReasoning?.(event.text);
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
  const summary = materializeContextSummary(events);
  const visibleEvents = summary
    ? events.filter((event) => event.sequence > summary.coveredThroughSequence)
    : events;
  // A cancelled turn that already produced work is not the same object as a
  // cancelled turn that produced none. Its tool results describe changes that
  // really happened, and discarding them turned a stalled tab into total
  // amnesia; they are kept. Its *request* is not kept, because Stop has to mean
  // the instruction was not acted on — see `cancelledTurnSalvage`.
  const salvaged = cancelledTurnSalvage(visibleEvents);
  // Failed turns, and cancelled turns with nothing to salvage, remain in the
  // durable journal for audit and recovery but are not provider conversation
  // history. Omitting the complete turn avoids replaying its user intent (or a
  // partial tool phase) as actionable context when a later turn begins.
  const nonActionableTurns = new Set(
    events
      .filter((event) =>
        (event.type === "turn.cancelled" || event.type === "turn.failed") &&
        typeof event.turnId === "string" &&
        !salvaged.has(event.turnId),
      )
      .map((event) => event.turnId as string),
  );
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
    event.type === "turn.requested" && event.turnId &&
    !nonActionableTurns.has(event.turnId) && !salvaged.has(event.turnId),
  );
  for (const event of visibleEvents) {
    if (event.turnId && nonActionableTurns.has(event.turnId)) continue;
    const payload = record(event.payload);
    const salvage = event.turnId ? salvaged.get(event.turnId) : undefined;
    if (salvage && event.type === "turn.requested") {
      // Stands where the cancelled request would have stood, so the first
      // message of the salvaged turn is still a user message and the tool
      // results below it are still preceded by the assistant step that made
      // them. It names what happened; it does not restate what was asked.
      messages.push({ role: "user", content: cancellationCheckpoint(salvage) });
      continue;
    }
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
        /*
         * A slash-shaped prompt is transport-local (/reason and the demo's
         * teaching verbs): workspace context injection wraps the user text in
         * a sterile header, and the receiving lane stopped parsing its own
         * verb — which is precisely how /reason returned the demo's fallback
         * instead of its reasoning lane. Those prompts are never workspace
         * queries, so they arrive verbatim.
         */
        const slashLocal = payload.content.trimStart().startsWith("/");
        messages.push({
          role: "user",
          content: options.injectLatestContext !== false && !slashLocal && event.eventId === latestRequest?.eventId
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
      const slashLocal = message?.role === "user" && message.content.trimStart().startsWith("/");
      if (
        messageIndex !== undefined &&
        message?.role === "user" &&
        !slashLocal &&
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
    if (event.type === TASK_PLAN_NOTE_EVENT_TYPE) {
      // Every note is rendered, not just the newest. A note is only ever
      // written immediately after a compaction, and the next compaction covers
      // it, so at most one stale note is ever live — and rendering "only the
      // latest" would make this function disagree with the audit's incremental
      // rebuild, which can push but cannot retract.
      const note = canonicalTaskPlanNote(event.payload);
      if (note) messages.push({ role: "user", content: note });
    }
    if (event.type === "assistant.completed") {
      const message = record(payload?.message);
      if (message?.role === "assistant" && typeof message.content === "string") {
        const declared = Array.isArray(message.toolCalls) ? (message.toolCalls as unknown as ToolCall[]) : undefined;
        // The unresolved tail of a cancelled step is dropped here rather than
        // answered with an invented result: every provider rejects a tool call
        // that no tool message ever replies to, so a call the turn never ran
        // cannot be carried forward at all.
        const toolCalls = salvage
          ? declared?.filter((call) => salvage.resolvedCallIds.has(call.id))
          : declared;
        if (!salvage || message.content || toolCalls?.length) {
          messages.push({
            role: "assistant",
            content: message.content,
            ...(toolCalls?.length ? { toolCalls } : {}),
          });
        }
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

type CancelledTurnSalvage = Readonly<{
  reason: string;
  resolvedCallIds: ReadonlySet<string>;
  unresolvedCalls: number;
}>;

/**
 * Decide which cancelled turns keep their completed work, and what of it.
 *
 * A cancellation is not evidence that the work was wrong — a stalled background
 * tab produces exactly the same terminal event as a deliberate Stop — so the
 * assistant step and the tool results that already landed are kept as history.
 * The user's request is not, and that asymmetry is the point: the one thing
 * Stop unambiguously means is that the instruction should not continue to be
 * acted on, and a replayed request is an instruction. `agent.test.ts` holds the
 * dangerous-prompt case that proves it.
 *
 * A turn is salvageable only when it has a materializable assistant step *and*
 * something that step accomplished (a tool outcome, or assistant prose). A turn
 * cancelled before any of that has nothing to carry and stays dropped whole, so
 * the common "typed it, hit Stop" case is unchanged.
 */
function cancelledTurnSalvage(events: readonly DurableEvent[]): Map<string, CancelledTurnSalvage> {
  const reasons = new Map<string, string>();
  const assistantTurns = new Set<string>();
  const workedTurns = new Set<string>();
  const requestedCalls = new Map<string, Set<string>>();
  const resolvedCalls = new Map<string, Set<string>>();
  for (const event of events) {
    const turnId = event.turnId;
    if (typeof turnId !== "string") continue;
    const payload = record(event.payload);
    if (event.type === "turn.cancelled") {
      reasons.set(turnId, boundedCancellationReason(payload?.error));
    } else if (event.type === "assistant.completed") {
      const message = record(payload?.message);
      if (message?.role !== "assistant" || typeof message.content !== "string") continue;
      assistantTurns.add(turnId);
      if (message.content) workedTurns.add(turnId);
      const calls = Array.isArray(message.toolCalls) ? message.toolCalls as unknown as ToolCall[] : [];
      const declared = requestedCalls.get(turnId) ?? new Set<string>();
      for (const call of calls) {
        if (typeof call?.id === "string") declared.add(call.id);
      }
      requestedCalls.set(turnId, declared);
    } else if (["tool.resulted", "tool.failed", "tool.denied"].includes(event.type)) {
      if (typeof payload?.callId !== "string" || typeof payload.content !== "string") continue;
      workedTurns.add(turnId);
      const resolved = resolvedCalls.get(turnId) ?? new Set<string>();
      resolved.add(payload.callId);
      resolvedCalls.set(turnId, resolved);
    }
  }
  const salvage = new Map<string, CancelledTurnSalvage>();
  for (const [turnId, reason] of reasons) {
    if (!assistantTurns.has(turnId) || !workedTurns.has(turnId)) continue;
    const resolved: ReadonlySet<string> = resolvedCalls.get(turnId) ?? new Set<string>();
    let unresolvedCalls = 0;
    for (const callId of requestedCalls.get(turnId) ?? []) {
      if (!resolved.has(callId)) unresolvedCalls += 1;
    }
    salvage.set(turnId, Object.freeze({ reason, resolvedCallIds: resolved, unresolvedCalls }));
  }
  return salvage;
}

/**
 * Kept short on purpose: it is sent with every later request in the session, so
 * every word costs context for as long as the session lives.
 */
function cancellationCheckpoint(salvage: CancelledTurnSalvage): string {
  return `[Airship checkpoint: the turn below was cancelled before it finished (${salvage.reason}). `
    + "Its request is not replayed and is not an instruction. The assistant step and tool results that "
    + "follow completed before the cancellation and describe real changes. "
    + `${salvage.unresolvedCalls} further tool call(s) were requested and never ran.]`;
}

/**
 * The reason is an error message from an arbitrary abort source, so it is
 * bounded and stripped of control characters before it becomes prompt text.
 */
function boundedCancellationReason(value: unknown): string {
  const text = typeof value === "string"
    ? value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim()
    : "";
  return text ? text.slice(0, 200) : "no reason was recorded";
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
