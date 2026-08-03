import { describe, expect, it } from "vitest";
import { MemoryWorkspace } from "../workspace/memory";
import { ClientContextEngine, SEMANTIC_DENSE_FLOOR, classifyRetrievalHit } from "./client-context-engine";
import { chunkSearchTokens } from "./incremental-indexer";

/*
 * The two halves of one retrieval contract, both measured on the shipped route.
 *
 * (1) "Kyoto" — a word no workspace file contains — was reported as
 *     "Workspace & sources · 1 result · /workspace/README.md" with the whole
 *     README printed, its real score "Dense 0.065 · Lexical 0.000 · Combined
 *     0.046" three disclosures down.
 * (2) The route's own suggestion chip, minted from the path notes/retrieval.md,
 *     returned "No memory matched “retrieval”" beside an Index panel reading
 *     "INDEXED notes/retrieval.md · 1 chunk".
 *
 * A floor without path tokens would have deepened (2); path tokens without a
 * floor leave (1). They are one contract, so they are tested as one.
 */
describe("retrieval confidence floor", () => {
  it("disqualifies a bootstrap hit with no lexical overlap, and says why", () => {
    const verdict = classifyRetrievalHit({ denseScore: 0.065, lexicalScore: 0, score: 0.046 }, "deterministic-bootstrap");
    expect(verdict.confidence).toBe("weak");
    expect(verdict.weakBecause).toContain("No word of the query appears here");
    expect(verdict.weakBecause).toContain("0.065");
    // The default posture is the bootstrap one: a provider that declares
    // nothing must not be trusted with the dense-only path.
    expect(classifyRetrievalHit({ denseScore: 0.9, lexicalScore: 0, score: 0.648 }).confidence).toBe("weak");
  });

  it("keeps any real word overlap, however small, as a match", () => {
    expect(classifyRetrievalHit({ denseScore: 0.02, lexicalScore: 0.11, score: 0.045 }, "deterministic-bootstrap").confidence).toBe("confident");
    expect(classifyRetrievalHit({ denseScore: 0.02, lexicalScore: 0.11, score: 0.045 }, "deterministic-bootstrap").weakBecause).toBeUndefined();
  });

  it("gives a real local model the dense-only path a hash provider must not have", () => {
    expect(classifyRetrievalHit({ denseScore: SEMANTIC_DENSE_FLOOR, lexicalScore: 0, score: 0.252 }, "local-semantic").confidence).toBe("confident");
    const below = classifyRetrievalHit({ denseScore: 0.19, lexicalScore: 0, score: 0.137 }, "local-semantic");
    expect(below.confidence).toBe("weak");
    expect(below.weakBecause).toContain("similarity floor");
  });
});

describe("path tokens in the searchable set", () => {
  it("makes a file findable by its own name without moving what it is about", () => {
    const tokens = chunkSearchTokens("/workspace/notes/retrieval.md", "The freshness window was 300 seconds.");
    expect(tokens).toContain("retrieval");
    expect(tokens).toContain("notes");
    expect(tokens).toContain("freshness");
    // The mount point is not part of any file's name: tokenizing it would make
    // "workspace" a term that lexically matches the entire corpus.
    expect(tokens).not.toContain("workspace");
  });

  it("counts a word that is in both the path and the body exactly once", () => {
    const tokens = chunkSearchTokens("/workspace/notes/retrieval.md", "retrieval retrieval");
    expect(tokens.filter((token) => token === "retrieval")).toHaveLength(2);
  });
});

describe("ClientContextEngine hit classification", () => {
  it("returns the nearest row for an absent word, marked as no match", async () => {
    const workspace = new MemoryWorkspace();
    await workspace.write("README.md", "# Airship workspace\nThis private virtual workspace is rooted at `/workspace`. Its live durability follows the selected Vault: Local Device, Google Drive, S3-compatible object storage, or Ephemeral page memory.");
    await workspace.write("notes/retrieval.md", "The freshness window was 300 seconds per the spec note.");
    /*
     * 48 dimensions, because the defect *is* a bucket collision and a collision
     * needs a crowded table to be reproducible in three files. The shipped 384
     * produced the same shape on the real workspace — "Dense 0.065 · Lexical
     * 0.000 · Combined 0.046" for "Kyoto" — and what is asserted here is the
     * classification, which does not depend on which pair collided.
     */
    const engine = new ClientContextEngine({ workspace, dimensions: 48 });
    await engine.updateWorkspace(await workspace.list());

    const absent = await engine.search("Kyoto");
    // Nothing is filtered away — the row is still returned, still carries its
    // scores and lineage — it simply may not be counted as a result.
    expect(absent.hits.length).toBeGreaterThan(0);
    expect(absent.hits[0]!.lexicalScore).toBe(0);
    expect(absent.hits[0]!.denseScore).toBeGreaterThan(0);
    expect(absent.hits.every((hit) => hit.confidence === "weak")).toBe(true);
    expect(absent.hits.every((hit) => Boolean(hit.weakBecause))).toBe(true);

    // …and the suggestion chip the route mints from a path now finds the file
    // that path names, in the same lane the chip's own label promises.
    const byName = await engine.search("retrieval");
    const confident = byName.hits.filter((hit) => hit.confidence === "confident");
    expect(confident.map((hit) => hit.path)).toContain("/workspace/notes/retrieval.md");

    const byBody = await engine.search("freshness window");
    expect(byBody.hits.filter((hit) => hit.confidence === "confident").map((hit) => hit.path))
      .toContain("/workspace/notes/retrieval.md");
    engine.dispose();
  });
});
