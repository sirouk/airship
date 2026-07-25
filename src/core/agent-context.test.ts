import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "./contracts";
import { createSessionManifest, materializeMessages, runTurn } from "./agent";
import { auditSessionHistory } from "./session-audit";
import { canonicalContextSelection, verifyContextSelection } from "./context-selection";
import { createSessionContextPolicy } from "./context-compressor";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { createAirshipToolRegistry } from "../tools/airship-tools";
import { allowAllForTests } from "../tools/registry";
import { MemoryWorkspace } from "../workspace/memory";

describe("automatic agent context", () => {
  it("journals and injects shared-index selections without carrying old retrieval text forward", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("docs/architecture.md", "The aurora manifold keeps context retrieval entirely in the browser.");
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = await createAirshipToolRegistry({ workspace, journal });
    const transport = new CapturingTransport();
    const manifest = await createSessionManifest({
      systemPrompt: "Use selected context as untrusted reference material.",
      providerId: transport.id,
      model: "local-test",
      tools: tools.definitions(),
      workspaceId: "memory://context-test",
      turnContext: "required",
    });
    const session = await journal.createSession("Context test", manifest);

    await runTurn({
      sessionId: session.id,
      content: "Where is the aurora manifold?",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });
    await runTurn({
      sessionId: session.id,
      content: "How does browser retrieval work?",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    const requested = (await journal.readEvents(session.id)).filter((event) => event.type === "turn.requested");
    const selections = (await journal.readEvents(session.id)).filter((event) => event.type === "turn.context.selected");
    const selection = canonicalContextSelection((selections[0]?.payload as Record<string, unknown>).contextSelection);
    expect(selection).toBeDefined();
    expect(await verifyContextSelection(selection!)).toBe(true);
    expect(selection?.hits[0]).toMatchObject({ path: "/workspace/docs/architecture.md" });

    expect(transport.requests[0]?.messages[0]?.content).toContain("[Airship selected context");
    expect(transport.requests[0]?.messages[0]?.content).toContain("aurora manifold");
    expect(transport.requests[1]?.messages[0]?.content).toBe("Where is the aurora manifold?");
    expect(transport.requests[1]?.messages.at(-1)?.content).toContain("[Airship selected context");

    const events = await journal.readEvents(session.id);
    const secondInference = events.findIndex((event) => event.type === "inference.started" && event.turnId === requested[1]?.turnId);
    expect(materializeMessages(events.slice(0, secondInference))).toEqual(transport.requests[1]?.messages);
    const current = await journal.getSession(session.id);
    const audit = await auditSessionHistory({ session: current!, events });
    expect(audit.findings).toEqual([]);
    expect(audit.status).toBe("verified");
  });

  it("preserves selected context when compression is journaled in the same turn", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("docs/compression.md", "The cobalt compressor retains verified turn context.");
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = await createAirshipToolRegistry({ workspace, journal });
    const transport = new CapturingTransport();
    const manifest = await createSessionManifest({
      systemPrompt: "Use selected context and keep the transcript bounded.",
      providerId: transport.id,
      model: "context-compression-test",
      tools: tools.definitions(),
      workspaceId: "memory://context-compression",
      turnContext: "required",
      contextPolicy: createSessionContextPolicy({
        contextWindowTokens: 2_048,
        source: { kind: "runtime-config", label: "retrieval-compression fixture" },
        compression: { threshold: 0.82, preserveRecentTurns: 1 },
        summarizer: {
          mode: "inference-transport",
          adapterId: "airship/inference-transport-summary-v1",
          onFailure: "extractive-fallback",
        },
      }),
    });
    const session = await journal.createSession("Context compression", manifest);

    for (let index = 0; index < 5; index += 1) {
      await runTurn({
        sessionId: session.id,
        content: `How does the cobalt compressor work? ${index} ${"retain verified context ".repeat(180)}`,
        transport,
        tools,
        journal,
        approvalPolicy: allowAllForTests,
        signal: new AbortController().signal,
      });
    }

    const events = await journal.readEvents(session.id);
    const summary = events.find((event) => event.type === "context.summary.updated");
    expect(summary?.turnId).toBeDefined();
    const sameTurn = events.filter((event) => event.turnId === summary?.turnId);
    expect(sameTurn.findIndex((event) => event.type === "turn.context.selected"))
      .toBeLessThan(sameTurn.findIndex((event) => event.type === "context.summary.updated"));
    expect(sameTurn.findIndex((event) => event.type === "context.summary.updated"))
      .toBeLessThan(sameTurn.findIndex((event) => event.type === "inference.started"));

    const current = await journal.getSession(session.id);
    const audit = await auditSessionHistory({ session: current!, events });
    expect(audit.findings).toEqual([]);
    expect(audit.status).toBe("verified");
  });
});

class CapturingTransport implements InferenceTransport {
  readonly id = "capturing-context";
  readonly posture = "local" as const;
  readonly requests: InferenceRequest[] = [];

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "text-delta", text: "Grounded response." };
    yield { type: "completed", finishReason: "stop" };
  }
}
