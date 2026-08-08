import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

/*
 * Approval-policy change settled on one truth: the policy is a durable event
 * on the conversation's own journal chain, not a catalog revision plus a new
 * pinned conversation. Its failure mode is honest by construction — a failed
 * append leaves nothing half-committed, so the notice can plainly say the
 * change did not land. The skill-policy write still commits a catalog
 * revision before its activation leg; that one retains the
 * default-already-moved honesty case. These pin both truthful copies.
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

  it("the approval-policy refusal names only what did not happen, because nothing did", () => {
    // The refusal sentence exists and is conversation-scoped: same thread,
    // no catalog revision, no session minted, no half-truth about defaults.
    expect(approvalBody).toContain("The approval policy could not be changed for this conversation.");
    expect(approvalBody).toContain("journal.setSessionApprovalMode(visibleSessionId, nextMode)");
    expect(approvalBody).not.toContain("defaultCommitted");
    expect(approvalBody).not.toContain("createProfileSession");
    expect(approvalBody).not.toContain("replaceProfile(current, revisedProfile)");
    // The navigation guard always releases, whether the append landed or not.
    expect(approvalBody).toContain("sessionNavigationChanging.current = true;");
    expect(approvalBody).toContain("sessionNavigationChanging.current = false;");
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
    app.indexOf("function RouteBar("),
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

/*
 * Every cell of the revision strip is a quarter of the strip, `nowrap`, and
 * ellipsised. A provider and a model do not fit in a quarter at any viewport —
 * "airship-demo · airship…" was measured truncated at 1920px — so the cell that
 * carries two names carries the hover recovery the terminal's shell path
 * already uses for the same reason.
 */
describe("the revision strip's runtime cell", () => {
  it("can be read in full when its quarter of the strip cuts it short", () => {
    const strip = app.slice(app.indexOf('<div class="revision-strip">'), app.indexOf('<div class="profile-actions">'));
    expect(strip).toContain("<span title={`${selected.providerId} · ${selected.model}`}>");
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
