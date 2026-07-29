import { describe, expect, it } from "vitest";
import { createBuiltInProfileCatalog, reconcileBuiltInSkills, type ProfileCatalog } from "./catalog";
import { createProfileRevision, createSkillRevision, type SkillRevision } from "./domain";
import {
  MemoryProfileCatalogStore,
  validateProfileCatalog,
  type ProfileCatalogCheckpoint,
} from "./persistence";
import { reconcileAdoptedProfileCatalog } from "../vault/runtime-adoption";

/** A catalog as an older release would have written it: no `delivery-loop`. */
async function olderReleaseCatalog(extraSkills: readonly SkillRevision[] = []): Promise<ProfileCatalog> {
  const current = await createBuiltInProfileCatalog();
  const profiles = await Promise.all(current.profiles.map((profile) => createProfileRevision({
    ...profile,
    skillModes: Object.fromEntries(
      Object.entries(profile.skillModes).filter(([skillId]) => skillId !== "delivery-loop"),
    ),
  })));
  return Object.freeze({
    ...current,
    skills: Object.freeze([
      ...current.skills.filter((skill) => skill.skillId !== "delivery-loop"),
      ...extraSkills,
    ]),
    profiles: Object.freeze(profiles),
  });
}

describe("adopted catalogs receive the skills this release ships", () => {
  it("adds the missing built-in without disturbing anything the reader owns", async () => {
    const custom = await createSkillRevision({
      skillId: "house-style",
      name: "House style",
      description: "A skill this build has never heard of.",
      systemPrompt: "Follow the house style.",
      promptOrder: 60,
    });
    const persisted = await olderReleaseCatalog([custom]);
    const reconciled = reconcileBuiltInSkills(persisted, await createBuiltInProfileCatalog());

    expect(reconciled.skills.map((skill) => skill.skillId).sort()).toEqual([
      "concise-handoff",
      "delivery-loop",
      "evidence-first",
      "house-style",
      "memory-gardener",
      "source-reviewer",
      "workspace-steward",
    ]);
    // Nothing the reader authored or chose is rewritten: profile revisions are
    // content digests, so byte-identity here is the whole guarantee.
    expect(reconciled.profiles.map((profile) => profile.revision))
      .toEqual(persisted.profiles.map((profile) => profile.revision));
    expect(reconciled.globalSkills).toEqual(persisted.globalSkills);
    expect(reconciled.themes).toEqual(persisted.themes);
    expect(reconciled.skills.find((skill) => skill.skillId === "house-style")).toEqual(custom);
    await expect(validateProfileCatalog(JSON.parse(JSON.stringify(reconciled)) as unknown)).resolves.toBeTruthy();
  });

  it("returns the catalog unchanged when the shipped set is already present", async () => {
    const current = await createBuiltInProfileCatalog();
    // Identity, not equality: this is what lets adoption skip a generation bump.
    expect(reconcileBuiltInSkills(current, current)).toBe(current);
  });

  it("replaces a built-in whose shipped content changed, and only that one", async () => {
    const current = await createBuiltInProfileCatalog();
    const stale = await createSkillRevision({
      ...current.skills.find((skill) => skill.skillId === "concise-handoff")!,
      systemPrompt: "An earlier release's wording.",
    });
    const persisted = Object.freeze({
      ...current,
      skills: Object.freeze(current.skills.map((skill) => skill.skillId === "concise-handoff" ? stale : skill)),
    });

    const reconciled = reconcileBuiltInSkills(persisted, current);
    expect(reconciled.skills.find((skill) => skill.skillId === "concise-handoff")?.digest)
      .toBe(current.skills.find((skill) => skill.skillId === "concise-handoff")?.digest);
    expect(reconciled.skills.filter((skill) => skill.skillId !== "concise-handoff"))
      .toEqual(current.skills.filter((skill) => skill.skillId !== "concise-handoff"));
  });

  it("commits the union as an ordinary generation bump", async () => {
    const store = new MemoryProfileCatalogStore();
    const { checkpoint } = await store.initialize(await olderReleaseCatalog());
    const reconciled = await reconcileAdoptedProfileCatalog(store, checkpoint);

    expect(reconciled.generation).toBe(checkpoint.generation + 1);
    expect(reconciled.digest).not.toBe(checkpoint.digest);
    expect(reconciled.catalog.skills.some((skill) => skill.skillId === "delivery-loop")).toBe(true);
    expect((await store.load())?.digest).toBe(reconciled.digest);
    // A catalog that already carries the shipped set writes nothing at all.
    expect(await reconcileAdoptedProfileCatalog(store, reconciled)).toBe(reconciled);
  });

  it("leaves the reader with what they had when the authority refuses the write", async () => {
    const store = new MemoryProfileCatalogStore();
    const { checkpoint } = await store.initialize(await olderReleaseCatalog());
    const refusing = {
      ...store,
      commit: async (): Promise<ProfileCatalogCheckpoint> => { throw new Error("read-only authority"); },
      load: store.load.bind(store),
      initialize: store.initialize.bind(store),
      durability: store.durability,
    };

    // A missing skill card is not a reason to fail adoption and strand a
    // workspace; the next adoption retries the union.
    await expect(reconcileAdoptedProfileCatalog(refusing, checkpoint)).resolves.toBe(checkpoint);
  });
});
