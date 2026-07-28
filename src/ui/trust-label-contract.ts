import {
  TRUST_LABEL_CLAIM_RAIL_HERO,
  TRUST_LABEL_CONNECT_TRUST_READINESS,
  TRUST_LABEL_MESSAGE_ASSERTED_NO_ENDPOINT,
  TRUST_LABEL_MESSAGE_NO_EVIDENCE,
  TRUST_LABEL_SESSION_ASSERTED,
  TRUST_LABEL_SESSION_NOT_CHECKED,
  type TrustRung,
} from "./trust-language";

/**
 * ── What each printed trust word is allowed to mean ──────────────────────
 *
 * Airship's currency is that a label never asserts more than the code
 * establishes. Unifying the trust *vocabulary* onto one three-rung ladder is
 * only safe if it does not also unify the trust *state*, so every rung word
 * carries the predicate that must hold before a surface may print it.
 *
 * This module is imported by `trust-language.test.ts` and by nothing else, on
 * purpose. `trust-language.ts` is a shared chunk, which means an export no
 * surface imports is still shipped to every visitor: keeping this table there
 * measured 0.31 KiB gzip of installed bundle for data only the guard reads. The
 * strings themselves stay in `trust-language.ts`, where the surfaces take them
 * from, so there is still exactly one spelling of every word.
 *
 * A surface does not consult this at runtime. It cannot: the predicate is about
 * whether the *state* the surface is in permits the word, and the guard proves
 * that statically for every state the reducers can reach. Wiring it as a
 * runtime check would let a wrong label render and then be caught, which is one
 * frame too late for a claim about evidence.
 */
export type TrustLabelSpec = Readonly<{
  /** The exact string the surface prints. */
  text: string;
  rung: TrustRung;
  /**
   * Whether a turn receipt must exist first.
   *
   * True for every label on the `asserted` rung, and that is the whole rule:
   * "Asserted" says a party made a claim, so it may be printed only where a
   * receipt records one. Where no receipt exists the honest rung is "No
   * evidence" — an assertion nobody made is not a weak assertion, it is an
   * absence.
   */
  requiresReceipt: boolean;
}>;

export const TRUST_LABELS: Readonly<Record<
  | "sessionAsserted"
  | "sessionNotChecked"
  | "messageAssertedNoEndpoint"
  | "messageNoEvidence"
  | "claimRailHero"
  | "connectTrustReadiness",
  TrustLabelSpec
>> = Object.freeze({
  sessionAsserted: Object.freeze({ text: TRUST_LABEL_SESSION_ASSERTED, rung: "asserted", requiresReceipt: true }),
  sessionNotChecked: Object.freeze({ text: TRUST_LABEL_SESSION_NOT_CHECKED, rung: "no-evidence", requiresReceipt: false }),
  messageAssertedNoEndpoint: Object.freeze({ text: TRUST_LABEL_MESSAGE_ASSERTED_NO_ENDPOINT, rung: "asserted", requiresReceipt: true }),
  messageNoEvidence: Object.freeze({ text: TRUST_LABEL_MESSAGE_NO_EVIDENCE, rung: "no-evidence", requiresReceipt: false }),
  claimRailHero: Object.freeze({ text: TRUST_LABEL_CLAIM_RAIL_HERO, rung: "asserted", requiresReceipt: true }),
  connectTrustReadiness: Object.freeze({ text: TRUST_LABEL_CONNECT_TRUST_READINESS, rung: "no-evidence", requiresReceipt: false }),
});

/**
 * The three rung words with their definitions.
 *
 * Byte-identical to `CLAIM_STATE_LEGEND` in `claim-stack-facts.ts`, which the
 * Proof route renders; the guard asserts that, so the ladder cannot come to
 * mean two things. It is declared here rather than in `trust-language.ts` for
 * the same measured reason as the table above — no first-paint surface has
 * adopted it yet, and a shared chunk ships what it exports. The moment the
 * session-bar chip's popover renders these definitions, move this constant into
 * `trust-language.ts` so the shell can reach it without the Proof chunk.
 */
export const TRUST_LADDER: readonly Readonly<{ rung: TrustRung; word: string; meaning: string }>[] = Object.freeze([
  Object.freeze({ rung: "verified" as const, word: "Verified", meaning: "A named authority checked this claim and it held." }),
  Object.freeze({ rung: "asserted" as const, word: "Asserted", meaning: "A party stated this claim. Nothing independent checked it." }),
  Object.freeze({ rung: "no-evidence" as const, word: "No evidence", meaning: "No record of this claim exists for this turn." }),
]);

/** The names this ladder retired. Pinned so none can return as a value. */
export const RETIRED_TRUST_LABELS: readonly string[] = Object.freeze([
  "Evidence not pulled",
  "Secure hardware evidence pending",
  "No evidence yet",
  "verification remains unverified",
]);

/**
 * Whether a label may be printed against what the code actually established.
 *
 * The guard in one line, so it cannot be got subtly wrong in six places: a
 * label that requires a receipt is legible only where one exists.
 */
export function trustLabelPermitted(
  spec: TrustLabelSpec,
  evidence: Readonly<{ hasReceipt: boolean }>,
): boolean {
  return !spec.requiresReceipt || evidence.hasReceipt;
}
