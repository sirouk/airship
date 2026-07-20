import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../core/contracts";
import type { DurableEvent } from "../../core/journal";
import { createLocalReceipt, type ConversationReceipt } from "../../receipts/types";
import {
  SessionMessagePresentationError,
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

type Draft = Readonly<{
  type: string;
  turnId?: string;
  operationId?: string;
  payload: JsonValue;
}>;

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
