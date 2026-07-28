import { describe, expect, it } from "vitest";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import { createLocalReceipt } from "../receipts/types";
import { claimCeiling, claimQualifierLabel, claimStackPopoverFacts, readClaimQualifier, CLAIM_STATE_LEGEND } from "./claim-stack-facts";
import { composeClaimStack } from "./claim-stack-model";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const KEY_DIGEST = `sha256:${"a".repeat(64)}`;

describe("claim-stack popover rows", () => {
  it("expands a claim into issuer, scope, age and its own evidence facts", () => {
    // Rung L1 of the disclosure ladder promises the whole claim behind one
    // gesture. Composing the row set once is what stops two popovers of the
    // same claim showing different fields.
    const model = composeClaimStack(encryptedReceipt(), endpointRecord(), NOW);
    const endpointKey = model.items.find((item) => item.key === "endpointKey")!;
    const facts = claimStackPopoverFacts(endpointKey);

    expect(facts.slice(0, 3).map((fact) => fact.label)).toEqual(["Issuer", "Scope", "Checked"]);
    expect(facts.find((fact) => fact.label === "Scope")?.value).toBe("Endpoint evidence");
    expect(facts.find((fact) => fact.label === "Key digest")?.value).toBe(KEY_DIGEST);
    expect(Object.isFrozen(facts)).toBe(true);
  });

  it("says a claim has no issuer rather than rendering an empty field", () => {
    // An unlabelled blank on a proof surface reads as "nothing to see"; the
    // honest reading is that nobody has asserted this yet.
    const facts = claimStackPopoverFacts(composeClaimStack(undefined, undefined, NOW).items[0]!);
    // "Not established" is retired as a value word: the claim rail counted
    // "7 established" to mean recorded while the metric beside it said "Not
    // established" to mean unproven, 183px apart in one viewport.
    expect(facts.find((fact) => fact.label === "Issuer")?.value).toBe("None recorded");
    expect(facts.find((fact) => fact.label === "Checked")?.value).toBe("Never");
    expect(facts).toHaveLength(3);
    expect(facts.some((fact) => fact.value.includes("established"))).toBe(false);
  });

  it("names the ceiling on the row it capped, and only there", () => {
    // A capped claim must say what capped it. An uncapped one must not carry a
    // boilerplate row, or the one that matters reads as furniture.
    const receipt = encryptedReceipt();
    receipt.claims.cpuTee = { status: "verified", summary: "Receipt declares a verified CPU TEE.", verifier: "chutes" };
    const model = composeClaimStack(receipt, undefined, NOW);
    const capped = claimStackPopoverFacts(model.items.find((item) => item.key === "cpuTee")!);
    expect(claimCeiling(model.items.find((item) => item.key === "cpuTee")!)).toBe("receipt-integrity");
    expect(claimCeiling(model.items.find((item) => item.key === "payment")!)).toBeUndefined();
    const uncapped = claimStackPopoverFacts(model.items.find((item) => item.key === "payment")!);

    expect(capped.find((fact) => fact.label === "Declared")?.value)
      .toBe("Verified · capped by receipt integrity not authenticated");
    expect(uncapped.some((fact) => fact.label === "Declared")).toBe(false);
  });

  it("returns only the delta so a status word is never printed twice", () => {
    // The shipped inspector rendered "ASSERTED · ASSERTED PARTIAL · RECEIPT
    // UNAUTHENTICATED" because the qualifier re-prefixed the status word the
    // line already began with.
    expect(claimQualifierLabel("asserted-verified"))
      .toBe("record declares verified · receipt integrity not authenticated");
    expect(claimQualifierLabel("asserted-verified", { ceilingStatedElsewhere: true }))
      .toBe("record declares verified");
    expect(claimQualifierLabel("asserted-unavailable")).toBeUndefined();
    for (const qualifier of ["asserted-verified", "verified-without-authority", "matched", "present", "unverified"]) {
      expect(claimQualifierLabel(qualifier)?.toLowerCase()).not.toContain("asserted");
    }
  });

  it("keeps the two ceilings separate and never speaks of signatures", () => {
    // Nothing in Airship checks a signature. Copy saying a receipt "is not
    // signed by a trusted authority" would assert a mechanism the product does
    // not implement, to explain a contradiction caused by overclaiming.
    expect(readClaimQualifier("asserted-verified").ceiling).toBe("receipt-integrity");
    expect(readClaimQualifier("verified-without-authority").ceiling).toBe("authority");
    expect(readClaimQualifier("matched").ceiling).toBeUndefined();
    expect(claimQualifierLabel("verified-without-authority")).not.toContain("sign");
  });

  it("publishes a legend containing exactly the three emitted state words", () => {
    expect(CLAIM_STATE_LEGEND.map((entry) => entry.word)).toEqual(["Verified", "Asserted", "No evidence"]);
    expect(CLAIM_STATE_LEGEND.every((entry) => entry.meaning.length > 30)).toBe(true);
  });

  it("distinguishes a turn receipt's own assertion from separately fetched endpoint evidence", () => {
    // The two are different authorities, and the popover is the surface where
    // conflating them would be easiest and worst.
    const model = composeClaimStack(encryptedReceipt(), endpointRecord(), NOW);
    const scopes = model.items.map((item) => claimStackPopoverFacts(item).find((fact) => fact.label === "Scope")?.value);
    expect(new Set(scopes)).toEqual(new Set(["Turn receipt", "Endpoint evidence"]));
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
