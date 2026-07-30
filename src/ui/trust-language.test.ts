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
import { describeAttestationSeal } from "./app";
import { encryptedReceiptFixture, endpointRecordFixture } from "./attestation-seal.fixtures";
import { SEAL_LABELS } from "./seal";
import { SESSION_STATUS_SHORT_MAX, sessionStatusShort } from "./chat/session-status-chip";
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
  it("speaks expiry in the word the evidence legend defines", () => {
    // "Expired" was a sixth state word that no legend on either Proof surface
    // defined: the Attestation tab taught "Stale observation" and then printed
    // "Expired" on every seal, count row and inspector title beside it.
    expect(proofStatusLabel("expired")).toBe("Stale observation");
    for (const status of ["verified", "partial", "failed", "expired", "unavailable"] as const) {
      expect(proofStatusLabel(status)).not.toBe("Expired");
    }
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

  /*
   * The same rule, over the *other* reducer that speaks this vocabulary.
   *
   * The guard above ran only over `turnEvidenceVerdict`, and a second, older
   * describer — `describeAttestationSeal` — emitted the same seal states from
   * the session bar without ever being covered. It shipped `asserted` for a
   * proof *policy*: a setting about the next turn, reached with no receipt, no
   * evidence record and no failure. One reducer under guard is not a guard.
   */
  it("never lets the session reducer reach an asserted rung without a receipt", () => {
    for (const connected of [true, false]) {
      for (const proofPolicy of [undefined, "record", "strict"] as const) {
        const seal = describeAttestationSeal({
          connected,
          ...(proofPolicy ? { proofPolicy } : {}),
          records: [],
          now: Date.parse("2026-07-19T12:00:00.000Z"),
        });
        const where = `connected=${String(connected)} policy=${String(proofPolicy)}`;
        expect(seal.state, where).not.toBe("asserted");
        expect(ASSERTED_WORD.test(seal.label), `${where}: "${seal.label}"`).toBe(false);
        // The mechanism that promoted a DOM attribute into a printed rung word:
        // the session bar shortens a label longer than the chip by falling back
        // to its state's own word, so a wrong `state` is *spoken*, not merely
        // recorded. This is the assertion that actually caught the shipped bug.
        expect(sessionStatusShort(seal.label, SEAL_LABELS[seal.state]), where)
          .not.toBe(SEAL_LABELS.asserted);
      }
    }
    // …and the arm that does hold a receipt still says it, so this guard is not
    // passing by having emptied the word out of the reducer.
    const withRecord = describeAttestationSeal({
      connected: true,
      receipt: encryptedReceiptFixture(),
      records: [endpointRecordFixture()],
      now: Date.parse("2026-07-19T12:00:00.000Z"),
    });
    expect(withRecord.state).toBe("asserted");
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

  /*
   * The ledger, enforced against what renders rather than against itself.
   *
   * The check above compares the dictionary to the dictionary: it passes as
   * long as no *entry in the table* spells a retired name, which is a property
   * the table trivially has. It never looked at a surface, and two surfaces
   * were printing retired names the whole time it was green — "Secure hardware
   * evidence pending" from the session/turn evidence reducer, and one assembled
   * by interpolation from a literal enum, which no whole-string search would
   * have found either.
   *
   * So this walks the shipped `src/ui` sources, reads only their string and
   * template literals (a retired name inside a comment is how a retirement is
   * *recorded*, and must stay legible), and matches a pattern that tolerates
   * interpolation in any position.
   */
  it("keeps every retired name off every surface that renders, including by interpolation", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const root = new URL("./", import.meta.url);
    const files: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(new URL(relative, root), { withFileTypes: true })) {
        const path = `${relative}${entry.name}`;
        if (entry.isDirectory()) { await walk(`${path}/`); continue; }
        if (!/\.tsx?$/u.test(entry.name) || /\.(?:test|fixtures)\.tsx?$/u.test(entry.name)) continue;
        // The two modules that name the retired words in order to retire them.
        if (path === "trust-language.ts" || path === "trust-label-contract.ts") continue;
        files.push(path);
      }
    };
    await walk("");
    expect(files.length).toBeGreaterThan(20);

    for (const path of files) {
      const literals = stringLiterals(await readFile(new URL(path, root), "utf8"));
      for (const retired of RETIRED_TRUST_LABELS) {
        for (const literal of literals) {
          expect(retiredNamePattern(retired).test(literal), `${path}: ${retired}`).toBe(false);
        }
      }
    }

    // A test that cannot fail is not a test: prove the scanner sees literals it
    // is pointed at, and that the interpolation tolerance is doing real work.
    const sample = stringLiterals([
      "// a comment naming 'Secure hardware evidence pending' stays legible",
      "const live = `verification remains ${model.trust.verification}`;",
    ].join("\n"));
    expect(sample).toEqual(["verification remains ${model.trust.verification}"]);
    expect(retiredNamePattern("verification remains unverified").test(sample[0]!)).toBe(true);
    expect(retiredNamePattern("Evidence not pulled").test(sample[0]!)).toBe(false);
  });

  /*
   * The chip bound, measured on every state rather than on the one a fixture
   * reaches.
   *
   * `TURN_EVIDENCE_COPY`'s docblock claimed "≤22" while `evidence-blocked` sat
   * at 24, and the suite's only length assertion ran on the `asserted` verdict
   * a receipt fixture happens to produce — exactly 22, so the over-long entry
   * was never measured. A documented bound nothing measures is a bound a
   * designer sizes a 40px row against and a build then breaks.
   */
  it("measures the resting chip and its sentence on every turn-evidence state", () => {
    const CHIP_MAX = 24;
    const LINE_MAX = 80;
    for (const [state, copy] of Object.entries(TURN_EVIDENCE_COPY)) {
      expect(copy.chip.length, `${state}: "${copy.chip}"`).toBeLessThanOrEqual(CHIP_MAX);
      expect(copy.line.length, `${state}: "${copy.line}"`).toBeLessThanOrEqual(LINE_MAX);
      // The one width-bound consumer never cuts a verdict: it prints the head
      // before " · " or the seal's own word, and both must fit the 430px right
      // cluster. This is what makes 24 safe where 22 was only arithmetic.
      const short = sessionStatusShort(copy.chip, SEAL_LABELS[copy.seal]);
      expect(short.length, `${state}: "${short}"`).toBeLessThanOrEqual(SESSION_STATUS_SHORT_MAX);
      expect(copy.chip.startsWith(short) || short === SEAL_LABELS[copy.seal], `${state}: "${short}"`).toBe(true);
    }
    // The chip the session bar actually receives for a blocked acquisition —
    // the 24-character entry — reaches it as a whole rung word, not a cut one.
    expect(sessionStatusShort(TURN_EVIDENCE_COPY["evidence-blocked"].chip, SEAL_LABELS.attention)).toBe("No evidence");
  });

  it("measures the counted chip and sentence the reducer composes, at their longest", () => {
    // `composeClaimStack` caps three of the eight keys at `partial`, so the
    // widest counted verdict is five verified with the remaining three split
    // across both tail clauses. The reducer writes these two strings itself;
    // the table's bound is worthless if the composed form escapes it.
    const widest = turnEvidenceVerdict({
      stack: stackOf([
        "verified", "verified", "verified", "verified", "verified",
        "partial", "unavailable", "unavailable",
      ]),
      hasReceipt: true,
    });
    expect(widest.chip).toBe("5 of 8 verified");
    expect(widest.chip.length).toBeLessThanOrEqual(24);
    expect(widest.line).toBe("5 claims were verified by a named authority; 1 asserted, 2 with no evidence.");
    expect(widest.line.length).toBeLessThanOrEqual(80);

    // Singular, because "1 claims were verified" is the sentence a reader
    // trusts least on the surface whose only job is to be trusted — and one
    // verified claim is the commonest non-zero case on this stack.
    const one = turnEvidenceVerdict({ stack: stackOf(["verified", "partial"]), hasReceipt: true });
    expect(one.line).toBe("1 claim was verified by a named authority; 1 asserted.");
  });

  it("states the same three definitions the Proof route's legend states", () => {
    // One dictionary in effect: the shell reaches the ladder without the Proof
    // chunk, and this fails the moment the two copies drift by one character.
    expect(TRUST_LADDER.map((rung) => rung.word)).toEqual(CLAIM_STATE_LEGEND.map((entry) => entry.word));
    expect(TRUST_LADDER.map((rung) => rung.meaning)).toEqual(CLAIM_STATE_LEGEND.map((entry) => entry.meaning));
    expect(TRUST_LADDER.map((rung) => rung.rung)).toEqual(["verified", "asserted", "no-evidence"]);
  });
});

/**
 * A retired name as it can actually appear in source: spelled out, or with one
 * word supplied by an interpolation. `verification remains ${…}` printed a
 * retired name for months without any whole-string search being able to see it.
 *
 * At most *one* word may be interpolated, and that bound is the whole design.
 * Allowing every word to be a `${…}` made this match any template of three
 * consecutive interpolations — it flagged
 * `${verb} ${total} ${total === 1 ? "file" : "files"}` in the workbench as
 * "Evidence not pulled". A caption assembled entirely from variables is not
 * spelling a retired name; a caption that spells all but one word of one is.
 */
function retiredNamePattern(retired: string): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const words = retired.split(" ");
  const variants = [words.map(escape)];
  for (let hole = 0; hole < words.length; hole += 1) {
    variants.push(words.map((word, index) => index === hole ? "\\$\\{[^}]*\\}" : escape(word)));
  }
  return new RegExp(`(?:${variants.map((variant) => variant.join("\\s+")).join("|")})`, "iu");
}

/**
 * Every string and template literal in one TypeScript source, comments excluded.
 *
 * Deliberately a scanner rather than a regex: a comment is where a retirement
 * is *explained*, so it must be able to name the retired words, and a regex
 * that cannot tell a comment from a caption would either forbid the explanation
 * or miss the caption.
 */
function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== character) {
        if (source[index] === "\\") { value += source.slice(index, index + 2); index += 2; continue; }
        // An unterminated single/double-quoted literal means the scanner lost
        // sync (a regex literal holding an odd quote). Stop rather than swallow
        // the rest of the file, which would hide every caption after it.
        if (source[index] === "\n" && character !== "`") break;
        value += source[index]!;
        index += 1;
      }
      index += 1;
      literals.push(value);
      continue;
    }
    index += 1;
  }
  return literals;
}
