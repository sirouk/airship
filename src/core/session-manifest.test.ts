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

  it("snapshots every caller-owned authority field once before hashing", async () => {
    const reads = new Map<string, number>();
    const once = <T>(name: string, value: T): T => {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      return value;
    };
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
    const tools = [{
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" },
      effect: "read" as const,
    }];
    const profile = {
      version: 1 as const,
      profileId: "profile-a",
      profileRevision: "revision-a",
      themeId: "theme-a",
      themeDigest: "theme-digest-a",
      resolvedSkills: [],
      skillSetDigest: "skill-digest-a",
      resolutionDigest: "resolution-a",
    };
    const lineage = {
      version: 1 as const,
      kind: "fork" as const,
      sourceSessionId: "source-session",
      sourceHeadSequence: 7,
      sourceHeadDigest: "source-head",
      forkedAt: "2026-08-19T00:00:00.000Z",
    };
    const contextPolicy = {
      version: 1 as const,
      contextWindowTokens: 8_192,
      contextWindowSource: { kind: "runtime-config" as const, label: "runtime-a" },
      compression: {
        strategy: "iterative-reference-delta-v1" as const,
        thresholdBasisPoints: 8_200,
        targetRatioBasisPoints: 6_000,
        preserveRecentTurns: 2,
        maxSummaryDeltaBytes: 2_048,
        summarizer: { mode: "extractive-fallback" as const },
      },
    };
    const args = {
      get systemPrompt() { return once("systemPrompt", "Pinned accessor prompt"); },
      get providerId() { return once("providerId", "ollama"); },
      get model() { return once("model", "gemma3:latest"); },
      get inferenceBinding() { return once("inferenceBinding", binding); },
      get tools() { return once("tools", tools); },
      get workspaceId() { return once("workspaceId", "workspace"); },
      get profile() { return once("profile", profile); },
      get securityPosture() { return once("securityPosture", "local" as const); },
      get lineage() { return once("lineage", lineage); },
      get contextPolicy() { return once("contextPolicy", contextPolicy); },
      get turnContext() { return once("turnContext", "required" as const); },
      get capabilityTier() { return once("capabilityTier", "web-enhanced" as const); },
      get now() { return once("now", "2026-08-20T00:00:00.000Z"); },
    };

    const pending = createSessionManifest(args);
    expect(Object.fromEntries(reads)).toEqual({
      systemPrompt: 1,
      providerId: 1,
      model: 1,
      inferenceBinding: 1,
      tools: 1,
      workspaceId: 1,
      profile: 1,
      securityPosture: 1,
      lineage: 1,
      contextPolicy: 1,
      turnContext: 1,
      capabilityTier: 1,
      now: 1,
    });

    // The first digest await cannot reopen caller authority.
    binding.connectionId = "mutated-connection";
    tools[0].name = "mutated_tool";
    profile.profileId = "mutated-profile";
    lineage.sourceSessionId = "mutated-source";
    contextPolicy.contextWindowSource.label = "mutated-runtime";

    await expect(pending).resolves.toMatchObject({
      providerId: "ollama",
      model: "gemma3:latest",
      inferenceBinding: {
        connectionId: "ollama-loopback",
        transportId: "ollama-openai-local-v1",
      },
      tools: [{ name: "read_file" }],
      profile: { profileId: "profile-a" },
      securityPosture: "local",
      lineage: { sourceSessionId: "source-session" },
      contextPolicy: { contextWindowSource: { label: "runtime-a" } },
      turnContext: "required",
      capabilityTier: "web-enhanced",
      createdAt: "2026-08-20T00:00:00.000Z",
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
