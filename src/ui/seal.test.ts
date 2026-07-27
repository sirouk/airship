import { describe, expect, it } from "vitest";
import {
  SEAL_DENSITIES,
  SEAL_LABELS,
  SEAL_STATES,
  sealDensitySize,
  sealRenderedSize,
  sealStateForProofStatus,
  sealStateForRuntimeStatus,
} from "./seal";
import { postureSeal, sealStateForReceipt } from "./seal-states";
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

  it("offers exactly three densities and no fourth escape hatch", () => {
    expect(SEAL_DENSITIES).toEqual(["dot", "chip", "hero"]);
  });

  it("renders every density in a well of at least 16px", () => {
    // The label is what scales down the disclosure ladder; the glyph does not.
    // `dot` hides its word, so it is the density most tempting to shrink and the
    // one where shrinking would leave colour as the only carrier of meaning.
    for (const density of SEAL_DENSITIES) {
      expect(sealDensitySize(density)).toBeGreaterThanOrEqual(16);
    }
    expect(sealDensitySize("dot")).toBe(16);
    expect(sealDensitySize("chip")).toBe(16);
    expect(sealDensitySize("hero")).toBe(28);
  });

  it("floors an explicit size override rather than trusting the call site", () => {
    expect(sealDensitySize("dot", 10)).toBe(16);
    expect(sealDensitySize("hero", 13)).toBe(16);
    expect(sealDensitySize("chip", 44)).toBe(44);
  });
});
