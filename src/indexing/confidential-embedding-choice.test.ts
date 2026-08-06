import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readConfidentialEmbeddingChoice,
  writeConfidentialEmbeddingChoice,
} from "./confidential-embedding-choice";
import { prepareConfidentialEmbeddings } from "./semantic-browser-provider";
import { setConfidentialAuthority } from "./confidential-authority";

/**
 * Two usable embedding deployments, which is the only situation this module is
 * for. The management shape is the one `chutes-embedding-catalog.test.ts`
 * recorded from the live API; the second chute is a copy with its own ids, and
 * it is deliberately the *hot* one so that "the choice won" and "the automatic
 * pick won" cannot produce the same answer.
 */
const CORD_REF = "508774ac-493f-5d02-8502-8da2a3435fe6";

function chute(overrides: Record<string, unknown>) {
  return {
    chute_id: "21822836-bfa6-5426-b27e-dd5fdda1249e",
    name: "Qwen/Qwen3-Embedding-8B-TEE",
    slug: "chutes-qwen-qwen3-embedding-8b-tee",
    standard_template: "embedding",
    cord_ref_id: CORD_REF,
    public: true,
    tee: true,
    hot: false,
    ...overrides,
  };
}

function twoDeployments() {
  return {
    total: 2,
    page: 0,
    limit: 50,
    items: [
      chute({}),
      chute({
        chute_id: "9f2c1f60-1111-5555-9999-0a1b2c3d4e5f",
        name: "BAAI/bge-m3-TEE",
        slug: "chutes-baai-bge-m3-tee",
        hot: true,
      }),
    ],
    cord_refs: {
      [CORD_REF]: [
        { path: "/embed", method: "POST", stream: false, function: "embed", public_api_path: "/v1/embeddings", public_api_method: "POST" },
      ],
    },
  };
}

function install(catalog: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 })));
  // One real vector, so the width probe has something to count. Which model was
  // asked is the whole subject of these tests, so the authority records it.
  const asked: string[] = [];
  setConfidentialAuthority(async (request) => {
    asked.push(String((request.payload as { model?: unknown }).model));
    return { data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] };
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setConfidentialAuthority(undefined);
  writeConfidentialEmbeddingChoice(undefined);
});

describe("the recorded embedding choice", () => {
  it("round-trips and clears", () => {
    expect(readConfidentialEmbeddingChoice()).toBeUndefined();
    writeConfidentialEmbeddingChoice("BAAI/bge-m3-TEE");
    expect(readConfidentialEmbeddingChoice()).toBe("BAAI/bge-m3-TEE");
    writeConfidentialEmbeddingChoice(undefined);
    expect(readConfidentialEmbeddingChoice()).toBeUndefined();
  });

  it("treats blank as no choice, because an empty string is not a deployment", () => {
    writeConfidentialEmbeddingChoice("   ");
    expect(readConfidentialEmbeddingChoice()).toBeUndefined();
  });
});

describe("resolving which deployment a corpus is embedded by", () => {
  it("refuses to guess when several deployments are live and none was chosen", async () => {
    const asked = install(twoDeployments());

    await expect(prepareConfidentialEmbeddings()).rejects.toThrow(
      "Choose one in the Connection view",
    );
    expect(asked).toEqual([]);
  });

  it("takes the recorded choice over the live one, because warmth is not a decision", async () => {
    const asked = install(twoDeployments());
    writeConfidentialEmbeddingChoice("Qwen/Qwen3-Embedding-8B-TEE");

    const { readiness } = await prepareConfidentialEmbeddings();

    expect(readiness.modelId).toBe("Qwen/Qwen3-Embedding-8B-TEE");
    expect(asked).toEqual(["Qwen/Qwen3-Embedding-8B-TEE"]);
  });

  it("refuses a stale choice instead of silently changing deployments", async () => {
    install(twoDeployments());
    writeConfidentialEmbeddingChoice("a-model-chutes-no-longer-publishes");

    await expect(prepareConfidentialEmbeddings()).rejects.toThrow(
      "Choose one in the Connection view",
    );
  });

  it("adopts the sole deployment by its live id", async () => {
    const asked = install({
      ...twoDeployments(),
      total: 1,
      items: [twoDeployments().items[0]],
    });

    const { readiness } = await prepareConfidentialEmbeddings();

    expect(readiness.modelId).toBe("Qwen/Qwen3-Embedding-8B-TEE");
    expect(asked).toEqual(["Qwen/Qwen3-Embedding-8B-TEE"]);
  });
});
