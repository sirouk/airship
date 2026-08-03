import { describe, expect, it } from "vitest";
import { FlatClientIndex } from "./flat-index";
import type { EmbeddedChunk } from "./contracts";

/*
 * This index had no test of its own, which is how it kept a lexical score with
 * no inverse document frequency in the lane that feeds automatic turn context.
 * These cases pin the properties that distinguish BM25 from the set-overlap
 * coefficient it replaced — a rare term outranking a ubiquitous one, and term
 * frequency counting at all.
 */

const DIM = 4;

function chunk(id: string, text: string, vector: number[]): EmbeddedChunk {
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return {
    id,
    path: `${id}.md`,
    revision: "r1",
    contentDigest: id,
    chunkIndex: 0,
    text,
    tokens,
    vector: Float32Array.from(vector),
  };
}

/** Orthogonal to every fixture vector, so dense contributes nothing to ranking. */
const NEUTRAL = Float32Array.from([0, 0, 0, 1]);

async function seed(index: FlatClientIndex): Promise<void> {
  // "the" appears in every document; "kestrel" in exactly one.
  await index.upsert([
    chunk("a", "the the the kestrel returned to the mast", [1, 0, 0, 0]),
    chunk("b", "the the the the harbour was quiet", [0, 1, 0, 0]),
    chunk("c", "the the the the the lantern swung", [0, 0, 1, 0]),
  ]);
}

describe("FlatClientIndex lexical scoring", () => {
  it("ranks by a term that discriminates, not by one every document shares", async () => {
    const index = new FlatClientIndex("lexical");
    await seed(index);

    const hits = await index.search(NEUTRAL, ["kestrel"], 3);

    expect(hits[0]?.chunkId, "the only document containing the rare term leads").toBe("a");
    expect(hits[0]?.lexicalScore).toBeGreaterThan(0);
    // The other two contain none of the query's discriminating terms.
    expect(hits[1]?.lexicalScore).toBe(0);
    expect(hits[2]?.lexicalScore).toBe(0);
  });

  it("gives a term present in every document no selective power", async () => {
    const index = new FlatClientIndex("lexical");
    await seed(index);

    const hits = await index.search(NEUTRAL, ["the"], 3);

    // "the" is in 3 of 3 documents and is a two-character Latin token, so it is
    // not a content term and cannot select. The previous coefficient scored it.
    for (const hit of hits) expect(hit.lexicalScore).toBe(0);
  });

  it("returns zero rather than guessing when nothing discriminates", async () => {
    const index = new FlatClientIndex("lexical");
    await seed(index);

    const hits = await index.search(NEUTRAL, ["albatross"], 3);

    for (const hit of hits) expect(hit.lexicalScore).toBe(0);
  });
});

describe("FlatClientIndex retrieval modes", () => {
  it("hybrid blends both signals and reports each separately", async () => {
    const index = new FlatClientIndex();
    await seed(index);

    const [top] = await index.search(Float32Array.from([1, 0, 0, 0]), ["kestrel"], 1);

    expect(top?.chunkId).toBe("a");
    expect(top?.denseScore).toBeGreaterThan(0.9);
    expect(top?.lexicalScore).toBeGreaterThan(0);
    // Neither component is discarded: the composite sits between them.
    expect(top!.score).toBeLessThan(top!.denseScore);
    expect(top!.score).toBeGreaterThan(top!.lexicalScore * 0.28 - 1e-9);
  });

  it("semantic mode ignores the lexical signal entirely", async () => {
    const index = new FlatClientIndex("semantic");
    await seed(index);

    // The query term only occurs in "a", but the vector points at "c".
    const [top] = await index.search(Float32Array.from([0, 0, 1, 0]), ["kestrel"], 1);

    expect(top?.chunkId).toBe("c");
    expect(top?.score).toBe(top?.denseScore);
  });

  it("lexical mode ignores the dense signal entirely", async () => {
    const index = new FlatClientIndex("lexical");
    await seed(index);

    // The vector points at "c", but only "a" carries the discriminating term.
    const [top] = await index.search(Float32Array.from([0, 0, 1, 0]), ["kestrel"], 1);

    expect(top?.chunkId).toBe("a");
    expect(top?.score).toBe(top?.lexicalScore);
  });

  it("defaults to hybrid", async () => {
    const index = new FlatClientIndex();
    await seed(index);
    const [top] = await index.search(Float32Array.from([1, 0, 0, 0]), ["kestrel"], 1);
    expect(top?.score).not.toBe(top?.denseScore);
    expect(top?.score).not.toBe(top?.lexicalScore);
  });
});

describe("FlatClientIndex corpus statistics", () => {
  it("scores an empty index without throwing", async () => {
    const index = new FlatClientIndex();
    expect(await index.search(NEUTRAL, ["kestrel"], 5)).toEqual([]);
  });

  it("drops a path's chunks from the corpus, not just from the results", async () => {
    const index = new FlatClientIndex("lexical");
    await seed(index);
    await index.removeByPath("a.md");

    const hits = await index.search(NEUTRAL, ["kestrel"], 5);

    expect(hits).toHaveLength(2);
    // With the only bearer gone the term is in no document and selects nothing.
    for (const hit of hits) expect(hit.lexicalScore).toBe(0);
  });

  it("keeps the dimension guard", async () => {
    const index = new FlatClientIndex();
    await seed(index);
    await expect(index.search(Float32Array.from([1, 0]), ["kestrel"], 1))
      .rejects.toThrow(/dimension/iu);
  });
});
