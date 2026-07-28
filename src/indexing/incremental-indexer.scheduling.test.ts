import { describe, expect, it } from "vitest";
import {
  deriveAdaptiveSchedulingPolicy,
  type AdaptiveSchedulingPolicy,
  type BrowserCapabilityObservation,
  type BrowserSignalReport,
  type WebAssemblyObservation,
} from "../capabilities/browser-runtime";
import { MemoryWorkspace } from "../workspace/memory";
import type { EmbeddingProvider } from "./contracts";
import { FlatClientIndex } from "./flat-index";
import { IncrementalWorkspaceIndexer } from "./incremental-indexer";

describe("adaptive indexing scheduling", () => {
  it("turns constrained and performance browser policies into materially different work lanes", async () => {
    const constrained = policyFor({ logicalProcessors: 2, deviceMemoryGiB: 2 });
    const performance = policyFor({ logicalProcessors: 12, deviceMemoryGiB: 16 });

    const constrainedRun = await runIndexing(constrained);
    const performanceRun = await runIndexing(performance);

    expect(constrained.class).toBe("constrained");
    expect(constrainedRun.maxConcurrent).toBe(1);
    expect(Math.max(...constrainedRun.batchSizes)).toBeLessThanOrEqual(constrained.embeddingBatchSize);
    expect(constrainedRun.yields).toBeGreaterThan(0);

    expect(performance.class).toBe("performance");
    expect(performanceRun.maxConcurrent).toBeGreaterThan(1);
    expect(Math.max(...performanceRun.batchSizes)).toBeLessThanOrEqual(performance.embeddingBatchSize);
    expect(performanceRun.embeddingCalls).toBeLessThan(constrainedRun.embeddingCalls);
    expect(performanceRun.yields).toBeGreaterThan(0);
  });
});

async function runIndexing(policy: AdaptiveSchedulingPolicy): Promise<Readonly<{
  maxConcurrent: number;
  batchSizes: readonly number[];
  embeddingCalls: number;
  yields: number;
}>> {
  const workspace = new MemoryWorkspace();
  for (let index = 0; index < 4; index += 1) {
    await workspace.write(
      `/workspace/file-${String(index)}.md`,
      Array.from({ length: 24 }, (_, line) => `turbine ${String(index)} segment ${String(line)} carries indexed context`).join("\n"),
      { expectedRevision: null },
    );
  }
  const embeddings = new MeasuringEmbeddings();
  let yields = 0;
  let tick = 0;
  const indexer = new IncrementalWorkspaceIndexer({
    workspace,
    embeddings,
    index: new FlatClientIndex(),
    maxChunkCharacters: 80,
    overlapCharacters: 8,
    scheduling: {
      embeddingBatchSize: policy.embeddingBatchSize,
      maxIndexingConcurrency: policy.maxIndexingConcurrency,
      cooperativeYieldIntervalMs: policy.yieldEveryMs,
      clock: () => { tick += 10; return tick; },
      yieldControl: async () => { yields += 1; await Promise.resolve(); },
    },
  });

  const candidates = await indexer.refresh();
  expect(candidates).toHaveLength(4);
  expect(candidates.every(({ status }) => status === "indexed")).toBe(true);
  return Object.freeze({
    maxConcurrent: embeddings.maxConcurrent,
    batchSizes: Object.freeze([...embeddings.batchSizes]),
    embeddingCalls: embeddings.batchSizes.length,
    yields,
  });
}

class MeasuringEmbeddings implements EmbeddingProvider {
  readonly id = "measuring-embeddings-v1";
  readonly dimensions = 8;
  readonly batchSizes: number[] = [];
  maxConcurrent = 0;
  private active = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.batchSizes.push(texts.length);
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    this.active -= 1;
    return texts.map((text) => {
      const vector = new Float32Array(this.dimensions);
      vector[0] = text.length || 1;
      return vector;
    });
  }
}

function policyFor(input: Readonly<{ logicalProcessors: number; deviceMemoryGiB: number }>): AdaptiveSchedulingPolicy {
  const unavailable: BrowserCapabilityObservation = Object.freeze({
    state: "unavailable",
    evidence: "not-observed",
    detail: "Not observed in scheduling test.",
  });
  const wasm: WebAssemblyObservation = Object.freeze({
    state: "available",
    evidence: "probe-passed",
    detail: "Test WebAssembly probe passed.",
    features: Object.freeze({ simd: true, threads: true, memory64: false, "multi-memory": false, "relaxed-simd": false, "tail-call": false }),
    sharedArrayBuffer: true,
    crossOriginIsolated: true,
  });
  const signals: BrowserSignalReport = Object.freeze({
    logicalProcessors: input.logicalProcessors,
    deviceMemoryGiB: input.deviceMemoryGiB,
    online: true,
    battery: Object.freeze({ state: "unavailable", detail: "Battery API unavailable." }),
    connection: Object.freeze({ state: "unavailable", detail: "Network API unavailable." }),
    thermal: Object.freeze({ state: "unavailable", detail: "No standardized browser thermal API." }),
  });
  return deriveAdaptiveSchedulingPolicy({ webgpu: unavailable, webnn: unavailable, wasm, opfs: unavailable, signals });
}
