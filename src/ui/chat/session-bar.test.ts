import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const bar = readFileSync(new URL("./session-bar.tsx", import.meta.url), "utf8");

describe("conversation status facts", () => {
  it("mounts the current durability and lifecycle facts without a second fact channel", () => {
    expect(app).toContain("statusFacts={sessionStatusFacts}");
    expect(app).toContain('id: "durability" as const,');
    expect(app).toContain('id: "lifecycle" as const,');
    expect(app).not.toContain("conversationFacts={");
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
