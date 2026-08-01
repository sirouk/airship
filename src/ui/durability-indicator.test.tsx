import { describe, expect, it } from "vitest";
import { DURABILITY_STATES, durabilityLabel, durabilitySeal, durabilityShort } from "./durability-indicator";

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
  });

  it("ranks page memory as a state the reader has to act on", () => {
    /*
     * Shipped as `none`, which is this vocabulary's "no evidence was requested"
     * rung, and the Atlas measured the cost: a 180-turn conversation carried an
     * unqualified event count and a per-turn integrity assertion while the only
     * durability warning anywhere was a transient status string overwritten by
     * the first turn. Every surface that renders a durability claim reads this
     * one function, so the rung is the product's single answer to "does closing
     * this tab cost anything".
     */
    expect(durabilitySeal("ephemeral")).toBe("attention");
    // The two claims that mean "your work is written down" must not be dragged
    // up with it; only the states with a consequence are alarming.
    expect(durabilitySeal("local")).toBe("verified");
    expect(durabilitySeal("synced")).toBe("verified");
  });

  it("abbreviates to the consequence, not to the jargon", () => {
    // "Ephemeral" is what `sessionStatusShort` derives from the label, and it is
    // the word the novice persona read four times without learning that their
    // conversation was not being kept.
    expect(durabilityShort("ephemeral")).toBe("Not saved");
    for (const state of DURABILITY_STATES) {
      expect(durabilityShort(state).length, state).toBeLessThanOrEqual(14);
    }
  });
});
