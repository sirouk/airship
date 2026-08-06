import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EPHEMERAL_RETENTION_DISCLOSURE } from "./chat/return-ledger";
import {
  PROVIDER_FACT_ROWS,
  PROVIDER_PROFILES,
  VAULT_RELEASE_ACTION_LABEL,
  attachedCount,
  attachedRows,
  attachedSummary,
  googleDriveAvailableInBuild,
  readinessTally,
  sealForState,
  vaultPhaseLabel,
  vaultReleaseNote,
  vaultState,
} from "./vault-view";
import { resolveDefaultVaultBackend } from "./platform-shell";
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

describe("route bar phase label", () => {
  const label = (input: Partial<Parameters<typeof vaultPhaseLabel>[0]>) => vaultPhaseLabel({
    state: "unset",
    phase: "disconnected",
    phaseLabel: "Disconnected",
    localDevice: false,
    ...input,
  });

  it("keeps every string the e2e suite reads off this bar", () => {
    expect(label({ state: "adopted", phase: "ready" })).toBe("Encrypted runtime active");
    expect(label({ state: "adopted", phase: "disconnected", localDevice: true }))
      .toBe("Encrypted device Vault ready");
    expect(label({ state: "verified", phase: "disconnected", localDevice: true }))
      .toBe("Encrypted device Vault ready");
    expect(label({ state: "ephemeral" })).toBe("Page memory · by choice");
  });

  it("never lets a passed contract report itself as an adopted runtime", () => {
    expect(label({ state: "verified", phase: "ready" })).toBe("Contract verified · not adopted");
    expect(sealForState("verified")).not.toBe("verified");
  });

  it("stops calling a Vault that was never created 'Disconnected'", () => {
    // Airship's failure grammar for what is a first-run default. The word is
    // kept for the providers that genuinely were connected and are not.
    expect(label({ state: "unset", localDevice: true })).toBe("Not set up yet");
    expect(label({ state: "unset", localDevice: false })).toBe("Disconnected");
  });

  it("carries a probing and a blocked phase through in the coordinator's own word", () => {
    expect(label({ state: "probing", phase: "probing", phaseLabel: "Testing" })).toBe("Testing");
    expect(label({ state: "blocked", phase: "degraded", phaseLabel: "Not ready" })).toBe("Not ready");
    expect(sealForState("blocked")).toBe("failed");
  });
});

describe("prerequisite itemisation", () => {
  it("names the three things the disconnected sentence lists, all missing", () => {
    const rows = attachedRows(disconnected, undefined, false);

    expect(rows.map((row) => row.label)).toEqual(["Endpoint", "Credential authority", "Workspace key"]);
    expect(rows.every((row) => row.attached === false)).toBe(true);
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
    /*
     * Was 3, deliberately amended to 2. The third row certified "Recovery key
     * · Saved by you" from nothing but `Boolean(localDeviceStatus)` — custody
     * of the one-time value is never persisted (the acknowledgement is page
     * state), so an open vault could not know the key was saved. The device
     * key and object store rows keep their custody-backed counts.
     */
    expect(attachedCount(disconnected, openedDevice, true)).toBe(2);
    expect(attachedRows(disconnected, openedDevice, true)[1]?.value).toBe("Created · OPFS");
  });

  it("states the provable recovery-key fact instead of a custody it cannot know", () => {
    const rows = attachedRows(disconnected, openedDevice, true);
    const recovery = rows[2]!;

    expect(recovery.label).toBe("Recovery key");
    // "unknown", never false: an unprovable fact reported as unmet is a fault
    // report, and this one could never be cleared.
    expect(recovery.attached).toBe("unknown");
    expect(recovery.value).toContain("Airship holds no copy");
    expect(recovery.value).toContain("confirm you can still find it");
    expect(recovery.value).not.toContain("Saved by you");
  });

  it("never puts an unknowable row in the count it advertises", () => {
    // The defect this pins: the summary was the literal "(n of 3) — the device
    // key, the object store and the recovery key", so a fully enrolled device
    // Vault read "2 of 3" forever and a real gap looked the same as the
    // standing one. Every row that is counted must be able to reach `true`.
    for (const localDevice of [true, false]) {
      for (const status of [undefined, openedDevice]) {
        for (const snapshot of [disconnected, readySnapshot]) {
          const rows = attachedRows(snapshot, status, localDevice);
          const counted = rows.filter((row) => row.attached !== "unknown");
          const summary = attachedSummary(rows);

          expect(summary).toContain(`of ${counted.length})`);
          for (const row of counted) expect(summary).toContain(row.label.toLowerCase());
          for (const row of rows.filter((item) => item.attached === "unknown")) {
            expect(summary).toContain("only you can confirm");
            expect(summary.indexOf(row.label.toLowerCase())).toBeGreaterThan(summary.indexOf(")"));
          }
        }
      }
    }
  });

  it("reaches its own denominator once a device Vault is fully set up", () => {
    expect(attachedSummary(attachedRows(disconnected, openedDevice, true)))
      .toBe("What's attached (2 of 2) — the device key and the encrypted object store; the recovery key only you can confirm");
    expect(attachedSummary(attachedRows(disconnected, undefined, true)))
      .toBe("What's attached (0 of 2) — the device key and the encrypted object store; the recovery key only you can confirm");
  });

  it("enumerates the prerequisites the surface actually has, not the device ones", () => {
    // A Drive/S3 Vault itemises endpoint, credential authority and workspace
    // key. The old literal summary named the device key and the object store on
    // that surface, which are not among its rows.
    const summary = attachedSummary(attachedRows(readySnapshot, undefined, false));

    expect(summary).toBe("What's attached (3 of 3) — the endpoint, the credential authority and the workspace key");
    expect(summary).not.toContain("device key");
    expect(summary).not.toContain("recovery key");
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
      "Page memory only; nothing synced",
      "Encrypted, offline, and persistent in this browser profile",
      "Your encrypted cross-device Airship workspace folder",
      // Was "Advanced provider or local development lab". The only S3
      // configuration this build can construct is the loopback lab, so the
      // option no longer offers an "advanced provider" it cannot open.
      "Loopback development lab",
    ]);
  });

  it("puts the starting Ephemeral option before Local Device", () => {
    expect(PROVIDER_PROFILES.slice(0, 2).map((profile) => profile.id))
      .toEqual(["ephemeral", "local-device"]);
  });

  it("promises cross-device reach for the one provider that can deliver it", () => {
    // `createLocalLabConfigureRequest` only ever builds `mode:
    // "local-development"`, which validation confines to a loopback endpoint,
    // so the S3 rung answering "Reaches other devices: Yes" was a promise no
    // shippable configuration keeps.
    const reaching = PROVIDER_PROFILES.filter((profile) => profile.facts.reach === "Yes");

    expect(reaching.map((profile) => profile.id)).toEqual(["google-drive"]);
  });

  it("describes the S3 rung as the loopback lab it can actually open", () => {
    const lab = PROVIDER_PROFILES.find((profile) => profile.id === "local-lab");

    expect(lab?.facts.reach.startsWith("No")).toBe(true);
    // "your bucket" claimed durability in storage the person controls off this
    // machine; the lab bucket lives on the loopback service they are running.
    for (const [key] of PROVIDER_FACT_ROWS) {
      expect(lab?.facts[key], key).not.toContain("your bucket");
    }
    // The restriction leads the paragraph rather than trailing it, because a
    // reader who stops after the first sentence must not stop on the promise.
    expect(lab?.note.split(". ")[0]).toBe("On a loopback lab endpoint nothing is cloud-synchronized");
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

  it("makes each provider's 'You keep' row answer its own 'What can lose it' row", () => {
    /*
     * Measured (J056): Local Device answered "You keep: A recovery key" above
     * "What can lose it: Browser eviction · clearing site data", and this
     * operator read the first as the antidote to the second — wrote the key
     * down, kept nothing else, and discovered at restore time that a fresh
     * browser profile plus the correct key returns "The recovery key did not
     * authenticate this Local Device Vault." The ciphertext is in the profile's
     * own storage, so both artifacts are required or neither works.
     */
    const local = PROVIDER_PROFILES.find((profile) => profile.id === "local-device");
    expect(local?.facts.lose).toBe("Browser eviction · clearing site data");
    expect(local?.facts.keep).toContain("encrypted backup file");
    expect(local?.facts.keep).toContain("the key alone cannot rebuild an evicted store");

    // The cloud rows are untouched on purpose: their ciphertext survives the
    // browser profile, so there the key really is the whole of what you keep.
    for (const id of ["google-drive", "local-lab"] as const) {
      expect(PROVIDER_PROFILES.find((profile) => profile.id === id)?.facts.keep, id)
        .toBe("A recovery key");
    }
  });

  it("states what an ephemeral browser profile still remembers, in the ledger's own words", () => {
    /*
     * The lane's policy question: the return ledger persists an opaque id, a
     * message count and a clock in `localStorage` for page-memory
     * conversations, and this row says "released with the page". Ephemeral is a
     * promise about content, so the row states the exception rather than the
     * module quietly making the row false.
     */
    const ephemeral = PROVIDER_PROFILES.find((profile) => profile.id === "ephemeral");
    expect(ephemeral?.note).toContain(EPHEMERAL_RETENTION_DISCLOSURE);
    expect(ephemeral?.note).toContain("closing the page releases it");
  });

  it("answers the intent that sends a person here, not the requirement that blocks them", () => {
    /*
     * Measured (J132): "Keep future conversations" on the loss report landed on
     * "Attention · Local Device setup required · Create or recover the device
     * key below. No storage authority is created before the recovery value is
     * acknowledged." — a requirement in the failure register in answer to an
     * intent, offered as the remedy for work that in that case had not even
     * been lost.
     */
    const view = readFileSync(new URL("./vault-view.tsx", import.meta.url), "utf8");
    expect(view).not.toContain('"Local Device setup required"');
    expect(view).toContain("Keep this browser’s work on this device");
    expect(view).toContain("Nothing is enrolled until you save that key, and cancelling changes nothing.");
    // And the consequence a person cannot discover any other way (J110).
    expect(view).toContain("Conversations already in this tab are copied into the Vault when it opens");
    expect(view).toContain("Fork to continue");
  });
});

describe("Drive availability", () => {
  const canonical = "airship-example-client.apps.googleusercontent.com";

  it("agrees with the preference sanitiser on every build value", () => {
    // The route used to decide this with raw truthiness while
    // `availableVaultBackend` used the strict predicate, so a malformed client
    // ID rendered a live connect route whose stored preference was silently
    // rewritten on the next load and whose authorizer threw at construction.
    for (const clientId of [undefined, "", "   ", "not-a-client-id", "my-client-id", canonical]) {
      const available = googleDriveAvailableInBuild(clientId);

      expect(available, clientId ?? "undefined").toBe(
        resolveDefaultVaultBackend("google-drive", clientId) === "google-drive",
      );
    }
  });

  it("calls only a deployable client ID available", () => {
    expect(googleDriveAvailableInBuild(canonical)).toBe(true);
    expect(googleDriveAvailableInBuild(` ${canonical} `)).toBe(true);
    expect(googleDriveAvailableInBuild("not-a-client-id")).toBe(false);
    expect(googleDriveAvailableInBuild(undefined)).toBe(false);
  });
});

/*
 * `adoptionNotice` was designed, documented and rendered, and no caller ever
 * passed it: the reason a verified vault refused to be adopted was written
 * straight into `runtimeStatus`, one mixed-purpose line that the next event
 * overwrites and that this route deliberately does not read. The row could
 * therefore only ever print its generic "still page-memory" sentence, on the
 * one screen a person goes to when adoption has not happened.
 */
describe("the runtime's own account of a failed adoption", () => {
  const view = readFileSync(new URL("./vault-view.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

  it("renders the caller's exact sentence as an alert, and only while unadopted", () => {
    expect(view).toContain('{!runtimeAdopted && adoptionNotice ? <p class="vault-view__warning" role="alert">{adoptionNotice}</p> : null}');
  });

  it("is fed by a state the adoption failure actually sets", () => {
    expect(app).toContain("const [vaultAdoptionNotice, setVaultAdoptionNotice] = useState<string>();");
    const adoption = app.slice(
      app.indexOf("void adoptReadyVaultRuntime(vaultSnapshot, vault.readyRuntime())"),
    ).slice(0, 800);
    expect(adoption).toContain("setVaultAdoptionNotice(message)");
    // Cleared on a later success and on a destination change, so the row cannot
    // carry a reason that no longer describes anything.
    expect(adoption).toContain(".then(() => setVaultAdoptionNotice(undefined))");
    expect(app.slice(app.indexOf("async function changeVaultProvider"), app.indexOf("async function changeVaultProvider") + 2_000))
      .toContain("setVaultAdoptionNotice(undefined)");
    expect(app).toContain("adoptionNotice={vaultAdoptionNotice}");
  });
});

describe("releasing the Vault is one act with one name", () => {
  const view = readFileSync(new URL("./vault-view.tsx", import.meta.url), "utf8");

  it("binds exactly one distinct button text to onDisconnect", () => {
    /*
     * Two labels for one host handler: "Switch to ephemeral · keep a page copy"
     * on Local Device and "Disconnect · continue locally" 102 lines below it on
     * every other provider. A person who learned the first could not find it
     * again after switching to Drive, and "Disconnect" is the failure grammar
     * this route reserves for a provider that genuinely dropped.
     */
    const bound = [...view.matchAll(/onClick=\{onDisconnect\}[^>]*>\s*\{?([^<}]*)/gu)]
      .map((match) => match[1]!.trim())
      .filter(Boolean);
    expect(new Set(bound).size).toBe(1);
    expect(view).not.toContain("Disconnect · continue locally");
    // Both branches render the same component, so a future edit cannot make the
    // label depend on which storage backend is attached.
    expect(view.match(/<VaultReleaseAction /gu) ?? []).toHaveLength(2);
    expect(view).toContain("{VAULT_RELEASE_ACTION_LABEL}");
  });

  it("states what survives per provider, in the sentence rather than the label", () => {
    // The label promises a page copy; only the sentence can answer "and what
    // about the encrypted copy I already have at the provider?".
    expect(VAULT_RELEASE_ACTION_LABEL).toContain("Switch to ephemeral");
    for (const profile of PROVIDER_PROFILES) {
      const note = vaultReleaseNote(profile.id);
      expect(note, `${profile.id} states what happens to this page`).toContain("keeps working in memory");
      expect(note).not.toMatch(/disconnect/iu);
      if (profile.id === "ephemeral") {
        // There is no durable store to leave behind, and a sentence about
        // "your encrypted Ephemeral data" would describe one that never existed.
        expect(note).toContain("No durable store is attached");
        continue;
      }
      expect(note, `${profile.id} names its own provider`).toContain(profile.title);
      expect(note).toContain("left exactly where it is");
    }
    // Bound to the control, so a screen-reader user gets the consequence with
    // the button rather than only if they happen to read past it.
    expect(view).toContain("aria-describedby={noteId}");
  });
});
