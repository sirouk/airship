import { describe, expect, it, vi } from "vitest";
import type { InferenceTransport } from "../../core/contracts";
import type {
  BrowserLocalModelProvider,
  LocalModelDiscovery,
} from "./contracts";
import { connectLocalProvider, toInferenceModelDescriptors } from "./catalog-adapter";

describe("local provider catalog adapter", () => {
  it("preserves live capability evidence without inventing parallel tools or vision", () => {
    const [model] = toInferenceModelDescriptors(discovery(), binding());
    expect(model).toMatchObject({
      connectionId: "connection-local",
      connectionGeneration: 3,
      providerId: "ollama",
      id: "agent-model",
      availability: { state: "available", source: "local-discovery", code: "jit-load" },
      contextWindowTokens: 32_768,
    });
    expect(model?.capabilities).toMatchObject({
      "text-input": { state: "supported", source: "local-discovery" },
      "text-output": { state: "supported", source: "local-discovery" },
      "image-input": { state: "unknown", source: "local-discovery" },
      "tool-calling": { state: "supported", source: "local-discovery" },
      reasoning: { state: "unsupported", source: "local-discovery" },
    });
    expect(model?.capabilities["parallel-tool-calling"]).toBeUndefined();
    expect(model?.capabilities["structured-output"]).toBeUndefined();
  });

  it("returns the transport from the same provider instance used for discovery", async () => {
    const transport: InferenceTransport = {
      id: "local-test",
      posture: "local",
      async *stream() {
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const provider: BrowserLocalModelProvider = {
      kind: "ollama",
      endpoint: new URL("http://127.0.0.1:11434"),
      probeHealth: vi.fn(),
      discoverModels: vi.fn(async () => discovery()),
      createTransport: vi.fn(() => transport),
    };
    const connected = await connectLocalProvider(provider, binding());
    expect(connected.transport).toBe(transport);
    expect(connected.models).toHaveLength(1);
    expect(provider.discoverModels).toHaveBeenCalledTimes(1);
    expect(provider.createTransport).toHaveBeenCalledTimes(1);
  });
});

function binding() {
  return {
    connectionId: "connection-local",
    connectionGeneration: 3,
    providerId: "ollama",
  } as const;
}

function discovery(): LocalModelDiscovery {
  return {
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    fetchedAt: "2026-07-24T01:00:00.000Z",
    models: [{
      id: "agent-model",
      provider: "ollama",
      state: "not-loaded",
      capabilities: [
        { capability: "text-generation", state: "supported", source: "/api/show:capabilities" },
        { capability: "tools", state: "supported", source: "/api/show:capabilities" },
        { capability: "vision", state: "unknown", source: "/api/show:capabilities" },
        { capability: "embeddings", state: "unsupported", source: "/api/show:capabilities" },
        { capability: "thinking", state: "unsupported", source: "/api/show:capabilities" },
      ],
      contextTokens: 32_768,
    }],
    diagnostics: [],
    complete: true,
  };
}

