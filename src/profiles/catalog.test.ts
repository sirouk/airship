import { describe, expect, it } from "vitest";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { BrowserGitClient } from "../git";
import { MemoryGitAdapter } from "../git/memory-adapter";
import { createAirshipToolRegistry } from "../tools/airship-tools";
import { MemoryWorkspace } from "../workspace/memory";
import { archiveProfileRevision, createBuiltInProfileCatalog, managedProfileRevisions } from "./catalog";
import { resolveProfileForSession, themeCssVariables } from "./domain";

describe("built-in Airship profiles", () => {
  it("resolves every profile into a pinned prompt, skill set, and semantic theme", async () => {
    const catalog = await createBuiltInProfileCatalog();
    expect(catalog.profiles.map((profile) => profile.profileId)).toEqual(["general", "research", "builder-systems"]);
    expect(catalog.profiles.map((profile) => ({
      profileId: profile.profileId,
      name: profile.name,
      themeId: profile.theme.themeId,
    }))).toEqual([
      { profileId: "general", name: "General", themeId: "foundry" },
      { profileId: "research", name: "Research", themeId: "verdigris" },
      { profileId: "builder-systems", name: "Developer", themeId: "blue-ledger" },
    ]);
    expect(new Set(catalog.profiles.map((profile) => profile.theme.themeId)).size).toBe(catalog.profiles.length);
    expect(new Set(catalog.themes.map((theme) => theme.digest)).size).toBe(catalog.themes.length);

    for (const profile of catalog.profiles) {
      const theme = catalog.themes.find((candidate) => candidate.digest === profile.theme.digest);
      expect(theme).toBeDefined();
      const pin = await resolveProfileForSession({
        profile,
        theme: theme!,
        skills: catalog.skills,
        globalSkills: catalog.globalSkills,
      });
      expect(pin.profile.profileId).toBe(profile.profileId);
      expect(pin.systemPrompt).toContain(profile.systemPrompt);
      expect(pin.resolutionDigest).toMatch(/^sha256:/u);
      expect(pin.workspaceBinding).toEqual({ kind: "active-workspace" });
      expect(["session", "profile", "workspace"]).toContain(pin.memoryScope);
      expect(["ask-first", "auto-approve", "full-access"]).toContain(pin.approvalMode);
      expect(Object.keys(themeCssVariables(theme!))).toHaveLength(9);
    }
  });

  it("requires only tool names implemented by the composed edge registry", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const required = catalog.skills.flatMap((skill) => skill.requiredTools);
    const workspace = new MemoryWorkspace();
    const git = new BrowserGitClient(await MemoryGitAdapter.create([{
      id: "profile-contract",
      name: "Profile contract",
      files: { "README.md": "profile tool contract" },
    }]));
    const tools = await createAirshipToolRegistry({
      workspace,
      git,
      journal: new EventJournal(new MemoryJournalBackend()),
    });
    const available = new Set(tools.definitions().map((tool) => tool.name));
    expect(required.length).toBeGreaterThan(3);
    for (const name of required) expect(available.has(name), name).toBe(true);
  });

  it("archives profiles from new work without stranding immutable historical revisions", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const archived = archiveProfileRevision(catalog, "research");
    expect(managedProfileRevisions(archived).map((profile) => profile.profileId)).toEqual(["general", "builder-systems"]);
    expect(archived.profiles.find((profile) => profile.profileId === "research")).toBe(catalog.profiles[1]);
    expect(() => archiveProfileRevision(archiveProfileRevision(archived, "builder-systems"), "general")).toThrow(/retain at least one/u);
  });
});
