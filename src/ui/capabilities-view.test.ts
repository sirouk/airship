import { describe, expect, it } from "vitest";
import { sealStateForCapabilitySummary } from "./capabilities-view";

describe("capability summary evidence", () => {
  it("does not verify a completed inspection unless every reported runtime is ready", () => {
    expect(sealStateForCapabilitySummary([])).toBe("checking");
    expect(sealStateForCapabilitySummary([{ state: "ready" }, { state: "ready" }])).toBe("verified");
    expect(sealStateForCapabilitySummary([{ state: "ready" }, { state: "installable" }])).toBe("asserted");
    expect(sealStateForCapabilitySummary([{ state: "unavailable" }, { state: "installable" }])).toBe("none");
    expect(sealStateForCapabilitySummary([{ state: "failed" }, { state: "unavailable" }])).toBe("failed");
  });

  it("surfaces inspection failure independently of cached runtime rows", () => {
    expect(sealStateForCapabilitySummary([{ state: "ready" }], true)).toBe("failed");
  });
});
