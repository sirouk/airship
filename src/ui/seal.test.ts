import { describe, expect, it } from "vitest";
import {
  postureSeal,
  SEAL_LABELS,
  SEAL_STATES,
  sealRenderedSize,
  sealStateForReceipt,
  sealStateForProofStatus,
  sealStateForRuntimeStatus,
} from "./seal";
import { createLocalReceipt } from "../receipts/types";

describe("canonical seal grammar", () => {
  it("defines seven named states over the canonical six-shape grammar", () => {
    expect(SEAL_STATES).toEqual([
      "none",
      "checking",
      "stale",
      "verified",
      "asserted",
      "attention",
      "failed",
    ]);
    expect(SEAL_LABELS.none).toBe("Not checked");
    expect(new Set(Object.values(SEAL_LABELS)).size).toBe(7);
  });

  it("normalizes proof and runtime states without inventing new visual states", () => {
    expect(sealStateForProofStatus("verified")).toBe("verified");
    expect(sealStateForProofStatus("partial")).toBe("asserted");
    expect(sealStateForProofStatus("expired")).toBe("failed");
    expect(sealStateForProofStatus("failed")).toBe("failed");
    expect(sealStateForProofStatus("unavailable")).toBe("none");
    expect(sealStateForRuntimeStatus("checking")).toBe("checking");
    expect(sealStateForRuntimeStatus("stale")).toBe("stale");
    expect(sealStateForRuntimeStatus("degraded")).toBe("attention");
  });

  it("maps every posture to one canonical hero state", () => {
    expect(postureSeal("local")).toBe("none");
    expect(postureSeal("plaintext-remote")).toBe("attention");
    expect(postureSeal("encrypted-unattested")).toBe("asserted");
    expect(postureSeal("encrypted-attested")).toBe("verified");
  });

  it("fails closed when an attested receipt's posture, level, and endpoint claim disagree", () => {
    const receipt = createLocalReceipt({ sessionId: "session", turnId: "turn", provider: "test", model: "model" });
    receipt.posture = "encrypted-attested";
    receipt.proofLevel = "attested-endpoint";
    expect(sealStateForReceipt(receipt)).toBe("failed");
    receipt.claims.endpointKey = { status: "verified", summary: "Exact endpoint key verified." };
    expect(sealStateForReceipt(receipt)).toBe("verified");
    receipt.proofLevel = "encrypted";
    expect(sealStateForReceipt(receipt)).toBe("failed");
  });

  it("never renders a seal below the 16px legibility floor", () => {
    expect(sealRenderedSize(8)).toBe(16);
    expect(sealRenderedSize(16)).toBe(16);
    expect(sealRenderedSize(44)).toBe(44);
  });
});
