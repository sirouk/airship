import { describe, expect, it } from "vitest";
import { claimExpiry, claimLanguage, postureLabel, proofLevelLabel, proofStatusLabel, rankedReceiptVerdict, relativeEvidenceAge } from "./trust-language";

describe("trust language", () => {
  it("never exposes machine enums as primary copy", () => {
    expect(proofLevelLabel("attested-endpoint")).toBe("Endpoint attested");
    expect(postureLabel("encrypted-unattested")).toBe("Encrypted · no required endpoint proof");
    expect(postureLabel("encrypted-attested")).toBe("Encrypted · fresh endpoint proof required");
    expect(proofStatusLabel("partial")).toBe("Asserted");
    expect(claimLanguage("cpuTee")).toEqual({ primary: "Protected CPU runtime", technical: "CPU TEE" });
  });
  it("speaks absence as absence and keeps the author in an assertion", () => {
    // "Established" meant two opposite things 183px apart: the rail counted
    // "7 established" for claims only recorded, while the metric beside it read
    // "Not established" to mean nothing was proven. The word is retired.
    expect(proofStatusLabel("unavailable")).toBe("No evidence");
    for (const status of ["verified", "partial", "failed", "expired", "unavailable"] as const) {
      expect(proofStatusLabel(status).toLowerCase()).not.toContain("establish");
    }
    // "Recorded" would say Airship wrote it down and drop the party that said
    // it. "Asserted" keeps the author, which is the claim being made.
    expect(proofStatusLabel("partial")).not.toBe("Recorded");
  });
  it("renders relative ages while timestamps remain available for time metadata", () => {
    expect(relativeEvidenceAge("2026-07-18T12:57:00.000Z", Date.parse("2026-07-18T13:00:00.000Z"))).toBe("3 minutes ago");
  });
  it("ranks failures before positive claims", () => {
    expect(rankedReceiptVerdict({ proofLevel: "settled", posture: "encrypted-attested", statuses: ["verified", "failed"] })).toMatch(/^Verification failed/);
  });
  it("extracts only valid explicit claim expiry fields", () => {
    expect(claimExpiry({ expiresAt: "2026-07-19T00:00:00.000Z" })).toBe("2026-07-19T00:00:00.000Z");
    expect(claimExpiry({ expiresAt: "tomorrow-ish" })).toBeUndefined();
  });
});
