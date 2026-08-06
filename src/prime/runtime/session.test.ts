/**
 * Prime session authority tests: the spec's eight named cases, run against
 * the real ported Agent/loop with the scripted faux provider, the airship
 * MemoryJournalBackend, and a real ToolRegistry, so every assertion reads
 * the same journal the session audit would read.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../ai/event-stream";
import type { AssistantMessage, Model, Usage } from "../ai/types";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "../ai/providers/faux";
import { materializeMessages } from "../../core/agent";
import type {
  ApprovalPolicy,
  JsonValue,
  SessionContextPolicy,
  SessionManifest,
  Tool,
  ToolContext,
  ToolExecutionResult,
} from "../../core/contracts";
import { createSessionContextPolicy } from "../../core/context-policy";
import { sha256, stableStringify } from "../../core/hash";
import { EventJournal } from "../../core/journal";
import type { DurableEvent } from "../../core/journal";
import { createSessionManifest } from "../../core/session-manifest";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import { PrimeKernelHost } from "../kernel/kernel-host";
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

function makeKernelBridgeWorker(): { worker: ScriptedKernelWorker } {
  const listeners = {
    message: [] as ((event: { data?: unknown }) => void)[],
    error: [] as ((event: { message?: string }) => void)[],
  };
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
          call: { jobId: data.job.jobId, seq: 0, tool: "echo_stub", arguments: {} },
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
      if (type === "message") listeners.message.push(listener as (event: { data?: unknown }) => void);
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
