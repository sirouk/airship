import { describe, expect, it, vi } from "vitest";
import {
  CHUTES_EMBEDDING_TEMPLATE,
  ChutesEmbeddingDiscoveryError,
  discoverChutesEmbeddingModels,
  readCatalog,
} from "./chutes-embedding-catalog";

/**
 * The envelope `GET /chutes/?template=embedding` returns, trimmed to the fields
 * this module reads.
 *
 * Recorded from the live management API on 2026-08-04, when it held exactly one
 * public embedding chute. That "exactly one" is the thing these tests exist to
 * stop the code from believing.
 */
function chute(overrides: Record<string, unknown> = {}) {
  return {
    chute_id: "21822836-bfa6-5426-b27e-dd5fdda1249e",
    name: "Qwen/Qwen3-Embedding-8B-TEE",
    slug: "chutes-qwen-qwen3-embedding-8b-tee",
    standard_template: "embedding",
    cord_ref_id: "508774ac-493f-5d02-8502-8da2a3435fe6",
    public: true,
    tee: true,
    hot: true,
    ...overrides,
  };
}

function envelope(items: unknown[], cordRefs: Record<string, unknown> = defaultCords()) {
  return { total: items.length, page: 0, limit: 50, items, cord_refs: cordRefs };
}

function defaultCords() {
  return {
    "508774ac-493f-5d02-8502-8da2a3435fe6": [
      { path: "/embed", method: "POST", stream: false, function: "embed", public_api_path: "/v1/embeddings", public_api_method: "POST" },
      { path: "/get_models", method: "GET", stream: false, function: "get_models", public_api_path: "/v1/models", public_api_method: "GET" },
    ],
  };
}

describe("discovering which chutes embed", () => {
  it("asks the management API with the embedding template and no credential", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope([chute()])), { status: 200 }));

    await discoverChutesEmbeddingModels({ fetch: fetchImpl as unknown as typeof globalThis.fetch });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.host).toBe("api.chutes.ai");
    expect(parsed.pathname).toBe("/chutes/");
    expect(parsed.searchParams.get("template")).toBe(CHUTES_EMBEDDING_TEMPLATE);
    expect(parsed.searchParams.get("include_public")).toBe("true");
    /*
     * Discovering *what exists* must not spend a credential. `docs/MODEL_DISCOVERY.md`
     * records that public `/chutes` reads work anonymously and that Airship
     * deliberately omits credentials for them; only the sealed invocation is
     * authenticated, and it is authenticated by the transport, not here.
     */
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(init.credentials).toBe("omit");
  });

  it("reads the chute, the model name and the path inside it from the answer", () => {
    const catalog = readCatalog(envelope([chute()]));

    expect(catalog.count).toBe(1);
    expect(catalog.models[0]).toEqual({
      id: "Qwen/Qwen3-Embedding-8B-TEE",
      chuteId: "21822836-bfa6-5426-b27e-dd5fdda1249e",
      slug: "chutes-qwen-qwen3-embedding-8b-tee",
      // Taken from the chute's own cord list, not written down here. `/embed` is
      // the internal function path; `/v1/embeddings` is the OpenAI-compatible
      // path the request body is written against, and it is what `X-E2E-Path`
      // must carry.
      path: "/v1/embeddings",
      hot: true,
    });
  });

  /*
   * One public embedding chute exists today. Nothing may assume that, so this
   * is the assertion that the count is read rather than known.
   */
  it("returns every embedding chute Chutes lists, not the one that exists today", () => {
    const second = chute({
      chute_id: "chute-b",
      name: "Another/Embedding-Model-TEE",
      slug: "another-embedding-model-tee",
      cord_ref_id: "cord-b",
      hot: false,
    });
    const catalog = readCatalog(envelope([chute(), second], {
      ...defaultCords(),
      "cord-b": [{ stream: false, public_api_path: "/v1/embeddings", public_api_method: "POST" }],
    }));

    expect(catalog.count).toBe(2);
    // Sorted by id so the order does not depend on catalog paging.
    expect(catalog.models.map((model) => model.id)).toEqual([
      "Another/Embedding-Model-TEE",
      "Qwen/Qwen3-Embedding-8B-TEE",
    ]);
    expect(catalog.models.map((model) => model.hot)).toEqual([false, true]);
  });

  it("ignores a chute that is not an embedding deployment", () => {
    const catalog = readCatalog(envelope([chute({ standard_template: "vllm" })]));
    expect(catalog.count).toBe(0);
    // Not a declined embedding model — a chat chute is simply not one of these.
    expect(catalog.declined).toBe(0);
  });

  /*
   * `EmbeddingProvider.posture` may only say `confidential-remote` of a provider
   * whose compute is attested, and `/e2e/invoke` needs an instance public key to
   * seal against. A non-TEE embedding chute has neither, so it is refused —
   * counted, not silently dropped, so the screen can tell "one model" apart from
   * "one usable model of three".
   */
  it("declines an embedding chute that is not confidential compute", () => {
    const catalog = readCatalog(envelope([chute({ tee: false })]));
    expect(catalog.count).toBe(0);
    expect(catalog.declined).toBe(1);
  });

  it("declines a chute that publishes no OpenAI-compatible embeddings path", () => {
    const catalog = readCatalog(envelope([chute()], {
      "508774ac-493f-5d02-8502-8da2a3435fe6": [
        { stream: false, public_api_path: "/v1/models", public_api_method: "GET" },
      ],
    }));
    expect(catalog.count).toBe(0);
    expect(catalog.declined).toBe(1);
  });

  it("refuses a cord that claims to stream, because an embeddings response does not", () => {
    const catalog = readCatalog(envelope([chute()], {
      "508774ac-493f-5d02-8502-8da2a3435fe6": [
        { stream: true, public_api_path: "/v1/embeddings", public_api_method: "POST" },
      ],
    }));
    expect(catalog.count).toBe(0);
    expect(catalog.declined).toBe(1);
  });
});

describe("discovery failure is loud", () => {
  it("distinguishes 'Chutes lists none' from 'Airship could not ask'", async () => {
    const unreachable = vi.fn(async () => { throw new Error("offline"); });
    await expect(discoverChutesEmbeddingModels({ fetch: unreachable as unknown as typeof globalThis.fetch }))
      .rejects.toThrow(/could not be reached/iu);

    const refused = vi.fn(async () => new Response("", { status: 503 }));
    await expect(discoverChutesEmbeddingModels({ fetch: refused as unknown as typeof globalThis.fetch }))
      .rejects.toThrow(/answered 503/u);

    // And an empty catalog is a successful answer, not a failure.
    const empty = vi.fn(async () => new Response(JSON.stringify(envelope([])), { status: 200 }));
    await expect(discoverChutesEmbeddingModels({ fetch: empty as unknown as typeof globalThis.fetch }))
      .resolves.toMatchObject({ count: 0, declined: 0 });
  });

  it("refuses a payload with no items array", () => {
    expect(() => readCatalog({ total: 0 })).toThrow(ChutesEmbeddingDiscoveryError);
    expect(() => readCatalog(null)).toThrow(/no `items` array/u);
  });
});
