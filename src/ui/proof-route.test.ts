import { describe, expect, it } from "vitest";
import { createLocalReceipt, type ConversationReceipt } from "../receipts/types";
import {
  proofHash,
  proofSelectionForReceipt,
  proofSelectionFromHash,
  resolveProofReceipt,
} from "./proof-route";

describe("proof receipt routing", () => {
  it("binds each of two completed turns to its own exact receipt", () => {
    const [first, second] = twoTurnReceipts();

    for (const expected of [first, second]) {
      const selection = proofSelectionForReceipt(expected);
      const restored = proofSelectionFromHash(proofHash(selection));

      expect(restored).toEqual({
        sessionId: expected.sessionId,
        receiptId: expected.receiptId,
        turnId: expected.turnId,
      });
      expect(resolveProofReceipt([first, second], restored, second)).toBe(expected);
    }
  });

  it("restores the older turn through history and never substitutes the newest receipt", () => {
    const [first, second] = twoTurnReceipts();
    const firstHistoryEntry = proofHash(proofSelectionForReceipt(first));
    const secondHistoryEntry = proofHash(proofSelectionForReceipt(second));

    expect(resolveProofReceipt([first, second], proofSelectionFromHash(secondHistoryEntry), second)).toBe(second);
    expect(resolveProofReceipt([first, second], proofSelectionFromHash(firstHistoryEntry), second)).toBe(first);

    const mismatchedIdentity = proofSelectionFromHash(
      proofHash({ sessionId: first.sessionId, receiptId: first.receiptId, turnId: second.turnId }),
    );
    expect(resolveProofReceipt([first, second], mismatchedIdentity, second)).toBeUndefined();
  });

  it("does not fall back when a receipt deep link is incomplete", () => {
    const [first, second] = twoTurnReceipts();
    const incomplete = proofSelectionFromHash(
      `#proof?session=${encodeURIComponent(first.sessionId)}&receipt=${encodeURIComponent(first.receiptId)}`,
    );

    expect(incomplete).toEqual({ sessionId: first.sessionId, receiptId: first.receiptId });
    expect(resolveProofReceipt([first, second], incomplete, second)).toBeUndefined();
  });
});

function twoTurnReceipts(): readonly [ConversationReceipt, ConversationReceipt] {
  return [
    {
      ...createLocalReceipt({
        sessionId: "session-proof-history",
        turnId: "turn-1",
        provider: "airship-demo",
        model: "airship/demo-v1",
        now: "2026-07-18T10:00:00.000Z",
      }),
      receiptId: "urn:airship:receipt:first",
    },
    {
      ...createLocalReceipt({
        sessionId: "session-proof-history",
        turnId: "turn-2",
        provider: "airship-demo",
        model: "airship/demo-v1",
        now: "2026-07-18T10:01:00.000Z",
      }),
      receiptId: "urn:airship:receipt:second",
    },
  ];
}
