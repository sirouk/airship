import { describe, expect, it } from "vitest";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import { createLocalReceipt } from "../receipts/types";
import { claimCeiling, declaredClaimStatus, turnEvidenceVerdict } from "./claim-stack-facts";
import { composeClaimStack } from "./claim-stack-model";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const KEY_DIGEST = `sha256:${"a".repeat(64)}`;

describe("claim-stack evidence composition", () => {
  it("names every unestablished proof axis before the first completed turn", () => {
    const model = composeClaimStack(undefined, undefined, NOW);

    expect(model.evidence).toBe("absent");
    expect(model.items).toHaveLength(8);
    expect(model.groups.unavailable.map((item) => item.key)).toEqual([
      "encryption", "freshness", "cpuTee", "gpuTee", "endpointKey", "model", "conversation", "payment",
    ]);
    expect(model.groups.unavailable.every((item) => item.status === "unavailable" && item.claim.summary.length > 20)).toBe(true);
  });

  it("composes fresh endpoint evidence only when its payload digest is recorded by the immutable receipt", () => {
    const receipt = encryptedReceipt();
    const model = composeClaimStack(receipt, endpointRecord(), NOW);

    expect(model.evidence).toBe("turn-bound");
    expect(model.evidenceSummary).toContain("payload digest exactly matches");
    expect(model.groups.asserted.map((item) => item.key)).toEqual(expect.arrayContaining(["encryption", "freshness", "cpuTee", "endpointKey"]));
    expect(model.items.find((item) => item.key === "endpointKey")).toMatchObject({ source: "endpoint-evidence", status: "partial" });
    expect(model.items.find((item) => item.key === "conversation")).toMatchObject({ source: "turn-receipt", status: "partial" });
    expect(receipt.claims.endpointKey.status).toBe("unavailable");
  });

  it("labels later same-instance/key evidence as not turn-bound and does not project its claims", () => {
    const receipt = encryptedReceipt(null);
    const model = composeClaimStack(receipt, endpointRecord(), NOW);

    expect(model.evidence).toBe("same-endpoint");
    expect(model.evidenceSummary).toContain("matches only the receipt’s instance and endpoint-key digest");
    expect(model.evidenceSummary).toContain("not bound to this exact turn");
    expect(model.items.find((item) => item.key === "cpuTee")).toMatchObject({
      source: "turn-receipt",
      status: "unavailable",
    });
    expect(model.items.find((item) => item.key === "endpointKey")).toMatchObject({
      source: "turn-receipt",
      status: "unavailable",
    });
  });

  it("does not treat a different evidence digest as exact-turn evidence", () => {
    const model = composeClaimStack(encryptedReceipt(`sha256:${"b".repeat(64)}`), endpointRecord(), NOW);
    expect(model.evidence).toBe("same-endpoint");
    expect(model.groups.verified).toHaveLength(0);
  });

  it("does not compose stale evidence and collapses its hardware claims as unavailable", () => {
    const model = composeClaimStack(encryptedReceipt(), endpointRecord(), Date.parse("2026-07-19T12:06:00.000Z"));
    expect(model.evidence).toBe("stale-turn-bound");
    expect(model.items.find((item) => item.key === "cpuTee")).toMatchObject({ source: "turn-receipt", status: "unavailable" });
    expect(model.groups.unavailable.map((item) => item.key)).toContain("endpointKey");
  });

  it("promotes only verifier-authenticated endpoint claims to verified", () => {
    const record = endpointRecord();
    const model = composeClaimStack(encryptedReceipt(), {
      ...record,
      claims: { ...record.claims, cpuTee: { ...record.claims.cpuTee, state: "verified", verifier: "intel-dcap-browser" } },
    }, NOW);
    expect(model.groups.verified).toHaveLength(1);
    expect(model.groups.verified[0]).toMatchObject({ key: "cpuTee", source: "endpoint-evidence" });
  });

  it("presents normalized quote-v5 evidence without labeling it quote-v4", () => {
    const record = endpointRecord();
    const model = composeClaimStack(encryptedReceipt(), {
      ...record,
      evidence: {
        ...record.evidence,
        quote: { ...record.evidence.quote, format: "intel-tdx-quote-v5", version: 5 },
      },
    }, NOW);

    expect(model.items.find((item) => item.key === "cpuTee")?.facts).toContainEqual({
      label: "TDX quote",
      value: "2,048 bytes · v5",
    });
  });
});

describe("the two claim ceilings", () => {
  it("never lets a receipt's own declaration of verification stand as verified", () => {
    // The measured defect: one receipt, one tab click apart, read "VERIFIED 1
    // / Protected CPU runtime ✓ Verified" on Receipt & journal and "Asserted ·
    // receipt unauthenticated" on Attestation evidence. Nothing authenticates
    // a receipt, so its own claim of verification is an assertion.
    const receipt = encryptedReceipt();
    receipt.claims.cpuTee = { status: "verified", summary: "Receipt declares a verified CPU TEE.", verifier: "chutes" };
    const model = composeClaimStack(receipt, undefined, NOW);
    const cpu = model.items.find((item) => item.key === "cpuTee")!;

    expect(cpu).toMatchObject({ source: "turn-receipt", status: "partial", qualifier: "asserted-verified" });
    expect(declaredClaimStatus(cpu)).toBe("verified");
    expect(claimCeiling(cpu)).toBe("receipt-integrity");
    expect(model.groups.verified).toHaveLength(0);
  });

  it("keeps a declared failure at full weight rather than softening it to an assertion", () => {
    // Fail-closed: the receipt-integrity ceiling may lower a positive claim and
    // may never soften a negative one, or a stated failure would be filed under
    // "Assertions" and leave the "Needs attention" group empty.
    const receipt = encryptedReceipt();
    receipt.claims.model = { status: "failed", summary: "The declared model artifact did not match." };
    const model = composeClaimStack(receipt, undefined, NOW);

    expect(model.items.find((item) => item.key === "model")).toMatchObject({ status: "failed", qualifier: "asserted-failed" });
    expect(model.groups.failed.map((item) => item.key)).toEqual(["model"]);
  });

  it("caps endpoint evidence that declares verification without naming a verifier", () => {
    const record = endpointRecord();
    const model = composeClaimStack(encryptedReceipt(), {
      ...record,
      claims: { ...record.claims, cpuTee: { state: "verified", title: "Fixture", summary: "verified fixture" } },
    }, NOW);
    const cpu = model.items.find((item) => item.key === "cpuTee")!;

    expect(cpu).toMatchObject({ source: "endpoint-evidence", status: "partial", qualifier: "verified-without-authority" });
    expect(declaredClaimStatus(cpu)).toBe("verified");
    expect(claimCeiling(cpu)).toBe("authority");
  });
});

describe("the one turn-evidence verdict", () => {
  it("answers an unproven-but-recorded turn with one asserted verdict and both figures", () => {
    const receipt = encryptedReceipt();
    receipt.claims.cpuTee = { status: "verified", summary: "Receipt declares a verified CPU TEE.", verifier: "chutes" };
    const verdict = turnEvidenceVerdict({ stack: composeClaimStack(receipt, undefined, NOW), hasReceipt: true });

    expect(verdict.state).toBe("asserted");
    expect(verdict.seal).toBe("asserted");
    expect(verdict.chip).toBe("Asserted, not verified");
    expect(verdict.chip.length).toBeLessThanOrEqual(22);
    expect(verdict.line.length).toBeLessThanOrEqual(80);
    // Uncapped versus capped, which is the whole argument of the surface.
    expect(verdict.declaredVerified).toBe(1);
    expect(verdict.counts.verified).toBe(0);
    expect(verdict.ceilings).toEqual(["receipt-integrity"]);
  });

  it("never promotes a failed fetch over a recorded turn, and never demotes it to nothing", () => {
    // An acquisition failure beside a receipt produced a topbar reading
    // "Evidence unavailable" next to a badge reading "evidence recorded".
    const withReceipt = turnEvidenceVerdict({
      stack: composeClaimStack(encryptedReceipt(), undefined, NOW),
      hasReceipt: true,
      acquisitionFailure: "Evidence path unreadable",
    });
    expect(withReceipt.state).toBe("asserted");
    expect(withReceipt.modifier).toBe("Evidence path unreadable");

    const withoutReceipt = turnEvidenceVerdict({
      stack: composeClaimStack(undefined, undefined, NOW),
      hasReceipt: false,
      acquisitionFailure: "Evidence path unreadable",
    });
    expect(withoutReceipt.state).toBe("evidence-blocked");
    expect(withoutReceipt.seal).toBe("attention");
  });

  it("fails closed on an attested receipt whose own fields disagree", () => {
    const verdict = turnEvidenceVerdict({
      stack: composeClaimStack(encryptedReceipt(), undefined, NOW),
      hasReceipt: true,
      attestedFieldsDisagree: true,
    });
    expect(verdict.state).toBe("failed");
    expect(verdict.line).toBe("Verification failed or expired · do not rely on this receipt");
  });

  it("says no evidence, not no proof, before the first turn", () => {
    const verdict = turnEvidenceVerdict({ stack: composeClaimStack(undefined, undefined, NOW), hasReceipt: false });
    expect(verdict.state).toBe("no-evidence");
    expect(verdict.counts).toMatchObject({ verified: 0, asserted: 0, noEvidence: 8, total: 8 });
    expect(verdict.ceilings).toEqual([]);
  });

  it("counts the surviving verifications when an authority actually checked one", () => {
    const record = endpointRecord();
    const verdict = turnEvidenceVerdict({
      stack: composeClaimStack(encryptedReceipt(), {
        ...record,
        claims: { ...record.claims, cpuTee: { ...record.claims.cpuTee, state: "verified", verifier: "intel-dcap-browser" } },
      }, NOW),
      hasReceipt: true,
    });
    expect(verdict.state).toBe("partly-proven");
    expect(verdict.chip).toBe("1 of 8 verified");
    expect(verdict.counts.verified).toBe(1);
  });
});

function encryptedReceipt(evidenceDigest: string | null = KEY_DIGEST) {
  const receipt = createLocalReceipt({ sessionId: "session-1", turnId: "turn-1", provider: "chutes-e2ee-v1", model: "model-1" });
  receipt.instanceId = "instance-1";
  receipt.posture = "encrypted-unattested";
  receipt.proofLevel = "encrypted";
  receipt.bindings.endpointKeyDigest = KEY_DIGEST;
  if (evidenceDigest) receipt.bindings.evidenceDigest = evidenceDigest;
  receipt.claims.encryption = { status: "partial", summary: "Authenticated encryption was used for the turn." };
  return receipt;
}

function endpointRecord(): ChutesEndpointEvidenceRecord {
  const claim = (state: ChutesEndpointEvidenceRecord["claims"][keyof ChutesEndpointEvidenceRecord["claims"]]["state"]) => ({ state, title: "Fixture", summary: `${state} fixture`, checkedAt: "2026-07-19T12:00:00.000Z" });
  return {
    version: 1,
    recordId: "urn:airship:attestation:fixture",
    provider: "chutes",
    kind: "endpoint-evidence",
    verdict: "evidence-only",
    subject: { scope: "endpoint", chuteId: "chute-1", instanceId: "instance-1", e2ePublicKey: "", e2ePublicKeyDigest: KEY_DIGEST },
    acquisition: { endpoint: "instance-evidence", requestUrl: "https://api.chutes.ai/fixture", requestNonce: "withheld", fetchedAt: "2026-07-19T12:00:00.000Z", cacheFreshUntil: "2026-07-19T12:05:00.000Z", freshUntil: "2026-07-19T12:05:00.000Z", authorization: "bearer", auth: "bearer", cache: "network" },
    evidence: {
      format: "chutes-tee-instance-evidence/v1", payloadDigest: KEY_DIGEST, quoteBytes: 2048, certificateBytes: 512, gpuDeviceCount: 1,
      quote: { format: "intel-tdx-quote-v4", base64: "", byteLength: 2048, version: 4, attestationKeyType: 2, teeType: "0x81", signatureDataLength: 1, reportDataHex: "" },
      gpu: { reportedEvidenceCount: 1, payloads: [] }, certificate: { format: "der", base64: "", byteLength: 512, binding: "not-established" },
    },
    binding: { construction: "SHA-256(UTF8(nonce + e2e_pubkey))", state: "matched", expectedDigestHex: "aa", quotedDigestHex: "aa", reportDataHex: "" },
    claims: {
      evidenceStructure: claim("present"), nonceFreshness: claim("matched"), endpointKey: claim("matched"), cpuTee: claim("unverified"), gpuTee: claim("unavailable"), runtimePolicy: claim("unavailable"), modelArtifact: claim("unavailable"), conversation: claim("unavailable"), request: claim("unavailable"), response: claim("unavailable"), payment: claim("unavailable"),
    },
    warnings: [],
  };
}
