import { describe, expect, it } from "vitest";
import { createSessionManifest } from "./session-manifest";

describe("session manifest protocol", () => {
  it("emits protocol v2 with an explicit disabled retrieval policy by default", async () => {
    const manifest = await createSessionManifest({
      systemPrompt: "Pinned system prompt",
      providerId: "provider",
      model: "model",
      tools: [],
      workspaceId: "workspace",
    });

    expect(manifest).toMatchObject({
      protocolVersion: 2,
      turnContext: "disabled",
    });
  });

  it("pins required retrieval into protocol v2", async () => {
    const manifest = await createSessionManifest({
      systemPrompt: "Pinned system prompt",
      providerId: "provider",
      model: "model",
      tools: [],
      workspaceId: "workspace",
      turnContext: "required",
    });

    expect(manifest.protocolVersion).toBe(2);
    expect(manifest.turnContext).toBe("required");
  });

  it("pins a credential-free connection generation without serializing authority", async () => {
    const manifest = await createSessionManifest({
      systemPrompt: "Pinned system prompt",
      providerId: "openai-responses-v1",
      model: "model-a",
      tools: [],
      workspaceId: "workspace",
      inferenceBinding: {
        version: 1,
        connectionId: "openai-main",
        connectionGeneration: 2,
        providerId: "openai",
        providerLabel: "OpenAI",
        providerRevision: 1,
        authMethod: "api-key",
        transportBoundary: "provider-tls",
        modelId: "model-a",
        boundAt: "2026-07-24T23:00:00.000Z",
      },
    });

    expect(manifest.inferenceBinding).toMatchObject({
      connectionId: "openai-main",
      connectionGeneration: 2,
      modelId: "model-a",
    });
    expect(JSON.stringify(manifest)).not.toMatch(/credential|token|secret|scope/iu);
  });
});
