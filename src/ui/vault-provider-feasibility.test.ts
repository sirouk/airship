import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VAULT_BACKENDS, vaultBackendUnavailableReason } from "./platform-shell";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const vaultViewSource = readFileSync(new URL("./vault-view.tsx", import.meta.url), "utf8");
const changeVaultProvider = appSource.match(
  /async function changeVaultProvider\(next: VaultBackend\): Promise<void> \{[\s\S]*?\n  \}\n/u,
)?.[0] ?? "";

/*
 * A destination this build cannot open is not a description problem.
 *
 * `changeVaultProvider` releases the current authority *before* it opens the
 * next one, so offering Google Drive on a build with no client ID traded an
 * adopted Vault for a destination that could never be reached. One predicate
 * now answers for all three surfaces: the Vault selector, the Preferences
 * Durability row, and the switch itself.
 */
describe("unopenable vault destinations are not selectable", () => {
  it("names the reason for every destination this deployment cannot reach", () => {
    expect(vaultBackendUnavailableReason("google-drive", undefined)).toContain("no Google OAuth client ID");
    expect(vaultBackendUnavailableReason("local-lab", undefined, { hostname: "airship.example" }))
      .toContain("loopback origin");
    for (const backend of ["local-device", "ephemeral"] as const) {
      expect(vaultBackendUnavailableReason(backend, undefined, { hostname: "airship.example" })).toBeUndefined();
    }
    expect(VAULT_BACKENDS).toContain("google-drive");
  });

  it("refuses the switch before any authority is released", () => {
    expect(changeVaultProvider).toContain("vaultBackendUnavailableReason(");
    const guard = changeVaultProvider.indexOf("const unopenable = vaultBackendUnavailableReason(");
    expect(guard).toBeGreaterThan(-1);
    // Everything that ends the current Vault's authority — the publication
    // abort, the switching latch, `transitionVaultProvider` with its
    // `adoptEphemeralRuntime`/`disconnectAuthority`/`commitPreference` — has to
    // come after the feasibility question, or the guard is decoration.
    for (const release of [
      "vaultContextPublication.current?.abort",
      "vaultProviderSwitchingRef.current = true",
      "transitionVaultProvider({",
      "adoptEphemeralRuntime",
      "disconnectAuthority",
      "commitPreference",
    ]) {
      expect(changeVaultProvider.indexOf(release)).toBeGreaterThan(guard);
    }
    expect(changeVaultProvider.slice(guard)).toContain("The current Vault was left attached.");
  });

  it("greys the same destinations in the Vault selector instead of describing them as prose", () => {
    expect(vaultViewSource).toContain("const unopenable = providerUnopenableReason(profile.id);");
    expect(vaultViewSource).toContain("...(unopenable ? { disabled: true } : {}),");
    // The old suffix made an unreachable destination read as a live choice.
    expect(vaultViewSource).not.toContain("— unavailable in this build");
  });

  it("keeps the Preferences Durability row on the same predicate", () => {
    const platformShell = readFileSync(new URL("./platform-shell.tsx", import.meta.url), "utf8");
    const durability = platformShell.match(/export function durabilityOptions\([\s\S]*?\n\}\n/u)?.[0] ?? "";
    expect(durability).toContain("vaultBackendUnavailableReason(");
    expect(durability).toContain("...(reason ? { disabled: true } : {}),");
  });
});
