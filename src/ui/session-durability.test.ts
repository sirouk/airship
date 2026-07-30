import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeSessionDurability } from "./app";
import { durabilityLabel, durabilitySeal } from "./durability-indicator";

describe("session durability derivation", () => {
  it("says an offline Drive vault's sync is paused, in a word that is not the in-progress one", () => {
    const offline = describeSessionDurability({
      localDeviceRuntimeAdopted: false,
      cloudVaultRuntimeAdopted: true,
      googleDriveVault: true,
      vaultContractReady: true,
      syncTarget: "Airship",
      online: false,
    });
    /*
     * `syncing` was the state this used to return, and its label is "Syncing
     * encrypted state" — so the chip's visible text and its accessible name both
     * asserted a sync in progress on the one code path whose own detail sentence
     * says nothing is synchronizing. A reader who believes a sync is under way
     * closes the tab on work that never left the browser.
     */
    expect(offline.state).toBe("sync-paused");
    expect(offline.state).not.toBe("synced");
    expect(offline.detail).toContain("Sync paused · offline");
    const label = durabilityLabel(offline.state);
    expect(label).not.toMatch(/Syncing|synchronizing|synced/u);
    expect(label).toContain("sync paused");
    // Not `verified` either: a paused sync is a state that needs the reader.
    expect(durabilitySeal(offline.state)).toBe("attention");

    const connected = describeSessionDurability({
      localDeviceRuntimeAdopted: false,
      cloudVaultRuntimeAdopted: true,
      googleDriveVault: true,
      vaultContractReady: true,
      syncTarget: "Airship",
      online: true,
    });
    expect(connected.state).toBe("synced");
    expect(connected.detail).toContain("Airship");
  });

  it("leaves connectivity-independent derivations untouched offline", () => {
    const device = describeSessionDurability({
      localDeviceRuntimeAdopted: true,
      cloudVaultRuntimeAdopted: false,
      googleDriveVault: false,
      vaultContractReady: false,
      online: false,
    });
    expect(device.state).toBe("local");

    // A loopback S3 lab does not become unreachable when `navigator.onLine`
    // goes false, so only the Drive arm folds connectivity in.
    const lab = describeSessionDurability({
      localDeviceRuntimeAdopted: false,
      cloudVaultRuntimeAdopted: true,
      googleDriveVault: false,
      vaultContractReady: true,
      syncTarget: "airship-dev",
      online: false,
    });
    expect(lab.state).toBe("synced");

    const page = describeSessionDurability({
      localDeviceRuntimeAdopted: false,
      cloudVaultRuntimeAdopted: false,
      googleDriveVault: false,
      vaultContractReady: false,
      online: false,
    });
    expect(page.state).toBe("ephemeral");
    expect(page.detail).toContain("Nothing is synced");
  });
});

describe("offline vault trust axis contract", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

  it("folds connectivity into the vault axis and the durability seal", () => {
    // An adopted Drive vault used to report "Cloud Vault active · verified"
    // and "Encrypted state synced" with the browser offline. Offline vault
    // reachability was the one runtime claim these two surfaces did not read.
    expect(app).toContain('"Vault adopted · currently unreachable"');
    expect(app).toContain('googleDriveVaultAdopted && !online ? "attention" : "verified"');
    // The session bar reads the seal from the durability vocabulary itself, so
    // the axis and the chip cannot disagree about an unreachable vault, and the
    // fourth hand-written copy of the ternary is gone.
    expect(app).toContain("const sessionDurabilitySeal: SealState = durabilitySeal(sessionDurability.state);");
    expect(app).not.toContain('sessionDurability.state === "syncing"');
  });
});
