import { describe, expect, it } from "vitest";
import { confidentialTokenForm } from "./local-chutes-oauth-bridge";

describe("local confidential Chutes OAuth bridge", () => {
  it("adds the device-held secret to a PKCE exchange", () => {
    const form = confidentialTokenForm(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: "one-time-code",
        client_id: "cid_airship",
        redirect_uri: "http://localhost:4173/auth/chutes/callback",
        code_verifier: "v".repeat(43),
      }).toString(),
      "cid_airship",
      "device-secret",
    );
    expect(form.get("client_secret")).toBe("device-secret");
    expect(form.get("code_verifier")).toBe("v".repeat(43));
  });

  it("rejects browser-supplied secrets, foreign clients, and unsupported fields", () => {
    expect(() => confidentialTokenForm("grant_type=authorization_code&client_id=cid_airship&client_secret=leak", "cid_airship", "secret")).toThrow("must not submit");
    expect(() => confidentialTokenForm("grant_type=authorization_code&client_id=cid_other", "cid_airship", "secret")).toThrow("does not match");
    expect(() => confidentialTokenForm("grant_type=password&client_id=cid_airship&password=nope", "cid_airship", "secret")).toThrow("unsupported field");
    expect(() => confidentialTokenForm("grant_type=authorization_code&client_id=cid_airship&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback", "cid_airship", "secret")).toThrow("redirect does not match");
  });
});
