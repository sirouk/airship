import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../core/contracts";
import type { DurableEvent } from "../../core/journal";
import {
  ASSISTANT_LENGTH_CODE,
  MESSAGE_PART_DISPLAY_LIMITS,
  boundedDisplayText,
  reasoningHeadline,
  messagePartFactsFromDurableEvents,
  messagePartsFromDurableEvents,
  messagePartsFromFacts,
  messagePlainText,
  reduceMessagePartFact,
  summarizeJson,
  toolResultCapabilityTier,
  type MessagePartFact,
} from "./message-parts";

describe("message parts", () => {
  it("preserves an exact per-result capability tier without accepting assertions outside the contract", () => {
    const [result] = messagePartsFromFacts([
      fact("tool-result", "tiered-result", 1, {
        callId: "call-tiered",
        name: "execute_code",
        content: "done",
        metadata: {
          capabilityTier: "web-enhanced",
          authority: "browser",
          engine: "pyodide-worker",
        },
      }),
    ]);

    expect(result).toMatchObject({
      kind: "tool-result",
      capabilityTier: "web-enhanced",
    });
    expect(toolResultCapabilityTier({ capabilityTier: "remote-ish" })).toBeUndefined();
    expect(toolResultCapabilityTier(["web-enhanced"])).toBeUndefined();
  });

  it("preserves durable text → tool → result → text ordering", () => {
    const events = eventSequence([
      draft("assistant.completed", {
        message: {
          role: "assistant",
          content: "I’ll inspect the workspace.",
          toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
        },
      }),
      draft("tool.requested", {
        call: { id: "call-1", name: "read_file", arguments: { path: "README.md" } },
      }, "call-1"),
      draft("tool.approved", { callId: "call-1", name: "read_file" }, "call-1"),
      draft("tool.resulted", {
        callId: "call-1",
        name: "read_file",
        content: "# Airship",
        isError: false,
      }, "call-1"),
      draft("assistant.completed", {
        message: { role: "assistant", content: "The project is Airship." },
      }),
      draft("turn.completed", { receiptId: "receipt-1" }),
    ]);

    const parts = messagePartsFromDurableEvents(events, { turnId: "turn-1" });
    expect(parts.map((part) => part.kind)).toEqual([
      "text",
      "tool-call",
      "tool-result",
      "text",
      "footer",
    ]);
    expect(parts[0]).toMatchObject({ kind: "text", content: "I’ll inspect the workspace." });
    expect(parts[1]).toMatchObject({
      kind: "tool-call",
      callId: "call-1",
      name: "read_file",
      status: "completed",
    });
    expect(parts[2]).toMatchObject({ kind: "tool-result", status: "success", summary: "# Airship" });
    expect(parts[3]).toMatchObject({ kind: "text", content: "The project is Airship." });

    const plain = messagePlainText(parts);
    expect(plain.indexOf("I’ll inspect")).toBeLessThan(plain.indexOf("Tool call"));
    expect(plain.indexOf("Tool call")).toBeLessThan(plain.indexOf("Tool result"));
    expect(plain.indexOf("Tool result")).toBeLessThan(plain.indexOf("The project is Airship"));
  });

  it("stable-sorts facts, merges only adjacent text, and ignores replayed fact IDs", () => {
    const facts: MessagePartFact[] = [
      fact("text", "after", 4, { text: "after" }),
      fact("text", "first", 1, { text: "Hello " }),
      fact("tool-result", "result", 3, {
        callId: "call-1",
        name: "search",
        content: "found it",
      }),
      fact("text", "second", 1, { text: "world", ordinal: 1 }),
      fact("tool-call", "call", 2, {
        callId: "call-1",
        name: "search",
        arguments: { query: "Airship" },
      }),
      fact("tool-call", "call", 2, {
        callId: "call-1",
        name: "search",
        arguments: { query: "replayed" },
      }),
    ];

    const parts = messagePartsFromFacts(facts);
    expect(parts.map((part) => part.kind)).toEqual(["text", "tool-call", "tool-result", "text"]);
    expect(parts[0]).toMatchObject({ kind: "text", content: "Hello world" });
    expect(parts[3]).toMatchObject({ kind: "text", content: "after" });
    expect(Object.isFrozen(parts)).toBe(true);
    expect(parts.every(Object.isFrozen)).toBe(true);

    const unchanged = reduceMessagePartFact(parts, facts[4]!);
    expect(unchanged).toBe(parts);
  });

  it("supports every public part kind without a hidden reasoning payload", () => {
    const parts = messagePartsFromFacts([
      fact("reasoning-summary", "reason", 1, {
        summary: "I compared the two verified alternatives.",
        label: "Decision summary",
      }),
      fact("citation", "cite", 2, {
        citationId: "citation-1",
        label: "Architecture note",
        excerpt: "The runtime remains on the client.",
        reference: "s3://private-workspace/architecture.md",
      }),
      fact("attachment", "attachment", 3, {
        attachmentId: "attachment-1",
        name: "report.pdf",
        mediaType: "application/pdf",
        sizeBytes: 42,
        status: "available",
      }),
      fact("error", "error", 4, {
        summary: "The operation stopped safely.",
        code: "TOOL_STOPPED",
        retryable: true,
      }),
      fact("footer", "footer", 5, {
        summary: "Verified locally.",
        receiptId: "receipt-1",
      }),
    ]);

    expect(parts.map((part) => part.kind)).toEqual([
      "reasoning-summary",
      "citation",
      "attachment",
      "error",
      "footer",
    ]);
    const reasoning = parts[0];
    expect(reasoning).toMatchObject({
      kind: "reasoning-summary",
      summary: "I compared the two verified alternatives.",
    });
    expect(reasoning && "reasoning" in reasoning).toBe(false);
    expect(messagePlainText(parts)).toContain("Decision summary");
  });

  it("keeps display projections deterministic and bounded", () => {
    const largeArguments: JsonValue = {
      zebra: "z".repeat(2_000),
      alpha: Array.from({ length: 100 }, (_, index) => ({ index, value: "v".repeat(100) })),
    };
    const summary = summarizeJson(largeArguments);
    expect(summary.length).toBeLessThanOrEqual(MESSAGE_PART_DISPLAY_LIMITS.toolArgumentsChars);
    expect(summary.startsWith("{\"alpha\":")).toBe(true);
    expect(summary).toBe(summarizeJson({ alpha: largeArguments.alpha!, zebra: largeArguments.zebra! }));
    expect(summary.endsWith("…")).toBe(true);

    const parts = messagePartsFromFacts([
      fact("tool-call", "large-call", 1, {
        callId: "call-large",
        name: "analyze",
        arguments: largeArguments,
      }),
      fact("tool-result", "large-result", 2, {
        callId: "call-large",
        content: "r".repeat(MESSAGE_PART_DISPLAY_LIMITS.toolResultChars + 100),
      }),
      fact("reasoning-summary", "large-summary", 3, {
        summary: "s".repeat(MESSAGE_PART_DISPLAY_LIMITS.reasoningSummaryChars + 100),
      }),
    ]);
    expect(parts[0]).toMatchObject({ kind: "tool-call" });
    expect(parts[0]?.kind === "tool-call" && parts[0].argumentsSummary.length)
      .toBeLessThanOrEqual(MESSAGE_PART_DISPLAY_LIMITS.toolArgumentsChars);
    expect(parts[1]?.kind === "tool-result" && parts[1].summary.length)
      .toBeLessThanOrEqual(MESSAGE_PART_DISPLAY_LIMITS.toolResultChars);
    expect(parts[2]?.kind === "reasoning-summary" && parts[2].summary.length)
      .toBeLessThanOrEqual(MESSAGE_PART_DISPLAY_LIMITS.reasoningSummaryChars);
    expect(messagePlainText(parts, 120).length).toBeLessThanOrEqual(120);
  });

  it("sanitizes display controls and never leaves a partial surrogate when truncating", () => {
    expect(boundedDisplayText("safe\u0000text", 20)).toBe("safe�text");
    const bounded = boundedDisplayText("A😀B", 3);
    expect(bounded).toBe("A…");
    expect(bounded.charCodeAt(bounded.length - 1)).not.toBeGreaterThanOrEqual(0xD800);
  });

  it("projects only requested turn events and can include the user request explicitly", () => {
    const events = [
      ...eventSequence([
        draft("turn.requested", { content: "First request" }),
        draft("assistant.completed", { message: { role: "assistant", content: "First answer" } }),
      ], "turn-1"),
      ...eventSequence([
        draft("turn.requested", { content: "Second request" }),
        draft("assistant.completed", { message: { role: "assistant", content: "Second answer" } }),
      ], "turn-2", 10),
    ];

    const facts = messagePartFactsFromDurableEvents(events, {
      turnId: "turn-2",
      includeTurnRequest: true,
    });
    const parts = messagePartsFromFacts(facts);
    expect(parts.map((part) => part.kind === "text" ? part.content : part.kind)).toEqual([
      "Second request",
      "Second answer",
    ]);
    expect(messagePlainText(parts)).not.toContain("First");
  });

  /**
   * The durable projection used to drop `turn.requested.images` entirely, so a
   * resumed image-bearing prompt was indistinguishable from a text-only one —
   * and the Edit/Retry attachment guards, which look for exactly this part
   * kind, could never fire on a reloaded transcript.
   */
  it("projects the images a request was journaled with as attachment parts", () => {
    const events = eventSequence([
      draft("turn.requested", {
        content: "What is in these screenshots?",
        images: [
          { type: "image", name: "one.png", mediaType: "image/png", dataUrl: "data:image/png;base64,AAAA", sizeBytes: 3 },
          { type: "image", name: "two.jpeg", mediaType: "image/jpeg", dataUrl: "data:image/jpeg;base64,AAAAAA==", sizeBytes: 4 },
        ],
      }),
    ]);
    const parts = messagePartsFromDurableEvents(events, { includeTurnRequest: true });
    expect(parts.map((part) => part.kind)).toEqual(["text", "attachment", "attachment"]);
    expect(parts[1]).toMatchObject({
      kind: "attachment",
      name: "one.png",
      mediaType: "image/png",
      sizeBytes: 3,
      status: "available",
    });
    expect(parts[2]).toMatchObject({ kind: "attachment", name: "two.jpeg", mediaType: "image/jpeg", sizeBytes: 4 });
    // The bytes are never re-rendered from the journal, so nothing here may
    // carry the data URL back into the page.
    expect(JSON.stringify(parts)).not.toContain("base64");
  });

  it("still marks an unreadable images record as an attachment rather than nothing", () => {
    const events = eventSequence([
      draft("turn.requested", { content: "Look at this", images: [{ type: "image", name: "x" }] }),
    ]);
    const parts = messagePartsFromDurableEvents(events, { includeTurnRequest: true });
    expect(parts.map((part) => part.kind)).toEqual(["text", "attachment"]);
    expect(parts[1]).toMatchObject({ kind: "attachment", status: "failed" });
  });

  /*
   * The whole point of the marker: two turns whose journals differ in exactly
   * one field must not render the same. Before this, they did — `finishReason`
   * was written, audited, and read by nothing, so a severed answer and a
   * finished one were byte-identical on screen.
   */
  it("distinguishes a length-finished answer from a stop-finished one", () => {
    const severedPayload = {
      message: { role: "assistant", content: "The three causes are: first, the" },
      finishReason: "length",
      responseDigest: "a".repeat(64),
    } satisfies JsonValue;
    const severed = messagePartsFromDurableEvents(
      eventSequence([draft("assistant.completed", severedPayload), draft("turn.completed", { receiptId: "receipt-1" })]),
    );
    const finished = messagePartsFromDurableEvents(
      eventSequence([
        draft("assistant.completed", { ...severedPayload, finishReason: "stop" }),
        draft("turn.completed", { receiptId: "receipt-1" }),
      ]),
    );

    expect(finished.map((part) => part.kind)).toEqual(["text", "footer"]);
    expect(severed.map((part) => part.kind)).toEqual(["text", "error", "footer"]);
    const marker = severed[1];
    expect(marker).toMatchObject({ kind: "error", code: ASSISTANT_LENGTH_CODE, retryable: false });
    // The marker orders after the text it qualifies and before the footer that
    // says the turn completed — both of which remain true statements.
    expect(marker!.sequence).toBe(1);
    expect(severed[2]).toMatchObject({ kind: "footer" });
    // A caveat that a copy button drops is a caveat that does not exist.
    expect(messagePlainText(severed)).toContain("maximum output length");
    expect(messagePlainText(finished)).not.toContain("maximum output length");
  });

  /* A tool-call step finishes for tool calls, never for length; no marker. */
  it("does not mark the tool-call phase of a turn as cut off", () => {
    const parts = messagePartsFromDurableEvents(eventSequence([
      draft("assistant.completed", {
        message: { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: {} }] },
        finishReason: "tool-calls",
      }),
    ]));
    expect(parts.every((part) => part.kind !== "error")).toBe(true);
  });
});

type DraftFixture = Readonly<{
  type: string;
  payload: JsonValue;
  operationId?: string;
}>;

function draft(type: string, payload: JsonValue, operationId?: string): DraftFixture {
  return { type, payload, ...(operationId ? { operationId } : {}) };
}

function eventSequence(
  drafts: readonly DraftFixture[],
  turnId = "turn-1",
  sequenceOffset = 0,
): DurableEvent[] {
  return drafts.map((event, index) => {
    const sequence = sequenceOffset + index + 1;
    return {
      ...event,
      version: 1,
      eventId: `${turnId}-event-${String(sequence)}`,
      sessionId: "session-1",
      turnId,
      sequence,
      recordedAt: `2026-07-18T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      previousDigest: sequence === 1 ? "genesis" : `digest-${String(sequence - 1)}`,
      digest: `digest-${String(sequence)}`,
    };
  });
}

function fact<Kind extends MessagePartFact["kind"]>(
  kind: Kind,
  factId: string,
  sequence: number,
  fields: Omit<Extract<MessagePartFact, { kind: Kind }>, "kind" | "factId" | "sequence">,
): Extract<MessagePartFact, { kind: Kind }> {
  return { kind, factId, sequence, ...fields } as Extract<MessagePartFact, { kind: Kind }>;
}


describe("reasoning parts from durable records", () => {
  function reasoningEvent(text: string, truncated = false): DurableEvent {
    return {
      version: 1,
      eventId: "evt-r1",
      sessionId: "s1",
      sequence: 5,
      recordedAt: "2026-08-06T00:00:00.000Z",
      previousDigest: "p",
      digest: "d",
      turnId: "t1",
      operationId: "req1",
      type: "turn.reasoning",
      payload: { text, ...(truncated ? { truncated: true } : {}) },
    } as DurableEvent;
  }

  it("projects headline and full text through the parts pipeline", () => {
    const parts = messagePartsFromDurableEvents([reasoningEvent("Line one of the plan.\nThe rest of the plan, in detail.")], { turnId: "t1" });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      kind: "reasoning-summary",
      label: "Reasoning",
      summary: "Line one of the plan.",
      full: "Line one of the plan.\nThe rest of the plan, in detail.",
    });
  });

  it("carries the truncation notice when the journal said the record was bounded", () => {
    const parts = messagePartsFromDurableEvents([reasoningEvent("Bounded reasoning.", true)], { turnId: "t1" });
    expect(parts[0]).toMatchObject({ label: "Reasoning · record truncated" });
  });

  it("bounds the full text at the reasoning limit without pretending it all fits", () => {
    const huge = "reasoning ".repeat(40_000);
    const parts = messagePartsFromDurableEvents([reasoningEvent(huge)], { turnId: "t1" });
    const part = parts[0];
    expect(part?.kind).toBe("reasoning-summary");
    if (part?.kind === "reasoning-summary" && part.full) {
      expect(part.full.length).toBeLessThanOrEqual(MESSAGE_PART_DISPLAY_LIMITS.reasoningFullChars);
    }
  });
});

describe("reasoningHeadline", () => {
  it("takes the first non-empty line and answers empties with a sentence", () => {
    expect(reasoningHeadline("\n\n  The real start.\nMore." )).toBe("The real start.");
    expect(reasoningHeadline("   \n \n")).toBe("The model reasoned before answering.");
    expect(reasoningHeadline("x".repeat(400)).length).toBeLessThanOrEqual(160);
  });
});