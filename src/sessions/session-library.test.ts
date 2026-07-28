import { describe, expect, it } from "vitest";
import { createSessionManifest } from "../core/agent";
import type { SessionManifest, ToolDefinition } from "../core/contracts";
import { EventJournal, type SessionRecord } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { auditSessionHistory } from "../core/session-audit";
import { createLocalReceipt } from "../receipts/types";
import {
  assessSessionHistory,
  decideSessionResume,
  extractSessionPins,
  materializeSessionMessages,
  querySessionRecords,
  type ActiveSessionRuntime,
} from "./domain";
import { SessionForkConflictError, SessionLibrary } from "./library";
import { SessionsView } from "../ui/sessions-view";

const DIGEST = `sha256:${"A".repeat(43)}`;
const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read one workspace file",
  effect: "read",
  inputSchema: { type: "object" },
};

describe("browser-native session domain", () => {
  it("exports the reusable Preact session surface", () => {
    expect(typeof SessionsView).toBe("function");
  });

  it("sorts, searches, and filters bounded session summaries without exposing prompts", async () => {
    const records = [
      record("s-2", "Incident review", await manifest({ providerId: "chutes", model: "model-b" }), "2026-07-18T03:00:00.000Z"),
      record("s-1", "Build release", await manifest({ providerId: "demo", model: "model-a" }), "2026-07-18T01:00:00.000Z"),
      record("s-3", "Research notes", await manifest({ providerId: "chutes", model: "model-a" }), "2026-07-18T02:00:00.000Z"),
    ];

    const newest = querySessionRecords(records, { sort: "updated-desc" });
    expect(newest.items.map((item) => item.id)).toEqual(["s-2", "s-3", "s-1"]);
    expect(newest.items[0]).not.toHaveProperty("systemPrompt");
    expect(newest.facets).toEqual({ providers: ["chutes", "demo"], models: ["model-a", "model-b"], profiles: [] });

    const filtered = querySessionRecords(records, { search: "RESEARCH", providerId: "chutes", model: "model-a" });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.id).toBe("s-3");
    expect(Object.isFrozen(filtered)).toBe(true);
  });

  it("materializes only bounded user and assistant text and reports every omission", async () => {
    const fixture = createJournal();
    const session = await fixture.journal.createSession("Bounded", await manifest());
    await fixture.journal.append(session.id, [
      { type: "turn.requested", turnId: "turn-1", payload: { content: `hello\u0000${"x".repeat(32)}` } },
      { type: "tool.resulted", turnId: "turn-1", operationId: "secret-tool", payload: { callId: "secret-tool", content: "must not render" } },
      { type: "assistant.completed", turnId: "turn-1", operationId: "op-1", payload: { message: { role: "assistant", content: "answer one" } } },
      { type: "turn.completed", turnId: "turn-1", payload: {} },
      { type: "turn.requested", turnId: "turn-2", payload: { content: "second request" } },
      { type: "assistant.completed", turnId: "turn-2", operationId: "op-2", payload: { message: { role: "assistant", content: "second answer" } } },
    ]);
    const events = await fixture.journal.readEvents(session.id);
    const transcript = materializeSessionMessages(events, {
      maxEvents: 100,
      maxMessages: 3,
      maxMessageChars: 12,
      maxTranscriptChars: 24,
    });

    expect(transcript.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(true);
    expect(transcript.messages.map((message) => message.content)).toEqual(["second requ…", "second answ…"]);
    expect(transcript.messages.some((message) => message.content.includes("must not render"))).toBe(false);
    expect(transcript.omittedMessages).toBe(2);
    expect(transcript.truncated).toBe(true);
    expect(Object.isFrozen(transcript.messages)).toBe(true);
  });

  it("keeps transcript, model pin, receipt chain, and lifecycle isolated across session switches", async () => {
    const fixture = createJournal();
    const first = await fixture.journal.createSession("First", await manifest({ model: "model-a" }));
    const second = await fixture.journal.createSession("Second", await manifest({ model: "model-b" }));
    const firstReceipt = createLocalReceipt({
      sessionId: first.id,
      turnId: "turn-a",
      provider: "demo",
      model: "model-a",
      requestDigest: DIGEST,
      responseDigest: DIGEST,
      now: "2026-07-18T00:01:00.000Z",
    });
    await fixture.journal.append(first.id, [
      { type: "turn.requested", turnId: "turn-a", payload: { content: "first request" } },
      {
        type: "assistant.completed",
        turnId: "turn-a",
        operationId: "op-a",
        payload: {
          message: { role: "assistant", content: "first response" },
          receipt: JSON.parse(JSON.stringify(firstReceipt)),
        },
      },
      { type: "turn.completed", turnId: "turn-a", payload: { receiptId: firstReceipt.receiptId } },
    ]);
    await fixture.journal.append(second.id, [
      { type: "turn.requested", turnId: "turn-b", payload: { content: "second request" } },
      {
        type: "assistant.completed",
        turnId: "turn-b",
        operationId: "op-b",
        payload: {
          message: { role: "assistant", content: "second response" },
          // A receipt copied from another session must never join this chain.
          receipt: JSON.parse(JSON.stringify(firstReceipt)),
        },
      },
      { type: "turn.failed", turnId: "turn-b", payload: { error: "isolated failure" } },
    ]);

    const library = new SessionLibrary(fixture.journal);
    const firstView = await library.inspect(first.id);
    const secondView = await library.inspect(second.id);
    const firstAgain = await library.inspect(first.id);

    expect(firstView.pins.model).toBe("model-a");
    expect(firstView.transcript.messages.map((message) => message.content)).toEqual(["first request", "first response"]);
    expect(firstView.transcript.messages.map((message) => [message.turnStatus, message.providerContext])).toEqual([
      ["completed", "included"],
      ["completed", "included"],
    ]);
    expect(firstView.transcript.messages[1]?.receipt?.receiptId).toBe(firstReceipt.receiptId);
    expect(firstView.transcript.receipts.map((receipt) => receipt.receiptId)).toEqual([firstReceipt.receiptId]);
    expect(firstView.transcript.lifecycle).toMatchObject({ state: "completed", turnId: "turn-a" });

    expect(secondView.pins.model).toBe("model-b");
    expect(secondView.transcript.messages.map((message) => message.content)).toEqual(["second request", "second response"]);
    expect(secondView.transcript.messages.map((message) => [message.turnStatus, message.providerContext])).toEqual([
      ["failed", "excluded"],
      ["failed", "excluded"],
    ]);
    expect(secondView.transcript.messages[1]?.receipt).toBeUndefined();
    expect(secondView.transcript.receipts).toEqual([]);
    expect(secondView.transcript.lifecycle).toMatchObject({ state: "failed", turnId: "turn-b" });

    const mixedBackendProjection = materializeSessionMessages([
      ...await fixture.journal.readEvents(first.id),
      ...await fixture.journal.readEvents(second.id),
    ], {}, first.id);
    expect(mixedBackendProjection.messages.map((message) => message.content)).toEqual(["first request", "first response"]);
    expect(mixedBackendProjection.receipts.map((receipt) => receipt.sessionId)).toEqual([first.id]);
    expect(mixedBackendProjection.lifecycle).toMatchObject({ state: "completed", turnId: "turn-a" });

    expect(firstAgain.transcript).toEqual(firstView.transcript);
    expect(Object.isFrozen(firstAgain.transcript.receipts[0])).toBe(true);

    const secondReceipt = createLocalReceipt({
      sessionId: second.id,
      turnId: "turn-c",
      provider: "demo",
      model: "model-b",
      requestDigest: DIGEST,
      responseDigest: DIGEST,
      now: "2026-07-18T00:02:00.000Z",
    });
    await fixture.journal.append(second.id, [
      { type: "turn.requested", turnId: "turn-c", payload: { content: "recovery request" } },
      {
        type: "assistant.completed",
        turnId: "turn-c",
        operationId: "op-c",
        payload: {
          message: { role: "assistant", content: "recovery response" },
          receipt: JSON.parse(JSON.stringify(secondReceipt)),
        },
      },
      { type: "turn.completed", turnId: "turn-c", payload: { receiptId: secondReceipt.receiptId } },
    ]);
    const secondAfterRecovery = await library.inspect(second.id);
    expect(secondAfterRecovery.transcript.lifecycle).toMatchObject({ state: "completed", turnId: "turn-c" });
    expect(secondAfterRecovery.transcript.messages.map((message) => [message.turnStatus, message.providerContext])).toEqual([
      ["failed", "excluded"],
      ["failed", "excluded"],
      ["completed", "included"],
      ["completed", "included"],
    ]);
    expect(secondAfterRecovery.transcript.receipts.map((receipt) => receipt.receiptId)).toEqual([secondReceipt.receiptId]);

    const clean = await fixture.journal.createSession("Clean", await manifest({ model: "model-c" }));
    const cleanView = await library.inspect(clean.id);
    expect(cleanView.pins.model).toBe("model-c");
    expect(cleanView.transcript.messages).toEqual([]);
    expect(cleanView.transcript.receipts).toEqual([]);
    expect(cleanView.transcript.lifecycle).toEqual({ state: "ready", label: "Ready", sequence: 0 });
  }, 10_000);

  it("separates coherent linkage, unfinished work, and suspect history from cryptographic proof", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Health", await manifest({ securityPosture: "local" }));
    let session = (await fixture.journal.getSession(created.id))!;
    let events = await fixture.journal.readEvents(session.id);
    const clean = assessSessionHistory(session, events);
    expect(clean.status).toBe("consistent");
    expect(clean.verification).toEqual({
      scope: "structural-linkage-only",
      digestRecomputed: false,
      authenticity: "not-proven",
    });

    await fixture.journal.append(session.id, [{ type: "turn.requested", turnId: "turn-open", payload: { content: "begin" } }]);
    session = (await fixture.journal.getSession(session.id))!;
    events = await fixture.journal.readEvents(session.id);
    const incomplete = assessSessionHistory(session, events);
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.issues.map((issue) => issue.code)).toContain("TURN_INCOMPLETE");

    const changed = structuredClone(events);
    changed[1]!.previousDigest = "unrelated";
    const suspect = assessSessionHistory(session, changed);
    expect(suspect.status).toBe("suspect");
    expect(suspect.issues.map((issue) => issue.code)).toContain("LINKAGE_MISMATCH");
  });

  it("exposes immutable manifest pins while labeling legacy posture as observation only", async () => {
    const fixture = createJournal();
    const profile = profileBinding();
    const created = await fixture.journal.createSession("Pins", await manifest({ profile }));
    await fixture.journal.append(created.id, [
      { type: "turn.requested", turnId: "turn-1", payload: { content: "hello" } },
      {
        type: "inference.started",
        turnId: "turn-1",
        operationId: "op-1",
        payload: { posture: "encrypted-unattested" },
      },
      { type: "turn.failed", turnId: "turn-1", payload: { error: "test stop" } },
    ]);
    const session = (await fixture.journal.getSession(created.id))!;
    const pins = extractSessionPins(session, await fixture.journal.readEvents(session.id));

    expect(pins.posture).toMatchObject({ basis: "event-observation", value: "encrypted-unattested", mixed: false });
    expect(pins.profile).toMatchObject({ profileId: "profile-1", themeDigest: DIGEST, resolutionDigest: DIGEST });
    expect(Object.isFrozen(pins)).toBe(true);
    expect(Object.isFrozen(pins.profile?.skills)).toBe(true);
  });

  it("allows resume only for an exact runtime binding and requires a fork for meaningful drift", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Compatible", await manifest({
      securityPosture: "encrypted-attested",
      profile: profileBinding(),
    }));
    const session = (await fixture.journal.getSession(created.id))!;
    const events = await fixture.journal.readEvents(session.id);
    const pins = extractSessionPins(session, events);
    const health = assessSessionHistory(session, events);
    const runtime = activeRuntime(session.manifest);

    expect(decideSessionResume(pins, health, runtime).action).toBe("resume");
    const changed = decideSessionResume(pins, health, { ...runtime, model: "different-model" });
    expect(changed.action).toBe("fork-required");
    expect(changed.reasons.map((reason) => reason.code)).toContain("MODEL_MISMATCH");

    const suspect = assessSessionHistory(session, [{ ...events[0]!, previousDigest: "wrong" }]);
    expect(decideSessionResume(pins, suspect, runtime).action).toBe("blocked");
  });

  it("never resumes a session through a replacement inference credential generation", async () => {
    const binding = {
      version: 1 as const,
      connectionId: "openai-primary",
      connectionGeneration: 3,
      providerId: "openai",
      providerLabel: "OpenAI",
      providerRevision: 1,
      authMethod: "api-key" as const,
      transportBoundary: "provider-tls" as const,
      modelId: "model-a",
      boundAt: "2026-07-18T00:00:00.000Z",
    };
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Exact account", await manifest({
      inferenceBinding: binding,
      securityPosture: "plaintext-remote",
    }));
    const session = (await fixture.journal.getSession(created.id))!;
    const events = await fixture.journal.readEvents(session.id);
    const pins = extractSessionPins(session, events);
    const health = assessSessionHistory(session, events);
    const runtime = activeRuntime(session.manifest);

    expect(decideSessionResume(pins, health, runtime).action).toBe("resume");
    expect(decideSessionResume(pins, health, {
      ...runtime,
      inferenceBinding: { ...binding, boundAt: "2026-07-18T01:00:00.000Z" },
    }).action).toBe("resume");
    const replacements = [
      { ...binding, connectionId: "openai-replacement" },
      { ...binding, connectionGeneration: 4 },
      { ...binding, providerId: "replacement-provider" },
      { ...binding, providerLabel: "Replacement provider" },
      { ...binding, providerRevision: 2 },
      { ...binding, authMethod: "oauth-pkce" as const },
      { ...binding, transportBoundary: "loopback-local" as const },
      { ...binding, modelId: "model-b" },
    ];
    for (const inferenceBinding of replacements) {
      const replaced = decideSessionResume(pins, health, {
        ...runtime,
        inferenceBinding,
      });
      expect(replaced.action).toBe("fork-required");
      expect(replaced.reasons.map((reason) => reason.code)).toContain("INFERENCE_CONNECTION_MISMATCH");
    }
  });
});

describe("SessionLibrary", () => {
  it("loads a stable bounded detail snapshot with a compatibility decision", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Inspectable", await manifest({ securityPosture: "local" }));
    const session = (await fixture.journal.getSession(created.id))!;
    const library = new SessionLibrary(fixture.journal);
    const detail = await library.inspect(session.id, activeRuntime(session.manifest));

    expect(detail.snapshotStable).toBe(true);
    expect(detail.history.status).toBe("consistent");
    expect(detail.compatibility?.action).toBe("resume");
    expect(Object.isFrozen(detail)).toBe(true);
  });

  it("forks into a new immutable session with an ancestor commitment and leaves source history untouched", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Source", await manifest({ securityPosture: "local" }));
    await fixture.journal.append(created.id, [{ type: "turn.requested", turnId: "open", payload: { content: "unfinished" } }]);
    const source = (await fixture.journal.getSession(created.id))!;
    const sourceEvents = await fixture.journal.readEvents(source.id);
    const replacement = await manifest({ model: "next-model", securityPosture: "encrypted-attested" });
    const library = new SessionLibrary(fixture.journal, { now: () => "2026-07-18T10:30:00.000Z" });

    const result = await library.fork(source.id, {
      title: "Source · confidential fork",
      manifest: replacement,
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
    });
    expect(result.session.id).not.toBe(source.id);
    expect(result.session.manifest.model).toBe("next-model");
    expect(result.session.manifest.lineage).toEqual({
      version: 1,
      kind: "fork",
      sourceSessionId: source.id,
      sourceHeadSequence: source.headSequence,
      sourceHeadDigest: source.headDigest,
      forkedAt: "2026-07-18T10:30:00.000Z",
    });
    expect(result.historyCopied).toBe(false);
    expect(await fixture.journal.readEvents(source.id)).toEqual(sourceEvents);
    expect((await fixture.journal.getSession(source.id))?.headDigest).toBe(source.headDigest);
    const audit = await auditSessionHistory({
      session: (await fixture.journal.getSession(result.session.id))!,
      events: await fixture.journal.readEvents(result.session.id),
    });
    expect(audit.status).toBe("verified");
    expect(audit.authenticity).toBe("not-proven");
  });

  it("rejects stale fork commitments and honors cancellation before mutation", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Source", await manifest());
    const source = (await fixture.journal.getSession(created.id))!;
    const library = new SessionLibrary(fixture.journal);
    await expect(library.fork(source.id, {
      expectedSourceHead: { sequence: source.headSequence + 1, digest: source.headDigest },
    })).rejects.toBeInstanceOf(SessionForkConflictError);

    const controller = new AbortController();
    controller.abort();
    await expect(library.fork(source.id, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect((await fixture.journal.listSessions()).length).toBe(1);
  });

  it("rejects an append that races fork manifest preparation", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Racing source", await manifest());
    const source = (await fixture.journal.getSession(created.id))!;
    const originalGetSession = fixture.journal.getSession.bind(fixture.journal);
    let injected = false;
    fixture.journal.getSession = async (sessionId) => {
      const snapshot = await originalGetSession(sessionId);
      if (!injected && sessionId === source.id) {
        injected = true;
        await fixture.journal.append(source.id, [
          { type: "turn.requested", turnId: "racing-turn", payload: { content: "changed concurrently" } },
        ]);
      }
      return snapshot;
    };

    await expect(new SessionLibrary(fixture.journal).fork(source.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
    })).rejects.toBeInstanceOf(SessionForkConflictError);
    expect(await fixture.journal.listSessions()).toHaveLength(1);
  });

  it("forks from an audited historical completed-turn boundary", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Historical", await manifest());
    const first = await fixture.journal.append(created.id, [
      { type: "turn.requested", turnId: "one", payload: { content: "one" } },
      { type: "assistant.completed", turnId: "one", payload: { message: { role: "assistant", content: "answer" } } },
      { type: "turn.completed", turnId: "one", payload: {} },
    ]);
    await fixture.journal.append(created.id, [{ type: "turn.requested", turnId: "two", payload: { content: "later" } }]);
    const source = (await fixture.journal.getSession(created.id))!;
    const point = first.at(-1)!;
    const result = await new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: point.sequence, digest: point.digest },
    });
    expect(result.sourceHeadSequence).toBe(point.sequence);
    expect(result.session.manifest.lineage).toMatchObject({ sourceHeadSequence: point.sequence, sourceHeadDigest: point.digest });
  });

  it("rejects a historical point that is not a completed-turn boundary", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Unsafe point", await manifest());
    const [request] = await fixture.journal.append(created.id, [{ type: "turn.requested", turnId: "open", payload: { content: "unfinished" } }]);
    const source = (await fixture.journal.getSession(created.id))!;
    await expect(new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: request!.sequence, digest: request!.digest },
    })).rejects.toBeInstanceOf(SessionForkConflictError);
  });
});

function createJournal() {
  let tick = 0;
  let identity = 0;
  return {
    journal: new EventJournal(
      new MemoryJournalBackend(),
      () => `2026-07-18T00:00:${String(tick++).padStart(2, "0")}.000Z`,
      () => `identity-${String(++identity)}`,
    ),
  };
}

async function manifest(overrides: Partial<Parameters<typeof createSessionManifest>[0]> = {}): Promise<SessionManifest> {
  return createSessionManifest({
    systemPrompt: "Keep the session exact.",
    providerId: "demo",
    model: "model-a",
    tools: [readTool],
    workspaceId: "memory://sessions",
    capabilityTier: "web-baseline",
    now: "2026-07-18T00:00:00.000Z",
    ...overrides,
  });
}

function record(id: string, title: string, sessionManifest: SessionManifest, updatedAt: string): SessionRecord {
  return {
    id,
    title,
    manifest: sessionManifest,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt,
    headSequence: 1,
    headDigest: DIGEST,
  };
}

function profileBinding(): NonNullable<SessionManifest["profile"]> {
  return {
    version: 1,
    profileId: "profile-1",
    profileRevision: DIGEST,
    themeId: "theme-1",
    themeDigest: DIGEST,
    resolvedSkills: [{ skillId: "skill-1", digest: DIGEST, promptOrder: 0 }],
    skillSetDigest: DIGEST,
    resolutionDigest: DIGEST,
  };
}

function activeRuntime(sessionManifest: SessionManifest): ActiveSessionRuntime {
  const profile = sessionManifest.profile;
  return {
    providerId: sessionManifest.providerId,
    model: sessionManifest.model,
    ...(sessionManifest.inferenceBinding ? { inferenceBinding: sessionManifest.inferenceBinding } : {}),
    posture: sessionManifest.securityPosture ?? "local",
    toolManifestDigest: sessionManifest.toolManifestDigest,
    workspaceId: sessionManifest.workspaceId,
    ...(profile ? {
      profile: {
        profileId: profile.profileId,
        profileRevision: profile.profileRevision,
        themeDigest: profile.themeDigest,
        skillSetDigest: profile.skillSetDigest,
        resolutionDigest: profile.resolutionDigest,
      },
    } : {}),
  };
}
