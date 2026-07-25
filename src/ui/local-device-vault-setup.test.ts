import { describe, expect, it } from "vitest";
import {
  formatLocalDeviceBytes,
  readBoundedLocalDeviceBackup,
} from "./local-device-vault-setup";

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

  it("renders bounded human-readable byte counts", () => {
    expect(formatLocalDeviceBytes(0)).toBe("0 B");
    expect(formatLocalDeviceBytes(1024)).toBe("1.0 KiB");
    expect(formatLocalDeviceBytes(256 * 1024 * 1024)).toBe("256 MiB");
    expect(formatLocalDeviceBytes(Number.NaN)).toBe("Unknown");
  });
});
