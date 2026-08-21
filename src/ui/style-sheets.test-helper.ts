import { readFile } from "node:fs/promises";

/**
 * Browser-equivalent order for every member of the `styles.css` barrel.
 * Contract tests that inspect the cascade must see the same sheets and source
 * order as the app; omitting a live member can make a negative assertion pass
 * while the shipped selector still exists.
 */
export const AIRSHIP_BARREL_SHEETS = Object.freeze([
  "./platform-shell.css",
  "./menu-select.css",
  "./tokens.css",
  "./shell.css",
  "./chat.css",
  "./routes.css",
  "./durability-indicator.css",
  "./popover.css",
  "./search-field.css",
] as const);

export async function readAirshipStyles(): Promise<string> {
  const sheets = await Promise.all(AIRSHIP_BARREL_SHEETS.map(async (name) =>
    readFile(new URL(name, import.meta.url), "utf8")));
  return sheets.join("\n");
}
