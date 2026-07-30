import { describe, expect, it } from "vitest";
import { DURABILITY_STATES, durabilityLabel, durabilitySeal } from "./durability-indicator";

describe("DurabilityIndicator", () => {
  it("states page-only durability without implying sync", () => {
    expect(durabilityLabel("ephemeral")).toBe("Ephemeral · this page only");
    expect(durabilityLabel("local")).toBe("Encrypted · this device");
    expect(durabilityLabel("syncing")).not.toContain("synced");
  });

  it("claims an in-progress sync in exactly one state, and never in the paused one", () => {
    /*
     * "not `synced`" was the whole of the old assertion, which a present-tense
     * activity claim passes trivially: the offline adopted-vault path returned
     * `syncing`, so the chip read "Syncing encrypted state" beside its own detail
     * sentence saying encrypted objects are not synchronizing. Both strings are
     * the chip's accessible name at different moments, so this is what a screen
     * reader announces, not decoration.
     */
    const progressive = /Syncing|Synchronizing/u;
    expect(durabilityLabel("syncing")).toMatch(progressive);
    for (const state of DURABILITY_STATES.filter((candidate) => candidate !== "syncing")) {
      expect(durabilityLabel(state), state).not.toMatch(progressive);
    }
    expect(durabilityLabel("sync-paused")).toBe("Encrypted · sync paused offline");
    // The seal is the same claim in glyph form and must not out-rank the words.
    expect(durabilitySeal("sync-paused")).toBe("attention");
    expect(durabilitySeal("syncing")).toBe("checking");
    expect(durabilitySeal("synced")).toBe("verified");
    expect(durabilitySeal("local")).toBe("verified");
    expect(durabilitySeal("ephemeral")).toBe("none");
  });
});
