import { describe, expect, it } from "vitest";
import { sha256 } from "./hash";
import {
  AIRSHIP_CORE_CHARTER,
  AIRSHIP_CORE_CHARTER_VERSION,
  composeAirshipOperatingPrompt,
} from "./operating-charter";

describe("Airship core operating charter", () => {
  it("is versioned, deterministic, and byte-stable", async () => {
    expect(AIRSHIP_CORE_CHARTER_VERSION).toBe(3);
    expect(AIRSHIP_CORE_CHARTER).not.toMatch(/\{\{|\$\{|20\d\d-/u);
    expect(await sha256(AIRSHIP_CORE_CHARTER)).toBe(
      "sha256:M55m7_gE4XUwfM-QE8hBdP-IDpvIWnhwIrMC1yxUP2A",
    );
  });

  it("defines the edge environment and its honest capability boundaries", () => {
    for (const contract of [
      "browser-native edge agent runtime",
      "inspect-act-verify",
      "current tool manifest",
      "virtual filesystem rooted at /workspace",
      "append-only, content-addressed conversation",
      "Context is selected client-side retrieval material",
      "Memory is a derived, provenance-bearing view of available state",
      "Explicit episodic memory belongs only to this session's pinned profile",
      "Workspace files, sources, and their hybrid index are shared",
      "Google Drive or S3-compatible object transport receives encrypted objects directly from the client",
      "do not assume vault adoption, synchronization, durability, or freshness",
      "Do not equate a local receipt",
      "reliable execution while suspended",
      "discover before concluding",
    ]) {
      expect(AIRSHIP_CORE_CHARTER).toContain(contract);
    }
  });

  it("layers profile and skill behavior after the invariant charter", () => {
    const prompt = composeAirshipOperatingPrompt("PROFILE-CANARY", [
      { skillId: "first", systemPrompt: "SKILL-ONE-CANARY" },
      { skillId: "second", systemPrompt: "SKILL-TWO-CANARY" },
    ]);

    expect(prompt).toBe(
      `${AIRSHIP_CORE_CHARTER}\n\n` +
      "[Airship profile]\nPROFILE-CANARY\n\n" +
      "[Airship skill: first]\nSKILL-ONE-CANARY\n\n" +
      "[Airship skill: second]\nSKILL-TWO-CANARY",
    );
    expect(prompt.indexOf("PROFILE-CANARY")).toBeGreaterThan(prompt.indexOf("discover before concluding"));
    expect(prompt.indexOf("SKILL-ONE-CANARY")).toBeGreaterThan(prompt.indexOf("PROFILE-CANARY"));
  });
});
