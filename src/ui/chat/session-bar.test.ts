import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pinnedSkillsDetail, pinnedSkillsLabel } from "./session-bar";

const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

/*
 * The set is no longer a chip on the session bar. It was a 44px glyph whose
 * entire content was a popover, on the row that already had three other
 * indicators and one title; the facts moved into the runtime chip's sheet,
 * where a claim row can hold the whole sentence.
 *
 * So the assertions moved from "the popover renders these strings" to "the
 * sentence carries every fact the popover did, and something mounts it". Both
 * halves matter: a detail function nobody calls is not a shipped fact, which is
 * the failure mode the composer's posture chip was written against.
 */
describe("pinned conversation skills", () => {
  it("counts the set in plain words", () => {
    expect(pinnedSkillsLabel(0)).toBe("0 skills pinned to this conversation");
    expect(pinnedSkillsLabel(1)).toBe("1 skill pinned to this conversation");
    expect(pinnedSkillsLabel(3)).toBe("3 skills pinned to this conversation");
  });

  it("keeps every name, every short digest and the set digest in the sentence", () => {
    const detail = pinnedSkillsDetail({
      skillSetDigest: "sha256:0123456789abcdef",
      skills: [
        { skillId: "review", name: "Code review", digest: "sha256:aaaaaaaaa111111111" },
        { skillId: "notes", name: "Meeting notes", digest: "sha256:bbbbbbbbb222222222" },
      ],
    });
    expect(detail).toContain("Later Skill changes apply only to a new conversation.");
    expect(detail).toContain("Code review (111111111)");
    expect(detail).toContain("Meeting notes (222222222)");
    expect(detail).toContain("Skill-set digest sha256:0123456789abcdef.");
  });

  it("states the empty set rather than saying nothing", () => {
    const detail = pinnedSkillsDetail({ skillSetDigest: "sha256:empty", skills: [] });
    expect(detail).toContain("No Skill instructions were pinned.");
  });

  it("is mounted as a conversation fact behind the runtime chip", () => {
    expect(app).toContain("detail: pinnedSkillsDetail({");
    expect(app).toContain("conversationFacts={conversationFacts}");
    // The bar may not grow the slot back.
    expect(app).not.toContain("pinnedSkills={");
  });
});
