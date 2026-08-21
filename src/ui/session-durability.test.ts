import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeSessionDurability } from "./app";
import { durabilityLabel, durabilityStatusMark } from "./durability-indicator";

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
    expect(durabilityStatusMark(offline.state)).toBe("attention");

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

describe("offline vault durability contract", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

  it("derives one standing durability fact from the active storage authority", () => {
    expect(app).toContain("const sessionDurability = describeSessionDurability({");
    expect(app).toContain("googleDriveVault: googleDriveVaultAdopted,");
    expect(app).toContain("online,");
    expect(app).toContain("const sessionDurabilityStatusMark: StatusMarkState = durabilityStatusMark(sessionDurability.state);");
    expect(app).toContain("detail: sessionDurability.detail,");
    expect(app).not.toContain('sessionDurability.state === "syncing"');
  });

  it("keeps standing durability in the session fact and its Vault action", () => {
    expect(app).not.toContain("Local Device Vault needs a saved recovery key");
    expect(app).toContain('id: "durability" as const,');
    expect(app).toContain('action: Object.freeze({ label: "Vault", onSelect: () => navigate("vault") })');
    expect(app).toContain("durability={sessionDurability}");
  });

  it("states a failed resume in one line and leaves the forensics where they render", () => {
    /*
     * Measured (J098): 470 characters of quarantine narrative — title, short
     * id, verbatim reason, history verdict and a raw
     * `LOCAL_COMMAND_INCOMPLETE: Client-only local command local-command-70aa…`
     * — in a single-line chip that draws about sixty of them before ellipsis,
     * with roughly two words of room on a phone. Every one of those strings
     * already renders in full in the `#sessions` quarantine panel that
     * `setQuarantinedSession` feeds.
     */
    expect(app).toContain("could not be replayed — open All conversations for the reason");
    expect(app).not.toContain("${quarantined.reason}");
    expect(app).not.toContain("Its history is intact — open Sessions to inspect it");
  });
});
