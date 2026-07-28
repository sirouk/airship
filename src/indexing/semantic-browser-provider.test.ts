import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserSemanticProvider,
  SwitchableEmbeddingProvider,
  readEmbeddingMode,
  writeEmbeddingMode,
} from "./semantic-browser-provider";
import { AIRSHIP_SEMANTIC_MODEL, LazySemanticWorkerEmbeddingProvider, type SemanticWorkerRequest, type SemanticWorkerResponse } from "./semantic-worker-provider";
import { ClientContextRuntime } from "../retrieval/client-context-runtime";
import { MemoryWorkspace } from "../workspace/memory";
import { getBrowserCapabilityRegistry, type BrowserRuntimeCapabilityReport } from "../capabilities/browser-runtime";

describe("semantic embedding selection", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.stubGlobal("Worker", vi.fn());
  });

  it("is explicit, durable, and bootstrap-safe by default", async () => {
    expect(readEmbeddingMode()).toBe("bootstrap");
    const provider = new SwitchableEmbeddingProvider(384, "bootstrap");
    expect(provider.posture).toBe("deterministic-bootstrap");
    expect(provider.id).toContain("hash");
    expect((await provider.embed(["airship"]))[0]).toHaveLength(384);
    writeEmbeddingMode("semantic");
    expect(readEmbeddingMode()).toBe("semantic");
  });

  it("keeps bootstrap retrieval live when browser preference storage is denied", () => {
    vi.stubGlobal("localStorage", {
      getItem() { throw new DOMException("Storage denied", "SecurityError"); },
      setItem() { throw new DOMException("Storage denied", "SecurityError"); },
    });
    expect(readEmbeddingMode()).toBe("bootstrap");
    expect(() => writeEmbeddingMode("semantic")).not.toThrow();
    expect(new SwitchableEmbeddingProvider().posture).toBe("deterministic-bootstrap");
  });

  it("does not construct the semantic worker while bootstrap mode is active", async () => {
    const worker = vi.spyOn(globalThis, "Worker");
    const provider = new SwitchableEmbeddingProvider(384, "bootstrap");
    await provider.embed(["local only"]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("prefers WebGPU only when the live capability policy selected a probed adapter", async () => {
    const webgpuWorker = new FakeSemanticWorker();
    const webgpuProvider = createBrowserSemanticProvider({
      workerFactory: () => webgpuWorker,
      capabilities: () => ({ scheduling: scheduling("webgpu") }),
    });
    await webgpuProvider.embed(["adapter passed"]);
    expect(webgpuWorker.requests[0]).toMatchObject({ type: "initialize", preferredBackend: "webgpu" });

    const wasmWorker = new FakeSemanticWorker();
    const wasmProvider = createBrowserSemanticProvider({
      workerFactory: () => wasmWorker,
      capabilities: () => ({ scheduling: scheduling("wasm") }),
    });
    await wasmProvider.embed(["adapter absent"]);
    expect(wasmWorker.requests[0]).toMatchObject({ type: "initialize", preferredBackend: "wasm" });
  });

  it("awaits the capability probe instead of sampling a cold snapshot at first embed", async () => {
    const registry = getBrowserCapabilityRegistry();
    const snapshot = vi.spyOn(registry, "snapshot").mockReturnValue(undefined);
    const refresh = vi.spyOn(registry, "refresh").mockResolvedValue(
      { scheduling: scheduling("webgpu") } as BrowserRuntimeCapabilityReport,
    );
    try {
      const worker = new FakeSemanticWorker();
      const provider = createBrowserSemanticProvider({ workerFactory: () => worker });
      await provider.embed(["cold registry at first embed"]);
      // Boot order must not decide the backend: the snapshot is still cold here,
      // and reading it would have latched the WASM fallback for the page.
      expect(snapshot).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalled();
      expect(worker.requests[0]).toMatchObject({ type: "initialize", preferredBackend: "webgpu" });
    } finally {
      snapshot.mockRestore();
      refresh.mockRestore();
    }
  });

  it("carries the power preference and WASM thread count of the live policy into the worker", async () => {
    const constrained = new FakeSemanticWorker();
    await createBrowserSemanticProvider({
      workerFactory: () => constrained,
      capabilities: async () => ({ scheduling: scheduling("wasm", { powerPreference: "low-power", preferredWasmTier: "baseline" }) }),
    }).embed(["unplugged laptop"]);
    expect(constrained.requests[0]).toMatchObject({ powerPreference: "low-power", wasmThreads: 1 });

    const threaded = new FakeSemanticWorker();
    await createBrowserSemanticProvider({
      workerFactory: () => threaded,
      capabilities: async () => ({ scheduling: scheduling("webgpu", { powerPreference: "high-performance", preferredWasmTier: "simd-threads", maxWorkerConcurrency: 6 }) }),
    }).embed(["desktop"]);
    expect(threaded.requests[0]).toMatchObject({ powerPreference: "high-performance", wasmThreads: 6 });
  });

  it("drops the bootstrap materialization and rebuilds every unchanged revision on semantic activation", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/engine.md", "compressor turbine thrust", { expectedRevision: null });
    const provider = new SwitchableEmbeddingProvider(384, "bootstrap", () =>
      new LazySemanticWorkerEmbeddingProvider(() => new FakeSemanticWorker(), () => ({ backend: "wasm" })),
    );
    const runtime = new ClientContextRuntime(workspace, { embeddings: provider });
    const bootstrap = await runtime.refreshNow();
    expect(bootstrap.lineage.embeddingPosture).toBe("deterministic-bootstrap");
    const semantic = await runtime.setEmbeddingMode("semantic");
    expect(semantic.lineage.embeddingPosture).toBe("local-semantic");
    expect(semantic.candidates[0]).toMatchObject({ status: "indexed", chunks: 1 });
    expect(semantic.lineage.embeddingProvider).toContain("mxbai-embed-xsmall-v1");
  });
});

class FakeSemanticWorker {
  readonly requests: SemanticWorkerRequest[] = [];
  private listeners = new Set<(event: MessageEvent<SemanticWorkerResponse>) => void>();
  postMessage(message: SemanticWorkerRequest) {
    this.requests.push(structuredClone(message));
    queueMicrotask(() => {
      if (message.type === "initialize") this.emit({ type: "ready", requestId: message.requestId, manifest: AIRSHIP_SEMANTIC_MODEL, backend: "wasm" });
      if (message.type === "embed") this.emit({ type: "result", requestId: message.requestId, vectors: message.texts.map(() => Float32Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0)) });
    });
  }
  addEventListener(_type: "message", listener: (event: MessageEvent<SemanticWorkerResponse>) => void) { this.listeners.add(listener); }
  removeEventListener(_type: "message", listener: (event: MessageEvent<SemanticWorkerResponse>) => void) { this.listeners.delete(listener); }
  terminate() { this.listeners.clear(); }
  private emit(data: SemanticWorkerResponse) { for (const listener of this.listeners) listener({ data } as MessageEvent<SemanticWorkerResponse>); }
}

function scheduling(
  preferredSemanticBackend: "webgpu" | "wasm",
  overrides: Partial<BrowserRuntimeCapabilityReport["scheduling"]> = {},
): BrowserRuntimeCapabilityReport["scheduling"] {
  return Object.freeze({
    class: "balanced",
    maxWorkerConcurrency: 2,
    maxIndexingConcurrency: 2,
    embeddingBatchSize: 12,
    yieldEveryMs: 12,
    heavyPackLoading: "lazy-on-demand",
    preferredSemanticBackend,
    preferredWasmTier: "simd",
    preferredWorkspaceStorage: "opfs",
    powerPreference: "default",
    reasons: Object.freeze(["test policy"]),
    ...overrides,
  });
}
