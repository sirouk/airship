import { describe, expect, it } from "vitest";
import { recoverPartialTurn } from "./turn-recovery";

describe("turn recovery", () => {
  it("keeps flushed and pending stream text with a retryable plain-language footer", () => {
    const result = recoverPartialTurn([], "hello ", "world", false);
    expect(result).toMatchObject([{ kind: "text", content: "hello world" }, { kind: "error", retryable: true }, { kind: "footer", summary: "Connection lost — partial response kept." }]);
    expect(JSON.stringify(result)).not.toContain("STREAM_TRUNCATED");
  });
});
