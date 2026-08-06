/**
 * The prime session authority: one ported prime-agent loop bound to one
 * airship session journal, translating the prime loop's runtime events into
 * the byte-exact airship turn protocol (journal vocabulary, receipts, and
 * guardrails from `src/core/agent.ts`), with prime-only facts kept in the
 * `prime.*` evidence namespace beside — never inside — the canonical
 * transcript.
 *
 * Binding rules (mirrors `SRC_PRIME_SPEC.md`):
 *   - the journal is the sole transcript authority: `convertToLlm` rebuilds
 *     the provider-visible canonical history from journal events before every
 *     provider request, and the request digest is computed over those exact
 *     canonical messages (the audit re-derives the same bytes);
 *   - every turn ends with exactly one durable terminal event, and terminal
 *     appends are signal-neutral: a cancellation must not prevent its own
 *     durable record ("cancellation cannot block the audit trail");
 *   - approvals are airship's: every effect crosses `ToolRegistry.review`
 *     then `executeApproved` with `(sessionId, turnId, operationId)` identity,
 *     and decisions are journaled with `approvalProvenance`;
 *   - steering is next-turn, never mid-turn text injection: every queued
 *     `steer`/`followUp` becomes its own `turn.requested`, because a message
 *     the journal never saw does not exist for the next provider request.
 */

import { Agent } from "../agent";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "../agent";
import { streamSimple as registryStreamSimple } from "../ai/stream";
import { createTransportForPrimeModel, type PrimeModelStreamFunction } from "../transport-adapter";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  JsonSchema,
  Message,
  Model,
  ToolResultMessage,
  Usage,
} from "../ai/types";
import { approvalProvenance } from "../../approvals/modes";
import { boundToolResultContent, materializeMessages } from "../../core/agent";
import type { AgentSignal } from "../../core/agent";
import type {
  ApprovalPolicy,
  CanonicalImageInput,
  CanonicalMessage,
  InferenceTransport,
  JsonValue,
  SessionManifest,
  Tool,
  ToolCall,
  ToolContext,
} from "../../core/contracts";
import {
  canonicalContextSelection,
  canonicalTurnContextQuery,
  contextSelectionScopeMatches,
  verifyContextSelection,
  verifyContextSelectionQuery,
} from "../../core/context-selection";
import { estimateInferenceTokens } from "../../core/context-compressor";
import { contextCompressionOptionsFromPolicy } from "../../core/context-policy";
import { sha256, stableStringify, toolArgumentsDigest } from "../../core/hash";
import { randomUuid } from "../../core/id";
import type { DurableEvent, EventDraft, EventJournal } from "../../core/journal";
import { canonicalImageInputs } from "../../core/multimodal";
import { createLocalReceipt, finalizeProviderReceipt } from "../../receipts/types";
import type { ConversationReceipt } from "../../receipts/types";
import type { ToolRegistry } from "../../tools/registry";
import type { KernelBudgets, KernelJobEvent, KernelJobResult } from "../kernel/kernel-contract";
import type { KernelBridgePort, KernelWorkerLike } from "../kernel/kernel-host";
import { PrimeKernelHost } from "../kernel/kernel-host";
import { KernelToolBridge } from "../kernel/tool-bridge";
import { noticeDraft, PRIME_EVENT_TYPES } from "./prime-events";

/** Mirrors core/agent.ts MAX_TOOL_CALLS_PER_STEP; one capped batch per assistant step. */
export const PRIME_MAX_TOOL_CALLS_PER_STEP = 64;
/** Mirrors core/agent.ts MAX_ASSISTANT_RESPONSE_BYTES; assistant text is measured in UTF-8 bytes. */
export const PRIME_MAX_ASSISTANT_BYTES = 4 * 1_024 * 1_024;
/** Mirrors core/agent.ts MAX_INFERENCE_EVENTS_PER_STEP; counted per streamed provider event. */
export const PRIME_MAX_STEP_EVENTS = 100_000;
/** Default turn step ceiling; airship's UI passes 32 to runTurn, so it is the prime default too. */
export const PRIME_DEFAULT_MAX_STEPS = 32;
/** Grace between cooperative kernel-job cancel and hard worker terminate on abort/dispose. */
export const PRIME_TERMINATE_GRACE_MS = 500;

const REPEATED_FAILURE_WARN_AT = 2;
const REPEATED_FAILURE_STOP_AT = 5;
/** Mirrors core/agent.ts: room held back so the final assistant reply still fits the window. */
const RESERVED_RESPONSE_TOKENS = 1_024;
/** Mirrors core/agent.ts: a turn that opened over its pinned window gets this much headroom. */
const OVER_WINDOW_LOOP_ALLOWANCE_TOKENS = RESERVED_RESPONSE_TOKENS * 2;
/** Mirrors core/agent.ts DEFAULT_BYTES_PER_TOKEN; calibration is a named deferred seam. */
const DEFAULT_BYTES_PER_TOKEN = 3.6;
const MAX_OPERATION_ID_CHARS = 512;
const UNSAFE_OPERATION_ID = /[-]/u;
const KERNEL_NOTICE_NAMESPACE_RESET =
  "The prime kernel worker was terminated; its in-worker namespace was reset and every symbol kernel code defined is gone. " +
  "Subsequent kernel jobs start from an empty namespace.";

export type PrimeTurnOutcome = "completed" | "failed" | "cancelled";

export type PrimeTurnResult = Readonly<{
  turnId: string;
  outcome: PrimeTurnOutcome;
  /** Final assistant text when completed. */
  text?: string;
  /** Terminal error text when failed. */
  error?: string;
  /** Cancellation reason when cancelled. */
  reason?: string;
  /** Receipt chained to the final step's request digest when completed. */
  receipt?: ConversationReceipt;
  /** Full journal read after the turn settled. */
  events: DurableEvent[];
}>;

export type PrimeSessionOptions = Readonly<{
  sessionId: string;
  /** Produced by the airship side (createSessionManifest); prime never invents one. */
  manifest: SessionManifest;
  journal: EventJournal;
  registry: ToolRegistry;
  approvalPolicy: ApprovalPolicy;
  model: Model<Api>;
  /** Override; absent means an adapter-bridge transport, else the prime ai registry stream. */
  streamFn?: StreamFn;
  /** Airship-side inference transport, adapted through ../transport-adapter when supplied. */
  transport?: InferenceTransport;
  /** Adapter out-channel hook for provider receipts. */
  onReceipt?: (receipt: ConversationReceipt) => void;
  /** Text-delta/status/tool-output fan-out using airship's AgentSignal vocabulary. */
  onSignal?: (signal: AgentSignal) => void;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  getSystemPrompt?: () => string | Promise<string>;
  maxSteps?: number;
  kernelBudgets?: Partial<KernelBudgets>;
  /** Test seam: scripted in-process kernel worker. */
  kernelWorkerFactory?: () => Worker;
  /** External host cancel: aborts the active turn exactly like abortTurn. */
  signal?: AbortSignal;
}>;

type QueuedTurnKind = "prompt" | "steer" | "followUp";

type QueuedTurnEntry = {
  kind: QueuedTurnKind;
  content: string;
  images?: readonly CanonicalImageInput[];
  resolve: (result: PrimeTurnResult) => void;
  reject: (error: unknown) => void;
};

type ExecutionCapture =
  | Readonly<{ kind: "result"; isError: boolean; metadata: JsonValue | undefined }>
  | Readonly<{ kind: "failed"; message: string }>;

/*
 * Everything whose lifetime is one journaled turn. A turn is recreated on
 * every prompt/steer/followUp run, so stale state from an earlier turn can
 * never leak into a later one's evidence: the repeat-failure counter, the
 * review bookkeeping, and the context budget all reset here boundaries.
 */
type ActiveTurn = {
  turnId: string;
  controller: AbortController;
  /** Next provider-request index inside this turn; journaled as inference.started.step. */
  step: number;
  stepEventCount: number;
  requestId?: string;
  requestDigest?: string;
  /** Canonical messages the current step was digested over; built by convertToLlm. */
  canonical: CanonicalMessage[];
  turnBaselineTokens?: number;
  remainingToolOutputBytes?: number;
  repeatCounts: Map<string, number>;
  guardrailStop?: string;
  reviewDeniedIds: Set<string>;
  reviewFailedIds: Set<string>;
  reviewedIds: Set<string>;
  callRecords: Map<string, Readonly<{ name: string; arguments: JsonValue }>>;
  execCaptures: Map<string, ExecutionCapture>;
  finalAssistantText?: string;
  finalReceipt?: ConversationReceipt;
  terminalError?: string;
  cancelReason?: string;
  terminalKind?: PrimeTurnOutcome;
};

export class PrimeAgentSession {
  private readonly options: PrimeSessionOptions;
  private readonly maxStepsLimit: number;
  private readonly agentLoop: Agent;
  private readonly kernelHostValue: PrimeKernelHost;
  private readonly idleKernelBridge: KernelToolBridge;
  private activeKernelBridge?: KernelToolBridge;
  private readonly sessionAbort = new AbortController();

  private eventsCache: DurableEvent[] = [];
  private bootstrapped = false;
  private readonly reservedOperationIds = new Set<string>();
  private usageTotal: Usage = primeZeroUsage();

  private turn?: ActiveTurn;
  private lastPromptSystemPrompt?: string;
  private readonly steerQueue: QueuedTurnEntry[] = [];
  private readonly followUpQueue: QueuedTurnEntry[] = [];
  private promptQueue: QueuedTurnEntry[] = [];
  private driverBusy = false;
  private idleWaiters: (() => void)[] = [];
  private disposed = false;
  private readonly activeKernelJobs = new Set<string>();
  private kernelTerminateTimer?: ReturnType<typeof setTimeout>;

  constructor(options: PrimeSessionOptions) {
    this.options = options;
    this.maxStepsLimit = options.maxSteps ?? PRIME_DEFAULT_MAX_STEPS;
    if (
      options.manifest.protocolVersion !== 2 ||
      (options.manifest.turnContext !== "required" && options.manifest.turnContext !== "disabled")
    ) {
      throw new Error("The session manifest uses an unsupported protocol or turn-context policy.");
    }
    if (options.transport && options.transport.id !== options.manifest.providerId) {
      throw new Error(
        `Session provider is pinned to ${options.manifest.providerId}; fork the session to use ${options.transport.id}.`,
      );
    }
    this.agentLoop = new Agent({
      initialState: { model: options.model, systemPrompt: "" },
      sessionId: options.sessionId,
      getApiKey: options.getApiKey,
      /*
       * Airship reviews a batch in strict call order and runs declared reads
       * read-parallel. The prime loop's parallel mode reviews in order but
       * executes everything concurrently, which lets concurrent writes race
       * where airship serializes them; sequential mode is the conservative
       * twin. The read-parallel speedup is a documented lossy note, not a
       * semantic change: journal order is call order in both worlds.
       */
      toolExecution: "sequential",
    });
    this.agentLoop.convertToLlm = (_messages) => this.convertToLlm(_messages);
    this.agentLoop.streamFn = this.createInstrumentedStreamFn();
    this.agentLoop.beforeToolCall = (hookContext, signal) => this.beforeToolCall(hookContext, signal);
    this.agentLoop.afterToolCall = async (hookContext) => this.afterToolCall(hookContext);
    this.agentLoop.shouldStopAfterTurn = () => this.turn?.guardrailStop !== undefined;
    this.agentLoop.subscribe((event) => this.onAgentEvent(event));

    const bridgePort: KernelBridgePort = {
      call: (request, label) => this.kernelBridge.call(request, label),
    };
    this.kernelHostValue = new PrimeKernelHost({
      budgets: options.kernelBudgets,
      ports: {
        bridge: bridgePort,
        ...(options.kernelWorkerFactory
          ? { workerFactory: () => options.kernelWorkerFactory!() as unknown as KernelWorkerLike }
          : {}),
      },
    });
    this.kernelHostValue.onEvent((event) => this.onKernelEvent(event));
    this.idleKernelBridge = this.createKernelBridge(this.sessionAbort.signal);
    if (options.signal) {
      if (options.signal.aborted) {
        void this.abortTurn(hostAbortReason(options.signal));
      } else {
        options.signal.addEventListener(
          "abort",
          () => void this.abortTurn(hostAbortReason(options.signal!)),
          { once: true },
        );
      }
    }
  }

  get id(): string {
    return this.options.sessionId;
  }

  get manifest(): SessionManifest {
    return this.options.manifest;
  }

  /** The adapted prime loop, exposed for tests and seams. */
  get agent(): Agent {
    return this.agentLoop;
  }

  /** Session-scoped kernel exec host; boots only on first kernel use. */
  get kernelHost(): PrimeKernelHost {
    return this.kernelHostValue;
  }

  /** The active turn's bridge when a turn is open, else the session-long idle bridge. */
  get kernelBridge(): KernelToolBridge {
    return this.activeKernelBridge ?? this.idleKernelBridge;
  }

  /** Sums every inference.usage payload this session journaled. */
  getUsageTotals(): Usage {
    return structuredClone(this.usageTotal) as Usage;
  }

  getActiveTurnId(): string | undefined {
    return this.turn?.turnId;
  }

  /** Resolve once the driver has emptied every queue and no turn is open. */
  waitForIdle(): Promise<void> {
    if (!this.driverBusy) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /**
   * Queue content for its own turn right after the run settles (upstream
   * steering drains before follow-ups). Each entry becomes an ordinary
   * turn.requested — the journal is the only transcript, so anything queued
   * outside a turn never happened.
   */
  steer(content: string): void {
    this.enqueue({ kind: "steer", content });
  }

  followUp(content: string): void {
    this.enqueue({ kind: "followUp", content });
  }

  prompt(content: string, images?: readonly CanonicalImageInput[]): Promise<PrimeTurnResult> {
    if (this.disposed) {
      return Promise.reject(new Error(`Prime session ${this.options.sessionId} is disposed.`));
    }
    if (this.driverBusy || this.turn) {
      const active = this.turn?.turnId;
      return Promise.reject(new Error(
        active
          ? `Turn ${active} is still active in this session. Wait for it to settle, or steer/follow-up as next turn.`
          : "A queued turn is still draining in this session. Wait for it to settle, or steer/follow-up as next turn.",
      ));
    }
    return new Promise<PrimeTurnResult>((resolve, reject) => {
      this.promptQueue.push({ kind: "prompt", content, images, resolve, reject });
      void this.drain();
    });
  }

  /**
   * Cooperative + hard, idempotent. Loop abort first, kernel jobs cancelled
   * second; the terminal record is written by the settle path, never by the
   * aborter, because an aborter racing the settle path would mint two
   * terminals for one turn.
   */
  async abortTurn(reason?: string): Promise<void> {
    const turn = this.turn;
    const text = reason ?? "The turn was cancelled by the host.";
    // A stop means stop: queued next-turn work is discarded, not deferred.
    this.dropQueued(this.steerQueue);
    this.dropQueued(this.followUpQueue);
    if (!turn) return;
    turn.cancelReason = text;
    turn.controller.abort(text);
    this.agentLoop.abort();
    for (const jobId of this.activeKernelJobs) {
      this.kernelHostValue.cancel(jobId, text);
    }
    if (this.activeKernelJobs.size > 0 && this.kernelTerminateTimer === undefined) {
      this.kernelTerminateTimer = setTimeout(() => {
        this.kernelTerminateTimer = undefined;
        if (this.activeKernelJobs.size > 0) {
          void this.kernelHostValue.terminate(text).catch(() => undefined);
        }
      }, PRIME_TERMINATE_GRACE_MS);
    }
  }

  /** Abort + kernel terminate; idempotent even when the run was already idle. */
  async dispose(reason: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.promptQueue) {
      entry.resolve({
        turnId: "disposed",
        outcome: "cancelled",
        reason,
        events: [],
      });
    }
    this.promptQueue = [];
    await this.abortTurn(reason);
    await this.waitForIdle();
    this.sessionAbort.abort(reason);
    if (this.kernelTerminateTimer !== undefined) {
      clearTimeout(this.kernelTerminateTimer);
      this.kernelTerminateTimer = undefined;
    }
    await this.kernelHostValue.terminate(reason).catch(() => undefined);
  }

  private enqueue(partial: Readonly<{ kind: QueuedTurnKind; content: string; images?: readonly CanonicalImageInput[] }>): void {
    if (this.disposed) return;
    const entry: QueuedTurnEntry = {
      ...partial,
      resolve: () => undefined,
      reject: () => undefined,
    };
    (partial.kind === "steer" ? this.steerQueue : this.followUpQueue).push(entry);
    void this.drain();
  }

  private dropQueued(queue: QueuedTurnEntry[]): void {
    queue.length = 0;
  }

  /**
   * One driver for the whole session: upstream drains steering before
   * follow-ups, and a caller's own prompt runs only when nothing is active.
   */
  private async drain(): Promise<void> {
    if (this.driverBusy) return;
    this.driverBusy = true;
    try {
      for (;;) {
        if (this.disposed) break;
        const entry = this.steerQueue.shift() ?? this.followUpQueue.shift() ?? this.promptQueue.shift();
        if (!entry) break;
        await this.runTurnEntry(entry);
      }
    } finally {
      this.driverBusy = false;
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  private async runTurnEntry(entry: QueuedTurnEntry): Promise<void> {
    try {
      const result = await this.runTurn(entry);
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    }
  }

  /*
   * One full journaled turn: open checks mirror core/agent.ts#runTurn in
   * order, the prime loop carries the streaming and tool work, and the event
   * handlers below journal the airship turn protocol as the loop emits.
   */
  private async runTurn(entry: QueuedTurnEntry): Promise<PrimeTurnResult> {
    const manifest = this.options.manifest;
    if (this.disposed) throw new Error(`Prime session ${this.options.sessionId} is disposed.`);
    await this.bootstrap();
    const session = await this.options.journal.getSession(this.options.sessionId);
    if (!session) throw new Error(`Unknown session: ${this.options.sessionId}`);
    const currentToolDigest = await sha256(
      stableStringify(this.options.registry.definitions() as unknown as JsonValue),
    );
    if (currentToolDigest !== manifest.toolManifestDigest) {
      throw new Error("The tool manifest changed. Fork the session before using a different tool set.");
    }
    const unfinishedTurn = findUnfinishedTurn(this.eventsCache);
    if (unfinishedTurn) {
      throw new Error(`Turn ${unfinishedTurn} has no durable terminal event; recover or fork the session before continuing.`);
    }
    assertContextHistoryCompatible(this.eventsCache, manifest);
    if (manifest.lineage) {
      // fork-context admission is a named remaining seam, not silently
      // dropped seed material: refuse rather than run on weakened context.
      throw new Error(
        "The prime session authority does not admit fork-context sessions yet; " +
        "fork-context admission is a named remaining seam.",
      );
    }
    const images = canonicalImageInputs(entry.images);
    if (!images) throw new TypeError("Turn images do not satisfy the canonical multimodal contract.");

    const controller = new AbortController();
    const turnId = randomUuid();
    const turn: ActiveTurn = {
      turnId,
      controller,
      step: 0,
      stepEventCount: 0,
      canonical: [],
      repeatCounts: new Map(),
      reviewDeniedIds: new Set(),
      reviewFailedIds: new Set(),
      reviewedIds: new Set(),
      callRecords: new Map(),
      execCaptures: new Map(),
    };
    this.turn = turn;
    if (this.options.signal?.aborted) {
      turn.cancelReason = hostAbortReason(this.options.signal);
      controller.abort(turn.cancelReason);
    }
    this.activeKernelBridge = this.createKernelBridge(controller.signal);

    try {
      const systemPrompt = await this.resolveSystemPrompt();
      this.agentLoop.state.systemPrompt = systemPrompt;
      this.agentLoop.state.tools = this.mapRegistryTools();

      await this.appendTurnDrafts(turn, [
        {
          type: "turn.requested",
          turnId,
          payload: {
            content: entry.content,
            ...(images.length ? { images: images as unknown as JsonValue } : {}),
          },
        },
      ]);
      await this.prepareTurnContext(turn, entry.content);

      const imageContent: ImageContent[] | undefined = images.length
        ? images.map((image) => canonicalImageToPrime(image))
        : undefined;
      await this.agentLoop.prompt(entry.content, imageContent);

      return await this.settleTurn(turn);
    } catch (error) {
      // The settle path owns terminals, but a turn that never reached the
      // loop (open checks, run failure outside the handlers) still needs one.
      return await this.settleTurn(turn, error);
    } finally {
      if (this.turn === turn) {
        this.turn = undefined;
        this.activeKernelBridge = undefined;
      }
    }
  }

  /** Read the journal byte-for-byte once, then keep the tail incremental. */
  private async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    this.eventsCache = await this.options.journal.readEvents(this.options.sessionId, 0);
    for (const event of this.eventsCache) {
      if (event.operationId) this.reservedOperationIds.add(event.operationId);
    }
  }

  /** Incremental refresh after the last sequence this session has seen. */
  private async refreshEvents(): Promise<DurableEvent[]> {
    const afterSequence = this.eventsCache.at(-1)?.sequence ?? 0;
    const fresh = await this.options.journal.readEvents(this.options.sessionId, afterSequence);
    if (fresh.length) this.eventsCache.push(...fresh);
    return this.eventsCache;
  }

  /*
   * The provider-input authority. The journal — not the loop's in-memory
   * transcript — decides what the provider sees, because only journaled
   * evidence reproduces under the audit. Runs immediately before every
   * provider request (agent-loop's single call point), which is where the
   * per-step token projection and context budget belong.
   */
  private async convertToLlm(_messages: AgentMessage[]): Promise<Message[]> {
    const turn = this.requireTurn();
    const events = await this.refreshEvents();
    const manifest = this.options.manifest;
    const canonical = materializeMessages(events as DurableEvent[], {
      allowEmbeddedContext: manifest.turnContext === undefined,
      allowSelectedContext: manifest.turnContext !== "disabled",
    });
    turn.canonical = canonical;

    if (manifest.contextPolicy) {
      const windowTokens = contextCompressionOptionsFromPolicy(manifest.contextPolicy).contextWindowTokens;
      const projectedTokens = estimateInferenceTokens({
        systemPrompt: manifest.systemPrompt,
        messages: canonical,
        tools: manifest.tools,
        bytesPerToken: DEFAULT_BYTES_PER_TOKEN,
      });
      if (turn.step === 0) turn.turnBaselineTokens = projectedTokens;
      const ceilingTokens = Math.max(
        windowTokens,
        turn.turnBaselineTokens! > windowTokens
          ? turn.turnBaselineTokens! + OVER_WINDOW_LOOP_ALLOWANCE_TOKENS
          : 0,
      );
      if (projectedTokens > ceilingTokens) {
        throw new Error(
          `This turn's accumulated tool output no longer fits the session's pinned ${windowTokens}-token ` +
          `context window (projected ${projectedTokens} tokens). History is intact in the journal; ` +
          "start a new turn so compression can run at the boundary.",
        );
      }
      turn.remainingToolOutputBytes = Math.max(0, Math.floor(
        (ceilingTokens - RESERVED_RESPONSE_TOKENS - projectedTokens) * DEFAULT_BYTES_PER_TOKEN,
      ));
    } else {
      turn.remainingToolOutputBytes = undefined;
    }
    return canonicalMessagesToPrime(canonical);
  }

  /*
   * inference.started must land after convertToLlm built the canonical list
   * and before the provider stream starts. The loop calls convertToLlm then
   * streamFn per step, so the instrumented streamFn is that exact boundary.
   */
  private createInstrumentedStreamFn(): StreamFn {
    let adapted: PrimeModelStreamFunction | undefined;
    if (this.options.transport) {
      adapted = createTransportForPrimeModel(this.options.model, this.options.transport, {
        onReceipt: this.options.onReceipt,
      });
    }
    const underlying: StreamFn = this.options.streamFn ?? adapted ?? registryStreamSimple;
    const session = this;
    const instrumented: StreamFn = Object.assign(
      async (model: Model<Api>, context: Parameters<StreamFn>[1], options?: Parameters<StreamFn>[2]) => {
        await session.prepareStepRequest();
        return underlying(model, context, options);
      },
      {
        // The adapter's receipt out-channel survives instrumentation so the
        // turn-settle path can finalize the provider receipt it chains.
        getLastReceipt: () => adapted?.getLastReceipt(),
      },
    );
    return instrumented;
  }

  private async prepareStepRequest(): Promise<void> {
    const turn = this.requireTurn();
    const manifest = this.options.manifest;
    if (turn.step >= this.maxStepsLimit) {
      // Thrown before any draft for this step exists, exactly where
      // core/agent.ts's step loop falls off its end.
      throw new Error(`Agent exceeded the ${this.maxStepsLimit}-step turn limit.`);
    }
    const requestId = randomUuid();
    if (this.reservedOperationIds.has(requestId)) {
      throw new Error("Generated inference operation ID was already used.");
    }
    this.reservedOperationIds.add(requestId);
    const idempotencyKey = `${this.options.sessionId}:${turn.turnId}:${turn.step}`;
    const requestDigest = await sha256(
      stableStringify({
        model: manifest.model,
        systemPromptDigest: manifest.systemPromptDigest,
        messages: turn.canonical,
        tools: manifest.tools,
        idempotencyKey,
      } as unknown as JsonValue),
    );
    await this.appendTurnDrafts(turn, [
      {
        type: "inference.started",
        turnId: turn.turnId,
        operationId: requestId,
        payload: {
          step: turn.step,
          providerId: manifest.providerId,
          model: manifest.model,
          posture: this.inferencePosture(),
          requestDigest,
          idempotencyKey,
        },
      },
    ]);
    turn.requestId = requestId;
    turn.requestDigest = requestDigest;
    turn.stepEventCount = 0;
    turn.step += 1;
    this.notifySignal({ type: "status", turnId: turn.turnId, status: "thinking" });
  }

  private inferencePosture(): NonNullable<SessionManifest["securityPosture"]> {
    // Name what we can prove: an adapted transport's own posture, else the
    // posture the manifest pinned, else "local" — the only value that never
    // claims remote evidence the runtime cannot see.
    return this.options.transport?.posture ?? this.options.manifest.securityPosture ?? "local";
  }

  private async resolveSystemPrompt(): Promise<string> {
    if (this.options.getSystemPrompt) return await this.options.getSystemPrompt();
    const manifest = this.options.manifest;
    if ((await sha256(manifest.systemPrompt)) !== manifest.systemPromptDigest) {
      throw new Error(
        "The session manifest system prompt does not match its pinned digest; the manifest was tampered with.",
      );
    }
    if (this.lastPromptSystemPrompt !== undefined) return this.lastPromptSystemPrompt;
    this.lastPromptSystemPrompt = manifest.systemPrompt;
    return this.lastPromptSystemPrompt;
  }

  private async prepareTurnContext(turn: ActiveTurn, content: string): Promise<void> {
    const provider = this.options.registry.getTurnContextProvider();
    const manifest = this.options.manifest;
    const mode = manifest.turnContext ?? "disabled";
    if (mode === "disabled") return;
    if (!provider) {
      throw new Error("This session requires turn-context retrieval, but no provider is attached.");
    }
    const query = canonicalTurnContextQuery(content);
    if (!query) return;
    const selected = await provider.selectForTurn(query, {
      sessionId: this.options.sessionId,
      signal: turn.controller.signal,
    });
    const canonical = canonicalContextSelection(selected);
    if (!canonical) throw new Error("The turn-context provider returned a non-canonical selection.");
    if (!await verifyContextSelection(canonical)) {
      throw new Error("The turn-context provider returned a selection whose commitments did not verify.");
    }
    if (!await verifyContextSelectionQuery(canonical, query)) {
      throw new Error("The turn-context provider returned a selection for a different canonical query.");
    }
    if (!contextSelectionScopeMatches(canonical, this.options.sessionId, manifest)) {
      throw new Error("The turn-context provider returned lineage outside this session's pinned scope.");
    }
    await this.appendTurnDrafts(turn, [
      {
        type: "turn.context.selected",
        turnId: turn.turnId,
        payload: { contextSelection: canonical as unknown as JsonValue },
      },
    ]);
  }

  /** Every registry definition becomes a prime tool whose execute is the airship ticket path. */
  private mapRegistryTools(): AgentTool[] {
    const session = this;
    return this.options.registry.definitions().map((definition) => ({
      label: definition.name,
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema as JsonSchema,
      async execute(toolCallId: string, args: unknown, signal?: AbortSignal) {
        const turn = session.turn;
        if (!turn) throw new Error("No active turn for tool execution.");
        const context: ToolContext = {
          sessionId: session.options.sessionId,
          turnId: turn.turnId,
          operationId: toolCallId,
          signal: signal ?? turn.controller.signal,
          capabilityTier: session.options.manifest.capabilityTier,
          onOutput(chunk) {
            session.notifySignal({ type: "tool-output", turnId: turn.turnId, operationId: toolCallId, ...chunk });
          },
        };
        try {
          const execution = await session.options.registry.executeApproved(
            definition.name,
            args as JsonValue,
            context,
          );
          turn.execCaptures.set(toolCallId, {
            kind: "result",
            isError: execution.isError ?? false,
            metadata: execution.metadata,
          });
          return {
            content: [{ type: "text" as const, text: execution.content }],
            details: {},
          };
        } catch (error) {
          turn.execCaptures.set(toolCallId, { kind: "failed", message: errorMessage(error) });
          throw error;
        }
      },
    } as AgentTool));
  }

  /*
   * The review gate, mirroring core/agent.ts phase 1 exactly: strict call
   * order (sequential execution guarantees it), one registry.review at a
   * time, provenance captured immediately after the decision, guardrail note
   * appended after provenance capture. A block reason carries the exact
   * content the journal's tool message carries, so the in-loop transcript
   * and the journal never disagree about what the model was told.
   */
  private async beforeToolCall(
    hookContext: Readonly<{ toolCall: { id: string; name: string; arguments: Record<string, unknown> } }>,
    signal: AbortSignal | undefined,
  ): Promise<{ block: boolean; reason: string } | undefined> {
    const turn = this.requireTurn();
    const call: ToolCall = {
      id: hookContext.toolCall.id,
      name: hookContext.toolCall.name,
      arguments: hookContext.toolCall.arguments as JsonValue,
    };
    turn.reviewedIds.add(call.id);
    turn.callRecords.set(call.id, { name: call.name, arguments: call.arguments });
    const context: ToolContext = {
      sessionId: this.options.sessionId,
      turnId: turn.turnId,
      operationId: call.id,
      signal: signal ?? turn.controller.signal,
      capabilityTier: this.options.manifest.capabilityTier,
      onOutput: (chunk) => {
        this.notifySignal({ type: "tool-output", turnId: turn.turnId, operationId: call.id, ...chunk });
      },
    };
    let decision: "allow" | "deny";
    try {
      decision = await this.options.registry.review(call.name, call.arguments, context, this.options.approvalPolicy);
    } catch (error) {
      const content = `${errorMessage(error)}${await this.noteFailedOutcome(turn, call)}`;
      turn.reviewFailedIds.add(call.id);
      await this.appendTurnDrafts(turn, [
        {
          type: "tool.failed",
          turnId: turn.turnId,
          operationId: call.id,
          payload: { callId: call.id, name: call.name, content },
        },
      ]);
      return { block: true, reason: content };
    }
    const provenance = approvalProvenance(this.options.approvalPolicy, context);
    if (decision === "deny") {
      const content = `Permission denied for ${call.name}.${await this.noteFailedOutcome(turn, call)}`;
      turn.reviewDeniedIds.add(call.id);
      await this.appendTurnDrafts(turn, [
        {
          type: "tool.denied",
          turnId: turn.turnId,
          operationId: call.id,
          payload: { callId: call.id, name: call.name, content, approval: provenance ?? null },
        },
      ]);
      return { block: true, reason: content };
    }
    await this.appendTurnDrafts(turn, [
      {
        type: "tool.approved",
        turnId: turn.turnId,
        operationId: call.id,
        payload: { callId: call.id, name: call.name, approval: provenance ?? null },
      },
    ]);
    this.notifySignal({ type: "status", turnId: turn.turnId, status: `running ${call.name}` });
    return undefined;
  }

  /*
   * Airship's ToolExecutionResult carries an isError flag the prime
   * AgentToolResult cannot, so executeApproved's outcome is captured at
   * execution and hoisted back through this hook — otherwise every errored
   * tool result would journal as isError:false and the transcript would lie.
   */
  private afterToolCall(
    hookContext: Readonly<{ toolCall: { id: string } }>,
  ): { isError: boolean } | undefined {
    const capture = this.turn?.execCaptures.get(hookContext.toolCall.id);
    if (!capture) return undefined;
    return { isError: capture.kind === "failed" ? true : capture.isError };
  }

  /*
   * Mirror of core/agent.ts noteFailedOutcome, keyed identically on
   * `(name.length:name)|argumentsDigest|error`; only error outcomes count.
   * The warning rides inside the tool message content because that is the
   * only channel the model reads.
   */
  private async noteFailedOutcome(turn: ActiveTurn, call: Readonly<{ name: string; arguments: JsonValue }>): Promise<string> {
    const digest = await toolArgumentsDigest(call.arguments);
    const key = `${call.name.length}:${call.name}|${digest}|error`;
    const count = (turn.repeatCounts.get(key) ?? 0) + 1;
    turn.repeatCounts.set(key, count);
    if (count >= REPEATED_FAILURE_STOP_AT) {
      turn.guardrailStop = `${call.name} failed ${count} times in this turn with identical arguments. `
        + "The turn was stopped instead of spending its remaining steps on a call that is not going to "
        + "start succeeding; change the arguments or the approach and send it again.";
      return "";
    }
    if (count < REPEATED_FAILURE_WARN_AT) return "";
    return `\n\n[Airship guardrail: ${call.name} has now failed ${count} times in this turn with identical `
      + "arguments, so repeating it unchanged will fail again. Change the arguments, use a different tool, "
      + `or tell the person what is blocking you. This turn stops at ${REPEATED_FAILURE_STOP_AT} identical failures.]`;
  }

  private requireTurn(): ActiveTurn {
    if (!this.turn) throw new Error("The prime session has no active turn.");
    return this.turn;
  }

  private async onAgentEvent(event: AgentEvent): Promise<void> {
    const turn = this.turn;
    if (!turn || this.disposed) return;
    switch (event.type) {
      case "message_update": {
        turn.stepEventCount += 1;
        if (turn.stepEventCount > PRIME_MAX_STEP_EVENTS) {
          throw new Error(`Provider exceeded the ${PRIME_MAX_STEP_EVENTS}-event inference step limit.`);
        }
        const sub = event.assistantMessageEvent;
        if (sub.type === "text_delta") {
          this.notifySignal({ type: "text-delta", turnId: turn.turnId, text: sub.delta });
        } else if (sub.type === "thinking_start" || sub.type === "thinking_delta") {
          this.notifySignal({ type: "status", turnId: turn.turnId, status: "reasoning" });
        }
        return;
      }
      case "tool_execution_start": {
        this.notifySignal({ type: "status", turnId: turn.turnId, status: `running ${event.toolName}` });
        return;
      }
      case "message_end": {
        await this.onMessageEnd(turn, event.message);
        return;
      }
      case "agent_end": {
        await this.onAgentEnd(turn);
        return;
      }
      default:
        return;
    }
  }

  private async onMessageEnd(turn: ActiveTurn, message: AgentMessage): Promise<void> {
    if (message.role === "assistant") {
      await this.onAssistantEnd(turn, message);
      return;
    }
    if (message.role === "toolResult") {
      await this.onToolResultEnd(turn, message);
    }
  }

  private async onAssistantEnd(turn: ActiveTurn, assistant: AssistantMessage): Promise<void> {
    const text = flattenAssistantText(assistant);
    if (
      assistant.stopReason === "toolUse" ||
      ((assistant.stopReason === "stop" || assistant.stopReason === "length") && !assistant.errorMessage)
    ) {
      const responseBytes = new TextEncoder().encode(text).byteLength;
      if (responseBytes > PRIME_MAX_ASSISTANT_BYTES) {
        throw new Error(`Provider response exceeded the ${PRIME_MAX_ASSISTANT_BYTES}-byte turn limit.`);
      }
      await this.journalStepUsage(turn, assistant);
    }

    if (assistant.stopReason === "toolUse") {
      await this.journalToolBatch(turn, assistant, text);
      return;
    }

    if (assistant.stopReason === "stop" || assistant.stopReason === "length") {
      if (assistant.errorMessage) {
        turn.terminalError = assistant.errorMessage;
        return;
      }
      await this.completeAssistantTurn(turn, assistant, text);
      return;
    }

    if (assistant.stopReason === "aborted") {
      // Terminal arrives at agent_end: one terminal per turn, written once.
      if (!turn.cancelReason) turn.cancelReason = assistant.errorMessage ?? "Request was aborted";
      return;
    }

    // stopReason "error": recorded, journaled at agent_end.
    turn.terminalError = assistant.errorMessage ?? "The turn failed.";
  }

  private async journalStepUsage(turn: ActiveTurn, assistant: AssistantMessage): Promise<void> {
    const usage = assistant.usage;
    /*
     * The airship payload is the transport's usage JSON; the prime Usage the
     * stream reports names the same money differently. Both names are
     * journaled — the audit's canonical token fields come from the
     * transport vocabulary, the prime fields keep cache accounting — and the
     * zeros-only usage of a provider that reported nothing is not journaled
     * at all (usage is provider-reported, never synthesized).
     */
    if (!usage || usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return;
    this.usageTotal = accumulateUsage(this.usageTotal, usage);
    await this.appendTurnDrafts(turn, [
      {
        type: "inference.usage",
        turnId: turn.turnId,
        operationId: turn.requestId,
        payload: {
          type: "usage",
          providerId: this.options.manifest.providerId,
          model: this.options.manifest.model,
          inputTokens: usage.input,
          outputTokens: usage.output,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        },
      },
    ]);
  }

  private async journalToolBatch(turn: ActiveTurn, assistant: AssistantMessage, text: string): Promise<void> {
    const calls = assistant.content.filter((block): block is Extract<typeof block, { type: "toolCall" }> =>
      block.type === "toolCall",
    );
    if (calls.length > PRIME_MAX_TOOL_CALLS_PER_STEP) {
      throw new Error(`Provider exceeded the ${PRIME_MAX_TOOL_CALLS_PER_STEP}-tool-call step limit.`);
    }
    // Validation raises before the batch is drafted anywhere, exactly like
    // core/agent.ts reserveToolCallBatch: malformed identity never reaches
    // the journal.
    const batch = new Set<string>();
    for (const call of calls) {
      if (
        typeof call.id !== "string" ||
        call.id.length === 0 ||
        call.id.length > MAX_OPERATION_ID_CHARS ||
        UNSAFE_OPERATION_ID.test(call.id)
      ) {
        throw new Error("Provider emitted an invalid tool-call operation ID.");
      }
      if (this.reservedOperationIds.has(call.id) || batch.has(call.id)) {
        throw new Error("Provider emitted a duplicate or reused tool-call operation ID.");
      }
      batch.add(call.id);
      this.reservedOperationIds.add(call.id);
      turn.callRecords.set(call.id, { name: call.name, arguments: call.arguments as JsonValue });
    }
    const assistantMessage: CanonicalMessage = {
      role: "assistant",
      content: text,
      toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments as JsonValue })),
    };
    const drafts: EventDraft[] = [
      {
        type: "assistant.completed",
        turnId: turn.turnId,
        operationId: turn.requestId,
        payload: { message: assistantMessage as unknown as JsonValue, finishReason: "tool-calls" },
      },
      ...calls.map((call): EventDraft => ({
        type: "tool.requested",
        turnId: turn.turnId,
        operationId: call.id,
        payload: {
          call: { id: call.id, name: call.name, arguments: call.arguments as JsonValue } as unknown as JsonValue,
        },
      })),
    ];
    await this.appendTurnDrafts(turn, drafts);
  }

  private async onToolResultEnd(turn: ActiveTurn, message: ToolResultMessage): Promise<void> {
    const operationId = message.toolCallId;
    // Denied and review-failed calls were journaled at the review; the loop's
    // synthesized blocked-result must not double the record.
    if (turn.reviewDeniedIds.has(operationId) || turn.reviewFailedIds.has(operationId)) return;
    if (!turn.reviewedIds.has(operationId)) {
      /*
       * beforeToolCall never ran: only an unregistered tool reaches this
       * branch (the loop answered it immediately). core/agent.ts denies
       * unknown tools at review with the canonical denial sentence; mirror
       * that record instead of inventing a parallel "not found" transcript.
       */
      const content = `Permission denied for ${message.toolName}.`;
      turn.reviewDeniedIds.add(operationId);
      await this.appendTurnDrafts(turn, [
        {
          type: "tool.denied",
          turnId: turn.turnId,
          operationId,
          payload: { callId: operationId, name: message.toolName, content, approval: null },
        },
      ]);
      return;
    }
    const capture = turn.execCaptures.get(operationId);
    const call = turn.callRecords.get(operationId) ?? { name: message.toolName, arguments: {} };
    if (capture?.kind === "failed") {
      const content = `${capture.message}${await this.noteFailedOutcome(turn, call)}`;
      await this.appendTurnDrafts(turn, [
        {
          type: "tool.failed",
          turnId: turn.turnId,
          operationId,
          payload: { callId: operationId, name: message.toolName, content },
        },
      ]);
      return;
    }
    const contentText = capture?.kind === "result"
      ? message.content.filter((block) => block.type === "text").map((block) => block.text).join("")
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    const bounded = boundToolResultContent(contentText, turn.remainingToolOutputBytes);
    const isError = capture?.kind === "result" ? capture.isError : message.isError;
    const guidance = isError ? await this.noteFailedOutcome(turn, call) : "";
    if (turn.remainingToolOutputBytes !== undefined) {
      turn.remainingToolOutputBytes = Math.max(
        0,
        turn.remainingToolOutputBytes - bounded.retainedBytes - new TextEncoder().encode(guidance).byteLength,
      );
    }
    const metadata = capture?.kind === "result" ? capture.metadata : undefined;
    await this.appendTurnDrafts(turn, [
      {
        type: "tool.resulted",
        turnId: turn.turnId,
        operationId,
        payload: {
          callId: operationId,
          name: message.toolName,
          content: `${bounded.content}${guidance}`,
          isError,
          metadata: bounded.truncated
            ? {
              ...(plainRecord(metadata) ?? {}),
              contextBudgetTruncated: true,
              originalContentBytes: bounded.originalBytes,
              retainedContentBytes: bounded.retainedBytes,
            }
            : metadata ?? null,
        },
      },
    ]);
  }

  private async completeAssistantTurn(turn: ActiveTurn, _assistant: AssistantMessage, text: string): Promise<void> {
    const manifest = this.options.manifest;
    const responseDigest = await sha256(text);
    const requestDigest = turn.requestDigest ?? "";
    /*
     * The receipt chains to the digest of the request that produced the
     * final answer — the current step's inference.started. The audit's
     * RECEIPT_BINDING_MISMATCH check reproduces this rule exactly.
     */
    const providerReceipt = (this.agentLoop.streamFn as unknown as { getLastReceipt?: () => ConversationReceipt | undefined })
      .getLastReceipt?.();
    const receipt = providerReceipt
      ? finalizeProviderReceipt(providerReceipt, manifest.providerId, requestDigest, responseDigest)
      : createLocalReceipt({
        sessionId: this.options.sessionId,
        turnId: turn.turnId,
        provider: manifest.providerId,
        model: manifest.model,
        requestDigest,
        responseDigest,
      });
    const assistantMessage: CanonicalMessage = { role: "assistant", content: text };
    await this.appendTurnDrafts(turn, [
      {
        type: "assistant.completed",
        turnId: turn.turnId,
        operationId: turn.requestId,
        payload: {
          message: assistantMessage as unknown as JsonValue,
          finishReason: "stop",
          responseDigest,
          receipt: receipt as unknown as JsonValue,
        },
      },
      {
        type: "turn.completed",
        turnId: turn.turnId,
        payload: { responseDigest, receiptId: receipt.receiptId },
      },
    ]);
    turn.finalAssistantText = text;
    turn.finalReceipt = receipt;
    turn.terminalKind = "completed";
    this.notifySignal({ type: "status", turnId: turn.turnId, status: "complete" });
  }

  /*
   * agent_end is the run's last event: exactly one terminal lands here for
   * paths the assistant handlers did not already close (error, abort,
   * guardrail stop). Signal-neutral: cancellation must not block the audit.
   */
  private async onAgentEnd(turn: ActiveTurn): Promise<void> {
    if (turn.terminalKind) return;
    if (turn.cancelReason !== undefined) {
      turn.terminalKind = "cancelled";
      await this.appendTerminal(turn, [
        {
          type: "turn.cancelled",
          turnId: turn.turnId,
          payload: { error: turn.cancelReason },
        },
      ]);
      return;
    }
    turn.terminalKind = "failed";
    turn.terminalError = turn.guardrailStop ?? turn.terminalError ?? "The turn failed.";
    await this.appendTerminal(turn, [
      {
        type: "turn.failed",
        turnId: turn.turnId,
        payload: { error: turn.terminalError },
      },
    ]);
  }

  /*
   * Settle a turn however it ended: the journal is re-read (a handler error
   * or a swallowed listener throw can leave the terminal unwritten), and a
   * turn with no terminal gets turn.failed before the result is built, so a
   * run never ends without exactly one durable terminal event.
   */
  private async settleTurn(turn: ActiveTurn, runError?: unknown): Promise<PrimeTurnResult> {
    const events = await this.refreshEvents();
    const terminals = events.filter((event) =>
      event.turnId === turn.turnId &&
      (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled")
    );
    let terminal: DurableEvent | undefined = terminals[0];
    if (!terminal) {
      const errorText = turn.terminalError
        ?? turn.cancelReason
        ?? (runError !== undefined ? errorMessage(runError) : "The turn ended before a durable terminal event could be recorded.");
      const cancelled = turn.cancelReason !== undefined;
      turn.terminalKind = cancelled ? "cancelled" : "failed";
      await this.appendTerminal(turn, [
        {
          type: cancelled ? "turn.cancelled" : "turn.failed",
          turnId: turn.turnId,
          payload: { error: errorText },
        },
      ]);
      const fresh = await this.refreshEvents();
      terminal = fresh.filter((event) =>
        event.turnId === turn.turnId &&
        (event.type === "turn.failed" || event.type === "turn.cancelled")
      ).at(-1);
    }
    const eventsNow = await this.refreshEvents();
    const payload = (terminal?.payload ?? undefined) as { error?: string } | undefined;
    if (turn.terminalKind === "completed") {
      return {
        turnId: turn.turnId,
        outcome: "completed",
        text: turn.finalAssistantText ?? "",
        receipt: turn.finalReceipt,
        events: eventsNow,
      };
    }
    if (turn.terminalKind === "cancelled") {
      return {
        turnId: turn.turnId,
        outcome: "cancelled",
        reason: turn.cancelReason ?? payload?.error ?? "The turn was cancelled.",
        events: eventsNow,
      };
    }
    return {
      turnId: turn.turnId,
      outcome: "failed",
      error: turn.terminalError ?? payload?.error ?? "The turn failed.",
      events: eventsNow,
    };
  }

  /** Turn appends carry the turn's signal; if it fires mid-turn, work stops. */
  private async appendTurnDrafts(turn: ActiveTurn, drafts: EventDraft[]): Promise<DurableEvent[]> {
    const durable = await this.options.journal.append(this.options.sessionId, drafts, turn.controller.signal);
    this.eventsCache.push(...durable);
    this.notifySignal({ type: "durable", events: durable });
    return durable;
  }

  /** Terminal appends never carry a signal: cancellation cannot block the audit. */
  private async appendTerminal(turn: ActiveTurn, drafts: EventDraft[]): Promise<DurableEvent[]> {
    const durable = await this.options.journal.append(this.options.sessionId, drafts);
    this.eventsCache.push(...durable);
    this.notifySignal({ type: "durable", events: durable });
    return durable;
  }

  private notifySignal(signal: AgentSignal): void {
    try {
      this.options.onSignal?.(signal);
    } catch {
      // Observers cannot mutate or interrupt the durable turn state machine.
    }
  }

  private createKernelBridge(signal: AbortSignal): KernelToolBridge {
    const tier = this.options.manifest.capabilityTier;
    return new KernelToolBridge({
      registry: this.options.registry,
      approvalPolicy: this.options.approvalPolicy,
      journal: this.options.journal,
      sessionId: this.options.sessionId,
      turnId: () => {
        const active = this.turn?.turnId;
        if (!active) {
          throw new Error(
            "A kernel bridge call arrived with no active prime turn; there is no turn identity to journal it under.",
          );
        }
        return active;
      },
      signal,
      capabilityTier: tier === "web-baseline" || tier === "web-enhanced" ? tier : undefined,
    });
  }

  private onKernelEvent(event: KernelJobEvent): void {
    if (event.type === "started") {
      this.activeKernelJobs.add(event.jobId);
      void this.appendSideband([
        {
          type: PRIME_EVENT_TYPES.kernelJobStarted,
          turnId: this.turn?.turnId,
          payload: { jobId: event.jobId, engine: event.engine, label: event.label ?? null },
        },
      ]);
      return;
    }
    if (
      event.type === "completed" || event.type === "failed" ||
      event.type === "cancelled" || event.type === "crashed"
    ) {
      this.activeKernelJobs.delete(event.jobId);
      const drafts: EventDraft[] = [
        {
          type: kernelJobEventType(event.type),
          turnId: this.turn?.turnId,
          payload: boundedKernelJobPayload(event.result),
        },
      ];
      if (event.type === "crashed") {
        const result = event.result;
        drafts.push(
          noticeDraft(KERNEL_NOTICE_NAMESPACE_RESET, {
            jobId: result.jobId,
            outcome: result.outcome,
            error: result.error ?? null,
          }),
        );
      }
      void this.appendSideband(drafts);
    }
  }

  /** Sideband evidence must never break a turn: journal failures are dropped. */
  private async appendSideband(drafts: EventDraft[]): Promise<void> {
    if (this.disposed) return;
    try {
      const durable = await this.options.journal.append(this.options.sessionId, drafts);
      this.eventsCache.push(...durable);
      this.notifySignal({ type: "durable", events: durable });
    } catch {
      // The canonical transcript is the authority; prime.* records never block it.
    }
  }
}

export function primeZeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function accumulateUsage(total: Usage, usage: Usage): Usage {
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: {
      input: total.cost.input + usage.cost.input,
      output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total,
    },
  };
}

function flattenAssistantText(assistant: AssistantMessage): string {
  return assistant.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function canonicalImageToPrime(image: CanonicalImageInput): ImageContent {
  const prefix = `data:${image.mediaType};base64,`;
  return { type: "image", data: image.dataUrl.slice(prefix.length), mimeType: image.mediaType };
}

/*
 * Canonical → prime message projection for the provider path. What cannot
 * round trip is named, not faked: canonical history carries no assistant
 * usage or api/provider stamping (the zero usage and session bindings here
 * are placeholders that never reach the wire), no tool-result isError flag
 * (canonical tool messages carry content only), and no assistant thinking
 * blocks (airship's transcript has no reasoning either, so they drop exactly
 * where materializeMessages drops them). Tool names are recovered from the
 * assistant message that declared the call.
 */
function canonicalMessagesToPrime(messages: readonly CanonicalMessage[]): Message[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) toolNames.set(call.id, call.name);
    }
  }
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const images = (message.images ?? []).map(canonicalImageToPrime);
      out.push({
        role: "user",
        content: images.length
          ? [{ type: "text", text: message.content }, ...images]
          : message.content,
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: (call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
            ? call.arguments
            : {}) as Record<string, unknown>,
        });
      }
      out.push({
        role: "assistant",
        content,
        api: "unknown",
        provider: "unknown",
        model: "unknown",
        usage: primeZeroUsage(),
        stopReason: message.toolCalls?.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
      continue;
    }
    out.push({
      role: "toolResult",
      toolCallId: message.toolCallId ?? "",
      toolName: toolNames.get(message.toolCallId ?? "") ?? "unknown",
      content: [{ type: "text", text: message.content }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  return out;
}

function kernelJobEventType(outcome: "completed" | "failed" | "cancelled" | "crashed"): string {
  switch (outcome) {
    case "completed": return PRIME_EVENT_TYPES.kernelJobCompleted;
    case "failed": return PRIME_EVENT_TYPES.kernelJobFailed;
    case "cancelled": return PRIME_EVENT_TYPES.kernelJobCancelled;
    case "crashed": return PRIME_EVENT_TYPES.kernelJobCrashed;
  }
}

const MAX_KERNEL_VALUE_CHARS = 64 * 1_024;
const MAX_KERNEL_STREAM_CHARS = 256 * 1_024;

function boundedKernelJobPayload(result: KernelJobResult): JsonValue {
  const valueJson = result.valueJson;
  const boundedValue = valueJson !== undefined && valueJson.length > MAX_KERNEL_VALUE_CHARS
    ? `${valueJson.slice(0, MAX_KERNEL_VALUE_CHARS)}[prime truncated: ${valueJson.length} chars total]`
    : valueJson;
  const stdout = result.stdout.length > MAX_KERNEL_STREAM_CHARS
    ? `${result.stdout.slice(0, MAX_KERNEL_STREAM_CHARS)}[prime truncated: ${result.stdout.length} chars total]`
    : result.stdout;
  const stderr = result.stderr.length > MAX_KERNEL_STREAM_CHARS
    ? `${result.stderr.slice(0, MAX_KERNEL_STREAM_CHARS)}[prime truncated: ${result.stderr.length} chars total]`
    : result.stderr;
  return {
    jobId: result.jobId,
    engine: result.engine,
    outcome: result.outcome,
    wallMs: result.wallMs,
    bridgeCalls: result.bridgeCalls,
    error: result.error ?? null,
    valueJson: boundedValue ?? null,
    stdout,
    stderr,
  } as unknown as JsonValue;
}

/** Mirror of core/agent.ts findUnfinishedProviderTurn on the cached history. */
function findUnfinishedTurn(events: readonly DurableEvent[]): string | undefined {
  let active: string | undefined;
  for (const event of events) {
    if (event.type === "turn.requested" && event.turnId) active = event.turnId;
    if (active && event.turnId === active &&
      (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled")) {
      active = undefined;
    }
  }
  return active;
}

/** Mirror of core/agent.ts assertContextHistoryCompatible. */
function assertContextHistoryCompatible(events: readonly DurableEvent[], manifest: SessionManifest): void {
  if (manifest.turnContext !== undefined && events.some((event) =>
    event.type === "turn.requested" &&
    (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, JsonValue>).contextSelection !== undefined
      : false)
  )) {
    throw new Error("This explicitly pinned session contains legacy request-embedded turn context.");
  }
  if (manifest.turnContext === "disabled" && events.some((event) => event.type === "turn.context.selected")) {
    throw new Error("This session disables turn-context retrieval but its history contains a selection event.");
  }
}

function plainRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostAbortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : "The host aborted this session.";
}
