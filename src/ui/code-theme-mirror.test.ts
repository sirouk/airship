import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CODE_THEMES, DEFAULT_CODE_THEME_ID, resolveCodeTheme } from "../profiles/code-themes";
import {
  CODE_THEME_MIRROR_KEY,
  CODE_THEME_MIRROR_LIMIT,
  codeThemeMirrorDigest,
  readMirroredCodeTheme,
  writeMirroredCodeTheme,
} from "./code-theme-mirror";

/**
 * The measured defect, in one sentence: pick Nord, reload, get One Dark Pro.
 *
 * Verified live at 1440x900 with no Vault adopted before this module existed —
 * and verified the other way after it. The shell's own theme, colour mode,
 * density and body font all came back from `airship.display-preferences.v1` on
 * the same reload, so the editor palette was the single display preference
 * that did not survive, which reads as a bug rather than as a policy.
 */
function memoryStorage(seed: Record<string, string> = {}): Storage & { readonly entries: Record<string, string> } {
  const entries: Record<string, string> = { ...seed };
  return {
    entries,
    get length() { return Object.keys(entries).length; },
    clear() { for (const key of Object.keys(entries)) delete entries[key]; },
    getItem: (key: string) => entries[key] ?? null,
    key: (index: number) => Object.keys(entries)[index] ?? null,
    removeItem: (key: string) => { delete entries[key]; },
    setItem: (key: string, value: string) => { entries[key] = value; },
  };
}

/** The shape `app.tsx` mints: a slug of the profile's *name*, plus six hex. */
const NAMED_PROFILE_ID = "acme-legal-discovery-a1b2c3";

describe("an editor palette survives a reload without a Vault", () => {
  it("returns the palette the previous page wrote", async () => {
    const storage = memoryStorage();
    await writeMirroredCodeTheme(NAMED_PROFILE_ID, "nord", storage);
    // A reload is a new page reading the same origin storage; nothing else
    // crosses that boundary when the catalog is `MemoryProfileCatalogStore`.
    expect(await readMirroredCodeTheme(NAMED_PROFILE_ID, memoryStorage(storage.entries))).toBe("nord");
  });

  it("keeps one profile's sheet out of another's", async () => {
    const storage = memoryStorage();
    await writeMirroredCodeTheme(NAMED_PROFILE_ID, "gruvbox-dark", storage);
    expect(await readMirroredCodeTheme("research", storage)).toBeUndefined();
  });

  it("says nothing for a profile that has never chosen", async () => {
    expect(await readMirroredCodeTheme("general", memoryStorage())).toBeUndefined();
  });
});

describe("the mirror cannot name anyone", () => {
  /*
   * Profile ids are not opaque: `app.tsx` mints them as
   * `${slugIdentifier(source.name)}-${randomUuid().slice(0, 6)}`. Writing one
   * into `localStorage` puts a profile *name* on the device in plaintext —
   * user content, and exactly what the ephemeral catalog exists to prevent.
   */
  it("writes neither the profile id nor any word of the profile name", async () => {
    const storage = memoryStorage();
    await writeMirroredCodeTheme(NAMED_PROFILE_ID, "tokyo-night", storage);
    const written = JSON.stringify(storage.entries);
    expect(written).not.toContain(NAMED_PROFILE_ID);
    for (const word of ["acme", "legal", "discovery"]) expect(written.toLowerCase()).not.toContain(word);
    // What it *does* contain: the palette id, which is one of six strings this
    // build ships and names nobody.
    expect(written).toContain("tokyo-night");
  });

  it("keys by a digest, so the same profile is recognised and no other is", async () => {
    const digest = await codeThemeMirrorDigest(NAMED_PROFILE_ID);
    expect(digest).toMatch(/^[0-9a-f]{16}$/u);
    expect(digest).not.toBe(await codeThemeMirrorDigest(`${NAMED_PROFILE_ID}x`));
    expect(digest).toBe(await codeThemeMirrorDigest(NAMED_PROFILE_ID));
  });

  it("bounds how many profiles it remembers", async () => {
    const storage = memoryStorage();
    for (let index = 0; index <= CODE_THEME_MIRROR_LIMIT + 8; index += 1) {
      await writeMirroredCodeTheme(`profile-${String(index)}`, "nord", storage);
    }
    const stored: unknown = JSON.parse(storage.entries[CODE_THEME_MIRROR_KEY] ?? "null");
    expect(Array.isArray(stored) && stored.length).toBe(CODE_THEME_MIRROR_LIMIT);
    // Most-recent-first, so the profile just used is the one that survives.
    expect(await readMirroredCodeTheme(`profile-${String(CODE_THEME_MIRROR_LIMIT + 8)}`, storage)).toBe("nord");
    expect(await readMirroredCodeTheme("profile-0", storage)).toBeUndefined();
  });
});

describe("what comes back out is validated, not trusted", () => {
  /*
   * Anything running on this origin can write this key, and the value reaches
   * a `data-code-theme` attribute and a custom-property lookup. An unvalidated
   * read is an injection surface, not merely a wrong colour.
   */
  it("drops a value that is not a palette this build ships", async () => {
    const digest = await codeThemeMirrorDigest("general");
    for (const hostile of ["</style><script>", "one-dark-pro; --accent: red", "a-palette-from-2027"]) {
      const storage = memoryStorage({ [CODE_THEME_MIRROR_KEY]: JSON.stringify([[digest, hostile]]) });
      expect(await readMirroredCodeTheme("general", storage)).toBeUndefined();
    }
  });

  it("survives a key that is not JSON, or not the shape it expects", async () => {
    for (const junk of ["{", "null", '"nord"', "[1,2,3]", '[["short"]]']) {
      const storage = memoryStorage({ [CODE_THEME_MIRROR_KEY]: junk });
      expect(await readMirroredCodeTheme("general", storage)).toBeUndefined();
    }
  });

  it("refuses to write a palette it does not ship", async () => {
    const storage = memoryStorage();
    await writeMirroredCodeTheme("general", "a-palette-from-2027", storage);
    expect(storage.entries[CODE_THEME_MIRROR_KEY]).toBeUndefined();
  });

  it("accepts every palette that is shipped, without naming one here", async () => {
    // Discovered from the table, not listed: a seventh palette must not need an
    // edit to this file to become storable.
    for (const theme of CODE_THEMES) {
      const storage = memoryStorage();
      await writeMirroredCodeTheme("general", theme.codeThemeId, storage);
      expect(await readMirroredCodeTheme("general", storage)).toBe(theme.codeThemeId);
    }
  });
});

describe("the catalog is the authority; this is the fallback", () => {
  /*
   * The ordering lives in `workspace-view.tsx` and is asserted at its source,
   * because a Vault-backed catalog is durable, encrypted and portable between
   * devices — and must never be overruled by a value one browser remembers.
   */
  it("is consulted only when the catalog has no answer", async () => {
    const source = await readFile(new URL("./workspace-view.tsx", import.meta.url), "utf8");
    expect(source).toContain("const codeTheme = resolveCodeTheme(codeThemeId ?? mirroredCodeThemeId);");
    expect(source).toContain("if (codeThemeId) return;");
  });

  it("resolves a divergent pair to the catalog's choice", () => {
    // The shape of the expression above, exercised: the Vault says Gruvbox,
    // this browser remembers Nord, and the sheet is Gruvbox.
    const sheet = (fromCatalog: string | undefined, fromMirror: string | undefined) =>
      resolveCodeTheme(fromCatalog ?? fromMirror).codeThemeId;
    expect(sheet("gruvbox-dark", "nord")).toBe("gruvbox-dark");
    expect(sheet(undefined, "nord")).toBe("nord");
    expect(sheet(undefined, undefined)).toBe(DEFAULT_CODE_THEME_ID);
  });
});
