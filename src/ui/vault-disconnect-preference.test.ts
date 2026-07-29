import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { transitionVaultProvider } from "./vault-provider-transition";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const disconnect = source.match(
  /async function disconnectVaultSafely\(\): Promise<void> \{[\s\S]*?\n  \}\n/u,
)?.[0] ?? "";
const localDeviceAutoOpen = source.match(
  /\/\/ Local Device is a durable, offline authority\.[\s\S]*?\n  \}, \[/u,
)?.[0] ?? "";

/*
 * "Switch to ephemeral · keep a page copy" used to be undone a frame later.
 *
 * Releasing the authority changed the runtime but not the preference, and the
 * preference is the only representation of "the user wants Local Device open".
 * The auto-open effect therefore read the post-disconnect state as "selected
 * but not yet open" and re-adopted the Vault that had just been detached.
 */
describe("detaching a Vault commits the destination it detached to", () => {
  it("releases first and only then names page memory as the destination", async () => {
    let storageId = "vault+local-device://workspace";
    const order: string[] = [];
    await transitionVaultProvider({
      current: "local-device",
      next: "ephemeral",
      runtimeUsesVault: () => storageId.startsWith("vault+"),
      adoptEphemeralRuntime: async () => { order.push("adopt"); storageId = "memory://airship-page"; },
      disconnectAuthority: () => order.push("disconnect"),
      commitPreference: (provider) => order.push(`preference:${provider}`),
    });
    expect(order).toEqual(["adopt", "disconnect", "preference:ephemeral"]);
    expect(storageId).toBe("memory://airship-page");
  });

  it("routes the disconnect through that same transition instead of a bare release", () => {
    expect(disconnect).toContain('next: "ephemeral"');
    expect(disconnect).toContain("transitionVaultProvider({");
    expect(disconnect).toContain('vaultBackend: provider');
    // The one case the transition declines: it is already page memory, so
    // there is no preference to move and the release has to be issued directly.
    expect(disconnect).toContain('if (preferences.vaultBackend === "ephemeral")');
    expect(disconnect).toContain("await releaseVaultAuthority(release)");
    expect(disconnect).toContain("setVaultSetupOpen(false)");
  });

  it("leaves the auto-open effect reading the preference the disconnect now moves", () => {
    expect(localDeviceAutoOpen).toContain('preferences.vaultBackend !== "local-device"');
    expect(localDeviceAutoOpen).toContain("openLocalDeviceWorkspaceKey");
    expect(localDeviceAutoOpen).toContain("activateLocalDeviceWorkspace");
  });
});
