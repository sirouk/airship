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
  it("sorts every status into exactly one of the five buckets", () => {
    const counts = turnEvidenceCounts(STATUSES.map((status) => item({ status })));

    expect(counts).toEqual({ verified: 1, asserted: 1, noEvidence: 1, failed: 1, expired: 1, total: 5 });
    expect(counts.verified + counts.asserted + counts.noEvidence + counts.failed + counts.expired).toBe(counts.total);
  });

  it("never files an expired claim under failed", () => {
    // The measured defect: `ProofStatus` has five members and this reducer had
    // four buckets, so the Proof summary tab printed "Failed: 1" for a claim
    // nothing had found to be false, while the Attestation tab called the same
    // claim a stale observation.
    const counts = turnEvidenceCounts([item({ status: "expired" })]);

    expect(counts.expired).toBe(1);
    expect(counts.failed).toBe(0);
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
    // There is no stronger rung to round up to: the receipt-integrity ceiling
    // caps three of the eight claim keys at `partial`, so "Proven this turn"
    // was unreachable and is deleted, not redefined.
    expect("proven" as string).not.toBe(verdict.state);
  });

  it("names evidence-less claims as no evidence, never as assertions", () => {
    const verdict = turnEvidenceVerdict({
      stack: stack([
        item({ status: "verified" }),
        item({ status: "partial" }),
        item({ status: "unavailable" }),
        item({ status: "unavailable" }),
      ]),
      hasReceipt: true,
    });

    // The measured defect: "the rest are assertions" filed claims with no
    // record at all under the asserted rung — the one reading §3 forbids. The
    // tail is composed from the buckets, omitting any whose count is zero.
    expect(verdict.line).toBe("1 claim was verified by a named authority; 1 asserted, 2 with no evidence.");
    expect(verdict.line).not.toContain("assertions");

    const assertionsOnly = turnEvidenceVerdict({
      stack: stack([item({ status: "verified" }), item({ status: "partial" })]),
      hasReceipt: true,
    });
    expect(assertionsOnly.line).toBe("1 claim was verified by a named authority; 1 asserted.");

    const nothingElse = turnEvidenceVerdict({
      stack: stack([item({ status: "verified" }), item({ status: "unavailable" })]),
      hasReceipt: true,
    });
    expect(nothingElse.line).toBe("1 claim was verified by a named authority; 1 with no evidence.");
  });

  it("speaks one verified claim in the singular and drops the tail when there is none", () => {
    // One verified claim is the commonest non-zero case on the eight-key stack,
    // and the sentence read "1 claims were verified by a named authority" on the
    // Proof hero — pinned verbatim by three assertions above, which is how a
    // grammar defect acquires a test defending it.
    const one = turnEvidenceVerdict({
      stack: stack([item({ status: "verified" }), item({ status: "partial" })]),
      hasReceipt: true,
    });
    expect(one.line.startsWith("1 claim was verified")).toBe(true);
    expect(one.line).not.toContain("1 claims");

    const many = turnEvidenceVerdict({
      stack: stack([item({ status: "verified" }), item({ status: "verified" }), item({ status: "partial" })]),
      hasReceipt: true,
    });
    expect(many.line).toBe("2 claims were verified by a named authority; 1 asserted.");

    // Unreachable through `composeClaimStack` — the receipt-integrity ceiling
    // caps three of the eight keys at `partial` — but `turnEvidenceVerdict` is
    // exported, and an all-verified stack used to render a dangling "; .".
    const everything = turnEvidenceVerdict({ stack: stack([item({ status: "verified" })]), hasReceipt: true });
    expect(everything.line).toBe("1 claim was verified by a named authority.");
    expect(everything.line).not.toContain("; .");
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

  it("still fails closed on expiry now that expiry has its own count", () => {
    const verdict = turnEvidenceVerdict({
      stack: stack([item({ status: "verified" }), item({ status: "expired" })]),
      hasReceipt: true,
    });

    // Separating the bucket must not soften the verdict: the copy already says
    // "failed or expired", so the hero is unchanged and only the count a reader
    // is shown stops claiming a check was run and failed.
    expect(verdict.state).toBe("failed");
    expect(verdict.line).toBe(TURN_EVIDENCE_COPY.failed.line);
    expect(verdict.counts.expired).toBe(1);
    expect(verdict.counts.failed).toBe(0);
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

  it("recovers records and then the persisted queue only after a credential-backed client is installed", () => {
    const connection = app.indexOf("async function connectChutes(");
    const workerInstall = app.indexOf(
      "const evidenceClient = await installAttestationEvidenceClient(",
      connection,
    );
    const recordAuthorityGate = app.indexOf(
      "if (evidenceClient && endpointEvidenceAuthority.current?.current())",
      workerInstall,
    );
    const recovery = app.indexOf(
      "await rebindEvidenceAcquisitionQueue(true, committedRuntime, nextProfile.profileId);",
      connection,
    );
    expect(connection).toBeGreaterThanOrEqual(0);
    expect(workerInstall).toBeGreaterThan(connection);
    expect(recordAuthorityGate).toBeGreaterThan(workerInstall);
    expect(recovery).toBeGreaterThan(recordAuthorityGate);

    const install = app.indexOf("async function installAttestationEvidenceClient(");
    const installBinding = app.indexOf("attestationClientBinding.current = binding;", install);
    const recordRecovery = app.indexOf("await ensureEndpointEvidenceAuthority(scope, binding);", installBinding);
    expect(installBinding).toBeGreaterThan(install);
    expect(recordRecovery).toBeGreaterThan(installBinding);
  });

  it("keeps disconnected queues paused and fences recovery to Profile, WorkspacePort, and client generation", () => {
    const profileEffect = app.indexOf("// Endpoint proof and its scheduler are one Profile cockpit.");
    const noCredential = app.indexOf("if (!credential || !credentialKind)", profileEffect);
    const profileRebind = app.indexOf("void rebindProfileEvidenceScope(active, profileId, credential, credentialKind)", profileEffect);
    expect(profileEffect).toBeGreaterThanOrEqual(0);
    expect(noCredential).toBeGreaterThan(profileEffect);
    expect(profileRebind).toBeGreaterThan(noCredential);

    const ensureQueue = app.indexOf("async function ensureEvidenceAcquisitionQueue(");
    const credentialGate = app.indexOf("!providerCredential.current", ensureQueue);
    const clientFence = app.indexOf("!sameEndpointEvidenceScope(expectedClient, evidenceScope)", ensureQueue);
    const recordFence = app.indexOf("!sameEndpointEvidenceScope(expectedEndpointBinding, evidenceScope)", ensureQueue);
    const recovery = app.indexOf("const binding = await authority.activate(target);", ensureQueue);
    expect(credentialGate).toBeGreaterThan(ensureQueue);
    expect(clientFence).toBeGreaterThan(credentialGate);
    expect(recordFence).toBeGreaterThan(clientFence);
    expect(recovery).toBeGreaterThan(recordFence);

    expect(app).toContain("attestationClientBinding.current !== expectedClient");
    expect(app).toContain("endpointEvidenceAuthority.current?.current() !== expectedEndpointBinding");
    expect(app).toContain("attestationPresentation.profileId === profileId");
    expect(app).toContain("attestationPresentation.sessionId === sessionId");
    expect(app).toContain("await authority.activate(target);");

    const acquireStart = app.indexOf("async function acquireEndpointAttestation(");
    const acquireEnd = app.indexOf("async function probeCurrentEndpoint(", acquireStart);
    const acquisition = app.slice(acquireStart, acquireEnd);
    expect(acquisition).toContain("const operation = attestationOperation.current;");
    expect(acquisition).not.toContain("++attestationOperation.current");
    expect(acquisition).toContain("attestationClientBinding.current !== clientBinding");
    expect(acquisition).toContain("isCurrentEndpointEvidenceFence(fence)");
  });
});
