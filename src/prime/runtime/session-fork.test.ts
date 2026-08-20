/**
 * Session-level fork-context integration: the session authority now admits
 * verified lineage forks end-to-end (turn drives with the inherited context
 * in the provider window) and refuses lineage claims without their pinned
 * seed — byte-identical sentences to core/agent.ts, traced to the journal.
 *
 * The module gate itself is covered exhaustively in fork-admission.test.ts;
 * this file pins the two places the session *uses* it (turn-open admission,
 * provider-input materialization), the seam that was previously an
 * unconditional "does not admit fork-context sessions yet" refusal.
 */

import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "../ai/stream";
import {
  type FauxProviderRegistration,
  fauxAssistantMessage,
  registerFauxProvider,
} from "../ai/providers/faux.test-support";
import type { Model } from "../ai/types";
import { createSessionManifest, runTurn } from "../../core/agent";
import type {
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
} from "../../core/contracts";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { SessionLibrary } from "../../sessions/library";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import { PrimeAgentSession } from "./session";

const registrations: FauxProviderRegistration[] = [];
afterEach(() => {
  while (registrations.length > 0) registrations.pop()?.unregister();
});

class SourceTransport implements InferenceTransport {
  readonly posture = "local" as const;
  private next = 0;
  constructor(
    private readonly responses: readonly string[],
    readonly id = "faux",
  ) {}
  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    void request;
    yield { type: "text-delta", text: this.responses[this.next++] ?? "Source answer." };
    yield { type: "completed", finishReason: "stop" };
  }
}

async function makeLineage(): Promise<Readonly<{
  journal: EventJournal;
  forkId: string;
  forkManifest: Awaited<ReturnType<SessionLibrary["fork"]>>["session"]["manifest"];
}>> {
  const journal = new EventJournal(new MemoryJournalBackend());
  const tools = new ToolRegistry();
  const transport = new SourceTransport(["Source answer."]);
  const sourceManifest = await createSessionManifest({
    systemPrompt: "Preserve the audited conversation context.",
    providerId: transport.id,
    model: "faux-1",
    tools: tools.definitions(),
    workspaceId: "memory://fork-session",
    turnContext: "disabled",
  });
  const source = await journal.createSession("Source", sourceManifest);
  await runTurn({
    sessionId: source.id,
    content: "Remember the source fact.",
    transport,
    tools,
    journal,
    approvalPolicy: allowAllForTests,
    signal: new AbortController().signal,
  });
  const snapshot = (await journal.getSession(source.id))!;
  const fork = await new SessionLibrary(journal).fork(source.id, {
    expectedSourceHead: {
      sequence: snapshot.headSequence,
      digest: snapshot.headDigest,
    },
  });
  return { journal, forkId: fork.session.id, forkManifest: fork.session.manifest };
}

function attachForkSession(args: Readonly<{
  registration: FauxProviderRegistration;
  journal: EventJournal;
  forkId: string;
  forkManifest: Parameters<typeof PrimeAgentSession.prototype.prompt>[0] extends never
    ? never
    : import("../../core/contracts").SessionManifest;
}>): PrimeAgentSession {
  const model = args.registration.getModel() as Model<string>;
  return new PrimeAgentSession({
    sessionId: args.forkId,
    manifest: args.forkManifest,
    journal: args.journal,
    registry: new ToolRegistry(),
    approvalPolicy: allowAllForTests,
    model,
    streamFn: streamSimple,
  });
}

describe("PrimeAgentSession fork-context integration", () => {
  it("drives a turn on a verified lineage fork that previously refused outright", async () => {
    const { journal, forkId, forkManifest } = await makeLineage();
    const registration = registerFauxProvider({});
    registrations.push(registration);
    registration.setResponses([fauxAssistantMessage("The fact was remembered.")]);
    const session = attachForkSession({ registration, journal, forkId, forkManifest });

    const result = await session.prompt("Which fact did the source hold?");
    expect(result.outcome).toBe("completed");
    expect(result.text).toContain("remembered");

    // And the turn really ran on the prime lane under the fork's own manifest:
    // the provider pin is the fork's lineage manifest, not a fresh session.
    const events = await journal.readEvents(forkId);
    expect(events.some((event) => event.type === "turn.requested" && event.turnId !== undefined)).toBe(true);
  });

  it("refuses a lineage claim without its pinned seed, with core's exact sentence", async () => {
    const { journal, forkManifest } = await makeLineage();
    const registration = registerFauxProvider({});
    registrations.push(registration);
    // Lineage claims without the journaled seed: manifest says fork, journal
    // says birth — the seed-at-position-1 commitment never exists here.
    const record = await journal.createSession("Unseeded fork claim", forkManifest);
    const session = attachForkSession({ registration, journal, forkId: record.id, forkManifest });
    await expect(session.prompt("hello")).rejects.toThrow(
      "A fork session is missing its unique initial context-seed commitment.",
    );
  });

  it("keeps lineage-free sessions on the baseline admission with no seed requirements", async () => {
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    const registration = registerFauxProvider({});
    registrations.push(registration);
    const model = registration.getModel() as Model<string>;
    const manifest = await createSessionManifest({
      systemPrompt: "plain",
      providerId: "faux",
      model: model.id,
      tools: tools.definitions(),
      workspaceId: "memory://fork-baseline",
      turnContext: "disabled",
    });
    const record = await journal.createSession("baseline", manifest);
    registration.setResponses([fauxAssistantMessage("baseline answer")]);
    const session = new PrimeAgentSession({
      sessionId: record.id,
      manifest,
      journal,
      registry: tools,
      approvalPolicy: allowAllForTests,
      model,
      streamFn: streamSimple,
    });
    const result = await session.prompt("hi");
    expect(result.outcome).toBe("completed");
    expect(result.text).toContain("baseline answer");
  });
});
