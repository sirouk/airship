import { describe, expect, it } from "vitest";
import { EventJournal } from "../core/journal";
import { MemoryJournalBackend } from "../core/memory-journal";
import { BrowserGitClient, MemoryGitAdapter } from "../git";
import { createAirshipToolRegistry } from "../tools/airship-tools";
import { MemoryWorkspace } from "../workspace/memory";
import { archiveProfileRevision, createBuiltInProfileCatalog, managedProfileRevisions } from "./catalog";
import { resolveProfileForSession, themeCssVariables } from "./domain";

describe("built-in Airship profiles", () => {
  it("resolves every profile into a pinned prompt, skill set, and semantic theme", async () => {
    const catalog = await createBuiltInProfileCatalog();
    expect(catalog.profiles.map((profile) => profile.profileId)).toEqual(["engineer", "researcher", "reviewer"]);
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
    const archived = archiveProfileRevision(catalog, "researcher");
    expect(managedProfileRevisions(archived).map((profile) => profile.profileId)).toEqual(["engineer", "reviewer"]);
    expect(archived.profiles.find((profile) => profile.profileId === "researcher")).toBe(catalog.profiles[1]);
    expect(() => archiveProfileRevision(archiveProfileRevision(archived, "reviewer"), "engineer")).toThrow(/retain at least one/u);
  });
});
