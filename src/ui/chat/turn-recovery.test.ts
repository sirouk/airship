import { describe, expect, it, vi } from "vitest";
import { readableLocalFailure, recoverPartialTurn, turnRecoverySummary } from "./turn-recovery";
import { messagePartsFromFacts } from "./message-parts";
import { mapRequestFailure } from "../request-state";

describe("turn recovery", () => {
  it("keeps flushed and pending stream text with a retryable plain-language footer", () => {
    const result = recoverPartialTurn([], "hello ", "world", false, "offline");
    expect(result).toMatchObject([{ kind: "text", content: "hello world" }, { kind: "error", retryable: true }, { kind: "footer", summary: "Connection lost — partial response kept." }]);
    expect(JSON.stringify(result)).not.toContain("STREAM_TRUNCATED");
  });

  /**
   * Every non-cancelled failure closed on "Connection lost", including the ones
   * with a working connection. The assertions run through `mapRequestFailure`
   * rather than naming kinds by hand, so a failure that is reclassified there
   * fails here instead of quietly acquiring the wrong cause word.
   */
  it("names the cause it was given instead of asserting a connection failure", () => {
    const causeFor = (input: Parameters<typeof mapRequestFailure>[0]) =>
      turnRecoverySummary(false, mapRequestFailure(input).kind);

    expect(causeFor({ online: true, status: 500 })).toBe("Provider failed — partial response kept.");
    expect(causeFor({ online: true, code: "ATTESTATION_FAILED", status: 403 })).toBe("Provider failed — partial response kept.");
    expect(causeFor({ online: true, code: "NONCE_REJECTED", status: 403 })).toBe("Provider failed — partial response kept.");
    expect(causeFor({ online: true, status: 429 })).toBe("Rate limit reached — partial response kept.");
    expect(causeFor({ online: true, status: 402 })).toBe("Out of credit — partial response kept.");
    expect(causeFor({ online: true, status: 401 })).toBe("Access rejected — partial response kept.");
    expect(causeFor({ online: false })).toBe("Connection lost — partial response kept.");
  });

  /**
   * A caller that has not classified the failure may not borrow a cause it
   * never checked — but the one cause it can still check for itself is the one
   * the old sentence was guessing at, so a genuinely offline device keeps the
   * accurate wording instead of losing it to the fix.
   */
  it("falls back to the one cause it can check, and to a cause-free sentence otherwise", () => {
    expect(turnRecoverySummary(true, "provider")).toBe("Stopped — partial response kept.");
    try {
      vi.stubGlobal("navigator", { onLine: true });
      expect(turnRecoverySummary(false)).toBe("Turn failed — partial response kept.");
      expect(recoverPartialTurn([], "", "partial", false).at(-1)).toMatchObject({ kind: "footer", summary: "Turn failed — partial response kept." });

      vi.stubGlobal("navigator", { onLine: false });
      expect(turnRecoverySummary(false)).toBe("Connection lost — partial response kept.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /**
   * A runtime activation failure reached the transcript as
   * "Failed to fetch dynamically imported module: …/node-webcontainer-pack-
   * DntNdFa_.js" under a FAILED TURN badge: a hashed build asset as the whole
   * diagnosis.
   */
  it("translates a chunk-load failure and leaves every other sentence alone", () => {
    const translated = readableLocalFailure(
      "Failed to fetch dynamically imported module: http://localhost:4173/assets/node-webcontainer-pack-DntNdFa_.js",
    );
    expect(translated).not.toContain("node-webcontainer-pack");
    expect(translated).not.toContain("http://");
    expect(translated).toContain("nothing was installed");
    expect(translated).toContain("reload the page");
    // Sentences the product wrote for a person are not rewritten.
    const own = "Permission denied for local /write-file. No tool effect ran, and nothing was sent to the model.";
    expect(readableLocalFailure(own)).toBe(own);
  });

  /**
   * "TURN FAILED — PARTIAL RESPONSE KEPT." was printed over an empty region on
   * three separate failure causes (stream-end, provider-unreachable, offline),
   * because the text part was pushed only `if (partial)` and the footer was
   * appended unconditionally. The footer may only claim what is above it.
   */
  it("does not claim a partial was kept when nothing arrived", () => {
    const nothing = recoverPartialTurn([], "", "", false, "unreachable");
    expect(nothing.filter((part) => part.kind === "text")).toHaveLength(0);
    expect(nothing.at(-1)).toMatchObject({ kind: "footer", summary: "Provider unreachable — nothing had arrived yet." });

    // Text the durable record already put in the card counts as kept, even
    // though this call carries no partial of its own.
    const durable = messagePartsFromFacts([{ kind: "text", factId: "answer", sequence: 1, text: "Half an answer" }]);
    expect(recoverPartialTurn(durable, "", "", false, "provider").at(-1))
      .toMatchObject({ kind: "footer", summary: "Provider failed — partial response kept." });
  });

  /**
   * "Retry is available." rendered on every failed turn while the controls it
   * referred to were disabled, because only the success path stamped the
   * pre-turn boundary a retry forks at.
   */
  it("only claims retryability when the caller has a way to act on it", () => {
    const withoutWay = recoverPartialTurn([], "", "", false, "provider", false);
    expect(withoutWay.find((part) => part.kind === "error")).toMatchObject({ retryable: false });
    expect(recoverPartialTurn([], "", "", false, "provider").find((part) => part.kind === "error"))
      .toMatchObject({ retryable: true });
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
