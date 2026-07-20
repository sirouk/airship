import { describe, expect, it, vi } from "vitest";
import { verifyContextSelection } from "../core/context-selection";
import { MemoryWorkspace } from "../workspace/memory";
import { ClientContextRuntime, getClientContextRuntime } from "./client-context-runtime";
import type { EmbeddingProvider } from "../indexing/contracts";

describe("ClientContextRuntime", () => {
  it("returns one runtime per workspace and reuses an unchanged generation", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("docs/runtime.md", "A shared local index serves tools, UI, and automatic context.");
    const runtime = getClientContextRuntime(workspace, { dimensions: 64 });
    expect(getClientContextRuntime(workspace)).toBe(runtime);

    const first = await runtime.refreshNow();
    const result = await runtime.search("shared local context");
    expect(runtime.getState().generation?.sequence).toBe(first.sequence);
    expect(result.hits[0]?.path).toBe("/workspace/docs/runtime.md");
  });

  it("observes writes and debounces them into one newest generation", async () => {
    vi.useFakeTimers();
    try {
      const workspace = new MemoryWorkspace();
      const runtime = new ClientContextRuntime(workspace, { dimensions: 64, debounceMs: 20 });
      const observed = runtime.observeWorkspace();
      await observed.write("one.md", "obsolete one");
      await observed.write("one.md", "current two");
      const refreshed = runtime.scheduleRefresh();
      await vi.advanceTimersByTimeAsync(20);
      await refreshed;

      expect(runtime.getState().generation?.sequence).toBe(1);
      const result = await runtime.search("current two");
      expect(result.hits[0]).toMatchObject({ text: "current two" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("seals bounded selected text and exact workspace provenance", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("knowledge.md", "brass turbine ".repeat(500));
    const runtime = new ClientContextRuntime(workspace, { dimensions: 64, maxChunkCharacters: 512 });
    const selection = await runtime.selectForTurn("brass turbine", undefined, { maxHits: 3, maxBytes: 700 });

    expect(selection.hits.length).toBeGreaterThan(0);
    expect(selection.hits.length).toBeLessThanOrEqual(3);
    expect(selection.selectedBytes).toBeLessThanOrEqual(700);
    expect(selection.truncated).toBe(true);
    expect(selection.generationDigest).toBe(runtime.getState().generation?.lineage.generationDigest);
    expect(await verifyContextSelection(selection)).toBe(true);
  });

  it("pins an injected semantic provider across every shared-runtime consumer", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("semantic.md", "local semantic provider seam");
    const embeddings: EmbeddingProvider = {
      id: "mock-semantic@immutable-revision",
      dimensions: 32,
      posture: "local-semantic",
      async embed(texts) {
        return texts.map((text) => {
          const vector = new Float32Array(32);
          vector[0] = text.length || 1;
          return vector;
        });
      },
    };
    const runtime = getClientContextRuntime(workspace, { embeddings });
    const generation = await runtime.refreshNow();

    expect(runtime.embeddingProviderId).toBe(embeddings.id);
    expect(generation.lineage).toMatchObject({
      embeddingProvider: embeddings.id,
      embeddingPosture: "local-semantic",
      embeddingDimensions: 32,
    });
    expect(() => getClientContextRuntime(workspace, {
      embeddings: { ...embeddings, id: "different-model" },
    })).toThrow(`already pinned to ${embeddings.id}`);
  });
});
