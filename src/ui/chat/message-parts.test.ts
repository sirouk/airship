import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../core/contracts";
import type { DurableEvent } from "../../core/journal";
import {
  MESSAGE_PART_DISPLAY_LIMITS,
  boundedDisplayText,
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
