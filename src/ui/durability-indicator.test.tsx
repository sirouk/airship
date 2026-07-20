import { describe, expect, it } from "vitest";
import { durabilityLabel } from "./durability-indicator";

describe("DurabilityIndicator", () => {
  it("states page-only durability without implying sync", () => {
    expect(durabilityLabel("ephemeral")).toBe("Ephemeral · this page only");
    expect(durabilityLabel("syncing")).not.toContain("synced");
  });
});
