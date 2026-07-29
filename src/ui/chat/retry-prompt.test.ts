import { describe, expect, it } from "vitest";
import { originatingPromptForRow, type RetryPromptRow } from "./retry-prompt";
import { messagePartsFromDurableEvents, type MessagePart } from "./message-parts";
import type { DurableEvent } from "../../core/journal";

describe("originatingPromptForRow", () => {
  it("recovers the prompt of a resumed assistant row from its own turn", () => {
    const rows = [
      row("user", "turn-1", "Summarise the audit log"),
      row("assistant", "turn-1", "Here is the summary."),
    ];
    expect(originatingPromptForRow(rows, 1)).toBe("Summarise the audit log");
  });

  it("never attaches a prompt to a user row", () => {
    const rows = [row("user", "turn-1", "Hello"), row("assistant", "turn-1", "Hi")];
    expect(originatingPromptForRow(rows, 0)).toBeUndefined();
  });

  // Retry re-sends this text verbatim; borrowing an unrelated turn's prompt
  // would silently ask a different question than the one on screen.
  it("refuses a prompt from a different turn", () => {
    const rows = [
      row("user", "turn-1", "First question"),
      row("assistant", "turn-2", "An answer whose prompt row was omitted"),
    ];
    expect(originatingPromptForRow(rows, 1)).toBeUndefined();
  });

  it("refuses when no row precedes the assistant row", () => {
    expect(originatingPromptForRow([row("assistant", "turn-1", "Orphan")], 0)).toBeUndefined();
  });

  it("refuses when two assistant rows are adjacent", () => {
    const rows = [row("assistant", "turn-1", "One"), row("assistant", "turn-1", "Two")];
    expect(originatingPromptForRow(rows, 1)).toBeUndefined();
  });

  it("treats a whitespace-only prompt as absent rather than resending nothing", () => {
    const rows = [row("user", "turn-1", "   \n  "), row("assistant", "turn-1", "Answer")];
    expect(originatingPromptForRow(rows, 1)).toBeUndefined();
  });

  it("returns undefined for an out-of-range index", () => {
    expect(originatingPromptForRow([], 0)).toBeUndefined();
    expect(originatingPromptForRow([row("assistant", "turn-1", "x")], 7)).toBeUndefined();
  });

  // A journal row keeps an attachment's name, media type and size, never its
  // bytes, and the composer File handle died with the previous page. Recovering
  // the text alone would make Retry re-send a visibly different request than the
  // one on screen, so the control must not offer itself at all.
  it("refuses a prompt whose turn carried an attachment", () => {
    const rows = [
      withAttachment(row("user", "turn-1", "What is in this screenshot?")),
      row("assistant", "turn-1", "A dashboard."),
    ];
    expect(originatingPromptForRow(rows, 1)).toBeUndefined();
  });

  /**
   * The guard above is only worth anything if a *durable* row can reach it.
   * It could not: the projection dropped `turn.requested.images`, so after a
   * reload the very rows the guard exists for looked text-only and Retry
   * offered to re-send them without their image. Built from journal events
   * rather than a hand-made part, because a hand-made part is exactly what hid
   * this.
   */
  it("refuses a prompt whose user row was rebuilt from a durable image-bearing request", () => {
    const rows = [
      durableRow("user", "turn-1", durableImageRequestParts()),
      row("assistant", "turn-1", "A dashboard."),
    ];
    expect(rows[0]!.parts.some((part) => part.kind === "attachment")).toBe(true);
    expect(originatingPromptForRow(rows, 1)).toBeUndefined();
  });

  it("still recovers the neighbouring text-only turn in the same transcript", () => {
    const rows = [
      withAttachment(row("user", "turn-1", "What is in this screenshot?")),
      row("assistant", "turn-1", "A dashboard."),
      row("user", "turn-2", "Summarise it"),
      row("assistant", "turn-2", "Here is the summary."),
    ];
    expect(originatingPromptForRow(rows, 1)).toBeUndefined();
    expect(originatingPromptForRow(rows, 3)).toBe("Summarise it");
  });
});

function withAttachment(source: RetryPromptRow): RetryPromptRow {
  const attachment: MessagePart = Object.freeze({
    id: `${source.turnId}:attachment`,
    kind: "attachment",
    sequence: 2,
    endSequence: 2,
    sourceFactIds: Object.freeze([]),
    attachmentId: "attachment-1",
    name: "screenshot.png",
    mediaType: "image/png",
    sizeBytes: 4_096,
    summary: "Included as an inline image inside the encrypted inference request.",
    reference: "inline-e2ee",
    status: "available",
  });
  return Object.freeze({ ...source, parts: Object.freeze([...source.parts, attachment]) });
}

function durableRow(role: "user" | "assistant", turnId: string, parts: readonly MessagePart[]): RetryPromptRow {
  return Object.freeze({ role, turnId, parts });
}

function durableImageRequestParts(): readonly MessagePart[] {
  const event: DurableEvent = {
    version: 1,
    eventId: "event-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sequence: 1,
    type: "turn.requested",
    payload: {
      content: "What is in this screenshot?",
      images: [{
        type: "image",
        name: "screenshot.png",
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,AAAA",
        sizeBytes: 3,
      }],
    },
    recordedAt: "2026-07-18T00:00:01.000Z",
    previousDigest: "genesis",
    digest: "digest-1",
  };
  return messagePartsFromDurableEvents([event], { includeTurnRequest: true });
}

function row(role: "user" | "assistant", turnId: string, content: string): RetryPromptRow {
  const part: MessagePart = Object.freeze({
    id: `${turnId}:${role}`,
    kind: "text",
    sequence: 1,
    endSequence: 1,
    sourceFactIds: Object.freeze([]),
    content,
  });
  return Object.freeze({ role, turnId, parts: Object.freeze([part]) });
}
