import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

/*
 * Approval-policy and skill-policy writes commit the catalog revision BEFORE
 * the activation leg opens the pinned conversation it names. A failure in the
 * activation leg therefore cannot honestly report "the policy could not be
 * changed": the durable default already moved. These pin the truthful copy on
 * that failure path.
 */
describe("policy activation failure honesty", () => {
  const approvalBody = app.slice(
    app.indexOf("async function changeActiveApprovalMode("),
    app.indexOf("async function forkProfile("),
  );
  const skillBody = app.slice(
    app.indexOf("async function setProfileSkill("),
    app.indexOf("async function loadBillingSnapshot("),
  );

  it("the approval-policy notice names the committed default when the conversation fails to open", () => {
    expect(approvalBody).toContain("defaultCommitted = true;");
    // The flag is set only after `mutateProfileCatalog` resolves: a catalog
    // failure still reports as a refusal, not as a half-truth.
    expect(approvalBody.indexOf("defaultCommitted = true;"))
      .toBeGreaterThan(approvalBody.indexOf("await mutateProfileCatalog("));
    expect(approvalBody).toContain("The profile default was updated to ${approvalModeLabel(nextMode)}, but the new conversation could not be opened.");
    // The generic refusal copy survives for failures before the commit.
    expect(approvalBody).toContain("The approval policy could not be changed.");
  });

  it("the skill-policy error names the profile whose default already moved", () => {
    expect(skillBody).toContain("defaultCommitted = true;");
    expect(skillBody.indexOf("defaultCommitted = true;"))
      .toBeGreaterThan(skillBody.indexOf("await mutateProfileCatalog("));
    expect(skillBody).toContain("The ${revisedProfile.name} profile default was updated, but the new conversation could not be opened.");
  });
});

/*
 * "Cancel preview" used to discard the entire unsaved profile draft —
 * name, role, instructions and boundaries — because it rebuilt the draft
 * from the saved revision. A preview touches exactly one field, and
 * cancelling it restores exactly that field.
 */
describe("theme preview cancel scope", () => {
  const managerBody = app.slice(
    app.indexOf("function ProfileManagerView("),
    app.indexOf("function SkillsManagerView("),
  );

  it("resets only the theme field and clears the preview state", () => {
    expect(managerBody).toContain("setDraft((current) => ({ ...current, themeId: selected.theme.themeId }));");
    expect(managerBody).toContain("setPreviewThemeId(undefined);");
    // The full-draft replacement is gone from the cancel path…
    expect(cancelPreview(app)).not.toContain("setDraft(profileDraftForEditor(selected))");
    // …and stays where it belongs: following a save, a fork, or a selection change.
    expect(managerBody).toContain("setDraft(profileDraftForEditor(selected));");
  });

  it("still restores the applied theme through the same preferences call", () => {
    expect(cancelPreview(app)).toContain("applyThemeWithPreferences(theme, preferences)");
  });
});

/** The "Cancel preview" button's handler, from its onClick through its closing tag. */
function cancelPreview(source: string): string {
  const label = source.indexOf(">Cancel preview</button>");
  expect(label).toBeGreaterThan(-1);
  const start = source.lastIndexOf("onClick={() => {", label);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("</button>", label));
}
