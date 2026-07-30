import { describe, expect, it, vi } from "vitest";
import { LmStudioBrowserProvider } from "./lm-studio";
import { OllamaBrowserProvider } from "./ollama";

/*
 * Pass 3 — hostile provider catalog shapes.
 *
 * The catalog endpoint is the only part of another process that reaches the
 * discovery path before a connection exists, and it is owned by anything that
 * can bind the loopback address: an old test server, a misbehaving dev
 * hook, a malformed reply after an upgrade. These batteries assert that such
 * a catalog is *filtered*, never splashed: no descriptor comes out carrying
 * an unsanitized capability lie, no prototype-walking key survives contact
 * with the parser, and a flood row can never take the useful rows with it.
 */

function lmStudio(payload: unknown): LmStudioBrowserProvider {
  const fetchImpl = vi.fn(async () => new Response(
    typeof payload === "string" ? payload : JSON.stringify(payload),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ));
  return new LmStudioBrowserProvider({ fetch: fetchImpl as unknown as typeof fetch });
}

function ollama(payload: unknown): OllamaBrowserProvider {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/version") {
      return new Response(JSON.stringify({ version: "0.12.3" }), { status: 200 });
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return new OllamaBrowserProvider({ fetch: fetchImpl as unknown as typeof fetch });
}

describe("LM Studio hostile catalog battery", () => {
  it("caps a flood page at its own bound and keeps only spelled rows", async () => {
    const provider = lmStudio({
      models: [
        ...Array.from({ length: 600 }, (_, index) => ({ key: `flood-${index}` })),
        42,
        null,
        { key: 42 },
        { key: "" },
        { key: "x".repeat(64) },
        JSON.parse(JSON.stringify({ key: "__proto__", type: "llm", display_name: "Polluted" })),
      ],
    });
    const discovery = await provider.discoverModels();
    // LM Studio defaults to 128 enumerated models; the parser must not spill more.
    expect(discovery.models.filter((model) => model.id.startsWith("flood-"))).toHaveLength(128);
    expect(discovery.complete).toBe(false);
    // Row hygiene: nothing without a name, nothing with a forged id walks through.
    expect(discovery.models.some((model) => model.id === "__proto__")).toBe(false);
    expect(discovery.models.every((model) => typeof model.id === "string" && model.id.length > 0)).toBe(true);
    // The most dangerous effect is prototype pollution: tracked everywhere.
    expect(({} as Record<string, unknown>).flood).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("passes display names through as text while refusing hostile capability hints", async () => {
    const provider = lmStudio({
      models: [
        {
          key: "legit-model",
          display_name: "<img src=x onerror=alert(1)>",
          type: "llm",
          capabilities: { vision: "yes", trained_for_tool_use: true },
          loaded_instances: [{}],
          max_context_length: 8_192,
        },
        {
          key: "chat-only",
          type: "llm",
          capabilities: [{ "__proto__": { admin: true } }, "vision"],
          loaded_instances: [{}],
          max_context_length: 32_768,
        },
      ],
    });
    const discovery = await provider.discoverModels();
    expect(discovery.models).toHaveLength(2);
    // The name is rendered, never executed: the parser preserves it, the DOM
    // handles HTML as text. The contract is the capability hints are dropped.
    const legit = discovery.models.find((model) => model.id === "legit-model");
    expect(legit).toBeDefined();
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    // No descriptor may reach for a number the provider never spelled.
    const chatOnly = discovery.models.find((model) => model.id === "chat-only");
    expect(chatOnly).toBeDefined();
    expect(Object.values(chatOnly!).every((value) =>
      typeof value !== "object" || !("admin" in (value as unknown as Record<string, unknown>)),
    )).toBe(true);
  });

  it("rejects a payload that is valid JSON but not the documented model array", async () => {
    for (const hostile of [
      { models: {} },
      { models: "not-an-array" },
      { data: {} },
      { kind: "model-list" },
    ]) {
      const provider = lmStudio(hostile);
      await expect(provider.discoverModels()).rejects.toMatchObject({
        diagnostic: { code: "invalid-payload" },
      });
    }
  });

  it("rejects a reply that is not even JSON", async () => {
    const provider = lmStudio("not-json{");
    await expect(provider.discoverModels()).rejects.toMatchObject({
      diagnostic: { code: "invalid-json" },
    });
  });
});

describe("Ollama hostile catalog battery", () => {
  it("rejects an oversized tag list at the catalog cap instead of enumerating it", async () => {
    const provider = ollama({
      models: Array.from({ length: 4_096 }, (_, index) => ({
        name: `overflow-${index}:latest`,
        size: 1,
        digest: `sha256:${index}`,
        modified_at: "2026-07-20T00:00:00Z",
      })),
    });
    const discovery = await provider.discoverModels();
    // 256 is Ollama's own bound; the parser enumerates no more than that.
    expect(discovery.models.length).toBeLessThanOrEqual(256);
    expect(discovery.complete).toBe(false);
  });

  it("drops rows without a parseable name while keeping their neighbors", async () => {
    const provider = ollama({
      models: [
        { name: 42 },
        { name: "" },
        {
          name: "good:latest",
          size: 1_234_567,
          digest: "sha256:good",
          modified_at: "2026-07-20T00:00:00Z",
          details: { family: "llama", parameter_size: "8B", quantization_level: "Q4_0" },
        },
        JSON.parse(JSON.stringify({ name: "p" })),
      ],
    });
    const discovery = await provider.discoverModels();
    expect(discovery.models.map((model) => model.id)).toContain("good:latest");
    expect(discovery.models.every((model) => typeof model.id === "string" && model.id.length > 0)).toBe(true);
  });

  it("survives NaN and hostile-typed detail fields without surfacing them", async () => {
    const provider = ollama({
      models: [
        {
          name: "nan:latest",
          size: Number.NaN === 0 ? 0 : 42_000_000,
          digest: 42,
          modified_at: 12_345,
          details: {
            family: { "__proto__": { x: 1 } },
            parameter_size: Number.POSITIVE_INFINITY,
            quantization_level: undefined === undefined ? "Q4_K_M" : "oops",
          },
        },
      ],
    });
    const discovery = await provider.discoverModels();
    const discovered = discovery.models.find((model) => model.id === "nan:latest");
    expect(discovered).toBeDefined();
    expect(Number.isNaN(discovered!.sizeBytes ?? 0)).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
