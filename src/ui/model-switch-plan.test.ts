import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../core/journal";
import { modelSwitchNeedsCompressionGate, planChutesModelSwitch } from "./model-switch-plan";

function session(pin: { providerId: string; connectionId: string; model: string }, override?: string): SessionRecord {
  return {
    id: "s-1",
    title: "thread",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    headSequence: 7,
    headDigest: "d",
    ...(override !== undefined ? { modelOverride: override } : {}),
    manifest: {
      protocolVersion: 2,
      turnContext: "disabled",
      systemPrompt: "",
      systemPromptDigest: "d",
      providerId: pin.providerId,
      model: pin.model,
      inferenceBinding: Object.freeze({
        version: 1 as const,
        connectionId: pin.connectionId,
        connectionGeneration: 1,
        providerId: pin.providerId,
        providerLabel: pin.providerId,
        providerRevision: 1,
        authMethod: "api-key" as const,
        transportBoundary: "e2ee-attestable" as const,
        modelId: pin.model,
        boundAt: "2026-08-06T00:00:00.000Z",
      }),
      toolManifestDigest: "d",
      tools: [],
      workspaceId: "w",
      capabilityTier: "web-baseline" as const,
      createdAt: "2026-08-06T00:00:00.000Z",
    },
  };
}

const chutesPin = { providerId: "chutes", connectionId: "conn-1", model: "model-a" };

describe("planChutesModelSwitch", () => {
  it("choosing the connection model with no override is a no-op", () => {
    expect(planChutesModelSwitch({
      reconnectIntent: false,
      activeSession: session(chutesPin),
      connectionId: "conn-1",
      connectionModel: "model-a",
      activeConnection: true,
      targetModelId: "model-a",
    })).toEqual({ kind: "noop" });
  });

  it("choosing another model on a thread pinning this connection changes in place", () => {
    const s = session(chutesPin);
    expect(planChutesModelSwitch({
      reconnectIntent: false,
      activeSession: s,
      connectionId: "conn-1",
      connectionModel: "model-a",
      activeConnection: true,
      targetModelId: "model-b",
    })).toEqual({ kind: "in-place", session: s });
  });

  it("re-selecting the active override is a no-op, even though it differs from the pin", () => {
    expect(planChutesModelSwitch({
      reconnectIntent: false,
      activeSession: session(chutesPin, "model-b"),
      connectionId: "conn-1",
      connectionModel: "model-a",
      activeConnection: true,
      targetModelId: "model-b",
    })).toEqual({ kind: "noop" });
  });

  it("choosing the pinned model while an override is active is a real change back", () => {
    const s = session(chutesPin, "model-b");
    expect(planChutesModelSwitch({
      reconnectIntent: false,
      activeSession: s,
      connectionId: "conn-1",
      connectionModel: "model-a",
      activeConnection: true,
      targetModelId: "model-a",
    })).toEqual({ kind: "in-place", session: s });
  });

  it("a thread pinned to a different connection still forks", () => {
    expect(planChutesModelSwitch({
      reconnectIntent: false,
      activeSession: session({ ...chutesPin, connectionId: "conn-old" }),
      connectionId: "conn-1",
      connectionModel: "model-a",
      activeConnection: true,
      targetModelId: "model-b",
    })).toEqual({ kind: "fork" });
  });

  it("a reconnect request never takes the in-place route", () => {
    expect(planChutesModelSwitch({
      reconnectIntent: true,
      activeSession: session(chutesPin),
      connectionId: "conn-1",
      connectionModel: "model-a",
      activeConnection: true,
      targetModelId: "model-b",
    })).toEqual({ kind: "fork" });
  });

  it("an external-provider thread never changes a Chutes connection in place", () => {
    expect(planChutesModelSwitch({
      reconnectIntent: false,
      activeSession: session({ providerId: "openai", connectionId: "oa-1", model: "gpt-5" }),
      connectionId: "conn-1",
      connectionModel: "model-a",
      activeConnection: true,
      targetModelId: "model-b",
    })).toEqual({ kind: "fork" });
  });

  it("with no visible thread, choosing the standby connection's model is a no-op and anything else forks", () => {
    const base = { reconnectIntent: false, connectionId: "conn-1", connectionModel: "model-a", activeConnection: true } as const;
    expect(planChutesModelSwitch({ ...base, targetModelId: "model-a" })).toEqual({ kind: "noop" });
    expect(planChutesModelSwitch({ ...base, targetModelId: "model-b" })).toEqual({ kind: "fork" });
  });
});

describe("modelSwitchNeedsCompressionGate", () => {
  it("speaks only when the window is smaller than measured use", () => {
    expect(modelSwitchNeedsCompressionGate(9_000, 8_000)).toBe(true);
    expect(modelSwitchNeedsCompressionGate(8_000, 8_000)).toBe(false);
    expect(modelSwitchNeedsCompressionGate(1_000, 8_000)).toBe(false);
  });

  it("stays silent when either side cannot be measured honestly", () => {
    expect(modelSwitchNeedsCompressionGate(undefined, 8_000)).toBe(false);
    expect(modelSwitchNeedsCompressionGate(9_000, undefined)).toBe(false);
    expect(modelSwitchNeedsCompressionGate(undefined, undefined)).toBe(false);
  });
});
