import { describe, expect, it } from "vitest";
import {
  archiveProfileRevision,
  createBuiltInProfileCatalog,
  reconcileBuiltInSkills,
  removeAuthoredSkill,
  skillReferences,
  upsertAuthoredSkill,
  type ProfileCatalog,
} from "./catalog";
import {
  MAX_CATALOG_SKILLS,
  createProfileRevision,
  createSkillRevision,
  resolveProfileForSession,
  type SkillMode,
} from "./domain";
import { validateProfileCatalog } from "./persistence";

async function authored(skillId = "custom.house-style") {
  return createSkillRevision({
    skillId,
    name: "House style",
    description: "A skill the person wrote.",
    systemPrompt: "Write in the house voice.",
    promptOrder: 60,
  });
}

/** What `setProfileSkill` in `app.tsx` commits, restated so this file can drive it. */
function withProfileSkillMode(
  catalog: ProfileCatalog,
  profileId: string,
  skillId: string,
  mode: SkillMode,
): Promise<ProfileCatalog> {
  const profile = catalog.profiles.find((candidate) => candidate.profileId === profileId)!;
  const skillModes = { ...profile.skillModes };
  if (mode === "inherit") delete skillModes[skillId];
  else skillModes[skillId] = mode;
  return createProfileRevision({
    ...profile,
    version: 3,
    parentRevision: profile.revision,
    skillModes,
    createdAt: new Date().toISOString(),
  }).then((revision) => Object.freeze({
    ...catalog,
    profiles: Object.freeze(catalog.profiles.map((candidate) =>
      candidate.profileId === revision.profileId ? revision : candidate,
    )),
  }));
}

describe("authoring a skill", () => {
  it("creates, revises, and resolves an authored skill into a session prompt", async () => {
    const base = await createBuiltInProfileCatalog();
    const created = upsertAuthoredSkill(base, await authored());
    expect(created.skills.map((skill) => skill.skillId)).toContain("custom.house-style");

    const revised = upsertAuthoredSkill(created, await createSkillRevision({
      skillId: "custom.house-style",
      name: "House style",
      description: "A skill the person wrote.",
      systemPrompt: "Write in the house voice, and cite the source.",
      promptOrder: 60,
    }));
    expect(revised.skills).toHaveLength(created.skills.length);
    expect(revised.skills.find((skill) => skill.skillId === "custom.house-style")!.systemPrompt)
      .toContain("cite the source");

    // The point of the whole lane: the text reaches a composed prompt.
    const withMode = await withProfileSkillMode(revised, "general", "custom.house-style", "on");
    const profile = withMode.profiles.find((candidate) => candidate.profileId === "general")!;
    const pin = await resolveProfileForSession({
      profile,
      theme: withMode.themes.find((theme) => theme.themeId === profile.theme.themeId)!,
      skills: withMode.skills,
      globalSkills: withMode.globalSkills,
    });
    expect(pin.systemPrompt).toContain("Write in the house voice, and cite the source.");
  });

  it("re-validates through the persistence boundary the commit path uses", async () => {
    const created = upsertAuthoredSkill(await createBuiltInProfileCatalog(), await authored());
    const validated = await validateProfileCatalog(JSON.parse(JSON.stringify(created)));
    expect(validated.skills.map((skill) => skill.skillId)).toContain("custom.house-style");
  });

  it("returns the same catalog when the revision is byte-identical", async () => {
    const created = upsertAuthoredSkill(await createBuiltInProfileCatalog(), await authored());
    expect(upsertAuthoredSkill(created, await authored())).toBe(created);
  });

  it("refuses to author outside the custom namespace", async () => {
    const base = await createBuiltInProfileCatalog();
    // `evidence-first` is release-owned: `reconcileBuiltInSkills` replaces any
    // persisted copy whose digest drifts, so authoring here would be text the
    // next release silently discards.
    await expect(async () => upsertAuthoredSkill(base, await createSkillRevision({
      skillId: "evidence-first",
      name: "Mine now",
      description: "",
      systemPrompt: "Overwrite the built-in.",
    }))).rejects.toThrow(/custom\. namespace/u);
  });

  it("refuses a new skill past the one catalog ceiling", async () => {
    const base = await createBuiltInProfileCatalog();
    const filler = await Promise.all(
      Array.from({ length: MAX_CATALOG_SKILLS - base.skills.length }, (_unused, index) => createSkillRevision({
        skillId: `custom.filler-${String(index)}`,
        name: `Filler ${String(index)}`,
        description: "",
        systemPrompt: "Filler.",
      })),
    );
    const full = filler.reduce(upsertAuthoredSkill, base);
    expect(full.skills).toHaveLength(MAX_CATALOG_SKILLS);
    await expect(async () => upsertAuthoredSkill(full, await authored())).rejects.toThrow(/maximum of 512/u);
    // The ceiling that refuses is the ceiling that admits: before this lane
    // `persistence.ts` accepted 1_024 and every later boot threw out of
    // `resolveProfileForSession`.
    await expect(validateProfileCatalog(JSON.parse(JSON.stringify(full)))).resolves.toBeDefined();
  });
});

describe("removing an authored skill", () => {
  it("stays removable after a profile is set to on and back to inherit", async () => {
    // The defect both refuters found, from opposite ends: `setProfileSkill`
    // stored an explicit "inherit", `Object.hasOwn` counted it as a reference,
    // and Remove refused forever naming a profile that does not use the skill.
    const created = upsertAuthoredSkill(await createBuiltInProfileCatalog(), await authored());
    const on = await withProfileSkillMode(created, "general", "custom.house-style", "on");
    expect(skillReferences(on, "custom.house-style")).toEqual(["General"]);

    const back = await withProfileSkillMode(on, "general", "custom.house-style", "inherit");
    expect(Object.hasOwn(back.profiles.find((p) => p.profileId === "general")!.skillModes, "custom.house-style")).toBe(false);
    expect(skillReferences(back, "custom.house-style")).toEqual([]);

    const removed = await removeAuthoredSkill(back, "custom.house-style");
    expect(removed.skills.map((skill) => skill.skillId)).not.toContain("custom.house-style");
    // And the result is a catalog the commit path will accept. An orphan
    // `skillModes` or `globalSkills` key is a rejection here, not a default,
    // which is what made the dead state unrecoverable from inside the product.
    await expect(validateProfileCatalog(JSON.parse(JSON.stringify(removed)))).resolves.toBeDefined();
  });

  it("clears a legacy explicit inherit rather than committing a catalog that cannot validate", async () => {
    const created = upsertAuthoredSkill(await createBuiltInProfileCatalog(), await authored());
    const general = created.profiles.find((profile) => profile.profileId === "general")!;
    // Written the way the old `setProfileSkill` wrote it, and reachable no other
    // way now: an inert key, resolving exactly as its absence does.
    const withInertKey = Object.freeze({
      ...created,
      profiles: Object.freeze([
        await createProfileRevision({
          ...general,
          version: 3,
          parentRevision: general.revision,
          skillModes: { ...general.skillModes, "custom.house-style": "inherit" },
          createdAt: new Date().toISOString(),
        }),
        ...created.profiles.filter((profile) => profile.profileId !== "general"),
      ]),
    });
    expect(skillReferences(withInertKey, "custom.house-style")).toEqual([]);

    const removed = await removeAuthoredSkill(withInertKey, "custom.house-style");
    expect(Object.hasOwn(removed.profiles.find((p) => p.profileId === "general")!.skillModes, "custom.house-style")).toBe(false);
    await expect(validateProfileCatalog(JSON.parse(JSON.stringify(removed)))).resolves.toBeDefined();
  });

  it("drops the global setting so the catalog does not reference a missing skill", async () => {
    const created = upsertAuthoredSkill(await createBuiltInProfileCatalog(), await authored());
    const enabled = Object.freeze({
      ...created,
      globalSkills: Object.freeze({ ...created.globalSkills, "custom.house-style": true }),
    });
    const removed = await removeAuthoredSkill(enabled, "custom.house-style");
    expect(Object.hasOwn(removed.globalSkills, "custom.house-style")).toBe(false);
    await expect(validateProfileCatalog(JSON.parse(JSON.stringify(removed)))).resolves.toBeDefined();
  });

  it("names the profiles that would change before it removes anything", async () => {
    const created = upsertAuthoredSkill(await createBuiltInProfileCatalog(), await authored());
    const on = await withProfileSkillMode(created, "research", "custom.house-style", "off");
    await expect(removeAuthoredSkill(on, "custom.house-style")).rejects.toThrow(/Research still refer/u);
    expect(on.skills.map((skill) => skill.skillId)).toContain("custom.house-style");
  });

  it("does not refuse on behalf of an archived profile nobody can reach", async () => {
    // The same dead end in different clothes: the Skills scope selector is built
    // from `managedProfileRevisions`, so an archived profile cannot be listed or
    // set back to Inherit, and a refusal naming one would be unanswerable.
    const created = upsertAuthoredSkill(await createBuiltInProfileCatalog(), await authored());
    const decided = await withProfileSkillMode(created, "research", "custom.house-style", "on");
    const archived = archiveProfileRevision(decided, "research");
    expect(skillReferences(archived, "custom.house-style")).toEqual([]);

    const removed = await removeAuthoredSkill(archived, "custom.house-style");
    expect(Object.hasOwn(removed.profiles.find((p) => p.profileId === "research")!.skillModes, "custom.house-style")).toBe(false);
    expect(removed.archivedProfileIds).toContain("research");
    await expect(validateProfileCatalog(JSON.parse(JSON.stringify(removed)))).resolves.toBeDefined();
  });

  it("refuses to remove a built-in", async () => {
    const base = await createBuiltInProfileCatalog();
    await expect(removeAuthoredSkill(base, "evidence-first")).rejects.toThrow(/owned by the release/u);
  });
});

describe("the built-in set may not claim the authored namespace", () => {
  it("throws rather than letting a release replace a person's skill", async () => {
    const persisted = upsertAuthoredSkill(await createBuiltInProfileCatalog(), await authored());
    const hostile = Object.freeze({
      ...await createBuiltInProfileCatalog(),
      skills: Object.freeze([await createSkillRevision({
        skillId: "custom.house-style",
        name: "Shipped",
        description: "",
        systemPrompt: "Release-owned text.",
      })]),
    });
    // Without this the reconcile would silently swap the person's instruction
    // for the release's, with no record that theirs existed.
    expect(() => reconcileBuiltInSkills(persisted, hostile)).toThrow(/claims the authored custom\. namespace/u);
  });

  it("holds for the set this build actually ships", async () => {
    const builtIn = await createBuiltInProfileCatalog();
    expect(() => reconcileBuiltInSkills(builtIn, builtIn)).not.toThrow();
  });
});
