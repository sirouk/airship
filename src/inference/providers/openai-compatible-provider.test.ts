import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleProvider } from "./openai-compatible-provider";

describe("user-owned OpenAI-compatible provider descriptors", () => {
  it("derives a cryptographic provider authority without exposing an endpoint slug", async () => {
    const provider = await createOpenAiCompatibleProvider({
      label: "My inference host",
      baseUrl: "https://models.example.test/api/v1",
      apiKeyHeader: "x-api-key",
      apiKeyScheme: "raw",
    });

    expect(provider).toMatchObject({
      version: 1,
      label: "My inference host",
      protocol: "openai-compatible",
      transportBoundary: "provider-tls",
      baseUrl: "https://models.example.test/api/v1/",
      modelsUrl: "https://models.example.test/api/v1/models",
      capabilities: ["invoke", "models:list"],
    });
    expect(provider.id).toMatch(/^openai-compatible-[a-f0-9]{64}$/u);
    expect(provider.id).not.toContain("models.example.test");
    expect(provider.documentationUrl).toBeUndefined();
    expect(provider.authMethods).toEqual([expect.objectContaining({
      kind: "api-key",
      header: { name: "x-api-key", scheme: "raw" },
    })]);
  });

  it("changes identity when any authority-bearing wire setting changes", async () => {
    const base = {
      label: "Gateway",
      baseUrl: "https://gateway.example.test/v1/",
    } as const;
    const [bearer, raw, otherCatalog] = await Promise.all([
      createOpenAiCompatibleProvider(base),
      createOpenAiCompatibleProvider({ ...base, apiKeyScheme: "raw" }),
      createOpenAiCompatibleProvider({
        ...base,
        modelsUrl: "https://catalog.example.test/models",
      }),
    ]);
    expect(new Set([bearer.id, raw.id, otherCatalog.id]).size).toBe(3);
  });

  it("separates two descriptors with a known legacy FNV-1a collision", async () => {
    const firstLabel = "Gateway qjpQaArwsj9F";
    const secondLabel = "Gateway Q9srvVh0Q1Lz";
    const legacyIdentity = (label: string) => JSON.stringify({
      label,
      baseUrl: "https://collision.example.test/v1/",
      modelsUrl: "https://collision.example.test/v1/models",
      header: "Authorization",
      scheme: "bearer",
    });
    // These exact descriptors collide under the former 32-bit identifier.
    expect(legacyFnv1a(legacyIdentity(firstLabel)))
      .toBe(legacyFnv1a(legacyIdentity(secondLabel)));

    const [first, second] = await Promise.all([
      createOpenAiCompatibleProvider({
        label: firstLabel,
        baseUrl: "https://collision.example.test/v1/",
      }),
      createOpenAiCompatibleProvider({
        label: secondLabel,
        baseUrl: "https://collision.example.test/v1/",
      }),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^openai-compatible-[a-f0-9]{64}$/u);
    expect(second.id).toMatch(/^openai-compatible-[a-f0-9]{64}$/u);
    expect(first.id).not.toContain("collision.example.test");
    expect(second.id).not.toContain("collision.example.test");
  });

  it("fails closed on insecure remote URLs, embedded credentials, fragments, or invalid headers", () => {
    expect(() => createOpenAiCompatibleProvider({
      label: "Insecure",
      baseUrl: "http://models.example.test/v1/",
    })).toThrow("must use HTTPS");
    expect(() => createOpenAiCompatibleProvider({
      label: "Embedded",
      baseUrl: "https://user:secret@models.example.test/v1/",
    })).toThrow("invalid");
    expect(() => createOpenAiCompatibleProvider({
      label: "Fragment",
      baseUrl: "https://models.example.test/v1/#key",
    })).toThrow("invalid");
    expect(() => createOpenAiCompatibleProvider({
      label: "Header",
      baseUrl: "https://models.example.test/v1/",
      apiKeyHeader: "Authorization\r\nx-secret",
    })).toThrow("header");
    expect(() => createOpenAiCompatibleProvider({
      label: "Query",
      baseUrl: "https://models.example.test/v1/?destination=elsewhere",
    })).toThrow("must not contain a query");
    expect(() => createOpenAiCompatibleProvider({
      label: "Catalog query",
      baseUrl: "https://models.example.test/v1/",
      modelsUrl: "https://catalog.example.test/models?api_key=secret",
    })).toThrow("models URL must not contain a query");
    for (const apiKeyHeader of ["Cookie", "Host", "Sec-Fetch-Site", "Proxy-Authorization"]) {
      expect(() => createOpenAiCompatibleProvider({
        label: "Forbidden header",
        baseUrl: "https://models.example.test/v1/",
        apiKeyHeader,
      })).toThrow("controlled by the browser");
    }
  });
});

function legacyFnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
