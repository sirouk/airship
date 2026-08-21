import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "../../core/contracts";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { createSessionManifest } from "../../core/session-manifest";
import { allowAllForTests } from "../../tools/registry";
import { createLoadedAirshipToolRegistry } from "../../tools/tool-bundle";
import { MemoryWorkspace } from "../../workspace/memory";
import { runPrimeTurn } from "./runtime";
import { primeToolDefinitions } from "./tool-surface";

/**
 * What the model is actually told, on a real turn.
 *
 * The layered prompt was wired only into the child factory, so a subagent
 * spawned by `rlm()` knew its working directory, the date, its security
 * posture and its real tool inventory, while the conversation that spawned it
 * knew none of it — it received the Agent Profile prompt alone. That is not
 * visible in any unit test of the composer, because the composer was always
 * correct; the wiring was missing. So this test reads the system prompt off
 * the wire, which is the only place the difference shows.
 */
function capturingTransport(): { transport: InferenceTransport; seen: () => string } {
  let captured = "";
  return {
    seen: () => captured,
    transport: {
      id: "faux",
      posture: "local",
      async *stream(request: InferenceRequest): AsyncGenerator<InferenceEvent> {
        captured = request.systemPrompt ?? "";
        yield { type: "text-delta", text: "ok" };
        yield { type: "usage", inputTokens: 3, outputTokens: 1 };
        yield { type: "completed", finishReason: "stop" };
      },
    },
  };
}

const OPERATOR_PROMPT = "You are an outcome-owning systems engineer operating the Airship edge workspace.";

async function briefedTurn() {
  const journal = new EventJournal(new MemoryJournalBackend());
  const workspace = new MemoryWorkspace();
  // The full bundle, because the point of the briefing is the tools a real
  // conversation pins — retrieval and memory included.
  const registry = await createLoadedAirshipToolRegistry({ workspace, journal });
  const manifest = await createSessionManifest({
    systemPrompt: OPERATOR_PROMPT,
    providerId: "faux",
    model: "faux/model",
    tools: [...primeToolDefinitions({ workspace, airship: registry })],
    workspaceId: "memory://prime-briefing",
    securityPosture: "local",
  });
  const session = await journal.createSession("Briefed", manifest);
  const { transport, seen } = capturingTransport();

  const result = await runPrimeTurn({
    sessionId: session.id,
    content: "hello",
    transport,
    tools: registry,
    workspace,
    journal,
    approvalPolicy: allowAllForTests,
    signal: new AbortController().signal,
  });

  return { result, prompt: seen(), manifest, journal, sessionId: session.id };
}

describe("the prompt a root conversation is actually sent", () => {
  it("keeps the operator's Agent Profile prompt as the identity, at the top", async () => {
    const { prompt } = await briefedTurn();
    expect(prompt.startsWith(OPERATOR_PROMPT)).toBe(true);
    // Two competing role statements is worse than either alone.
    expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
  });

  it("briefs the turn on where and when it is running", async () => {
    const { prompt } = await briefedTurn();
    expect(prompt).toContain("Working directory: /workspace");
    expect(prompt).toContain("Current date: ");
    expect(prompt).toContain("Runtime: prime-runtime");
    expect(prompt).toContain("Inference path: local");
  });

  it("names every tool the session pinned, not a six-entry constant", async () => {
    const { prompt, manifest } = await briefedTurn();
    expect(manifest.tools.length).toBeGreaterThan(20);
    for (const tool of manifest.tools) {
      expect(prompt, `${tool.name} is pinned but the model is never told it exists`).toContain(`- ${tool.name}:`);
    }
  });

  it("names the retrieval lane, which is the one an agent has to be told about", async () => {
    // A model reaches for `search_text` because grep is the obvious move.
    // Hybrid retrieval is only reached if something says it is there.
    const { prompt } = await briefedTurn();
    expect(prompt).toContain("- search_context:");
    expect(prompt).toContain("- search_memory:");
  });

  it("does not rewrite the manifest, whose digest pins what the person authored", async () => {
    const { manifest, journal, sessionId } = await briefedTurn();
    const stored = await journal.getSession(sessionId);
    expect(stored?.manifest.systemPrompt).toBe(OPERATOR_PROMPT);
    expect(stored?.manifest.systemPromptDigest).toBe(manifest.systemPromptDigest);
  });

  it("fits, so no layer is silently clipped by the inventory getting longer", async () => {
    const { prompt } = await briefedTurn();
    // A thirty-four-tool inventory is the largest thing this layer carries;
    // if it ever pushes the base layer past its cap, the clip lands on the
    // runtime facts and the failure is invisible at runtime.
    expect(prompt).not.toContain("[prime: system prompt layer truncated]");
    expect(prompt.length).toBeLessThan(48_000);
  });

  it("still completes the turn", async () => {
    const { result } = await briefedTurn();
    expect(result.content).toBe("ok");
  });
});
