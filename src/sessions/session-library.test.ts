import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSessionManifest, materializeMessages } from "../core/agent";
import { CONVERSATION_NAMED_EVENT_TYPE, type CanonicalMessage, type JsonValue, type SessionManifest, type ToolDefinition } from "../core/contracts";
import { FORK_CONTEXT_EVENT_TYPE, canonicalForkContextSeed } from "../core/fork-context";
import { sha256, stableStringify } from "../core/hash";
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
import { PREFERENCE_TAIL_DEPTH, SessionForkConflictError, SessionLibrary, UnknownSessionError } from "./library";
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

  /*
   * A branch summary must carry where it was cut, not only what it was cut
   * from.
   *
   * The summary shipped with `sourceSessionId` alone, so the downward
   * "Alternates" list on the Sessions detail pane could name three branches
   * and not say whether they were three answers to one turn or three
   * different questions. The fork boundary is part of the same manifest
   * commitment as the parent id, so it is validated on the same terms the
   * session audit uses (FORK_LINEAGE_INVALID: a positive journal sequence) and
   * a row that fails is counted as rejected rather than printed with a fork
   * point no audit would agree with.
   */
  it("carries the fork boundary on branch summaries and rejects a lineage that has none", async () => {
    const forkedAt = "2026-07-18T04:00:00.000Z";
    const branchManifest = async (sourceHeadSequence: number) => {
      const base = await manifest({ now: forkedAt });
      return {
        ...base,
        lineage: { version: 1, kind: "fork", sourceSessionId: "s-source", sourceHeadSequence, sourceHeadDigest: DIGEST, forkedAt },
      } as SessionManifest;
    };
    const records = [
      record("s-source", "Original question", await manifest(), "2026-07-18T01:00:00.000Z"),
      record("s-retry-a", "First alternative", await branchManifest(12), "2026-07-18T02:00:00.000Z"),
      record("s-retry-b", "Second alternative", await branchManifest(30), "2026-07-18T03:00:00.000Z"),
      // A fork point of 0 is not a fork point: the genesis boundary has no
      // audited prefix to have branched at.
      record("s-broken", "Malformed lineage", await branchManifest(0), "2026-07-18T04:00:00.000Z"),
    ];

    const page = querySessionRecords(records, { sort: "updated-desc" });
    expect(page.items.map((item) => [item.id, item.sourceSessionId, item.sourceHeadSequence])).toEqual([
      ["s-retry-b", "s-source", 30],
      ["s-retry-a", "s-source", 12],
      ["s-source", undefined, undefined],
    ]);
    expect(page.rejected).toBe(1);
  });

  /*
   * Profile is a scope boundary, not a filter.
   *
   * Folding it into the same pass as provider/model/search left the facets
   * derived from every record in the store, so the provider and model menus of
   * one Profile enumerated the other Profile's inventory — a name it has never
   * used, selectable, and yielding nothing. Facets are taken after the scope
   * and before the filters, so they stay stable as the reader narrows.
   */
  it("derives filter facets from the profile scope, never from the whole store", async () => {
    const records = [
      record("a-1", "Profile A", await manifest({ providerId: "chutes", model: "model-a", profile: profileBinding() }), "2026-07-18T01:00:00.000Z"),
      record("b-1", "Profile B", await manifest({ providerId: "demo", model: "model-b", profile: { ...profileBinding(), profileId: "profile-2" } }), "2026-07-18T02:00:00.000Z"),
      record("u-1", "Unbound", await manifest({ providerId: "ollama", model: "model-c" }), "2026-07-18T03:00:00.000Z"),
    ];

    expect(querySessionRecords(records, { profileId: "profile-1" }).facets).toEqual({
      providers: ["chutes"],
      models: ["model-a"],
      profiles: ["profile-1"],
    });
    expect(querySessionRecords(records, { profileId: "unbound" }).facets).toEqual({
      providers: ["ollama"],
      models: ["model-c"],
      profiles: [],
    });
    // Narrowing inside the scope must not shrink the menus the reader is
    // choosing from, which is why the facets come before the filters.
    const narrowed = querySessionRecords(records, { providerId: "chutes", model: "model-a", search: "Profile" });
    expect(narrowed.facets).toEqual({
      providers: ["chutes", "demo", "ollama"],
      models: ["model-a", "model-b", "model-c"],
      profiles: ["profile-1", "profile-2"],
    });
    expect(narrowed.items.map((item) => item.id)).toEqual(["a-1"]);
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

  /*
   * The naming call is a second billed provider request, and this materializer
   * is the only path by which a reloaded journal's receipts reach Proof. Its
   * receipt was being minted, validated and journaled, and then recovered by
   * nothing — a receipt no surface can resolve proves nothing at all.
   */
  it("recovers the naming inference's receipt into the chain without giving it a transcript row", async () => {
    const fixture = createJournal();
    const session = await fixture.journal.createSession("Named", await manifest());
    const namingReceipt = createLocalReceipt({
      sessionId: session.id,
      turnId: "naming-turn-1",
      provider: "demo",
      model: "model-a",
      requestDigest: DIGEST,
      responseDigest: DIGEST,
      now: "2026-07-18T00:01:00.000Z",
    });
    const strayReceipt = createLocalReceipt({
      sessionId: "some-other-session",
      turnId: "naming-turn-2",
      provider: "demo",
      model: "model-a",
      now: "2026-07-18T00:01:01.000Z",
    });
    await fixture.journal.append(session.id, [
      { type: "turn.requested", turnId: "turn-1", payload: { content: "first request" } },
      {
        type: "conversation.named",
        turnId: "naming-turn-1",
        operationId: "naming-operation-1",
        payload: {
          title: "First request",
          answer: "First request",
          model: "model-a",
          receipt: JSON.parse(JSON.stringify(namingReceipt)),
        },
      },
      {
        type: "conversation.named",
        turnId: "naming-turn-2",
        operationId: "naming-operation-2",
        // Bound to another session, so the same rule that rejects a borrowed
        // turn receipt has to reject this one: nothing is recovered from it.
        payload: { title: "Elsewhere", model: "model-a", receipt: JSON.parse(JSON.stringify(strayReceipt)) },
      },
    ]);
    const events = await fixture.journal.readEvents(session.id);
    const transcript = materializeSessionMessages(events, {}, session.id);

    expect(transcript.receipts.map((receipt) => receipt.receiptId)).toEqual([namingReceipt.receiptId]);
    expect(transcript.receipts[0]?.turnId).toBe("naming-turn-1");
    // It said nothing, so it is not a message; the transcript still reports it
    // as an event it chose not to render rather than pretending it is absent.
    expect(transcript.messages.map((message) => message.content)).toEqual(["first request"]);
    expect(Object.isFrozen(transcript.receipts[0])).toBe(true);
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

  it("keeps ordered favorites inside the profile journal authority", async () => {
    const fixture = createJournal();
    const first = await fixture.journal.createSession("First favorite", await manifest({ profile: profileBinding() }));
    const second = await fixture.journal.createSession("Second favorite", await manifest({ profile: profileBinding() }));
    const library = new SessionLibrary(fixture.journal);

    await library.setFavorite(first.id, "profile-1", true);
    await library.setFavorite(second.id, "profile-1", true);
    expect((await library.favorites("profile-1")).map((favorite) => favorite.sessionId)).toEqual([first.id, second.id]);

    await library.moveFavoriteBefore(second.id, "profile-1", first.id);
    expect((await library.favorites("profile-1")).map((favorite) => favorite.sessionId)).toEqual([second.id, first.id]);

    await library.setFavorite(first.id, "profile-1", false);
    expect((await library.favorites("profile-1")).map((favorite) => favorite.sessionId)).toEqual([second.id]);
    await expect(library.setFavorite(second.id, "another-profile", false)).rejects.toThrow(/active profile/u);

    const [updated, events] = await Promise.all([
      fixture.journal.getSession(second.id),
      fixture.journal.readEvents(second.id),
    ]);
    const audit = await auditSessionHistory({ session: updated!, events });
    expect(audit.findings.map((finding) => finding.code)).not.toContain("EVENT_TYPE_UNKNOWN");
    expect(audit.findings.map((finding) => finding.code)).not.toContain("SESSION_FAVORITE_MALFORMED");
    expect(audit.findings.map((finding) => finding.code)).not.toContain("PROFILE_FAVORITE_ORDER_MALFORMED");
  });

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

  /*
   * Saving a profile is not losing your conversations.
   *
   * Driven in a browser before it was changed: send one turn, open Profiles,
   * choose a different interface theme, press "Save new revision" and switch to
   * it. The finished conversation's only forward action became a gold "Fork to
   * continue"; its Resume button read "Fork required" and was disabled; the
   * row's one-press Open refused and left the route on #sessions — beside that
   * same conversation's "Journal structure passed · 11 of 11 events inspected ·
   * Last turn completed". A theme is not a pin.
   */
  it("resumes a conversation whose profile was re-saved with only presentation changed", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Themed", await manifest({ profile: profileBindingV2() }));
    const session = (await fixture.journal.getSession(created.id))!;
    const events = await fixture.journal.readEvents(session.id);
    const pins = extractSessionPins(session, events);
    const health = assessSessionHistory(session, events);
    const runtime = activeRuntime(session.manifest);

    const resaved = decideSessionResume(pins, health, {
      ...runtime,
      profile: {
        ...runtime.profile!,
        profileRevision: `sha256:${"B".repeat(43)}`,
        themeDigest: `sha256:${"C".repeat(43)}`,
        resolutionDigest: `sha256:${"D".repeat(43)}`,
      },
    });
    expect(resaved.action).toBe("resume");
    expect(resaved.label).toBe("Ready to resume");
    // Stated, not hidden: the person is told they are on an older revision.
    expect(resaved.reasons.map((reason) => reason.code)).toContain("PROFILE_REVISION_NEWER");
    expect(resaved.reasons.every((reason) => reason.severity !== "warning")).toBe(true);
  });

  it("still requires a fork when the profile's skills or governing boundaries moved", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Governed", await manifest({ profile: profileBindingV2() }));
    const session = (await fixture.journal.getSession(created.id))!;
    const events = await fixture.journal.readEvents(session.id);
    const pins = extractSessionPins(session, events);
    const health = assessSessionHistory(session, events);
    const runtime = activeRuntime(session.manifest);

    const skills = decideSessionResume(pins, health, {
      ...runtime,
      profile: { ...runtime.profile!, skillSetDigest: `sha256:${"E".repeat(43)}` },
    });
    expect(skills.action).toBe("fork-required");
    expect(skills.reasons.map((reason) => reason.code)).toContain("PROFILE_SKILLS_MISMATCH");

    for (const boundary of [
      { approvalMode: "full-access" },
      { memoryScope: "session" },
      { workspaceBinding: "workspace-id:other" },
      { minimumPosture: "encrypted-unattested" as const },
    ]) {
      const moved = decideSessionResume(pins, health, {
        ...runtime,
        profile: { ...runtime.profile!, ...boundary },
      });
      expect(moved.action).toBe("fork-required");
      expect(moved.reasons.map((reason) => reason.code)).toContain("PROFILE_BOUNDARY_MISMATCH");
    }

    const other = decideSessionResume(pins, health, {
      ...runtime,
      profile: { ...runtime.profile!, profileId: "profile-2" },
    });
    expect(other.action).toBe("fork-required");
    expect(other.reasons.map((reason) => reason.code)).toContain("PROFILE_MISMATCH");
  });

  /*
   * "Unfinished — 103 of 103 events inspected · 1 turn" over "Last turn
   * completed", with "RUNTIME DECISION: Fork required / HISTORY INCOMPLETE /
   * The session ended mid-turn or was only partially inspected" — while the
   * composer for that conversation accepted input. Every one of those words was
   * false about a fully inspected, fully terminated journal carrying a
   * timestamp drift, and the fork they demanded was not needed.
   */
  it("does not call a fully inspected, fully terminated history unfinished", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Drifted", await manifest({}));
    await fixture.journal.append(created.id, [
      { type: "turn.requested", turnId: "turn-1", payload: { content: "hello" } },
      { type: "assistant.completed", turnId: "turn-1", payload: { message: { role: "assistant", content: "hi" } } },
      { type: "turn.completed", turnId: "turn-1", payload: {} },
    ]);
    const stored = (await fixture.journal.getSession(created.id))!;
    const events = await fixture.journal.readEvents(stored.id);
    // The one observation, and nothing else: the session's own updated-at
    // clock differs from its final event's.
    const drifted = { ...stored, updatedAt: new Date(Date.parse(stored.updatedAt) + 1_000).toISOString() };

    const health = assessSessionHistory(drifted, events);
    expect(health.status).toBe("incomplete");
    expect(health.issues.map((issue) => issue.code)).toEqual(["SESSION_UPDATE_TIME_MISMATCH"]);
    expect(health.checkedEvents).toBe(health.totalEvents);
    expect(health.label).toBe("Observations recorded");

    const decision = decideSessionResume(extractSessionPins(drifted, events), health, activeRuntime(drifted.manifest));
    expect(decision.action).toBe("resume");
    expect(decision.reasons.map((reason) => reason.code)).not.toContain("HISTORY_INCOMPLETE");
    expect(decision.reasons.find((reason) => reason.code === "HISTORY_OBSERVED")?.message)
      .toContain("Fork not required");
  });

  it("still requires a fork for a conversation that genuinely ended mid-turn", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Mid-turn", await manifest({}));
    await fixture.journal.append(created.id, [
      { type: "turn.requested", turnId: "turn-1", payload: { content: "hello" } },
    ]);
    const session = (await fixture.journal.getSession(created.id))!;
    const events = await fixture.journal.readEvents(session.id);
    const health = assessSessionHistory(session, events);
    expect(health.label).toBe("Unfinished");

    const decision = decideSessionResume(extractSessionPins(session, events), health, activeRuntime(session.manifest));
    expect(decision.action).toBe("fork-required");
    expect(decision.reasons.find((reason) => reason.code === "HISTORY_INCOMPLETE")?.message)
      .toBe("The most recent turn has no durable terminal event; fork before continuing.");
  });

  it("treats a durable same-thread model change as the thread's current route", async () => {
    const binding = {
      version: 1 as const,
      connectionId: "chutes-primary",
      connectionGeneration: 3,
      providerId: "chutes",
      providerLabel: "Chutes",
      providerRevision: 1,
      authMethod: "oauth-pkce" as const,
      transportBoundary: "e2ee-attestable" as const,
      modelId: "model-a",
      boundAt: "2026-07-18T00:00:00.000Z",
    };
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Changed in place", await manifest({
      model: "model-a",
      inferenceBinding: binding,
      securityPosture: "encrypted-attested",
    }));
    const changed = await fixture.journal.setSessionModel(created.id, "model-b");
    const events = await fixture.journal.readEvents(changed.id);
    const pins = extractSessionPins(changed, events);

    expect(pins.model).toBe("model-b");
    expect(pins.inferenceBinding).toMatchObject({
      connectionId: "chutes-primary",
      connectionGeneration: 3,
      modelId: "model-b",
    });
    const decision = decideSessionResume(
      pins,
      assessSessionHistory(changed, events),
      {
        ...activeRuntime(changed.manifest),
        model: "model-b",
        inferenceBinding: { ...binding, modelId: "model-b" },
      },
    );
    expect(decision.action).toBe("resume");
    expect(decision.reasons.map((reason) => reason.code)).not.toContain("MODEL_MISMATCH");
    expect(decision.reasons.map((reason) => reason.code)).not.toContain("INFERENCE_CONNECTION_MISMATCH");
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
  /*
   * A conversation this journal never had is a different fault from one this
   * runtime cannot open yet, and only the first is permanent. The deep-link
   * resolver in app.tsx branches on the type to decide whether to keep holding
   * the URL open, so absence has to be recognisable without string matching —
   * and the id must not ride along in the message any surface may print.
   */
  it("reports an absent conversation as typed absence, not as an opaque internal string", async () => {
    const fixture = createJournal();
    const library = new SessionLibrary(fixture.journal);
    const missing = "018f40e0-7c62-7c70-9db7-6d5de37ae52c";

    const error = await library.inspect(missing).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UnknownSessionError);
    expect((error as UnknownSessionError).sessionId).toBe(missing);
    expect((error as Error).message).not.toContain(missing);
    expect((error as Error).message).not.toContain("Unknown session");
  });

  it("keeps a readable conversation resolvable so only real absence takes the absence arm", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Present", await manifest({ securityPosture: "local" }));
    const library = new SessionLibrary(fixture.journal);
    await expect(library.inspect(created.id)).resolves.toMatchObject({ session: { id: created.id } });
  });

  it("routes only absence through the deep-link reset, leaving every other fault holding its URL", () => {
    const source = readFileSync(new URL("../ui/app.tsx", import.meta.url), "utf8");
    const resolver = source.match(
      /void inspectSessionForNavigation\(requestedSessionId\)[\s\S]*?\n      \.finally\(/u,
    )?.[0] ?? "";
    expect(resolver).toContain("error instanceof UnknownSessionError");
    // Clearing the request is what lets the canonicalisation effect rewrite the
    // hash to the conversation actually open; keeping it set is what made a
    // transient miss permanent.
    const absence = resolver.slice(resolver.indexOf("error instanceof UnknownSessionError"));
    expect(absence).toContain("setChatRouteRequest((current) => current === requestedSessionId ? undefined : current)");
    expect(absence).toContain("did not survive the reload");
    expect(absence.slice(0, absence.indexOf("Keep the URL intact"))).not.toContain("describeSessionPresentationFault");
    expect(resolver).toContain("Keep the URL intact");
  });

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
    const emptyBoundary = sourceEvents[0]!;
    expect(result.session.manifest.lineage).toEqual({
      version: 1,
      kind: "fork",
      sourceSessionId: source.id,
      sourceHeadSequence: emptyBoundary.sequence,
      sourceHeadDigest: emptyBoundary.digest,
      forkedAt: "2026-07-18T10:30:00.000Z",
    });
    expect(result).toMatchObject({
      sourceHeadSequence: source.headSequence,
      sourceHeadDigest: source.headDigest,
      sourceBoundarySequence: emptyBoundary.sequence,
      sourceBoundaryDigest: emptyBoundary.digest,
      contextSeeded: true,
      contextMessageCount: 0,
    });
    expect(result.historyCopied).toBe(false);
    expect(await fixture.journal.readEvents(source.id)).toEqual(sourceEvents);
    expect((await fixture.journal.getSession(source.id))?.headDigest).toBe(source.headDigest);
    const forkEvents = await fixture.journal.readEvents(result.session.id);
    expect(forkEvents.map((event) => event.type)).toEqual(["session.created", FORK_CONTEXT_EVENT_TYPE]);
    const sourceEventIds = new Set(sourceEvents.map((event) => event.eventId));
    expect(forkEvents.some((event) => sourceEventIds.has(event.eventId))).toBe(false);
    const audit = await auditSessionHistory({
      session: (await fixture.journal.getSession(result.session.id))!,
      events: forkEvents,
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
    const point = await appendAuditedTurn(fixture.journal, created.id, "one", "one", "answer");
    await fixture.journal.append(created.id, [{ type: "turn.requested", turnId: "two", payload: { content: "later" } }]);
    const source = (await fixture.journal.getSession(created.id))!;
    const result = await new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: point.sequence, digest: point.digest },
    });
    expect(result.sourceHeadSequence).toBe(source.headSequence);
    expect(result.sourceBoundarySequence).toBe(point.sequence);
    expect(result.session.manifest.lineage).toMatchObject({ sourceHeadSequence: point.sequence, sourceHeadDigest: point.digest });
    const forkEvents = await fixture.journal.readEvents(result.session.id);
    const seed = canonicalForkContextSeed(forkEvents.find((event) => event.type === FORK_CONTEXT_EVENT_TYPE)?.payload)!;
    expect(materializeMessages(forkEvents, {
      forkContextScope: { sessionId: result.session.id, lineage: result.session.manifest.lineage },
      verifiedForkContextDigest: seed.contextDigest,
    })).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "answer" },
    ]);
    expect(materializeMessages(forkEvents, {
      forkContextScope: { sessionId: result.session.id, lineage: result.session.manifest.lineage },
      verifiedForkContextDigest: seed.contextDigest,
    }).some((message) => message.content === "later")).toBe(false);
  });

  it("forks at a turn's own pre-turn boundary without inheriting that turn's prompt or answer", async () => {
    // The boundary Retry forks at: the assistant row's `turnStartPoint`, which
    // is the requesting event's `previousDigest`. Retry used to reuse the
    // row's `sourcePoint` — the post-answer terminal — so the regenerated turn
    // was handed the answer it was replacing as provider context.
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Retry source", await manifest());
    await appendAuditedTurn(fixture.journal, created.id, "one", "first prompt", "first answer");
    await appendAuditedTurn(fixture.journal, created.id, "two", "second prompt", "second answer", [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ]);
    const request = (await fixture.journal.readEvents(created.id))
      .find((event) => event.type === "turn.requested" && event.turnId === "two")!;
    const source = (await fixture.journal.getSession(created.id))!;

    const result = await new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: request.sequence - 1, digest: request.previousDigest },
    });

    const forkEvents = await fixture.journal.readEvents(result.session.id);
    const seed = canonicalForkContextSeed(forkEvents.find((event) => event.type === FORK_CONTEXT_EVENT_TYPE)?.payload)!;
    const seeded = materializeMessages(forkEvents, {
      forkContextScope: { sessionId: result.session.id, lineage: result.session.manifest.lineage },
      verifiedForkContextDigest: seed.contextDigest,
    });
    expect(seeded).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ]);
    expect(seeded.some((message) => message.content === "second prompt")).toBe(false);
    expect(seeded.some((message) => message.content === "second answer")).toBe(false);
  });

  it("recognizes the exact pre-turn boundary after an audited ancillary naming call", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Named source", await manifest());
    await fixture.journal.append(created.id, [
      {
        type: CONVERSATION_NAMED_EVENT_TYPE,
        turnId: "naming-one",
        operationId: "naming-request-one",
        payload: { title: "Useful name", answer: "Useful name", model: "demo-v1" },
      },
      {
        type: "inference.usage",
        turnId: "naming-one",
        operationId: "naming-request-one",
        payload: { inputTokens: 4, outputTokens: 2, source: "conversation-naming" },
      },
      { type: "turn.requested", turnId: "two", payload: { content: "edit this" } },
      { type: "turn.cancelled", turnId: "two", payload: { error: "test boundary" } },
    ]);
    const events = await fixture.journal.readEvents(created.id);
    const request = events.find((event) => event.type === "turn.requested" && event.turnId === "two")!;
    const source = (await fixture.journal.getSession(created.id))!;

    const result = await new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: request.sequence - 1, digest: request.previousDigest },
    });

    expect(result.sourceBoundarySequence).toBe(request.sequence - 1);
    expect(result.sourceBoundaryDigest).toBe(request.previousDigest);
  });

  /*
   * Quiescence is about nothing being in flight, not about the last thing
   * having gone well.
   *
   * A user row's fork point is the event immediately before its own
   * turn.requested, so the message typed right after Stop, right after a
   * provider error, or right after a denied local command pointed at
   * turn.cancelled / turn.failed / local.command.denied — none of which were
   * boundaries, so `Edit & branch` and `Fork` were rejected there with "not an
   * audited quiescent conversation boundary". The abandoned turn is still kept
   * out of the seed: materializeMessages drops non-actionable turns whole.
   */
  it.each([
    ["turn.cancelled", "cancelled"],
    ["turn.failed", "failed"],
  ])("forks at a %s boundary without inheriting the abandoned prompt", async (terminalType) => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Interrupted", await manifest());
    await appendAuditedTurn(fixture.journal, created.id, "one", "kept question", "kept answer");
    const appended = await fixture.journal.append(created.id, [
      { type: "turn.requested", turnId: "two", payload: { content: "abandoned prompt" } },
      { type: terminalType, turnId: "two", payload: { error: "the reader pressed Stop" } },
    ]);
    const point = appended.at(-1)!;
    const source = (await fixture.journal.getSession(created.id))!;

    const result = await new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: point.sequence, digest: point.digest },
    });

    expect(result.session.manifest.lineage).toMatchObject({
      sourceHeadSequence: point.sequence,
      sourceHeadDigest: point.digest,
    });
    const forkEvents = await fixture.journal.readEvents(result.session.id);
    const seed = canonicalForkContextSeed(forkEvents.find((event) => event.type === FORK_CONTEXT_EVENT_TYPE)?.payload)!;
    expect(materializeMessages(forkEvents, {
      forkContextScope: { sessionId: result.session.id, lineage: result.session.manifest.lineage },
      verifiedForkContextDigest: seed.contextDigest,
    })).toEqual([
      { role: "user", content: "kept question" },
      { role: "assistant", content: "kept answer" },
    ]);
  });

  it("forks at a denied local command, which is as quiescent as a completed one", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Denied", await manifest());
    await appendAuditedTurn(fixture.journal, created.id, "one", "kept question", "kept answer");
    const appended = await fixture.journal.append(created.id, [
      { type: "local.command.requested", turnId: "local-1", operationId: "local-op-1", payload: { toolName: "read_file", content: "/read secrets", arguments: {} } },
      { type: "local.command.denied", turnId: "local-1", operationId: "local-op-1", payload: { toolName: "read_file", content: "The operator declined." } },
    ]);
    const point = appended.at(-1)!;
    const source = (await fixture.journal.getSession(created.id))!;

    const result = await new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: point.sequence, digest: point.digest },
    });

    expect(result.session.manifest.lineage).toMatchObject({
      sourceHeadSequence: point.sequence,
      sourceHeadDigest: point.digest,
    });
    const forkEvents = await fixture.journal.readEvents(result.session.id);
    const seed = canonicalForkContextSeed(forkEvents.find((event) => event.type === FORK_CONTEXT_EVENT_TYPE)?.payload)!;
    expect(materializeMessages(forkEvents, {
      forkContextScope: { sessionId: result.session.id, lineage: result.session.manifest.lineage },
      verifiedForkContextDigest: seed.contextDigest,
    })).toEqual([
      { role: "user", content: "kept question" },
      { role: "assistant", content: "kept answer" },
    ]);
  });

  it("forks at an audited pre-turn rename without inheriting the following first prompt", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Untitled", await manifest());
    await fixture.journal.renameSession(created.id, "First prompt title");
    const rename = (await fixture.journal.readEvents(created.id)).at(-1)!;
    await appendAuditedTurn(fixture.journal, created.id, "first", "first prompt", "first answer");
    const source = (await fixture.journal.getSession(created.id))!;

    const result = await new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: rename.sequence, digest: rename.digest },
    });

    expect(rename.type).toBe("session.renamed");
    expect(result).toMatchObject({
      sourceHeadSequence: source.headSequence,
      sourceBoundarySequence: rename.sequence,
      sourceBoundaryDigest: rename.digest,
      contextMessageCount: 0,
      contextSeeded: true,
    });
    expect(result.session.manifest.lineage).toMatchObject({
      sourceHeadSequence: rename.sequence,
      sourceHeadDigest: rename.digest,
    });
    const forkEvents = await fixture.journal.readEvents(result.session.id);
    const seed = canonicalForkContextSeed(forkEvents.find((event) => event.type === FORK_CONTEXT_EVENT_TYPE)?.payload)!;
    expect(materializeMessages(forkEvents, {
      forkContextScope: { sessionId: result.session.id, lineage: result.session.manifest.lineage },
      verifiedForkContextDigest: seed.contextDigest,
    })).toEqual([]);
  });

  it("refuses a context seed when the selected source prefix does not pass audit", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Malformed source", await manifest());
    const events = await fixture.journal.append(created.id, [
      { type: "turn.requested", turnId: "broken", payload: { content: "request" } },
      { type: "turn.completed", turnId: "broken", payload: {} },
    ]);
    const source = (await fixture.journal.getSession(created.id))!;
    const point = events.at(-1)!;
    await expect(new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: point.sequence, digest: point.digest },
    })).rejects.toThrow(/did not pass the local journal audit/u);
    expect(await fixture.journal.listSessions()).toHaveLength(1);
  });

  it("refuses an audited prefix when the later observed source head is structurally invalid", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Invalid later head", await manifest());
    const point = await appendAuditedTurn(fixture.journal, created.id, "valid", "keep", "kept");
    await fixture.journal.append(created.id, [
      { type: "turn.completed", turnId: "orphaned", payload: {} },
    ]);
    const source = (await fixture.journal.getSession(created.id))!;

    await expect(new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: point.sequence, digest: point.digest },
    })).rejects.toThrow(/observed source head did not pass the local journal audit/u);
    expect(await fixture.journal.listSessions()).toHaveLength(1);
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

  it("rejects a session-scoped record appended while a provider turn is still active", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Mid-turn metadata", await manifest());
    await fixture.journal.append(created.id, [
      { type: "turn.requested", turnId: "open", payload: { content: "unfinished" } },
    ]);
    await fixture.journal.renameSession(created.id, "Renamed during open turn");
    const rename = (await fixture.journal.readEvents(created.id)).at(-1)!;
    const source = (await fixture.journal.getSession(created.id))!;

    await expect(new SessionLibrary(fixture.journal).fork(created.id, {
      expectedSourceHead: { sequence: source.headSequence, digest: source.headDigest },
      sourcePoint: { sequence: rename.sequence, digest: rename.digest },
    })).rejects.toThrow(/selected source boundary did not pass/u);
    expect(await fixture.journal.listSessions()).toHaveLength(1);
  });

  /*
   * `list()` dates the Recent group from the newest event that is not a
   * preference write. It used to find that event by reading — and, on an
   * adopted vault, decrypting — every event of every conversation, on every
   * refresh. The sidebar refreshes once per durable event, so a long
   * conversation made each of its own turns quadratically more expensive to
   * display. The answer only ever lives in the last few events, so that is all
   * that is read.
   */
  it("dates the Recent group from a bounded tail rather than every event of every conversation", async () => {
    const fixture = createJournal();
    const sessions = await Promise.all(["First", "Second", "Third"].map(async (title) =>
      fixture.journal.createSession(title, await manifest({ profile: profileBinding() }))));
    for (const session of sessions) {
      await fixture.journal.append(session.id, Array.from({ length: 12 }, (_, index) => ({
        type: "turn.requested",
        turnId: `turn-${index}`,
        payload: { content: `message ${index}` },
      })));
    }
    const heads = new Map(
      (await fixture.journal.listSessions()).map((session) => [session.id, session.headSequence] as const),
    );

    const reads: Array<readonly [string, number | undefined]> = [];
    const underlying = fixture.journal.readEvents.bind(fixture.journal);
    fixture.journal.readEvents = (sessionId, afterSequence, signal) => {
      reads.push([sessionId, afterSequence]);
      return underlying(sessionId, afterSequence, signal);
    };

    const library = new SessionLibrary(fixture.journal);
    const page = await library.list({ profileId: "profile-1" });

    expect(page.items).toHaveLength(sessions.length);
    // One read per conversation, and every one of them skips past the head
    // minus the tail depth instead of starting from sequence zero.
    expect(reads).toHaveLength(sessions.length);
    for (const [sessionId, afterSequence] of reads) {
      expect(heads.get(sessionId)).toBeGreaterThan(PREFERENCE_TAIL_DEPTH);
      expect(afterSequence).toBe(heads.get(sessionId)! - PREFERENCE_TAIL_DEPTH);
      expect(afterSequence).toBeGreaterThan(0);
    }
  });

  it("keeps starring out of the derived activity time, and under-claims past the tail", async () => {
    const fixture = createJournal();
    const created = await fixture.journal.createSession("Starred", await manifest({ profile: profileBinding() }));
    await fixture.journal.append(created.id, [
      { type: "turn.requested", turnId: "turn-1", payload: { content: "real activity" } },
    ]);
    const library = new SessionLibrary(fixture.journal);
    const activity = (await library.list({ profileId: "profile-1" })).items[0]!.updatedAt;

    await library.setFavorite(created.id, "profile-1", true);
    expect((await library.list({ profileId: "profile-1" })).items[0]!.updatedAt).toBe(activity);

    /*
     * Past `PREFERENCE_TAIL_DEPTH` consecutive preference writes the tail holds
     * no conversation activity at all, and the answer is still the activity
     * time.
     *
     * This used to assert the opposite — that the record's own timestamp had
     * drifted past it — because the journals advanced `updatedAt` for every
     * append including preference writes, and only this class filtered them
     * back out. Two answers to one question, and the selection pointer went
     * through the gap: fixing the journals left this deriving the timestamp
     * from the very record they had stopped counting. One rule now
     * (`SESSION_BOOKKEEPING_EVENT_TYPES`), applied in the journals and here, so
     * bookkeeping cannot move a row however deep the tail of it gets.
     */
    for (let toggle = 0; toggle < PREFERENCE_TAIL_DEPTH; toggle += 1) {
      await library.setFavorite(created.id, "profile-1", toggle % 2 === 0);
    }
    const record = (await fixture.journal.getSession(created.id))!;
    expect((await library.list({ profileId: "profile-1" })).items[0]!.updatedAt).toBe(record.updatedAt);
    expect(record.updatedAt).toBe(activity);
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

async function appendAuditedTurn(
  journal: EventJournal,
  sessionId: string,
  turnId: string,
  userContent: string,
  assistantContent: string,
  // The request digest covers the whole materialized message list, so a second
  // audited turn has to state the turns that precede it.
  priorMessages: readonly CanonicalMessage[] = [],
) {
  const session = (await journal.getSession(sessionId))!;
  const messages: CanonicalMessage[] = [...priorMessages, { role: "user", content: userContent }];
  const idempotencyKey = `${session.id}:${turnId}:0`;
  const requestDigest = await sha256(stableStringify({
    model: session.manifest.model,
    systemPromptDigest: session.manifest.systemPromptDigest,
    messages,
    tools: session.manifest.tools,
    idempotencyKey,
  } as unknown as JsonValue));
  const responseDigest = await sha256(assistantContent);
  const receipt = createLocalReceipt({
    sessionId,
    turnId,
    provider: session.manifest.providerId,
    model: session.manifest.model,
    requestDigest,
    responseDigest,
    now: "2026-07-18T00:00:04.000Z",
  });
  await journal.append(sessionId, [
    { type: "turn.requested", turnId, payload: { content: userContent } },
    {
      type: "inference.started",
      turnId,
      operationId: `inference-${turnId}`,
      payload: {
        step: 0,
        providerId: session.manifest.providerId,
        model: session.manifest.model,
        posture: "local",
        requestDigest,
        idempotencyKey,
      },
    },
    {
      type: "assistant.completed",
      turnId,
      operationId: `inference-${turnId}`,
      payload: {
        message: { role: "assistant", content: assistantContent },
        finishReason: "stop",
        responseDigest,
        receipt: receipt as unknown as JsonValue,
      },
    },
    { type: "turn.completed", turnId, payload: { responseDigest, receiptId: receipt.receiptId } },
  ]);
  return (await journal.readEvents(sessionId)).at(-1)!;
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

/** The current pin shape, which carries the boundaries a turn is governed by. */
function profileBindingV2(): NonNullable<SessionManifest["profile"]> {
  return {
    ...profileBinding(),
    version: 2,
    workspaceBinding: { kind: "active-workspace" },
    memoryScope: "profile",
    approvalMode: "ask-first",
    minimumPosture: "local",
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
        ...(profile.version === 2 ? {
          workspaceBinding: profile.workspaceBinding.kind === "workspace-id"
            ? `workspace-id:${profile.workspaceBinding.workspaceId}`
            : "active-workspace",
          memoryScope: profile.memoryScope,
          approvalMode: profile.approvalMode,
          minimumPosture: profile.minimumPosture,
        } : {}),
      },
    } : {}),
  };
}
