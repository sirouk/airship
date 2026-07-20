import { describe, expect, it } from "vitest";
import {
  CHUTES_CAPABILITY_MATRIX,
  DISCONNECTED_CHUTES_CONNECTION,
  connectionCapabilities,
  connectionLabel,
  createChutesConnection,
  isChutesConnected,
  parseChutesCredential,
  withChutesModel,
  withVerifiedInvocation,
} from "./connection";

describe("Chutes connection domain", () => {
  it("classifies only the two supported credential prefixes", () => {
    expect(parseChutesCredential("  cak_user-token  ")).toEqual({
      kind: "oauth-user-token",
      value: "cak_user-token",
    });
    expect(parseChutesCredential("cpk_inference-key")).toEqual({
      kind: "inference-api-key",
      value: "cpk_inference-key",
    });
    expect(Object.isFrozen(parseChutesCredential("cak_frozen"))).toBe(true);
  });

  it("fails closed on unknown, incomplete, and whitespace-bearing credentials", () => {
    for (const value of ["", "cak_", "cpk_", "CAK_token", "csk_admin", "Bearer cak_token", "cak_two words", "cpk_line\nbreak"]) {
      expect(() => parseChutesCredential(value)).toThrow();
    }
  });

  it("creates mutually exclusive connection metadata without retaining the secret", () => {
    const credential = parseChutesCredential("cak_secret-never-serialize");
    const connection = createChutesConnection({
      credentialKind: credential.kind,
      model: "org/model",
      posture: "encrypted-unattested",
      connectedAt: "2026-07-18T00:00:00.000Z",
    });

    expect(connection).toMatchObject({
      kind: "chutes-oauth",
      credentialKind: "oauth-user-token",
      source: "manual-import",
      model: "org/model",
      invokeAuthorization: "unverified",
    });
    expect(JSON.stringify(connection)).not.toContain("secret-never-serialize");
    expect(Object.isFrozen(connection)).toBe(true);
    expect(isChutesConnected(connection)).toBe(true);
    expect(connectionLabel(connection)).toBe("Chutes OAuth user token");
  });

  it("resolves the explicit capability matrix for all three states", () => {
    const oauth = createChutesConnection({
      credentialKind: "oauth-user-token",
      model: "model",
      posture: "encrypted-attested",
      connectedAt: "2026-07-18T00:00:00.000Z",
    });
    const apiKey = createChutesConnection({
      credentialKind: "inference-api-key",
      model: "model",
      posture: "encrypted-unattested",
      connectedAt: "2026-07-18T00:00:00.000Z",
    });

    expect(connectionCapabilities(DISCONNECTED_CHUTES_CONNECTION)).toEqual({
      identity: false,
      account: false,
      billing: false,
      invoke: false,
    });
    expect(connectionCapabilities(oauth)).toEqual({ identity: true, account: true, billing: true, invoke: true });
    expect(connectionCapabilities(apiKey)).toEqual({ identity: true, account: true, billing: true, invoke: true });
    expect(CHUTES_CAPABILITY_MATRIX.map((row) => [row.capability, row.oauth, row.apiKey])).toEqual([
      ["identity", true, true],
      ["account", true, true],
      ["billing", true, true],
      ["invoke", true, true],
    ]);
  });

  it("rejects noncanonical timestamps and unsupported postures", () => {
    expect(() => createChutesConnection({
      credentialKind: "oauth-user-token",
      model: "model",
      posture: "encrypted-unattested",
      connectedAt: "2026-07-18",
    })).toThrow("canonical");
    expect(() => createChutesConnection({
      credentialKind: "oauth-user-token",
      model: "model",
      posture: "local" as "encrypted-attested",
    })).toThrow("posture");
  });

  it("rebinds only model metadata while preserving the credential class and connection time", () => {
    const connection = createChutesConnection({
      credentialKind: "inference-api-key",
      model: "old-model",
      posture: "encrypted-unattested",
      connectedAt: "2026-07-18T00:00:00.000Z",
    });
    const rebound = withChutesModel(connection, "new-model");
    expect(rebound).toEqual({ ...connection, model: "new-model", invokeAuthorization: "unverified" });
    expect(Object.isFrozen(rebound)).toBe(true);
    expect(withChutesModel(rebound, "new-model")).toBe(rebound);
    expect(() => withChutesModel(rebound, "bad\nmodel")).toThrow();
  });

  it("records protected invocation proof and invalidates it when the model changes", () => {
    const connection = createChutesConnection({
      credentialKind: "inference-api-key",
      model: "old-model",
      posture: "encrypted-unattested",
      connectedAt: "2026-07-18T00:00:00.000Z",
    });
    const verified = withVerifiedInvocation(connection, "2026-07-18T01:02:03.000Z");
    expect(verified.invokeAuthorization).toBe("verified");
    expect(verified.lastInvokeAt).toBe("2026-07-18T01:02:03.000Z");
    const rebound = withChutesModel(verified, "new-model");
    expect(rebound.invokeAuthorization).toBe("unverified");
    expect("lastInvokeAt" in rebound).toBe(false);
    expect(() => withVerifiedInvocation(connection, "not-a-date")).toThrow("timestamp");
  });
});
