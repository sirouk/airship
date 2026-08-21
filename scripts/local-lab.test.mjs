import { describe, expect, it } from "vitest";
import {
  LOCAL_LAB,
  LOCAL_LAB_GOOGLE_CLIENT_ID,
  LOCAL_LAB_UI_ORIGINS,
  inspectAirshipHtml,
  labCorsAllows,
  labEnvironment,
  stockBuildEnvironment,
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
    const source = { PATH: "/test/bin", CUSTOM: "preserved", VITE_AIRSHIP_ENABLE_LOCAL_LAB: "0" };
    const result = labEnvironment(source);
    expect(source).toEqual({ PATH: "/test/bin", CUSTOM: "preserved", VITE_AIRSHIP_ENABLE_LOCAL_LAB: "0" });
    expect(result).toMatchObject({
      PATH: "/test/bin",
      CUSTOM: "preserved",
      AIRSHIP_LOCAL_S3_ENDPOINT: LOCAL_LAB.s3Endpoint,
      AIRSHIP_LOCAL_S3_BUCKET: LOCAL_LAB.bucket,
      AIRSHIP_LOCAL_S3_ACCESS_KEY: LOCAL_LAB.accessKeyId,
      VITE_AIRSHIP_ENABLE_LOCAL_LAB: "1",
      VITE_AIRSHIP_DEFAULT_VAULT_PROVIDER: "google-drive",
      VITE_GOOGLE_CLIENT_ID: LOCAL_LAB_GOOGLE_CLIENT_ID,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("gates the release half of the suite on a stock build, whatever the shell exported", () => {
    // `npm run check` builds and gates the artifact this project ships, and the
    // gate refuses one that carries the lab. An exported opt-in must not make
    // `lab:test` fail on a bundle nobody releases.
    const source = { PATH: "/test/bin", VITE_AIRSHIP_ENABLE_LOCAL_LAB: "1" };
    const result = stockBuildEnvironment(source);
    expect(source.VITE_AIRSHIP_ENABLE_LOCAL_LAB).toBe("1");
    expect(result).toMatchObject({ PATH: "/test/bin", VITE_AIRSHIP_ENABLE_LOCAL_LAB: "0" });
    expect(stockBuildEnvironment({}).VITE_AIRSHIP_ENABLE_LOCAL_LAB).toBe("0");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("preserves an operator-provided Google registration in the lab", () => {
    const result = labEnvironment({ VITE_GOOGLE_CLIENT_ID: "operator-client.apps.googleusercontent.com" });
    expect(result.VITE_GOOGLE_CLIENT_ID).toBe("operator-client.apps.googleusercontent.com");
  });

  it("confines the published lab endpoint and console to IPv4 loopback", () => {
    expect(new URL(LOCAL_LAB.s3Endpoint).hostname).toBe("127.0.0.1");
    expect(new URL(LOCAL_LAB.s3Console).hostname).toBe("127.0.0.1");
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
