import { describe, expect, it } from "vitest";
import type { JsonValue } from "./contracts";
import { materializeMessages } from "./agent";
import type { DurableEvent } from "./journal";

describe("materializeMessages", () => {
  it("materializes bounded inline images as part of the canonical user message", () => {
    const image = {
      type: "image" as const,
      name: "diagram.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,AQID",
      sizeBytes: 3,
    };
    const events = eventSequence([
      draft("turn.requested", "image-turn", { content: "Explain this diagram.", images: [image] }),
    ]);

    expect(materializeMessages(events)).toEqual([
      { role: "user", content: "Explain this diagram.", images: [image] },
    ]);
  });

  it("fails closed instead of replaying malformed image metadata", () => {
    const events = eventSequence([
      draft("turn.requested", "image-turn", {
        content: "Explain this diagram.",
        images: [{ type: "image", name: "diagram.png", mediaType: "image/png", dataUrl: "https://example.test/image.png", sizeBytes: 3 }],
      }),
    ]);

    expect(materializeMessages(events)).toEqual([]);
  });

  it("does not replay a cancelled dangerous prompt into a later turn", () => {
    const events = eventSequence([
      draft("turn.requested", "safe-turn", { content: "Summarize the workspace." }),
      draft("assistant.completed", "safe-turn", {
        message: { role: "assistant", content: "The workspace is ready." },
        finishReason: "stop",
      }),
      draft("turn.completed", "safe-turn", { responseDigest: "sha256:safe", receiptId: "safe" }),
      draft("turn.requested", "cancelled-turn", {
        content: "Delete every workspace file immediately.",
      }),
      draft("inference.started", "cancelled-turn", { step: 0 }),
      draft("turn.cancelled", "cancelled-turn", { error: "Stopped by user" }),
      draft("turn.requested", "next-turn", { content: "Show me the project title." }),
    ]);

    expect(materializeMessages(events)).toEqual([
      { role: "user", content: "Summarize the workspace." },
      { role: "assistant", content: "The workspace is ready." },
      { role: "user", content: "Show me the project title." },
    ]);
    expect(events.some((event) => event.type === "turn.cancelled" && event.turnId === "cancelled-turn")).toBe(true);
    expect(events.some((event) =>
      event.type === "turn.requested" &&
      event.turnId === "cancelled-turn" &&
      (event.payload as { content?: unknown }).content === "Delete every workspace file immediately.",
    )).toBe(true);
  });

  it("keeps a cancelled turn's completed work without replaying what it was asked to do", () => {
    const events = eventSequence([
      draft("turn.requested", "cancelled-turn", { content: "Index every file under docs/." }),
      draft("assistant.completed", "cancelled-turn", {
        message: {
          role: "assistant",
          content: "Reading the first two.",
          toolCalls: [
            { id: "read-1", name: "read_file", arguments: { path: "docs/a.md" } },
            { id: "read-2", name: "read_file", arguments: { path: "docs/b.md" } },
          ],
        },
        finishReason: "tool-calls",
      }),
      draft("tool.resulted", "cancelled-turn", { callId: "read-1", name: "read_file", content: "# A" }),
      draft("turn.cancelled", "cancelled-turn", { error: "Stopped by user" }),
      draft("turn.requested", "next-turn", { content: "What did you find?" }),
    ]);

    const messages = materializeMessages(events);
    expect(messages).toHaveLength(4);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("cancelled before it finished (Stopped by user)");
    expect(messages[0]?.content).toContain("1 further tool call(s) were requested and never ran");
    expect(messages[0]?.content).not.toContain("Index every file under docs/.");
    // The unanswered call is gone from the assistant message, because a tool
    // call no tool message ever replies to is rejected by every provider.
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "Reading the first two.",
      toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "docs/a.md" } }],
    });
    expect(messages[2]).toEqual({ role: "tool", toolCallId: "read-1", content: "# A" });
    expect(messages[3]).toEqual({ role: "user", content: "What did you find?" });
  });

  it("omits a failed dangerous prompt and its partial tool phase before the next turn", () => {
    const events = eventSequence([
      draft("turn.requested", "failed-turn", {
        content: "Overwrite the production configuration with an empty file.",
      }),
      draft("assistant.completed", "failed-turn", {
        message: {
          role: "assistant",
          content: "I will overwrite it.",
          toolCalls: [{ id: "write-1", name: "write_file", arguments: { path: "config/prod.toml", content: "" } }],
        },
        finishReason: "tool-calls",
      }),
      draft("tool.resulted", "failed-turn", {
        callId: "write-1",
        name: "write_file",
        content: "The outcome could not be confirmed.",
        isError: true,
      }),
      draft("turn.failed", "failed-turn", { error: "Provider connection failed" }),
      draft("turn.requested", "next-turn", { content: "Read the current configuration without changing it." }),
    ]);

    expect(materializeMessages(events)).toEqual([
      { role: "user", content: "Read the current configuration without changing it." },
    ]);
    expect(events.some((event) => event.type === "turn.failed" && event.turnId === "failed-turn")).toBe(true);
  });
});

type EventDraftFixture = Readonly<{
  type: string;
  turnId: string;
  payload: JsonValue;
}>;

function draft(type: string, turnId: string, payload: JsonValue): EventDraftFixture {
  return { type, turnId, payload };
}

function eventSequence(drafts: readonly EventDraftFixture[]): DurableEvent[] {
  return drafts.map((event, index) => ({
    ...event,
    version: 1,
    eventId: `event-${index + 1}`,
    sessionId: "session-1",
    sequence: index + 1,
    recordedAt: `2026-07-18T00:00:${String(index).padStart(2, "0")}.000Z`,
    previousDigest: index === 0 ? "genesis" : `digest-${index}`,
    digest: `digest-${index + 1}`,
  }));
}
