import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AttestationEvidenceClientError } from "../attestation/provider-client";
import {
  ATTESTATION_CLAIM_GROUPS,
  EVIDENCE_STATE_MEANINGS,
  attestationQualifierLabel,
  attestationRecordReading,
  attestationRefreshError,
} from "./attestations-view";
import { ATTESTATION_DIMENSIONS } from "./attestations-model";
import { claimQualifierLabel } from "./claim-stack-facts";
import { proofStatusLabel } from "./trust-language";

const source = readFileSync(new URL("./attestations-view.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./attestations-view.css", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

describe("attestation refresh failure copy", () => {
  it("renders an unreadable cross-origin response without inventing a CORS or TEE result", () => {
    const message = attestationRefreshError(new AttestationEvidenceClientError(
      "cross-origin-unreadable",
      "The browser could not read the Chutes evidence response.",
    ));
    expect(message).toContain("Provider evidence is cross-origin unreadable");
    expect(message).toContain("CORS authorization or the network path may have failed");
    expect(message).toContain("evidence was not pulled");
    expect(message).toContain("not a TEE verification failure");
    expect(message).toContain("no claim was promoted");
    expect(message).not.toContain("proxy");
  });

  it("does not expose arbitrary provider error text", () => {
    const message = attestationRefreshError(new Error("raw provider body csc_never-show-this-value"));
    expect(message).toBe("Evidence refresh failed safely. Evidence was not pulled, and no verification state was inferred from the failure.");
    expect(message).not.toContain("csc_");
  });
});

describe("route-owned evidence selection", () => {
  it("does not fall through to the newest record when a named record is absent", () => {
    expect(source).toContain("const requestedRecordMissing = Boolean(selectedRecordId");
    expect(source).toContain("No newer record was selected in its place.");
    expect(source).toContain("const selected = requestedRecordMissing");
    expect(appSource).toContain("const ledgerSelectedRecordId = proofScoped");
    expect(appSource).toContain("`receipt:${effectiveProofSelection.receiptId}`");
  });

  it("re-enqueues the active receipt once when its endpoint observation expires", () => {
    expect(appSource).toContain("automaticEvidenceRefreshes.current.has(record.recordId)");
    expect(appSource).toContain("enqueueAutomaticReceiptEvidence(lastReceipt, sessionId, profileId)");
    expect(appSource).toContain("window.setInterval(tick, 30_000)");
  });
});

describe("one qualifier vocabulary across both Proof tabs", () => {
  it("says exactly what the Receipt & journal tab says about the same qualifier", () => {
    // The defect this package exists to fix is two tabs describing one turn in
    // two languages. The dictionary cannot be shared as a module here — see the
    // comment on `attestationQualifierLabel` — so the agreement is asserted
    // instead, over every qualifier `attestations-model.ts` can emit.
    const emitted = [
      ...(["verified", "partial", "failed", "expired", "unavailable"] as const).map((state) => `asserted-${state}`),
      "verified-without-authority",
      "matched", "present", "unverified", "verified", "failed", "expired", "unavailable",
      "runtime-policy-matched/model-unavailable",
      "matched/unavailable",
    ];
    for (const qualifier of emitted) {
      expect(attestationQualifierLabel(qualifier), qualifier)
        .toBe(claimQualifierLabel(qualifier, { ceilingStatedElsewhere: true }));
    }
  });

  it("never re-prefixes the status word the caller already rendered", () => {
    // "Attested endpoint-key bindingASSERTED · ASSERTED PARTIAL · RECEIPT
    // UNAUTHENTICATED" — four status words in a row, in two casings.
    for (const qualifier of ["asserted-verified", "asserted-failed", "verified-without-authority", "matched"]) {
      expect(attestationQualifierLabel(qualifier)?.toLowerCase()).not.toContain("asserted");
    }
    expect(attestationQualifierLabel("asserted-partial")).toBeUndefined();
  });
});

describe("evidence comprehension hierarchy", () => {
  it("never describes an immutable receipt as stale when one of its claims expired", () => {
    expect(attestationRecordReading({
      source: "conversation-receipt",
      overallState: "expired",
    })).toEqual({
      kind: "immutable-receipt",
      label: "Immutable turn receipt · contains an expired claim",
      detail: "This completion record does not change or become stale. Later endpoint observations can be compared with it, but cannot rewrite or silently upgrade it.",
    });
  });

  it("labels expiry as a stale endpoint observation without rewriting receipt history", () => {
    const reading = attestationRecordReading({
      source: "endpoint-evidence",
      overallState: "expired",
    });
    expect(reading.kind).toBe("endpoint-observation");
    expect(reading.label).toBe("Stale observation");
    expect(reading.detail).toContain("historical evidence");
    expect(reading.detail).toContain("does not make an immutable receipt stale");
  });

  it("groups every claim exactly once without removing TEE, model, conversation, or payment facts", () => {
    const grouped = ATTESTATION_CLAIM_GROUPS.flatMap((group) => group.keys);
    expect([...grouped].sort()).toEqual([...ATTESTATION_DIMENSIONS].sort());
    expect(new Set(grouped).size).toBe(ATTESTATION_DIMENSIONS.length);
    expect(grouped).toEqual(expect.arrayContaining([
      "cpu-tee",
      "gpu-tee",
      "model",
      "conversation",
      "payment",
    ]));
    expect(ATTESTATION_CLAIM_GROUPS.find((group) => group.id === "compute")?.description).toContain("Intel TDX");
    expect(ATTESTATION_CLAIM_GROUPS.find((group) => group.id === "compute")?.description).toContain("NVIDIA CC");
  });

  it("defines verified, asserted, failed, unavailable, and stale observation meanings", () => {
    expect(EVIDENCE_STATE_MEANINGS.map((entry) => entry.label)).toEqual([
      "Verified",
      "Asserted",
      "Failed",
      "No evidence",
      "Stale observation",
    ]);
  });

  it("prints only state words this legend defines", () => {
    // The seals, the record-count row and the inspector title all render
    // `proofStatusLabel`, and it used to answer "Expired" for a state this
    // legend calls a stale observation — a sixth word, taught nowhere, on the
    // same screen as the definition it contradicted.
    const defined = new Set(EVIDENCE_STATE_MEANINGS.map((entry) => entry.label));
    for (const status of ["verified", "partial", "failed", "expired", "unavailable"] as const) {
      expect(defined).toContain(proofStatusLabel(status));
    }
  });

  it("states one privacy boundary for raw evidence, not two that disagree", () => {
    // The panel said raw evidence was withheld by design and, 155 lines later,
    // that raw values remained available in the same panel. The grid renders
    // normalized digests and measurement metadata; the raw material is reachable
    // only through the Receipt & journal export, so the header names it.
    expect(source).toContain("Raw evidence withheld here; export the raw verification bundle from Receipt &amp; journal");
    expect(source).toContain("digests and measurement metadata only");
    expect(source).not.toContain("raw values remain available here");
  });

  it("presents manual acquisition as retry/diagnostic and preserves the full mobile fact path", () => {
    expect(source).toContain("Manual acquisition is a retry and diagnostic; it never rewrites a receipt.");
    expect(source).toContain("Retry acquisition");
    expect(source).toContain('<details class="attestations-authorities">');
    expect(source).toContain('<details class="attestations-bindings">');
    expect(source.indexOf('class="attestation-matrix"')).toBeLessThan(source.indexOf('id="attestation-selected-detail"'));
    expect(source.indexOf('id="attestation-selected-detail"')).toBeLessThan(source.indexOf('class="attestations-disclosures"'));
    expect(styles).toContain(".attestation-claim-group > div { grid-template-columns: 1fr; }");
    expect(styles).not.toMatch(/@media \(max-width: 480px\)[\s\S]*\.attestations-inspector\s*\{[^}]*display:\s*none/u);
  });
});
