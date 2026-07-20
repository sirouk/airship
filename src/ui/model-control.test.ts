import { describe, expect, it } from "vitest";
import type { ActiveChutesConnection } from "../auth/connection";
import { activeConnectionProofLabel } from "./model-control";

describe("active model proof label", () => {
  it("shows policy before evidence and last-turn evidence only after protected invocation", () => {
    const connection: ActiveChutesConnection = {
      version: 1,
      kind: "chutes-oauth",
      credentialKind: "oauth-user-token",
      provider: "chutes",
      model: "model-1",
      connectedAt: "2026-07-20T00:00:00.000Z",
      posture: "encrypted-attested",
      source: "manual-import",
      invokeAuthorization: "unverified",
    };
    expect(activeConnectionProofLabel(connection)).toBe("E2EE · proof required");
    expect(activeConnectionProofLabel({ ...connection, invokeAuthorization: "verified", lastInvokeAt: "2026-07-20T00:01:00.000Z" })).toBe("E2EE · last turn proved");
    expect(activeConnectionProofLabel(connection, true)).toBe("E2EE · Switching…");
  });

  it("does not imply proof when the compatibility posture has no required gate", () => {
    const connection: ActiveChutesConnection = {
      version: 1,
      kind: "chutes-api-key",
      credentialKind: "inference-api-key",
      provider: "chutes",
      model: "model-1",
      connectedAt: "2026-07-20T00:00:00.000Z",
      posture: "encrypted-unattested",
      source: "manual-import",
      invokeAuthorization: "unverified",
    };
    expect(activeConnectionProofLabel(connection)).toBe("E2EE · no proof gate");
  });
});
