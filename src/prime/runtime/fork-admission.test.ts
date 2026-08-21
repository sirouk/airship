/**
 * Fork-context admission tests for the prime session authority: a real fork
 * fixture built through SessionLibrary#fork, then the admission gate's
 * verdicts pinned byte-for-byte against the refusal sentences core/agent.ts
 * throws for the same evidence.
 */

import { describe, expect, it } from "vitest";
import { createSessionManifest, materializeMessages, runTurn } from "../../core/agent";
import type {
  InferenceEvent,
  InferenceRequest,
  InferenceTransport,
  JsonValue,
  SessionForkContextSeed,
  SessionManifest,
} from "../../core/contracts";
import { FORK_CONTEXT_EVENT_TYPE } from "../../core/fork-context";
import { stableStringify } from "../../core/hash";
import type { DurableEvent } from "../../core/journal";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { SessionLibrary } from "../../sessions/library";
import { allowAllForTests, ToolRegistry } from "../../tools/registry";
import {
  admitPrimeForkContext,
  primeMaterializeForkOptions,
  type PrimeForkAdmission,
} from "./fork-admission";

type ForkFixture = Readonly<{
  sourceId: string;
  sourceEvents: DurableEvent[];
  sourceManifest: SessionManifest;
  forkId: string;
  forkEvents: DurableEvent[];
  forkManifest: SessionManifest;
  seedEvent: DurableEvent;
  seedDigest: string;
}>;

async function makeForkFixture(): Promise<ForkFixture> {
  const journal = new EventJournal(new MemoryJournalBackend());
  const tools = new ToolRegistry();
  const transport = new CapturingTransport(["Source answer."]);
  const sourceManifest = await createSessionManifest({
    systemPrompt: "Preserve the audited conversation context.",
    providerId: transport.id,
    model: "fork-admission-test",
    tools: tools.definitions(),
    workspaceId: "memory://fork-admission",
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
  const sourceSnapshot = (await journal.getSession(source.id))!;
  const fork = await new SessionLibrary(journal).fork(source.id, {
    expectedSourceHead: {
      sequence: sourceSnapshot.headSequence,
      digest: sourceSnapshot.headDigest,
    },
  });
  const forkEvents = await journal.readEvents(fork.session.id);
  const seedEvent = forkEvents.find((event) => event.type === FORK_CONTEXT_EVENT_TYPE);
  if (!seedEvent) throw new Error("The fork fixture has no fork-context seed event.");
  return {
    sourceId: source.id,
    sourceEvents: await journal.readEvents(source.id),
    sourceManifest,
    forkId: fork.session.id,
    forkEvents,
    forkManifest: fork.session.manifest,
    seedEvent,
    seedDigest: (seedEvent.payload as unknown as SessionForkContextSeed).contextDigest,
  };
}

function expectAdmitted(admission: PrimeForkAdmission): Extract<PrimeForkAdmission, { ok: true }> {
  if (!admission.ok) throw new Error(`Admission refused unexpectedly: ${admission.reason}`);
  return admission;
}

describe("prime fork-context admission", () => {
  it("admits a valid lineage fork and exposes its verified seed digest", async () => {
    const fixture = await makeForkFixture();
    const admission = expectAdmitted(await admitPrimeForkContext({
      sessionId: fixture.forkId,
      events: fixture.forkEvents,
      manifest: fixture.forkManifest,
    }));

    expect(admission.verifiedForkContextDigest).toBe(fixture.seedDigest);
    expect(admission.forkContextScope).toEqual({
      sessionId: fixture.forkId,
      lineage: fixture.forkManifest.lineage,
    });
    // The returned digest is not decorative: materializeMessages admits the
    // inherited source context only when handed these exact options.
    expect(materializeMessages([...fixture.forkEvents], admission.materializeOptions)).toEqual([
      { role: "user", content: "Remember the source fact." },
      { role: "assistant", content: "Source answer." },
    ]);
  });

  it("rejects a fork whose journaled seed bytes no longer match its pinned digest", async () => {
    const fixture = await makeForkFixture();
    const tamperedSeed = structuredClone(fixture.seedEvent.payload) as Record<string, unknown>;
    (tamperedSeed.messages as Record<string, unknown>[])[0]!.content = "Rewritten source fact.";
    const tamperedEvents = fixture.forkEvents.map((event) =>
      event.eventId === fixture.seedEvent.eventId
        ? { ...event, payload: tamperedSeed as JsonValue }
        : event);
    expect(await admitPrimeForkContext({
      sessionId: fixture.forkId,
      events: tamperedEvents,
      manifest: fixture.forkManifest,
    })).toEqual({
      ok: false,
      reason: "The fork-context seed is malformed, out of scope, or has a digest mismatch.",
    });

    const swappedSeed = structuredClone(fixture.seedEvent.payload) as Record<string, unknown>;
    swappedSeed.contextDigest = `sha256:${"Z".repeat(43)}`;
    const swappedEvents = fixture.forkEvents.map((event) =>
      event.eventId === fixture.seedEvent.eventId
        ? { ...event, payload: swappedSeed as JsonValue }
        : event);
    expect(await admitPrimeForkContext({
      sessionId: fixture.forkId,
      events: swappedEvents,
      manifest: fixture.forkManifest,
    })).toEqual({
      ok: false,
      reason: "The fork-context seed is malformed, out of scope, or has a digest mismatch.",
    });
  });

  it("rejects a lineage fork whose seed is missing or moved off journal position 1", async () => {
    const fixture = await makeForkFixture();
    const missing = fixture.forkEvents.filter((event) => event.type !== FORK_CONTEXT_EVENT_TYPE);
    expect(await admitPrimeForkContext({
      sessionId: fixture.forkId,
      events: missing,
      manifest: fixture.forkManifest,
    })).toEqual({
      ok: false,
      reason: "A fork session is missing its unique initial context-seed commitment.",
    });

    // A seed anywhere other than events[1] is no commitment at all: swap the
    // creation event with the seed so position 1 holds session.created.
    const moved = [fixture.forkEvents[1]!, fixture.forkEvents[0]!, ...fixture.forkEvents.slice(2)];
    expect(moved[1]?.type).not.toBe(FORK_CONTEXT_EVENT_TYPE);
    expect(await admitPrimeForkContext({
      sessionId: fixture.forkId,
      events: moved,
      manifest: fixture.forkManifest,
    })).toEqual({
      ok: false,
      reason: "A fork session is missing its unique initial context-seed commitment.",
    });
  });

  it("flags a protocol-v1 lineage manifest as replay-only with the byte-identical core refusal", async () => {
    const fixture = await makeForkFixture();
    const { turnContext: _turnContext, ...legacyFields } = fixture.forkManifest;
    const v1Manifest: SessionManifest = { ...legacyFields, protocolVersion: 1 };
    expect(await admitPrimeForkContext({
      sessionId: fixture.forkId,
      events: fixture.forkEvents,
      manifest: v1Manifest,
    })).toEqual({
      ok: false,
      reason: "Protocol-v1 sessions are replay-only; fork the session before starting a new turn.",
    });
  });

  it("returns materialize options byte-equal to the literal core/agent.ts constructs", async () => {
    const fixture = await makeForkFixture();
    const admission = expectAdmitted(await admitPrimeForkContext({
      sessionId: fixture.forkId,
      events: fixture.forkEvents,
      manifest: fixture.forkManifest,
    }));

    // Hand-built from core/agent.ts runTurn's materializeMessages call sites:
    // same four expressions, same literal shape, same forkContextScope.
    const coreOptions = {
      allowEmbeddedContext: fixture.forkManifest.turnContext === undefined,
      allowSelectedContext: fixture.forkManifest.turnContext !== "disabled",
      forkContextScope: { sessionId: fixture.forkId, lineage: fixture.forkManifest.lineage },
      verifiedForkContextDigest: fixture.seedDigest,
    };
    expect(stableStringify(admission.materializeOptions as unknown as JsonValue))
      .toBe(stableStringify(coreOptions as unknown as JsonValue));
    expect(admission.materializeOptions).toEqual(coreOptions);
    expect(primeMaterializeForkOptions({
      sessionId: fixture.forkId,
      manifest: fixture.forkManifest,
      verifiedForkContextDigest: fixture.seedDigest,
    })).toEqual(coreOptions);
  });

  it("admits a lineage-free session with no verified digest and lineage-undefined options", async () => {
    const fixture = await makeForkFixture();
    const admission = expectAdmitted(await admitPrimeForkContext({
      sessionId: fixture.sourceId,
      events: fixture.sourceEvents,
      manifest: fixture.sourceManifest,
    }));

    expect(admission.verifiedForkContextDigest).toBeUndefined();
    expect(admission.forkContextScope).toEqual({ sessionId: fixture.sourceId });
    const coreOptions = {
      allowEmbeddedContext: fixture.sourceManifest.turnContext === undefined,
      allowSelectedContext: fixture.sourceManifest.turnContext !== "disabled",
      forkContextScope: { sessionId: fixture.sourceId, lineage: fixture.sourceManifest.lineage },
      verifiedForkContextDigest: undefined,
    };
    expect(stableStringify(admission.materializeOptions as unknown as JsonValue))
      .toBe(stableStringify(coreOptions as unknown as JsonValue));
  });

  it("rejects fork seed material journaled into a session without lineage", async () => {
    const fixture = await makeForkFixture();
    expect(await admitPrimeForkContext({
      sessionId: fixture.sourceId,
      events: [...fixture.sourceEvents, fixture.seedEvent],
      manifest: fixture.sourceManifest,
    })).toEqual({
      ok: false,
      reason: "A non-fork session contains fork-context seed material.",
    });
  });
});

class CapturingTransport implements InferenceTransport {
  readonly posture = "local" as const;
  readonly requests: InferenceRequest[] = [];
  private next = 0;

  constructor(
    private readonly responses: readonly string[],
    readonly id = "fork-admission-transport",
  ) {}

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    this.requests.push(structuredClone(request));
    const response = this.responses[this.next++] ?? "Unexpected response.";
    yield { type: "text-delta", text: response };
    yield { type: "completed", finishReason: "stop" };
  }
}
