import { describe, expect, it } from "vitest";
import {
  PROVIDER_FACT_ROWS,
  PROVIDER_PROFILES,
  attachedCount,
  attachedRows,
  readinessTally,
  sealForState,
  vaultState,
} from "./vault-view";
import type { VaultSnapshot } from "../vault/coordinator";
import type { LocalDeviceVaultStatus } from "../vault/local-device";

const disconnected = { phase: "disconnected", message: "No cloud vault is configured." } as unknown as VaultSnapshot;

const readySnapshot = {
  phase: "ready",
  message: "Vault contract verified for this browser origin; synchronization has not been evaluated.",
  workspaceKey: "attached",
  config: {
    endpoint: "http://127.0.0.1:9900",
    bucket: "airship-dev",
    region: "us-east-1",
    namespace: "airship-live-v2/local-user",
    mode: "local-development",
    credentialSource: { displayName: "User-owned loopback S3 lab" },
  },
} as unknown as VaultSnapshot;

const openedDevice = {
  message: "Encrypted device Vault ready.",
  readiness: { backend: "opfs", persistence: "origin-private", persistedPermission: "not-granted", schema: { current: 2 } },
} as unknown as LocalDeviceVaultStatus;

describe("vault state honesty", () => {
  it("never renders a verified seal for a passed contract the runtime has not adopted", () => {
    const notAdopted = vaultState({
      phase: "ready", localDevice: false, localDeviceOpened: false, ephemeral: false, runtimeAdopted: false,
    });
    const adopted = vaultState({
      phase: "ready", localDevice: false, localDeviceOpened: false, ephemeral: false, runtimeAdopted: true,
    });

    // The shipped defect this guards: a green "Contract verified" while the
    // workspace and journal were still page memory.
    expect(notAdopted).toBe("verified");
    expect(sealForState(notAdopted)).toBe("attention");
    expect(adopted).toBe("adopted");
    expect(sealForState(adopted)).toBe("verified");
  });

  it("treats ephemeral as a chosen mode rather than a failure", () => {
    const state = vaultState({
      phase: "disconnected", localDevice: false, localDeviceOpened: false, ephemeral: true, runtimeAdopted: false,
    });

    expect(state).toBe("ephemeral");
    expect(sealForState(state)).toBe("none");
    expect(sealForState(state)).not.toBe("failed");
  });

  it("keeps a degraded probe a failure and a running probe a check", () => {
    const blocked = vaultState({
      phase: "degraded", localDevice: false, localDeviceOpened: false, ephemeral: false, runtimeAdopted: false,
    });
    const probing = vaultState({
      phase: "probing", localDevice: false, localDeviceOpened: false, ephemeral: false, runtimeAdopted: false,
    });

    expect(sealForState(blocked)).toBe("failed");
    expect(sealForState(probing)).toBe("checking");
  });

  it("does not call a local device opened until its status exists", () => {
    expect(vaultState({
      phase: "disconnected", localDevice: true, localDeviceOpened: false, ephemeral: false, runtimeAdopted: false,
    })).toBe("unset");
    expect(vaultState({
      phase: "disconnected", localDevice: true, localDeviceOpened: true, ephemeral: false, runtimeAdopted: true,
    })).toBe("adopted");
  });
});

describe("prerequisite itemisation", () => {
  it("names the three things the disconnected sentence lists, all missing", () => {
    const rows = attachedRows(disconnected, undefined, false);

    expect(rows.map((row) => row.label)).toEqual(["Endpoint", "Credential authority", "Workspace key"]);
    expect(rows.every((row) => !row.attached)).toBe(true);
    expect(attachedCount(disconnected, undefined, false)).toBe(0);
  });

  it("reports the real endpoint and credential path once they are attached", () => {
    const rows = attachedRows(readySnapshot, undefined, false);

    expect(rows[0]?.value).toBe("http://127.0.0.1:9900");
    expect(rows[1]?.value).toBe("User-owned loopback S3 lab");
    expect(attachedCount(readySnapshot, undefined, false)).toBe(3);
  });

  it("counts the device prerequisites from custody, not from the selected provider", () => {
    expect(attachedCount(disconnected, undefined, true)).toBe(0);
    expect(attachedCount(disconnected, openedDevice, true)).toBe(3);
    expect(attachedRows(disconnected, openedDevice, true)[1]?.value).toBe("Created · OPFS");
  });
});

describe("readiness tally", () => {
  it("counts rather than hard-codes, and never calls a skipped check verified", () => {
    expect(readinessTally({
      conditionalCreate: "verified", compareAndSwap: "verified", exactRange: "verified", prefixList: "verified",
      readAfterWrite: "verified", encryptedJournal: "verified", encryptedWorkspace: "verified",
      dataSynchronization: "not-evaluated",
    })).toBe("7 of 8 checks verified · 1 not evaluated");
  });

  it("drops the trailing clause only when nothing was skipped", () => {
    expect(readinessTally({
      conditionalCreate: "verified", compareAndSwap: "verified", exactRange: "verified", prefixList: "verified",
      readAfterWrite: "verified", encryptedJournal: "verified", encryptedWorkspace: "verified",
      dataSynchronization: "verified" as "not-evaluated",
    })).toBe("8 of 8 checks verified");
  });
});

describe("provider comparison", () => {
  it("answers the same six questions for every provider so the columns line up", () => {
    for (const profile of PROVIDER_PROFILES) {
      for (const [key] of PROVIDER_FACT_ROWS) {
        expect(profile.facts[key], `${profile.title}/${key}`).toBeTruthy();
      }
    }
    expect(PROVIDER_PROFILES).toHaveLength(4);
  });

  it("keeps the four shipped option descriptions verbatim", () => {
    expect(PROVIDER_PROFILES.map((profile) => profile.description)).toEqual([
      "Encrypted, offline, and persistent in this browser profile",
      "Your encrypted cross-device Airship workspace folder",
      "Advanced provider or local development lab",
      "Page memory only; nothing synced",
    ]);
  });

  it("states plainly that the ephemeral option keeps nothing", () => {
    const ephemeral = PROVIDER_PROFILES.find((profile) => profile.id === "ephemeral");

    expect(ephemeral?.facts.survives).toBe("No · released with the page");
    expect(ephemeral?.facts.keep).toBe("Nothing to keep");
    expect(ephemeral?.facts.lose).toBe("Closing the page");
  });

  it("keeps the Drive honesty claim in the sentence read at the moment of choice", () => {
    const drive = PROVIDER_PROFILES.find((profile) => profile.id === "google-drive");

    expect(drive?.note).toContain("Google never receives the workspace key.");
  });
});
