import { describe, expect, it } from "vitest";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "../../core/contracts";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { createSessionManifest } from "../../core/session-manifest";
import { allowAllForTests } from "../../tools/registry";
import { createWorkspaceToolRegistry } from "../../tools/workspace-tools";
import { MemoryWorkspace } from "../../workspace/memory";
import { runPrimeTurn } from "./runtime";
import { primeToolDefinitions } from "./tool-surface";

/**
 * A prime turn, driven end to end, with a transport that actually answers.
 *
 * Every existing `runPrimeTurn` test hands the turn a transport that throws on
 * sight and asserts it rejects — which proves the gate and the seal and
 * nothing about a turn that works. So a whole class of failure had no test at
 * all: the surface composition, the subagent registry construction, the
 * heartbeat and harness lookups and the manifest digest check all run before
 * the first inference event, and any one of them throwing is indistinguishable
 * from "the provider refused". It presented as
 * "Turn failed — nothing had arrived yet" on every conversation, which is
 * exactly what a person sees and exactly what a passing suite did not.
 */
function scriptedTransport(): InferenceTransport {
  return {
    id: "faux",
    posture: "local",
    async *stream(_request: InferenceRequest): AsyncGenerator<InferenceEvent> {
      yield { type: "text-delta", text: "ok" };
      yield { type: "usage", inputTokens: 3, outputTokens: 1 };
      yield { type: "completed", finishReason: "stop" };
    },
  };
}

async function fixture(pinPrimeSurface: boolean) {
  const journal = new EventJournal(new MemoryJournalBackend());
  const workspace = new MemoryWorkspace();
  const registry = createWorkspaceToolRegistry(workspace);
  const manifest = await createSessionManifest({
    systemPrompt: "be exact",
    providerId: "faux",
    model: "faux/model",
    tools: pinPrimeSurface
      ? [...primeToolDefinitions({ workspace, airship: registry })]
      : registry.definitions(),
    workspaceId: "memory://prime-turn",
    securityPosture: "local",
  });
  const session = await journal.createSession("Prime turn", manifest);
  return { journal, workspace, registry, session };
}

describe("a prime turn that is allowed to succeed", () => {
  it("completes with the full prime surface when the manifest pinned it", async () => {
    const { journal, workspace, registry, session } = await fixture(true);

    const result = await runPrimeTurn({
      sessionId: session.id,
      content: "hello",
      transport: scriptedTransport(),
      tools: registry,
      workspace,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    expect(result.content).toBe("ok");
    const events = await journal.readEvents(session.id);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
  });

  it("refuses a conversation pinned to a different tool set, naming the fork", async () => {
    // No fallback, on purpose. A conversation pinned to a narrower surface was
    // a different agent, and running it on a wider one would leave two
    // conversations claiming the same engine while reaching different tools.
    // The session already answers that, and the answer names the remedy.
    const { journal, workspace, registry, session } = await fixture(false);

    await expect(runPrimeTurn({
      sessionId: session.id,
      content: "hello",
      transport: scriptedTransport(),
      tools: registry,
      workspace,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow(/fork the session/i);
  });

  it("completes with no workspace at all, which is the engine-only shape", async () => {
    const { journal, registry, session } = await fixture(false);

    const result = await runPrimeTurn({
      sessionId: session.id,
      content: "hello",
      transport: scriptedTransport(),
      tools: registry,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    });

    expect(result.content).toBe("ok");
  });
});
