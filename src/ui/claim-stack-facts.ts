import type { ClaimCeiling, ClaimStackFact, ClaimStackItem } from "./claim-stack-model";
import { claimCeiling, claimQualifierCeiling, declaredClaimStatus } from "./turn-evidence";
import { proofStatusLabel } from "./trust-language";

/*
 * The verdict reducer that used to live at the foot of this file now lives in
 * `turn-evidence.ts`. It was written here on the reasoning that a rendering
 * travels with the surface that renders it — correct, until the shell adopted
 * it. The topbar, the session bar and the transcript's receipt chip are all
 * first-paint surfaces, so the reducer had to move to a first-paint module or
 * the shell would have paid for this file's ceiling copy, legend and popover
 * projection to draw one word. The names are re-exported so every existing
 * import of `claim-stack-facts` keeps working and there is still exactly one
 * definition of the six states.
 */
export {
  TURN_EVIDENCE_COPY,
  claimCeiling,
  declaredClaimStatus,
  turnEvidenceCounts,
  turnEvidenceVerdict,
} from "./turn-evidence";
export type {
  TurnEvidenceCounts,
  TurnEvidenceState,
  TurnEvidenceVerdict,
} from "./turn-evidence";

export type ClaimQualifierReading = Readonly<{
  /** What this claim's own record says, beyond the status word. */
  delta?: string;
  /** The shared rule that capped it, if one did. */
  ceiling?: ClaimCeiling;
}>;

/**
 * The qualifier dictionary: the per-claim delta, plus the shared rule.
 *
 * The delta sentences are disclosure copy — only a popover or an inspector row
 * ever prints them — so they stay in this lazily delivered module. The
 * rule half is `claimQualifierCeiling`, which first paint also needs.
 */
export function readClaimQualifier(qualifier: string): ClaimQualifierReading {
  const ceiling = claimQualifierCeiling(qualifier);
  const rule = ceiling ? { ceiling } : {};
  if (qualifier === "verified-without-authority") return Object.freeze({ ...rule, delta: "record declares verified" });
  if (qualifier.startsWith("asserted-")) {
    const declared = qualifier.slice("asserted-".length);
    if (declared === "unavailable" || declared === "partial") return Object.freeze(rule);
    return Object.freeze({ ...rule, delta: `record declares ${declared}` });
  }
  if (qualifier === "matched") return Object.freeze({ delta: "locally matched · not independently verified" });
  if (qualifier === "present") return Object.freeze({ delta: "present · authenticity not checked" });
  if (qualifier === "unverified") return Object.freeze({ delta: "no independent verifier" });
  if (qualifier === "verified") return Object.freeze({ delta: "checked by the named authority" });
  if (qualifier === "unavailable") return Object.freeze({});
  // The provider pair qualifiers ("matched/unavailable") are raw states joined
  // by a slash. Keep both halves; only the separator becomes readable.
  return qualifier.includes("/") ? Object.freeze({ delta: qualifier.replace("/", " · ") }) : Object.freeze({});
}

/**
 * The rows a claim's chip expands into.
 *
 * Rung L1 of the disclosure ladder promises the *whole* claim behind one
 * gesture: who asserted it, over what, how old it is, and the facts that let
 * someone else recompute it. Composing that list once keeps every popover in
 * the product showing the same fields for the same claim.
 *
 * It lives beside `claim-stack-model.ts` rather than inside it because that
 * module is reachable from the entry chunk, and the startup budget currently
 * has bytes rather than kilobytes of headroom. A projection used only by
 * disclosure surfaces belongs in the chunks those surfaces travel in.
 */
export function claimStackPopoverFacts(item: ClaimStackItem): readonly ClaimStackFact[] {
  const { verifier, checkedAt } = item.claim;
  return Object.freeze([
    { label: "Issuer", value: verifier ?? "None recorded" },
    { label: "Scope", value: item.source === "endpoint-evidence" ? "Endpoint evidence" : "Turn receipt" },
    { label: "Checked", value: checkedAt ?? "Never" },
    // Only when a ceiling actually moved this claim. A row saying "nothing was
    // capped" on every uncapped claim would make the one that *was* capped
    // read as boilerplate.
    ...(claimCeiling(item)
      ? [{ label: "Declared", value: `${proofStatusLabel(declaredClaimStatus(item))} · capped by ${CLAIM_CEILING_LABELS[claimCeiling(item)!].toLowerCase()}` }]
      : []),
    ...item.facts,
  ]);
}

/**
 * The short name of each ceiling — what a reader sees on the resting surface.
 *
 * Two names, never one. Merging them would produce a single sentence about
 * signatures, and nothing in Airship checks a signature.
 */
export const CLAIM_CEILING_LABELS: Readonly<Record<ClaimCeiling, string>> = Object.freeze({
  "receipt-integrity": "Receipt integrity not authenticated",
  authority: "No authority named",
});

/**
 * The full sentence for each ceiling, in the words the model itself emits.
 *
 * Both are quoted from the shipped reducers rather than rewritten, because the
 * failure this replaces was copy that explained a contradiction by asserting a
 * mechanism ("not signed by a trusted authority") the product does not have.
 */
export const CLAIM_CEILING_SENTENCES: Readonly<Record<ClaimCeiling, string>> = Object.freeze({
  "receipt-integrity": "Receipt integrity and embedded claim authority were not authenticated; non-unavailable claim states are shown as assertions only.",
  authority: "The claim declared verification without naming an authority, so Airship shows it as an assertion.",
});

/** Which claim source each ceiling governs, so the two are never conflated. */
export const CLAIM_CEILING_SCOPES: Readonly<Record<ClaimCeiling, string>> = Object.freeze({
  "receipt-integrity": "Every claim carried by the turn receipt",
  authority: "Every claim carried by endpoint evidence",
});

/**
 * The legend, containing exactly the state words the surfaces emit.
 *
 * Persistent, never behind a disclosure. Three words with three definitions is
 * the whole vocabulary; a reader who learns it here can read every seal in the
 * product, which is the point of having one status family.
 */
export const CLAIM_STATE_LEGEND = Object.freeze([
  Object.freeze({ status: "verified", word: "Verified", meaning: "A named authority checked this claim and it held." }),
  Object.freeze({ status: "partial", word: "Asserted", meaning: "A party stated this claim. Nothing independent checked it." }),
  Object.freeze({ status: "unavailable", word: "No evidence", meaning: "No record of this claim exists for this turn." }),
] as const);

/**
 * The delta a qualifier adds, with the status word removed.
 *
 * The measured defect: the claim inspector printed "Attested endpoint-key
 * bindingASSERTED · ASSERTED PARTIAL · RECEIPT UNAUTHENTICATED" — four status
 * words in a row, in two casings, because the qualifier re-prefixed a word the
 * line already began with. Callers render `{proofStatusLabel(state)} · {delta}`
 * and this returns only the delta, or nothing when the status word already
 * says everything there is to say.
 *
 * The input vocabulary is shared with `attestations-model.ts` on purpose, so
 * the Proof route's two tabs cannot describe one turn in two languages.
 */
export function claimQualifierLabel(
  qualifier: string,
  options: Readonly<{
    /**
     * True where the surrounding surface already states the ceiling once — the
     * Attestation tab's record header does, which is why the shipped tiles
     * printed "receipt unauthenticated" nine times for one record-level fact.
     */
    ceilingStatedElsewhere?: boolean;
  }> = {},
): string | undefined {
  const reading = readClaimQualifier(qualifier);
  const ceiling = options.ceilingStatedElsewhere || !reading.ceiling
    ? undefined
    : CLAIM_CEILING_LABELS[reading.ceiling].toLowerCase();
  return [reading.delta, ceiling].filter(Boolean).join(" · ") || undefined;
}
