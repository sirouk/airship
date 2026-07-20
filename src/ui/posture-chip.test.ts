import { describe, expect, it } from "vitest";
import { posturePresentation } from "./posture-chip";

describe("posture presentation", () => {
  it("presents required attestation as policy rather than verified evidence", () => {
    expect(posturePresentation("encrypted-attested")).toEqual({
      state: "asserted",
      label: "Encrypted · proof required",
      detail: "Policy requires fresh endpoint proof before invocation; only turn evidence can verify the claim.",
    });
  });
});
