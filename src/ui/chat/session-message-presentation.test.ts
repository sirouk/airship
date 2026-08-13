import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../core/contracts";
import { CONVERSATION_NAMED_EVENT_TYPE, HUMAN_INTENT_EVENT_TYPE } from "../../core/contracts";
import type { DurableEvent } from "../../core/journal";
import { createLocalReceipt, type ConversationReceipt } from "../../receipts/types";
import { EventJournal } from "../../core/journal";
import { MemoryJournalBackend } from "../../core/memory-journal";
import { createSessionManifest } from "../../core/session-manifest";
import { sha256, stableStringify } from "../../core/hash";
import type { CanonicalMessage } from "../../core/contracts";
import { auditSessionHistory } from "../../core/session-audit";
import { selectProfileActiveConversation } from "../../sessions/profile-cockpit";
import { SessionLibrary } from "../../sessions/library";
import {
  SessionMessagePresentationError,
  describeSessionPresentationFault,
  presentSessionMessages,
  type SessionMessagePresentationInput,
} from "./session-message-presentation";

describe("presentSessionMessages", () => {
  it("groups every turn into one user and one assistant row without losing tool order", () => {
    const receipt = localReceipt("session-1", "turn-1");
    const events = sequence([
      draft("session.created", undefined, {}),
      draft("turn.requested", "turn-1", { content: "Inspect the workspace." }),
      draft("assistant.completed", "turn-1", {
        message: {
          role: "assistant",
          content: "I’ll inspect it.",
          toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
        },
      }),
      draft("tool.requested", "turn-1", {
        call: { id: "call-1", name: "read_file", arguments: { path: "README.md" } },
      }),
      draft("tool.approved", "turn-1", { callId: "call-1", name: "read_file" }),
      draft("tool.resulted", "turn-1", {
        callId: "call-1",
        name: "read_file",
        content: "# Airship",
        isError: false,
      }),
      draft("assistant.completed", "turn-1", {
        message: { role: "assistant", content: "The workspace is Airship." },
      }),
      draft("turn.completed", "turn-1", { receiptId: receipt.receiptId }),
      draft("turn.requested", "turn-2", { content: "Continue." }),
      draft("assistant.completed", "turn-2", {
        message: { role: "assistant", content: "I could not finish." },
      }),
      draft("turn.failed", "turn-2", { error: "Connection closed safely." }),
    ]);

    const view = presentSessionMessages(input(events, {
      receipts: [receipt],
      history: [
        { turnId: "turn-1", turnStatus: "completed", providerContext: "included" },
        { turnId: "turn-1", turnStatus: "completed", providerContext: "included" },
        { turnId: "turn-2", turnStatus: "failed", providerContext: "excluded" },
      ],
    }));

    expect(view.rows.map((row) => [row.turnId, row.role])).toEqual([
      ["turn-1", "user"],
      ["turn-1", "assistant"],
      ["turn-2", "user"],
      ["turn-2", "assistant"],
    ]);
    expect(view.rows[1]?.parts.map((part) => part.kind)).toEqual([
      "text",
      "tool-call",
      "tool-result",
      "text",
      "footer",
    ]);
    expect(view.rows[1]).toMatchObject({
      turnStatus: "completed",
      providerContext: "included",
      receipt: { receiptId: receipt.receiptId },
    });
    expect(view.rows[3]?.parts.map((part) => part.kind)).toEqual(["text", "error"]);
    expect(view.rows[3]).toMatchObject({ turnStatus: "failed", providerContext: "excluded" });
    expect(view.turnCount).toBe(2);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.rows)).toBe(true);
    expect(view.rows.every(Object.isFrozen)).toBe(true);
  });

  it("states an assistant row's pre-turn boundary separately from its fork-from-here boundary", () => {
    // Two boundaries, two meanings. "Fork from here" on an answer keeps the
    // answer, so `sourcePoint` is the turn's terminal event. Retry regenerates
    // the turn, so it needs the point before the request — reusing
    // `sourcePoint` for it handed the replacement answer the answer it was
    // replacing.
    const events = sequence([
      draft("session.created", undefined, {}),
      ...agentTurn("turn-1", "First", "First answer"),
      ...agentTurn("turn-2", "Second", "Second answer"),
    ]);
    const view = presentSessionMessages(input(events));
    const request = events.find((event) => event.type === "turn.requested" && event.turnId === "turn-2")!;
    const completed = events.find((event) => event.type === "turn.completed" && event.turnId === "turn-2")!;
    const assistant = assistantRow(view.rows, "turn-2");

    expect(assistant.sourcePoint).toEqual({ sequence: completed.sequence, digest: completed.digest });
    expect(assistant.turnStartPoint).toEqual({
      sequence: request.sequence - 1,
      digest: request.previousDigest,
    });
    expect(assistant.turnStartPoint).not.toEqual(assistant.sourcePoint);
    // The user row's own source point already is that boundary, so the two
    // rows agree about where the turn began.
    expect(view.rows.find((row) => row.turnId === "turn-2" && row.role === "user")?.sourcePoint)
      .toEqual(assistant.turnStartPoint);
  });

  it("replays completed, denied, and failed local commands between ordinary agent turns", () => {
    const events = sequence([
      draft("session.created", undefined, {}),
      ...agentTurn("agent-1", "Before one", "Before answer"),
      localDraft("local.command.requested", "local-complete", "operation-1", {
        content: "/read README.md",
        toolName: "read_file",
        arguments: { path: "README.md" },
      }),
      localDraft("local.command.approved", "local-complete", "operation-1", {
        toolName: "read_file",
      }),
      localDraft("local.command.completed", "local-complete", "operation-1", {
        toolName: "read_file",
        content: "# Airship",
        isError: false,
        metadata: { bytes: 9 },
      }),
      ...agentTurn("agent-2", "Between one", "Between answer"),
      localDraft("local.command.requested", "local-denied", "operation-2", {
        content: "/write protected.txt",
        toolName: "write_file",
        arguments: { path: "protected.txt", content: "blocked" },
      }),
      localDraft("local.command.denied", "local-denied", "operation-2", {
        toolName: "write_file",
        content: "Permission denied locally.",
      }),
      ...agentTurn("agent-3", "Between two", "Another answer"),
      localDraft("local.command.requested", "local-failed", "operation-3", {
        content: "/read missing.txt",
        toolName: "read_file",
        arguments: { path: "missing.txt" },
      }),
      localDraft("local.command.approved", "local-failed", "operation-3", {
        toolName: "read_file",
      }),
      localDraft("local.command.failed", "local-failed", "operation-3", {
        toolName: "read_file",
        content: "The local read failed safely.",
        cancelled: false,
      }),
      ...agentTurn("agent-4", "After all", "Final answer"),
    ]);
    const value = input(events);
    const view = presentSessionMessages({
      ...value,
      // Protocol-v1 currently reports local.command.* as completeness warnings.
      audit: { ...value.audit, status: "incomplete" },
    });

    expect(view.rows.filter((row) => row.role === "user").map((row) => row.turnId)).toEqual([
      "agent-1",
      "local-complete",
      "agent-2",
      "local-denied",
      "agent-3",
      "local-failed",
      "agent-4",
    ]);

    const completed = assistantRow(view.rows, "local-complete");
    expect(completed.parts.map((part) => part.kind)).toEqual(["tool-call", "tool-result", "footer"]);
    expect(completed.parts[0]).toMatchObject({ kind: "tool-call", status: "completed" });
    expect(completed.parts[1]).toMatchObject({ kind: "tool-result", status: "success", summary: "# Airship" });
    expect(completed).toMatchObject({ turnStatus: "completed", providerContext: "excluded" });
    expect(completed.receipt).toBeUndefined();

    const denied = assistantRow(view.rows, "local-denied");
    expect(denied.parts.map((part) => part.kind)).toEqual(["tool-call", "tool-result", "footer"]);
    expect(denied.parts[0]).toMatchObject({ kind: "tool-call", status: "denied" });
    expect(denied.parts[1]).toMatchObject({ kind: "tool-result", status: "denied" });
    expect(denied).toMatchObject({ turnStatus: "completed", providerContext: "excluded" });

    const failed = assistantRow(view.rows, "local-failed");
    expect(failed.parts.map((part) => part.kind)).toEqual(["tool-call", "error", "footer"]);
    expect(failed.parts[0]).toMatchObject({ kind: "tool-call", status: "failed" });
    expect(failed.parts[1]).toMatchObject({ kind: "error", code: "local.command.failed" });
    expect(failed).toMatchObject({ turnStatus: "failed", providerContext: "excluded" });

    expect(assistantRow(view.rows, "agent-2")).toMatchObject({
      turnStatus: "completed",
      providerContext: "included",
    });
  });

  it("maps a durably marked local cancellation to cancelled and accepts a local-command tail boundary", () => {
    const events = sequence([
      localDraft("local.command.requested", "local-cancelled", "operation-9", {
        content: "/read slow.txt",
        toolName: "read_file",
        arguments: { path: "slow.txt" },
      }),
      localDraft("local.command.approved", "local-cancelled", "operation-9", {
        toolName: "read_file",
      }),
      localDraft("local.command.failed", "local-cancelled", "operation-9", {
        toolName: "read_file",
        content: "Stopped before completion.",
        cancelled: true,
      }),
    ], 70);
    const value = input(events);
    const view = presentSessionMessages({
      ...value,
      audit: { ...value.audit, status: "incomplete" },
    });

    expect(view.page).toEqual({ firstSequence: 71, lastSequence: 73, omittedPrefix: true });
    expect(assistantRow(view.rows, "local-cancelled")).toMatchObject({
      turnStatus: "cancelled",
      providerContext: "excluded",
      parts: [
        expect.objectContaining({ kind: "tool-call", status: "failed" }),
        expect.objectContaining({ kind: "error", code: "local.command.cancelled" }),
        expect.objectContaining({ kind: "footer" }),
      ],
    });

    const midCommand = events.slice(1);
    expectPresentationError(() => presentSessionMessages(input(midCommand)), "MID_TURN_SLICE");
  });

  it("rejects malformed local command identity, approval order, and provider receipts", () => {
    const missingApproval = sequence([
      draft("session.created", undefined, {}),
      localDraft("local.command.requested", "local-1", "operation-1", {
        content: "/read README.md",
        toolName: "read_file",
        arguments: { path: "README.md" },
      }),
      localDraft("local.command.completed", "local-1", "operation-1", {
        toolName: "read_file",
        content: "unexpected",
      }),
    ]);
    expectPresentationError(() => presentSessionMessages(input(missingApproval)), "TURN_PROTOCOL_INVALID");

    const changedOperation = sequence([
      draft("session.created", undefined, {}),
      localDraft("local.command.requested", "local-1", "operation-1", {
        content: "/read README.md",
        toolName: "read_file",
        arguments: { path: "README.md" },
      }),
      localDraft("local.command.failed", "local-1", "operation-2", {
        toolName: "read_file",
        content: "failed",
      }),
    ]);
    expectPresentationError(() => presentSessionMessages(input(changedOperation)), "TURN_PROTOCOL_INVALID");

    const denied = sequence([
      draft("session.created", undefined, {}),
      localDraft("local.command.requested", "local-1", "operation-1", {
        content: "/write README.md",
        toolName: "write_file",
        arguments: { path: "README.md" },
      }),
      localDraft("local.command.denied", "local-1", "operation-1", {
        toolName: "write_file",
        content: "denied",
      }),
    ]);
    expectPresentationError(() => presentSessionMessages(input(denied, {
      receipts: [localReceipt("session-1", "local-1")],
    })), "RECEIPT_MISMATCH");
  });

  it("accepts a contiguous tail page only when it begins at a turn boundary", () => {
    const events = sequence([
      draft("turn.requested", "turn-tail", { content: "Tail request" }),
      draft("assistant.completed", "turn-tail", {
        message: { role: "assistant", content: "Tail response" },
      }),
      draft("turn.completed", "turn-tail", {}),
    ], 40);

    const view = presentSessionMessages(input(events));
    expect(view.page).toEqual({ firstSequence: 41, lastSequence: 43, omittedPrefix: true });
    expect(view.rows.map((row) => row.role)).toEqual(["user", "assistant"]);

    const midTurn = events.slice(1);
    expectPresentationError(() => presentSessionMessages(input(midTurn)), "MID_TURN_SLICE");
  });

  it("rejects either audit or event pages that do not end at the selected head", () => {
    const events = sequence([
      draft("session.created", undefined, {}),
      draft("turn.requested", "turn-1", { content: "Hello" }),
    ]);
    const valid = input(events);

    expectPresentationError(() => presentSessionMessages({
      ...valid,
      session: { ...valid.session, headDigest: "different" },
    }), "HEAD_MISMATCH");
    expectPresentationError(() => presentSessionMessages({
      ...valid,
      audit: { ...valid.audit, commitment: { ...valid.audit.commitment, sequence: 1 } },
    }), "HEAD_MISMATCH");
    expectPresentationError(() => presentSessionMessages({
      ...valid,
      audit: { ...valid.audit, status: "invalid" },
    }), "AUDIT_REJECTED");
  });

  it("rejects non-contiguous pages, cross-session events, and oversized input", () => {
    const events = sequence([
      draft("session.created", undefined, {}),
      draft("turn.requested", "turn-1", { content: "Hello" }),
      draft("turn.failed", "turn-1", { error: "Stopped" }),
    ]);
    const gap = structuredClone(events);
    gap[1]!.sequence = 9;
    expectPresentationError(() => presentSessionMessages(input(gap)), "EVENT_ORDER_INVALID");

    const mixed = structuredClone(events);
    mixed[1]!.sessionId = "session-2";
    expectPresentationError(() => presentSessionMessages(input(mixed)), "SESSION_MISMATCH");

    expectPresentationError(() => presentSessionMessages(input(events, {
      limits: { maxEvents: 2 },
    })), "BOUND_EXCEEDED");
  });

  it("preserves an incomplete terminal disposition under an incomplete audit", () => {
    const events = sequence([
      draft("session.created", undefined, {}),
      draft("turn.requested", "turn-open", { content: "Begin" }),
      draft("inference.started", "turn-open", { step: 0 }),
    ]);
    const value = input(events);
    const view = presentSessionMessages({
      ...value,
      audit: { ...value.audit, status: "incomplete" },
    });

    expect(view.auditStatus).toBe("incomplete");
    expect(view.rows).toHaveLength(2);
    expect(view.rows.every((row) =>
      row.turnStatus === "incomplete" && row.providerContext === "excluded"
    )).toBe(true);
    expect(view.rows[1]?.parts).toEqual([]);
  });

  it("keeps receipt IDs display-only and rejects contradictory receipt or history metadata", () => {
    const receipt = localReceipt("session-1", "turn-1");
    const events = sequence([
      draft("session.created", undefined, {}),
      draft("turn.requested", "turn-1", { content: "Hello" }),
      draft("assistant.completed", "turn-1", {
        message: { role: "assistant", content: "Hello back" },
      }),
      draft("turn.completed", "turn-1", { receiptId: "another-receipt" }),
    ]);

    expectPresentationError(() => presentSessionMessages(input(events, {
      receipts: [receipt],
    })), "RECEIPT_MISMATCH");
    expectPresentationError(() => presentSessionMessages(input(events, {
      history: [{ turnId: "turn-1", turnStatus: "failed", providerContext: "excluded" }],
    })), "HISTORY_MISMATCH");

    const otherSessionReceipt = localReceipt("session-2", "turn-elsewhere");
    expectPresentationError(() => presentSessionMessages(input(events, {
      receipts: [otherSessionReceipt],
    })), "SESSION_MISMATCH");
  });

  it("returns an empty immutable view only for the genesis head", () => {
    const view = presentSessionMessages({
      session: { id: "session-1", headSequence: 0, headDigest: "genesis" },
      audit: {
        status: "verified",
        sessionId: "session-1",
        commitment: { sequence: 0, digest: "genesis" },
      },
      events: [],
    });
    expect(view.rows).toEqual([]);
    expect(view.page).toEqual({ firstSequence: 0, lastSequence: 0, omittedPrefix: false });

    expectPresentationError(() => presentSessionMessages({
      ...input(sequence([draft("session.created", undefined, {})])),
      events: [],
    }), "HEAD_MISMATCH");
  });
});

/*
 * ── The two validators must agree ────────────────────────────────────────
 *
 * `auditSessionHistory` and `presentSessionMessages` are both asked whether a
 * journal is sound, and they disagreed. The audit dispatches on an allow-list —
 * it reacts to the types it knows and warns about the rest — while the
 * presentation fell through to `requiredTurnId`, a throw, for anything that was
 * not a turn. protocol-v1 defines session-scoped events with no `turnId` at
 * all, so a journal the audit rated `verified` raised a protocol error in the
 * renderer, and because the renderer runs *inside* vault adoption, one such
 * event made an entire vault unadoptable.
 *
 * Nothing was corrupt. `session.renamed` is written by Airship itself on the
 * first prompt of every default-titled session, and by the Rename control in
 * the Sessions route; renaming also bumps `updatedAt`, which is the sort key
 * that elects the session adoption tries to resume. The act that made a session
 * unpresentable promoted it to the resume slot.
 *
 * These cases are the deliverable. They are written against the *real* journal
 * and the *real* audit — no hand-built digests — so they cannot pass by
 * agreeing with a fixture instead of with the code.
 */
describe("presentSessionMessages agrees with auditSessionHistory", () => {
  it("presents the durable active-conversation pointer as a comprehensible session record", async () => {
    const journal = memoryJournal();
    const created = await journal.createSession("General conversation", await auditProfileManifest());
    const profileId = created.manifest.profile!.profileId;
    await selectProfileActiveConversation(journal, profileId, created.id);
    const session = (await journal.getSession(created.id))!;
    const events = await journal.readEvents(created.id);
    const audit = await auditSessionHistory({ session, events });
    expect(audit.status).toBe("verified");

    const view = presentSessionMessages({ session, audit, events });
    expect(view.markers).toHaveLength(1);
    expect(view.markers[0]).toMatchObject({
      kind: "profile.active-conversation.selected",
      presentable: true,
      detail: "Selected as this profile’s active conversation.",
    });
  });

  it("presents a renamed session, the way Airship's own auto-title writes it", async () => {
    const journal = memoryJournal();
    const created = await journal.createSession("General conversation", await auditManifest());
    // Exactly what `app.tsx` does on the first prompt of a default-titled
    // session: rename at headSequence 1, before the turn is requested.
    await journal.renameSession(created.id, "Say the single word: ok");
    await appendAuditableTurn(journal, created.id, "turn-1", "Say the single word: ok", "ok");
    const session = (await journal.getSession(created.id))!;
    const events = await journal.readEvents(session.id);
    const audit = await auditSessionHistory({ session, events });

    // The premise: the audit is happy. If this ever stops holding, the two
    // validators are being reconciled by weakening the audit, which would rate
    // every real user's correct journal invalid.
    expect(audit.status).toBe("verified");

    const view = presentSessionMessages({ session, audit, events });

    expect(view.turnCount).toBe(1);
    expect(view.rows).toHaveLength(2);
    // The rename is not silently skipped: it is a durable record the user
    // created, and it comes back with its position in the chain.
    expect(view.markers).toHaveLength(1);
    expect(view.markers[0]).toMatchObject({
      kind: "session.renamed",
      sequence: 2,
      presentable: true,
      detail: "Renamed to “Say the single word: ok”",
    });
    expect(view.markers[0]!.digest).toBe(events[1]!.digest);
  });

  it("presents a rename made mid-conversation, in its own place in the chain", async () => {
    const journal = memoryJournal();
    const created = await journal.createSession("Audit fixture", await auditManifest());
    await appendAuditableTurn(journal, created.id, "turn-1", "First", "One");
    // The shipped Rename control in the Sessions route, between two turns.
    await journal.renameSession(created.id, "Renamed midway");
    await appendAuditableTurn(journal, created.id, "turn-2", "Second", "Two");
    const session = (await journal.getSession(created.id))!;
    const events = await journal.readEvents(session.id);
    const audit = await auditSessionHistory({ session, events });
    expect(audit.status).toBe("verified");

    const renameSequence = events.find((event) => event.type === "session.renamed")!.sequence;
    const view = presentSessionMessages({ session, audit, events });
    expect(view.turnCount).toBe(2);
    expect(view.markers.map((marker) => marker.sequence)).toEqual([renameSequence]);
    // Between the two turns, not appended at the end: a divider whose position
    // has been lost is a record whose meaning has been lost. Turn one's two
    // rows sit below it in the chain and turn two's two rows sit above it.
    expect(view.rows.filter((row) => row.sequence < renameSequence).map((row) => row.turnId))
      .toEqual(["turn-1", "turn-1"]);
    expect(view.rows.filter((row) => row.sequence > renameSequence).map((row) => row.turnId))
      .toEqual(["turn-2", "turn-2"]);
  });

  it("accounts for a session-scoped record it cannot read, instead of refusing the page", () => {
    // Stands in for a protocol type a future build adds and this one does not
    // know. The audit warns and keeps going; the presentation must do the same,
    // and must say on screen that the record is there.
    const events = sequence([
      draft("session.created", undefined, {}),
      draft("session.archived.v2", undefined, { reason: "unknown to this build" }),
      ...agentTurn("turn-1", "Ask", "Answer"),
    ]);
    const view = presentSessionMessages(input(events));

    expect(view.turnCount).toBe(1);
    expect(view.markers).toHaveLength(1);
    expect(view.markers[0]).toMatchObject({ kind: "session.archived.v2", presentable: false });
    expect(view.markers[0]!.detail).toContain("cannot replay");
    expect(view.markers[0]!.detail).toContain("intact in the journal");
  });

  /**
   * Every branch — fork, Edit & branch, retry — opens on this record, and it
   * opened by telling its author the build could not replay something the
   * build had written itself one operation earlier. The marker now carries the
   * lineage the seed proves: where the branch was taken, and what came across.
   */
  it("presents the fork context seed it wrote itself as a lineage sentence", async () => {
    const journal = memoryJournal();
    const created = await journal.createSession("Source", await auditManifest());
    await appendAuditableTurn(journal, created.id, "turn-1", "First", "One");
    const library = new SessionLibrary(journal, { now: () => "2026-07-18T00:01:00.000Z" });
    const fork = await library.fork(created.id);

    const session = (await journal.getSession(fork.session.id))!;
    const events = await journal.readEvents(session.id);
    const audit = await auditSessionHistory({ session, events });
    expect(audit.status).toBe("verified");

    const view = presentSessionMessages({ session, audit, events });
    expect(view.markers).toHaveLength(1);
    const marker = view.markers[0]!;
    expect(marker.kind).toBe("session.fork.context.seeded");
    expect(marker.presentable).toBe(true);
    expect(marker.detail).toContain(`at event ${String(fork.sourceBoundarySequence)}`);
    expect(marker.detail).toContain(`${String(fork.contextMessageCount)} ancestor messages carried`);
    expect(marker.detail).toContain(`${String(fork.omittedContextMessages)} omitted`);
    expect(marker.detail).not.toContain("cannot replay");
    // The raw event type belongs to the provenance line under the sentence,
    // never inside the sentence a reader is meant to understand.
    expect(marker.detail).not.toContain("session.fork.context.seeded");
    // And the messages themselves, so the count is a disclosure the reader can
    // open rather than a claim they have to take on faith over an empty screen.
    expect(marker.carriedContext).toHaveLength(fork.contextMessageCount);
    expect(marker.carriedContext).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "One" },
    ]);
  });

  /*
   * The record of a decision the *person* proposed — Create branch, Import
   * repository, probe the vault — is written with a fresh turn and operation ID
   * precisely so the audit can prove it is not a step of any turn. The grouper
   * read that identity as turn membership, looked for the `turn.requested`
   * boundary the contract says will never exist, and threw. One approved Git
   * operation therefore made the whole conversation unreplayable, and because
   * the renderer runs inside the profile switch, switching back to that profile
   * failed and silently reverted to the profile the user had just left.
   */
  it("presents a human-initiated approval as the out-of-turn record the audit defines", async () => {
    const journal = memoryJournal();
    const created = await journal.createSession("General silo checkpoint", await auditManifest());
    await appendAuditableTurn(journal, created.id, "turn-1", "First", "One");
    // Exactly the shape `reviewHumanIntent` writes for a Git approval taken
    // from the Workspace while a conversation is open.
    await journal.append(created.id, [{
      type: HUMAN_INTENT_EVENT_TYPE,
      turnId: "human-git-8f2c",
      operationId: "git-4b19",
      payload: {
        toolName: "git_branch-create",
        effect: "write",
        decision: "allow",
        summary: "Create the local branch profile-silo-alpha.",
        arguments: { branch: "profile-silo-alpha" },
        approval: { source: "bounded-browser-sandbox", mode: "full-access" },
      },
    }]);
    await appendAuditableTurn(journal, created.id, "turn-2", "Second", "Two");
    const session = (await journal.getSession(created.id))!;
    const events = await journal.readEvents(session.id);
    const audit = await auditSessionHistory({ session, events });

    // The premise: the audit rates this journal sound. The renderer disagreeing
    // with it is the defect, so reconciling them by loosening the audit would
    // be reconciling the wrong one.
    expect(audit.status).toBe("verified");

    const view = presentSessionMessages({ session, audit, events });
    // Both turns survive, in their own places, with the decision between them.
    expect(view.turnCount).toBe(2);
    expect(view.rows.map((row) => row.turnId)).toEqual(["turn-1", "turn-1", "turn-2", "turn-2"]);
    expect(view.markers).toHaveLength(1);
    const marker = view.markers[0]!;
    expect(marker.kind).toBe(HUMAN_INTENT_EVENT_TYPE);
    expect(marker.presentable).toBe(true);
    expect(marker.detail).toContain("Allowed git_branch-create");
    expect(marker.detail).toContain("write effect");
    expect(marker.detail).toContain("outside any turn");
    // The authority is named for the same reason the tool cards name it.
    expect(marker.detail).toContain("Full Access");
    expect(marker.detail).not.toContain("cannot replay");
    expect(marker.sequence).toBeGreaterThan(view.rows[1]!.endSequence);
    expect(marker.sequence).toBeLessThan(view.rows[2]!.sequence);
  });

  /*
   * Naming is a real billed request made beside a turn rather than in it, so it
   * declares its own identity and then reports its usage under it. The audit
   * admits that usage against the record that declared it; the renderer refused
   * it, which would have stranded every auto-named conversation the same way.
   */
  it("presents the naming inference and the usage it declared, and still refuses an undeclared one", async () => {
    const journal = memoryJournal();
    const created = await journal.createSession("General conversation", await auditManifest());
    await appendAuditableTurn(journal, created.id, "turn-1", "Say the single word: ok", "ok");
    await journal.append(created.id, [
      {
        type: CONVERSATION_NAMED_EVENT_TYPE,
        turnId: "naming-turn-1",
        operationId: "naming-operation-1",
        payload: { title: "Saying the word ok", answer: "Saying the word ok", model: "airship/test-model" },
      },
      {
        type: "inference.usage",
        turnId: "naming-turn-1",
        operationId: "naming-operation-1",
        payload: { inputTokens: 42, outputTokens: 5, source: "conversation-naming" },
      },
    ]);
    const session = (await journal.getSession(created.id))!;
    const events = await journal.readEvents(session.id);
    const audit = await auditSessionHistory({ session, events });
    expect(audit.status).toBe("verified");

    const view = presentSessionMessages({ session, audit, events });
    expect(view.turnCount).toBe(1);
    expect(view.markers.map((entry) => entry.kind)).toEqual([CONVERSATION_NAMED_EVENT_TYPE, "inference.usage"]);
    expect(view.markers[0]!.presentable).toBe(true);
    expect(view.markers[0]!.detail).toContain("Saying the word ok");
    expect(view.markers[0]!.detail).toContain("airship/test-model");
    expect(view.markers[1]!.presentable).toBe(true);
    expect(view.markers.every((entry) => !entry.detail.includes("cannot replay"))).toBe(true);

    // The admission is exactly as wide as the audit's: usage is out-of-turn
    // only when a naming record ahead of it declared that identity. An orphan
    // is still a protocol violation, so the leniency cannot be borrowed to
    // smuggle a turn event past its missing boundary.
    expectPresentationError(() => presentSessionMessages(input(sequence([
      draft("session.created", undefined, {}),
      { type: "inference.usage", turnId: "naming-turn-1", operationId: "naming-operation-1", payload: { inputTokens: 42 } },
    ]))), "TURN_PROTOCOL_INVALID");
  });

  /*
   * The naming receipt was being minted, validated and journaled while nothing
   * on any surface could open it: turn receipts ride assistant rows, and a
   * record with no row had no carrier at all. Proof resolves against the
   * receipts the transcript items hand it, so the marker has to carry its own.
   */
  it("binds an out-of-turn inference marker to its receipt, and leaves every other marker without one", () => {
    const turnReceipt = localReceipt("session-1", "turn-1");
    const namingReceipt = localReceipt("session-1", "naming-turn-1");
    const view = presentSessionMessages(input(sequence([
      draft("session.created", undefined, {}),
      ...agentTurn("turn-1", "Say ok", "ok"),
      localDraft(CONVERSATION_NAMED_EVENT_TYPE, "naming-turn-1", "naming-operation-1", {
        title: "Saying ok",
        answer: "Saying ok",
        model: "airship/demo-v1",
      }),
      draft("session.renamed", undefined, { title: "Saying ok" }),
    ]), { receipts: [turnReceipt, namingReceipt] }));

    const naming = view.markers.find((marker) => marker.kind === CONVERSATION_NAMED_EVENT_TYPE)!;
    expect(naming.turnId).toBe("naming-turn-1");
    expect(naming.receipt?.receiptId).toBe(namingReceipt.receiptId);
    // The turn's own receipt still belongs to the turn, and a bookkeeping
    // record that made no provider request must not appear to have evidence.
    expect(view.rows[1]!.receipt?.receiptId).toBe(turnReceipt.receiptId);
    const renamed = view.markers.find((marker) => marker.kind === "session.renamed")!;
    expect(renamed.receipt).toBeUndefined();
    expect(renamed.turnId).toBeUndefined();
  });

  /*
   * A completed naming call whose answer is a refusal or an essay is still a
   * billed, attested request. Recording it and then rendering "this build
   * cannot replay" would be the same erasure in a new place.
   */
  it("reports a naming request that returned no usable name, rather than calling the record unreadable", () => {
    const view = presentSessionMessages(input(sequence([
      draft("session.created", undefined, {}),
      ...agentTurn("turn-1", "Say ok", "ok"),
      localDraft(CONVERSATION_NAMED_EVENT_TYPE, "naming-turn-1", "naming-operation-1", {
        answer: "I'm sorry, but I can't help with naming this conversation.",
        model: "airship/demo-v1",
      }),
    ])));

    const naming = view.markers.find((marker) => marker.kind === CONVERSATION_NAMED_EVENT_TYPE)!;
    expect(naming.presentable).toBe(true);
    expect(naming.detail).toContain("no usable name");
    expect(naming.detail).toContain("airship/demo-v1");
    expect(naming.detail).not.toContain("cannot replay");
  });

  it("still refuses a turn event that lost its turn identity, and says which one", () => {
    // The permissiveness above is scoped to types that are not turn-scoped. An
    // `assistant.completed` with no turn is a real protocol violation and stays
    // one — but the fault now names the session, the sequence and the type
    // rather than handing the user a bare event UUID.
    const events = sequence([
      draft("session.created", undefined, {}),
      draft("turn.requested", "turn-1", { content: "Ask" }),
      draft("assistant.completed", undefined, { message: { role: "assistant", content: "Orphan" } }),
      draft("turn.completed", "turn-1", {}),
    ]);
    try {
      presentSessionMessages(input(events));
      throw new Error("Expected presentation to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionMessagePresentationError);
      const fault = error as SessionMessagePresentationError;
      expect(fault.code).toBe("TURN_PROTOCOL_INVALID");
      expect(fault.sessionId).toBe("session-1");
      expect(fault.sequence).toBe(3);
      expect(fault.eventType).toBe("assistant.completed");
      const described = describeSessionPresentationFault(fault);
      expect(described).toContain("at event 3");
      expect(described).toContain("assistant.completed");
      // The short id, which is what a fault line has room for.
      expect(described).toContain("in session session-1".slice(0, "in session ".length + 8));
    }
  });

  /*
   * The journal has recorded who authorized every tool call since approval
   * modes shipped, and the transcript read none of it: a call a person clicked
   * Allow on, one a review model waved through, and one Full Access ran unasked
   * were three identical cards. Those are three different accountability
   * claims.
   */
  it("labels each approved tool call with the authority that actually allowed it", () => {
    const call = (id: string, name: string) => ({ id, name, arguments: {} });
    const events = sequence([
      draft("session.created", undefined, {}),
      draft("turn.requested", "turn-1", { content: "Do three things." }),
      draft("assistant.completed", "turn-1", {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [call("call-1", "write_file"), call("call-2", "write_file"), call("call-3", "write_file")],
        },
      }),
      draft("tool.requested", "turn-1", { call: call("call-1", "write_file") }),
      draft("tool.approved", "turn-1", {
        callId: "call-1",
        name: "write_file",
        approval: { mode: "ask-first", source: "human", reason: "Allowed once by the user." },
      }),
      draft("tool.requested", "turn-1", { call: call("call-2", "write_file") }),
      draft("tool.approved", "turn-1", {
        callId: "call-2",
        name: "write_file",
        approval: { mode: "auto-approve", source: "model-review", reason: "Reviewed as safe." },
      }),
      draft("tool.requested", "turn-1", { call: call("call-3", "write_file") }),
      draft("tool.approved", "turn-1", {
        callId: "call-3",
        name: "write_file",
        approval: { mode: "full-access", source: "bounded-browser-sandbox", reason: "Allowed by Full Access." },
      }),
      draft("turn.completed", "turn-1", {}),
    ]);

    const view = presentSessionMessages(input(events));

    expect(assistantRow(view.rows, "turn-1").toolAuthorities).toEqual([
      { callId: "call-1", mode: "ask-first", source: "human", label: "You approved" },
      { callId: "call-2", mode: "auto-approve", source: "model-review", label: "Model review" },
      { callId: "call-3", mode: "full-access", source: "bounded-browser-sandbox", label: "Full Access" },
    ]);
  });

  it("leaves the authority absent rather than guessing when the provenance is unreadable", () => {
    const events = sequence([
      draft("session.created", undefined, {}),
      draft("turn.requested", "turn-1", { content: "Do one thing." }),
      draft("assistant.completed", "turn-1", {
        message: { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "write_file", arguments: {} }] },
      }),
      draft("tool.requested", "turn-1", { call: { id: "call-1", name: "write_file", arguments: {} } }),
      draft("tool.approved", "turn-1", { callId: "call-1", name: "write_file", approval: null }),
      draft("turn.completed", "turn-1", {}),
    ]);

    // "We do not know who approved this" must never render as "you approved it".
    expect(assistantRow(presentSessionMessages(input(events)).rows, "turn-1").toolAuthorities).toBeUndefined();
  });

  it("labels a local command with the authority recorded on its own approval", () => {
    const events = sequence([
      draft("session.created", undefined, {}),
      localDraft("local.command.requested", "local-1", "operation-1", {
        content: "/read README.md",
        toolName: "read_file",
        arguments: { path: "README.md" },
      }),
      localDraft("local.command.approved", "local-1", "operation-1", {
        toolName: "read_file",
        approval: { mode: "ask-first", source: "human", reason: "Allowed once by the user." },
      }),
      localDraft("local.command.completed", "local-1", "operation-1", {
        toolName: "read_file",
        content: "# Airship",
        isError: false,
      }),
    ]);
    const value = input(events);

    const view = presentSessionMessages({ ...value, audit: { ...value.audit, status: "incomplete" } });

    expect(assistantRow(view.rows, "local-1").toolAuthorities).toEqual([
      { callId: "operation-1", mode: "ask-first", source: "human", label: "You approved" },
    ]);
  });
});

function memoryJournal(): EventJournal {
  let tick = 0;
  let id = 0;
  return new EventJournal(
    new MemoryJournalBackend(),
    () => `2026-07-18T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    () => `event-${String(++id)}`,
  );
}

/**
 * One turn the audit accepts in full: request, inference, digest-bound
 * assistant message, receipt and completion.
 *
 * Written out rather than hand-stubbed because these cases exist to prove the
 * *audit* and the *presentation* agree. A turn the audit merely tolerates would
 * let the pair agree about a journal neither of them really approves.
 */
async function appendAuditableTurn(
  journal: EventJournal,
  sessionId: string,
  turnId: string,
  prompt: string,
  answer: string,
): Promise<void> {
  const operationId = `inference-${turnId}`;
  const session = (await journal.getSession(sessionId))!;
  const priorEvents = await journal.readEvents(sessionId);
  const messages: CanonicalMessage[] = [];
  for (const event of priorEvents) {
    const payload = event.payload as unknown as { content?: string; message?: CanonicalMessage };
    if (event.type === "turn.requested") messages.push({ role: "user", content: payload.content! });
    if (event.type === "assistant.completed") messages.push(payload.message!);
  }
  messages.push({ role: "user", content: prompt });
  await journal.append(sessionId, [{ type: "turn.requested", turnId, payload: { content: prompt } }]);
  const requestDigest = await sha256(stableStringify({
    model: session.manifest.model,
    systemPromptDigest: session.manifest.systemPromptDigest,
    messages,
    tools: session.manifest.tools,
    idempotencyKey: `${sessionId}:${turnId}:0`,
  } as unknown as JsonValue));
  await journal.append(sessionId, [{
    type: "inference.started",
    turnId,
    operationId,
    payload: {
      step: 0,
      providerId: session.manifest.providerId,
      model: session.manifest.model,
      posture: "local",
      requestDigest,
      idempotencyKey: `${sessionId}:${turnId}:0`,
    },
  }]);
  const responseDigest = await sha256(answer);
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
    {
      type: "assistant.completed",
      turnId,
      operationId,
      payload: {
        message: { role: "assistant", content: answer },
        finishReason: "stop",
        responseDigest,
        receipt: receipt as unknown as JsonValue,
      },
    },
    { type: "turn.completed", turnId, payload: { responseDigest, receiptId: receipt.receiptId } },
  ]);
}

function auditManifest() {
  return createSessionManifest({
    systemPrompt: "Be exact and preserve evidence.",
    providerId: "demo",
    model: "airship/test-model",
    tools: [],
    workspaceId: "memory://presentation-test",
    capabilityTier: "web-baseline",
    now: "2026-07-18T00:00:00.000Z",
  });
}

async function auditProfileManifest() {
  const digest = await sha256("profile-presentation-fixture");
  return createSessionManifest({
    systemPrompt: "Be exact and preserve profile evidence.",
    providerId: "demo",
    model: "airship/test-model",
    tools: [],
    workspaceId: "memory://presentation-test",
    capabilityTier: "web-baseline",
    now: "2026-07-18T00:00:00.000Z",
    profile: {
      version: 2,
      profileId: "general",
      profileRevision: digest,
      themeId: "airship",
      themeDigest: digest,
      resolvedSkills: [],
      skillSetDigest: await sha256(stableStringify([] as JsonValue)),
      resolutionDigest: digest,
      workspaceBinding: { kind: "active-workspace" },
      memoryScope: "profile",
      approvalMode: "ask-first",
      minimumPosture: "local",
    },
  });
}

type Draft = Readonly<{
  type: string;
  turnId?: string;
  operationId?: string;
  payload: JsonValue;
}>;

/*
 * The contract `app.tsx` re-addresses a running turn's row to.
 *
 * A reader who steps into another conversation mid-turn and steps back gets
 * this projection, not their live rows — the transcript array is replaced
 * wholesale on open. So the running turn has to survive projection, and its
 * assistant row has to land on the id the live stream slots are keyed by
 * (`adoptJournalTurnAddress`). If a turn without a terminal were dropped
 * here, or if the id were derived from anything but the turn id, the answer
 * would go back to streaming into a row nobody can see.
 */
describe("a turn still in flight projects the row its live stream is addressed to", () => {
  it("emits both rows for an unterminated turn, the assistant one keyed by turn id", () => {
    const events = sequence([
      draft("session.created", undefined, {}),
      ...agentTurn("turn-1", "First", "First answer"),
      // No assistant.completed and no terminal: the turn is mid-flight.
      draft("turn.requested", "turn-2", { content: "Still thinking" }),
    ]);

    const view = presentSessionMessages(input(events));
    const assistant = view.rows.find((row) => row.role === "assistant" && row.turnId === "turn-2");
    const user = view.rows.find((row) => row.role === "user" && row.turnId === "turn-2");

    expect(user).toBeDefined();
    expect(assistant).toBeDefined();
    expect(assistant?.id).toBe("message:turn-2:assistant");
    // Named as unfinished, so nothing downstream reads it as a settled answer.
    expect(assistant?.turnStatus).toBe("incomplete");
    // And the finished turn beside it is untouched by the running one.
    expect(view.rows.find((row) => row.role === "assistant" && row.turnId === "turn-1")?.turnStatus).toBe("completed");
  });
});

function draft(type: string, turnId: string | undefined, payload: JsonValue): Draft {
  return { type, ...(turnId ? { turnId } : {}), payload };
}

function localDraft(
  type: string,
  turnId: string,
  operationId: string,
  payload: JsonValue,
): Draft {
  return { type, turnId, operationId, payload };
}

function agentTurn(turnId: string, request: string, response: string): Draft[] {
  return [
    draft("turn.requested", turnId, { content: request }),
    draft("assistant.completed", turnId, { message: { role: "assistant", content: response } }),
    draft("turn.completed", turnId, {}),
  ];
}

function sequence(drafts: readonly Draft[], offset = 0): DurableEvent[] {
  return drafts.map((event, index) => {
    const sequenceNumber = offset + index + 1;
    return {
      ...event,
      version: 1,
      eventId: `event-${String(sequenceNumber)}`,
      sessionId: "session-1",
      sequence: sequenceNumber,
      recordedAt: `2026-07-18T00:00:${String(index).padStart(2, "0")}.000Z`,
      previousDigest: sequenceNumber === 1 ? "genesis" : `digest-${String(sequenceNumber - 1)}`,
      digest: `digest-${String(sequenceNumber)}`,
    };
  });
}

function input(
  events: readonly DurableEvent[],
  options: Readonly<{
    receipts?: readonly ConversationReceipt[];
    history?: SessionMessagePresentationInput["history"];
    limits?: SessionMessagePresentationInput["limits"];
  }> = {},
): SessionMessagePresentationInput {
  const last = events.at(-1);
  const head = {
    sequence: last?.sequence ?? 0,
    digest: last?.digest ?? "genesis",
  };
  return {
    session: { id: "session-1", headSequence: head.sequence, headDigest: head.digest },
    audit: { status: "verified", sessionId: "session-1", commitment: head },
    events,
    ...options,
  };
}

function localReceipt(sessionId: string, turnId: string): ConversationReceipt {
  return createLocalReceipt({
    sessionId,
    turnId,
    provider: "demo",
    model: "airship/demo-v1",
    now: "2026-07-18T00:01:00.000Z",
  });
}

function expectPresentationError(
  action: () => unknown,
  code: SessionMessagePresentationError["code"],
): void {
  try {
    action();
    throw new Error("Expected presentation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(SessionMessagePresentationError);
    expect((error as SessionMessagePresentationError).code).toBe(code);
  }
}

function assistantRow(
  rows: ReturnType<typeof presentSessionMessages>["rows"],
  turnId: string,
) {
  const row = rows.find((candidate) => candidate.turnId === turnId && candidate.role === "assistant");
  expect(row).toBeDefined();
  return row!;
}
