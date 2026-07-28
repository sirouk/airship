import { describe, expect, it } from "vitest";
import {
  RETIRED_TRUST_LABELS,
  TRUST_LABELS,
  TRUST_LADDER,
  trustLabelPermitted,
} from "./trust-label-contract";
import {
  TURN_EVIDENCE_COPY,
  claimExpiry,
  claimLanguage,
  postureLabel,
  proofLevelLabel,
  proofStatusLabel,
  rankedReceiptVerdict,
  relativeEvidenceAge,
  type TurnEvidenceState,
} from "./trust-language";
import { CLAIM_STATE_LEGEND } from "./claim-stack-facts";
import { turnEvidenceVerdict } from "./turn-evidence";
import type { ClaimStackItem, ClaimStackModel } from "./claim-stack-model";
import type { ProofStatus } from "../receipts/types";

describe("trust language", () => {
  it("never exposes machine enums as primary copy", () => {
    expect(proofLevelLabel("attested-endpoint")).toBe("Endpoint attested");
    expect(postureLabel("encrypted-unattested")).toBe("Encrypted · no required endpoint proof");
    expect(postureLabel("encrypted-attested")).toBe("Encrypted · fresh endpoint proof required");
    expect(proofStatusLabel("partial")).toBe("Asserted");
    expect(claimLanguage("cpuTee")).toEqual({ primary: "Protected CPU runtime", technical: "CPU TEE" });
  });
  it("speaks absence as absence and keeps the author in an assertion", () => {
    // "Established" meant two opposite things 183px apart: the rail counted
    // "7 established" for claims only recorded, while the metric beside it read
    // "Not established" to mean nothing was proven. The word is retired.
    expect(proofStatusLabel("unavailable")).toBe("No evidence");
    for (const status of ["verified", "partial", "failed", "expired", "unavailable"] as const) {
      expect(proofStatusLabel(status).toLowerCase()).not.toContain("establish");
    }
    // "Recorded" would say Airship wrote it down and drop the party that said
    // it. "Asserted" keeps the author, which is the claim being made.
    expect(proofStatusLabel("partial")).not.toBe("Recorded");
  });
  it("renders relative ages while timestamps remain available for time metadata", () => {
    expect(relativeEvidenceAge("2026-07-18T12:57:00.000Z", Date.parse("2026-07-18T13:00:00.000Z"))).toBe("3 minutes ago");
  });
  it("ranks failures before positive claims", () => {
    expect(rankedReceiptVerdict({ proofLevel: "settled", posture: "encrypted-attested", statuses: ["verified", "failed"] })).toMatch(/^Verification failed/);
  });
  it("extracts only valid explicit claim expiry fields", () => {
    expect(claimExpiry({ expiresAt: "2026-07-19T00:00:00.000Z" })).toBe("2026-07-19T00:00:00.000Z");
    expect(claimExpiry({ expiresAt: "tomorrow-ish" })).toBeUndefined();
  });
});

/*
 * ── The predicate guard ──────────────────────────────────────────────────
 *
 * The contract this package exists to hold: unifying the *word* must not unify
 * the *state*. Every assertion below is written so that hand-editing a label
 * onto a state whose predicate is false fails here rather than shipping.
 */

const ASSERTED_WORD = /\basserted\b/iu;

function claim(status: ProofStatus): ClaimStackItem {
  return Object.freeze({
    key: "encryption",
    status,
    qualifier: `asserted-${status}`,
    source: "turn-receipt",
    claim: Object.freeze({ status, summary: "fixture" }),
    facts: Object.freeze([]),
  }) as ClaimStackItem;
}

function stackOf(statuses: readonly ProofStatus[]): ClaimStackModel {
  const items = statuses.map(claim);
  return Object.freeze({
    evidence: "absent",
    evidenceSummary: "fixture",
    items,
    groups: Object.freeze({
      failed: items.filter((entry) => entry.status === "failed" || entry.status === "expired"),
      verified: items.filter((entry) => entry.status === "verified"),
      asserted: items.filter((entry) => entry.status === "partial"),
      unavailable: items.filter((entry) => entry.status === "unavailable"),
    }),
  });
}

describe("the trust ladder is three rungs, and a rung is a predicate", () => {
  it("prints its rung word only where the rung's predicate can hold", () => {
    for (const [id, spec] of Object.entries(TRUST_LABELS)) {
      // The whole guard, stated once: the word "Asserted" is a claim that a
      // party made a claim, so it is legible only where a receipt records one.
      expect(ASSERTED_WORD.test(spec.text), `${id}: "${spec.text}"`).toBe(spec.rung === "asserted");
      expect(spec.requiresReceipt, `${id}: "${spec.text}"`).toBe(spec.rung === "asserted");
    }
  });

  it("refuses an asserted label on a turn with no receipt", () => {
    expect(trustLabelPermitted(TRUST_LABELS.sessionAsserted, { hasReceipt: true })).toBe(true);
    expect(trustLabelPermitted(TRUST_LABELS.sessionAsserted, { hasReceipt: false })).toBe(false);
    expect(trustLabelPermitted(TRUST_LABELS.messageAssertedNoEndpoint, { hasReceipt: false })).toBe(false);
    // Absence is printable everywhere: it can only under-claim.
    expect(trustLabelPermitted(TRUST_LABELS.sessionNotChecked, { hasReceipt: false })).toBe(true);
    expect(trustLabelPermitted(TRUST_LABELS.messageNoEvidence, { hasReceipt: false })).toBe(true);
  });

  it("never emits the word from a state the reducer reached without a receipt", () => {
    // The live reducer, not the table: this is the assertion that catches a
    // build which re-words a no-receipt arm into the asserted vocabulary.
    const shapes: readonly (readonly ProofStatus[])[] = [
      [],
      ["unavailable"],
      ["partial"],
      ["verified"],
      ["verified", "partial"],
      ["partial", "unavailable"],
    ];
    for (const shape of shapes) {
      for (const acquisitionFailure of [undefined, "Evidence unavailable"]) {
        const verdict = turnEvidenceVerdict({
          stack: stackOf(shape),
          hasReceipt: false,
          ...(acquisitionFailure ? { acquisitionFailure } : {}),
        });
        expect(ASSERTED_WORD.test(verdict.chip), `${verdict.state}: "${verdict.chip}"`).toBe(false);
        expect(verdict.seal, verdict.state).not.toBe("asserted");
      }
    }
    // …and the receipt-bearing arm still says it, so the guard is not passing
    // by having deleted the word.
    const asserted = turnEvidenceVerdict({ stack: stackOf(["partial"]), hasReceipt: true });
    expect(asserted.chip).toBe(TRUST_LABELS.claimRailHero.text);
    expect(asserted.seal).toBe("asserted");
  });

  it("keeps every retired name out of the words it actually emits", () => {
    const emitted = [
      ...Object.values(TRUST_LABELS).map((spec) => spec.text),
      ...Object.values(TURN_EVIDENCE_COPY).flatMap((copy) => [copy.chip, copy.line]),
    ];
    for (const retired of RETIRED_TRUST_LABELS) {
      expect(emitted, retired).not.toContain(retired);
    }
    // Both no-receipt arms now stand on the one rung word.
    const noReceiptStates: readonly TurnEvidenceState[] = ["no-evidence", "evidence-blocked"];
    for (const state of noReceiptStates) {
      expect(TURN_EVIDENCE_COPY[state].chip.startsWith("No evidence"), state).toBe(true);
    }
  });

  it("states the same three definitions the Proof route's legend states", () => {
    // One dictionary in effect: the shell reaches the ladder without the Proof
    // chunk, and this fails the moment the two copies drift by one character.
    expect(TRUST_LADDER.map((rung) => rung.word)).toEqual(CLAIM_STATE_LEGEND.map((entry) => entry.word));
    expect(TRUST_LADDER.map((rung) => rung.meaning)).toEqual(CLAIM_STATE_LEGEND.map((entry) => entry.meaning));
    expect(TRUST_LADDER.map((rung) => rung.rung)).toEqual(["verified", "asserted", "no-evidence"]);
  });
});
