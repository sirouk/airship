import { describe, expect, it, vi } from "vitest";
import { emptyClaims, type ConversationReceipt } from "../receipts/types";
import { normalizeAttestationEvidence } from "./attestations-model";
import {
  MAX_SESSION_ATTESTATION_RECEIPTS,
  attestationRecordIdForReceipt,
  sessionAttestationReceipts,
} from "./attestation-history";

describe("session attestation receipt history", () => {
  it("keeps only unique receipts from the active session in newest-first order", () => {
    const oldest = receipt(1);
    const newest = receipt(3);
    const replacement = { ...receipt(2), model: "replacement-model" };
    const duplicate = { ...replacement, model: "last-visible-copy" };

    const receipts = sessionAttestationReceipts({
      sessionId: "session-a",
      messages: [
        { receipt: oldest },
        { receipt: replacement },
        { receipt: receipt(9, "session-b") },
        { receipt: duplicate },
        { receipt: newest },
      ],
    });

    expect(receipts.map((item) => item.receiptId)).toEqual([
      newest.receiptId,
      replacement.receiptId,
      oldest.receiptId,
    ]);
    expect(receipts[1]!.model).toBe("last-visible-copy");
  });

  it("bounds the page while retaining an older receipt selected from its message chip", () => {
    const all = Array.from({ length: MAX_SESSION_ATTESTATION_RECEIPTS + 2 }, (_, index) => receipt(index));
    const initiallyVisible = sessionAttestationReceipts({
      sessionId: "session-a",
      messages: all.map((item) => ({ receipt: item })),
    });
    expect(initiallyVisible).toHaveLength(MAX_SESSION_ATTESTATION_RECEIPTS);
    expect(initiallyVisible.some((item) => item.receiptId === all[0]!.receiptId)).toBe(false);

    const selectedRecordId = attestationRecordIdForReceipt(all[0]!);
    const selectedPage = sessionAttestationReceipts({
      sessionId: "session-a",
      selectedRecordId,
      messages: all.map((item) => ({ receipt: item })),
    });
    const records = normalizeAttestationEvidence({ receipts: selectedPage });

    expect(selectedPage).toHaveLength(MAX_SESSION_ATTESTATION_RECEIPTS);
    expect(records.some((record) => record.id === selectedRecordId)).toBe(true);
  });

  it("scans a large transcript without sorting or materializing an unbounded receipt index", () => {
    const count = 20_000;
    const all = Array.from({ length: count }, (_, index) => ({ receipt: receipt(index) }));
    const selectedRecordId = attestationRecordIdForReceipt(all[0]!.receipt);
    const sort = vi.spyOn(Array.prototype, "sort").mockImplementation(() => {
      throw new Error("receipt history must not sort");
    });

    let selectedPage: readonly ConversationReceipt[];
    try {
      selectedPage = sessionAttestationReceipts({
        sessionId: "session-a",
        selectedRecordId,
        messages: all,
      });
    } finally {
      sort.mockRestore();
    }

    expect(selectedPage).toHaveLength(MAX_SESSION_ATTESTATION_RECEIPTS);
    expect(selectedPage[0]!.receiptId).toBe(all.at(-1)!.receipt.receiptId);
    expect(selectedPage.at(-1)!.receiptId).toBe(all[0]!.receipt.receiptId);
  });

  it("uses the presenter's receipt ID without promoting structural receipts to trusted proof", () => {
    const candidate = receipt(7);
    candidate.claims.endpointKey = {
      status: "verified",
      summary: "Untrusted input declared a verified endpoint key.",
      verifier: "claimed-verifier",
      checkedAt: candidate.createdAt,
    };

    const [record] = normalizeAttestationEvidence({ receipts: [candidate] });
    expect(attestationRecordIdForReceipt(candidate)).toBe(record!.id);
    expect(record!.receiptTrust).toBe("asserted");
    expect(record!.dimensions["endpoint-key"].state).toBe("partial");
  });

  it("returns no receipts until an active session is known", () => {
    expect(sessionAttestationReceipts({ messages: [{ receipt: receipt(1) }] })).toEqual([]);
  });
});

function receipt(index: number, sessionId = "session-a"): ConversationReceipt {
  return {
    version: 1,
    receiptId: `urn:airship:receipt:${index.toString().padStart(4, "0")}`,
    sessionId,
    turnId: `turn-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    proofLevel: "encrypted",
    posture: "encrypted-unattested",
    provider: "chutes",
    instanceId: `instance-${index}`,
    model: "model-a",
    claims: emptyClaims(),
    bindings: {
      algorithm: "SHA-256",
      endpointKeyDigest: index.toString(16).padStart(64, "0"),
    },
    verifications: [],
  };
}
