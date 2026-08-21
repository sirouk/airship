/**
 * One duplicate hunter, for every lane that stores remembered text.
 *
 * Inspiration and lineage: Graphify's entity-dedup pipeline (exact
 * normalization, entropy gate, MinHash/LSH blocking, Jaro-Winkler verification,
 * union-find merge). Ported pure TypeScript because a memory record is a short
 * string, not a graph node, and because this runs in the browser vault on
 * VaultDevice memory, not in a Python CLI. The discipline carried over is the
 * two-stage shape: cheap blocking must never be the verdict; a real comparison
 * always has the last word. The thresholds were retuned for memory-length
 * prose, and the verification now requires CONTAINMENT, not just string
 * similarity — "lives in Berlin" and "lives in Paris" are 93% Jaro-Winkler
 * identical and are not duplicates of each other. The graph-side gates below
 * exist so precision never trades for recall here: merging two distinct facts
 * is the worst thing this module can do.
 *
 * Performance envelope: bounded by the memory document's own ceiling of 512
 * records. Blocking is cheap on varied prose, but a corpus of one repeated
 * template — the shape a generated fact list takes — collides in every band,
 * so verification is what actually decides the cost. Measured on such a
 * worst-case 512-record corpus: ~55ms on a developer laptop and ~400ms on a
 * shared CI runner, with the numeric gate turning most candidate pairs away
 * before either the token or the character lane runs. The 32-bit hash family
 * is deliberate: at this scale the Mersenne-prime family Graphify's port uses
 * buys nothing measurable, and `Math.imul` families avoid BigInt allocation
 * entirely.
 */

import { isContentTerm, tokenize } from "./bm25";

/** Permutations per MinHash signature. 24 bands × 4 rows. */
export const DEDUP_PERMUTATIONS = 96;
/** LSH band count; a pair sharing ANY band becomes a verification candidate. */
export const DEDUP_BANDS = 24;
/** Rows per band. Higher is stricter (fewer candidates). */
export const DEDUP_ROWS_PER_BAND = DEDUP_PERMUTATIONS / DEDUP_BANDS;

/**
 * Below this many content terms a record never enters the fuzzy lane: short
 * template-like facts ("uses TypeScript") produce shingles so sparse that
 * every gate is noise. Such records may only exact-match.
 */
export const DEDUP_MIN_CONTENT_TERMS = 4;

/** Signature-overlap fraction needed before a band hit is verified at all. */
export const DEDUP_MIN_SIGNATURE_ESTIMATE = 0.4;
/**
 * Shared-token fraction of the SMALLER token set. Containment, not Jaccard:
 * a near-duplicate is one fact phrased twice, so one record nearly inside the
 * other is the shape of truth, while two equally long records sharing half
 * their tokens are two facts with a common frame.
 */
export const DEDUP_MIN_CONTAINMENT = 0.85;
/** Jaro-Winkler on normalized text, when the strings are short enough to score. */
export const DEDUP_MIN_JARO_WINKLER = 0.88;
/** Long texts skip Jaro-Winkler; the signature estimate must carry them alone. */
export const DEDUP_MIN_LONG_SIGNATURE_ESTIMATE = 0.6;
/** Normalized strings are compared character-real only up to this length. */
export const DEDUP_MAX_JARO_CHARS = 1024;
/** Hard ceiling on records passed in one call — mirrors the memory document. */
export const DEDUP_MAX_RECORDS = 512;

export type DedupPair = Readonly<{
  /** Index into the caller's array for the earlier record. */
  a: number;
  /** Index into the caller's array for the later record. */
  b: number;
  /** 0..1 confidence, 1 only for a normalized-exact match. */
  similarity: number;
  exact: boolean;
}>;

export type DedupCluster = Readonly<{
  /** Caller indexes, in input order. Always at least two. */
  members: readonly number[];
  /** The index this lane keeps: longest content, ties broken by earliest createdAt then index order. */
  representative: number;
  /** The least confident pair that holds this cluster together. */
  similarity: number;
  exact: boolean;
}>;

/**
 * NFKC-fold, casefold, collapse every non-alphanumeric run to one space.
 * Two memories that differ only in punctuation or casing normalize equal and
 * are, for every purpose that matters, the same fact.
 */
export function normalizeDedupText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function signatureTerms(normalized: string): { terms: string[]; contentTerms: number } {
  const terms = tokenize(normalized);
  let contentTerms = 0;
  for (const term of terms) if (isContentTerm(term)) contentTerms += 1;
  return { terms, contentTerms };
}

/** Ordered word bigrams+trigrams over the token stream; empty below 3 tokens. */
function shingles(terms: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < terms.length; i += 1) {
    out.push(`${terms[i]}\u0001${terms[i + 1]}`);
    if (i + 2 < terms.length) out.push(`${terms[i]}\u0001${terms[i + 1]}\u0001${terms[i + 2]}`);
  }
  return out;
}

/**
 * A deterministic 32-bit linear hash family. Constants come from a seeded
 * generator so the signature of a text is stable across calls, tabs, and
 * sessions — the Memory view recomputes these on every mount and would
 * otherwise need to cache them.
 */
const HASH_A: readonly number[] = (() => {
  let state = 0x9e3779b9;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
  return Object.freeze(Array.from({ length: DEDUP_PERMUTATIONS }, () => next() | 1));
})();
const HASH_B: readonly number[] = (() => {
  let state = 0x2545f491;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
  return Object.freeze(Array.from({ length: DEDUP_PERMUTATIONS }, () => next()));
})();

type PreparedDocument = Readonly<{
  normalized: string;
  unigrams: ReadonlySet<string>;
  contentTerms: number;
  /** Every digit run in the normalized text, sorted and joined. See `numericLiterals`. */
  numbers: string;
  signature: Uint32Array | undefined;
}>;

/**
 * The precise part of a remembered fact.
 *
 * "42 bar" and "43 bar" are two facts, but neither the token lane nor the
 * character lane can see that. `tokenize` drops one-digit runs entirely and
 * treats a two-digit run as a function word, so "3 attempts" and "9 attempts"
 * carry identical token sets; Jaro-Winkler reads one differing character in a
 * long sentence as 0.99 similar. Both gates therefore reported a merge — the
 * one outcome this module calls its worst.
 *
 * Numbers are exactly where a single character changes the fact, so two records
 * that BOTH name numbers may only merge on similarity when they name the same
 * numbers. A record with no numeral is not contradicting one that has it — "90
 * days" and "ninety days" are one fact in two wordings — so that pair still
 * goes to the ordinary gates. This can never create a merge; it only withholds
 * one, which is the safe direction for a lane that discards a record.
 */
function numericLiterals(normalized: string): string {
  return (normalized.match(/\p{N}+/gu) ?? []).sort().join(" ");
}

function prepare(normalized: string): PreparedDocument {
  const { terms, contentTerms } = signatureTerms(normalized);
  const unigrams: Set<string> = new Set(terms);
  const numbers = numericLiterals(normalized);
  const grams = contentTerms >= DEDUP_MIN_CONTENT_TERMS ? shingles(terms) : [];
  if (!grams.length) {
    return Object.freeze({ normalized, unigrams, contentTerms, numbers, signature: undefined });
  }
  // Shingle strings intern to corpus-stable ids; ids are hashed, never the
  // raw strings, so the inner loop is integer arithmetic only.
  const ids: number[] = grams.map(() => 0);
  const intern = new Map<string, number>();
  for (let i = 0; i < grams.length; i += 1) {
    const gram = grams[i]!;
    let id = intern.get(gram);
    if (id === undefined) { id = intern.size; intern.set(gram, id); }
    ids[i] = id;
  }
  const signature = new Uint32Array(DEDUP_PERMUTATIONS);
  for (let p = 0; p < DEDUP_PERMUTATIONS; p += 1) {
    let min = 0xffffffff;
    const a = HASH_A[p]!;
    const b = HASH_B[p]!;
    for (let i = 0; i < ids.length; i += 1) {
      const h = (Math.imul(ids[i]!, a) + b) >>> 0;
      if (h < min) min = h;
    }
    signature[p] = min;
  }
  return Object.freeze({ normalized, unigrams, contentTerms, numbers, signature });
}

function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  if (!smaller.size) return 0;
  let shared = 0;
  for (const term of smaller) if (larger.has(term)) shared += 1;
  return shared / smaller.size;
}

function estimateSignatureOverlap(a: Uint32Array, b: Uint32Array): number {
  let equal = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) equal += 1;
  return equal / a.length;
}

/**
 * Jaro-Winkler over the two normalized strings. O(min·window + shared) — the
 * window bound (max/2 - 1) keeps this linear-ish for memory-length strings,
 * and callers skip it entirely above DEDUP_MAX_JARO_CHARS.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const window = Math.max(1, Math.floor(longer.length / 2) - 1);
  const longerMatched = new Uint8Array(longer.length);
  const sharedShorter: string[] = [];
  const sharedLonger: string[] = [];
  for (let i = 0; i < shorter.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, longer.length);
    for (let j = start; j < end; j += 1) {
      if (longerMatched[j] || longer[j] !== shorter[i]) continue;
      longerMatched[j] = 1;
      sharedShorter.push(shorter[i]!);
      sharedLonger.push(longer[j]!);
      break;
    }
  }
  const matches = sharedShorter.length;
  if (!matches) return 0;
  let transpositions = 0;
  for (let i = 0; i < matches; i += 1) if (sharedShorter[i] !== sharedLonger[i]) transpositions += 1;
  const jaro = (matches / shorter.length + matches / longer.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < shorter.length && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Verify one candidate pair. Returns the similarity when the pair passes
 * every gate, or -1. Containment is consulted before string similitude so
 * the "lives in Berlin / lives in Paris" class of trap dies cheaply.
 */
function verify(a: PreparedDocument, b: PreparedDocument): number {
  if (!a.contentTerms || !b.contentTerms) return -1;
  // Cheapest gate first, and the only one that reads the precise part of the
  // fact rather than its wording.
  if (a.numbers && b.numbers && a.numbers !== b.numbers) return -1;
  if (containment(a.unigrams, b.unigrams) < DEDUP_MIN_CONTAINMENT) return -1;
  if (a.signature && b.signature) {
    const estimate = estimateSignatureOverlap(a.signature, b.signature);
    if (estimate < DEDUP_MIN_SIGNATURE_ESTIMATE) return -1;
    if (Math.min(a.normalized.length, b.normalized.length) > DEDUP_MAX_JARO_CHARS) {
      return estimate >= DEDUP_MIN_LONG_SIGNATURE_ESTIMATE ? estimate : -1;
    }
  } else {
    // Sparse records (no signature) only ever exact-match — that lane ran
    // already. Reaching here means one side has shingles and one does not:
    // different lengths, different facts.
    return -1;
  }
  const score = jaroWinkler(a.normalized, b.normalized);
  return score >= DEDUP_MIN_JARO_WINKLER ? score : -1;
}

type ScopedRecord = Readonly<{ index: number; scopeKey: string }>;

/**
 * Find every pair of duplicates inside one record set, partitioned first by
 * the caller's scope key so a silo wall is never crossed. Exact
 * (normalized-identical) matches always return exact clusters; fuzzy matches
 * run the blocking pipeline per partition.
 */
export function findDuplicatePairs<T>(
  records: readonly T[],
  select: (record: T) => string,
  scopeKey?: (record: T) => string,
): readonly DedupPair[] {
  const corpus = records.slice(0, DEDUP_MAX_RECORDS);
  if (corpus.length < 2) return Object.freeze([]);
  const partitions = new Map<string, ScopedRecord[]>();
  const prepared = new Array<PreparedDocument>(corpus.length);
  corpus.forEach((record, index) => {
    const normalized = normalizeDedupText(select(record));
    prepared[index] = prepare(normalized);
    const key = scopeKey ? scopeKey(record) : "all";
    const bucket = partitions.get(key);
    if (bucket) bucket.push(Object.freeze({ index, scopeKey: key }));
    else partitions.set(key, [Object.freeze({ index, scopeKey: key })]);
  });

  const pairs: DedupPair[] = [];
  const mergedPairs = new Set<number>();

  // Exact lane: normalized-identical texts are the same fact regardless of
  // length, and pairing all members of one normalized group keeps the merge
  // chain connected even through the union-find below.
  for (const partition of partitions.values()) {
    const byNormalized = new Map<string, number[]>();
    for (const { index } of partition) {
      const normalized = prepared[index]!.normalized;
      /*
       * Text that normalizes away is not text two records have in common.
       * Punctuation-only or emoji-only notes all reduce to the empty string,
       * and keying on it put every one of them in a single group that the loop
       * below then reported as exact duplicates at similarity 1 — the strongest
       * claim this module can make, on the least evidence it can hold. The
       * fuzzy lane below already declines the same records for the same reason
       * (`if (!signature) continue`); this is that guard, one lane earlier.
       */
      if (!normalized) continue;
      const group = byNormalized.get(normalized);
      if (group) group.push(index);
      else byNormalized.set(normalized, [index]);
    }
    for (const group of byNormalized.values()) {
      if (group.length < 2) continue;
      for (let i = 1; i < group.length; i += 1) {
        const a = group[0]!;
        const b = group[i]!;
        mergedPairs.add(a * DEDUP_MAX_RECORDS + b);
        pairs.push(Object.freeze({ a, b, similarity: 1, exact: true }));
      }
    }

    // Fuzzy lane: LSH blocking per band, verification for the survivors.
    const bandBuckets = new Map<string, number[]>();
    for (const { index } of partition) {
      const signature = prepared[index]!.signature;
      if (!signature) continue;
      for (let band = 0; band < DEDUP_BANDS; band += 1) {
        const offset = band * DEDUP_ROWS_PER_BAND;
        const bucketKey = `${band}:${signature[offset]}:${signature[offset + 1]}:${signature[offset + 2]}:${signature[offset + 3]}`;
        const bucket = bandBuckets.get(bucketKey);
        if (bucket) bucket.push(index);
        else bandBuckets.set(bucketKey, [index]);
      }
    }
    for (const bucket of bandBuckets.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          const a = bucket[i] < bucket[j] ? bucket[i]! : bucket[j]!;
          const b = bucket[i] < bucket[j] ? bucket[j]! : bucket[i]!;
          const key = a * DEDUP_MAX_RECORDS + b;
          if (mergedPairs.has(key)) continue;
          mergedPairs.add(key);
          const similarity = verify(prepared[a]!, prepared[b]!);
          if (similarity >= 0) pairs.push(Object.freeze({ a, b, similarity, exact: false }));
        }
      }
    }
  }
  return Object.freeze(pairs);
}

/** Pick the record a merge keeps: longest content, earliest createdAt, lowest index. */
export function pickRepresentative<T>(
  records: readonly T[],
  members: readonly number[],
  select: (record: T) => string,
  createdAt?: (record: T) => string,
): number {
  let best = members[0]!;
  for (const candidate of members.slice(1)) {
    const bestRecord = records[best]!;
    const candidateRecord = records[candidate]!;
    const lengthDelta = select(candidateRecord).length - select(bestRecord).length;
    if (lengthDelta > 0) { best = candidate; continue; }
    if (lengthDelta < 0) continue;
    if (createdAt) {
      const timeDelta = createdAt(candidateRecord).localeCompare(createdAt(bestRecord));
      if (timeDelta < 0) { best = candidate; continue; }
      if (timeDelta > 0) continue;
    }
    if (candidate < best) best = candidate;
  }
  return best;
}

/**
 * Union-find over duplicate pairs. A pair is an edge; a cluster is a
 * connected component of ≥2 records. "A≈B and B≈C ⇒ A≈C" is the standard
 * forgive-the-bridge rule for one fact re-pinned in three wordings.
 */
export function clusterDuplicatePairs<T>(
  records: readonly T[],
  pairs: readonly DedupPair[],
  select: (record: T) => string,
  createdAt?: (record: T) => string,
): readonly DedupCluster[] {
  if (!pairs.length) return Object.freeze([]);
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    let node = x;
    while (parent.get(node) !== undefined && parent.get(node) !== node) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const pair of pairs) {
    const rootA = find(pair.a);
    const rootB = find(pair.b);
    if (rootA !== rootB) parent.set(Math.max(rootA, rootB), Math.min(rootA, rootB));
  }
  const groups = new Map<number, number[]>();
  for (const pair of pairs) {
    for (const index of [pair.a, pair.b]) {
      const root = find(index);
      const group = groups.get(root);
      if (group) { if (!group.includes(index)) group.push(index); }
      else groups.set(root, [index]);
    }
  }
  // Cluster-level stats are computed AFTER the components settle: rooting is
  // order-dependent, so any statistic accumulated mid-union would be keyed to
  // a root that may no longer exist.
  const clusters: DedupCluster[] = [];
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    members.sort((x, y) => x - y);
    let similarity = 1;
    const exactness = new Set<string>();
    for (const pair of pairs) {
      if (find(pair.a) === root && find(pair.b) === root) {
        if (pair.similarity < similarity) similarity = pair.similarity;
      }
    }
    let exactnessTag = true;
    for (const member of members) {
      exactness.add(normalizeDedupText(select(records[member]!)));
      if (exactness.size > 1) { exactnessTag = false; break; }
    }
    clusters.push(Object.freeze({
      members: Object.freeze(members),
      representative: pickRepresentative(records, members, select, createdAt),
      similarity,
      exact: exactnessTag,
    }));
  }
  clusters.sort((a, b) => b.members.length - a.members.length || a.members[0]! - b.members[0]!);
  return Object.freeze(clusters);
}

/**
 * One call for the review lanes: pairs and clusters across the whole set.
 * `scopeKey` is the silo wall — records in different partitions can never be
 * proposed as duplicates of one another, however similar their prose is.
 */
export function findDuplicateClusters<T>(
  records: readonly T[],
  select: (record: T) => string,
  options: Readonly<{ scopeKey?: (record: T) => string; createdAt?: (record: T) => string }> = {},
): readonly DedupCluster[] {
  return clusterDuplicatePairs(records, findDuplicatePairs(records, select, options.scopeKey), select, options.createdAt);
}

export type DedupCandidate = Readonly<{
  /** Index into the caller's array. */
  index: number;
  similarity: number;
  exact: boolean;
}>;

/**
 * Pin-time probe: how does ONE new text stand against the stored set?
 * Runs the same gates as the full pass over only the candidates that share a
 * band with the probe, so a remember call never pays for an all-pairs sweep.
 */
export function findDedupCandidates<T>(
  content: string,
  records: readonly T[],
  select: (record: T) => string,
  scopeKey?: (record: T) => string,
  probeScopeKey?: string,
): readonly DedupCandidate[] {
  const probePrepared = prepare(normalizeDedupText(content));
  const candidates: DedupCandidate[] = [];
  if (!probePrepared.normalized) return Object.freeze([]);
  const seen = new Set<number>();
  const consider = (index: number): void => {
    if (seen.has(index)) return;
    seen.add(index);
    const stored = prepare(normalizeDedupText(select(records[index]!)));
    if (stored.normalized === probePrepared.normalized) {
      candidates.push(Object.freeze({ index, similarity: 1, exact: true }));
      return;
    }
    if (probePrepared.signature && stored.signature) {
      const similarity = verify(probePrepared, stored);
      if (similarity >= 0) candidates.push(Object.freeze({ index, similarity, exact: false }));
    } else if (probePrepared.contentTerms < DEDUP_MIN_CONTENT_TERMS && stored.contentTerms < DEDUP_MIN_CONTENT_TERMS) {
      // Sparse-vs-sparse can still be a containment duplicate worth telling
      // the writer about ("uses TypeScript" vs "uses TypeScript strictly").
      if (containment(probePrepared.unigrams, stored.unigrams) >= DEDUP_MIN_CONTAINMENT) {
        const score = jaroWinkler(probePrepared.normalized, stored.normalized);
        if (score >= DEDUP_MIN_JARO_WINKLER) {
          candidates.push(Object.freeze({ index, similarity: score, exact: false }));
        }
      }
    }
  };
  const scopeRestricted = (index: number): boolean =>
    !scopeKey || probeScopeKey === undefined || scopeKey(records[index]!) === probeScopeKey;
  if (probePrepared.signature) {
    // Band probe: only stored records sharing a band with the probe are real
    // candidates; everything else is unreachable by the same logic the bulk
    // pass uses.
    const bandKeys = new Set<string>();
    for (let band = 0; band < DEDUP_BANDS; band += 1) {
      const offset = band * DEDUP_ROWS_PER_BAND;
      const s = probePrepared.signature;
      bandKeys.add(`${band}:${s[offset]}:${s[offset + 1]}:${s[offset + 2]}:${s[offset + 3]}`);
    }
    const corpus = records.slice(0, DEDUP_MAX_RECORDS);
    for (let index = 0; index < corpus.length; index += 1) {
      if (!scopeRestricted(index)) continue;
      const stored = prepare(normalizeDedupText(select(corpus[index]!)));
      if (!stored.signature) {
        if (stored.normalized === probePrepared.normalized) consider(index);
        continue;
      }
      let sharesBand = false;
      for (let band = 0; !sharesBand && band < DEDUP_BANDS; band += 1) {
        const offset = band * DEDUP_ROWS_PER_BAND;
        const s = stored.signature;
        sharesBand = bandKeys.has(`${band}:${s[offset]}:${s[offset + 1]}:${s[offset + 2]}:${s[offset + 3]}`);
      }
      if (sharesBand || stored.normalized === probePrepared.normalized) consider(index);
    }
  } else {
    const corpus = records.slice(0, DEDUP_MAX_RECORDS);
    for (let index = 0; index < corpus.length; index += 1) {
      if (scopeRestricted(index)) consider(index);
    }
  }
  candidates.sort((a, b) => b.similarity - a.similarity || a.index - b.index);
  return Object.freeze(candidates);
}
