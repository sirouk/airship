import type { ClaimCeiling, ClaimStackItem, ClaimStackModel } from "./claim-stack-model";
import type { ProofStatus } from "../receipts/types";
import type { SealState } from "./seal";
import { TURN_EVIDENCE_COPY, type TurnEvidenceState } from "./trust-language";

export { TURN_EVIDENCE_COPY } from "./trust-language";
export type { TurnEvidenceState } from "./trust-language";

/*
 * ── The canonical turn-evidence verdict ──────────────────────────────────
 *
 * The Proof package wrote this reducer at the foot of `claim-stack-facts.ts`,
 * with a note that "the topbar and the session bar are the two [surfaces] that
 * must" adopt it. It is here instead because that file also carries the ceiling
 * copy, the legend and the popover projection, and a caller that wanted one
 * word paid for all of it.
 *
 * Three modules, one dictionary: `trust-language.ts` holds the words and is the
 * only piece the first-paint shell reaches; this module holds the reducer and
 * travels with the surfaces that reduce a claim stack; `claim-stack-facts.ts`
 * holds the disclosure copy and re-exports both, so the Proof route's imports
 * are unchanged and there is still exactly one definition of the six states.
 */

export type TurnEvidenceCounts = Readonly<{
  verified: number;
  asserted: number;
  noEvidence: number;
  failed: number;
  /**
   * Its own bucket, not a share of `failed`.
   *
   * `ProofStatus` has five members and this reducer had four buckets, so the
   * trailing `else` quietly filed every expired claim under `failed` and the
   * Proof summary tab printed "Failed: 1" for a claim that was never found to
   * be false — while the Attestation tab, reading the same claim, called it a
   * stale observation. The verdict still fails closed on either (see the gate
   * below); only the count a reader is shown stops lying about which happened.
   */
  expired: number;
  total: number;
}>;

export type TurnEvidenceVerdict = Readonly<{
  state: TurnEvidenceState;
  seal: SealState;
  /** ≤22 characters. The word-form every trust surface shows at rest. */
  chip: string;
  /** ≤80 characters. One sentence, printable beside the chip. */
  line: string;
  counts: TurnEvidenceCounts;
  /** How many claims their own record declared verified, before the ceilings. */
  declaredVerified: number;
  /** The ceilings that actually capped a claim on this turn, in fixed order. */
  ceilings: readonly ClaimCeiling[];
  /**
   * An acquisition failure, verbatim, when a receipt already exists.
   *
   * Not being able to *fetch* evidence is a modifier on the verdict, never the
   * verdict itself: rendering it as a second pill is what produced a topbar
   * reading "Evidence unavailable" beside a session badge reading "evidence
   * recorded" for one turn that had, in fact, been recorded.
   */
  modifier?: string;
}>;

export function turnEvidenceCounts(items: readonly ClaimStackItem[]): TurnEvidenceCounts {
  let verified = 0;
  let asserted = 0;
  let noEvidence = 0;
  let failed = 0;
  let expired = 0;
  for (const item of items) {
    if (item.status === "verified") verified += 1;
    else if (item.status === "partial") asserted += 1;
    else if (item.status === "unavailable") noEvidence += 1;
    else if (item.status === "expired") expired += 1;
    else failed += 1;
  }
  return Object.freeze({ verified, asserted, noEvidence, failed, expired, total: items.length });
}

/**
 * The single reducer every trust surface must call to answer "is this proven".
 *
 * Precedence, and the rule that makes it honest: an acquisition failure never
 * becomes the headline while a receipt exists. It is returned as `modifier` and
 * rendered as a trailing clause on the one chip — "Asserted, not verified ·
 * evidence not pulled" — because a fetch that did not happen is not a
 * verification that failed, and printing it as a peer verdict says it is.
 */
export function turnEvidenceVerdict(input: Readonly<{
  stack: ClaimStackModel;
  hasReceipt: boolean;
  /**
   * `sealStateForReceipt(receipt) === "failed"` — an attested posture whose
   * endpoint-key claim and proof level do not agree. Passed in as a predicate
   * so the shipped fail-closed rule stays exactly one rule instead of becoming
   * a second seal drawn beside this one.
   */
  attestedFieldsDisagree?: boolean;
  /** `attestationFailureLabel()`'s string, verbatim, or nothing. */
  acquisitionFailure?: string;
}>): TurnEvidenceVerdict {
  const counts = turnEvidenceCounts(input.stack.items);
  const declaredVerified = input.stack.items.filter((item) => declaredClaimStatus(item) === "verified").length;
  const ceilings: ClaimCeiling[] = [];
  for (const ceiling of ["receipt-integrity", "authority"] as const) {
    if (input.stack.items.some((item) => claimCeiling(item) === ceiling)) ceilings.push(ceiling);
  }
  const base = Object.freeze({ counts, declaredVerified, ceilings: Object.freeze(ceilings) });
  const modifier = input.acquisitionFailure ? { modifier: input.acquisitionFailure } : {};

  // Splitting `expired` out of `failed` above must not soften the verdict: an
  // expired claim still fails closed, and `TURN_EVIDENCE_COPY.failed` already
  // reads "Verification failed or expired", so the hero is unchanged.
  if (counts.failed > 0 || counts.expired > 0 || input.attestedFieldsDisagree) {
    return Object.freeze({ ...base, ...modifier, ...TURN_EVIDENCE_COPY.failed, state: "failed" });
  }
  if (!input.hasReceipt) {
    return input.acquisitionFailure
      ? Object.freeze({ ...base, ...modifier, ...TURN_EVIDENCE_COPY["evidence-blocked"], state: "evidence-blocked" })
      : Object.freeze({ ...base, ...TURN_EVIDENCE_COPY["no-evidence"], state: "no-evidence" });
  }
  if (counts.verified === counts.total) {
    return Object.freeze({ ...base, ...modifier, ...TURN_EVIDENCE_COPY.proven, state: "proven" });
  }
  if (counts.verified > 0) {
    // The count replaces the generic word: "3 of 8 verified" is the same claim
    // as "Partly verified" and strictly more of it, so the table's phrasing is
    // the floor rather than the ceiling here.
    return Object.freeze({
      ...base,
      ...modifier,
      ...TURN_EVIDENCE_COPY["partly-proven"],
      state: "partly-proven",
      chip: `${counts.verified} of ${counts.total} verified`,
      line: `${counts.verified} claims were verified by a named authority; the rest are assertions.`,
    });
  }
  return Object.freeze({ ...base, ...modifier, ...TURN_EVIDENCE_COPY.asserted, state: "asserted" });
}

/**
 * What the claim's own record said about itself, before any ceiling.
 *
 * Read back from the qualifier rather than stored on the item: the model is
 * entry-reachable and every stored field is paid for at first paint, while
 * this is only ever needed by a surface that is explaining the gap.
 */
export function declaredClaimStatus(item: ClaimStackItem): ProofStatus {
  if (item.qualifier === "verified-without-authority") return "verified";
  return item.qualifier.startsWith("asserted-")
    ? item.qualifier.slice("asserted-".length) as ProofStatus
    : item.status;
}

/**
 * The ceiling that actually moved this claim, or nothing.
 *
 * A rule that applies but changes nothing is not a ceiling anybody needs to
 * read about — `asserted-partial` is governed by the receipt-integrity rule
 * and was already an assertion, so it reports no ceiling.
 */
export function claimCeiling(item: ClaimStackItem): ClaimCeiling | undefined {
  return declaredClaimStatus(item) === item.status ? undefined : claimQualifierCeiling(item.qualifier);
}

/**
 * Which shared rule a qualifier belongs to. One definition, two readers.
 *
 * `claimCeiling` (first paint, so the shell can say which turn was capped) and
 * `readClaimQualifier` (the Proof route's disclosure copy) both need this
 * mapping, and they are delivered in different chunks. Only the mapping lives
 * here; the per-claim delta sentences travel with the surface that prints them.
 */
export function claimQualifierCeiling(qualifier: string): ClaimCeiling | undefined {
  if (qualifier === "verified-without-authority") return "authority";
  return qualifier.startsWith("asserted-") && qualifier !== "asserted-unavailable" ? "receipt-integrity" : undefined;
}
