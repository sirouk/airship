import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActiveChutesConnection } from "../auth/connection";
import {
  activeConnectionProofLabel,
  modelControlOptions,
  safeModelControlErrorMessage,
} from "./model-control";

const source = readFileSync(new URL("./model-control.tsx", import.meta.url), "utf8");

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

describe("provider-neutral model control", () => {
  it("retains a pinned model when a refreshed catalog no longer lists it", () => {
    expect(modelControlOptions([
      { id: "new-model", label: "New model", detail: "Vision" },
    ], "pinned-model")).toEqual([
      {
        value: "pinned-model",
        label: "pinned-model",
        description: "Current pinned model · catalog details unavailable",
      },
      {
        value: "new-model",
        label: "New model",
        description: "Vision · starts a new pinned conversation",
      },
    ]);
  });

  it("does not duplicate a pinned model already present in the live catalog", () => {
    const options = modelControlOptions([
      { id: "pinned-model", label: "Pinned model" },
      { id: "other-model", label: "Other model" },
    ], "pinned-model");
    expect(options).toHaveLength(2);
    expect(options[0]?.value).toBe("pinned-model");
  });

  it("redacts credential-shaped failure text", () => {
    const secret = "sk-examplecredential123456789";
    const message = safeModelControlErrorMessage(new Error(`Bearer token-value ${secret}`));
    expect(message).not.toContain(secret);
    expect(message).not.toContain("token-value");
    expect(message).toContain("[credential]");
  });

  it("opens the session model menu into the available stage instead of above the header", () => {
    expect(source).toContain('placement="down"');
  });
});
