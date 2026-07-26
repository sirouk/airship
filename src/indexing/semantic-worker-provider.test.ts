import { describe, expect, it } from "vitest";
import {
  AIRSHIP_SEMANTIC_MODEL,
  createSemanticWorkerHandler,
  LazySemanticWorkerEmbeddingProvider,
  type SemanticAccelerationPreference,
  type SemanticBackend,
  type SemanticLoadedModel,
  type SemanticModelLoader,
  type SemanticProviderState,
  type SemanticWorkerPort,
  type SemanticWorkerRequest,
  type SemanticWorkerResponse,
} from "./semantic-worker-provider";

describe("LazySemanticWorkerEmbeddingProvider", () => {
  it("loads nothing until first use and falls back from WebGPU to WASM with explicit progress", async () => {
    const loader = new MockLoader({ failWebgpu: true });
    let workers = 0;
    let loopback: LoopbackWorker | undefined;
    const provider = new LazySemanticWorkerEmbeddingProvider(() => {
      workers += 1;
      return loopback = new LoopbackWorker(loader);
    }, () => ({ backend: "webgpu" }));
    const states: SemanticProviderState[] = [];
    provider.subscribe((state) => states.push(state));

    expect(workers).toBe(0);
    expect(provider.getState()).toEqual({ phase: "cold" });
    const vectors = await provider.embed(["brass", "airship"]);

    expect(workers).toBe(1);
    expect(loader.backends).toEqual(["webgpu", "wasm"]);
    expect(loopback?.requests[0]).toEqual({
      type: "initialize",
      requestId: "initialize",
      manifest: AIRSHIP_SEMANTIC_MODEL,
      preferredBackend: "webgpu",
    });
    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "loading-worker" }),
      expect.objectContaining({ phase: "initializing", backend: "webgpu" }),
      expect.objectContaining({ phase: "initializing", backend: "wasm" }),
      expect.objectContaining({ phase: "downloading", backend: "wasm", loadedBytes: 24, totalBytes: 48 }),
      expect.objectContaining({ phase: "ready", backend: "wasm" }),
    ]));
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]).toHaveLength(384);
    expect(vectors[0]?.[0]).toBe(5);
    expect(provider.id).toContain(AIRSHIP_SEMANTIC_MODEL.revision);
    expect(provider.posture).toBe("local-semantic");
  });

  it("waits for the accelerator policy before latching a backend and threads it into the loader", async () => {
    const loader = new MockLoader({});
    const worker = new LoopbackWorker(loader);
    let publishPolicy!: (preference: SemanticAccelerationPreference) => void;
    const policy = new Promise<SemanticAccelerationPreference>((resolve) => { publishPolicy = resolve; });
    const provider = new LazySemanticWorkerEmbeddingProvider(() => worker, () => policy);

    const embedding = provider.embed(["deferred capability probe"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The capability probe is still in flight: nothing may be latched yet.
    expect(worker.requests).toEqual([]);

    publishPolicy({ backend: "webgpu", powerPreference: "low-power", wasmThreads: 4 });
    await embedding;

    expect(worker.requests[0]).toEqual({
      type: "initialize",
      requestId: "initialize",
      manifest: AIRSHIP_SEMANTIC_MODEL,
      preferredBackend: "webgpu",
      powerPreference: "low-power",
      wasmThreads: 4,
    });
    expect(loader.loads[0]).toMatchObject({ backend: "webgpu", powerPreference: "low-power", wasmThreads: 4 });
  });

  it("bounds the requested thread count and still starts when the policy resolver fails", async () => {
    const overRequested = new LoopbackWorker(new MockLoader({}));
    await new LazySemanticWorkerEmbeddingProvider(() => overRequested, () => ({ backend: "wasm", wasmThreads: 64 }))
      .embed(["bounded"]);
    expect(overRequested.requests[0]).toMatchObject({ wasmThreads: 8 });

    const failed = new LoopbackWorker(new MockLoader({}));
    await new LazySemanticWorkerEmbeddingProvider(() => failed, () => Promise.reject(new Error("probe failed")))
      .embed(["fallback"]);
    // A failed probe is not evidence against an accelerator, so the request is
    // still made; the worker remains the authority on what actually loaded.
    expect(failed.requests[0]).toMatchObject({ type: "initialize" });
    expect((failed.requests[0] as { powerPreference?: string }).powerPreference).toBeUndefined();
  });

  it("propagates cancellation into the worker operation", async () => {
    const loader = new MockLoader({ blockEmbedding: true });
    const worker = new LoopbackWorker(loader);
    const provider = new LazySemanticWorkerEmbeddingProvider(() => worker, () => ({ backend: "wasm" }));
    await provider.embed(["warmup"]);

    const controller = new AbortController();
    const pending = provider.embed(["cancel this"], controller.signal);
    await loader.embeddingStarted;
    controller.abort(new DOMException("Caller cancelled.", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.requests).toContainEqual({ type: "cancel", requestId: "embed-2" });
  });

  it("fails closed on wrong vector dimensions", async () => {
    const loader: SemanticModelLoader = {
      async load() {
        return { async embed() { return [new Float32Array(12)]; } };
      },
    };
    const provider = new LazySemanticWorkerEmbeddingProvider(() => new LoopbackWorker(loader), () => ({ backend: "wasm" }));
    await expect(provider.embed(["invalid"])).rejects.toMatchObject({
      name: "SemanticWorkerError",
      code: "SEMANTIC_EMBED_FAILED",
    });
  });
});

class LoopbackWorker implements SemanticWorkerPort {
  readonly requests: SemanticWorkerRequest[] = [];
  private readonly listeners = new Set<(event: MessageEvent<SemanticWorkerResponse>) => void>();
  private readonly handle: (message: SemanticWorkerRequest) => Promise<void>;

  constructor(loader: SemanticModelLoader) {
    this.handle = createSemanticWorkerHandler(loader, (message) => {
      queueMicrotask(() => {
        const event = { data: message } as MessageEvent<SemanticWorkerResponse>;
        for (const listener of this.listeners) listener(event);
      });
    });
  }

  postMessage(message: SemanticWorkerRequest): void {
    this.requests.push(structuredClone(message));
    queueMicrotask(() => void this.handle(message));
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<SemanticWorkerResponse>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<SemanticWorkerResponse>) => void): void {
    this.listeners.delete(listener);
  }

  terminate(): void { this.listeners.clear(); }
}

class MockLoader implements SemanticModelLoader {
  readonly backends: SemanticBackend[] = [];
  readonly loads: Array<Parameters<SemanticModelLoader["load"]>[0]> = [];
  private startedResolve!: () => void;
  readonly embeddingStarted = new Promise<void>((resolve) => { this.startedResolve = resolve; });

  constructor(private readonly options: Readonly<{ failWebgpu?: boolean; blockEmbedding?: boolean }>) {}

  async load(args: Parameters<SemanticModelLoader["load"]>[0]): Promise<SemanticLoadedModel> {
    this.backends.push(args.backend);
    this.loads.push(args);
    if (args.backend === "webgpu" && this.options.failWebgpu) throw new Error("WebGPU adapter unavailable");
    args.onProgress({ loadedBytes: 24, totalBytes: 48, message: "Loading pinned same-origin artifacts." });
    return {
      embed: async (texts, signal) => {
        if (this.options.blockEmbedding && texts[0] !== "warmup") {
          this.startedResolve();
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
          });
        }
        return texts.map((text) => {
          const vector = new Float32Array(AIRSHIP_SEMANTIC_MODEL.dimensions);
          vector[0] = text.length;
          return vector;
        });
      },
    };
  }
}
