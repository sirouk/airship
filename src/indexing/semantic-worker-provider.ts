import type { EmbeddingProvider } from "./contracts";

export const AIRSHIP_SEMANTIC_MODEL = Object.freeze({
  transformersVersion: "4.0.0",
  modelId: "mixedbread-ai/mxbai-embed-xsmall-v1",
  revision: "b0561d9a97e6b298da39f0ef3e7d3cf153b1b29a",
  dimensions: 384,
  task: "feature-extraction" as const,
  pooling: "mean" as const,
  normalize: true as const,
  webgpuDtype: "q4f16" as const,
  wasmDtype: "q8" as const,
  delivery: "same-origin-pack-required" as const,
});

export type SemanticBackend = "webgpu" | "wasm";
export type SemanticProviderPhase =
  | "cold"
  | "loading-worker"
  | "downloading"
  | "initializing"
  | "ready"
  | "unavailable"
  | "failed"
  | "disposed";

export type SemanticProviderState = Readonly<{
  phase: SemanticProviderPhase;
  backend?: SemanticBackend;
  loadedBytes?: number;
  totalBytes?: number;
  message?: string;
}>;

export type SemanticModelManifest = typeof AIRSHIP_SEMANTIC_MODEL;

export type SemanticPowerPreference = "high-performance" | "low-power" | "default";

/**
 * The accelerator choices the main thread makes for the worker. It is resolved
 * before the worker latches a backend, because the capability probe is
 * asynchronous and reading a not-yet-observed snapshot would silently pin the
 * WASM fallback on a WebGPU host.
 */
export type SemanticAccelerationPreference = Readonly<{
  backend: SemanticBackend;
  powerPreference?: SemanticPowerPreference;
  /** ONNX Runtime WASM thread count; ORT spawns (wasmThreads - 1) workers. */
  wasmThreads?: number;
}>;

export type SemanticAccelerationResolver =
  () => SemanticAccelerationPreference | undefined | Promise<SemanticAccelerationPreference | undefined>;

export type SemanticWorkerRequest =
  | Readonly<{
      type: "initialize";
      requestId: string;
      manifest: SemanticModelManifest;
      preferredBackend: SemanticBackend;
      powerPreference?: SemanticPowerPreference;
      wasmThreads?: number;
    }>
  | Readonly<{ type: "embed"; requestId: string; texts: readonly string[] }>
  | Readonly<{ type: "cancel"; requestId: string }>
  | Readonly<{ type: "dispose" }>;

export type SemanticWorkerResponse =
  | Readonly<{ type: "state"; state: SemanticProviderState }>
  | Readonly<{ type: "ready"; requestId: string; manifest: SemanticModelManifest; backend: SemanticBackend }>
  | Readonly<{ type: "result"; requestId: string; vectors: readonly Float32Array[] }>
  | Readonly<{ type: "error"; requestId: string; code: string; message: string; recoverable: boolean }>;

export interface SemanticWorkerPort {
  postMessage(message: SemanticWorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<SemanticWorkerResponse>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<SemanticWorkerResponse>) => void): void;
  terminate(): void;
}

export type SemanticWorkerFactory = () => SemanticWorkerPort;

export type SemanticLoadedModel = Readonly<{
  embed(texts: readonly string[], signal: AbortSignal): Promise<readonly Float32Array[]>;
  dispose?(): void | Promise<void>;
}>;

/** Implemented by the separately shipped, same-origin Transformers.js pack. */
export interface SemanticModelLoader {
  load(args: Readonly<{
    manifest: SemanticModelManifest;
    backend: SemanticBackend;
    powerPreference?: SemanticPowerPreference;
    wasmThreads?: number;
    signal: AbortSignal;
    onProgress(state: Readonly<{ loadedBytes?: number; totalBytes?: number; message?: string }>): void;
  }>): Promise<SemanticLoadedModel>;
}

type Pending = Readonly<{
  resolve(vectors: Float32Array[]): void;
  reject(error: unknown): void;
  detach(): void;
}>;

/**
 * Lazy main-thread facade. Constructing it imports nothing and starts no worker;
 * the optional worker pack is requested only by the first embed call.
 */
export class LazySemanticWorkerEmbeddingProvider implements EmbeddingProvider {
  readonly posture = "local-semantic" as const;
  readonly dimensions = AIRSHIP_SEMANTIC_MODEL.dimensions;
  readonly id = [
    "airship-transformersjs",
    AIRSHIP_SEMANTIC_MODEL.transformersVersion,
    `${AIRSHIP_SEMANTIC_MODEL.modelId}@${AIRSHIP_SEMANTIC_MODEL.revision}`,
    `${AIRSHIP_SEMANTIC_MODEL.dimensions}d`,
  ].join(":");

  private readonly listeners = new Set<(state: SemanticProviderState) => void>();
  private readonly pending = new Map<string, Pending>();
  private worker?: SemanticWorkerPort;
  private ready?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: unknown) => void;
  private sequence = 0;
  private state: SemanticProviderState = Object.freeze({ phase: "cold" });

  constructor(
    private readonly workerFactory: SemanticWorkerFactory,
    private readonly acceleration: SemanticAccelerationResolver = defaultAcceleration,
  ) {}

  getState(): SemanticProviderState { return this.state; }

  subscribe(listener: (state: SemanticProviderState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (this.state.phase === "disposed") throw new Error("The semantic embedding provider is disposed.");
    validateTexts(texts);
    throwIfAborted(signal);
    await raceAbort(this.ensureReady(), signal);
    throwIfAborted(signal);
    const requestId = `embed-${++this.sequence}`;
    return new Promise<Float32Array[]>((resolve, reject) => {
      const abort = () => {
        this.worker?.postMessage({ type: "cancel", requestId });
        this.pending.delete(requestId);
        reject(signal?.reason ?? new DOMException("Embedding cancelled.", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(requestId, {
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", abort),
      });
      this.worker!.postMessage({ type: "embed", requestId, texts: structuredClone(texts) });
    });
  }

  dispose(): void {
    if (this.state.phase === "disposed") return;
    const error = new Error("The semantic embedding provider was disposed.");
    this.rejectReady?.(error);
    for (const pending of this.pending.values()) { pending.detach(); pending.reject(error); }
    this.pending.clear();
    this.worker?.postMessage({ type: "dispose" });
    this.worker?.removeEventListener("message", this.onMessage);
    this.worker?.terminate();
    this.worker = undefined;
    this.publish({ phase: "disposed" });
    this.listeners.clear();
  }

  private ensureReady(): Promise<void> {
    if (this.state.phase === "ready") return Promise.resolve();
    if (this.ready) return this.ready;
    this.publish({ phase: "loading-worker", message: "Loading the optional same-origin semantic pack." });
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // The worker latches its backend for the page lifetime, so the accelerator
    // decision must not race the capability probe: resolve the preference
    // first, then start the worker. The resolver is deadline-bounded by the
    // capability registry, so this adds bounded first-embed latency only.
    void this.startWorker();
    return this.ready;
  }

  private async startWorker(): Promise<void> {
    let preference: SemanticAccelerationPreference;
    try {
      preference = (await this.acceleration()) ?? defaultAcceleration();
    } catch {
      // A failed capability probe is not evidence against WebGPU; the worker
      // still reports whichever backend actually activated.
      preference = defaultAcceleration();
    }
    if (this.state.phase === "disposed") return;
    try {
      this.worker = this.workerFactory();
      this.worker.addEventListener("message", this.onMessage);
      this.worker.postMessage({
        type: "initialize",
        requestId: "initialize",
        manifest: AIRSHIP_SEMANTIC_MODEL,
        preferredBackend: preference.backend === "webgpu" ? "webgpu" : "wasm",
        ...(preference.powerPreference ? { powerPreference: preference.powerPreference } : {}),
        ...(preference.wasmThreads !== undefined ? { wasmThreads: boundedThreads(preference.wasmThreads) } : {}),
      });
    } catch (error) {
      this.failInitialization(error, "SEMANTIC_PACK_UNAVAILABLE");
    }
  }

  private readonly onMessage = (event: MessageEvent<SemanticWorkerResponse>) => {
    const message = event.data;
    if (message.type === "state") {
      this.publish(message.state);
      return;
    }
    if (message.type === "ready") {
      if (!sameManifest(message.manifest) || !["webgpu", "wasm"].includes(message.backend)) {
        this.failInitialization(new Error("Semantic worker returned an unpinned model manifest."), "SEMANTIC_MANIFEST_MISMATCH");
        return;
      }
      this.publish({ phase: "ready", backend: message.backend });
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      return;
    }
    if (message.type === "result") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      pending.detach();
      try { pending.resolve(validateVectors(message.vectors, this.dimensions)); }
      catch (error) { pending.reject(error); }
      return;
    }
    if (message.requestId === "initialize") {
      this.failInitialization(new Error(message.message), message.code, message.recoverable);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    pending.detach();
    pending.reject(new SemanticWorkerError(message.code, message.message, message.recoverable));
  };

  private failInitialization(error: unknown, code: string, recoverable = true): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.publish({ phase: recoverable ? "unavailable" : "failed", message: normalized.message });
    this.rejectReady?.(new SemanticWorkerError(code, normalized.message, recoverable));
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }

  private publish(state: SemanticProviderState): void {
    this.state = Object.freeze({ ...state });
    for (const listener of this.listeners) listener(this.state);
  }
}

export class SemanticWorkerError extends Error {
  constructor(readonly code: string, message: string, readonly recoverable: boolean) {
    super(message);
    this.name = "SemanticWorkerError";
  }
}

/** Worker-side protocol host; the optional pack supplies the actual loader. */
export function createSemanticWorkerHandler(
  loader: SemanticModelLoader,
  emit: (message: SemanticWorkerResponse) => void,
): (message: SemanticWorkerRequest) => Promise<void> {
  let model: SemanticLoadedModel | undefined;
  let backend: SemanticBackend | undefined;
  let initialization: AbortController | undefined;
  const operations = new Map<string, AbortController>();

  return async (message) => {
    if (message.type === "initialize") {
      if (!sameManifest(message.manifest)) {
        emit({ type: "error", requestId: message.requestId, code: "SEMANTIC_MANIFEST_MISMATCH", message: "The requested semantic model is not the pinned Airship manifest.", recoverable: false });
        return;
      }
      initialization = new AbortController();
      const attempts: SemanticBackend[] = message.preferredBackend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
      let lastError: unknown;
      for (const candidate of attempts) {
        try {
          emit({ type: "state", state: { phase: "initializing", backend: candidate, message: candidate === "webgpu" ? "Initializing WebGPU semantic embeddings." : "Initializing the WASM semantic fallback." } });
          model = await loader.load({
            manifest: message.manifest,
            backend: candidate,
            ...(message.powerPreference ? { powerPreference: message.powerPreference } : {}),
            ...(message.wasmThreads !== undefined ? { wasmThreads: message.wasmThreads } : {}),
            signal: initialization.signal,
            onProgress: (progress) => emit({ type: "state", state: { phase: "downloading", backend: candidate, ...progress } }),
          });
          backend = candidate;
          emit({ type: "ready", requestId: message.requestId, manifest: message.manifest, backend });
          return;
        } catch (error) {
          lastError = error;
          if (initialization.signal.aborted) break;
        }
      }
      emit({ type: "error", requestId: message.requestId, code: "SEMANTIC_BACKENDS_UNAVAILABLE", message: errorMessage(lastError), recoverable: true });
      return;
    }
    if (message.type === "cancel") {
      operations.get(message.requestId)?.abort(new DOMException("Embedding cancelled.", "AbortError"));
      return;
    }
    if (message.type === "dispose") {
      initialization?.abort();
      for (const controller of operations.values()) controller.abort();
      operations.clear();
      await model?.dispose?.();
      model = undefined;
      return;
    }
    if (!model || !backend) {
      emit({ type: "error", requestId: message.requestId, code: "SEMANTIC_NOT_READY", message: "The semantic model is not ready.", recoverable: true });
      return;
    }
    const controller = new AbortController();
    operations.set(message.requestId, controller);
    try {
      const vectors = validateVectors(await model.embed(message.texts, controller.signal), AIRSHIP_SEMANTIC_MODEL.dimensions);
      if (!controller.signal.aborted) emit({ type: "result", requestId: message.requestId, vectors });
    } catch (error) {
      if (!controller.signal.aborted) emit({ type: "error", requestId: message.requestId, code: "SEMANTIC_EMBED_FAILED", message: errorMessage(error), recoverable: true });
    } finally {
      operations.delete(message.requestId);
    }
  };
}

function sameManifest(value: SemanticModelManifest): boolean {
  return JSON.stringify(value) === JSON.stringify(AIRSHIP_SEMANTIC_MODEL);
}

function validateTexts(texts: readonly string[]): void {
  if (!Array.isArray(texts) || texts.length > 512 || texts.some((text) => typeof text !== "string" || text.length > 1_000_000)) {
    throw new TypeError("Semantic embedding batch violates the bounded text contract.");
  }
}

function validateVectors(vectors: readonly Float32Array[], dimensions: number): Float32Array[] {
  if (!Array.isArray(vectors) || vectors.length > 512) throw new Error("Semantic worker returned an invalid vector batch.");
  return vectors.map((vector) => {
    if (!(vector instanceof Float32Array) || vector.length !== dimensions) throw new Error("Semantic worker returned an invalid vector dimension.");
    if ([...vector].some((value) => !Number.isFinite(value))) throw new Error("Semantic worker returned a non-finite vector.");
    return new Float32Array(vector);
  });
}

/**
 * Fallback used only when no capability policy is available. Presence of
 * navigator.gpu is not activation evidence, so it only decides whether the
 * WebGPU rung is attempted; the worker still reports the backend that loaded.
 */
function defaultAcceleration(): SemanticAccelerationPreference {
  return Object.freeze({
    backend: typeof navigator !== "undefined" && "gpu" in navigator ? "webgpu" : "wasm",
  });
}

/** ORT spawns (count - 1) workers; keep the request inside the policy ceiling. */
function boundedThreads(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.trunc(value))) : 1;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Embedding cancelled.", "AbortError");
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Embedding cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Semantic backend failed.");
}
