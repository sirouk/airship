import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The two overlays that ship in their own chunk. There is no DOM in this
 * suite, so what is asserted here is the source the browser gets: the
 * behaviour these lines encode is checked in `e2e/preferences-reset.spec.ts`,
 * and this is the half that fails in a second rather than in a browser run.
 */
const source = readFileSync(new URL("./platform-overlays.tsx", import.meta.url), "utf8");

describe("Preferences reset", () => {
  it("keeps the storage destination the reader chose", () => {
    /*
     * The host's `onChange` is not a state write. A `vaultBackend` that differs
     * from the current one runs `changeVaultProvider`, which releases the
     * current authority — `vault.disconnect()` — and re-adopts the runtime into
     * page memory. So `onChange(DEFAULT_PREFERENCES)` made "Reset preferences"
     * detach a connected Local Device vault and print "Ephemeral mode · page
     * memory only" on any build whose default backend is a different one, which
     * is the exact opposite of the sentence the reader just agreed to.
     */
    const confirm = source.match(/onConfirm=\{\(\) => \{[\s\S]*?\}\}/u)?.[0] ?? "";
    expect(confirm).toContain("onChange(Object.freeze({ ...DEFAULT_PREFERENCES, vaultBackend: value.vaultBackend }))");
    expect(confirm).not.toContain("onChange(DEFAULT_PREFERENCES)");
  });

  it("promises only what the reset actually does", () => {
    // Both sentences are read in one breath, so they may not contradict each
    // other: durability is the vault, and a dialog cannot reset it in its first
    // sentence and leave it untouched in its second.
    const body = source.slice(source.indexOf('title="Reset preferences?"'));
    expect(body).toContain("Display and legacy approval preferences return to their defaults.");
    expect(body).not.toContain("Display, durability, and legacy approval preferences");
    expect(body).toContain("conversations, profiles, vault, and workspaces are not touched");
    // And it names where durability is changed instead, rather than leaving the
    // reader to find the row on their own.
    expect(body).toContain("Durability stays where you set it");
  });
});
