import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../core/journal";
import { modelSwitchNeedsCompressionGate, planModelSwitch } from "./model-switch-plan";

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
        transportBoundary: "provider-tls" as const,
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

const pin = { providerId: "openai", connectionId: "conn-1", model: "model-a" };

describe("planModelSwitch", () => {
  it("choosing the thread's current model with no override is a no-op", () => {
    expect(planModelSwitch({
      activeSession: session(pin),
      targetModelId: "model-a",
    })).toEqual({ kind: "noop" });
  });

  it("choosing another model changes the visible thread in place — no fork arm exists", () => {
    const s = session(pin);
    expect(planModelSwitch({
      activeSession: s,
      targetModelId: "model-b",
    })).toEqual({ kind: "in-place", session: s });
  });

  it("re-selecting the active override is a no-op, even though it differs from the pin", () => {
    expect(planModelSwitch({
      activeSession: session(pin, "model-b"),
      targetModelId: "model-b",
    })).toEqual({ kind: "noop" });
  });

  it("choosing the pinned model while an override is active is a real change back", () => {
    const s = session(pin, "model-b");
    expect(planModelSwitch({
      activeSession: s,
      targetModelId: "model-a",
    })).toEqual({ kind: "in-place", session: s });
  });

  it("the plan is provider-neutral: any provider's thread earns the same in-place route", () => {
    for (const providerId of ["chutes", "openai", "anthropic", "xai", "ollama", "lm-studio"]) {
      const s = session({ providerId, connectionId: `conn-${providerId}`, model: "model-a" });
      expect(planModelSwitch({ activeSession: s, targetModelId: "model-b" }))
        .toEqual({ kind: "in-place", session: s });
    }
  });

  it("with no visible thread there is nothing to change", () => {
    expect(planModelSwitch({ targetModelId: "model-b" })).toEqual({ kind: "noop" });
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
