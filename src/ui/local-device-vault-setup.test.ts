import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatLocalDeviceBytes,
  publicError,
  readBoundedLocalDeviceBackup,
  recoveryAcknowledgementAllowed,
  recoveryCustodyStatus,
} from "./local-device-vault-setup";
import { LocalDeviceVaultCorruptionError } from "../storage/local-device-object-store";

describe("local device Vault setup boundaries", () => {
  it("reads an encrypted backup exactly within the configured bound", async () => {
    const expected = Uint8Array.from({ length: 97_103 }, (_, index) => index % 251);
    const actual = await readBoundedLocalDeviceBackup(new Blob([expected]), expected.byteLength);

    expect(actual).toEqual(expected);
  });

  it("rejects empty and oversized files before restore handoff", async () => {
    await expect(readBoundedLocalDeviceBackup(new Blob([]), 8)).rejects.toThrow("empty");
    await expect(readBoundedLocalDeviceBackup(new Blob([Uint8Array.of(1, 2, 3)]), 2))
      .rejects.toThrow("exceeds 2 B");
  });

  it("stops a bounded file read when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(readBoundedLocalDeviceBackup(
      new Blob([Uint8Array.of(1)]),
      8,
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
  });

  it("calls an unsaved one-time key an attention state, in its own words", () => {
    // The acknowledgement directly below this line blanks the key for good, so
    // "you have not saved it yet" must not be the quietest thing on the screen.
    expect(recoveryCustodyStatus("none")).toEqual({
      state: "attention",
      label: "Not copied or downloaded yet.",
    });
    expect(recoveryCustodyStatus("copied")).toEqual({
      state: "verified",
      label: "Copied to your clipboard.",
    });
    expect(recoveryCustodyStatus("downloaded")).toEqual({
      state: "verified",
      label: "Download requested.",
    });
  });

  it("refuses the acknowledgement while its own seal says nothing has left the page", () => {
    /*
     * Measured (J058): with the Seal reading verbatim "Not copied or downloaded
     * yet.", the checkbox below it was `disabled: false`; one click advanced
     * the ceremony to `acknowledged` and "The recovery value is no longer
     * rendered." A screen that knows the fact which makes the next click
     * dangerous and permits it anyway is warning nobody.
     */
    expect(recoveryAcknowledgementAllowed("none")).toBe(false);
    expect(recoveryAcknowledgementAllowed("copied")).toBe(true);
    expect(recoveryAcknowledgementAllowed("downloaded")).toBe(true);
    /*
     * The escape is explicit and honest about its own class. Without it the
     * gate is routed around by clicking Copy and never pasting — writing a
     * recovery key on paper is a real thing people do, and Airship watched
     * none of it happen.
     */
    expect(recoveryAcknowledgementAllowed("transcribed")).toBe(true);
    expect(recoveryCustodyStatus("transcribed").state).toBe("asserted");
    expect(recoveryCustodyStatus("transcribed").state).not.toBe("verified");

    const view = readFileSync(new URL("./local-device-vault-setup.tsx", import.meta.url), "utf8");
    // Both sides of the boundary: the control is disabled, and the handler the
    // disabled control guards refuses a programmatic click too.
    expect(view).toContain("disabled={!recoveryAcknowledgementAllowed(custody)}");
    expect(view).toContain("if (!recoveryAcknowledgementAllowed(custody)) return;");
  });

  it("says what the recovery key can and cannot restore, and names the second artifact", () => {
    const view = readFileSync(new URL("./local-device-vault-setup.tsx", import.meta.url), "utf8");
    /*
     * Measured (J056): "Losing both it and this browser profile means losing
     * the Vault." The word "both" states that losing only the profile is
     * survivable, and it is not — a fresh browser profile plus the correct key
     * answered "No existing local device Vault was found for this partition."
     *
     * And (J057): the artifact that can actually restore after profile loss —
     * the encrypted backup — was only discoverable after the ceremony ended,
     * below the fold, under the eyebrow "PORTABLE CIPHERTEXT".
     */
    expect(view).not.toContain("Losing both it and this browser profile");
    expect(view).toContain("it does not contain your data — it authenticates the Vault");
    expect(view).toContain("an encrypted backup file");
    expect(view).toContain("Recovery kit · part 2 of 2");
    expect(view).toContain("Finish the recovery kit");
  });

  it("keeps the safety sentence when the storage engine states only a symptom", () => {
    /*
     * The restore's fallback is the only text that tells a person their
     * existing encrypted Vault survived a failed restore — and it was
     * discarded in exactly the cases it was written for, because every
     * anticipated failure is a corruption error carrying short internal prose.
     * "Stored object authentication failed." on a new laptop does not answer
     * "have I just destroyed my data".
     */
    const remedy = "The backup failed authentication. The existing Vault was not replaced.";
    const notice = publicError(new LocalDeviceVaultCorruptionError("Stored object authentication failed."), remedy);
    expect(notice).toContain("The existing Vault was not replaced.");
    expect(notice).toContain("Stored object authentication failed.");
    expect(notice.indexOf(remedy)).toBe(0);

    // The restore path is the one that must pass that sentence.
    const view = readFileSync(new URL("./local-device-vault-setup.tsx", import.meta.url), "utf8");
    expect(view).toContain('publicError(error, "The backup failed authentication. The existing Vault was not replaced.")');
  });

  it("bounds the technical clause and never re-renders a recovery key", () => {
    expect(publicError("not an error", "Remedy.")).toBe("Remedy.");
    expect(publicError(new Error(""), "Remedy.")).toBe("Remedy.");
    expect(publicError(new Error(`airship-wrk-v1.${"A".repeat(43)}`), "Remedy.")).toBe("Remedy.");
    expect(publicError(new Error("x".repeat(241)), "Remedy.")).toBe("Remedy.");
    // A detail that is already the remedy would print the sentence twice.
    expect(publicError(new Error("Remedy."), "Remedy.")).toBe("Remedy.");
    // Multi-line engine prose collapses to one clause and gains its full stop.
    expect(publicError(new Error("line one\n  line two"), "Remedy.")).toBe("Remedy. Technical detail: line one line two.");
  });

  it("renders bounded human-readable byte counts", () => {
    expect(formatLocalDeviceBytes(0)).toBe("0 B");
    expect(formatLocalDeviceBytes(1024)).toBe("1.0 KiB");
    expect(formatLocalDeviceBytes(256 * 1024 * 1024)).toBe("256 MiB");
    expect(formatLocalDeviceBytes(Number.NaN)).toBe("Unknown");
  });
});

/*
 * Source contracts. The component has no render harness in this pack, and its
 * two ceremony regressions live in markup and effects — both fail closed here
 * rather than not at all.
 */
describe("ceremony continuity contracts", () => {
  const view = readFileSync(new URL("./local-device-vault-setup.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./local-device-vault-setup.css", import.meta.url), "utf8");

  it("keeps the replacement warning in one readable column", () => {
    // The warning used a two-column durability-card grid even though its
    // heading, explanation, and actions are one sequence. A long paragraph
    // consumed the auto column, collapsing the heading and buttons into a
    // narrow strip at the left edge of the alert.
    expect(styles).toMatch(/\.local-device-vault__replacement\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u);
    expect(styles).toContain(".local-device-vault__replacement > .local-device-vault__actions");
  });

  it("hands focus to the commit button when acknowledgement unmounts the checkbox", () => {
    // The acknowledge transition swaps the revealed panel (with the focused
    // checkbox) for the acknowledged panel; without this handoff focus drops
    // to the document body mid-ceremony.
    expect(view).toContain('ceremony === "acknowledged"');
    expect(view).toContain("commitButton.current?.focus()");
    expect(view).toContain("ref={commitButton}");
  });

  it("describes the enrolled-key reuse the empty-storage restore actually performs", () => {
    // The old guard copy claimed the restore "fails if this profile already
    // has an enrolled key", while `restoreBackup` reuses a proved-equivalent
    // enrolled key — the sentence was false about the safest path.
    expect(view).toContain("an enrolled key matching this backup is reused");
    expect(view).not.toContain("Fails if this profile already has an enrolled key or object authority");
  });

  it("makes replacement an explicit, backed-up, same-key operation", () => {
    expect(view).toContain("hasExistingAuthority");
    expect(view).toContain("Existing authority found");
    expect(view).toContain("Continue to backup warning");
    expect(view).toContain("Download backup before replacing");
    expect(view).toContain("Your existing recovery key still opens this Vault.");
    expect(view).toContain("!replacementBackupExported");
    expect(view).toContain("The Vault was not replaced. Your existing encrypted data remains in place.");
    expect(view).toContain("onReplaceExistingVault");
  });
});
