/**
 * PrimeRuntime facade tests: create/attach/list/prompt/abort/dispose flows
 * over the memory journal, disposal serialization, and the runtime gate's
 * fail-closed fork refusals.
 */

import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "../ai/stream";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  registerFauxProvider,
} from "../ai/providers/faux.test-support";
import type { Api, Model } from "../ai/types";
import type { StreamFn } from "../agent";
import type { InferenceTransport } from "../../core/contracts";
import { EventJournal } from "../../core/journal";
import { createSessionManifest } from "../../core/session-manifest";
import { canonicalLiveEnvironmentSnapshot, verifyLiveEnvironmentSnapshot } from "../../core/live-environment";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { auditSessionHistory } from "../../core/session-audit";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import { PRIME_EVENT_TYPES } from "./prime-events";
import { PrimeRuntime, primeModelFromManifest, runPrimeTurn, sessionRuntimeKind } from "./runtime";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
  while (registrations.length > 0) registrations.pop()?.unregister();
});

type RuntimeFixture = Readonly<{
  registration: FauxProviderRegistration;
  model: Model<string>;
  journal: EventJournal;
  registry: ToolRegistry;
  runtime: PrimeRuntime;
}>;

async function makeRuntimeFixture(
  faux?: Parameters<typeof registerFauxProvider>[0],
): Promise<RuntimeFixture> {
  const registration = registerFauxProvider(faux ?? {});
  registrations.push(registration);
  const model = registration.getModel();
  if (!model) throw new Error("faux registration has no model");
  const journal = new EventJournal(new MemoryJournalBackend());
  const registry = new ToolRegistry();
  const runtime = new PrimeRuntime({ journal, registry, approvalPolicy: allowAllForTests });
  return { registration, model, journal, registry, runtime };
}

describe("PrimeRuntime", () => {
  it("creates sessions whose manifests are digest-identical to airship createSessionManifest output", async () => {
    const fixture = await makeRuntimeFixture();
    const now = "2026-01-01T00:00:00.000Z";
    const session = await fixture.runtime.createSession({
      title: "runtime create",
      model: fixture.model,
      streamFn: streamSimple,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: fixture.model.id,
        workspaceId: "ws-runtime",
        now,
      },
    });
    const direct = await createSessionManifest({
      systemPrompt: "prompt",
      providerId: "faux",
      model: fixture.model.id,
      tools: fixture.registry.definitions(),
      workspaceId: "ws-runtime",
      now,
    });
    expect(session.manifest).toEqual(direct);
    expect(session.manifest.protocolVersion).toBe(2);
    expect(fixture.runtime.getSession(session.id)).toBe(session);
    const record = await fixture.journal.getSession(session.id);
    expect(record?.manifest).toEqual(direct);
  });

  it("builds Prime models from canonical provider protocol rather than transport IDs", async () => {
    const manifest = await createSessionManifest({
      systemPrompt: "prompt",
      providerId: "chutes",
      model: "chutes/model",
      tools: [],
      workspaceId: "ws-runtime",
      inferenceBinding: {
        version: 2,
        connectionId: "chutes-main",
        connectionGeneration: 1,
        providerId: "chutes",
        providerLabel: "Chutes",
        providerRevision: 1,
        transportId: "chutes-openai-compatible-v1",
        protocol: "openai-compatible",
        authMethod: "api-key",
        transportBoundary: "provider-tls",
        modelId: "chutes/model",
        boundAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(primeModelFromManifest(manifest)).toMatchObject({
      provider: "chutes",
      api: "openai-completions",
    });
  });

  it("refuses invalid Prime creation wiring before it creates a durable record", async () => {
    const fixture = await makeRuntimeFixture();
    const binding = {
      version: 2 as const,
      connectionId: "ollama-loopback",
      connectionGeneration: 1,
      providerId: "ollama",
      providerLabel: "Ollama",
      providerRevision: 1,
      transportId: "ollama-openai-local-v1",
      protocol: "openai-compatible" as const,
      authMethod: "local-none" as const,
      transportBoundary: "loopback-local" as const,
      modelId: "gemma3:latest",
      boundAt: "2026-08-20T00:00:00.000Z",
    };
    const model: Model<Api> = {
      ...fixture.model,
      id: binding.modelId,
      name: binding.modelId,
      provider: binding.providerId,
      api: "openai-completions",
    };
    const transport: InferenceTransport = {
      id: binding.transportId,
      posture: "local",
      async *stream() { throw new Error("not reached"); },
    };
    const streamFn: StreamFn = async () => { throw new Error("not reached"); };
    const create = (candidate: Model<Api>, overrides: Readonly<{ streamFn?: StreamFn }> = {}) =>
      fixture.runtime.createSession({
        model: candidate,
        transport,
        activeInferenceBinding: binding,
        ...overrides,
        manifest: {
          systemPrompt: "prompt",
          providerId: binding.providerId,
          model: binding.modelId,
          workspaceId: "ws-runtime",
        },
      });

    await expect(create({ ...model, id: "other-model" })).rejects.toThrow(/durable model pin/u);
    await expect(create({ ...model, provider: "other-provider" })).rejects.toThrow(/model provider/u);
    await expect(create({ ...model, api: "anthropic-messages" })).rejects.toThrow(/does not match the pinned/u);
    await expect(create(model, { streamFn })).rejects.toThrow(/cannot override/u);
    expect(await fixture.journal.listSessions()).toEqual([]);
  });

  it("projects a durable model change through the same exact v2 Prime route", async () => {
    const fixture = await makeRuntimeFixture();
    const binding = {
      version: 2 as const,
      connectionId: "ollama-loopback",
      connectionGeneration: 1,
      providerId: "ollama",
      providerLabel: "Ollama",
      providerRevision: 1,
      transportId: "ollama-openai-local-v1",
      protocol: "openai-compatible" as const,
      authMethod: "local-none" as const,
      transportBoundary: "loopback-local" as const,
      modelId: "gemma3:latest",
      boundAt: "2026-08-20T00:00:00.000Z",
    };
    fixture.registry.attachLiveEnvironmentProvider({
      async capture() {
        return {
          capturedAt: "2026-08-20T00:01:00.000Z",
          browser: [],
          execution: [],
          providers: [{
            id: "provider-directory",
            label: "Provider directory",
            state: "ready" as const,
            evidence: "runtime-reported",
            detail: "post-switch observation",
            facets: [],
          }],
          storage: [],
          extension: [],
          workspaceIndex: { state: "not-observed" as const, detail: "No workspace index." },
          limitations: [],
        };
      },
    });
    const requests: string[] = [];
    const transport: InferenceTransport = {
      id: binding.transportId,
      posture: "local",
      async *stream(request) {
        requests.push(request.model);
        yield { type: "text-delta", text: "switched" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const model: Model<Api> = {
      ...fixture.model,
      id: binding.modelId,
      name: binding.modelId,
      provider: binding.providerId,
      api: "openai-completions",
    };
    const session = await fixture.runtime.createSession({
      model,
      transport,
      activeInferenceBinding: binding,
      manifest: {
        systemPrompt: "prompt",
        providerId: binding.providerId,
        model: binding.modelId,
        workspaceId: "ws-runtime",
      },
    });

    await fixture.journal.setSessionModel(session.id, "qwen3:latest");
    const result = await fixture.runtime.prompt(session.id, "after switch");
    expect(result.outcome).toBe("completed");
    expect(requests).toEqual(["qwen3:latest"]);
    expect(result.receipt?.model).toBe("qwen3:latest");
    const record = await fixture.journal.getSession(session.id);
    const events = await fixture.journal.readEvents(session.id);
    const requested = events.find((event) => event.type === "turn.requested");
    const snapshot = canonicalLiveEnvironmentSnapshot(
      (requested?.payload as { liveEnvironment?: unknown } | undefined)?.liveEnvironment,
    );
    expect(snapshot).toBeDefined();
    expect(snapshot?.inference).toMatchObject({ providerId: "ollama", model: "qwen3:latest" });
    expect(await verifyLiveEnvironmentSnapshot(snapshot!)).toBe(true);
    expect(await auditSessionHistory({ session: record!, events })).toMatchObject({
      status: "verified",
      findings: [],
    });
    expect(record?.title).toBe("after switch");
  });

  it("does not rename a Prime conversation before exact route refusal", async () => {
    const fixture = await makeRuntimeFixture();
    const binding = {
      version: 2 as const,
      connectionId: "ollama-loopback",
      connectionGeneration: 1,
      providerId: "ollama",
      providerLabel: "Ollama",
      providerRevision: 1,
      transportId: "ollama-openai-local-v1",
      protocol: "openai-compatible" as const,
      authMethod: "local-none" as const,
      transportBoundary: "loopback-local" as const,
      modelId: "gemma3:latest",
      boundAt: "2026-08-20T00:00:00.000Z",
    };
    let transportId = binding.transportId;
    const transport: InferenceTransport = {
      get id() { return transportId; },
      posture: "local",
      async *stream() { throw new Error("must not stream"); },
    };
    const model: Model<Api> = {
      ...fixture.model,
      id: binding.modelId,
      name: binding.modelId,
      provider: binding.providerId,
      api: "openai-completions",
    };
    const session = await fixture.runtime.createSession({
      model,
      transport,
      activeInferenceBinding: binding,
      manifest: {
        systemPrompt: "prompt",
        providerId: binding.providerId,
        model: binding.modelId,
        workspaceId: "ws-runtime",
      },
    });
    const before = await fixture.journal.getSession(session.id);
    const eventsBefore = await fixture.journal.readEvents(session.id);
    transportId = "other-transport";

    await expect(fixture.runtime.prompt(session.id, "must not rename"))
      .rejects.toThrow(/transport is pinned/u);
    expect(await fixture.journal.getSession(session.id)).toEqual(before);
    expect(await fixture.journal.readEvents(session.id)).toEqual(eventsBefore);
  });

  it("uses an equivalent active v2 route to upgrade a historical v1 Prime model", async () => {
    const base = {
      connectionId: "anthropic-main",
      connectionGeneration: 2,
      providerId: "anthropic",
      providerLabel: "Anthropic",
      providerRevision: 1,
      authMethod: "api-key" as const,
      transportBoundary: "provider-tls" as const,
      modelId: "claude-current",
      boundAt: "2026-08-20T00:00:00.000Z",
    };
    const manifest = await createSessionManifest({
      systemPrompt: "prompt",
      providerId: "anthropic-messages-v1",
      model: base.modelId,
      tools: [],
      workspaceId: "ws-runtime",
      inferenceBinding: { ...base, version: 1 },
    });
    const active = {
      ...base,
      version: 2 as const,
      transportId: "anthropic-messages-v1",
      protocol: "anthropic-messages" as const,
    };

    expect(() => primeModelFromManifest(manifest))
      .toThrow(/requires an exact active v2 inference binding/u);
    expect(primeModelFromManifest(manifest, active)).toMatchObject({
      provider: "anthropic",
      api: "anthropic-messages",
    });
  });

  it("routes prompts through the runtime registry and lists durable sessions", async () => {
    const fixture = await makeRuntimeFixture();
    fixture.registration.setResponses([fauxAssistantMessage("runtime answer")]);
    const session = await fixture.runtime.createSession({
      model: fixture.model,
      streamFn: streamSimple,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: fixture.model.id,
        workspaceId: "ws-runtime",
      },
    });
    const result = await fixture.runtime.prompt(session.id, "hello");
    expect(result.outcome).toBe("completed");
    expect(result.text).toContain("runtime answer");
    expect((await fixture.journal.getSession(session.id))?.title).toBe("hello");
    const events = await fixture.journal.readEvents(session.id);
    expect(events.some((event) => event.type === "conversation.named")).toBe(false);
    expect(events.some((event) =>
      event.type === "inference.usage"
      && (event.payload as { source?: string } | undefined)?.source === "conversation-naming"
    )).toBe(false);

    const other = await fixture.runtime.createSession({
      model: fixture.model,
      streamFn: streamSimple,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: fixture.model.id,
        workspaceId: "ws-runtime",
      },
    });
    const listed = await fixture.runtime.listSessions();
    const ids = listed.map((record) => record.id);
    expect(ids).toContain(session.id);
    expect(ids).toContain(other.id);
    expect(listed).toHaveLength(2);
  });

  it("attaches to a durable session record, refuses duplicates and unknown ids", async () => {
    const fixture = await makeRuntimeFixture();
    fixture.registration.setResponses([fauxAssistantMessage("attached answer")]);
    const manifest = await createSessionManifest({
      systemPrompt: "prompt",
      providerId: "faux",
      model: fixture.model.id,
      tools: fixture.registry.definitions(),
      workspaceId: "ws-runtime",
      securityPosture: "local",
    });
    const record = await fixture.journal.createSession("to attach", manifest);

    const session = await fixture.runtime.attachSession({
      sessionId: record.id,
      model: fixture.model,
      streamFn: streamSimple,
    });
    expect(session.id).toBe(record.id);
    expect(session.manifest).toEqual(manifest);
    const result = await fixture.runtime.prompt(record.id, "hi");
    expect(result.outcome).toBe("completed");

    await expect(
      fixture.runtime.attachSession({ sessionId: record.id, model: fixture.model }),
    ).rejects.toThrow(`Session ${record.id} is already attached to this runtime.`);
    await expect(
      fixture.runtime.attachSession({ sessionId: "does-not-exist", model: fixture.model }),
    ).rejects.toThrow("Unknown session: does-not-exist");
  });

  it("routes abortTurn and refuses unknown sessions", async () => {
    const fixture = await makeRuntimeFixture();
    await expect(fixture.runtime.prompt("missing", "hi")).rejects.toThrow("Unknown prime session: missing.");
    await expect(fixture.runtime.abortTurn("missing")).rejects.toThrow("Unknown prime session: missing.");

    const slow = await makeRuntimeFixture({ tokensPerSecond: 5 });
    slow.registration.setResponses([fauxAssistantMessage("slow ".repeat(400))]);
    const session = await slow.runtime.createSession({
      model: slow.model,
      streamFn: streamSimple,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: slow.model.id,
        workspaceId: "ws-runtime",
      },
    });
    const promptPromise = slow.runtime.prompt(session.id, "slow prompt");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(session.getActiveTurnId()).toBeDefined();
    await slow.runtime.abortTurn(session.id, "runtime stop");
    const result = await promptPromise;
    expect(result.outcome).toBe("cancelled");
    expect(result.reason).toBe("runtime stop");
  });

  it("serializes disposal: one session fully tears down before the next begins", async () => {
    const fixture = await makeRuntimeFixture();
    const options = (id: string) => ({
      model: fixture.model,
      streamFn: streamSimple,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: fixture.model.id,
        workspaceId: "ws-runtime",
      },
      title: id,
    });
    const first = await fixture.runtime.createSession(options("first"));
    const second = await fixture.runtime.createSession(options("second"));

    const order: string[] = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const firstDispose = first.dispose.bind(first);
    const secondDispose = second.dispose.bind(second);
    first.dispose = async (reason: string) => {
      order.push("first:start");
      await delay(40);
      await firstDispose(reason);
      order.push("first:end");
    };
    second.dispose = async (reason: string) => {
      order.push("second:start");
      await secondDispose(reason);
      order.push("second:end");
    };

    await fixture.runtime.dispose();
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(fixture.runtime.getSession(first.id)).toBeUndefined();

    await fixture.runtime.dispose(); // idempotent
    await expect(
      fixture.runtime.createSession(options("third")),
    ).rejects.toThrow("The prime runtime is disposed.");
    void options;
  });

  it("gate: journal classification and fork refusals are fail-closed", async () => {
    // The classification is the gate's, so an empty journal is unclaimed land
    // rather than airship-core; the local copy that said otherwise kept the
    // first-turn selection marker from being written.
    expect(sessionRuntimeKind([])).toBe("unpinned");
    expect(sessionRuntimeKind([{ type: "turn.requested" }])).toBe("airship-core");
    expect(sessionRuntimeKind([{ type: "prime.kernel.job.started" }])).toBe("prime");
    expect(sessionRuntimeKind([{ type: PRIME_EVENT_TYPES.sessionRuntimeSelected }])).toBe("prime");
    // Historical journals remain readable even though no current writer uses this name.
    expect(sessionRuntimeKind([{ type: "prime.session.runtime.seal" }])).toBe("prime");

    const transport: InferenceTransport = {
      id: "faux",
      posture: "local",
      async *stream() {
        throw new Error("gate tests never stream through the transport");
      },
    };
    const fixture = await makeRuntimeFixture();

    // Explicit Prime selection on a fresh journal is admitted.
    const manifest = await createSessionManifest({
      systemPrompt: "prompt",
      providerId: "faux",
      model: fixture.model.id,
      tools: fixture.registry.definitions(),
      workspaceId: "ws-runtime",
      securityPosture: "local",
    });
    /*
     * A fresh journal is unpinned, so Prime is admitted and the current
     * runtime-selection marker is written before the session runs. It lands
     * even when this deliberately unusable transport later fails the turn.
     */
    const plain = await fixture.journal.createSession("plain", manifest);
    await expect(
      runPrimeTurn({
        sessionId: plain.id,
        content: "hi",
        runtime: "prime",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    const selected = await fixture.journal.readEvents(plain.id);
    expect(selected.filter((event) => event.type === PRIME_EVENT_TYPES.sessionRuntimeSelected)).toHaveLength(1);
    expect(selected.some((event) => event.type === "prime.session.runtime.seal")).toBe(false);

    // The default path — no explicit `runtime` — takes the same branch, and
    // the current selection marker is written exactly once per journal.
    const defaulted = await fixture.journal.createSession("defaulted", manifest);
    await expect(
      runPrimeTurn({
        sessionId: defaulted.id,
        content: "hi",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    await expect(
      runPrimeTurn({
        sessionId: defaulted.id,
        content: "again",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    const defaultedEvents = await fixture.journal.readEvents(defaulted.id);
    expect(defaultedEvents.filter((event) => event.type === PRIME_EVENT_TYPES.sessionRuntimeSelected)).toHaveLength(1);
    expect(defaultedEvents.some((event) => event.type === "prime.session.runtime.seal")).toBe(false);

    // Durable airship turn history is what refuses prime, not the mere
    // presence of a creation record.
    const airship = await fixture.journal.createSession("airship", manifest);
    await fixture.journal.append(airship.id, [
      { type: "turn.requested", turnId: "t-1", payload: { content: "hi" } },
      { type: "inference.started", turnId: "t-1", payload: { step: 0 } },
    ]);
    await expect(
      runPrimeTurn({
        sessionId: airship.id,
        content: "hi",
        runtime: "prime",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("fork the session to use the PRIME runtime");

    /*
     * The same refusal without an explicit `runtime`. Reading the pin out of
     * the journal and calling it the selection made both guards vacuous: the
     * Prime engine ran on an airship-core session and flipped its durable
     * runtime kind. Entering this function is the request; the journal either
     * admits it or refuses it.
     */
    const airshipHistoryBefore = await fixture.journal.readEvents(airship.id);
    await expect(
      runPrimeTurn({
        sessionId: airship.id,
        content: "hi",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("fork the session to use the PRIME runtime");
    expect(await fixture.journal.readEvents(airship.id)).toEqual(airshipHistoryBefore);
    expect(sessionRuntimeKind(await fixture.journal.readEvents(airship.id))).toBe("airship-core");

    /*
     * The mirror case. An explicit `runtime: "airship-core"` on an unpinned
     * journal fell through both guards and ran the Prime engine anyway, leaving
     * the session pinned to the engine the caller had just declined.
     */
    const declined = await fixture.journal.createSession("declined", manifest);
    const declinedBefore = await fixture.journal.readEvents(declined.id);
    await expect(
      runPrimeTurn({
        sessionId: declined.id,
        content: "hi",
        runtime: "airship-core",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("this entry point runs the PRIME runtime");
    expect(await fixture.journal.readEvents(declined.id)).toEqual(declinedBefore);
    expect(sessionRuntimeKind(await fixture.journal.readEvents(declined.id))).toBe("unpinned");

    // Provider-pin mismatch names fork the session.
    const wrongTransport: InferenceTransport = { ...transport, id: "not-faux" };
    await expect(
      runPrimeTurn({
        sessionId: plain.id,
        content: "hi",
        transport: wrongTransport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("fork the session");

    // A Prime-pinned session (prime.* records in its journal) refuses airship-core selection.
    fixture.registration.setResponses([fauxAssistantMessage("prime answer")]);
    const primeSession = await fixture.runtime.createSession({
      model: fixture.model,
      streamFn: streamSimple,
      manifest: {
        systemPrompt: "prompt",
        providerId: "faux",
        model: fixture.model.id,
        workspaceId: "ws-runtime",
      },
    });
    const completed = await fixture.runtime.prompt(primeSession.id, "go");
    expect(completed.outcome).toBe("completed");
    const primeEvents = await fixture.journal.readEvents(primeSession.id);
    expect(primeEvents.some((event) => event.type.startsWith("prime."))).toBe(true);
    await expect(
      runPrimeTurn({
        sessionId: primeSession.id,
        content: "again",
        runtime: "airship-core",
        transport,
        tools: fixture.registry,
        journal: fixture.journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("fork the session to use the airship-core runtime");
  });

  it("refuses malformed imported v2 authority before writing the Prime marker", async () => {
    const backend = new MemoryJournalBackend();
    const journal = new EventJournal(backend);
    const registry = new ToolRegistry();
    const binding = {
      version: 2 as const,
      connectionId: "ollama-loopback",
      connectionGeneration: 1,
      providerId: "ollama",
      providerLabel: "Ollama",
      providerRevision: 1,
      transportId: "ollama-openai-local-v1",
      protocol: "openai-compatible" as const,
      authMethod: "local-none" as const,
      transportBoundary: "loopback-local" as const,
      modelId: "gemma3:latest",
      boundAt: "2026-08-20T00:00:00.000Z",
    };
    const valid = await createSessionManifest({
      systemPrompt: "prompt",
      providerId: binding.providerId,
      model: binding.modelId,
      inferenceBinding: binding,
      tools: [],
      workspaceId: "ws-runtime",
    });
    await backend.createSession({
      id: "malformed-prime",
      title: "Malformed Prime",
      manifest: {
        ...valid,
        inferenceBinding: { ...binding, credential: "must-not-persist" },
      } as unknown as typeof valid,
      createdAt: valid.createdAt,
      updatedAt: valid.createdAt,
      headSequence: 0,
      headDigest: "genesis",
    });
    const transport: InferenceTransport = {
      id: binding.transportId,
      posture: "local",
      async *stream() { throw new Error("must not stream"); },
    };

    await expect(runPrimeTurn({
      sessionId: "malformed-prime",
      content: "must not write",
      transport,
      activeInferenceBinding: binding,
      tools: registry,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow(/unknown or missing field/u);
    expect(await journal.readEvents("malformed-prime")).toEqual([]);
    expect((await journal.getSession("malformed-prime"))?.headSequence).toBe(0);
  });

  it.each(["provider-tls", "e2ee-attestable"] as const)(
    "keeps historical Prime v1 %s authority read-only without a v2 bridge",
    async (transportBoundary) => {
      const journal = new EventJournal(new MemoryJournalBackend());
      const registry = new ToolRegistry();
      const historicalBinding = {
        version: 1 as const,
        connectionId: "ollama-loopback",
        connectionGeneration: 1,
        providerId: "ollama",
        providerLabel: "Ollama",
        providerRevision: 1,
        authMethod: "local-none" as const,
        transportBoundary,
        modelId: "gemma3:latest",
        boundAt: "2026-08-20T00:00:00.000Z",
      };
      const manifest = await createSessionManifest({
        systemPrompt: "historical only",
        providerId: "ollama-openai-local-v1",
        model: historicalBinding.modelId,
        inferenceBinding: historicalBinding,
        tools: [],
        workspaceId: "ws-runtime",
      });
      const session = await journal.createSession("Historical Prime", manifest);
      const before = await journal.getSession(session.id);
      const eventsBefore = await journal.readEvents(session.id);
      const transport: InferenceTransport = {
        id: manifest.providerId,
        posture: "local",
        async *stream() { throw new Error("must not stream"); },
      };

      await expect(runPrimeTurn({
        sessionId: session.id,
        content: "must not write",
        transport,
        tools: registry,
        journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      })).rejects.toThrow(/requires its exact active v2 inference binding/u);
      expect(await journal.getSession(session.id)).toEqual(before);
      expect(await journal.readEvents(session.id)).toEqual(eventsBefore);
    },
  );

  it("upgrades known Prime v1 authority with canonical provider provenance", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const registry = new ToolRegistry();
    const historicalBinding = {
      version: 1 as const,
      connectionId: "chutes-primary",
      connectionGeneration: 2,
      providerId: "chutes",
      providerLabel: "Chutes",
      providerRevision: 1,
      authMethod: "api-key" as const,
      transportBoundary: "provider-tls" as const,
      modelId: "model-a",
      boundAt: "2026-08-20T00:00:00.000Z",
    };
    const activeBinding = {
      ...historicalBinding,
      version: 2 as const,
      transportId: "chutes-openai-compatible-v1",
      protocol: "openai-compatible" as const,
    };
    const manifest = await createSessionManifest({
      systemPrompt: "historical route",
      providerId: activeBinding.transportId,
      model: historicalBinding.modelId,
      inferenceBinding: historicalBinding,
      tools: [],
      workspaceId: "ws-runtime",
      securityPosture: "plaintext-remote",
    });
    const session = await journal.createSession("Historical Prime upgrade", manifest);
    registry.attachLiveEnvironmentProvider({
      async capture() {
        return {
          capturedAt: "2026-08-20T00:01:00.000Z",
          browser: [], execution: [], providers: [], storage: [], extension: [], limitations: [],
          workspaceIndex: { state: "not-observed" as const, detail: "Not attached." },
        };
      },
    });
    const transport: InferenceTransport = {
      id: activeBinding.transportId,
      posture: "plaintext-remote",
      async *stream() {
        yield { type: "text-delta", text: "prime upgraded" };
        yield { type: "completed", finishReason: "stop" };
      },
    };

    const result = await runPrimeTurn({
      sessionId: session.id,
      content: "continue",
      transport,
      activeInferenceBinding: activeBinding,
      tools: registry,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });
    expect(result.content).toBe("prime upgraded");
    const record = (await journal.getSession(session.id))!;
    const events = await journal.readEvents(session.id);
    expect(events.find((event) => event.type === "inference.started")?.payload)
      .toMatchObject({ providerId: "chutes", model: "model-a" });
    expect(events.find((event) => event.type === "assistant.completed")?.payload)
      .toMatchObject({ receipt: { provider: "chutes", model: "model-a" } });
    expect(events.find((event) => event.type === "turn.requested")?.payload)
      .toMatchObject({ liveEnvironment: { inference: { providerId: "chutes", model: "model-a" } } });
    await expect((await import("../../core/session-audit")).auditSessionHistory({ session: record, events }))
      .resolves.toMatchObject({ status: "verified" });
  });

  it.each([
    ["no active protocol binding", undefined],
    ["a wrong active protocol", "openai-responses" as const],
  ] as const)("refuses Prime same-ID v2 transport with %s before custody", async (_label, protocol) => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const registry = new ToolRegistry();
    const binding = {
      version: 2 as const,
      connectionId: "ollama-loopback",
      connectionGeneration: 1,
      providerId: "ollama",
      providerLabel: "Ollama",
      providerRevision: 1,
      transportId: "ollama-openai-local-v1",
      protocol: "openai-compatible" as const,
      authMethod: "local-none" as const,
      transportBoundary: "loopback-local" as const,
      modelId: "gemma3:latest",
      boundAt: "2026-08-20T00:00:00.000Z",
    };
    const manifest = await createSessionManifest({
      systemPrompt: "protocol proof",
      providerId: binding.providerId,
      model: binding.modelId,
      inferenceBinding: binding,
      tools: [],
      workspaceId: "ws-runtime",
    });
    const session = await journal.createSession("Prime protocol proof", manifest);
    const before = await journal.getSession(session.id);
    const eventsBefore = await journal.readEvents(session.id);
    const transport: InferenceTransport = {
      id: binding.transportId,
      posture: "local",
      async *stream() { throw new Error("must not stream"); },
    };

    await expect(runPrimeTurn({
      sessionId: session.id,
      content: "must not write",
      transport,
      ...(protocol ? { activeInferenceBinding: { ...binding, protocol } } : {}),
      tools: registry,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow(protocol
      ? /does not match the session's v2 authority/u
      : /exact active v2 inference binding/u);
    expect(await journal.getSession(session.id)).toEqual(before);
    expect(await journal.readEvents(session.id)).toEqual(eventsBefore);
  });

  it("separates a v2 provider pin from its exact transport and refuses drift before journaling", async () => {
    const fixture = await makeRuntimeFixture();
    const binding = {
      version: 2 as const,
      connectionId: "ollama-loopback",
      connectionGeneration: 1,
      providerId: "ollama",
      providerLabel: "Ollama",
      providerRevision: 1,
      transportId: "ollama-openai-local-v1",
      protocol: "openai-compatible" as const,
      authMethod: "local-none" as const,
      transportBoundary: "loopback-local" as const,
      modelId: fixture.model.id,
      boundAt: "2026-08-20T00:00:00.000Z",
    };
    const manifest = await createSessionManifest({
      systemPrompt: "prompt",
      providerId: binding.providerId,
      model: binding.modelId,
      inferenceBinding: binding,
      tools: fixture.registry.definitions(),
      workspaceId: "ws-runtime",
      securityPosture: "local",
    });
    const transport = (id: string): InferenceTransport => ({
      id,
      posture: "local",
      async *stream() { throw new Error("authority test stops after admission"); },
    });

    const admitted = await fixture.journal.createSession("admitted", manifest);
    await expect(runPrimeTurn({
      sessionId: admitted.id,
      content: "hi",
      transport: transport(binding.transportId),
      activeInferenceBinding: binding,
      tools: fixture.registry,
      journal: fixture.journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow("authority test stops after admission");
    expect((await fixture.journal.readEvents(admitted.id)).some(
      (event) => event.type === PRIME_EVENT_TYPES.sessionRuntimeSelected,
    )).toBe(true);

    const refused = await fixture.journal.createSession("refused", manifest);
    await expect(runPrimeTurn({
      sessionId: refused.id,
      content: "hi",
      transport: transport("ollama"),
      activeInferenceBinding: binding,
      tools: fixture.registry,
      journal: fixture.journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow(/transport is pinned to ollama-openai-local-v1/u);
    expect((await fixture.journal.readEvents(refused.id)).some(
      (event) => event.type.startsWith("prime."),
    )).toBe(false);
  });

});
