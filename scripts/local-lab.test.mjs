import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOCAL_LAB,
  LOCAL_LAB_GOOGLE_CLIENT_ID,
  LOCAL_LAB_UI_ORIGINS,
  chutesOAuthBridgeRequest,
  inspectAirshipHtml,
  labCorsAllows,
  labEnvironment,
  requireChutesApiCheckout,
  requiresOwnedViteRestartForOAuth,
} from "./local-lab.mjs";

describe("local full-system lab contract", () => {
  it("recognizes Airship only when the development CSP authorizes both loopback spellings", () => {
    const ready = inspectAirshipHtml(
      "<title>Airship — private edge agent</title><meta content=\"connect-src http://127.0.0.1:9900 http://localhost:9900\">",
    );
    expect(ready).toEqual({ airship: true, localS3Csp: true });
    expect(inspectAirshipHtml("<title>Airship</title>")).toEqual({ airship: true, localS3Csp: false });
    expect(inspectAirshipHtml("<title>Another product</title>").airship).toBe(false);
  });

  it("builds the live harness environment without mutating or dropping the caller environment", () => {
    const source = { PATH: "/test/bin", CUSTOM: "preserved" };
    const result = labEnvironment(source);
    expect(source).toEqual({ PATH: "/test/bin", CUSTOM: "preserved" });
    expect(result).toMatchObject({
      PATH: "/test/bin",
      CUSTOM: "preserved",
      AIRSHIP_LOCAL_S3_ENDPOINT: LOCAL_LAB.s3Endpoint,
      AIRSHIP_LOCAL_S3_BUCKET: LOCAL_LAB.bucket,
      AIRSHIP_LOCAL_S3_ACCESS_KEY: LOCAL_LAB.accessKeyId,
      VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER: "google-drive",
      VITE_GOOGLE_CLIENT_ID: LOCAL_LAB_GOOGLE_CLIENT_ID,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("preserves an operator-provided Google registration in the lab", () => {
    const result = labEnvironment({ VITE_GOOGLE_CLIENT_ID: "operator-client.apps.googleusercontent.com" });
    expect(result.VITE_GOOGLE_CLIENT_ID).toBe("operator-client.apps.googleusercontent.com");
  });

  it("requires a complete process-only Chutes bridge configuration and exposes no secret state", () => {
    expect(chutesOAuthBridgeRequest({})).toEqual({ configured: false });
    expect(() => chutesOAuthBridgeRequest({ AIRSHIP_CHUTES_OAUTH_CLIENT_ID: "cid_test" }))
      .toThrow(/requires both/u);
    expect(() => chutesOAuthBridgeRequest({ AIRSHIP_CHUTES_OAUTH_CLIENT_SECRET: "csc_test" }))
      .toThrow(/requires both/u);
    const request = chutesOAuthBridgeRequest({
      AIRSHIP_CHUTES_OAUTH_CLIENT_ID: " cid_test ",
      AIRSHIP_CHUTES_OAUTH_CLIENT_SECRET: " csc_memory_only ",
    });
    expect(request).toEqual({ configured: true, clientId: "cid_test" });
    expect(JSON.stringify(request)).not.toContain("csc_memory_only");
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("restarts an owned OAuth handler for secret rotation without persisting a secret derivative", () => {
    const configured = { configured: true, clientId: "cid_test" };
    const absent = { configured: false };
    expect(requiresOwnedViteRestartForOAuth(configured, configured)).toBe(true);
    expect(requiresOwnedViteRestartForOAuth(configured, absent)).toBe(true);
    expect(requiresOwnedViteRestartForOAuth(absent, configured)).toBe(true);
    expect(requiresOwnedViteRestartForOAuth(absent, absent)).toBe(false);
  });

  it("confines the published lab endpoint and console to IPv4 loopback", () => {
    expect(new URL(LOCAL_LAB.s3Endpoint).hostname).toBe("127.0.0.1");
    expect(new URL(LOCAL_LAB.s3Console).hostname).toBe("127.0.0.1");
  });

  it("names the missing sibling checkout stage 5 needs, by path", async () => {
    // Stage 5 used to reach `uv run pytest` in `../chutes-api` only after the
    // four expensive stages had run, and reported the absent checkout as a
    // spawn error rather than as the unlisted precondition it is.
    await expect(requireChutesApiCheckout(resolve(process.cwd(), "..", "no-such-chutes-api")))
      .rejects.toThrow(/chutes-api. checkout beside this repository/u);
    await expect(requireChutesApiCheckout(process.cwd())).resolves.toBeUndefined();
  });

  it("requires the exact Airship origin and complete signed-write preflight surface", () => {
    const allowed = {
      status: 204,
      allowOrigin: "http://localhost:4173",
      allowMethods: "PUT",
      allowHeaders: "authorization,content-type,if-match,if-none-match,range,x-amz-content-sha256,x-amz-date",
    };
    expect(labCorsAllows(allowed)).toBe(true);
    expect(labCorsAllows({ ...allowed, allowOrigin: "http://127.0.0.1:4173" })).toBe(true);
    expect(labCorsAllows({ ...allowed, allowOrigin: "*" })).toBe(false);
    expect(LOCAL_LAB_UI_ORIGINS).toEqual(["http://localhost:4173", "http://127.0.0.1:4173"]);
    expect(labCorsAllows({ ...allowed, allowHeaders: "authorization,x-amz-date" })).toBe(false);
  });
});
