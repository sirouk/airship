import { describe, expect, it } from "vitest";
import { remainingApprovalTime, writeApprovalFacts } from "./approval-presentation";

describe("approval presentation", () => {
  it("derives bounded, human write consequences", () => {
    expect(writeApprovalFacts({ path: "notes/a.md", expectedRevision: "r1", oldContent: "old", content: "newer" })).toEqual({
      target: "notes/a.md", disposition: "Replace", byteLength: 5, byteDelta: 2, before: "old", after: "newer",
    });
    expect(writeApprovalFacts({ path: "new.md", content: "x" })?.disposition).toBe("Create");
    expect(writeApprovalFacts({ path: "large", content: "x".repeat(2_000) })?.after).toContain("bounded preview");
  });

  it("formats a fail-closed expiry countdown", () => {
    expect(remainingApprovalTime("2026-07-18T00:02:03.000Z", Date.parse("2026-07-18T00:00:00.000Z"))).toBe("02:03");
    expect(remainingApprovalTime("2026-07-17T00:00:00.000Z", Date.parse("2026-07-18T00:00:00.000Z"))).toBe("00:00");
  });
});
