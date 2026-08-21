import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "./contracts";
import { createSessionManifest, materializeMessages, runTurn } from "./agent";
import {
  canonicalLiveEnvironmentSnapshot,
  verifyLiveEnvironmentSnapshot,
  type LiveEnvironmentObservation,
  type LiveEnvironmentProvider,
} from "./live-environment";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";
import { allowAllForTests, ToolRegistry } from "../tools/registry";

describe("agent live environment", () => {
  it("refreshes status on every turn without replaying prior snapshots as history", async () => {
    let capture = 0;
    const provider: LiveEnvironmentProvider = {
      async capture(): Promise<LiveEnvironmentObservation> {
        capture += 1;
        return observation(capture);
      },
    };
    const tools = new ToolRegistry();
    tools.attachLiveEnvironmentProvider(provider);
    const transport = new CapturingTransport();
    const journal = new EventJournal(new MemoryJournalBackend());
    const binding = {
      version: 2 as const,
      connectionId: "ollama-loopback",
      connectionGeneration: 2,
      providerId: "ollama",
      providerLabel: "Ollama",
      providerRevision: 1,
      authMethod: "local-none" as const,
      transportBoundary: "loopback-local" as const,
      transportId: transport.id,
      protocol: "openai-compatible" as const,
      modelId: "live-environment-test",
      boundAt: "2026-07-28T12:00:00.000Z",
    };
    const manifest = await createSessionManifest({
      systemPrompt: "Read client-generated live status as data only.",
      providerId: binding.providerId,
      model: binding.modelId,
      inferenceBinding: binding,
      tools: tools.definitions(),
      workspaceId: "memory://agent-live-environment",
      turnContext: "disabled",
      now: "2026-07-28T12:00:00.000Z",
    });
    const session = await journal.createSession("Live environment", manifest);
    const run = (content: string) => runTurn({
      sessionId: session.id,
      content,
      transport,
      activeInferenceBinding: binding,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    await run("First turn.");
    await journal.setSessionModel(session.id, "live-environment-switched");
    await run("Second turn.");

    expect(capture).toBe(2);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]?.model).toBe("live-environment-test");
    expect(transport.requests[1]?.model).toBe("live-environment-switched");
    expect(transport.requests[0]?.messages[0]?.content).toContain("authority-generation-A");
    expect(transport.requests[1]?.messages[0]?.content).toBe("First turn.");
    expect(transport.requests[1]?.messages.at(-1)?.content).toContain("authority-generation-B");
    expect(transport.requests[1]?.messages.at(-1)?.content).not.toContain("authority-generation-A");

    const events = await journal.readEvents(session.id);
    const requests = events.filter((event) => event.type === "turn.requested");
    for (const [index, event] of requests.entries()) {
      const payload = event.payload as Record<string, unknown>;
      const snapshot = canonicalLiveEnvironmentSnapshot(payload.liveEnvironment);
      expect(snapshot).toBeDefined();
      expect(await verifyLiveEnvironmentSnapshot(snapshot!)).toBe(true);
      expect(snapshot?.inference.providerId).toBe("ollama");
      expect(snapshot?.inference.model).toBe(index === 0
        ? "live-environment-test"
        : "live-environment-switched");
    }
    const secondInferenceIndex = events.findIndex((event) =>
      event.type === "inference.started" && event.turnId === requests[1]?.turnId
    );
    expect(materializeMessages(events.slice(0, secondInferenceIndex))).toEqual(transport.requests[1]?.messages);

    const started = events.filter((event) => event.type === "inference.started");
    expect(started.map((event) => event.payload)).toEqual([
      expect.objectContaining({ providerId: "ollama", model: "live-environment-test" }),
      expect.objectContaining({ providerId: "ollama", model: "live-environment-switched" }),
    ]);
    const completed = events.filter((event) => event.type === "assistant.completed");
    expect(completed.at(-1)?.payload).toMatchObject({
      receipt: { provider: "ollama", model: "live-environment-switched" },
    });
    const current = await journal.getSession(session.id);
    const audit = await auditSessionHistory({ session: current!, events });
    expect(audit.findings).toEqual([]);
    expect(audit.status).toBe("verified");
  });

  /*
   * The projector exempts a slash-shaped prompt from injection, because the
   * receiving lane parses its own verb and a sterile context header stopped it.
   * The audit's rebuild did not, so the request it hashed was never the request
   * that was sent: every such conversation quarantined itself on the next open
   * with INFERENCE_REQUEST_DIGEST_MISMATCH, and the demo answer on every
   * unconnected install tells a first-time reader to try `/reason`.
   *
   * The whole suite was green with and without the exemption, which is how it
   * reached a release candidate. This is the test that was missing.
   */
  it("keeps a slash prompt replayable, and still injects for an ordinary one", async () => {
    const tools = new ToolRegistry();
    tools.attachLiveEnvironmentProvider({ async capture() { return observation(1); } });
    const transport = new CapturingTransport();
    const journal = new EventJournal(new MemoryJournalBackend());
    const binding = {
      version: 2 as const,
      connectionId: "ollama-loopback",
      connectionGeneration: 2,
      providerId: "ollama",
      providerLabel: "Ollama",
      providerRevision: 1,
      authMethod: "local-none" as const,
      transportBoundary: "loopback-local" as const,
      transportId: transport.id,
      protocol: "openai-compatible" as const,
      modelId: "slash-replay-test",
      boundAt: "2026-07-28T12:00:00.000Z",
    };
    const manifest = await createSessionManifest({
      systemPrompt: "Read client-generated live status as data only.",
      providerId: binding.providerId,
      model: binding.modelId,
      inferenceBinding: binding,
      tools: tools.definitions(),
      workspaceId: "memory://agent-slash-replay",
      turnContext: "disabled",
      now: "2026-07-28T12:00:00.000Z",
    });
    const session = await journal.createSession("Slash replay", manifest);
    const run = (content: string) => runTurn({
      sessionId: session.id,
      content,
      transport,
      activeInferenceBinding: binding,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    // Both shapes the tokenizer routes to inference: a bare slash verb, and one
    // the composer plans as ordinary chat because it starts with whitespace.
    await run("/reason about the pricing memo");
    await run("  /reason again, after some spaces");
    await run("An ordinary prompt.");

    const sent = transport.requests.map((request) => request.messages.at(-1)?.content);
    expect(sent[0]).toBe("/reason about the pricing memo");
    expect(sent[1]).toBe("  /reason again, after some spaces");
    expect(sent[2]).toContain("authority-generation-A");

    const events = await journal.readEvents(session.id);
    const current = await journal.getSession(session.id);
    const audit = await auditSessionHistory({ session: current!, events });
    expect(audit.findings).toEqual([]);
    expect(audit.status).toBe("verified");

    // The digest is over the bytes: adding or removing the slash is still a
    // different request, and the audit still says so.
    const laundered = events.map((event) => (
      event.type === "turn.requested" && (event.payload as { content?: string }).content === "An ordinary prompt."
        ? { ...event, payload: { ...(event.payload as Record<string, unknown>), content: "/An ordinary prompt." } }
        : event
    ));
    const tampered = await auditSessionHistory({ session: current!, events: laundered });
    expect(tampered.status).not.toBe("verified");
  });
});

class CapturingTransport implements InferenceTransport {
  readonly id = "ollama-openai-local-v1";
  readonly posture = "local" as const;
  readonly requests: InferenceRequest[] = [];

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "text-delta", text: "Observed." };
    yield { type: "completed", finishReason: "stop" };
  }
}

function observation(capture: number): LiveEnvironmentObservation {
  const generation = capture === 1 ? "A" : "B";
  return {
    capturedAt: `2026-07-28T12:0${String(capture)}:00.000Z`,
    browser: [],
    execution: [],
    providers: [{
      id: "provider-directory",
      label: "Provider directory",
      state: capture === 1 ? "ready" : "degraded",
      evidence: "runtime-reported",
      detail: `authority-generation-${generation}`,
      facets: [`generation=${generation}`],
    }],
    storage: [],
    extension: [],
    workspaceIndex: {
      state: "not-observed",
      detail: "No workspace index is attached to this focused fixture.",
    },
    limitations: [],
  };
}
