import type { EmbeddingProvider } from "./contracts";

/**
 * Embeddings computed on Chutes confidential compute.
 *
 * The on-device pack is 78 MiB of model and ONNX runtime downloaded to every
 * browser that opts in, and it is the only reason a phone needs WebGPU to have
 * semantic memory at all. This provider moves that work off the device.
 *
 * Moving it off the device is normally the wrong trade for this product: an
 * ordinary remote embedder puts the corpus in someone else's plaintext, which is
 * exactly the posture `docs/CANON.md` promises Airship will not silently adopt,
 * and `SEMANTIC_EMBEDDING_PACK.md` says in as many words that there is no remote
 * embedding endpoint. What makes this one admissible is that the chute is TEE —
 * `confidential_compute: true` on `chute_id
 * 21822836-bfa6-5426-b27e-dd5fdda1249e` — so it belongs to the same trust family
 * as the encrypted chat transport rather than to `plaintext-remote`.
 *
 * It is therefore never a silent default. A person selects it, and if it cannot
 * be reached the index says so and stops. It does not quietly become hash
 * vectors wearing a semantic label; that rule already governs the on-device pack
 * and it governs this the same way.
 */

/** The public embedding chute. Not on `llm.chutes.ai` — that host serves the chat router only. */
export const CHUTES_EMBEDDING_ENDPOINT =
  "https://chutes-qwen-qwen3-embedding-8b-tee.chutes.ai/v1/embeddings";

export const CHUTES_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B-TEE";

/**
 * Qwen3-Embedding-8B's native width. Declared rather than discovered so that an
 * index built against it can refuse a vector of another width instead of
 * silently cosine-comparing incompatible spaces — but see `embed`, which checks
 * the first response against this number rather than trusting it.
 */
export const CHUTES_EMBEDDING_DIMENSIONS = 4096;

/** One request per batch; the caller's batching is what bounds this. */
const MAX_TEXTS_PER_REQUEST = 64;

export type ChutesEmbeddingOptions = Readonly<{
  /** Returns a `cpk_` bearer token, or undefined when Chutes is not connected. */
  token: () => Promise<string | undefined> | string | undefined;
  endpoint?: string;
  model?: string;
  dimensions?: number;
  fetch?: typeof globalThis.fetch;
}>;

export class ChutesEmbeddingError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ChutesEmbeddingError";
  }
}

export class ChutesEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly posture = "confidential-remote" as const;

  private readonly endpoint: string;
  private readonly model: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: ChutesEmbeddingOptions) {
    this.endpoint = options.endpoint ?? CHUTES_EMBEDDING_ENDPOINT;
    this.model = options.model ?? CHUTES_EMBEDDING_MODEL;
    this.dimensions = options.dimensions ?? CHUTES_EMBEDDING_DIMENSIONS;
    this.id = `chutes:${this.model}`;
    const injected = options.fetch;
    const ambient = globalThis.fetch;
    if (!injected && !ambient) throw new ChutesEmbeddingError("No fetch implementation is available.");
    this.fetchImpl = injected ?? ambient.bind(globalThis);
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (!texts.length) return [];

    const token = await this.options.token();
    if (!token) {
      // Fail closed and name the cause. A missing connection is a state the
      // person can fix; silently returning nothing would look like an empty
      // corpus, and falling back to another engine would mislabel the vectors.
      throw new ChutesEmbeddingError(
        "Chutes is not connected, so confidential embeddings cannot be requested. Connect Chutes or select another embedding engine.",
      );
    }

    const vectors: Float32Array[] = [];
    for (let offset = 0; offset < texts.length; offset += MAX_TEXTS_PER_REQUEST) {
      const batch = texts.slice(offset, offset + MAX_TEXTS_PER_REQUEST);
      vectors.push(...await this.embedBatch(batch, token, signal));
    }
    return vectors;
  }

  private async embedBatch(
    batch: string[],
    token: string,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          // Bearer only. Chutes documents that `X-API-Key` is not a supported
          // inference auth scheme and an unauthenticated request falls to the
          // anonymous rate-limit path rather than a 401.
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input: batch }),
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      throw new ChutesEmbeddingError("The Chutes embedding endpoint could not be reached.", cause);
    }

    if (response.status === 429) {
      throw new ChutesEmbeddingError(
        "Chutes rate-limited this embedding request. This is also what an unauthenticated request looks like, so check that the connected key is still valid.",
      );
    }
    if (!response.ok) {
      throw new ChutesEmbeddingError(
        `The Chutes embedding endpoint answered ${response.status}.`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new ChutesEmbeddingError("The Chutes embedding response was not readable JSON.", cause);
    }

    return this.readVectors(payload, batch.length);
  }

  private readVectors(payload: unknown, expectedCount: number): Float32Array[] {
    const data = (payload as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
      throw new ChutesEmbeddingError("The Chutes embedding response carried no `data` array.");
    }
    if (data.length !== expectedCount) {
      throw new ChutesEmbeddingError(
        `Asked for ${expectedCount} embeddings and received ${data.length}.`,
      );
    }

    // `index` is authoritative: an OpenAI-compatible response may return the
    // batch out of order, and a vector attached to the wrong chunk is a
    // retrieval defect that no later gate would catch.
    const ordered = new Array<Float32Array | undefined>(expectedCount);
    for (const entry of data) {
      const record = entry as { embedding?: unknown; index?: unknown };
      const position = typeof record.index === "number" ? record.index : undefined;
      if (position === undefined || position < 0 || position >= expectedCount) {
        throw new ChutesEmbeddingError("A Chutes embedding carried no usable `index`.");
      }
      if (!Array.isArray(record.embedding)) {
        throw new ChutesEmbeddingError("A Chutes embedding carried no `embedding` array.");
      }
      if (record.embedding.length !== this.dimensions) {
        // Loud, with both numbers. A silently reshaped vector would be cosine-
        // compared against a differently shaped index and quietly rank noise.
        throw new ChutesEmbeddingError(
          `Chutes returned a ${record.embedding.length}-dimension vector where this index expects ${this.dimensions}. The deployment's width changed; rebuild the index against the new width rather than mixing them.`,
        );
      }
      ordered[position] = Float32Array.from(record.embedding as number[]);
    }

    const vectors: Float32Array[] = [];
    for (let position = 0; position < expectedCount; position += 1) {
      const vector = ordered[position];
      if (!vector) throw new ChutesEmbeddingError(`No Chutes embedding was returned for input ${position}.`);
      vectors.push(vector);
    }
    return vectors;
  }
}
