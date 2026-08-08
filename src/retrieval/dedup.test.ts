import { describe, expect, it } from "vitest";
import {
  DEDUP_MIN_CONTENT_TERMS,
  clusterDuplicatePairs,
  findDedupCandidates,
  findDuplicateClusters,
  findDuplicatePairs,
  jaroWinkler,
  normalizeDedupText,
  pickRepresentative,
} from "./dedup";

const select = (record: { content: string }) => record.content;
const r = (content: string, createdAt = "2026-08-07T00:00:00.000Z") => Object.freeze({ content, createdAt });

describe("normalizeDedupText", () => {
  it("folds case, punctuation and spacing into one normalized fact", () => {
    expect(normalizeDedupText("  Prefer METRIC units, always!! ")).toBe(normalizeDedupText("prefer metric units always"));
  });

  it("keeps CJK text comparable across scripts without mangling", () => {
    expect(normalizeDedupText("lios docu menta nos")).toBe("lios docu menta nos");
    expect(normalizeDedupText("ACME — 42")).toBe("acme 42");
    // The class that survives normalization is `\p{L}\p{N}`, not `a-z0-9`:
    // Han and Kana are letters and stay, while the CJK comma and full stop
    // fold to a space like any other punctuation. Narrow that class and every
    // non-Latin memory normalizes to the empty string, which the exact lane
    // would then read as one enormous group of identical facts.
    expect(normalizeDedupText("東京は晴れ、42度。")).toBe("東京は晴れ 42度");
  });
});

describe("jaroWinkler", () => {
  it("scores identical strings as 1 and disjoint strings as 0", () => {
    expect(jaroWinkler("alpha", "alpha")).toBe(1);
    expect(jaroWinkler("abcd", "wxyz")).toBe(0);
  });

  it("ranks near-identical prose very high — the trap this module must not trust alone", () => {
    // This is exactly the precision hazard the containment gate exists for.
    expect(jaroWinkler("lives in berlin", "lives in paris")).toBeGreaterThan(0.9);
  });
});

describe("findDuplicatePairs", () => {
  it("flags normalized-identical records as an exact pair", () => {
    const pairs = findDuplicatePairs([
      r("Prefer metric units in every generated report."),
      r("prefer METRIC units   in every generated report"),
    ], select);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: 0, b: 1, exact: true, similarity: 1 });
  });

  it("flags a lightly reworded near-duplicate", () => {
    const pairs = findDuplicatePairs([
      r("The turbine pressure limit is 42 bar."),
      r("The turbine pressure limit is 42 bar at inlet."),
    ], select);
    expect(pairs.some((pair) => !pair.exact && pair.similarity > 0.87)).toBe(true);
  });

  it("NEVER merges records whose text normalizes away to nothing", () => {
    /*
     * The hazard the CJK test above names in prose: anything that reduces to
     * the empty string — punctuation-only notes, an emoji, a lone arrow —
     * shared one group key, and the exact lane reported every pair of them at
     * similarity 1. That is the strongest claim this module makes, resting on
     * no surviving content at all. Two records with nothing in common are not
     * duplicates because normalization left them both empty.
     */
    expect(normalizeDedupText("!!! ---")).toBe("");
    expect(normalizeDedupText("→→→")).toBe("");
    const pairs = findDuplicatePairs([r("!!! ---"), r("→→→"), r("?? ...")], select);
    expect(pairs).toHaveLength(0);
  });

  it("NEVER merges same-frame different-fact records (Berlin vs Paris)", () => {
    const pairs = findDuplicatePairs([
      r("The owner lives in Berlin."),
      r("The owner lives in Paris."),
    ], select);
    expect(pairs).toHaveLength(0);
  });

  it("never merges short template facts sharing a frame", () => {
    const pairs = findDuplicatePairs([
      r("Release gate is green."),
      r("Release gate is red."),
    ], select);
    expect(pairs).toHaveLength(0);
  });

  it("keeps sparse records to exact-match only", () => {
    const short = "uses TypeScript";
    expect(short.split(" ").length - 1).toBeLessThan(DEDUP_MIN_CONTENT_TERMS);
    const pairs = findDuplicatePairs([r(short), r("uses TypeScript strictly")], select);
    expect(pairs).toHaveLength(0);
    const exact = findDuplicatePairs([r(short), r("Uses typescript")], select);
    expect(exact).toHaveLength(1);
  });

  it("respects the scope partition: identical text in two scopes is an intended duplicate", () => {
    const pairs = findDuplicatePairs(
      [
        { content: "The deployment key rotates every 90 days.", scopeKey: "profile-a" },
        { content: "The deployment key rotates every 90 days.", scopeKey: "profile-b" },
      ] as const,
      (record) => record.content,
      (record) => record.scopeKey,
    );
    expect(pairs).toHaveLength(0);
  });

  it("is deterministic across runs", () => {
    const corpus = [
      r("Turn the vault fully keyless.", "2026-08-01T00:00:00.000Z"),
      r("turn the vault fully keyless now", "2026-08-03T00:00:00.000Z"),
      r("Separate fact entirely: beta waves register 11 Hz.", "2026-08-02T00:00:00.000Z"),
    ];
    const first = findDuplicatePairs(corpus, select);
    const second = findDuplicatePairs(corpus, select);
    expect(first).toEqual(second);
  });
});

describe("clusters and representatives", () => {
  it("merges a rephrased chain into one cluster and keeps the longest wording", () => {
    const records = [
      r("The turbine pressure limit is 42 bar.", "2026-08-01T00:00:00.000Z"),
      r("turbine pressure limit is 42 bar", "2026-08-03T00:00:00.000Z"),
      r("The turbine pressure limit is 42 bar at the inlet manifold.", "2026-08-02T00:00:00.000Z"),
    ];
    const pairs = findDuplicatePairs(records, select);
    const clusters = clusterDuplicatePairs(records, pairs, select, (record) => record.createdAt);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toEqual([0, 1, 2]);
    expect(clusters[0]!.representative).toBe(2);
  });

  it("keeps two separate clusters when the bridge pair would be wrong", () => {
    const records = [
      r("The turbine pressure limit is 42 bar."),
      r("The turbine pressure limit is 42 bar at inlet."),
      r("The deployment key rotates every 90 days."),
      r("The deployment key rotates every ninety days."),
    ];
    const clusters = findDuplicateClusters(records, select);
    // Exactly two clusters, each holding its own world: a bound of "at most
    // two" is also satisfied by finding nothing at all, which is a recall
    // collapse rather than the separation this test is named for.
    expect(clusters.map((cluster) => cluster.members)).toEqual([[0, 1], [2, 3]]);
    // The two worlds must never fuse into one cluster of four.
    expect(clusters.some((cluster) => cluster.members.length === 4)).toBe(false);
  });
});

describe("findDedupCandidates (pin-time probe)", () => {
  const stored = [
    r("The turbine pressure limit is 42 bar."),
    r("The owner lives in Berlin."),
    r("Prefer metric units in every generated report."),
  ];

  it("reports the exact match first", () => {
    const candidates = findDedupCandidates("the TURBINE pressure limit is 42 BAR", stored, select);
    expect(candidates[0]).toMatchObject({ index: 0, exact: true, similarity: 1 });
  });

  it("reports a near-match against a lightly extended wording", () => {
    const candidates = findDedupCandidates("The turbine pressure limit is 42 bar at inlet.", stored, select);
    expect(candidates.some((candidate) => candidate.index === 0 && !candidate.exact)).toBe(true);
  });

  it("stays silent on a genuinely new fact", () => {
    expect(findDedupCandidates("Calico cats nap 16 hours a day.", stored, select)).toHaveLength(0);
  });

  it("stays silent on the same frame with different substance", () => {
    expect(findDedupCandidates("The owner lives in Paris.", stored, select)).toHaveLength(0);
  });
});

describe("performance envelope", () => {
  it("a 512-record pass stays in the phone-attention budget", () => {
    const corpus = Array.from({ length: 512 }, (_, index) =>
      r(`Fact number ${index}: the numbered valve ${index % 17} tolerates ${40 + (index % 9)} bar.`, `2026-08-0${(index % 9) + 1}T00:00:00.000Z`),
    );
    const started = performance.now();
    findDuplicateClusters(corpus, select);
    const elapsed = performance.now() - started;
    // The gate: under 250ms on a laptop-class CI runner; a phone is roughly
    // 3x slower and still inside the attention budget.
    expect(elapsed).toBeLessThan(250);
  });
});
