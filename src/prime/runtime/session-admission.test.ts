import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "../ai/stream";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  registerFauxProvider,
} from "../ai/providers/faux.test-support";
import { createSessionContextPolicy } from "../../core/context-policy";
import type { JsonValue, SessionContextPolicy, SessionManifest } from "../../core/contracts";
import { EventJournal, JournalConflictError, type DurableEvent } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { auditSessionHistory } from "../../core/session-audit";
import { createSessionManifest } from "../../core/session-manifest";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import { PrimeAgentSession, type PrimeSessionOptions, type PrimeTurnResult } from "./session";

const SYSTEM_PROMPT = "You are the fenced Prime admission test assistant.";
const WORKSPACE_ID = "ws-prime-admission";
const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  while (registrations.length > 0) registrations.pop()?.unregister();
});

type Fixture = Readonly<{
  registration: FauxProviderRegistration;
  backend: MemoryJournalBackend;
  journal: EventJournal;
  registry: ToolRegistry;
  manifest: SessionManifest;
  sessionId: string;
}>;

function deferred<T = void>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function makeFixture(contextPolicy?: SessionContextPolicy): Promise<Fixture> {
  const registration = registerFauxProvider({
    models: [
      { id: "model-a", name: "Model A", contextWindow: 4_096 },
      { id: "model-b", name: "Model B", contextWindow: 8_192 },
    ],
  });
  registrations.push(registration);
  const backend = new MemoryJournalBackend();
  const journal = new EventJournal(backend);
  const registry = new ToolRegistry();
  const manifest = await createSessionManifest({
    systemPrompt: SYSTEM_PROMPT,
    providerId: "faux",
    model: "model-a",
    tools: registry.definitions(),
    workspaceId: WORKSPACE_ID,
    securityPosture: "local",
    ...(contextPolicy ? { contextPolicy } : {}),
  });
  const record = await journal.createSession("Prime admission fence", manifest);
  return { registration, backend, journal, registry, manifest, sessionId: record.id };
}

function makeSession(
  fixture: Fixture,
  journal: EventJournal,
  options: Partial<PrimeSessionOptions> = {},
): PrimeAgentSession {
  const model = fixture.registration.getModel("model-a");
  if (!model) throw new Error("model-a is not registered");
  return new PrimeAgentSession({
    sessionId: fixture.sessionId,
    manifest: fixture.manifest,
    journal,
    registry: fixture.registry,
    approvalPolicy: allowAllForTests,
    model,
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

async function expectVerified(journal: EventJournal, sessionId: string): Promise<void> {
  const session = await journal.getSession(sessionId);
  if (!session) throw new Error(`missing session ${sessionId}`);
  const events = await journal.readEvents(sessionId);
  const report = await auditSessionHistory({ session, events });
  expect(report.status).toBe("verified");
  expect(report.findings).toEqual([]);
}

type SettledTurn =
  | Readonly<{ status: "fulfilled"; value: PrimeTurnResult }>
  | Readonly<{ status: "rejected"; reason: unknown }>;

function settleTurn(promise: Promise<PrimeTurnResult>): Promise<SettledTurn> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

describe("PrimeAgentSession exact-head turn admission", () => {
  it("refuses a model/context change during async prompt preflight before inference or turn mutation, then retries from the new head", async () => {
    const firstPolicy = createSessionContextPolicy({
      contextWindowTokens: 4_096,
      source: { kind: "runtime-config", label: "model-a-window" },
    });
    const secondPolicy = createSessionContextPolicy({
      contextWindowTokens: 8_192,
      source: { kind: "runtime-config", label: "model-b-window" },
    });
    const fixture = await makeFixture(firstPolicy);
    fixture.registration.setResponses([fauxAssistantMessage("answer from the admitted model")]);
    const enteredPromptPreflight = deferred();
    const releasePromptPreflight = deferred();
    const session = makeSession(fixture, fixture.journal, {
      getSystemPrompt: async () => {
        enteredPromptPreflight.resolve();
        await releasePromptPreflight.promise;
        return fixture.manifest.systemPrompt;
      },
    });
    const idleKernelBridge = session.kernelBridge;

    const firstAttempt = settleTurn(session.prompt("which model owns this turn?"));
    await enteredPromptPreflight.promise;
    expect(session.getActiveTurnId()).toBeUndefined();
    expect(session.kernelBridge).toBe(idleKernelBridge);
    expect(session.agent.state.systemPrompt).toBe("");
    expect(session.agent.state.model.id).toBe("model-a");
    await expect(idleKernelBridge.call({
      jobId: "pre-admission-kernel-job",
      seq: 0,
      tool: "execute_code",
      arguments: { code: "return 'must not run';" },
    })).rejects.toThrow("no active prime turn");
    const beforeChange = await fixture.journal.readEvents(fixture.sessionId);
    expect(eventsOfType(beforeChange, "turn.requested")).toHaveLength(0);
    expect(eventsOfType(beforeChange, "inference.started")).toHaveLength(0);
    expect(eventsOfType(beforeChange, "prime.kernel.tool.failed")).toHaveLength(0);
    expect(beforeChange.filter((event) => event.turnId !== undefined)).toHaveLength(0);

    await fixture.journal.setSessionModel(fixture.sessionId, "model-b", {
      contextPolicy: secondPolicy,
    });
    releasePromptPreflight.resolve();

    const refused = await firstAttempt;
    expect(refused.status).toBe("rejected");
    if (refused.status !== "rejected") throw new Error("stale turn unexpectedly completed");
    expect(refused.reason).toBeInstanceOf(JournalConflictError);
    expect(fixture.registration.state.callCount).toBe(0);

    const afterRefusal = await fixture.journal.readEvents(fixture.sessionId);
    expect(eventsOfType(afterRefusal, "session.model-changed")).toHaveLength(1);
    expect(eventsOfType(afterRefusal, "turn.requested")).toHaveLength(0);
    expect(eventsOfType(afterRefusal, "inference.started")).toHaveLength(0);
    expect(eventsOfType(afterRefusal, "assistant.completed")).toHaveLength(0);
    expect(eventsOfType(afterRefusal, "turn.completed")).toHaveLength(0);
    expect(eventsOfType(afterRefusal, "turn.failed")).toHaveLength(0);
    expect(eventsOfType(afterRefusal, "turn.cancelled")).toHaveLength(0);
    expect(eventsOfType(afterRefusal, "prime.kernel.tool.failed")).toHaveLength(0);
    expect(afterRefusal.filter((event) => event.turnId !== undefined)).toHaveLength(0);
    expect(session.getActiveTurnId()).toBeUndefined();
    expect(session.kernelBridge).toBe(idleKernelBridge);
    expect(session.agent.state.systemPrompt).toBe("");
    expect(session.agent.state.model.id).toBe("model-a");

    const retried = await session.prompt("retry against the current head");
    expect(retried.outcome).toBe("completed");
    const retriedStarts = eventsOfType(retried.events, "inference.started")
      .filter((event) => event.turnId === retried.turnId);
    expect(retriedStarts).toHaveLength(1);
    expect(payloadRecord(retriedStarts[0]!).model).toBe("model-b");
    expect(retried.receipt?.model).toBe("model-b");
    expect(session.agent.state.model.contextWindow).toBe(secondPolicy.contextWindowTokens);
    expect(fixture.registration.state.callCount).toBe(1);
    await expectVerified(fixture.journal, fixture.sessionId);
  });

  it("keeps inference, digest, and receipt on the snapshot admitted before a later model change", async () => {
    const admittedPolicy = createSessionContextPolicy({
      contextWindowTokens: 4_096,
      source: { kind: "runtime-config", label: "admitted-window" },
    });
    const nextPolicy = createSessionContextPolicy({
      contextWindowTokens: 8_192,
      source: { kind: "runtime-config", label: "next-window" },
    });
    const fixture = await makeFixture(admittedPolicy);
    fixture.registration.setResponses([fauxAssistantMessage("the admitted turn stays on model a")]);
    let modelChange: Promise<unknown> | undefined;
    let session!: PrimeAgentSession;
    let requestedSignalTurnId: string | undefined;
    let requestedSignalKernelBridge: unknown;
    session = makeSession(fixture, fixture.journal, {
      onSignal(signal) {
        if (
          signal.type === "durable" &&
          signal.events.some((event) => event.type === "turn.requested") &&
          !modelChange
        ) {
          requestedSignalTurnId = session.getActiveTurnId();
          requestedSignalKernelBridge = session.kernelBridge;
          modelChange = fixture.journal.setSessionModel(fixture.sessionId, "model-b", {
            contextPolicy: nextPolicy,
          });
          void modelChange.catch(() => undefined);
        }
      },
    });
    const idleKernelBridge = session.kernelBridge;

    const result = await session.prompt("finish under the admitted route");
    await modelChange;
    expect(requestedSignalTurnId).toBe(result.turnId);
    expect(requestedSignalKernelBridge).not.toBe(idleKernelBridge);
    expect(result.outcome).toBe("completed");
    const events = await fixture.journal.readEvents(fixture.sessionId);
    const requested = eventsOfType(events, "turn.requested")[0]!;
    const changed = eventsOfType(events, "session.model-changed")[0]!;
    const started = eventsOfType(events, "inference.started")[0]!;
    expect(requested.sequence).toBeLessThan(changed.sequence);
    expect(changed.sequence).toBeLessThan(started.sequence);
    expect(payloadRecord(started).model).toBe("model-a");
    expect(result.receipt?.model).toBe("model-a");
    expect(result.receipt?.requestDigest).toBe(payloadRecord(started).requestDigest);
    expect(session.agent.state.model.contextWindow).toBe(admittedPolicy.contextWindowTokens);
    expect((await fixture.journal.getSession(fixture.sessionId))?.modelOverride).toBe("model-b");
    await expectVerified(fixture.journal, fixture.sessionId);
  });

  it("admits only one of two cross-tab turns racing from the same durable head", async () => {
    const fixture = await makeFixture();
    fixture.registration.setResponses([
      fauxAssistantMessage("winner one"),
      fauxAssistantMessage("winner two"),
    ]);
    const otherJournal = new EventJournal(fixture.backend);
    const bothInPreflight = deferred();
    const releasePreflight = deferred();
    let arrivals = 0;
    const getSystemPrompt = async () => {
      arrivals += 1;
      if (arrivals === 2) bothInPreflight.resolve();
      await releasePreflight.promise;
      return fixture.manifest.systemPrompt;
    };
    const firstSession = makeSession(fixture, fixture.journal, { getSystemPrompt });
    const secondSession = makeSession(fixture, otherJournal, { getSystemPrompt });
    const firstIdleKernelBridge = firstSession.kernelBridge;
    const secondIdleKernelBridge = secondSession.kernelBridge;

    const first = settleTurn(firstSession.prompt("first tab"));
    const second = settleTurn(secondSession.prompt("second tab"));
    await bothInPreflight.promise;
    expect(firstSession.getActiveTurnId()).toBeUndefined();
    expect(secondSession.getActiveTurnId()).toBeUndefined();
    expect(firstSession.kernelBridge).toBe(firstIdleKernelBridge);
    expect(secondSession.kernelBridge).toBe(secondIdleKernelBridge);
    expect(eventsOfType(await fixture.journal.readEvents(fixture.sessionId), "turn.requested")).toHaveLength(0);
    releasePreflight.resolve();

    const settled = await Promise.all([first, second]);
    const fulfilled = settled.filter(
      (outcome): outcome is Extract<SettledTurn, { status: "fulfilled" }> => outcome.status === "fulfilled",
    );
    const rejected = settled.filter(
      (outcome): outcome is Extract<SettledTurn, { status: "rejected" }> => outcome.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.outcome).toBe("completed");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(JournalConflictError);
    expect(fixture.registration.state.callCount).toBe(1);

    const events = await fixture.journal.readEvents(fixture.sessionId);
    expect(eventsOfType(events, "turn.requested")).toHaveLength(1);
    expect(eventsOfType(events, "inference.started")).toHaveLength(1);
    expect(eventsOfType(events, "assistant.completed")).toHaveLength(1);
    expect(eventsOfType(events, "turn.completed")).toHaveLength(1);
    expect(eventsOfType(events, "turn.failed")).toHaveLength(0);
    expect(eventsOfType(events, "turn.cancelled")).toHaveLength(0);
    await expectVerified(fixture.journal, fixture.sessionId);
  });

  it("snapshots caller-owned images before async prompt preflight", async () => {
    const fixture = await makeFixture();
    fixture.registration.setResponses([fauxAssistantMessage("image admitted")]);
    const enteredPromptPreflight = deferred();
    const releasePromptPreflight = deferred();
    const session = makeSession(fixture, fixture.journal, {
      getSystemPrompt: async () => {
        enteredPromptPreflight.resolve();
        await releasePromptPreflight.promise;
        return fixture.manifest.systemPrompt;
      },
    });
    const image = {
      type: "image" as const,
      name: "before.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,aGVsbG8=",
      sizeBytes: 5,
    };
    const callerImages = [image];

    const pending = session.prompt("inspect the queued image", callerImages);
    await enteredPromptPreflight.promise;
    image.name = "after.png";
    image.dataUrl = "data:image/png;base64,d29ybGQ=";
    callerImages.length = 0;
    releasePromptPreflight.resolve();

    const result = await pending;
    expect(result.outcome).toBe("completed");
    const requested = eventsOfType(result.events, "turn.requested")[0]!;
    expect(payloadRecord(requested).images as JsonValue).toEqual([
      {
        type: "image",
        name: "before.png",
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,aGVsbG8=",
        sizeBytes: 5,
      },
    ]);
    await expectVerified(fixture.journal, fixture.sessionId);
  });
});
