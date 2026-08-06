import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBuiltInProfileCatalog } from "../profiles/catalog";
import { createProfileRevision } from "../profiles/domain";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const changeApprovalMode = source.match(
  /async function changeActiveApprovalMode\(nextMode: ApprovalMode\): Promise<void> \{[\s\S]*?\n  \}\n/u,
)?.[0] ?? "";

/*
 * One durable journal event beside the manifest pin changes the policy on the
 * conversation already open — the old behavior (mint a new pinned conversation
 * for every switch) is exactly what a person reads as "switching Permissions
 * spawned a new chat thread". The profile default still lives where it always
 * did: profile revisions, for FUTURE conversations — which is what the status
 * sentence says plainly.
 */
describe("approval policy scope is stated where it is changed", () => {
  it("keeps the profile-ownable default inside profile revisions", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const general = catalog.profiles.find((profile) => profile.profileId === "general");
    expect(general?.approvalMode).toBe("ask-first");
    const revised = await createProfileRevision({
      ...general!,
      parentRevision: general!.revision,
      approvalMode: "full-access",
      createdAt: "2026-07-28T00:00:00.000Z",
    });
    const next = catalog.profiles.map((profile) =>
      profile.profileId === revised.profileId ? revised : profile,
    );
    expect(next.find((profile) => profile.profileId === "general")?.approvalMode).toBe("full-access");
  });

  it("changes the conversation in place with a durable journal event", () => {
    expect(changeApprovalMode).toContain("journal.setSessionApprovalMode(visibleSessionId, nextMode)");
    expect(changeApprovalMode).toContain("setActiveSessionRecord(updated)");
    // The very next call is governed by it: a running turn hot-swaps the live
    // controller, which is the point of the hot-swap branch continuing.
    expect(changeApprovalMode).toContain("activeTurnSessionId.current === visibleSessionId");
    expect(changeApprovalMode).toContain("approvalPolicyController.replace(approvalModePolicies[nextMode])");
    expect(changeApprovalMode).toContain("setLiveApprovalMode(Object.freeze({ sessionId: visibleSessionId, mode: nextMode }))");
    // The old way minted a pinned clone and announced it; both are gone.
    expect(changeApprovalMode).not.toContain("createProfileSession");
    expect(changeApprovalMode).not.toContain("new pinned conversation");
    expect(changeApprovalMode).not.toContain("replaceProfile(current, revisedProfile)");
    // What the person is told: this conversation changed; the profile default
    // for new conversations did not.
    expect(changeApprovalMode).toContain("Approval policy changed to ${approvalModeLabel(nextMode)} for this conversation. The profile default for new conversations is unchanged.");
  });

  it("names the composer control by what it does: change this conversation, next call governed", () => {
    // The aria name must not end in "new conversation", which would collide
    // with the session bar's New conversation button under substring matching.
    expect(source).toContain("Conversation approval policy · changes this conversation in place, next call governed");
    expect(source).not.toContain("then starts a pinned conversation when idle");
    expect(source).not.toMatch(/ariaLabel="[^"]*new conversations?"/iu);
  });
});
