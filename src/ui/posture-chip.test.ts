import { describe, expect, it } from "vitest";
import { posturePresentation } from "./posture-chip";

describe("profile trust-floor presentation", () => {
  it("maps minimum posture to named Seal semantics", () => {
    expect(posturePresentation("local")).toEqual(expect.objectContaining({ state: "none", label: "Local" }));
    expect(posturePresentation("encrypted-unattested")).toEqual(expect.objectContaining({ state: "asserted", label: "Encrypted · unattested" }));
    expect(posturePresentation("encrypted-attested")).toEqual(expect.objectContaining({ state: "verified", label: "Encrypted · attested" }));
  });
});
