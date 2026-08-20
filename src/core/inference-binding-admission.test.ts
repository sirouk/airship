import { describe, expect, it } from "vitest";
import type {
  InferenceTransport,
  SessionInferenceBindingV1,
  SessionInferenceBindingV2,
  SessionManifest,
} from "./contracts";
import { runTurn } from "./agent";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { createSessionManifest } from "./session-manifest";
import { auditSessionHistory } from "./session-audit";
import { allowAllForTests, ToolRegistry } from "../tools/registry";

const binding: SessionInferenceBindingV2 = Object.freeze({
  version: 2,
  connectionId: "ollama-loopback",
  connectionGeneration: 3,
  providerId: "ollama",
  providerLabel: "Ollama",
  providerRevision: 1,
  transportId: "ollama-openai-local-v1",
  protocol: "openai-compatible",
  authMethod: "local-none",
  transportBoundary: "loopback-local",
  modelId: "gemma3:latest",
  boundAt: "2026-08-20T00:00:00.000Z",
});

function transport(id = binding.transportId): InferenceTransport {
  return {
    id,
    posture: "local",
    async *stream() {
      yield { type: "text-delta" as const, text: "local answer" };
      yield { type: "completed" as const, finishReason: "stop" as const };
    },
  };
}

async function manifest(): Promise<SessionManifest> {
  return createSessionManifest({
    systemPrompt: "answer locally",
    providerId: binding.providerId,
    model: binding.modelId,
    inferenceBinding: binding,
    tools: [],
    workspaceId: "workspace",
    securityPosture: "local",
  });
}

describe("core turn inference authority", () => {
  it("journals canonical provider identity while invoking the exact split transport", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const session = await journal.createSession("split identity", await manifest());
    const tools = new ToolRegistry();

    const result = await runTurn({
      sessionId: session.id,
      content: "hello",
      transport: transport(),
      activeInferenceBinding: binding,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    expect(result.content).toBe("local answer");
    const record = (await journal.getSession(session.id))!;
    const events = await journal.readEvents(session.id);
    const started = events.find((event) => event.type === "inference.started");
    const completed = events.find((event) => event.type === "assistant.completed");
    expect(started?.payload).toMatchObject({ providerId: "ollama", model: binding.modelId });
    expect(completed?.payload).toMatchObject({ receipt: { provider: "ollama" } });
    expect((await auditSessionHistory({ session: record, events })).status).toBe("verified");
  });

  it("rejects a provider receipt for a foreign turn before a successful terminal is journaled", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const session = await journal.createSession("foreign receipt", await manifest());
    const poisoned: InferenceTransport = {
      id: binding.transportId,
      posture: "local",
      async *stream() {
        yield { type: "text-delta" as const, text: "must not complete" };
        yield {
          type: "completed" as const,
          finishReason: "stop" as const,
          receipt: {
            version: 1 as const,
            origin: "provider" as const,
            attestation: "none" as const,
            receiptId: "urn:receipt:foreign",
            sessionId: "other-session",
            turnId: "other-turn",
            createdAt: "2026-08-20T00:00:00.000Z",
            provider: binding.providerId,
            model: "other-model",
          },
        };
      },
    };

    await expect(runTurn({
      sessionId: session.id,
      content: "hello",
      transport: poisoned,
      activeInferenceBinding: binding,
      tools: new ToolRegistry(),
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow(/identity does not match the active turn/u);

    const record = (await journal.getSession(session.id))!;
    const events = await journal.readEvents(session.id);
    expect(events.some((event) => event.type === "assistant.completed")).toBe(false);
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn.failed");
    const report = await auditSessionHistory({ session: record, events });
    expect(report.status).toBe("incomplete");
    expect(report.findings.some((finding) => finding.code === "RECEIPT_IDENTITY_MISMATCH")).toBe(false);
  });

  it.each([
    ["no active protocol binding", undefined],
    ["a wrong active protocol", { ...binding, protocol: "openai-responses" as const }],
  ] as const)("refuses same-ID v2 transport with %s before mutation", async (_label, activeInferenceBinding) => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const session = await journal.createSession("Protocol proof", await manifest());
    const before = await journal.getSession(session.id);
    const eventsBefore = await journal.readEvents(session.id);

    await expect(runTurn({
      sessionId: session.id,
      content: "must not write",
      transport: transport(binding.transportId),
      ...(activeInferenceBinding ? { activeInferenceBinding } : {}),
      tools: new ToolRegistry(),
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow(activeInferenceBinding
      ? /does not match the session's v2 authority/u
      : /exact active v2 inference binding/u);
    expect(await journal.getSession(session.id)).toEqual(before);
    expect(await journal.readEvents(session.id)).toEqual(eventsBefore);
  });

  it("upgrades a known v1 route while journaling canonical provider provenance", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const historicalBinding: SessionInferenceBindingV1 = {
      version: 1,
      connectionId: "chutes-primary",
      connectionGeneration: 2,
      providerId: "chutes",
      providerLabel: "Chutes",
      providerRevision: 1,
      authMethod: "api-key",
      transportBoundary: "provider-tls",
      modelId: "model-a",
      boundAt: "2026-08-20T00:00:00.000Z",
    };
    const activeBinding: SessionInferenceBindingV2 = {
      ...historicalBinding,
      version: 2,
      transportBoundary: "provider-tls",
      transportId: "chutes-openai-compatible-v1",
      protocol: "openai-compatible",
    };
    const historical = await createSessionManifest({
      systemPrompt: "historical route",
      providerId: activeBinding.transportId,
      model: historicalBinding.modelId,
      inferenceBinding: historicalBinding,
      tools: [],
      workspaceId: "workspace",
      securityPosture: "plaintext-remote",
    });
    const session = await journal.createSession("Historical upgrade", historical);
    const tools = new ToolRegistry();
    tools.attachLiveEnvironmentProvider({
      async capture() {
        return {
          capturedAt: "2026-08-20T00:01:00.000Z",
          browser: [], execution: [], providers: [], storage: [], extension: [], limitations: [],
          workspaceIndex: { state: "not-observed" as const, detail: "Not attached." },
        };
      },
    });
    const upgradedTransport: InferenceTransport = {
      id: activeBinding.transportId,
      posture: "plaintext-remote",
      async *stream() {
        yield { type: "text-delta", text: "upgraded answer" };
        yield { type: "completed", finishReason: "stop" };
      },
    };

    await runTurn({
      sessionId: session.id,
      content: "continue",
      transport: upgradedTransport,
      activeInferenceBinding: activeBinding,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });
    const record = (await journal.getSession(session.id))!;
    const events = await journal.readEvents(session.id);
    expect(events.find((event) => event.type === "inference.started")?.payload)
      .toMatchObject({ providerId: "chutes", model: "model-a" });
    expect(events.find((event) => event.type === "assistant.completed")?.payload)
      .toMatchObject({ receipt: { provider: "chutes", model: "model-a" } });
    expect(events.find((event) => event.type === "turn.requested")?.payload)
      .toMatchObject({ liveEnvironment: { inference: { providerId: "chutes", model: "model-a" } } });
    expect((await auditSessionHistory({ session: record, events })).status).toBe("verified");
  });

  it.each(["provider-tls", "e2ee-attestable"] as const)(
    "keeps historical v1 %s authority read-only without an exact active v2 bridge",
    async (transportBoundary) => {
      const journal = new EventJournal(new MemoryJournalBackend());
      const historicalBinding: SessionInferenceBindingV1 = {
        version: 1,
        connectionId: binding.connectionId,
        connectionGeneration: binding.connectionGeneration,
        providerId: binding.providerId,
        providerLabel: binding.providerLabel,
        providerRevision: binding.providerRevision,
        authMethod: binding.authMethod,
        transportBoundary,
        modelId: binding.modelId,
        boundAt: binding.boundAt,
      };
      const historical = await createSessionManifest({
        systemPrompt: "historical only",
        providerId: binding.transportId,
        model: binding.modelId,
        inferenceBinding: historicalBinding,
        tools: [],
        workspaceId: "workspace",
        securityPosture: "local",
      });
      const session = await journal.createSession("Historical", historical);
      const before = await journal.getSession(session.id);
      const eventsBefore = await journal.readEvents(session.id);

      await expect(runTurn({
        sessionId: session.id,
        content: "must not write",
        transport: transport(binding.transportId),
        tools: new ToolRegistry(),
        journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      })).rejects.toThrow(/requires its exact active v2 inference binding/u);
      expect(await journal.getSession(session.id)).toEqual(before);
      expect(await journal.readEvents(session.id)).toEqual(eventsBefore);
    },
  );

  it("refuses malformed imported binding data before the first journal write", async () => {
    const backend = new MemoryJournalBackend();
    const journal = new EventJournal(backend);
    const valid = await manifest();
    const malformed = {
      ...valid,
      inferenceBinding: { ...binding, credential: "must-not-persist" },
    } as unknown as SessionManifest;
    await backend.createSession({
      id: "imported-malformed",
      title: "Imported malformed",
      manifest: malformed,
      createdAt: valid.createdAt,
      updatedAt: valid.createdAt,
      headSequence: 0,
      headDigest: "genesis",
    });

    await expect(runTurn({
      sessionId: "imported-malformed",
      content: "must not write",
      transport: transport(),
      activeInferenceBinding: binding,
      tools: new ToolRegistry(),
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow(/unknown or missing field/u);
    expect((await journal.getSession("imported-malformed"))?.headSequence).toBe(0);
    expect(await journal.readEvents("imported-malformed")).toEqual([]);
  });
});
