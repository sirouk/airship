import { describe, expect, it, vi } from "vitest";
import {
  CHUTES_EMBEDDING_DIMENSIONS,
  CHUTES_EMBEDDING_ENDPOINT,
  CHUTES_EMBEDDING_MODEL,
  ChutesEmbeddingError,
  ChutesEmbeddingProvider,
} from "./chutes-embeddings";

function vector(fill: number, length = CHUTES_EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length }, () => fill);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function provider(fetchImpl: typeof globalThis.fetch, token: string | undefined = "cpk_test") {
  return new ChutesEmbeddingProvider({ token: () => token, fetch: fetchImpl });
}

describe("ChutesEmbeddingProvider request", () => {
  it("posts OpenAI-compatible shape to the embedding chute with a bearer token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{ index: 0, embedding: vector(0.1) }],
    }));

    await provider(fetchImpl as unknown as typeof globalThis.fetch).embed(["hello"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CHUTES_EMBEDDING_ENDPOINT);
    // Not llm.chutes.ai: that host serves the chat router and answers 404 here.
    expect(url).not.toContain("llm.chutes.ai");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cpk_test");
    // Chutes documents that X-API-Key is not a supported inference auth scheme.
    expect(headers["X-API-Key"]).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({ model: CHUTES_EMBEDDING_MODEL, input: ["hello"] });
  });

  it("declares a confidential-remote posture, never local", async () => {
    const instance = provider(vi.fn() as unknown as typeof globalThis.fetch);
    expect(instance.posture).toBe("confidential-remote");
    expect(instance.dimensions).toBe(4096);
  });

  it("batches large inputs rather than sending one unbounded request", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)).input as string[];
      return jsonResponse({ data: sent.map((_, index) => ({ index, embedding: vector(0.2) })) });
    });

    const texts = Array.from({ length: 130 }, (_, index) => `chunk ${index}`);
    const vectors = await provider(fetchImpl as unknown as typeof globalThis.fetch).embed(texts);

    expect(vectors).toHaveLength(130);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns nothing and calls nothing for an empty input", async () => {
    const fetchImpl = vi.fn();
    expect(await provider(fetchImpl as unknown as typeof globalThis.fetch).embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ChutesEmbeddingProvider failure is loud", () => {
  it("refuses when Chutes is not connected instead of returning an empty corpus", async () => {
    const fetchImpl = vi.fn();
    // Built directly rather than through the helper: passing `undefined` to a
    // parameter with a default gets the default, which is how this test first
    // passed a token while claiming not to.
    const disconnected = new ChutesEmbeddingProvider({
      token: () => undefined,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });

    await expect(disconnected.embed(["x"])).rejects.toThrow(/not connected/iu);
    expect(fetchImpl, "an unconnected provider must not reach the network").not.toHaveBeenCalled();
  });

  it("names the anonymous rate-limit path on 429, because that is what a bad key looks like", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    await expect(provider(fetchImpl as unknown as typeof globalThis.fetch).embed(["x"]))
      .rejects.toThrow(/rate-limited/iu);
  });

  it("refuses a vector of unexpected width rather than reshaping it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{ index: 0, embedding: vector(0.1, 1024) }],
    }));

    await expect(provider(fetchImpl as unknown as typeof globalThis.fetch).embed(["x"]))
      .rejects.toThrow(/1024-dimension vector where this index expects 4096/iu);
  });

  it("refuses a short batch rather than silently dropping a chunk", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{ index: 0, embedding: vector(0.1) }],
    }));

    await expect(provider(fetchImpl as unknown as typeof globalThis.fetch).embed(["a", "b"]))
      .rejects.toThrow(/Asked for 2 embeddings and received 1/iu);
  });

  it("surfaces a transport failure rather than swallowing it", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    await expect(provider(fetchImpl as unknown as typeof globalThis.fetch).embed(["x"]))
      .rejects.toThrow(/could not be reached/iu);
  });
});

describe("ChutesEmbeddingProvider ordering", () => {
  it("honours `index` so a vector never lands on the wrong chunk", async () => {
    // The provider returns the batch reversed, which an OpenAI-compatible
    // endpoint is entitled to do.
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [
        { index: 1, embedding: vector(0.9) },
        { index: 0, embedding: vector(0.1) },
      ],
    }));

    const [first, second] = await provider(fetchImpl as unknown as typeof globalThis.fetch)
      .embed(["first", "second"]);

    expect(first?.[0]).toBeCloseTo(0.1);
    expect(second?.[0]).toBeCloseTo(0.9);
  });

  it("refuses a response whose entries carry no usable index", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{ embedding: vector(0.1) }],
    }));
    await expect(provider(fetchImpl as unknown as typeof globalThis.fetch).embed(["x"]))
      .rejects.toThrow(/no usable `index`/iu);
  });

  it("refuses a response with no data array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ object: "list" }));
    await expect(provider(fetchImpl as unknown as typeof globalThis.fetch).embed(["x"]))
      .rejects.toThrow(/no `data` array/iu);
  });
});

describe("ChutesEmbeddingError", () => {
  it("is distinguishable so a caller can tell a connection problem from a bug", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    await expect(provider(fetchImpl as unknown as typeof globalThis.fetch).embed(["x"]))
      .rejects.toBeInstanceOf(ChutesEmbeddingError);
  });
});
