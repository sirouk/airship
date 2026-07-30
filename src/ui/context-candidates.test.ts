import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ClientContextCandidate } from "../indexing/client-context-engine";
import { CONTEXT_CANDIDATE_PAGE_SIZE, contextCandidateWindow, orderCandidates } from "./context-view";

const source = await readFile(new URL("./context-view.tsx", import.meta.url), "utf8");

function candidate(path: string, status: ClientContextCandidate["status"] = "indexed"): ClientContextCandidate {
  return { path, status, revision: `rev-${path}`, chunkIds: [], chunks: 0, size: 10, reason: "" } as unknown as ClientContextCandidate;
}

/*
 * The candidate list had no bound of its own.
 *
 * `repository-import` admits up to 10,000 files and the engine's only ceiling
 * is `MAX_SNAPSHOT_ENTRIES = 250_000`, while the upstream presentation cap was
 * deliberately removed on the grounds that "bounding belongs in the consumers
 * that need it". This consumer had none: it mounted one `<article>` per
 * workspace entry, each eagerly mounting a provenance popover — `Popover`
 * always renders its children — so one ordinary GitHub import built ~10,000
 * `<dl>`s of 8+ rows with a copy button apiece.
 */
describe("vectorization candidate window", () => {
  const many = Array.from({ length: 10_000 }, (_, index) => candidate(`/workspace/file-${index}.ts`));

  it("mounts a bounded number of rows, not one per workspace entry", () => {
    const window = contextCandidateWindow(many, 1);
    expect(window.shown).toHaveLength(CONTEXT_CANDIDATE_PAGE_SIZE);
    expect(window.total).toBe(10_000);
    expect(window.bounded).toBe(true);
  });

  it("states both the shown count and the true total", () => {
    const window = contextCandidateWindow(many, 1);
    expect(window.sentence).toContain(CONTEXT_CANDIDATE_PAGE_SIZE.toLocaleString());
    expect(window.sentence).toContain((10_000).toLocaleString());
  });

  it("raises the bound without disturbing the rows already shown", () => {
    const first = contextCandidateWindow(many, 1);
    const second = contextCandidateWindow(many, 2);
    expect(second.shown).toHaveLength(CONTEXT_CANDIDATE_PAGE_SIZE * 2);
    // Same objects in the same order: the keys are `path:revision`, so Preact
    // reuses the mounted rows instead of rebuilding every popover.
    expect(second.shown.slice(0, first.shown.length)).toEqual([...first.shown]);
  });

  it("says nothing about a bound when every source is on screen", () => {
    const window = contextCandidateWindow(many.slice(0, 12), 1);
    expect(window.bounded).toBe(false);
    expect(window.shown).toHaveLength(12);
    expect(window.next).toBe(0);
  });

  it("keeps every row a person has to act on inside the first page", () => {
    // The cut is only safe because degraded rows sort first, so the ordering
    // rule and the bound are applied by the same function.
    const degraded = [
      candidate("/workspace/broken.ts", "failed"),
      candidate("/workspace/huge.bin", "too-large"),
      candidate("/workspace/image.png", "unsupported"),
    ];
    const window = contextCandidateWindow([...many, ...degraded], 1);
    for (const row of degraded) {
      expect(window.shown.some((shown) => shown.path === row.path), row.path).toBe(true);
    }
    expect(window.shown.slice(0, degraded.length)).toEqual(orderCandidates(degraded).slice(0, degraded.length));
  });

  it("renders the window and its footer instead of the whole candidate array", () => {
    expect(source).toContain("contextCandidateWindow(generation?.candidates ?? [], candidatePages)");
    expect(source).toContain("{candidateWindow.shown.map((candidate) => (");
    expect(source).not.toContain("{orderCandidates(generation.candidates).map((candidate) => (");
    expect(source).toContain('<div class="context-candidate-bound" role="status">');
    expect(source).toContain("<p>{candidateWindow.sentence}</p>");
    expect(source).toContain("onClick={() => setCandidatePages((value) => value + 1)}");
  });
});
