import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { EmbeddingMode } from "../indexing/semantic-browser-provider";
import { embeddingEngineNote, embeddingModeNoun, embeddingStatus, indexSummaryText, semanticTone } from "./context-view";

const source = await readFile(new URL("./context-view.tsx", import.meta.url), "utf8");

const MODES: readonly EmbeddingMode[] = Object.freeze(["bootstrap", "semantic"]);

describe("embedding mode copy", () => {
  it("gives each on-device mode a distinct noun", () => {
    const nouns = MODES.map(embeddingModeNoun);
    expect(new Set(nouns).size).toBe(MODES.length);
    expect(embeddingModeNoun("bootstrap")).toBe("bootstrap embeddings");
    expect(embeddingModeNoun("semantic")).toBe("local semantic embeddings");
  });

  it("prints the selected engine in the summary line", () => {
    const bootstrap = indexSummaryText(12, 340, 4_096, "bootstrap");
    const semantic = indexSummaryText(12, 340, 4_096, "semantic");
    expect(bootstrap).toContain("bootstrap embeddings");
    expect(semantic).toContain("local semantic embeddings");
    expect(semantic).not.toContain("bootstrap embeddings");
    expect(bootstrap.startsWith("12 sources · 340 chunks · ")).toBe(true);
  });

  it("keeps both expanded notes private and local", () => {
    const bootstrap = embeddingEngineNote("bootstrap");
    const semantic = embeddingEngineNote("semantic");
    expect(bootstrap.title).toContain("Private embedding engine");
    expect(semantic.title).toContain("Private embedding engine");
    expect(bootstrap.body).toContain("deterministic test/bootstrap signals");
    expect(semantic.body).toContain("isolated browser worker");
    expect(semantic.body).toContain("WebGPU");
    expect(semantic.body).toContain("page-memory only");
  });

  it("keeps each mode's title and body distinct", () => {
    const titles = MODES.map((mode) => embeddingEngineNote(mode).title);
    const bodies = MODES.map((mode) => embeddingEngineNote(mode).body);
    expect(new Set(titles).size).toBe(MODES.length);
    expect(new Set(bodies).size).toBe(MODES.length);
  });
});

describe("the engine toggle group", () => {
  it("renders only the two on-device modes", () => {
    for (const mode of MODES) {
      expect(source, mode).toContain(`aria-pressed={embeddingMode === "${mode}"}`);
      expect(source, mode).toContain(`changeEmbeddingMode("${mode}")`);
    }
    expect(source).not.toContain('changeEmbeddingMode("chutes")');
    expect(source).not.toContain('embeddingMode === "chutes"');
    expect(source).not.toContain("context-confidential-preflight");
  });

  it("renders an unpublished semantic pack as unavailable before interaction", () => {
    expect(source).toContain('disabled={embeddingChange === "changing" || !semanticPackAvailable}');
    expect(embeddingStatus("bootstrap", undefined, "idle", false))
      .toBe("Bootstrap active · local semantic not included in this build");
  });
});

describe("the engine status line", () => {
  it("does not guess a destination while a rebuild is in flight", () => {
    const sentences = new Set(MODES.map((mode) => embeddingStatus(mode, undefined, "changing")));
    expect(sentences).toEqual(new Set(["Rebuilding the index for the selected engine…"]));
  });

  it("keeps bootstrap and local semantic status truthful", () => {
    expect(embeddingStatus("bootstrap", undefined, "idle")).toBe("Bootstrap active · no model loaded");
    expect(embeddingStatus("semantic", undefined, "idle")).toBe("Semantic selected · starts on first index operation");
    expect(embeddingStatus("semantic", { phase: "ready", backend: "webgpu" }, "idle")).toBe("WebGPU semantic model ready");
  });

  it("keeps the semantic tone local and worker-driven", () => {
    expect(semanticTone("bootstrap")).toBe("neutral");
    expect(semanticTone("semantic")).toBe("neutral");
    expect(semanticTone("semantic", { phase: "ready", backend: "wasm" })).toBe("ready");
    expect(semanticTone("semantic", { phase: "failed" })).toBe("error");
  });
});
