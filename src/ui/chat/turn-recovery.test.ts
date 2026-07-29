import { describe, expect, it } from "vitest";
import { recoverPartialTurn } from "./turn-recovery";
import { messagePartsFromFacts } from "./message-parts";

describe("turn recovery", () => {
  it("keeps flushed and pending stream text with a retryable plain-language footer", () => {
    const result = recoverPartialTurn([], "hello ", "world", false);
    expect(result).toMatchObject([{ kind: "text", content: "hello world" }, { kind: "error", retryable: true }, { kind: "footer", summary: "Connection lost — partial response kept." }]);
    expect(JSON.stringify(result)).not.toContain("STREAM_TRUNCATED");
  });

  /**
   * The durable reducer and this helper are two reporters of one stop. When the
   * cancellation event has already landed, a second error part says the same
   * thing again a few pixels lower — the stop was announced three times in one
   * message on the shipped build.
   */
  it("does not report a stop the durable record already reports", () => {
    const durable = messagePartsFromFacts([
      { kind: "text", factId: "answer", sequence: 1, text: "Partial" },
      { kind: "error", factId: "cancelled", sequence: 2, summary: "Stopped by the operator.", code: "turn.cancelled" },
    ]);
    const result = recoverPartialTurn(durable, "", "", true);

    expect(result).toHaveLength(durable.length + 1);
    expect(result.filter((part) => part.kind === "error")).toHaveLength(1);
    expect(result.at(-1)).toMatchObject({ kind: "footer", summary: "Stopped — partial response kept." });
  });

  it("still reports a stop no durable record covers", () => {
    const parts = messagePartsFromFacts([{ kind: "text", factId: "answer", sequence: 1, text: "Partial" }]);
    const result = recoverPartialTurn(parts, "", "", true);
    expect(result.filter((part) => part.kind === "error")).toHaveLength(1);
  });
});
