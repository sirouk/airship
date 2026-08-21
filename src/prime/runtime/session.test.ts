/**
 * Prime session authority tests: the spec's eight named cases, run against
 * the real ported Agent/loop with the scripted faux provider, the airship
 * MemoryJournalBackend, and a real ToolRegistry, so every assertion reads
 * the same journal the session audit would read.
 */

import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "../ai/stream";
import { createAssistantMessageEventStream } from "../ai/event-stream";
import type { AssistantMessage, Model, Usage } from "../ai/types";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "../ai/faux.test-support";
import { materializeMessages } from "../../core/agent";
import type {
  ApprovalPolicy,
  InferenceRequest,
  InferenceTransport,
  JsonValue,
  SessionContextPolicy,
  SessionManifest,
  Tool,
  ToolContext,
  ToolExecutionResult,
} from "../../core/contracts";
import type { ConversationReceipt } from "../../core/conversation-receipt";
import { createSessionContextPolicy } from "../../core/context-policy";
import { sha256, stableStringify } from "../../core/hash";
import { EventJournal } from "../../core/journal";
import type { DurableEvent } from "../../core/journal";
import { createSessionManifest } from "../../core/session-manifest";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { auditSessionHistory } from "../../core/session-audit";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import { PrimeKernelHost } from "../kernel/kernel-host";
import { KernelToolBridge } from "../kernel/tool-bridge";
import type { KernelWorkerLike } from "../kernel/kernel-host";
import { createPrimeExecuteCodeTool } from "../tools/kernel-tool";
import { PrimeAgentSession } from "./session";
import type { PrimeSessionOptions } from "./session";
import { PRIME_EVENT_TYPES } from "./prime-events";

const SYSTEM_PROMPT = "You are a test assistant.";
const WORKSPACE_ID = "ws-prime-test";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  while (registrations.length > 0) registrations.pop()?.unregister();
});

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function makeStubTool(
  name: string,
  effect: "read" | "write",
  execute: (args: JsonValue, context: ToolContext) => Promise<ToolExecutionResult>,
): Tool {
  return {
    definition: {
      name,
      description: `Test stub tool ${name}.`,
      effect,
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        additionalProperties: true,
      },
    },
    execute,
  };
}

type SessionFixture = Readonly<{
  registration: FauxProviderRegistration;
  model: Model<string>;
  journal: EventJournal;
  registry: ToolRegistry;
  sessionId: string;
  manifest: SessionManifest;
}>;

async function makeFixture(options: Readonly<{
  tools?: Tool[];
  contextPolicy?: SessionContextPolicy;
  faux?: Parameters<typeof registerFauxProvider>[0];
}> = {}): Promise<SessionFixture> {
  const registration = registerFauxProvider(options.faux ?? {});
  registrations.push(registration);
  const journal = new EventJournal(new MemoryJournalBackend());
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);
  const model = registration.getModel();
  if (!model) throw new Error("faux registration has no model");
  const manifest = await createSessionManifest({
    systemPrompt: SYSTEM_PROMPT,
    providerId: "faux",
    model: model.id,
    tools: registry.definitions(),
    workspaceId: WORKSPACE_ID,
    securityPosture: "local",
    ...(options.contextPolicy ? { contextPolicy: options.contextPolicy } : {}),
  });
  const record = await journal.createSession("prime session authority test", manifest);
  return { registration, model, journal, registry, sessionId: record.id, manifest };
}

function makeSession(
  fixture: SessionFixture,
  options: Partial<PrimeSessionOptions> = {},
): PrimeAgentSession {
  return new PrimeAgentSession({
    sessionId: fixture.sessionId,
    manifest: fixture.manifest,
    journal: fixture.journal,
    registry: fixture.registry,
    approvalPolicy: allowAllForTests,
    model: fixture.model,
    ...(options.transport || options.streamFn ? {} : { streamFn: streamSimple }),
    ...options,
  });
}

function eventsOfType(events: readonly DurableEvent[], type: string): DurableEvent[] {
  return events.filter((event) => event.type === type);
}

function payloadRecord(event: DurableEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

/** Scripted kernel worker: answers one tool bridge call per job, then finishes. */
type ScriptedKernelWorker = KernelWorkerLike & {
  emit(message: unknown): void;
};

function makeKernelBridgeWorker(bridgeTool = "echo_stub"): { worker: ScriptedKernelWorker } {
  const listeners = {
    message: [] as ((event: { data?: unknown }) => void)[],
    error: [] as ((event: { message?: string }) => void)[],
  };
  let readyAnnounced = false;
  const worker: ScriptedKernelWorker = {
    emit(message: unknown) {
      for (const listener of listeners.message) listener({ data: message });
    },
    postMessage(message: unknown) {
      const data = message as {
        type?: string;
        job?: { jobId: string; code: string; label?: string };
      };
      if (data.type === "exec" && data.job) {
        worker.emit({
          type: "bridge-request",
          jobId: data.job.jobId,
          call: { jobId: data.job.jobId, seq: 0, tool: bridgeTool, arguments: {} },
        });
        return;
      }
      if (data.type === "bridge-response") {
        const jobId = (message as { jobId: string }).jobId;
        worker.emit({
          type: "finished",
          jobId,
          result: {
            jobId,
            engine: "javascript",
            outcome: "completed",
            stdout: "",
            stderr: "",
            bridgeCalls: 1,
            wallMs: 1,
          },
        });
      }
    },
    terminate() {
      // Scripted workers do not hold resources.
    },
    addEventListener(type: string, listener: (event: never) => void) {
      if (type === "message") {
        listeners.message.push(listener as (event: { data?: unknown }) => void);
        // The host waits for exactly one ready handshake after boot.
        if (!readyAnnounced) {
          readyAnnounced = true;
          queueMicrotask(() => worker.emit({ type: "ready", engine: "javascript" }));
        }
      }
      if (type === "error") listeners.error.push(listener as (event: { message?: string }) => void);
    },
    removeEventListener(type: string, listener: (event: never) => void) {
      const bucket = type === "message" ? listeners.message : listeners.error;
      const index = bucket.indexOf(listener as never);
      if (index >= 0) bucket.splice(index, 1);
    },
  };
  return { worker };
}

describe("PrimeAgentSession", () => {
  it("refuses a forged attached manifest before writing Prime custody", async () => {
    const fixture = await makeFixture();
    const forged = {
      ...fixture.manifest,
      systemPrompt: "forged prompt",
    };
    const session = makeSession(fixture, { manifest: forged });
    const before = await fixture.journal.readEvents(fixture.sessionId);

    await expect(session.prompt("must not write")).rejects.toThrow(/differs from the durable session authority/u);
    expect(await fixture.journal.readEvents(fixture.sessionId)).toEqual(before);
    expect(before.some((event) => event.type.startsWith("prime."))).toBe(false);
  });

  it("t1: reproduces core/agent.ts requestDigests from journal replay for every step", async () => {
    const lookup = makeStubTool("lookup", "read", async () => ({ content: "lookup says hi" }));
    const fixture = await makeFixture({ tools: [lookup] });
    fixture.registration.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("lookup", { query: "q" }, { id: "call-1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("final answer"),
    ]);
    const session = makeSession(fixture);
    const result = await session.prompt("call the tool then answer");
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completion");

    const started = eventsOfType(result.events, "inference.started");
    expect(started).toHaveLength(2);
    for (const [step, event] of started.entries()) {
      const payload = payloadRecord(event);
      expect(payload.providerId).toBe(fixture.manifest.providerId);
      expect(payload.model).toBe(fixture.manifest.model);
      expect(payload.step).toBe(step);
      expect(payload.posture).toBe("local");
      expect(payload.idempotencyKey).toBe(`${fixture.sessionId}:${result.turnId}:${step}`);
      /*
       * Byte parity: recreate the digest from the journal replay exactly the
       * way core/agent.ts builds it (protocol-v2 disabled-context options),
       * so the check fails on any drift in journal→LLM materialization.
       */
      const prior = result.events.filter((candidate) => candidate.sequence < event.sequence);
      const messages = materializeMessages(prior, {
        allowEmbeddedContext: false,
        allowSelectedContext: false,
      });
      const expected = await sha256(
        stableStringify({
          model: fixture.manifest.model,
          systemPromptDigest: fixture.manifest.systemPromptDigest,
          messages,
          tools: fixture.manifest.tools,
          idempotencyKey: payload.idempotencyKey,
        } as unknown as JsonValue),
      );
      expect(payload.requestDigest).toBe(expected);
    }
    const priorToSecond = result.events.filter((event) => event.sequence < started[1]!.sequence);
    const replayed = materializeMessages(priorToSecond, {
      allowEmbeddedContext: false,
      allowSelectedContext: false,
    });
    expect(replayed.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);

    const finalized = eventsOfType(result.events, "turn.completed");
    expect(finalized).toHaveLength(1);
    expect(payloadRecord(finalized[0]!).receiptId).toBe(result.receipt!.receiptId);
  });

  it("records the trace receipt on the final assistant event and passes session audit", async () => {
    const fixture = await makeFixture();
    fixture.registration.setResponses([fauxAssistantMessage("audited answer")]);
    const session = makeSession(fixture);
    const result = await session.prompt("answer and seal it");
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completion");

    const assistantCompleted = eventsOfType(result.events, "assistant.completed");
    expect(assistantCompleted).toHaveLength(1);
    const assistantPayload = payloadRecord(assistantCompleted[0]!);
    expect(assistantPayload.receipt).toEqual(result.receipt);
    expect((assistantPayload.receipt as Record<string, unknown>).requestDigest).toBe(result.receipt!.requestDigest);
    expect((assistantPayload.receipt as Record<string, unknown>).responseDigest).toBe(result.receipt!.responseDigest);

    const sessionRecord = (await fixture.journal.getSession(fixture.sessionId))!;
    const report = await auditSessionHistory(
      { session: sessionRecord, events: result.events },
      {
        checkedAt: "2026-08-20T00:00:00.000Z",
        trustedHead: {
          sequence: sessionRecord.headSequence,
          digest: sessionRecord.headDigest,
          source: "prime session authority test",
        },
      },
    );
    expect(report.status).toBe("verified");
    expect(report.checks.traceBindings).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("t2: denial journal shape matches core/agent.ts; repeated denials stop the turn at five", async () => {
    const writeThing = makeStubTool("write_thing", "write", async () => ({ content: "never runs" }));
    const fixture = await makeFixture({ tools: [writeThing] });
    const denyAll: ApprovalPolicy = { review: async () => "deny" };
    fixture.registration.setResponses(
      Array.from({ length: 5 }, (_unused, index) =>
        fauxAssistantMessage(
          [fauxToolCall("write_thing", { value: "same" }, { id: `deny-call-${index + 1}` })],
          { stopReason: "toolUse" },
        ),
      ),
    );
    const session = makeSession(fixture, { approvalPolicy: denyAll });
    const result = await session.prompt("keep trying");
    expect(result.outcome).toBe("failed");

    const denied = eventsOfType(result.events, "tool.denied");
    expect(denied).toHaveLength(5);
    for (const event of denied) {
      const payload = payloadRecord(event);
      expect(payload.name).toBe("write_thing");
      expect(payload.approval).toBeNull();
    }
    expect(payloadRecord(denied[0]!).content).toBe("Permission denied for write_thing.");
    expect(String(payloadRecord(denied[1]!).content)).toContain(
      "[Airship guardrail: write_thing has now failed 2 times in this turn with identical arguments",
    );
    expect(String(payloadRecord(denied[2]!).content)).toContain("3 times in this turn with identical arguments");
    expect(payloadRecord(denied[4]!).content).toBe("Permission denied for write_thing.");
    expect(eventsOfType(result.events, "tool.resulted")).toHaveLength(0);
    expect(eventsOfType(result.events, "tool.approved")).toHaveLength(0);

    const failed = eventsOfType(result.events, "turn.failed");
    expect(failed).toHaveLength(1);
    const stopText =
      "write_thing failed 5 times in this turn with identical arguments. " +
      "The turn was stopped instead of spending its remaining steps on a call that is not going to " +
      "start succeeding; change the arguments or the approach and send it again.";
    expect(payloadRecord(failed[0]!).error).toBe(stopText);
    expect(result.error).toBe(stopText);

    // A failed turn is dropped whole from the next turn's actionable history.
    const materialized = materializeMessages(result.events, {
      allowEmbeddedContext: false,
      allowSelectedContext: false,
    });
    expect(materialized).toHaveLength(0);
  });

  it("t2b: the second identical denial carries the guardrail warning inside the tool message", async () => {
    const writeThing = makeStubTool("write_thing", "write", async () => ({ content: "never runs" }));
    const fixture = await makeFixture({ tools: [writeThing] });
    const denyAll: ApprovalPolicy = { review: async () => "deny" };
    fixture.registration.setResponses([
      fauxAssistantMessage([fauxToolCall("write_thing", { value: "same" }, { id: "deny-a" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("write_thing", { value: "same" }, { id: "deny-b" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("gives up"),
    ]);
    const session = makeSession(fixture, { approvalPolicy: denyAll });
    const result = await session.prompt("try twice");
    expect(result.outcome).toBe("completed");
    const denied = eventsOfType(result.events, "tool.denied");
    expect(denied).toHaveLength(2);
    expect(payloadRecord(denied[1]!).content).toBe(
      "Permission denied for write_thing.\n\n" +
      "[Airship guardrail: write_thing has now failed 2 times in this turn with identical arguments, " +
      "so repeating it unchanged will fail again. Change the arguments, use a different tool, " +
      "or tell the person what is blocking you. This turn stops at 5 identical failures.]",
    );
  });

  it("t3: approved calls journal approved→resulted in order, with bounded content metadata", async () => {
    const bigRead = makeStubTool("big_read", "read", async () => ({
      content: "x".repeat(50_000),
      metadata: { origin: "stub" },
    }));
    const contextPolicy = createSessionContextPolicy({
      contextWindowTokens: 2_048,
      source: { kind: "runtime-config", label: "test-window" },
    });
    const fixture = await makeFixture({ tools: [bigRead], contextPolicy });
    fixture.registration.setResponses([
      fauxAssistantMessage([fauxToolCall("big_read", { value: "go" }, { id: "big-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done reading"),
    ]);
    const session = makeSession(fixture);
    const result = await session.prompt("read everything");
    expect(result.outcome).toBe("completed");

    const requested = eventsOfType(result.events, "tool.requested")[0]!;
    const approved = eventsOfType(result.events, "tool.approved")[0]!;
    const resulted = eventsOfType(result.events, "tool.resulted")[0]!;
    expect(requested.sequence).toBeLessThan(approved.sequence);
    expect(approved.sequence).toBeLessThan(resulted.sequence);

    const approval = payloadRecord(approved).approval as Record<string, unknown>;
    expect(approval.source).toBe("bounded-browser-sandbox");
    expect(approval.mode).toBe("full-access");

    const resultedPayload = payloadRecord(resulted);
    expect(resultedPayload.isError).toBe(false);
    expect(String(resultedPayload.content)).toContain("[Airship truncated this tool result:");
    const metadata = resultedPayload.metadata as Record<string, unknown>;
    expect(metadata.contextBudgetTruncated).toBe(true);
    expect(metadata.origin).toBe("stub");
    expect(metadata.originalContentBytes).toBe(50_000);
    expect(Number(metadata.retainedContentBytes)).toBeLessThan(50_000);
    expect(resultedPayload.callId).toBe("big-1");
    expect(payloadRecord(approved).callId).toBe("big-1");
    expect(eventsOfType(result.events, "tool.failed")).toHaveLength(0);
  });

  it("t3b: errored tool results journal the identical-failure warning at count two", async () => {
    const flaky = makeStubTool("flaky_write", "write", async () => ({ content: "disk is full", isError: true }));
    const fixture = await makeFixture({ tools: [flaky] });
    fixture.registration.setResponses([
      fauxAssistantMessage([fauxToolCall("flaky_write", { value: "same" }, { id: "flaky-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("flaky_write", { value: "same" }, { id: "flaky-2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("stopping here"),
    ]);
    const session = makeSession(fixture);
    const result = await session.prompt("write twice");
    expect(result.outcome).toBe("completed");
    const resulted = eventsOfType(result.events, "tool.resulted");
    expect(resulted).toHaveLength(2);
    expect(payloadRecord(resulted[0]!).isError).toBe(true);
    expect(String(payloadRecord(resulted[1]!).content)).toContain(
      "[Airship guardrail: flaky_write has now failed 2 times in this turn with identical arguments",
    );
  });

  it("t4: abort mid-flight journals turn.cancelled signal-neutrally and keeps salvage invariants", async () => {
    const fixture = await makeFixture({ faux: { tokensPerSecond: 2 } });
    fixture.registration.setResponses([fauxAssistantMessage("slow ".repeat(600))]);
    const session = makeSession(fixture);
    const promise = session.prompt("say a lot");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(session.getActiveTurnId()).toBeDefined();
    await session.abortTurn("user pressed stop");
    const result = await promise;
    expect(result.outcome).toBe("cancelled");
    expect(result.reason).toBe("user pressed stop");

    const cancelled = eventsOfType(result.events, "turn.cancelled");
    expect(cancelled).toHaveLength(1);
    expect(payloadRecord(cancelled[0]!).error).toBe("user pressed stop");
    expect(eventsOfType(result.events, "turn.completed")).toHaveLength(0);

    // An unproductive cancelled turn drops whole: the next request reads as if it never asked.
    const materialized = materializeMessages(result.events, {
      allowEmbeddedContext: false,
      allowSelectedContext: false,
    });
    expect(materialized).toHaveLength(0);

    fixture.registration.appendResponses([fauxAssistantMessage("second works")]);
    const second = await session.prompt("after the stop");
    expect(second.outcome).toBe("completed");
    expect(eventsOfType(second.events, "turn.cancelled")).toHaveLength(1);
  });

  it("t5a: the maxSteps cap journals turn.failed naming the step limit before opening another request", async () => {
    const lookup = makeStubTool("lookup", "read", async () => ({ content: "ok" }));
    const fixture = await makeFixture({ tools: [lookup] });
    fixture.registration.setResponses(
      Array.from({ length: 3 }, (_unused, index) =>
        fauxAssistantMessage(
          [fauxToolCall("lookup", { query: `q${index}` }, { id: `cap-call-${index}` })],
          { stopReason: "toolUse" },
        ),
      ),
    );
    const session = makeSession(fixture, { maxSteps: 2 });
    const result = await session.prompt("loop forever");
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("Agent exceeded the 2-step turn limit.");
    expect(payloadRecord(eventsOfType(result.events, "turn.failed")[0]!).error).toBe(
      "Agent exceeded the 2-step turn limit.",
    );
    // Steps 0 and 1 opened; the third request never reached the provider.
    expect(eventsOfType(result.events, "inference.started")).toHaveLength(2);
    expect(fixture.registration.state.callCount).toBe(2);
  });

  it("t5b: the 64-tool-call step cap journals turn.failed before any tool draft exists", async () => {
    const lookup = makeStubTool("lookup", "read", async () => ({ content: "ok" }));
    const fixture = await makeFixture({ tools: [lookup] });
    const calls = Array.from({ length: 65 }, (_unused, index) =>
      fauxToolCall("lookup", { query: `${index}` }, { id: `call-${index}` }),
    );
    fixture.registration.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" })]);
    const session = makeSession(fixture);
    const result = await session.prompt("call everything");
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("Provider exceeded the 64-tool-call step limit.");
    // Mismatches raise before the batch is drafted anywhere.
    expect(eventsOfType(result.events, "tool.requested")).toHaveLength(0);
    expect(eventsOfType(result.events, "assistant.completed")).toHaveLength(0);
    expect(payloadRecord(eventsOfType(result.events, "turn.failed")[0]!).error).toBe(
      "Provider exceeded the 64-tool-call step limit.",
    );
  });

  it("t5c: a reused tool-call operation id journals turn.failed naming the reuse", async () => {
    const lookup = makeStubTool("lookup", "read", async () => ({ content: "ok" }));
    const fixture = await makeFixture({ tools: [lookup] });
    fixture.registration.setResponses([
      fauxAssistantMessage([fauxToolCall("lookup", { query: "a" }, { id: "reused" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("lookup", { query: "b" }, { id: "reused" })], { stopReason: "toolUse" }),
    ]);
    const session = makeSession(fixture);
    const result = await session.prompt("reuse ids");
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("Provider emitted a duplicate or reused tool-call operation ID.");
  });

  it("t5d: the 100_000-event step cap journals turn.failed from a bloated stream", { timeout: 30_000 }, async () => {
    const fixture = await makeFixture({});
    const session = makeSession(fixture, {
      streamFn: (model, _context, _options) => {
        const out = createAssistantMessageEventStream();
        const partial: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          api: fixture.model.api,
          provider: fixture.model.provider,
          model: fixture.model.id,
          usage: zeroUsage(),
          stopReason: "stop",
          timestamp: Date.now(),
        };
        const final: AssistantMessage = { ...partial, content: [{ type: "text", text: "x" }] };
        queueMicrotask(() => {
          out.push({ type: "start", partial });
          for (let index = 0; index < 100_001; index += 1) {
            out.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
          }
          out.push({ type: "done", reason: "stop", message: final });
          out.end(final);
        });
        return out;
      },
    });
    const result = await session.prompt("flood the step");
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("Provider exceeded the 100000-event inference step limit.");
    expect(payloadRecord(eventsOfType(result.events, "turn.failed")[0]!).error).toBe(
      "Provider exceeded the 100000-event inference step limit.",
    );
  });

  /*
   * Prime is the default engine, so "the provider exposed reasoning" has to
   * reach a reader on this lane the way it does on core's. It used to reach
   * only a status string: `thinking_delta` raised "reasoning" and dropped the
   * text, so a prime turn showed a reasoning indicator with no reasoning
   * under it and left nothing in the journal for the settled summary to
   * project. Both halves are asserted here — the live signal and the durable
   * record — because either one alone still looks like it works.
   */
  it("t5f: provider reasoning streams as signals and settles as one turn.reasoning record", async () => {
    const fixture = await makeFixture({});
    const streamed: string[] = [];
    const session = makeSession(fixture, {
      onSignal: (signal) => {
        if (signal.type === "reasoning-delta") streamed.push(signal.text);
      },
      streamFn: (_model, _context, _options) => {
        const out = createAssistantMessageEventStream();
        const partial: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          api: fixture.model.api,
          provider: fixture.model.provider,
          model: fixture.model.id,
          usage: zeroUsage(),
          stopReason: "stop",
          timestamp: Date.now(),
        };
        const final: AssistantMessage = { ...partial, content: [{ type: "text", text: "The answer." }] };
        queueMicrotask(() => {
          out.push({ type: "start", partial });
          out.push({ type: "thinking_start", contentIndex: 0, partial });
          out.push({ type: "thinking_delta", contentIndex: 0, delta: "First the plan. ", partial });
          out.push({ type: "thinking_delta", contentIndex: 0, delta: "Then the answer.", partial });
          out.push({ type: "text_delta", contentIndex: 1, delta: "The answer.", partial });
          out.push({ type: "done", reason: "stop", message: final });
          out.end(final);
        });
        return out;
      },
    });

    const result = await session.prompt("think out loud");
    expect(result.outcome).toBe("completed");
    // Live: every delta the provider exposed, in order, unjoined.
    expect(streamed).toEqual(["First the plan. ", "Then the answer."]);
    // Durable: one record for the one step, carrying the joined chain, and no
    // `truncated` flag because the cap never bit.
    const records = eventsOfType(result.events, "turn.reasoning");
    expect(records).toHaveLength(1);
    expect(payloadRecord(records[0]!).text).toBe("First the plan. Then the answer.");
    expect(payloadRecord(records[0]!).truncated).toBeUndefined();
  });

  it("t5e: assistant text over 4 MiB journals turn.failed naming the byte limit", async () => {
    const fixture = await makeFixture({});
    const flood = "x".repeat(4 * 1_024 * 1_024 + 64);
    const session = makeSession(fixture, {
      streamFn: (model, _context, _options) => {
        const out = createAssistantMessageEventStream();
        const final2: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: flood }],
          api: fixture.model.api,
          provider: fixture.model.provider,
          model: fixture.model.id,
          usage: zeroUsage(),
          stopReason: "stop",
          timestamp: Date.now(),
        };
        queueMicrotask(() => {
          out.push({ type: "start", partial: { ...final2, content: [{ type: "text", text: "" }] } });
          out.push({ type: "text_delta", contentIndex: 0, delta: flood, partial: final2 });
          out.push({ type: "done", reason: "stop", message: final2 });
          out.end(final2);
        });
        return out;
      },
    });
    const result = await session.prompt("say too much");
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe(`Provider response exceeded the ${4 * 1_024 * 1_024}-byte turn limit.`);
  });

  it("t6: a kernel bridge call journals prime.kernel.tool.* with prime-kernel:<jobId>:<seq> identity", async () => {
    const echoStub = makeStubTool("echo_stub", "read", async () => ({ content: "echo-ok" }));
    const probe = await makeFixture({});
    const definitionProbeHost = new PrimeKernelHost({
      ports: {
        bridge: { call: async () => ({ seq: 0, ok: false as const, error: "probe host never routes" }) },
        workerFactory: () => {
          throw new Error("definition probe host never boots");
        },
      },
    });
    const executeCodeDef = createPrimeExecuteCodeTool(definitionProbeHost).definition;
    const manifest = await createSessionManifest({
      systemPrompt: SYSTEM_PROMPT,
      providerId: "faux",
      model: probe.model.id,
      tools: [echoStub.definition, executeCodeDef],
      workspaceId: WORKSPACE_ID,
      securityPosture: "local",
    });
    const record = await probe.journal.createSession("kernel bridge test", manifest);

    const scripted = makeKernelBridgeWorker();
    const session = makeSession(
      { ...probe, sessionId: record.id, manifest },
      { kernelWorkerFactory: () => scripted.worker as unknown as Worker },
    );
    probe.registry.register(echoStub);
    probe.registry.register(createPrimeExecuteCodeTool(session.kernelHost));
    probe.registration.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("execute_code", { code: "await pat.call('echo_stub', {})" }, { id: "kernel-call-1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("kernel finished"),
    ]);
    const result = await session.prompt("run code that calls the echo stub");
    expect(result.outcome).toBe("completed");

    const jobStarted = eventsOfType(result.events, PRIME_EVENT_TYPES.kernelJobStarted);
    expect(jobStarted).toHaveLength(1);
    expect(payloadRecord(jobStarted[0]!).jobId).toBe("prime-exec-kernel-call-1");

    const bridgeApproved = eventsOfType(result.events, "prime.kernel.tool.approved");
    expect(bridgeApproved).toHaveLength(1);
    expect(bridgeApproved[0]!.operationId).toBe("prime-kernel:prime-exec-kernel-call-1:0");
    const bridgeApproval = payloadRecord(bridgeApproved[0]!).approval as Record<string, unknown>;
    expect(bridgeApproval.source).toBe("bounded-browser-sandbox");

    const bridgeResulted = eventsOfType(result.events, "prime.kernel.tool.resulted");
    expect(bridgeResulted).toHaveLength(1);
    expect(bridgeResulted[0]!.operationId).toBe("prime-kernel:prime-exec-kernel-call-1:0");
    expect(payloadRecord(bridgeResulted[0]!).content).toBe("echo-ok");
    expect(payloadRecord(bridgeResulted[0]!).callId).toBe("prime-kernel:prime-exec-kernel-call-1:0");

    const jobCompleted = eventsOfType(result.events, PRIME_EVENT_TYPES.kernelJobCompleted);
    expect(jobCompleted).toHaveLength(1);
    expect(payloadRecord(jobCompleted[0]!).bridgeCalls).toBe(1);

    // The execute_code call itself lives in the ordinary turn vocabulary.
    expect(eventsOfType(result.events, "tool.approved").map((event) => event.operationId)).toEqual(["kernel-call-1"]);
    expect(eventsOfType(result.events, "tool.resulted").map((event) => event.operationId)).toEqual(["kernel-call-1"]);
    expect(result.text ?? "").toContain("kernel finished");
  });

  it("refuses recursive execute_code before registry review or execution", async () => {
    const fixture = await makeFixture();
    const bridge = new KernelToolBridge({
      registry: fixture.registry,
      approvalPolicy: allowAllForTests,
      journal: fixture.journal,
      sessionId: fixture.sessionId,
      turnId: () => "turn-recursive-kernel",
      signal: new AbortController().signal,
    });

    const result = await bridge.call({
      jobId: "job-recursive-kernel",
      seq: 0,
      tool: "execute_code",
      arguments: { code: "return 'nested';" },
    });
    expect(result).toMatchObject({
      seq: 0,
      ok: false,
      error: expect.stringContaining("cannot invoke execute_code recursively"),
    });
    const events = await fixture.journal.readEvents(fixture.sessionId);
    const failed = eventsOfType(events, "prime.kernel.tool.failed");
    expect(failed).toHaveLength(1);
    expect(payloadRecord(failed[0]!).name).toBe("execute_code");
    expect(eventsOfType(events, "prime.kernel.tool.approved")).toHaveLength(0);
  });

  it("t7: prompt during an active turn refuses with the serialization error; queued steer lands as next turn", { timeout: 120_000 }, async () => {
    const fixture = await makeFixture({});
    fixture.registration.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("steer answer"),
      fauxAssistantMessage("second answer"),
    ]);
    const session = makeSession(fixture);
    const first = session.prompt("one");
    /*
     * The serialization contract this test owns is synchronous: calling
     * prompt() marks driverBusy on the entry queue before the turn opens,
     * so an immediately issued second prompt must be refused by that latch
     * long before the turn identity exists. The old two-tick wait used to
     * do nothing; the 10s/120s translations just proved the *turn* can close
     * before macros get back. The assertion this test needs is the refusal
     * itself, made before any scheduling window can masquerade as flaky.
     */
    const [secondErr, thirdErr] = await Promise.all([
      session.prompt("two").then(
        () => { throw new Error("prompt('two') while driverBusy must be rejected"); },
        (error: unknown) => error,
      ),
      session.prompt("also cannot").then(
        () => { throw new Error("prompt('also cannot') while driverBusy must be rejected"); },
        (error: unknown) => error,
      ),
    ]);
    expect(String(secondErr)).toMatch(/steer\/follow-up as next turn/i);
    expect(String(thirdErr)).toMatch(/wait for it to settle/i);

    session.steer("steered while running");
    const firstResult = await first;
    expect(firstResult.outcome).toBe("completed");
    await session.waitForIdle();

    const third = await session.prompt("two");
    expect(third.outcome).toBe("completed");

    const journal = await fixture.journal.readEvents(fixture.sessionId);
    const requested = eventsOfType(journal, "turn.requested").map((event) => String(payloadRecord(event).content));
    expect(requested).toEqual(["one", "steered while running", "two"]);
    expect(fixture.registration.state.callCount).toBe(3);
  });

  it("t8: turn.requested images pass through and the receipt chains to the final request digest", async () => {
    const lookup = makeStubTool("lookup", "read", async () => ({ content: "found it" }));
    const fixture = await makeFixture({ tools: [lookup] });
    const capturedContexts: unknown[][] = [];
    fixture.registration.setResponses([
      (context) => {
        capturedContexts.push(context.messages);
        return fauxAssistantMessage([fauxToolCall("lookup", { query: "q" }, { id: "call-1" })], { stopReason: "toolUse" });
      },
      (context) => {
        capturedContexts.push(context.messages);
        return fauxAssistantMessage("saw the image");
      },
    ]);
    const image = {
      type: "image" as const,
      name: "pic",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,aGVsbG8=",
      sizeBytes: 5,
    };
    const session = makeSession(fixture);
    const result = await session.prompt("what is in this image", [image]);
    expect(result.outcome).toBe("completed");

    const requested = eventsOfType(result.events, "turn.requested")[0]!;
    const images = payloadRecord(requested).images as unknown[];
    expect(images).toEqual([
      {
        type: "image",
        name: "pic",
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,aGVsbG8=",
        sizeBytes: 5,
      },
    ]);
    expect(capturedContexts).toHaveLength(2);

    // The provider-facing messages carry the image as a prime image block.
    const userMessage = capturedContexts[0]![0] as { role: string; content: unknown };
    expect(userMessage.role).toBe("user");
    const parts = userMessage.content as Array<Record<string, unknown>>;
    expect(parts).toEqual([
      { type: "text", text: "what is in this image" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);

    // The receipt binds the request digest of the step that produced the final answer.
    const receipt = result.receipt!;
    const started = eventsOfType(result.events, "inference.started");
    const lastStarted = started.at(-1)!;
    expect(receipt.requestDigest).toBe(payloadRecord(lastStarted).requestDigest);
    expect(receipt.responseDigest).toBe(await sha256("saw the image"));
    expect(receipt.sessionId).toBe(fixture.sessionId);
    expect(receipt.turnId).toBe(result.turnId);
    expect(receipt.provider).toBe(fixture.manifest.providerId);
    expect(receipt.model).toBe(fixture.manifest.model);
    expect(eventsOfType(result.events, "turn.completed")[0]!.payload).toEqual({
      responseDigest: await sha256("saw the image"),
      receiptId: receipt.receiptId,
    });

    const totals = session.getUsageTotals();
    expect(totals.input + totals.cacheRead + totals.cacheWrite).toBeGreaterThan(0);
    expect(totals.output).toBeGreaterThan(0);
  });

  it("writes the custody notice once per journal, not once per attached authority", async () => {
    /*
     * `runPrimeTurn` builds a fresh authority for every turn, so "written
     * once" has to be a fact about the journal. Two authorities over one
     * journal is that shape, minus the runtime facade.
     */
    const fixture = await makeFixture();
    fixture.registration.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    const first = makeSession(fixture);
    await first.prompt("hello");
    await first.dispose("first authority done");

    const second = makeSession(fixture);
    const result = await second.prompt("again");
    await second.dispose("second authority done");

    const custody = eventsOfType(result.events, PRIME_EVENT_TYPES.customNotice)
      .filter((event) => String(payloadRecord(event).notice ?? "").includes("took custody"));
    expect(custody).toHaveLength(1);
  });

  it("binds provider receipts and idempotency keys to the live turn, not a per-request uuid", async () => {
    const fixture = await makeFixture();
    const requests: InferenceRequest[] = [];
    const transport: InferenceTransport = {
      id: "faux",
      posture: "local",
      // Mirrors a receipt-minting transport: the receipt is minted from the
      // identity the request arrived carrying, so a request addressed to a
      // turn that does not exist mints a receipt the audit cannot match.
      async *stream(request) {
        requests.push(structuredClone(request));
        yield { type: "text-delta", text: "bound" };
        yield {
          type: "completed",
          finishReason: "stop",
          receipt: {
            ...blankReceipt(),
            sessionId: request.sessionId,
            turnId: request.turnId,
          },
        };
      },
    };
    const session = makeSession(fixture, { transport });
    const result = await session.prompt("hi");
    expect(result.outcome).toBe("completed");

    expect(result.receipt!.turnId).toBe(result.turnId);
    expect(result.receipt!.sessionId).toBe(fixture.sessionId);
    // The key the provider saw is the key the journal recorded, so a retried
    // step asks the provider to dedup against something it has actually seen.
    const journaledKeys = eventsOfType(result.events, "inference.started")
      .map((event) => payloadRecord(event).idempotencyKey);
    expect(requests.map((request) => request.idempotencyKey)).toEqual(journaledKeys);
    expect(journaledKeys[0]).toBe(`${fixture.sessionId}:${result.turnId}:0`);
  });


  it("fails a provider receipt for a foreign turn without journaling a successful terminal", async () => {
    const fixture = await makeFixture();
    const transport: InferenceTransport = {
      id: "faux",
      posture: "local",
      async *stream() {
        yield { type: "text-delta" as const, text: "must not complete" };
        yield {
          type: "completed" as const,
          finishReason: "stop" as const,
          receipt: {
            ...blankReceipt(),
            origin: "provider" as const,
            sessionId: "other-session",
            turnId: "other-turn",
            model: "other-model",
          },
        };
      },
    };
    const session = makeSession(fixture, { transport });
    const result = await session.prompt("hi");

    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/identity does not match the active turn/u);
    expect(eventsOfType(result.events, "assistant.completed")).toHaveLength(0);
    expect(eventsOfType(result.events, "turn.completed")).toHaveLength(0);
    expect(eventsOfType(result.events, "turn.failed")).toHaveLength(1);
    const record = (await fixture.journal.getSession(fixture.sessionId))!;
    const report = await auditSessionHistory({ session: record, events: result.events });
    expect(report.status).toBe("incomplete");
    expect(report.findings.some((finding) => finding.code === "RECEIPT_IDENTITY_MISMATCH")).toBe(false);
  });

  it("clears a tool-step receipt before the next provider call when the final step has none", async () => {
    const lookup = makeStubTool("lookup", "read", async () => ({ content: "tool output" }));
    const fixture = await makeFixture({ tools: [lookup] });
    const requests: InferenceRequest[] = [];
    const toolStepReceiptId = "urn:airship:receipt:tool-step";
    const transport: InferenceTransport = {
      id: "faux",
      posture: "local",
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield {
            type: "tool-call",
            call: { id: "call-1", name: "lookup", arguments: { value: "x" } },
          };
          yield {
            type: "completed",
            finishReason: "tool-calls",
            receipt: {
              ...blankReceipt(),
              receiptId: toolStepReceiptId,
              sessionId: request.sessionId,
              turnId: request.turnId,
              provider: "tool-step-provider",
            },
          };
          return;
        }
        yield { type: "text-delta", text: "final answer" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const session = makeSession(fixture, { transport });
    const result = await session.prompt("hi");
    expect(result.outcome).toBe("completed");
    expect(requests).toHaveLength(2);

    const inferenceStarts = eventsOfType(result.events, "inference.started");
    const finalAssistant = eventsOfType(result.events, "assistant.completed").at(-1)!;
    const finalReceipt = payloadRecord(finalAssistant).receipt as Record<string, unknown>;
    expect(result.receipt?.receiptId).not.toBe(toolStepReceiptId);
    expect(finalReceipt.receiptId).toBe(result.receipt?.receiptId);
    expect(finalReceipt.receiptId).not.toBe(toolStepReceiptId);
    expect(finalReceipt.requestDigest).toBe(payloadRecord(inferenceStarts[1]!).requestDigest);
    expect(result.receipt?.requestDigest).toBe(payloadRecord(inferenceStarts[1]!).requestDigest);
  });

  it("addresses each turn to the model the session record names now, not the manifest's", async () => {
    /*
     * The manifest is the thread's birth certificate. A person who opens the
     * picker mid-conversation writes `session.model-changed`, and the prime
     * lane used to read the record only to check it existed — so the picker
     * appeared to work, the request kept going to the old model, and the
     * journal named a model nobody had chosen.
     */
    const fixture = await makeFixture();
    const requests: InferenceRequest[] = [];
    const transport: InferenceTransport = {
      id: "faux",
      posture: "local",
      async *stream(request) {
        requests.push(structuredClone(request));
        yield { type: "text-delta", text: "ok" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const session = makeSession(fixture, { transport });
    const before = await session.prompt("before the switch");
    expect(before.outcome).toBe("completed");

    await fixture.journal.setSessionModel(fixture.sessionId, "switched-model-v2");
    const after = await session.prompt("after the switch");
    expect(after.outcome).toBe("completed");

    expect(requests.map((request) => request.model)).toEqual([fixture.manifest.model, "switched-model-v2"]);
    const started = eventsOfType(after.events, "inference.started").filter((event) => event.turnId === after.turnId);
    expect(payloadRecord(started[0]!).model).toBe("switched-model-v2");
    expect(after.receipt!.model).toBe("switched-model-v2");
  });

  it("spends the step's tool-output budget on the ratio the boundary calibrated", async () => {
    /*
     * The boundary gate measures this turn's context with the tokenizer ratio
     * it calibrated from journaled provider usage; the step ledger used to
     * measure the same turn with the fixed 3.6 guess. A fixed 3.6 is off by
     * 25-40% between minified JSON and English prose, so the two scales hand
     * the step visibly different budgets for byte-identical work.
     */
    const budgetFor = async (seedUsage: boolean): Promise<number> => {
      const bigRead = makeStubTool("big_read", "read", async () => ({ content: "x".repeat(50_000) }));
      const contextPolicy = createSessionContextPolicy({
        contextWindowTokens: 4_096,
        source: { kind: "runtime-config", label: "test-window" },
      });
      const fixture = await makeFixture({ tools: [bigRead], contextPolicy });
      if (seedUsage) {
        /*
         * One usage sample whose input-token count is far below the request's
         * byte size, so calibration clamps to its 6 bytes/token ceiling — a
         * deterministic ratio well clear of the 3.6 default. These records
         * carry no canonical message, so the two journals materialize
         * identically and only the ratio differs.
         */
        await fixture.journal.append(fixture.sessionId, [
          { type: "inference.started", turnId: "seed-turn", operationId: "seed-op", payload: { step: 0 } },
          { type: "inference.usage", turnId: "seed-turn", operationId: "seed-op", payload: { type: "usage", inputTokens: 1 } },
        ]);
      }
      fixture.registration.setResponses([
        fauxAssistantMessage([fauxToolCall("big_read", { value: "go" }, { id: "big-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done reading"),
      ]);
      const session = makeSession(fixture);
      const result = await session.prompt("read everything");
      expect(result.outcome).toBe("completed");
      const metadata = payloadRecord(eventsOfType(result.events, "tool.resulted")[0]!).metadata as Record<string, unknown>;
      expect(metadata.contextBudgetTruncated).toBe(true);
      return Number(metadata.retainedContentBytes);
    };

    const calibrated = await budgetFor(true);
    const uncalibrated = await budgetFor(false);
    expect(calibrated).toBeGreaterThan(uncalibrated);
  });
});

/** A trace-only receipt: only identity and digests matter to these tests. */
function blankReceipt(): ConversationReceipt {
  return {
    version: 1,
    origin: "local",
    attestation: "none",
    receiptId: "urn:airship:receipt:prime-session-test",
    sessionId: "unbound",
    turnId: "unbound",
    createdAt: "2026-01-01T00:00:00.000Z",
    provider: "unbound",
  };
}

/**
 * The queued turn must become *active* under contended event loops on any
 * machine the suite runs on: a fixed number of `setTimeout(0)` ticks races on
 * loaded runners, while a millisecond deadline does not depend on tick
 * scheduling at all. Its only clock is the file's own test timeout: the
 * state it waits for is one the session always reaches, so a fixed poll
 * budget only ever decides whether a slow machine or a broken session gets
 * the blame.
 */
async function waitForActiveTurnId(session: PrimeAgentSession): Promise<string | undefined> {
  /*
   * No wall-clock deadline: fixed budgets keep losing to load (2 s sat empty
   * on a four-worker runner, 10 s sat empty beside a six-browser verification
   * swarm — the turn opened right after the budget expired in both). The
   * state this test needs is one the session ALWAYS reaches; the file's own
   * 30 s testTimeout is the backstop if it somehow never does, and failing at
   * that boundary names the real regression instead of racing a clock.
   */
  for (;;) {
    const turnId = session.getActiveTurnId();
    if (turnId) return turnId;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
