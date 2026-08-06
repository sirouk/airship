import { describe, expect, it, vi } from "vitest";
import { LmStudioBrowserProvider } from "./lm-studio";
import { OllamaBrowserProvider } from "./ollama";

describe("Ollama browser provider", () => {
  it("confirms browser-direct health and reports the live Ollama version", async () => {
    const provider = new OllamaBrowserProvider({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        expect(new URL(String(input)).pathname).toBe("/api/version");
        return json({ version: "0.12.3" });
      }) as typeof fetch,
    });
    await expect(provider.probeHealth()).resolves.toMatchObject({
      provider: "ollama",
      state: "ready",
      version: "0.12.3",
      cors: "confirmed",
    });
  });

  it("discovers the advertised directory without probing or loading each model", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("http://127.0.0.1:11434");
      expect(init?.credentials).toBe("omit");
      if (url.pathname === "/api/tags") {
        return json({
          models: [
            {
              name: "gemma3:latest",
              size: 3_338_801_804,
              digest: "sha256:model",
              modified_at: "2026-07-20T00:00:00Z",
              capabilities: ["completion", "vision", "tools"],
              details: {
                format: "gguf",
                family: "gemma3",
                parameter_size: "4.3B",
                quantization_level: "Q4_K_M",
              },
            },
            { name: "qwen3:latest", capabilities: ["completion", "thinking"] },
          ],
        });
      }
      throw new Error(`unexpected per-model request: ${url.pathname}`);
    }) as typeof fetch;
    const provider = new OllamaBrowserProvider({ fetch: fetchMock });

    const snapshot = await provider.discoverModels();

    expect(snapshot.complete).toBe(true);
    expect(snapshot.models).toHaveLength(2);
    expect(snapshot.models[0]).toMatchObject({
      id: "gemma3:latest",
      provider: "ollama",
      format: "gguf",
      quantization: "Q4_K_M",
    });
    expect(capability(snapshot.models[0]!, "tools")).toMatchObject({
      state: "supported",
      source: "/api/tags:capabilities",
    });
    expect(capability(snapshot.models[1]!, "vision").state).toBe("unsupported");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps discovery useful with unknown capability evidence when the directory omits it", async () => {
    const provider = new OllamaBrowserProvider({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/tags") return json({ models: [{ name: "offline-details" }] });
        throw new Error(`unexpected per-model request: ${url.pathname}`);
      }) as typeof fetch,
    });
    const snapshot = await provider.discoverModels();
    expect(snapshot.complete).toBe(true);
    expect(capability(snapshot.models[0]!, "tools").state).toBe("unknown");
    expect(snapshot.diagnostics).toEqual([]);
  });
});

describe("LM Studio browser provider", () => {
  it("confirms browser-direct health through the current native model endpoint", async () => {
    const provider = new LmStudioBrowserProvider({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        expect(new URL(String(input)).pathname).toBe("/api/v1/models");
        return json({ models: [] });
      }) as typeof fetch,
    });
    await expect(provider.probeHealth()).resolves.toMatchObject({
      provider: "lm-studio",
      state: "ready",
      cors: "confirmed",
    });
  });

  it("takes capabilities, type, loading state, and limits from the provider response", async () => {
    const credential = "memory-only-token";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/api/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
      return json({
        models: [
          {
            key: "qwen-vl",
            type: "llm",
            loaded_instances: [{ id: "qwen-vl", config: { context_length: 8_192 } }],
            capabilities: { trained_for_tool_use: true, vision: true },
            max_context_length: 32_768,
            architecture: "qwen2_vl",
            format: "gguf",
            quantization: { name: "Q4_K_M", bits_per_weight: 4 },
          },
          {
            key: "nomic-embed",
            type: "embedding",
            loaded_instances: [],
          },
        ],
      });
    }) as typeof fetch;
    const provider = new LmStudioBrowserProvider({
      credential: () => credential,
      fetch: fetchMock,
    });

    const snapshot = await provider.discoverModels();

    expect(snapshot.models[0]).toMatchObject({
      id: "qwen-vl",
      state: "loaded",
      contextTokens: 32_768,
    });
    expect(capability(snapshot.models[0]!, "tools").state).toBe("supported");
    expect(capability(snapshot.models[0]!, "vision")).toMatchObject({
      state: "supported",
      source: "/api/v1/models:capabilities.vision",
    });
    expect(capability(snapshot.models[1]!, "embeddings").state).toBe("supported");
    expect(JSON.stringify(snapshot)).not.toContain(credential);
  });

  it("falls back to the documented v0 model catalog only for an unavailable v1 route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/models") return new Response("", { status: 404 });
      expect(path).toBe("/api/v0/models");
      return json({
        data: [{
          id: "legacy-vlm",
          type: "vlm",
          state: "not-loaded",
          capabilities: ["tool_use"],
        }],
      });
    }) as typeof fetch;
    const snapshot = await new LmStudioBrowserProvider({ fetch: fetchMock }).discoverModels();
    expect(snapshot.models[0]).toMatchObject({ id: "legacy-vlm", state: "not-loaded" });
    expect(capability(snapshot.models[0]!, "tools").state).toBe("supported");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("turns an opaque direct-fetch failure into actionable browser diagnostics", async () => {
    const provider = new LmStudioBrowserProvider({
      fetch: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });
    await expect(provider.discoverModels()).rejects.toMatchObject({
      diagnostic: {
        code: "cors-or-private-network-access",
        blocking: true,
      },
    });
  });

  it("forwards discovery cancellation and labels it separately from timeout", async () => {
    const provider = new LmStudioBrowserProvider({
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason);
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      ) as typeof fetch,
    });
    const controller = new AbortController();
    const pending = provider.discoverModels(controller.signal);
    controller.abort(new DOMException("User cancelled.", "AbortError"));
    await expect(pending).rejects.toMatchObject({
      diagnostic: { code: "cancelled" },
    });
  });
});

function capability(
  model: { capabilities: readonly { capability: string; state: string; source: string }[] },
  name: string,
) {
  return model.capabilities.find((item) => item.capability === name)!;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}
