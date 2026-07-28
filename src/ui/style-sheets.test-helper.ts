import { readFile } from "node:fs/promises";

/**
 * `styles.css` is an `@import` barrel, so reading it no longer reads the
 * cascade. The contract tests assert on the cascade — "does the rail rule that
 * wins actually say this" — not on a filename, so they read the barrel's own
 * members, concatenated in barrel order. That is the same text, in the same
 * order, that the browser resolves the barrel to.
 *
 * Only the sheets the barrel owns are listed. `platform-shell.css`,
 * `model-picker.css` and `menu-select.css` are imported by the barrel too, but
 * they are separate artifacts that individual tests read (and make negative
 * assertions about) by name, so folding them in here would silently widen
 * every `not.toContain` in the suite.
 */
export const AIRSHIP_BARREL_SHEETS = Object.freeze([
  "./tokens.css",
  "./shell.css",
  "./chat.css",
  "./routes.css",
] as const);

export async function readAirshipStyles(): Promise<string> {
  const sheets = await Promise.all(AIRSHIP_BARREL_SHEETS.map(async (name) =>
    readFile(new URL(name, import.meta.url), "utf8")));
  return sheets.join("\n");
}
