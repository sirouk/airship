import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ClaimStackItem, ClaimStackModel } from "./claim-stack-model";
import type { ProofStatus } from "../receipts/types";
import {
  TURN_EVIDENCE_COPY,
  claimCeiling,
  declaredClaimStatus,
  turnEvidenceCounts,
  turnEvidenceVerdict,
} from "./turn-evidence";

function item(over: Partial<ClaimStackItem> & Pick<ClaimStackItem, "status">): ClaimStackItem {
  return Object.freeze({
    key: "encryption",
    qualifier: `asserted-${over.status}`,
    source: "turn-receipt",
    claim: Object.freeze({ status: over.status, summary: "fixture" }),
    facts: Object.freeze([]),
    ...over,
  }) as ClaimStackItem;
}

function stack(items: readonly ClaimStackItem[]): ClaimStackModel {
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

const STATUSES: readonly ProofStatus[] = ["verified", "partial", "unavailable", "failed", "expired"];

describe("turnEvidenceCounts", () => {
  it("sorts every status into exactly one of the four buckets", () => {
    const counts = turnEvidenceCounts(STATUSES.map((status) => item({ status })));

    expect(counts).toEqual({ verified: 1, asserted: 1, noEvidence: 1, failed: 2, total: 5 });
    expect(counts.verified + counts.asserted + counts.noEvidence + counts.failed).toBe(counts.total);
  });
});

describe("turnEvidenceVerdict", () => {
  it("never lets an acquisition failure outrank a receipt that exists", () => {
    const verdict = turnEvidenceVerdict({
      stack: stack([item({ status: "partial" }), item({ status: "unavailable" })]),
      hasReceipt: true,
      acquisitionFailure: "Evidence unavailable",
    });

    // The measured defect: the topbar printed the acquisition reason as a
    // verdict while the session badge said the turn had been recorded. A fetch
    // that did not happen is a modifier, and the verdict is what the receipt
    // actually establishes.
    expect(verdict.state).toBe("asserted");
    expect(verdict.chip).toBe("Asserted, not verified");
    expect(verdict.modifier).toBe("Evidence unavailable");
  });

  it("promotes the acquisition failure to the verdict only when no receipt exists", () => {
    const blocked = turnEvidenceVerdict({ stack: stack([]), hasReceipt: false, acquisitionFailure: "Evidence access denied" });
    const quiet = turnEvidenceVerdict({ stack: stack([]), hasReceipt: false });

    expect(blocked.chip).toBe(TURN_EVIDENCE_COPY["evidence-blocked"].chip);
    expect(blocked.modifier).toBe("Evidence access denied");
    expect(quiet.chip).toBe(TURN_EVIDENCE_COPY["no-evidence"].chip);
    expect(quiet.modifier).toBeUndefined();
  });

  it("counts rather than characterises a partly verified turn, and never rounds up", () => {
    const verdict = turnEvidenceVerdict({
      stack: stack([item({ status: "verified" }), item({ status: "partial" }), item({ status: "unavailable" })]),
      hasReceipt: true,
    });

    expect(verdict.state).toBe("partly-proven");
    expect(verdict.chip).toBe("1 of 3 verified");
    expect(verdict.chip).not.toBe(TURN_EVIDENCE_COPY.proven.chip);
  });

  it("fails closed on a disagreeing attested receipt even with nothing failed in the stack", () => {
    const verdict = turnEvidenceVerdict({
      stack: stack([item({ status: "verified" })]),
      hasReceipt: true,
      attestedFieldsDisagree: true,
    });

    expect(verdict.state).toBe("failed");
    expect(verdict.line).toBe(TURN_EVIDENCE_COPY.failed.line);
  });

  it("reports both ceilings separately, and only when one actually moved a claim", () => {
    const capped = turnEvidenceVerdict({
      stack: stack([
        item({ status: "partial", qualifier: "asserted-verified" }),
        item({ status: "partial", qualifier: "verified-without-authority" }),
        // Declared and shown agree, so no ceiling is reported for this one.
        item({ status: "partial", qualifier: "asserted-partial" }),
      ]),
      hasReceipt: true,
    });

    expect(capped.declaredVerified).toBe(2);
    expect(capped.counts.verified).toBe(0);
    expect(capped.ceilings).toEqual(["receipt-integrity", "authority"]);
  });
});

describe("the qualifier readers", () => {
  it("reads a declared status back off the qualifier without storing it twice", () => {
    expect(declaredClaimStatus(item({ status: "partial", qualifier: "asserted-verified" }))).toBe("verified");
    expect(declaredClaimStatus(item({ status: "partial", qualifier: "verified-without-authority" }))).toBe("verified");
    expect(declaredClaimStatus(item({ status: "verified", qualifier: "verified" }))).toBe("verified");
  });

  it("reports no ceiling for a rule that applied but changed nothing", () => {
    expect(claimCeiling(item({ status: "partial", qualifier: "asserted-partial" }))).toBeUndefined();
    expect(claimCeiling(item({ status: "partial", qualifier: "asserted-verified" }))).toBe("receipt-integrity");
  });
});

/*
 * The delivery boundary is load-bearing, not stylistic.
 *
 * The shell draws this verdict at first paint, so the reducer has to live in a
 * module the shell can reach without also downloading the Proof route's
 * ceiling copy, legend and popover projection. If someone moves it back beside
 * that copy, the 132 KiB startup cap absorbs the difference silently — this
 * test is the thing that does not.
 */
const [turnEvidence, claimStackFacts, app] = await Promise.all([
  readFile(new URL("./turn-evidence.ts", import.meta.url), "utf8"),
  readFile(new URL("./claim-stack-facts.ts", import.meta.url), "utf8"),
  readFile(new URL("./app.tsx", import.meta.url), "utf8"),
]);

describe("the canonical verdict's delivery boundary", () => {
  it("keeps the shell's reducer out of the Proof route's disclosure module", () => {
    expect(turnEvidence).toContain("export function turnEvidenceVerdict(");
    expect(claimStackFacts).not.toContain("export function turnEvidenceVerdict(");
    expect(claimStackFacts).toContain('} from "./turn-evidence";');
    // The disclosure copy stays where only a disclosure surface pays for it.
    expect(turnEvidence).not.toContain("CLAIM_CEILING_SENTENCES");
    expect(turnEvidence).not.toContain("CLAIM_STATE_LEGEND");
  });

  it("imports the shell's evidence words from the one module that defines them", () => {
    expect(app).toContain('from "./turn-evidence"');
    // The acquisition branch reads the canonical word rather than spelling a
    // fifth one; that is the whole point of exporting the copy as data.
    expect(app).toContain('label: TURN_EVIDENCE_COPY["evidence-blocked"].chip');
    expect(app).not.toContain('label: args.failure.label');
  });
});
