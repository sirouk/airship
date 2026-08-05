import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { EmbeddingMode } from "../indexing/semantic-browser-provider";
import { embeddingEngineNote, embeddingModeNoun, embeddingStatus, indexSummaryText, semanticTone } from "./context-view";

const source = await readFile(new URL("./context-view.tsx", import.meta.url), "utf8");

const MODES: readonly EmbeddingMode[] = Object.freeze(["bootstrap", "semantic", "chutes"]);

/*
 * Third-mode debt.
 *
 * `EmbeddingMode` has had three members for as long as `SwitchableEmbeddingProvider`
 * has had a confidential branch, but every string on this screen was written as a
 * two-branch ternary — `mode === "semantic" ? … : …` — so `chutes` silently took
 * the *else* arm everywhere. The else arm was always the on-device one, which is
 * the worst possible direction for the error to run: a remote engine reported
 * itself as a local one, in the status row's text, in the accessible name of the
 * collapsed disclosure, and in the expanded panel's "Private embedding engine".
 *
 * These assert the mode's own words, and that no mode borrows another's.
 */
describe("every embedding mode names itself", () => {
  it("gives each mode a distinct noun", () => {
    const nouns = MODES.map(embeddingModeNoun);
    expect(new Set(nouns).size).toBe(MODES.length);
    expect(embeddingModeNoun("chutes")).toBe("confidential remote embeddings");
  });

  it("prints the confidential engine in the summary line rather than 'bootstrap'", () => {
    const summary = indexSummaryText(12, 340, 4_096, "chutes");
    expect(summary).toContain("confidential remote embeddings");
    expect(summary).not.toContain("bootstrap");
    expect(summary).not.toContain("local semantic");
    // The counts are unchanged by the mode; only the engine clause is.
    expect(summary.startsWith("12 sources · 340 chunks · ")).toBe(true);
  });

  it("does not call a remote engine private in the expanded panel", () => {
    const note = embeddingEngineNote("chutes");
    expect(note.title).not.toContain("Private");
    expect(note.title).toContain("Chutes confidential compute");
    /*
     * The two facts this panel owns. The egress claim itself is not restated
     * here — `CHUTES_CONFIDENTIAL_EMBEDDING_PREFLIGHT` is on screen whenever
     * this mode is reachable and `egress-preflight.test.ts` binds it — so what
     * is left is which model runs, and what does not leave.
     */
    expect(note.body).toContain("page-memory only");
    expect(note.body).toContain("TEE");

    for (const mode of ["bootstrap", "semantic"] as const) {
      expect(embeddingEngineNote(mode).title).toContain("Private embedding engine");
    }
  });

  /*
   * This is the assertion the old one should have been.
   *
   * The previous test pinned the literal "Qwen3-Embedding-8B", which is exactly
   * what made a hardcoded model name survive a batch whose whole purpose was
   * removing hardcoded model names: the test agreed with the bug. What the
   * sentence owes a person is the model that is *actually* serving their text,
   * so the test names two different ones and requires the sentence to follow.
   */
  it("names the discovered chute, and admits when discovery has not answered", () => {
    const discovered = embeddingEngineNote("chutes", "Qwen/Qwen3-Embedding-8B-TEE");
    expect(discovered.body).toContain("Qwen/Qwen3-Embedding-8B-TEE");

    const other = embeddingEngineNote("chutes", "BAAI/bge-m3-TEE");
    expect(other.body).toContain("BAAI/bge-m3-TEE");
    expect(other.body).not.toContain("Qwen");

    // Before discovery answers there is no model to name, and inventing one
    // would be the original bug wearing a different string.
    const unknown = embeddingEngineNote("chutes");
    expect(unknown.body).not.toContain("Qwen");
    expect(unknown.body).toContain("the embedding chute you selected");

    // The on-device engines take no model argument and must ignore one.
    for (const mode of ["bootstrap", "semantic"] as const) {
      expect(embeddingEngineNote(mode, "BAAI/bge-m3-TEE")).toEqual(embeddingEngineNote(mode));
    }
  });

  it("keeps every mode's note and noun distinct", () => {
    const titles = MODES.map((mode) => embeddingEngineNote(mode).title);
    const bodies = MODES.map((mode) => embeddingEngineNote(mode).body);
    expect(new Set(titles).size).toBe(MODES.length);
    expect(new Set(bodies).size).toBe(MODES.length);
  });
});

/*
 * `aria-pressed` on a toggle group is a statement about the whole group: with
 * two buttons and three modes, a confidential index made both of them report
 * `false`, so a screen reader was told nothing was selected while an engine was
 * demonstrably running. The third button is the fix, and it has to survive the
 * authority being withdrawn — otherwise releasing Chutes reintroduces the exact
 * same "nothing is selected" state it was added to remove.
 */
describe("the engine toggle group always has a pressed member", () => {
  it("renders a button for every member of the union", () => {
    for (const mode of MODES) {
      expect(source, mode).toContain(`aria-pressed={embeddingMode === "${mode}"}`);
      expect(source, mode).toContain(`changeEmbeddingMode("${mode}")`);
    }
  });

  it("keeps the confidential button mounted while it is the mode in force", () => {
    // Not `confidentialAvailable` alone: that hides the selected button the
    // moment the credential is released.
    expect(source).toContain(`{confidentialAvailable || embeddingMode === "chutes" ? (`);
    // …and disables it when there is no authority, so the group can state the
    // mode without offering a press that could only fail.
    expect(source).toContain(`disabled={embeddingChange === "changing" || !confidentialAvailable}`);
  });

  it("renders an unpublished semantic pack as unavailable before interaction", () => {
    expect(source).toContain(`disabled={embeddingChange === "changing" || !semanticPackAvailable}`);
    expect(embeddingStatus("bootstrap", undefined, "idle", true, false))
      .toBe("Bootstrap active · local semantic not included in this build");
  });

});

/*
 * The status line beside the toggle, which had no confidential arm at all: the
 * `chutes` mode fell through the `bootstrap` guard into the semantic branches
 * and, with no `SemanticProviderState` to read, reported "Semantic selected ·
 * starts on first index operation" over a remote engine.
 */
describe("the engine status line", () => {
  it("names the confidential engine and says where the text goes", () => {
    const status = embeddingStatus("chutes", undefined, "idle", true);
    expect(status).toContain("Confidential embeddings active");
    expect(status).toContain("leaves this page");
    expect(status).not.toContain("Semantic");
    expect(semanticTone("chutes", undefined, true)).toBe("ready");
  });

  it("refuses to show a running engine that cannot authorize", () => {
    // Releasing Chutes does not change the mode; it removes the authority. The
    // next rebuild will reject, and this says so before it does.
    expect(embeddingStatus("chutes", undefined, "idle", false))
      .toBe("Confidential embeddings unavailable · Chutes is not connected");
    expect(semanticTone("chutes", undefined, false)).toBe("error");
  });

  it("does not guess a destination while a rebuild is in flight", () => {
    /*
     * `embeddingMode` still holds the mode being *left* until the rebuild
     * resolves, so any sentence naming a destination is a guess — and with
     * three modes it is wrong more often than right. Every direction gets the
     * one sentence that is true of all of them.
     */
    const sentences = new Set(MODES.map((mode) => embeddingStatus(mode, undefined, "changing")));
    expect(sentences).toEqual(new Set(["Rebuilding the index for the selected engine…"]));
  });

  it("leaves the two on-device modes exactly as they were", () => {
    expect(embeddingStatus("bootstrap", undefined, "idle")).toBe("Bootstrap active · no model loaded");
    expect(embeddingStatus("semantic", undefined, "idle")).toBe("Semantic selected · starts on first index operation");
    expect(embeddingStatus("semantic", { phase: "ready", backend: "webgpu" }, "idle")).toBe("WebGPU semantic model ready");
  });
});
