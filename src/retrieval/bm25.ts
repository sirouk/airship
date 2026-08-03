/**
 * One BM25, for every lane that ranks text.
 *
 * There were two. `memory-ranking.ts` scored explicit profile memory with a real
 * BM25 — saturation, length normalization, inverse document frequency — while
 * the workspace/source index that feeds automatic turn context scored with
 * `matches / sqrt(|query| * |document|)`: an Otsuka–Ochiai set coefficient with
 * no IDF at all. In that lane a hit on "the" counted exactly as much as a hit on
 * a rare identifier, a term repeated twenty times counted once because the
 * document was a Set, and the only length signal was a square root.
 *
 * That is the wrong way round. Profile memory is a bounded corpus a person
 * curated; the workspace index is thousands of chunks the agent reads from on
 * every turn, and it is precisely where discrimination matters most.
 *
 * So the ranker moved here and both lanes call it. The constants and the
 * discriminating-term rule are the ones `memory-ranking.ts` already shipped and
 * its tests already pin — this is that scorer, extracted, not a second opinion
 * about it.
 */

/** Term-frequency saturation. Standard BM25. */
export const BM25_K1 = 1.2;
/** Length normalization. Standard BM25. */
export const BM25_B = 0.75;

const TOKEN = /[\p{L}\p{N}_-]{2,}/gu;

export function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().match(TOKEN) ?? [];
}

/**
 * Two-character Latin tokens are function words ("in", "of"); two-character
 * tokens in other scripts are whole words, so script decides rather than a
 * language-specific stop list.
 */
export function isContentTerm(term: string): boolean {
  return term.length >= 3 || /[^\p{Script=Latin}\p{N}_-]/u.test(term);
}

export function termFrequencies(terms: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

export type Bm25Ranker = Readonly<{
  /**
   * BM25 for one document, divided by the best score this query could achieve
   * against any document. The result is bounded to 0..1 so a lane can blend it
   * with a cosine similarity without one term silently dominating by scale.
   */
  score(documentIndex: number): number;
  /**
   * The query terms that actually discriminate within this corpus. Empty means
   * no term could select a document, and every score is 0 — which is the honest
   * answer, not a reason to fall back to something weaker.
   */
  discriminatingTerms: readonly string[];
}>;

/**
 * Prepare a ranker over one already-scoped corpus.
 *
 * Corpus statistics are the whole point of BM25 and cannot be computed per
 * document, so this takes the corpus once and returns a scorer over it. Callers
 * that score in a loop therefore pay for document frequency once rather than
 * once per candidate.
 */
export function prepareBm25(
  documents: readonly (readonly string[])[],
  queryTerms: readonly string[],
): Bm25Ranker {
  const size = documents.length;
  if (!size || !queryTerms.length) {
    return Object.freeze({ score: () => 0, discriminatingTerms: Object.freeze([]) });
  }

  const frequencies = documents.map(termFrequencies);
  const lengths = documents.map((terms) => terms.length);
  const averageLength = lengths.reduce((total, length) => total + length, 0) / size || 1;

  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const counts of frequencies) if (counts.has(term)) count += 1;
    documentFrequency.set(term, count);
  }

  /*
   * Only discriminating terms count, in both the score and the ideal it is
   * normalized against. A term in no document cannot select one. A term in most
   * documents cannot select one either, and a short Latin token is a function
   * word in practice, so incidental "in"/"the" overlap must not read as
   * evidence.
   */
  const commonCeiling = Math.max(1, Math.floor(size / 2));
  const discriminating = queryTerms.filter((term) => {
    const frequency = documentFrequency.get(term) ?? 0;
    return frequency > 0 && frequency <= commonCeiling && isContentTerm(term);
  });

  const idf = new Map(discriminating.map((term) => {
    const frequency = documentFrequency.get(term) ?? 0;
    return [term, Math.log(1 + (size - frequency + 0.5) / (frequency + 0.5))] as const;
  }));

  const ideal = discriminating.reduce((total, term) => total + (idf.get(term) ?? 0) * (BM25_K1 + 1), 0);

  return Object.freeze({
    discriminatingTerms: Object.freeze([...discriminating]),
    score(documentIndex: number): number {
      if (ideal <= 0) return 0;
      const counts = frequencies[documentIndex];
      const length = lengths[documentIndex];
      if (!counts || length === undefined) return 0;
      let total = 0;
      for (const term of discriminating) {
        const frequency = counts.get(term) ?? 0;
        if (!frequency) continue;
        total += (idf.get(term) ?? 0) *
          (frequency * (BM25_K1 + 1)) /
          (frequency + BM25_K1 * (1 - BM25_B + BM25_B * (length / averageLength)));
      }
      return total / ideal;
    },
  });
}
