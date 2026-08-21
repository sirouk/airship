import { describe, expect, it } from "vitest";
import { ToolRegistry, allowAllForTests } from "../tools/registry";
import { createSessionManifest, runTurn, type AgentSignal } from "./agent";
import {
  sealContextSelection,
  type CanonicalContextSelection,
  type TurnContextProvider,
} from "./context-selection";
import type { InferenceEvent, InferenceRequest, InferenceTransport, SessionManifest } from "./contracts";
import { sha256 } from "./hash";
import { EventJournal, type DurableEvent, type SessionRecord } from "./journal";
import { MemoryJournalBackend } from "./memory-journal";
import { auditSessionHistory } from "./session-audit";

describe("agent preprocessing lifecycle", () => {
  it("journals one failed terminal after a required context provider rejects", async () => {
    const provider: TurnContextProvider = {
      async selectForTurn() {
        throw new Error("retrieval unavailable");
      },
    };
    const fixture = await createFixture({ turnContext: "required", provider });

    await expect(fixture.run("Find the deployment contract.")).rejects.toThrow("retrieval unavailable");

    const events = await fixture.events();
    expect(turnTypes(events)).toEqual(["turn.requested", "turn.failed"]);
    expect(events.filter((event) => terminal(event.type))).toHaveLength(1);
    expect(fixture.transport.requests).toHaveLength(0);
    await expectVerified(fixture.journal, fixture.sessionId);
  });

  it("persists one cancellation even when retrieval aborts the turn signal", async () => {
    const controller = new AbortController();
    const provider: TurnContextProvider = {
      async selectForTurn() {
        const reason = new DOMException("Stopped during retrieval", "AbortError");
        controller.abort(reason);
        throw reason;
      },
    };
    const fixture = await createFixture({ turnContext: "required", provider, controller });

    await expect(fixture.run("Stop this retrieval.")).rejects.toMatchObject({ name: "AbortError" });

    const events = await fixture.events();
    expect(turnTypes(events)).toEqual(["turn.requested", "turn.cancelled"]);
    expect(events.filter((event) => terminal(event.type))).toHaveLength(1);
    await expectVerified(fixture.journal, fixture.sessionId);
  });

  it.each([
    ["non-canonical", async () => ({ version: 2 }) as unknown as CanonicalContextSelection],
    ["digest-invalid", async () => {
      const selection = await validSelection("Find the manifest.");
      return { ...selection, selectionDigest: await sha256("wrong selection") };
    }],
    ["wrong-query", async () => validSelection("A different request.")],
  ])("rejects a %s selection before journaling or inference", async (_label, selectForTurn) => {
    const provider: TurnContextProvider = { selectForTurn };
    const fixture = await createFixture({ turnContext: "required", provider });

    await expect(fixture.run("Find the manifest.")).rejects.toThrow(/turn-context provider returned/u);

    const events = await fixture.events();
    expect(turnTypes(events)).toEqual(["turn.requested", "turn.failed"]);
    expect(events.some((event) => event.type === "turn.context.selected")).toBe(false);
    expect(fixture.transport.requests).toHaveLength(0);
    await expectVerified(fixture.journal, fixture.sessionId);
  });

  it("rejects otherwise valid v2 lineage outside the pinned session scope", async () => {
    const provider: TurnContextProvider = {
      async selectForTurn(query) {
        return validScopedSelection(query, { sessionId: "another-session" });
      },
    };
    const fixture = await createFixture({ turnContext: "required", provider });

    await expect(fixture.run("Find scoped context.")).rejects.toThrow("outside this session's pinned scope");

    expect(turnTypes(await fixture.events())).toEqual(["turn.requested", "turn.failed"]);
    expect(fixture.transport.requests).toHaveLength(0);
  });

  it("fails closed when retrieval is required but no provider is attached", async () => {
    const fixture = await createFixture({ turnContext: "required" });

    await expect(fixture.run("Retrieve context.")).rejects.toThrow("no provider is attached");

    expect(turnTypes(await fixture.events())).toEqual(["turn.requested", "turn.failed"]);
    expect(fixture.transport.requests).toHaveLength(0);
  });

  it("does not consult an attached provider when the immutable policy disables retrieval", async () => {
    let calls = 0;
    const provider: TurnContextProvider = {
      async selectForTurn(query) {
        calls += 1;
        return validSelection(query);
      },
    };
    const fixture = await createFixture({ turnContext: "disabled", provider });

    await fixture.run("Use only the transcript.");

    expect(calls).toBe(0);
    expect(fixture.transport.requests).toHaveLength(1);
    expect((await fixture.events()).some((event) => event.type === "turn.context.selected")).toBe(false);
  });

  it("rejects legacy request-embedded context under an explicit disabled pin", async () => {
    const fixture = await createFixture({ turnContext: "disabled" });
    const selection = await validSelection("Legacy context.");
    await fixture.journal.append(fixture.sessionId, [
      {
        type: "turn.requested",
        turnId: "legacy-embedded",
        payload: { content: "Legacy context.", contextSelection: selection as never },
      },
      {
        type: "turn.failed",
        turnId: "legacy-embedded",
        payload: { error: "fixture terminal" },
      },
    ]);

    const [session, events] = await Promise.all([
      fixture.journal.getSession(fixture.sessionId),
      fixture.events(),
    ]);
    const report = await auditSessionHistory({ session: session!, events });
    expect(report.findings.map((finding) => finding.code)).toContain("TURN_CONTEXT_LEGACY_EMBED_INVALID");
    await expect(fixture.run("Continue.")).rejects.toThrow("legacy request-embedded turn context");
    expect((await fixture.events()).filter((event) => event.type === "turn.requested")).toHaveLength(1);
  });

  it("refuses to overlap a pre-existing unterminated provider turn", async () => {
    const fixture = await createFixture({ turnContext: "disabled" });
    await fixture.journal.append(fixture.sessionId, [{
      type: "turn.requested",
      turnId: "open-turn",
      payload: { content: "Still running." },
    }]);

    await expect(fixture.run("Do not overlap.")).rejects.toThrow("has no durable terminal event");

    const requests = (await fixture.events()).filter((event) => event.type === "turn.requested");
    expect(requests.map((event) => event.turnId)).toEqual(["open-turn"]);
    expect(fixture.transport.requests).toHaveLength(0);
  });

  it("accepts historical embedded context for replay but keeps protocol-v1 sessions read-only", async () => {
    let calls = 0;
    const provider: TurnContextProvider = {
      async selectForTurn(query) {
        calls += 1;
        return validSelection(query);
      },
    };
    const journal = new EventJournal(new MemoryJournalBackend());
    const tools = new ToolRegistry();
    tools.attachTurnContextProvider(provider);
    const transport = new RecordingTransport(false);
    const current = await createSessionManifest({
      systemPrompt: "Replay a historical protocol-v1 session.",
      providerId: transport.id,
      model: "legacy-test",
      tools: tools.definitions(),
      workspaceId: "memory://legacy",
    });
    const { turnContext: _turnContext, ...legacyFields } = current;
    const historical: SessionManifest = { ...legacyFields, protocolVersion: 1 };
    const session = await journal.createSession("Historical", historical);
    const selection = await validSelection("Retrieve with legacy semantics.");
    await journal.append(session.id, [
      {
        type: "turn.requested",
        turnId: "legacy-turn",
        payload: {
          content: "Retrieve with legacy semantics.",
          contextSelection: selection as never,
        },
      },
      {
        type: "turn.failed",
        turnId: "legacy-turn",
        payload: { error: "historical terminal" },
      },
    ]);

    await expect(runTurn({
      sessionId: session.id,
      content: "Start a current turn.",
      transport,
      tools,
      journal,
      approvalPolicy: allowAllForTests,
      signal: new AbortController().signal,
    })).rejects.toThrow("Protocol-v1 sessions are replay-only");

    expect(calls).toBe(0);
    expect((await journal.readEvents(session.id)).some((event) => event.type === "turn.context.selected")).toBe(false);
    await expectVerified(journal, session.id);
  });

  it("uses posture-neutral reasoning status and isolates throwing observers", async () => {
    const fixture = await createFixture({ turnContext: "disabled", reasoning: true });
    const signals: AgentSignal[] = [];
    await fixture.run("Think carefully.", (signal) => signals.push(signal));

    const statuses = signals.flatMap((signal) => signal.type === "status" ? [signal.status] : []);
    expect(statuses).toContain("reasoning");
    expect(statuses.join(" ")).not.toMatch(/enclave|private/iu);

    const throwing = await createFixture({ turnContext: "disabled", reasoning: true });
    await expect(throwing.run("Finish despite the observer.", () => {
      throw new Error("observer failed");
    })).resolves.toMatchObject({ content: "Done." });
    const terminals = (await throwing.events()).filter((event) => terminal(event.type));
    expect(terminals.map((event) => event.type)).toEqual(["turn.completed"]);
  });

  it("reconciles a terminal append whose cloud acknowledgement is lost", async () => {
    const fixture = await createFixture({
      turnContext: "disabled",
      backend: new CommitThenLoseAcknowledgementBackend(),
    });

    await expect(fixture.run("Commit exactly once.")).rejects.toThrow("terminal acknowledgement lost");

    const events = await fixture.events();
    expect(events.filter((event) => terminal(event.type)).map((event) => event.type))
      .toEqual(["turn.completed"]);
    await expectVerified(fixture.journal, fixture.sessionId);
  });

  it("reports an explicit indeterminate audit failure when storage refuses every terminal", async () => {
    const fixture = await createFixture({
      turnContext: "disabled",
      backend: new RefuseTerminalBackend(),
    });

    await expect(fixture.run("Storage is unavailable."))
      .rejects.toThrow("terminal audit event could not be persisted");

    expect((await fixture.events()).filter((event) => terminal(event.type))).toHaveLength(0);
  });
});

async function createFixture(options: Readonly<{
  turnContext: "required" | "disabled";
  provider?: TurnContextProvider;
  controller?: AbortController;
  reasoning?: boolean;
  backend?: MemoryJournalBackend;
}>) {
  const journal = new EventJournal(options.backend ?? new MemoryJournalBackend());
  const tools = new ToolRegistry();
  if (options.provider) tools.attachTurnContextProvider(options.provider);
  const transport = new RecordingTransport(options.reasoning ?? false);
  const manifest = await createSessionManifest({
    systemPrompt: "Test the turn lifecycle.",
    providerId: transport.id,
    model: "lifecycle-test",
    tools: tools.definitions(),
    workspaceId: "memory://lifecycle",
    turnContext: options.turnContext,
  });
  const session = await journal.createSession("Lifecycle", manifest);
  const controller = options.controller ?? new AbortController();
  return {
    journal,
    sessionId: session.id,
    transport,
    run(content: string, onSignal?: (signal: AgentSignal) => void) {
      return runTurn({
        sessionId: session.id,
        content,
        transport,
        tools,
        journal,
        approvalPolicy: allowAllForTests,
        signal: controller.signal,
        ...(onSignal ? { onSignal } : {}),
      });
    },
    events: () => journal.readEvents(session.id),
  };
}

class RecordingTransport implements InferenceTransport {
  readonly id = "preprocessing-test";
  readonly posture = "plaintext-remote" as const;
  readonly requests: InferenceRequest[] = [];

  constructor(private readonly reasoning: boolean) {}

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    if (this.reasoning) yield { type: "progress", phase: "reasoning" };
    yield { type: "text-delta", text: "Done." };
    yield { type: "completed", finishReason: "stop" };
  }
}

class CommitThenLoseAcknowledgementBackend extends MemoryJournalBackend {
  private lost = false;

  override async append(
    sessionId: string,
    expectedHead: { sequence: number; digest: string },
    events: DurableEvent[],
  ): Promise<SessionRecord> {
    const result = await super.append(sessionId, expectedHead, events);
    if (!this.lost && events.some((event) => terminal(event.type))) {
      this.lost = true;
      throw new Error("terminal acknowledgement lost");
    }
    return result;
  }
}

class RefuseTerminalBackend extends MemoryJournalBackend {
  override async append(
    sessionId: string,
    expectedHead: { sequence: number; digest: string },
    events: DurableEvent[],
  ): Promise<SessionRecord> {
    if (events.some((event) => terminal(event.type))) throw new Error("terminal storage refused");
    return super.append(sessionId, expectedHead, events);
  }
}

async function validSelection(query: string): Promise<CanonicalContextSelection> {
  const text = "Pinned workspace context.";
  const textDigest = await sha256(text);
  const generationDigest = await sha256("generation");
  return sealContextSelection({
    version: 1,
    queryDigest: await sha256(query),
    generationDigest,
    workspaceSnapshotDigest: await sha256("workspace"),
    selectedAt: "2026-07-23T12:00:00.000Z",
    maxHits: 1,
    maxBytes: 4_096,
    selectedBytes: new TextEncoder().encode(text).byteLength,
    truncated: false,
    hits: [{
      path: "/workspace/README.md",
      revision: "working-tree",
      contentDigest: await sha256("source"),
      chunkId: await sha256("chunk"),
      chunkIndex: 0,
      score: 1,
      text,
      textDigest,
    }],
  });
}

async function validScopedSelection(
  query: string,
  scope: Readonly<{ sessionId?: string; workspaceId?: string }>,
): Promise<CanonicalContextSelection> {
  const text = "Scoped workspace context.";
  const generationId = await sha256("scoped-generation");
  const workspaceSnapshotDigest = await sha256("scoped-workspace");
  return sealContextSelection({
    version: 2,
    queryDigest: await sha256(query),
    generationDigest: generationId,
    workspaceSnapshotDigest,
    selectedAt: "2026-07-23T12:00:00.000Z",
    maxHits: 1,
    maxBytes: 4_096,
    selectedBytes: new TextEncoder().encode(text).byteLength,
    truncated: false,
    hits: [{
      path: "/workspace/scoped.md",
      revision: "working-tree",
      contentDigest: await sha256("scoped-source"),
      chunkId: await sha256("scoped-chunk"),
      chunkIndex: 0,
      score: 1,
      text,
      textDigest: await sha256(text),
      corpus: "workspace",
      sourceId: "/workspace/scoped.md",
      lineageRef: generationId,
    }],
    lineage: {
      retriever: "airship-workspace-turn-context-v1",
      scope,
      generations: [{
        id: generationId,
        corpus: "workspace",
        sourceRevision: "working-tree",
        sourceDigest: workspaceSnapshotDigest,
        extractor: "test-extractor",
        chunker: "test-chunker",
        embedding: {
          provider: "test-embedding",
          dimensions: 3,
          posture: "deterministic-bootstrap",
        },
        indexFormat: "test-index-v1",
        persistence: "memory-only",
      }],
    },
  });
}

function turnTypes(events: readonly { type: string }[]): string[] {
  return events.filter((event) => event.type.startsWith("turn.")).map((event) => event.type);
}

function terminal(type: string): boolean {
  return type === "turn.completed" || type === "turn.failed" || type === "turn.cancelled";
}

async function expectVerified(journal: EventJournal, sessionId: string): Promise<void> {
  const [session, events] = await Promise.all([
    journal.getSession(sessionId),
    journal.readEvents(sessionId),
  ]);
  const report = await auditSessionHistory({ session: session!, events });
  expect(report.findings).toEqual([]);
  expect(report.status).toBe("verified");
}
