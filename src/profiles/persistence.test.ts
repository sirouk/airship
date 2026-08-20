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

  it("admits exactly one concurrent page-memory commit from the same checkpoint", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const store = new MemoryProfileCatalogStore();
    const initial = (await store.initialize(catalog)).checkpoint;
    const outcomes = await Promise.allSettled([
      store.commit(initial, withGlobalSkill(catalog, "concise-handoff", true)),
      store.commit(initial, withGlobalSkill(catalog, "workspace-steward", true)),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: expect.any(ProfileCatalogConflictError) });
    const winner = fulfilled[0]!.value;
    await expect(store.load()).resolves.toMatchObject({
      generation: 2,
      digest: winner.digest,
      versionTag: winner.versionTag,
    });
  });

  it("publishes one generation-one page-memory catalog under concurrent initialization", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const alternate = withGlobalSkill(catalog, "concise-handoff", true);
    const store = new MemoryProfileCatalogStore();
    const results = await Promise.all([store.initialize(catalog), store.initialize(alternate)]);

    expect(results.map((result) => result.disposition).sort()).toEqual(["created", "existing"]);
    expect(results[0]!.checkpoint).toEqual(results[1]!.checkpoint);
    await expect(store.load()).resolves.toEqual(results[0]!.checkpoint);
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
      version: 3,
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

  it("loads immutable v1/v2 profile preimages and mints fieldless v3 children", async () => {
    const builtIn = await createBuiltInProfileCatalog();
    const legacyGeneral = Object.freeze({
      ...builtIn.profiles[0]!,
      version: 2 as const,
      minimumPosture: "local" as const,
      revision: "sha256:t5oNg4rLUH87vFCUy4w7rW7kTAlhpQP8cnihPz-0tHw" as const,
    });
    const legacyCatalog = Object.freeze({
      ...builtIn,
      profiles: Object.freeze([legacyGeneral, ...builtIn.profiles.slice(1)]),
    }) as unknown as ProfileCatalog;

    const validated = await validateProfileCatalog(legacyCatalog);
    expect(validated.profiles[0]).toMatchObject({ version: 2, revision: legacyGeneral.revision });
    expect(Object.hasOwn(validated.profiles[0]!, "minimumPosture")).toBe(true);

    const objectStore = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    await new EncryptedProfileCatalogStore(objectStore, key).initialize(legacyCatalog);
    const recovered = await new EncryptedProfileCatalogStore(objectStore, key).load();
    const historical = recovered?.catalog.profiles[0];
    expect(historical).toMatchObject({ version: 2, revision: legacyGeneral.revision });
    expect(Object.hasOwn(historical!, "minimumPosture")).toBe(true);

    const child = await createProfileRevision({
      ...historical!,
      version: 3,
      parentRevision: historical!.revision,
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    expect(child).toMatchObject({ version: 3, parentRevision: legacyGeneral.revision });
    expect(Object.hasOwn(child, "minimumPosture")).toBe(false);

    const tampered = structuredClone(legacyCatalog) as unknown as {
      profiles: Array<Record<string, unknown>>;
    };
    tampered.profiles[0]!.minimumPosture = "plaintext-remote";
    await expect(validateProfileCatalog(tampered)).rejects.toThrow("failed its revision check");
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
