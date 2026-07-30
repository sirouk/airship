import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const app = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

const changeProfile = app.slice(
  app.indexOf("async function changeProfile("),
  app.indexOf("async function releaseOutgoingProfileTerminals("),
);
const releaseTerminals = (() => {
  const start = app.indexOf("async function releaseOutgoingProfileTerminals(");
  return app.slice(start, app.indexOf("\n  }\n", start));
})();

/*
 * `changeProfile` is a two-part commit — authority and identity — with every
 * fallible step inside one catalog transaction and a catch that restores the
 * outgoing cockpit. Stopping the outgoing profile's terminal is fallible in
 * exactly one direction: the process cannot be restarted, so unlike every other
 * step it has no rollback. It therefore belongs *after* the last thing that can
 * fail, not before it.
 *
 * Asserted at source because these are ordering laws inside one function, and
 * the failures they forbid are a refused encrypted catalog write and a runtime
 * replaced by a concurrent vault adoption — reachable in a render test only by
 * rebuilding the whole cockpit around them.
 */
describe("profile switch terminal quiesce position", () => {
  it("kills no shell process until the switch is a committed fact", () => {
    // Not inside the catalog transaction at all: everything the callback returns
    // is still subject to `active.profiles.commit`, the authority re-checks and
    // the session publication, and every one of those unwinds through the catch.
    const transaction = changeProfile.slice(
      changeProfile.indexOf("await mutateProfileCatalog("),
      changeProfile.indexOf("return next;"),
    );
    expect(transaction).not.toContain("quiesce");
    expect(transaction).not.toContain("releaseOutgoingProfileTerminals");
    expect(changeProfile).not.toContain("quiesceBrowserTerminalWorkspace(");

    // Both commit branches release the terminals only after identity and the
    // conversation have been published — the switch is true by then.
    const publishIdentity = changeProfile.indexOf("publishProfileId(nextId);");
    const restoredBranch = changeProfile.indexOf("await publishAuditedSession(restored.fresh, restored.audited,");
    const freshBranch = changeProfile.indexOf("const activated = await activateSession(nextSession);");
    const releases = [...changeProfile.matchAll(/await releaseOutgoingProfileTerminals\(/gu)].map((match) => match.index!);
    expect(releases).toHaveLength(2);
    expect(publishIdentity).toBeGreaterThan(-1);
    expect(releases[0]).toBeGreaterThan(restoredBranch);
    expect(releases[1]).toBeGreaterThan(freshBranch);
    for (const release of releases) expect(release).toBeGreaterThan(publishIdentity);
  });

  it("releases the outgoing workspace with the incoming profile's reason", () => {
    expect(changeProfile).toContain("await releaseOutgoingProfileTerminals(active.workspace, profile.name);");
    expect(releaseTerminals).toContain("outgoingWorkspace,");
    expect(releaseTerminals).toContain("`Switched to the ${incomingProfileName} profile. Restart this terminal against that profile's workspace.`");
    expect(releaseTerminals).not.toContain("switched.runtime.workspace");
  });

  it("reports a quiesce failure rather than unwinding a switch that already committed", () => {
    const failure = releaseTerminals.slice(releaseTerminals.indexOf("} catch (error) {"));
    expect(failure).toContain("setRuntimeStatus(");
    expect(failure).toContain("could not be released");
    expect(failure).not.toContain("throw");
  });

  it("still names the reason and restores the outgoing cockpit on any transaction failure", () => {
    expect(changeProfile).toContain("Profile switch failed:");
    expect(changeProfile).toContain("runtime.current = active;");
    expect(changeProfile).toContain("setGitClient(previousGit);");
    expect(changeProfile).toContain("setSlashRegistry(previousRegistry);");
    expect(changeProfile).toContain("publishProfileId(previousProfileId);");
  });

  it("restores nothing when a foreign authority owns the runtime", () => {
    /*
     * The guard that throws "The runtime changed before the profile cockpit
     * could be restored" exists because a durable-vault adoption can replace
     * `runtime.current` mid-switch. It publishes a whole cockpit — runtime, Git
     * client, slash registry, catalog checkpoint, session library, durable
     * authority and an activated Vault conversation — so restoring the four
     * fields this function knows about would leave the rest adopted, flip the
     * trust axis back to "not adopted" under a vault conversation, and hand the
     * next catalog commit a checkpoint minted by a different store.
     */
    expect(changeProfile).toContain("const ownsRuntime = runtime.current === active || runtime.current === committed;");
    const rollback = changeProfile.slice(changeProfile.indexOf("const ownsRuntime ="));
    expect(rollback.indexOf("if (ownsRuntime) {")).toBeLessThan(rollback.indexOf("runtime.current = active;"));
    expect(rollback).toContain("Profile switch abandoned:");
    // The runtime this call published is its own to put back; anything else is not.
    expect(changeProfile).toContain("committed = switched.runtime;");
  });

  it("keeps an automatic vault adoption out of a cockpit transition entirely", () => {
    // The other half of the same defect: the adoption effects had no bail on the
    // transition latch, so the collision above was reachable at all.
    const defer = app.slice(
      app.indexOf("function deferAdoptionUntilCockpitSettles()"),
      app.indexOf("function deferAdoptionUntilCockpitSettles()") + 400,
    );
    expect(defer).toContain("if (!sessionNavigationChanging.current) return undefined;");
    expect(defer).toContain("setCockpitSettleRetry(");
    // Both automatic adoptions consult it, and both can re-run once it clears.
    expect([...app.matchAll(/const deferred = deferAdoptionUntilCockpitSettles\(\);/gu)]).toHaveLength(2);
    expect([...app.matchAll(/cockpitSettleRetry\]\);/gu)]).toHaveLength(2);
  });
});
