import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBuiltInProfileCatalog } from "../profiles/catalog";
import { createProfileRevision } from "../profiles/domain";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const changeApprovalMode = source.match(
  /async function changeActiveApprovalMode\(nextMode: ApprovalMode\): Promise<void> \{[\s\S]*?\n  \}\n/u,
)?.[0] ?? "";

/*
 * Idle changes still use the immutable profile-revision flow. During a live
 * turn the same control swaps the page-memory delegate in place, without
 * rewriting the pinned manifest or its audit chain. These cases pin both
 * meanings to the copy the person sees.
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
    const liveBranch = changeApprovalMode.slice(
      changeApprovalMode.indexOf("if (busy)"),
      changeApprovalMode.indexOf("if (\n      !runtime.current"),
    );
    expect(liveBranch).toContain("setLiveApprovalMode");
    expect(liveBranch).toContain("approvalPolicyController.replace(approvalModePolicies[nextMode])");
    expect(liveBranch).toContain("The pinned conversation and audit remain unchanged.");
    expect(liveBranch).not.toContain("Stop the active turn and wait for model or storage changes before changing the approval policy.");
  });

  it("names the composer control by its real scope, without colliding with New conversation", () => {
    // The name has to describe both paths: live replacement while a turn runs,
    // and a new immutable pin when idle. It must not end in "new conversation",
    // which would collide with the session bar's New conversation button under
    // accessible-name substring matching.
    expect(source).not.toContain('ariaLabel="Conversation approval policy"');
    expect(source).toContain('ariaLabel="Conversation approval policy · live during a turn, then starts a pinned conversation when idle"');
    expect(source).not.toMatch(/ariaLabel="[^"]*new conversations?"/iu);
  });
});
