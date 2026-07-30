import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pinnedSkillsLabel } from "./session-bar";

const source = readFileSync(new URL("./session-bar.tsx", import.meta.url), "utf8");

describe("pinned conversation skills", () => {
  it("reports the immutable set in the session bar", () => {
    expect(pinnedSkillsLabel(0)).toBe("0 skills pinned to this conversation");
    expect(pinnedSkillsLabel(1)).toBe("1 skill pinned to this conversation");
    expect(pinnedSkillsLabel(3)).toBe("3 skills pinned to this conversation");
    expect(source).toContain("Later Skill changes apply only to a new conversation.");
    expect(source).toContain("pin.skillSetDigest");
    expect(source).toContain("pin.skills.map");
  });
});
