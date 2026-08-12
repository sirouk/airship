import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "./contracts";
import { createSessionManifest, runTurn } from "./agent";
import { EventJournal } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";
import { ToolRegistry, allowAllForTests } from "../tools/registry";
import { messagePartsFromDurableEvents } from "../ui/chat/message-parts";

class ReasoningTransport implements InferenceTransport {
  readonly id = "reasoning-test-transport";
  readonly posture = "local" as const;
  readonly requests: InferenceRequest[] = [];

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "progress", phase: "reasoning" };
    yield { type: "reasoning-delta", text: "First the plan: read the prompt. " };
    yield { type: "reasoning-delta", text: "Then answer it in one sentence." };
    yield { type: "text-delta", text: "The answer." };
    yield { type: "usage", inputTokens: 42, outputTokens: 3 };
    yield { type: "completed", finishReason: "stop" };
  }
}

/** Ends its chain on the delta that crosses the 200,000-character record cap. */
class OverflowingReasoningTransport implements InferenceTransport {
  readonly id = "reasoning-test-transport";
  readonly posture = "local" as const;

  async *stream(_request: InferenceRequest): AsyncIterable<InferenceEvent> {
    yield { type: "reasoning-delta", text: "a".repeat(199_999) };
    yield { type: "reasoning-delta", text: "b".repeat(5_000) };
    yield { type: "text-delta", text: "The answer." };
    yield { type: "completed", finishReason: "stop" };
  }
}

describe("reasoning the provider chose to expose becomes a durable, replayable part of the turn", () => {
  it("journals one turn.reasoning record before the answer, projects it summary+full, and the audit verifies", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const transport = new ReasoningTransport();
    const tools = new ToolRegistry();
    const manifest = await createSessionManifest({
      systemPrompt: "test thread",
      providerId: transport.id,
      model: "reasoning/model-a",
      tools: tools.definitions(),
      workspaceId: "memory://reasoning-display",
    });
    const session = await journal.createSession("Thread", manifest);

    const result = await runTurn({
      sessionId: session.id,
      content: "Think out loud",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    const reasoning = result.events.filter((event) => event.type === "turn.reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.payload).toEqual({
      text: "First the plan: read the prompt. Then answer it in one sentence.",
    });
    // The reasoning is its own record, before the answer it belongs to.
    const answer = result.events.find((event) => event.type === "assistant.completed")!;
    expect(reasoning[0]!.sequence).toBeLessThan(answer.sequence);

    const parts = messagePartsFromDurableEvents(result.events, { turnId: result.turnId });
    const part = parts.find((candidate) => candidate.kind === "reasoning-summary");
    expect(part).toMatchObject({
      label: "Reasoning",
      summary: "First the plan: read the prompt. Then answer it in one sentence.",
      full: "First the plan: read the prompt. Then answer it in one sentence.",
    });

    const updated = (await journal.getSession(session.id))!;
    const events = await journal.readEvents(session.id);
    const audit = await auditSessionHistory({ session: updated, events });
    expect(audit.status).toBe("verified");
  });

  it("says so when the delta that ends the chain is the one the cap cuts", async () => {
    // The shape that used to lie: one long chain whose *final* delta crosses
    // the cap, then `completed`. Nothing arrives afterwards to notice, so the
    // record read as complete while ~5,000 characters of it were gone.
    const journal = new EventJournal(new MemoryJournalBackend());
    const transport = new OverflowingReasoningTransport();
    const tools = new ToolRegistry();
    const manifest = await createSessionManifest({
      systemPrompt: "test thread",
      providerId: transport.id,
      model: "reasoning/model-a",
      tools: tools.definitions(),
      workspaceId: "memory://reasoning-overflow",
    });
    const session = await journal.createSession("Thread", manifest);

    const result = await runTurn({
      sessionId: session.id,
      content: "Think out loud, at length",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    const reasoning = result.events.find((event) => event.type === "turn.reasoning")!;
    const payload = reasoning.payload as { text: string; truncated?: true };
    expect(payload.text).toHaveLength(200_000);
    expect(payload.truncated).toBe(true);

    const parts = messagePartsFromDurableEvents(result.events, { turnId: result.turnId });
    expect(parts.find((candidate) => candidate.kind === "reasoning-summary"))
      .toMatchObject({ label: "Reasoning · record truncated" });
  });
});
