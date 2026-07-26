import { describe, expect, it } from "vitest";
import {
  codePreview,
  isSubmittableCode,
  MAX_AUTHORIZATION_CODE_CHARS,
  MAX_PASTED_INPUT_CHARS,
  readAuthorizationCode,
} from "./authorization-code-paste";

describe("reading a pasted authorization code", () => {
  it("treats blank and whitespace-only input as nothing typed yet", () => {
    expect(readAuthorizationCode("")).toEqual({ kind: "empty" });
    expect(readAuthorizationCode("   \n\t ")).toEqual({ kind: "empty" });
  });

  it("reads the code out of the whole failed-page address", () => {
    const reading = readAuthorizationCode(
      "http://localhost:1455/auth/callback?code=ac_1a2b3c4d5e6f&state=xyz789",
    );
    expect(reading).toMatchObject({
      kind: "accepted",
      code: "ac_1a2b3c4d5e6f",
      state: "xyz789",
      source: "pasted-address",
    });
    expect(isSubmittableCode(reading)).toBe(true);
  });

  it("reads a code carried in the address fragment", () => {
    expect(readAuthorizationCode("https://airship.example/#code=frag_code_1&state=st")).toMatchObject({
      kind: "accepted",
      code: "frag_code_1",
      state: "st",
    });
  });

  it("accepts a bare code with no address around it", () => {
    expect(readAuthorizationCode("  ac_bare0123456  ")).toMatchObject({
      kind: "accepted",
      code: "ac_bare0123456",
      source: "bare-code",
    });
  });

  it("splits the code#state shape into its two parts", () => {
    expect(readAuthorizationCode("codevalue123#statevalue456")).toMatchObject({
      kind: "accepted",
      code: "codevalue123",
      state: "statevalue456",
    });
  });

  it("strips quoting a mail or chat client added around the paste", () => {
    expect(readAuthorizationCode('"http://localhost:1455/cb?code=quoted_code"')).toMatchObject({
      kind: "accepted",
      code: "quoted_code",
    });
  });

  it("names a vendor refusal instead of reporting an invalid code", () => {
    const reading = readAuthorizationCode(
      "http://localhost:1455/cb?error=access_denied&error_description=The%20user%20declined",
    );
    expect(reading).toMatchObject({ kind: "rejected", reason: "vendor-reported-error" });
    expect(reading.kind === "rejected" && reading.message).toContain("declined");
    expect(reading.kind === "rejected" && reading.message).not.toContain("invalid");
  });

  it("bounds vendor error text rather than printing whatever arrives", () => {
    const reading = readAuthorizationCode(
      `http://localhost:1455/cb?error=server_error&error_description=${"x".repeat(4_000)}`,
    );
    expect(reading.kind).toBe("rejected");
    expect(reading.kind === "rejected" && reading.message.length).toBeLessThan(320);
  });

  it("says what is missing when the pasted address carries no code", () => {
    const reading = readAuthorizationCode("http://localhost:1455/auth/callback");
    expect(reading).toMatchObject({ kind: "rejected", reason: "address-has-no-code" });
    expect(reading.kind === "rejected" && reading.message).toContain("code=");
  });

  it("refuses an API key pasted into the code field, by name", () => {
    for (const key of ["sk-proj-abcdefghijklmnop", "cpk_abcdefghijklmnop", "xai-abcdefghijklmn"]) {
      const reading = readAuthorizationCode(key);
      expect(reading, key).toMatchObject({ kind: "rejected", reason: "looks-like-an-api-key" });
    }
  });

  it("refuses characters a one-time code never carries", () => {
    expect(readAuthorizationCode("code with spaces")).toMatchObject({
      kind: "rejected",
      reason: "unsupported-characters",
    });
  });

  it("recognises a half-pasted address instead of reading it as a code", () => {
    expect(readAuthorizationCode("localhost:1455/auth/callback?code")).toMatchObject({
      kind: "rejected",
      reason: "address-has-no-code",
    });
  });

  it("bounds the raw paste and the extracted code independently", () => {
    expect(readAuthorizationCode("a".repeat(MAX_PASTED_INPUT_CHARS + 1))).toMatchObject({
      kind: "rejected",
      reason: "input-too-long",
    });
    expect(readAuthorizationCode("b".repeat(MAX_AUTHORIZATION_CODE_CHARS + 1))).toMatchObject({
      kind: "rejected",
      reason: "code-too-long",
    });
    expect(readAuthorizationCode("c".repeat(MAX_AUTHORIZATION_CODE_CHARS)).kind).toBe("accepted");
  });

  it("omits state entirely when the vendor round-tripped none", () => {
    const reading = readAuthorizationCode("http://localhost:1455/cb?code=nostate_code");
    expect(reading.kind).toBe("accepted");
    expect(reading.kind === "accepted" && "state" in reading).toBe(false);
  });

  it("previews the code without printing all of it", () => {
    expect(codePreview("ac_1234567890abcdef")).toBe("ac_1…cdef");
    expect(codePreview("short")).toBe("sh…");
    expect(codePreview("ac_1234567890abcdef")).not.toContain("567890");
  });
});
