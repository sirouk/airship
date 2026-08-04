import type { ConfidentialEmbeddingAuthority } from "./confidential-authority";
import type { ChutesEmbeddingModel } from "./chutes-embedding-catalog";
import type { EmbeddingProvider } from "./contracts";

/**
 * Embeddings computed on Chutes confidential compute, over the same end-to-end
 * encrypted transport the chat lane uses.
 *
 * The on-device pack is 78 MiB of model and ONNX runtime downloaded to every
 * browser that opts in, and it is the only reason a phone needs WebGPU to have
 * semantic memory at all. This provider moves that work off the device.
 *
 * It used to move it off the device over plain HTTPS to a hardcoded host with a
 * hardcoded model name, carrying the bearer token itself. Every part of that was
 * avoidable: `/e2e/invoke` takes `X-Chute-Id` and `X-E2E-Path`, so an embedding
 * request is the chat machinery pointed at a different chute and a different
 * path — same ML-KEM sealing to the instance's own public key, same nonce
 * ledger, same attestation gate, same bounded reads. So this module holds no
 * crypto, no endpoint and no credential. It holds the shape of an OpenAI
 * embeddings response and the rules about when to refuse one.
 *
 * The chute, the model name, the path inside it and the vector width all arrive
 * from discovery (`chutes-embedding-catalog.ts` and `measureEmbeddingWidth`
 * below). Nothing here is named that Chutes will answer a question about.
 *
 * It is never a silent default. A person selects it, and if it cannot be reached
 * the index says so and stops. It does not quietly become hash vectors wearing a
 * semantic label; that rule already governs the on-device pack and it governs
 * this the same way.
 */

/** One request per batch; the caller's batching is what bounds this. */
const MAX_TEXTS_PER_REQUEST = 64;

/**
 * The narrowest possible question that still yields a real vector.
 *
 * Width is a property of the deployed model, not of embeddings, so it is asked
 * for rather than declared. One space is enough: a model that answers at all
 * answers at its native width.
 */
const WIDTH_PROBE_TEXT = " ";

export type ChutesEmbeddingOptions = Readonly<{
  /**
   * Returns the installed confidential invoker, or `undefined` when Chutes is
   * not connected. Read per embed rather than captured, so a connection that
   * completes mid-index serves the next batch.
   */
  invoker: () => ConfidentialEmbeddingAuthority | undefined;
  /** The discovered embedding deployment. Never defaulted. */
  model: ChutesEmbeddingModel;
  /** The width `model` was observed to return. See `measureEmbeddingWidth`. */
  dimensions: number;
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
  readonly model: ChutesEmbeddingModel;

  constructor(private readonly options: ChutesEmbeddingOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    if (!Number.isSafeInteger(this.dimensions) || this.dimensions <= 0) {
      throw new ChutesEmbeddingError(
        `A confidential embedding index needs a measured vector width; ${String(options.dimensions)} is not one.`,
      );
    }
    this.id = `chutes:${this.model.id}`;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const invoke = this.requireInvoker();

    const vectors: Float32Array[] = [];
    for (let offset = 0; offset < texts.length; offset += MAX_TEXTS_PER_REQUEST) {
      const batch = texts.slice(offset, offset + MAX_TEXTS_PER_REQUEST);
      const payload = await requestEmbeddings(invoke, this.model, batch, signal);
      vectors.push(...readVectors(payload, batch.length, this.dimensions));
    }
    return vectors;
  }

  private requireInvoker(): ConfidentialEmbeddingAuthority {
    const invoke = this.options.invoker();
    if (!invoke) {
      // Fail closed and name the cause. A missing connection is a state the
      // person can fix; silently returning nothing would look like an empty
      // corpus, and falling back to another engine would mislabel the vectors.
      throw new ChutesEmbeddingError(
        "Chutes is not connected, so confidential embeddings cannot be requested. Connect Chutes or select another embedding engine.",
      );
    }
    return invoke;
  }
}

/**
 * Ask a discovered deployment how wide its vectors are, by taking one.
 *
 * 4096 was written into this module as a constant, with a comment conceding it
 * was "declared rather than discovered". It is Qwen3-Embedding-8B's width and
 * nothing more; the next embedding chute will have another. An index built on a
 * guessed width silently cosine-compares incompatible spaces, so the width is
 * established before the index exists, from the deployment that will fill it.
 */
export async function measureEmbeddingWidth(
  invoker: () => ConfidentialEmbeddingAuthority | undefined,
  model: ChutesEmbeddingModel,
  signal?: AbortSignal,
): Promise<number> {
  const invoke = invoker();
  if (!invoke) {
    throw new ChutesEmbeddingError(
      "Chutes is not connected, so the confidential embedding width cannot be measured.",
    );
  }
  const payload = await requestEmbeddings(invoke, model, [WIDTH_PROBE_TEXT], signal);
  const data = readData(payload, 1);
  const first = data[0] as { embedding?: unknown } | undefined;
  if (!Array.isArray(first?.embedding) || first.embedding.length === 0) {
    throw new ChutesEmbeddingError(
      `${model.id} answered the width probe with no usable vector, so no index can be sized against it.`,
    );
  }
  return first.embedding.length;
}

async function requestEmbeddings(
  invoke: ConfidentialEmbeddingAuthority,
  model: ChutesEmbeddingModel,
  batch: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await invoke({
      chuteId: model.chuteId,
      path: model.path,
      payload: { model: model.id, input: batch },
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof ChutesEmbeddingError) throw cause;
    // The transport's own sentence is the useful one — it knows whether this was
    // a rejected nonce, a failed attestation, a 429 pinned to one instance, or
    // an unreachable host. Wrapping keeps the caller's `instanceof` contract
    // without discarding what actually happened.
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ChutesEmbeddingError(
      `The encrypted embedding request to ${model.id} failed. ${detail}`,
      cause,
    );
  }
}

function readData(payload: unknown, expectedCount: number): unknown[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new ChutesEmbeddingError("The Chutes embedding response carried no `data` array.");
  }
  if (data.length !== expectedCount) {
    throw new ChutesEmbeddingError(
      `Asked for ${expectedCount} embeddings and received ${data.length}.`,
    );
  }
  return data;
}

function readVectors(payload: unknown, expectedCount: number, dimensions: number): Float32Array[] {
  const data = readData(payload, expectedCount);

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
    if (record.embedding.length !== dimensions) {
      // Loud, with both numbers. A silently reshaped vector would be cosine-
      // compared against a differently shaped index and quietly rank noise.
      throw new ChutesEmbeddingError(
        `Chutes returned a ${record.embedding.length}-dimension vector where this index expects ${dimensions}. The deployment's width changed; rebuild the index against the new width rather than mixing them.`,
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
