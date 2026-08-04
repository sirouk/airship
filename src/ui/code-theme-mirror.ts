import { isKnownCodeThemeId } from "../profiles/code-themes";

/**
 * A device-side echo of the editor palette, keyed so it cannot name anyone.
 *
 * ## Why this exists at all
 *
 * `editorSettings` lives in the profile catalog, and without an adopted Vault
 * that catalog is `MemoryProfileCatalogStore` — durability `"ephemeral"`, and
 * deliberately without a browser persistence side channel, because profile
 * content (names, descriptions, system prompts) must never land unencrypted.
 * The consequence shipped as a bug: the shell's own theme, colour mode, density
 * and body font all survive a reload from `airship.display-preferences.v1`, and
 * the *editor's* palette was the one display preference that did not. Pick
 * Nord, reload, get One Dark Pro. Nothing in the product explains that
 * asymmetry, so it reads as broken rather than as principled.
 *
 * A syntax palette is a display preference of exactly the class `mode` and
 * `bodyFont` already are — six shipped ids, no user text in any of them — so it
 * may persist device-side under the same rule they do.
 *
 * ## Why the key is a digest
 *
 * Profile ids are *not* opaque. `app.tsx` mints them as
 * `${slugIdentifier(name)}-${randomUuid().slice(0, 6)}`, so a profile named
 * "Acme Legal Discovery" has the id `acme-legal-discovery-a1b2c3`. Writing raw
 * ids into `localStorage` would put profile *names* in plaintext on the device
 * — the precise thing the ephemeral catalog exists to prevent, leaked through
 * the back door by a colour preference. The key is therefore a SHA-256 digest
 * of the id: enough to recognise the same profile on the next page load, and
 * nothing anyone can read a name out of.
 *
 * ## What this is not
 *
 * It is a fallback, never a second source of truth. The catalog is asked first
 * and always wins when it answers, so a Vault-backed catalog — which is
 * durable, encrypted and portable between devices — is never overridden by a
 * stale value one browser happens to remember.
 */
export const CODE_THEME_MIRROR_KEY = "airship.editor-theme.v1";

/**
 * How many profiles the mirror remembers.
 *
 * Unbounded growth in `localStorage` is a quota fault waiting for the busiest
 * user, and the value of remembering the 25th-least-recently-used profile's
 * palette is nil. Entries are most-recent-first and the tail is dropped.
 */
export const CODE_THEME_MIRROR_LIMIT = 24;

/** Hex characters of SHA-256 retained per key. 16 is 64 bits of collision space. */
const DIGEST_LENGTH = 16;

type MirrorEntry = readonly [digest: string, codeThemeId: string];

/**
 * SHA-256 of the profile id, truncated, hex.
 *
 * `crypto.subtle` is the only digest in the platform and it is async, which is
 * why every function here is. That is not a cost worth engineering around: the
 * read happens once per profile per page, off the first-paint path, behind the
 * editor's own lazy chunk.
 */
export async function codeThemeMirrorDigest(profileId: string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(profileId));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, DIGEST_LENGTH);
}

/**
 * The palette this device last saw for this profile, if it is one we ship.
 *
 * Validated against the shipped table on the way out, not just on the way in.
 * Anything on the origin can write this key, and the value is interpolated into
 * a `data-code-theme` attribute and used to look up CSS custom properties — an
 * unvalidated read is an injection surface, not merely a wrong colour. An
 * unknown id is dropped rather than passed through: unlike the catalog, which
 * preserves a future release's id so returning to that release restores the
 * choice, this mirror is a device convenience with nothing to preserve.
 */
export async function readMirroredCodeTheme(
  profileId: string,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): Promise<string | undefined> {
  if (!storage) return undefined;
  const digest = await codeThemeMirrorDigest(profileId);
  if (!digest) return undefined;
  const found = readEntries(storage).find((entry) => entry[0] === digest);
  return found && isKnownCodeThemeId(found[1]) ? found[1] : undefined;
}

/**
 * Remember this profile's palette on this device, most-recent-first.
 *
 * Silent on failure by design: Safari private mode and a full quota both throw
 * from `setItem`, and neither is a reason to interrupt someone who just picked
 * a colour. The catalog write is the one that reports.
 */
export async function writeMirroredCodeTheme(
  profileId: string,
  codeThemeId: string,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = defaultStorage(),
): Promise<void> {
  if (!storage || !isKnownCodeThemeId(codeThemeId)) return;
  const digest = await codeThemeMirrorDigest(profileId);
  if (!digest) return;
  const entries: MirrorEntry[] = [
    [digest, codeThemeId],
    ...readEntries(storage).filter((entry) => entry[0] !== digest),
  ];
  try {
    storage.setItem(CODE_THEME_MIRROR_KEY, JSON.stringify(entries.slice(0, CODE_THEME_MIRROR_LIMIT)));
  } catch { /* The palette stays live for this page; the catalog is the record. */ }
}

function readEntries(storage: Pick<Storage, "getItem">): readonly MirrorEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CODE_THEME_MIRROR_KEY) ?? "null");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): MirrorEntry[] => Array.isArray(entry)
      && typeof entry[0] === "string"
      && typeof entry[1] === "string"
      ? [[entry[0], entry[1]]]
      : []).slice(0, CODE_THEME_MIRROR_LIMIT);
  } catch { return []; }
}

function defaultStorage(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}
