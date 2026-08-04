/**
 * Live acceptance for confidential embeddings, against real Chutes.
 *
 * Everything else about this lane is proven structurally or under a mock: that
 * the module holds no endpoint and no credential, that the width is probed
 * rather than declared, that a missing connection fails closed. All of that is
 * worth having and none of it establishes the one fact a person actually cares
 * about — that a real vector comes back, over the sealed transport, from a
 * chute nobody hardcoded.
 *
 * That gap is why this file exists. It was written after a batch shipped with
 * thirteen passing tests and no CSP grant, so the provider could never have
 * reached the network at all and every test still passed. A suite that cannot
 * distinguish "works" from "cannot possibly work" is the defect this closes.
 *
 * Skipped unless `CHUTES_TEST_API_KEY` is set, exactly like
 * `../inference/chutes/transport.live.test.ts` beside it, so it costs an
 * ordinary `npm test` nothing. Set `AIRSHIP_CHUTES_LIVE=1` to make a missing
 * key an error rather than a silent skip.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WasmChutesE2eeCrypto } from "../inference/chutes/crypto";
import { ChutesInferenceTransport } from "../inference/chutes/transport";
import { discoverChutesEmbeddingModels } from "./chutes-embedding-catalog";
import { ChutesEmbeddingProvider, measureEmbeddingWidth } from "./chutes-embeddings";
import type { ConfidentialEmbeddingAuthority } from "./confidential-authority";

const apiKey = process.env.CHUTES_TEST_API_KEY?.trim();
if (process.env.AIRSHIP_CHUTES_LIVE === "1" && !apiKey) {
  throw new Error("Live confidential embedding acceptance requires CHUTES_TEST_API_KEY.");
}
const liveDescribe = apiKey ? describe : describe.skip;

async function liveAuthority(): Promise<ConfidentialEmbeddingAuthority> {
  const wasm = await readFile(new URL("../inference/chutes/wasm/chutes_e2ee_wasm_bg.wasm", import.meta.url));
  const transport = new ChutesInferenceTransport({
    apiKey: apiKey!,
    attestationMode: "optional",
    crypto: new WasmChutesE2eeCrypto({ module_or_path: wasm }),
  });
  // Exactly the wiring `app.tsx` installs, so this exercises the shipped seam
  // rather than a test-only one.
  return (request, signal) => transport.invokeJson(request, signal);
}

liveDescribe("live confidential embeddings", () => {
  it("discovers an embedding chute without a credential", async () => {
    const catalog = await discoverChutesEmbeddingModels({});
    // Discovery is a management read and is deliberately anonymous; if this
    // ever needs the key, the posture claim in the docs has become false.
    expect(catalog.count).toBeGreaterThan(0);
    for (const model of catalog.models) {
      expect(model.chuteId).toMatch(/^[0-9a-f-]{36}$/iu);
      expect(model.path.startsWith("/")).toBe(true);
      expect(model.path).toMatch(/\/embeddings$/u);
    }
  }, 60_000);

  it("returns a real vector over the sealed transport, at a width nobody declared", async () => {
    const catalog = await discoverChutesEmbeddingModels({});
    const model = catalog.models.find((candidate) => candidate.hot) ?? catalog.models[0];
    expect(model, "Chutes listed no usable embedding deployment.").toBeDefined();

    const invoke = await liveAuthority();
    const dimensions = await measureEmbeddingWidth(() => invoke, model!);
    expect(Number.isSafeInteger(dimensions)).toBe(true);
    expect(dimensions).toBeGreaterThan(0);

    const provider = new ChutesEmbeddingProvider({ invoker: () => invoke, model: model!, dimensions });
    const vectors = await provider.embed([
      "Airship keeps retrieval vectors in page memory.",
      "The chute runs in a trusted execution environment.",
    ]);

    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toBeInstanceOf(Float32Array);
      expect(vector.length).toBe(dimensions);
      // A zero vector is what a stub, a truncated read, or a mis-parsed
      // response all produce, and each of those would satisfy a length check.
      expect(vector.some((value) => value !== 0)).toBe(true);
      expect(vector.every((value) => Number.isFinite(value))).toBe(true);
    }

    // Different text must produce a different vector. Without this, a provider
    // that returned one cached probe result for every input would pass
    // everything above.
    expect(Array.from(vectors[0]!)).not.toEqual(Array.from(vectors[1]!));

    // eslint-disable-next-line no-console -- the measured facts are the point of a live run.
    console.log(`live embedding: model=${model!.id} chute=${model!.chuteId} width=${dimensions}`);
  }, 120_000);

  it("embeds the same text to the same vector, so an index is stable across rebuilds", async () => {
    const catalog = await discoverChutesEmbeddingModels({});
    const model = catalog.models.find((candidate) => candidate.hot) ?? catalog.models[0];
    const invoke = await liveAuthority();
    const dimensions = await measureEmbeddingWidth(() => invoke, model!);
    const provider = new ChutesEmbeddingProvider({ invoker: () => invoke, model: model!, dimensions });

    const text = "Determinism is what makes an incremental index safe to reuse.";
    const [first] = await provider.embed([text]);
    const [second] = await provider.embed([text]);

    // Not exact equality: these are two independent sealed requests that may
    // land on different instances of the same deployment. Cosine similarity is
    // the property the index actually depends on.
    let dot = 0;
    let firstNorm = 0;
    let secondNorm = 0;
    for (let index = 0; index < dimensions; index += 1) {
      dot += first![index]! * second![index]!;
      firstNorm += first![index]! ** 2;
      secondNorm += second![index]! ** 2;
    }
    const cosine = dot / (Math.sqrt(firstNorm) * Math.sqrt(secondNorm));
    expect(cosine).toBeGreaterThan(0.999);
  }, 120_000);
});
