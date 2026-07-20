import { describe, expect, it } from "vitest";
import { AttestationEvidenceClientError } from "../attestation/provider-client";
import { attestationRefreshError } from "./attestations-view";

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
