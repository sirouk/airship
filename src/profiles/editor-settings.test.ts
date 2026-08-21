import { describe, expect, it } from "vitest";
import { WorkspaceRootKey } from "../storage/encrypted-envelope";
import { MemoryObjectStore } from "../storage/memory-object-store.test-support";
import { DEFAULT_CODE_THEME_ID, resolveCodeTheme } from "./code-themes";
import { createBuiltInProfileCatalog, profileCodeThemeId, setProfileCodeTheme } from "./catalog";
import { EncryptedProfileCatalogStore, validateProfileCatalog } from "./persistence";

/**
 * The editor theme is carried by the agent, not by the browser tab.
 *
 * The cheap version of "auto-saved" is the session-scoped workbench record the
 * workbench already writes for its open tabs and rail width. It satisfies the
 * word and fails the sentence: the owner asked for a default that belongs to
 * the profile, so switching profiles has to switch the sheet and a reload on
 * an adopted Vault has to bring the choice back.
 */
describe("an editor theme belongs to a profile", () => {
  it("answers with nothing until a profile chooses, which the editor reads as the default", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const [first] = catalog.profiles;
    expect(profileCodeThemeId(catalog, first!.profileId)).toBeUndefined();
    expect(resolveCodeTheme(profileCodeThemeId(catalog, first!.profileId)).codeThemeId).toBe(DEFAULT_CODE_THEME_ID);
  });

  it("keeps one profile's choice out of another's", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const [first, second] = catalog.profiles;
    const chosen = setProfileCodeTheme(catalog, first!.profileId, "gruvbox-dark");
    expect(profileCodeThemeId(chosen, first!.profileId)).toBe("gruvbox-dark");
    expect(profileCodeThemeId(chosen, second!.profileId)).toBeUndefined();
  });

  it("mints no profile revision — a colour is not a pinned manifest", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const chosen = setProfileCodeTheme(catalog, catalog.profiles[0]!.profileId, "nord");
    expect(chosen.profiles).toBe(catalog.profiles);
    expect(chosen.themes).toBe(catalog.themes);
  });

  it("returns identity when the choice is already the stored one", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const chosen = setProfileCodeTheme(catalog, catalog.profiles[0]!.profileId, "nord");
    // Identity is what lets the catalog transaction skip a generation bump.
    expect(setProfileCodeTheme(chosen, catalog.profiles[0]!.profileId, "nord")).toBe(chosen);
  });

  /*
   * Shape, not membership. The boot-path catalog cannot name the palette table
   * without dragging six colour tables into the eager bundle, and refusing an
   * unknown id here would also refuse a palette a later release wrote — the
   * one case the whole forward-compatibility rule exists to survive.
   */
  it("refuses an id that is not an id", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const profileId = catalog.profiles[0]!.profileId;
    expect(() => setProfileCodeTheme(catalog, profileId, "")).toThrow(/usable editor theme id/u);
    expect(() => setProfileCodeTheme(catalog, profileId, "Nord Light!")).toThrow(/usable editor theme id/u);
    expect(() => setProfileCodeTheme(catalog, profileId, "x".repeat(65))).toThrow(/usable editor theme id/u);
  });

  it("survives the encrypted Vault round trip", async () => {
    const objectStore = new MemoryObjectStore();
    const { key } = await WorkspaceRootKey.generate();
    const writer = new EncryptedProfileCatalogStore(objectStore, key);
    const builtIn = await createBuiltInProfileCatalog();
    const first = (await writer.initialize(builtIn)).checkpoint;
    const profileId = builtIn.profiles[0]!.profileId;

    await writer.commit(first, setProfileCodeTheme(builtIn, profileId, "tokyo-night"));

    const reader = new EncryptedProfileCatalogStore(objectStore, key);
    const reloaded = await reader.load();
    expect(profileCodeThemeId(reloaded!.catalog, profileId)).toBe("tokyo-night");
  });
});

describe("a persisted editor preference is validated, not trusted", () => {
  it("keeps an id this build has never heard of rather than refusing the catalog", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const profileId = catalog.profiles[0]!.profileId;
    const decoded = await validateProfileCatalog(JSON.parse(JSON.stringify({
      ...catalog,
      editorSettings: { [profileId]: { codeThemeId: "a-palette-from-2027" } },
    })));
    // Stored verbatim so returning to the newer build restores the choice…
    expect(decoded.editorSettings?.[profileId]?.codeThemeId).toBe("a-palette-from-2027");
    // …while this build still renders something.
    expect(resolveCodeTheme(profileCodeThemeId(decoded, profileId)).codeThemeId).toBe(DEFAULT_CODE_THEME_ID);
  });

  it("drops an entry whose profile the catalog no longer retains", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const decoded = await validateProfileCatalog(JSON.parse(JSON.stringify({
      ...catalog,
      editorSettings: { "profile-that-was-deleted": { codeThemeId: "nord" } },
    })));
    expect(decoded.editorSettings).toEqual({});
  });

  it("rejects a malformed entry rather than persisting a shape nothing can read", async () => {
    const catalog = await createBuiltInProfileCatalog();
    const profileId = catalog.profiles[0]!.profileId;
    await expect(validateProfileCatalog(JSON.parse(JSON.stringify({
      ...catalog,
      editorSettings: { [profileId]: { codeThemeId: 17 } },
    })))).rejects.toThrow(/invalid theme/u);
  });
});
