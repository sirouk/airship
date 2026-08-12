import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pinnedSkillsDetail, pinnedSkillsLabel } from "./session-bar";

const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const bar = readFileSync(new URL("./session-bar.tsx", import.meta.url), "utf8");

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

/*
 * A rename that cannot proceed has to say so.
 *
 * `renameActiveConversation` throws sentences written for a person — a turn
 * still running, a journal not ready yet, a title the journal itself refuses —
 * and the bar caught every one of them and did nothing but refocus the field.
 * The edit stayed open with the typed text and no stated cause, and because the
 * field's own `onBlur` commits, the next blur repeated the same silence.
 */
describe("the conversation rename's refusals", () => {
  it("puts the thrown sentence back on the field the reader is already in", () => {
    expect(bar).toContain("} catch (caught) {");
    expect(bar).toContain('renameInput.current?.setCustomValidity(caught instanceof Error ? caught.message : "The conversation could not be renamed.");');
    expect(bar).toContain("renameInput.current?.reportValidity();");
    // The field stays open holding what was typed, which is the half of the old
    // behaviour that was right.
    expect(bar).toContain("renameInput.current?.focus();");
    expect(bar).toContain("renameInFlight.current = false;");
  });

  it("clears the last refusal before asking the field again", () => {
    // Left standing, a custom message outranks `required`, so an emptied title
    // would report the previous failure instead of the empty box in front of it.
    expect(bar).toContain('renameInput.current?.setCustomValidity("");');
    expect(bar.indexOf('setCustomValidity("")')).toBeLessThan(bar.indexOf("renameInput.current?.reportValidity();"));
  });
});
