import { describe, expect, it } from "vitest";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store.test-support";
import { createBuiltInProfileCatalog, type ProfileCatalog } from "./catalog";
import { createGlobalSkillSettings, createProfileRevision } from "./domain";
import {
  EncryptedProfileCatalogStore,
  MemoryProfileCatalogStore,
  ProfileCatalogConflictError,
  validateProfileCatalog,
} from "./persistence";

describe("profile catalog persistence", () => {
  it("keeps Ephemeral state page-local and generation-fences concurrent mutations", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const store = new MemoryProfileCatalogStore();
    const first = (await store.initialize(catalog)).checkpoint;
    const nextCatalog = withGlobalSkill(catalog, "workspace-steward", true);

    const second = await store.commit(first, nextCatalog);
    expect(second).toMatchObject({ generation: 2, catalog: { globalSkills: { "workspace-steward": true } } });
    await expect(store.commit(first, withGlobalSkill(catalog, "concise-handoff", true)))
      .rejects.toBeInstanceOf(ProfileCatalogConflictError);

    // A new page-memory adapter has no hidden localStorage/IndexedDB recovery.
    await expect(new MemoryProfileCatalogStore().load()).resolves.toBeUndefined();
  });

  it("round-trips profile, theme, and skill policy through an encrypted provider-neutral CAS head", async () => {
    const objectStore = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const firstClient = new EncryptedProfileCatalogStore(objectStore, key);
    const builtIn = await createBuiltInProfileCatalog();
    const first = (await firstClient.initialize(builtIn)).checkpoint;
    const current = builtIn.profiles[0]!;
    const revision = await createProfileRevision({
      ...current,
      parentRevision: current.revision,
      name: "Persistent Flight Director",
      createdAt: "2026-07-22T12:00:00.000Z",
    });
    const edited: ProfileCatalog = Object.freeze({
      ...builtIn,
      profiles: Object.freeze([revision, ...builtIn.profiles.slice(1)]),
      globalSkills: createGlobalSkillSettings({ ...builtIn.globalSkills, "concise-handoff": true }),
    });

    const committed = await firstClient.commit(first, edited);
    expect(committed.generation).toBe(2);
    const secondClient = new EncryptedProfileCatalogStore(objectStore, key);
    const recovered = await secondClient.load();
    expect(recovered).toMatchObject({ generation: 2, digest: committed.digest });
    expect(recovered?.catalog.profiles[0]?.name).toBe("Persistent Flight Director");
    expect(recovered?.catalog.globalSkills["concise-handoff"]).toBe(true);

    const serialized = (await Promise.all((await objectStore.list("state/profiles/v1/"))
      .map(async (entry) => new TextDecoder().decode((await objectStore.get(entry.key))!.bytes))))
      .join("\n");
    expect(serialized).not.toContain("Persistent Flight Director");
    expect(serialized).not.toContain("Evidence first");
    expect(serialized).not.toContain("builder-systems");
  });

  it("rejects stale Vault writers and never treats ciphertext as readable with another root key", async () => {
    const objectStore = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const writerA = new EncryptedProfileCatalogStore(objectStore, key);
    const writerB = new EncryptedProfileCatalogStore(objectStore, key);
    const builtIn = await createBuiltInProfileCatalog();
    const initial = (await writerA.initialize(builtIn)).checkpoint;
    const stale = await writerB.load();
    if (!stale) throw new Error("expected encrypted catalog");

    await writerA.commit(initial, withGlobalSkill(builtIn, "workspace-steward", true));
    await expect(writerB.commit(stale, withGlobalSkill(builtIn, "concise-handoff", true)))
      .rejects.toBeInstanceOf(ProfileCatalogConflictError);

    const { key: wrongKey } = await WorkspaceRootKey.generate();
    await expect(new EncryptedProfileCatalogStore(objectStore, wrongKey).load()).resolves.toBeUndefined();
    // Object names are keyed as well: a wrong root key cannot even select the catalog head.
  });

  it("rebuilds content-addressed members and rejects a tampered profile revision", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const tampered = structuredClone(catalog) as unknown as {
      profiles: Array<{ name: string; revision: string }>;
    };
    tampered.profiles[0]!.name = "Digest bypass attempt";
    await expect(validateProfileCatalog(tampered)).rejects.toThrow("failed its revision check");
  });
});

function withGlobalSkill(catalog: ProfileCatalog, skillId: string, enabled: boolean): ProfileCatalog {
  return Object.freeze({
    ...catalog,
    globalSkills: createGlobalSkillSettings({ ...catalog.globalSkills, [skillId]: enabled }),
  });
}
