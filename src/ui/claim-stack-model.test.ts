import { describe, expect, it } from "vitest";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import { createLocalReceipt } from "../receipts/types";
import { composeClaimStack } from "./claim-stack-model";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const KEY_DIGEST = `sha256:${"a".repeat(64)}`;

describe("claim-stack evidence composition", () => {
  it("joins matching fresh endpoint evidence without upgrading the immutable receipt", () => {
    const receipt = encryptedReceipt();
    const model = composeClaimStack(receipt, endpointRecord(), NOW);

    expect(model.evidence).toBe("matched");
    expect(model.groups.asserted.map((item) => item.key)).toEqual(expect.arrayContaining(["encryption", "freshness", "cpuTee", "endpointKey"]));
    expect(model.items.find((item) => item.key === "endpointKey")).toMatchObject({ source: "endpoint-evidence", status: "partial" });
    expect(model.items.find((item) => item.key === "conversation")).toMatchObject({ source: "turn-receipt", status: "partial" });
    expect(receipt.claims.endpointKey.status).toBe("unavailable");
  });

  it("does not compose stale evidence and collapses its hardware claims as unavailable", () => {
    const model = composeClaimStack(encryptedReceipt(), endpointRecord(), Date.parse("2026-07-19T12:06:00.000Z"));
    expect(model.evidence).toBe("stale");
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

function encryptedReceipt() {
  const receipt = createLocalReceipt({ sessionId: "session-1", turnId: "turn-1", provider: "chutes-e2ee-v1", model: "model-1" });
  receipt.instanceId = "instance-1";
  receipt.posture = "encrypted-unattested";
  receipt.proofLevel = "encrypted";
  receipt.bindings.endpointKeyDigest = KEY_DIGEST;
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
