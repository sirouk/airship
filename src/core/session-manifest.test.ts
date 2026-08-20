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

  it("snapshots caller-owned authority fields once before hashing", async () => {
    const reads = new Map<string, number>();
    const once = <T>(name: string, value: T): T => {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      return value;
    };
    const args = {
      get systemPrompt() { return once("systemPrompt", "Pinned accessor prompt"); },
      get providerId() { return once("providerId", "ollama"); },
      get model() { return once("model", "gemma3:latest"); },
      get inferenceBinding() {
        return once("inferenceBinding", {
          version: 2 as const,
          connectionId: "ollama-loopback",
          connectionGeneration: 1,
          providerId: "ollama",
          providerLabel: "Ollama",
          providerRevision: 1,
          authMethod: "local-none" as const,
          transportBoundary: "loopback-local" as const,
          modelId: "gemma3:latest",
          boundAt: "2026-08-20T00:00:00.000Z",
          transportId: "ollama-openai-local-v1",
          protocol: "openai-compatible" as const,
        });
      },
      get tools() { return once("tools", []); },
      get workspaceId() { return once("workspaceId", "workspace"); },
      get now() { return once("now", "2026-08-20T00:00:00.000Z"); },
    };

    await expect(createSessionManifest(args)).resolves.toMatchObject({
      providerId: "ollama",
      model: "gemma3:latest",
      inferenceBinding: { transportId: "ollama-openai-local-v1" },
    });
    expect(Object.fromEntries(reads)).toEqual({
      systemPrompt: 1,
      providerId: 1,
      model: 1,
      inferenceBinding: 1,
      tools: 1,
      workspaceId: 1,
      now: 1,
    });
  });

  it("requires current v2 bindings to match the canonical provider and model pins", async () => {
    const binding = {
      version: 2 as const,
      connectionId: "ollama-loopback",
      connectionGeneration: 1,
      providerId: "ollama",
      providerLabel: "Ollama",
      providerRevision: 1,
      authMethod: "local-none" as const,
      transportBoundary: "loopback-local" as const,
      modelId: "gemma3:latest",
      boundAt: "2026-08-20T00:00:00.000Z",
      transportId: "ollama-openai-local-v1",
      protocol: "openai-compatible" as const,
    };
    const create = (providerId: string, model: string) => createSessionManifest({
      systemPrompt: "Pinned system prompt",
      providerId,
      model,
      tools: [],
      workspaceId: "workspace",
      inferenceBinding: binding,
    });

    await expect(create("other-provider", binding.modelId)).rejects.toThrow(/inference binding does not match/u);
    await expect(create(binding.providerId, "other-model")).rejects.toThrow(/inference binding does not match/u);
    await expect(create(binding.providerId, binding.modelId)).resolves.toMatchObject({
      providerId: "ollama",
      inferenceBinding: { transportId: "ollama-openai-local-v1" },
    });
  });
});
