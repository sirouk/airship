import { describe, expect, it } from "vitest";
import type { SessionInferenceBinding, SessionManifest } from "./contracts";
import {
  assertPinnedInferenceTransport,
  assertValidSessionInferenceBinding,
  currentInferenceBinding,
  inferenceBindingsMatch,
  pinnedInferenceTransportId,
} from "./inference-binding";

const base = Object.freeze({
  connectionId: "ollama-loopback",
  connectionGeneration: 2,
  providerId: "ollama",
  providerLabel: "Ollama",
  providerRevision: 1,
  authMethod: "local-none" as const,
  transportBoundary: "loopback-local" as const,
  modelId: "gemma3:latest",
  boundAt: "2026-08-20T00:00:00.000Z",
});
const v1: SessionInferenceBinding = Object.freeze({ ...base, version: 1 });
const v2: SessionInferenceBinding = Object.freeze({
  ...base,
  version: 2,
  transportId: "ollama-openai-local-v1",
  protocol: "openai-compatible",
});
const historicalManifest = Object.freeze({
  providerId: "ollama-openai-local-v1",
  model: base.modelId,
  inferenceBinding: v1,
});

function manifest(binding?: SessionInferenceBinding): Pick<SessionManifest, "providerId" | "model" | "inferenceBinding"> {
  return { providerId: "ollama", model: base.modelId, ...(binding ? { inferenceBinding: binding } : {}) };
}

describe("session inference transport authority", () => {
  it("uses exact v2 transport identity instead of conflating it with the provider", () => {
    expect(pinnedInferenceTransportId(manifest(v2))).toBe("ollama-openai-local-v1");
    expect(assertPinnedInferenceTransport(manifest(v2), "ollama-openai-local-v1", v2)).toBe(
      "ollama-openai-local-v1",
    );
    expect(() => assertPinnedInferenceTransport(manifest(v2), "ollama-openai-local-v1"))
      .toThrow(/exact active v2 inference binding/u);
    expect(() => assertPinnedInferenceTransport(manifest(v2), "ollama", v2))
      .toThrow(/transport is pinned to ollama-openai-local-v1/u);
  });

  it("allows only the one-way v1-to-equivalent-v2 upgrade", () => {
    expect(inferenceBindingsMatch(v1, v2)).toBe(true);
    expect(inferenceBindingsMatch(v1, v1)).toBe(false);
    expect(inferenceBindingsMatch(v2, v1)).toBe(false);
    expect(currentInferenceBinding(historicalManifest, v2)).toBe(v2);
    expect(pinnedInferenceTransportId(historicalManifest, v2)).toBe("ollama-openai-local-v1");
    expect(() => pinnedInferenceTransportId(historicalManifest, v1))
      .toThrow(/cannot upgrade this historical session authority/u);
  });

  it("rejects provider, protocol, transport, and generation drift", () => {
    expect(() => pinnedInferenceTransportId(
      { providerId: "other", model: base.modelId, inferenceBinding: v2 },
      v2,
    )).toThrow(/provider and inference binding disagree/u);
    for (const drifted of [
      { ...v2, connectionGeneration: 3 },
      { ...v2, transportId: "other-transport" },
      { ...v2, protocol: "openai-responses" as const },
      { ...v2, providerId: "other" },
    ]) {
      expect(() => pinnedInferenceTransportId(manifest(v2), drifted))
        .toThrow(/does not match the session's v2 authority/u);
    }
  });

  it("reserves provider-as-transport fallback for manifests with no durable binding", () => {
    expect(currentInferenceBinding(manifest(), v2)).toBeUndefined();
    expect(pinnedInferenceTransportId(manifest())).toBe("ollama");
    expect(() => currentInferenceBinding(historicalManifest))
      .toThrow(/requires an exact active v2 inference binding/u);
    expect(() => pinnedInferenceTransportId(historicalManifest))
      .toThrow(/requires an exact active v2 inference binding/u);
    expect(() => currentInferenceBinding({
      ...historicalManifest,
      inferenceBinding: { ...v1, transportBoundary: "e2ee-attestable" },
    }, v2)).toThrow(/cannot upgrade/u);
  });

  it("projects only an explicitly durable model change onto v2 authority", () => {
    const switched = Object.freeze({ ...v2, modelId: "qwen3:latest" });
    expect(currentInferenceBinding(manifest(v2), switched, switched.modelId)).toMatchObject(switched);
    expect(assertPinnedInferenceTransport(
      manifest(v2),
      switched.transportId,
      switched,
      switched.modelId,
    )).toBe(switched.transportId);
    expect(currentInferenceBinding(manifest(v2), switched)?.modelId).toBe(base.modelId);
    expect(() => currentInferenceBinding(
      manifest(v2),
      { ...switched, connectionGeneration: switched.connectionGeneration + 1 },
      switched.modelId,
    )).toThrow(/does not match the session's v2 authority/u);
  });

  it("refuses a v1 upgrade when the legacy transport or its known protocol drifts", () => {
    expect(() => currentInferenceBinding(historicalManifest, {
      ...v2,
      transportId: "other-openai-local-v1",
    })).toThrow(/cannot upgrade/u);
    expect(() => currentInferenceBinding(historicalManifest, {
      ...v2,
      protocol: "openai-chat-completions",
    })).toThrow(/cannot upgrade/u);
  });

  it("validates exact credential-free fields before persistence", () => {
    expect(() => assertValidSessionInferenceBinding(manifest(v2))).not.toThrow();
    expect(() => assertValidSessionInferenceBinding({
      ...manifest(v2),
      inferenceBinding: { ...v2, credential: "must-not-persist" } as SessionInferenceBinding,
    })).toThrow(/unknown or missing field/u);
    expect(() => assertValidSessionInferenceBinding({
      ...manifest(v2),
      inferenceBinding: { ...v2, transportId: "bad\u0000transport" },
    })).toThrow(/supported bounded authority/u);
    expect(() => assertValidSessionInferenceBinding({
      ...manifest(v2),
      inferenceBinding: { ...v2, protocol: "unknown-wire" } as unknown as SessionInferenceBinding,
    })).toThrow(/supported bounded authority/u);
    expect(() => assertValidSessionInferenceBinding({
      ...manifest(v2),
      inferenceBinding: { ...v2, connectionGeneration: 0 },
    })).toThrow(/supported bounded authority/u);
    expect(() => assertValidSessionInferenceBinding({
      providerId: "legacy-transport",
      model: base.modelId,
      inferenceBinding: { ...v1, transportBoundary: "e2ee-attestable" },
    })).not.toThrow();
    expect(() => assertValidSessionInferenceBinding({
      ...manifest(v2),
      inferenceBinding: { ...v2, transportBoundary: "e2ee-attestable" } as unknown as SessionInferenceBinding,
    })).toThrow(/supported bounded authority/u);
  });
});
