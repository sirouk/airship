import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ChutesEmbeddingModel } from "./chutes-embedding-catalog";
import type { ConfidentialEmbeddingInvocation } from "./confidential-authority";
import {
  ChutesEmbeddingError,
  ChutesEmbeddingProvider,
  measureEmbeddingWidth,
} from "./chutes-embeddings";

/**
 * A discovered deployment, never a constant.
 *
 * Every field here arrives from `GET /chutes/?template=embedding` at runtime.
 * The values are realistic because the shape has to be, but no production code
 * path may contain any of them — `chutes-embedding-catalog.test.ts` is what
 * pins the parse, and this file only pins what the provider does with it.
 */
const MODEL: ChutesEmbeddingModel = Object.freeze({
  id: "Some/Discovered-Embedding-Model",
  chuteId: "chute-embed-0001",
  slug: "some-discovered-embedding-model",
  path: "/v1/embeddings",
  hot: true,
});

/** Deliberately not 4096: the width is whatever the deployment measured at. */
const WIDTH = 1536;

function vector(fill: number, length = WIDTH): number[] {
  return Array.from({ length }, () => fill);
}

type Invoker = (request: ConfidentialEmbeddingInvocation) => Promise<unknown>;

function provider(invoke: Invoker | undefined, dimensions = WIDTH) {
  return new ChutesEmbeddingProvider({ invoker: () => invoke, model: MODEL, dimensions });
}

describe("ChutesEmbeddingProvider request", () => {
  it("sends the OpenAI embeddings shape through the encrypted transport, not to a host of its own", async () => {
    const invoke = vi.fn<Invoker>(async () => ({ data: [{ index: 0, embedding: vector(0.1) }] }));

    await provider(invoke).embed(["hello"]);

    expect(invoke).toHaveBeenCalledTimes(1);
    const request = invoke.mock.calls[0]![0];
    // The chute and the path inside it are what `/e2e/invoke` needs in
    // `X-Chute-Id` and `X-E2E-Path`. Both are discovered.
    expect(request.chuteId).toBe(MODEL.chuteId);
    expect(request.path).toBe(MODEL.path);
    expect(request.payload).toEqual({ model: MODEL.id, input: ["hello"] });
  });

  it("carries no credential of its own: the transport owns the bearer", async () => {
    const source = await readFile(new URL("./chutes-embeddings.ts", import.meta.url), "utf8");
    // The provider used to open its own HTTPS connection with an Authorization
    // header. It now holds no fetch, no endpoint and no token.
    expect(source).not.toContain("Authorization");
    expect(source).not.toContain("Bearer");
    expect(source).not.toContain("fetch");
    expect(source).not.toContain("https://");
  });

  it("declares a confidential-remote posture, never local, and reports the measured width", () => {
    const instance = provider(vi.fn());
    expect(instance.posture).toBe("confidential-remote");
    expect(instance.dimensions).toBe(WIDTH);
    expect(instance.id).toBe(`chutes:${MODEL.id}`);
  });

  it("refuses to exist without a measured width rather than assuming one", () => {
    expect(() => provider(vi.fn(), 0)).toThrow(/measured vector width/iu);
    expect(() => provider(vi.fn(), 4096.5)).toThrow(/measured vector width/iu);
  });

  it("batches large inputs rather than sending one unbounded request", async () => {
    const invoke = vi.fn<Invoker>(async (request) => {
      const sent = (request.payload as { input: string[] }).input;
      return { data: sent.map((_, index) => ({ index, embedding: vector(0.2) })) };
    });

    const texts = Array.from({ length: 130 }, (_, index) => `chunk ${index}`);
    const vectors = await provider(invoke).embed(texts);

    expect(vectors).toHaveLength(130);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("returns nothing and calls nothing for an empty input", async () => {
    const invoke = vi.fn();
    expect(await provider(invoke).embed([])).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("ChutesEmbeddingProvider failure is loud", () => {
  it("refuses when Chutes is not connected instead of returning an empty corpus", async () => {
    // Built with no invoker at all, which is exactly what a released connection
    // leaves behind.
    const disconnected = provider(undefined);

    await expect(disconnected.embed(["x"])).rejects.toThrow(/not connected/iu);
  });

  it("keeps the transport's own sentence when an encrypted invocation fails", async () => {
    const invoke = vi.fn<Invoker>(async () => {
      throw new Error(
        "Chutes E2EE invoke failed with HTTP 429. This route is pinned to instance i-7 of chute chute-embed-0001",
      );
    });

    const failure = await provider(invoke).embed(["x"]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChutesEmbeddingError);
    // The named cause survives: a rate limit pinned to one instance is a
    // different problem from an unreachable host, and the reader needs to know
    // which one happened.
    expect(String(failure)).toMatch(/HTTP 429/u);
    expect(String(failure)).toMatch(/pinned to instance i-7/u);
    expect(String(failure)).toContain(MODEL.id);
  });

  it("refuses a vector of unexpected width rather than reshaping it", async () => {
    const invoke = vi.fn<Invoker>(async () => ({ data: [{ index: 0, embedding: vector(0.1, 1024) }] }));

    await expect(provider(invoke).embed(["x"]))
      .rejects.toThrow(new RegExp(`1024-dimension vector where this index expects ${WIDTH}`, "u"));
  });

  it("refuses a short batch rather than silently dropping a chunk", async () => {
    const invoke = vi.fn<Invoker>(async () => ({ data: [{ index: 0, embedding: vector(0.1) }] }));

    await expect(provider(invoke).embed(["a", "b"]))
      .rejects.toThrow(/Asked for 2 embeddings and received 1/iu);
  });
});

describe("ChutesEmbeddingProvider ordering", () => {
  it("honours `index` so a vector never lands on the wrong chunk", async () => {
    // The provider returns the batch reversed, which an OpenAI-compatible
    // endpoint is entitled to do.
    const invoke = vi.fn<Invoker>(async () => ({
      data: [
        { index: 1, embedding: vector(0.9) },
        { index: 0, embedding: vector(0.1) },
      ],
    }));

    const [first, second] = await provider(invoke).embed(["first", "second"]);

    expect(first?.[0]).toBeCloseTo(0.1);
    expect(second?.[0]).toBeCloseTo(0.9);
  });

  it("refuses a response whose entries carry no usable index", async () => {
    const invoke = vi.fn<Invoker>(async () => ({ data: [{ embedding: vector(0.1) }] }));
    await expect(provider(invoke).embed(["x"])).rejects.toThrow(/no usable `index`/iu);
  });

  it("refuses a response with no data array", async () => {
    const invoke = vi.fn<Invoker>(async () => ({ object: "list" }));
    await expect(provider(invoke).embed(["x"])).rejects.toThrow(/no `data` array/iu);
  });
});

/**
 * 4096 used to be a constant in this module, with a comment conceding it was
 * "declared rather than discovered". It is one model's width; the next chute
 * will have another, and an index sized against a guess quietly compares
 * incompatible spaces.
 */
describe("measuring the width instead of declaring it", () => {
  it("takes one real vector from the deployment and counts it", async () => {
    const invoke = vi.fn<Invoker>(async () => ({ data: [{ index: 0, embedding: vector(0.5, 3072) }] }));

    await expect(measureEmbeddingWidth(() => invoke, MODEL)).resolves.toBe(3072);
    // One input, so the probe costs one vector and not a corpus.
    expect((invoke.mock.calls[0]![0].payload as { input: string[] }).input).toHaveLength(1);
  });

  it("refuses when the deployment answers with no usable vector", async () => {
    const invoke = vi.fn<Invoker>(async () => ({ data: [{ index: 0, embedding: [] }] }));
    await expect(measureEmbeddingWidth(() => invoke, MODEL)).rejects.toThrow(/no usable vector/iu);
  });

  it("refuses when Chutes is not connected", async () => {
    await expect(measureEmbeddingWidth(() => undefined, MODEL)).rejects.toThrow(/not connected/iu);
  });
});

describe("the page is allowed to reach the encrypted invoke endpoint", () => {
  /*
   * The provider shipped once with a content security policy that named
   * `llm.chutes.ai` and not the embedding chute, so every request would have
   * been blocked by the browser before it left the page — a provider with 13
   * passing unit tests and no route out. The policy then grew an entry naming
   * one specific chute host, which is a hardcoding that model discovery can
   * never satisfy: a chute discovered tomorrow would have its own hostname and
   * no way into a static header.
   *
   * Routing the corpus through `/e2e/invoke` removes the problem rather than
   * managing it. There is one host, it is the one the chat lane already uses,
   * and a newly published embedding chute needs no policy change at all.
   *
   * Both policies are asserted because `check-static-security.mjs` requires them
   * to serialize identically apart from `frame-ancestors`; granting one and not
   * the other fails the build, and granting neither fails only in a browser.
   */
  it.each(["index.html", "public/_headers"])("%s grants api.chutes.ai and no per-chute host", async (file) => {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    const connectSrc = /connect-src [^;]*/u.exec(source)?.[0];
    expect(connectSrc, `${file} has no connect-src`).toBeDefined();
    expect(connectSrc).toContain("https://api.chutes.ai");
    expect(connectSrc).not.toMatch(/https:\/\/chutes-[a-z0-9-]+\.chutes\.ai/u);
  });
});

describe("ChutesEmbeddingError", () => {
  it("is distinguishable so a caller can tell a connection problem from a bug", async () => {
    const invoke = vi.fn<Invoker>(async () => { throw new Error("offline"); });
    await expect(provider(invoke).embed(["x"])).rejects.toBeInstanceOf(ChutesEmbeddingError);
  });
});
