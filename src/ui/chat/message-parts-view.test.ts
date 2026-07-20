import { describe, expect, it } from "vitest";
import { messagePartsFromFacts } from "./message-parts";
import { boundedMessageParts, DEFAULT_OPERATION_RENDER_LIMIT, streamedMessageTail } from "./message-parts-view";

describe("streamed message tail", () => {
  it("renders the separate, non-durable stream segment beside durable facts", () => {
    const parts = messagePartsFromFacts([{ kind: "text", factId: "first", sequence: 1, text: "Stored " }]);
    expect(streamedMessageTail(parts, "live", true)).toBe("live");
  });

  it("renders the full stream before any durable text exists", () => {
    const parts = messagePartsFromFacts([{
      kind: "tool-call",
      factId: "call",
      sequence: 1,
      callId: "call-1",
      name: "read_file",
    }]);
    expect(streamedMessageTail(parts, "Working…", true)).toBe("Working…");
  });

  it("hides ephemeral content as soon as a message is no longer streaming", () => {
    const parts = messagePartsFromFacts([{ kind: "text", factId: "first", sequence: 1, text: "Durable" }]);
    expect(streamedMessageTail(parts, "Durable complete", false)).toBe("");
  });

  it("keeps the default tool-step surface bounded", () => {
    expect(DEFAULT_OPERATION_RENDER_LIMIT).toBe(12);
  });

  it("moves the whole chronological suffix after the operation boundary", () => {
    const facts = Array.from({ length: 13 }, (_, index) => ([
      { kind: "tool-call" as const, factId: `call-${String(index)}`, sequence: index * 2 + 1, callId: `call-${String(index)}`, name: "read_file" },
      { kind: "tool-result" as const, factId: `result-${String(index)}`, sequence: index * 2 + 2, callId: `call-${String(index)}`, content: `result ${String(index)}` },
    ])).flat();
    facts.push({ kind: "text", factId: "final", sequence: 100, text: "Final answer" } as never);
    const bounded = boundedMessageParts(messagePartsFromFacts(facts), 12);

    expect(bounded.visible.filter((part) => part.kind === "tool-call" || part.kind === "tool-result")).toHaveLength(12);
    expect(bounded.overflow[0]?.kind).toBe("tool-call");
    expect(bounded.overflow.at(-1)).toMatchObject({ kind: "text", content: "Final answer" });
  });
});
