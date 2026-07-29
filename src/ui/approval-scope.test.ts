import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBuiltInProfileCatalog } from "../profiles/catalog";
import { createProfileRevision } from "../profiles/domain";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const changeApprovalMode = source.match(
  /async function changeActiveApprovalMode\(nextMode: ApprovalMode\): Promise<void> \{[\s\S]*?\n  \}\n/u,
)?.[0] ?? "";

/*
 * The composer's approval control has no conversation-scoped representation to
 * write into: a mode lives in a `ProfileRevision`, and a session pin is only
 * accepted against the catalog's *active* revision, so changing it here commits
 * a new profile default. These cases pin the copy to that fact — the defect was
 * not the mutation, it was three strings that described a narrower one.
 */
describe("approval policy scope is stated where it is changed", () => {
  it("moves the profile default, which is the state the copy has to describe", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const general = catalog.profiles.find((profile) => profile.profileId === "general");
    expect(general?.approvalMode).toBe("ask-first");
    const revised = await createProfileRevision({
      ...general!,
      parentRevision: general!.revision,
      approvalMode: "full-access",
      createdAt: "2026-07-28T00:00:00.000Z",
    });
    // `replaceProfile` in app.tsx swaps exactly this revision into the catalog,
    // so the profile's next conversation resolves `full-access` as its default.
    const next = catalog.profiles.map((profile) =>
      profile.profileId === revised.profileId ? revised : profile,
    );
    expect(next.find((profile) => profile.profileId === "general")?.approvalMode).toBe("full-access");
  });

  it("commits the new mode as the profile revision and says so in the same breath", () => {
    expect(changeApprovalMode).toContain("replaceProfile(current, revisedProfile)");
    expect(changeApprovalMode).toContain("will start new conversations in ${approvalModeLabel(nextMode)}");
    expect(changeApprovalMode).toContain("${revisedProfile.name}");
    expect(changeApprovalMode).not.toContain("this conversation's approval policy");
  });

  it("names the composer control by its real scope, without colliding with New conversation", () => {
    // The name has to say the control reaches past this conversation — but the
    // first spelling ended in "…this profile's new conversations", which
    // *contains* "New conversation". Accessible-name matching is substring
    // matching, so the session bar's New conversation button and this menu
    // became two elements with one name: every by-name query for either
    // resolved to both, and eight browser journeys failed on the ambiguity.
    expect(source).not.toContain('ariaLabel="Conversation approval policy"');
    expect(source).toContain('ariaLabel="Conversation approval policy · applies to this conversation and future ones in this profile"');
    expect(source).not.toMatch(/ariaLabel="[^"]*new conversations?"/iu);
  });
});
