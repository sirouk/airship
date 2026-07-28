import { describe, expect, it } from "vitest";
import {
  PROFILE_BOUNDARY_NOTE,
  PROFILE_POSTURE_FIELD_LABEL,
  profileGovernanceCellLabel,
  profileGovernanceCells,
  type ProfileGovernanceInput,
} from "./profiles-governance";

function input(overrides: Partial<ProfileGovernanceInput> = {}): ProfileGovernanceInput {
  return {
    systemPromptLength: 419,
    themeName: "Foundry",
    memoryScope: "profile",
    approvalMode: "ask-first",
    minimumPosture: "local",
    skillCount: 3,
    ...overrides,
  };
}

describe("profileGovernanceCells", () => {
  it("makes all six governed things legible with zero clicks", () => {
    expect(profileGovernanceCells(input()).map((cell) => `${cell.label} ${cell.value}`)).toEqual([
      "Instructions 419 ch",
      "Theme Foundry",
      "Memory This profile",
      "Approvals Ask First",
      "Minimum proof Local",
      "Skills 3",
    ]);
  });

  it("never prints a raw enum where the editor prints a sentence", () => {
    const cells = profileGovernanceCells(input({ memoryScope: "workspace", minimumPosture: "encrypted-attested" }));
    const values = cells.map((cell) => cell.value);
    expect(values).toContain("Shared workspace");
    expect(values).toContain("Attested");
    for (const value of values) expect(value).not.toMatch(/[a-z]+-[a-z]+/u);
  });

  it("keeps the three approval labels in the Title Case eight e2e assertions pin", () => {
    for (const [mode, label] of [["ask-first", "Ask First"], ["auto-approve", "Auto Approve"], ["full-access", "Full Access"]] as const) {
      const cell = profileGovernanceCells(input({ approvalMode: mode })).find((item) => item.key === "approvals");
      expect(cell?.value).toBe(label);
    }
  });

  it("gives the minimum-proof field exactly one name", () => {
    const cell = profileGovernanceCells(input()).find((item) => item.key === "proof");
    expect(cell?.label).toBe(PROFILE_POSTURE_FIELD_LABEL);
    expect(PROFILE_POSTURE_FIELD_LABEL).toBe("Minimum proof");
  });

  it("gives the skill count somewhere to go", () => {
    const cell = profileGovernanceCells(input()).find((item) => item.key === "skills");
    expect(cell?.link).toBe("#skills");
  });

  it("returns frozen records so a caller cannot re-word a field name in place", () => {
    const cells = profileGovernanceCells(input());
    expect(Object.isFrozen(cells)).toBe(true);
    expect(Object.isFrozen(cells[0])).toBe(true);
  });
});

describe("profileGovernanceCellLabel", () => {
  it("says the field, its value and what opening it does", () => {
    const cell = profileGovernanceCells(input())[2]!;
    expect(profileGovernanceCellLabel(cell)).toBe("Memory: This profile. Choose how far this profile's memory reaches.");
  });
});

describe("PROFILE_BOUNDARY_NOTE", () => {
  it("no longer points below itself at a control that is above it", () => {
    expect(PROFILE_BOUNDARY_NOTE).not.toContain("below");
    expect(PROFILE_BOUNDARY_NOTE).toContain("copied into each new session");
    expect(PROFILE_BOUNDARY_NOTE).toContain("keep their original pin");
  });
});
