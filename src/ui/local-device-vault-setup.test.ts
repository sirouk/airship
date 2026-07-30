import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatLocalDeviceBytes,
  publicError,
  readBoundedLocalDeviceBackup,
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
});
