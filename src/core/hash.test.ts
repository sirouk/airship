import { describe, expect, it } from "vitest";
import type { JsonValue } from "./contracts";
import { fromBase64Url, sha256, stableStringify, toBase64Url, toolArgumentsDigest } from "./hash";

describe("stableStringify", () => {
  it("orders keys by code unit, not by the host's collation", () => {
    /*
     * Every key here is one ICU orders differently from code point under `en`:
     * collation treats `_` as ignorable punctuation and folds case, so it reads
     * `a_b` < `a0b`, `id` < `Id`, and `0a` > `_b`. The digests built over this
     * string are commitments that a second device recomputes, so the only
     * ordering that can be right is the one that depends on nothing but the
     * bytes.
     */
    const canonical = stableStringify({ a_b: 1, a0b: 2, aXb: 3, _b: 4, "0a": 5, id: 6, Id: 7 } as JsonValue);

    expect(canonical).toBe('{"0a":5,"Id":7,"_b":4,"a0b":2,"aXb":3,"a_b":1,"id":6}');
    expect(canonical).toBe(stableStringify(
      { id: 6, "0a": 5, aXb: 3, Id: 7, a0b: 2, _b: 4, a_b: 1 } as JsonValue,
    ));
  });

  it("gives one preimage whatever order the object was built in", async () => {
    const written = { gpu_evidence: { deviceId: "a", gpu_uuid: "b" }, gpuCount: 2 };
    const read = { gpuCount: 2, gpu_evidence: { gpu_uuid: "b", deviceId: "a" } };

    expect(stableStringify(written as JsonValue)).toBe(stableStringify(read as JsonValue));
    expect(await toolArgumentsDigest(written as JsonValue)).toBe(await toolArgumentsDigest(read as JsonValue));
  });

  it("keeps arrays in their own order and renders scalars as JSON does", () => {
    expect(stableStringify([3, 1, 2] as JsonValue)).toBe("[3,1,2]");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify("a\"b" as JsonValue)).toBe('"a\\"b"');
  });
});

describe("base64url", () => {
  it("round-trips bytes through an unpadded, URL-safe alphabet", () => {
    const bytes = Uint8Array.from([0, 1, 251, 252, 253, 254, 255]);
    const encoded = toBase64Url(bytes);

    expect(encoded).not.toMatch(/[+/=]/u);
    expect([...fromBase64Url(encoded)]).toEqual([...bytes]);
  });

  it("labels its digests with the algorithm that produced them", async () => {
    expect(await sha256("airship")).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
  });
});
