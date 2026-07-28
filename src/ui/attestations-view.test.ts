import { describe, expect, it } from "vitest";
import { AttestationEvidenceClientError } from "../attestation/provider-client";
import { attestationQualifierLabel, attestationRefreshError } from "./attestations-view";
import { claimQualifierLabel } from "./claim-stack-facts";

describe("attestation refresh failure copy", () => {
  it("renders an unreadable cross-origin response without inventing a CORS or TEE result", () => {
    const message = attestationRefreshError(new AttestationEvidenceClientError(
      "cross-origin-unreadable",
      "The browser could not read the Chutes evidence response.",
    ));
    expect(message).toContain("Provider evidence is cross-origin unreadable");
    expect(message).toContain("CORS authorization or the network path may have failed");
    expect(message).toContain("evidence was not pulled");
    expect(message).toContain("not a TEE verification failure");
    expect(message).toContain("no claim was promoted");
    expect(message).not.toContain("proxy");
  });

  it("does not expose arbitrary provider error text", () => {
    const message = attestationRefreshError(new Error("raw provider body csc_never-show-this-value"));
    expect(message).toBe("Evidence refresh failed safely. Evidence was not pulled, and no verification state was inferred from the failure.");
    expect(message).not.toContain("csc_");
  });
});

describe("one qualifier vocabulary across both Proof tabs", () => {
  it("says exactly what the Receipt & journal tab says about the same qualifier", () => {
    // The defect this package exists to fix is two tabs describing one turn in
    // two languages. The dictionary cannot be shared as a module here — see the
    // comment on `attestationQualifierLabel` — so the agreement is asserted
    // instead, over every qualifier `attestations-model.ts` can emit.
    const emitted = [
      ...(["verified", "partial", "failed", "expired", "unavailable"] as const).map((state) => `asserted-${state}`),
      "verified-without-authority",
      "matched", "present", "unverified", "verified", "failed", "expired", "unavailable",
      "runtime-policy-matched/model-unavailable",
      "matched/unavailable",
    ];
    for (const qualifier of emitted) {
      expect(attestationQualifierLabel(qualifier), qualifier)
        .toBe(claimQualifierLabel(qualifier, { ceilingStatedElsewhere: true }));
    }
  });

  it("never re-prefixes the status word the caller already rendered", () => {
    // "Attested endpoint-key bindingASSERTED · ASSERTED PARTIAL · RECEIPT
    // UNAUTHENTICATED" — four status words in a row, in two casings.
    for (const qualifier of ["asserted-verified", "asserted-failed", "verified-without-authority", "matched"]) {
      expect(attestationQualifierLabel(qualifier)?.toLowerCase()).not.toContain("asserted");
    }
    expect(attestationQualifierLabel("asserted-partial")).toBeUndefined();
  });
});
