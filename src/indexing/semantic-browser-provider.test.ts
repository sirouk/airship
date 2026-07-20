import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwitchableEmbeddingProvider, readEmbeddingMode, writeEmbeddingMode } from "./semantic-browser-provider";
import { AIRSHIP_SEMANTIC_MODEL, LazySemanticWorkerEmbeddingProvider, type SemanticWorkerRequest, type SemanticWorkerResponse } from "./semantic-worker-provider";
import { ClientContextRuntime } from "../retrieval/client-context-runtime";
import { MemoryWorkspace } from "../workspace/memory";

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

  it("does not construct the semantic worker while bootstrap mode is active", async () => {
    const worker = vi.spyOn(globalThis, "Worker");
    const provider = new SwitchableEmbeddingProvider(384, "bootstrap");
    await provider.embed(["local only"]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("drops the bootstrap materialization and rebuilds every unchanged revision on semantic activation", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("/workspace/engine.md", "compressor turbine thrust", { expectedRevision: null });
    const provider = new SwitchableEmbeddingProvider(384, "bootstrap", () =>
      new LazySemanticWorkerEmbeddingProvider(() => new FakeSemanticWorker(), () => false),
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
  private listeners = new Set<(event: MessageEvent<SemanticWorkerResponse>) => void>();
  postMessage(message: SemanticWorkerRequest) {
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
