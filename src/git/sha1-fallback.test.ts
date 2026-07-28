import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import BrowserSha1 from "./sha1-fallback";

describe("browser SHA-1 fallback", () => {
  it.each([
    ["", "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
    ["abc", "a9993e364706816aba3e25717850c26c9cd0d89d"],
    ["The quick brown fox jumps over the lazy dog", "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12"],
  ])("matches the published SHA-1 vector for %j", (input, expected) => {
    expect(new BrowserSha1().update(input).digest("hex")).toBe(expected);
  });

  it("supports incremental binary and hexadecimal updates used by the pack writer", () => {
    const digest = new BrowserSha1()
      .update(new Uint8Array([0x61]))
      .update("62", "hex")
      .update(new Uint8Array([0x63]).buffer)
      .digest();
    expect([...digest as Uint8Array].map((byte) => byte.toString(16).padStart(2, "0")).join(""))
      .toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it.each([55, 56, 63, 64, 65, 119, 120, 127, 128, 129])(
    "matches the platform reference across the %i-byte padding boundary",
    (length) => {
      const input = Uint8Array.from({ length }, (_, index) => (index * 17 + 29) & 0xff);
      const expected = createHash("sha1").update(input).digest("hex");
      const hash = new BrowserSha1();
      for (let offset = 0; offset < input.byteLength; offset += 13) {
        hash.update(input.subarray(offset, offset + 13));
      }
      expect(hash.digest("hex")).toBe(expected);
    },
  );

  it("handles a multi-block incremental stream without truncating its bit length", () => {
    const hash = new BrowserSha1();
    const block = "a".repeat(1_000);
    for (let index = 0; index < 1_000; index += 1) hash.update(block);
    const internals = hash as unknown as { chunks?: unknown; tailLength: number };
    expect(internals.chunks).toBeUndefined();
    expect(internals.tailLength).toBeGreaterThanOrEqual(0);
    expect(internals.tailLength).toBeLessThan(64);
    expect(hash.digest("hex")).toBe("34aa973cd4c4daa4f61eeb2bdbad27316534016f");
  });

  it("processes caller-owned full blocks immediately and retains only its bounded tail", () => {
    const input = new Uint8Array(64 * 1_024 + 3).fill(0x61);
    const expected = new BrowserSha1().update(input).digest("hex");
    const hash = new BrowserSha1().update(input);
    input.fill(0);
    const internals = hash as unknown as { tailLength: number };
    expect(internals.tailLength).toBe(3);
    expect(hash.digest("hex")).toBe(expected);
  });

  it("does not accept updates or a second digest after finalization", () => {
    const hash = new BrowserSha1().update("abc");
    expect(hash.digest("hex")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(() => hash.update("def")).toThrow(/already been finalized/iu);
    expect(() => hash.digest("hex")).toThrow(/already been finalized/iu);
  });
});
