import { describe, expect, it } from "vitest";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import { createLocalReceipt } from "../receipts/types";
import { claimStackPopoverFacts } from "./claim-stack-facts";
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
    expect(facts.find((fact) => fact.label === "Issuer")?.value).toBe("Not established");
    expect(facts.find((fact) => fact.label === "Checked")?.value).toBe("Never");
    expect(facts).toHaveLength(3);
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
