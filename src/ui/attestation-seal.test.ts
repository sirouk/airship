import { describe, expect, it } from "vitest";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import { createLocalReceipt } from "../receipts/types";
import { describeAttestationSeal } from "./app";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const KEY_DIGEST = `sha256:${"a".repeat(64)}`;

describe("session attestation seal", () => {
  it("labels post-turn endpoint evidence as a separate local match without upgrading the receipt", () => {
    const receipt = encryptedReceipt();
    const seal = describeAttestationSeal({
      connected: true,
      receipt,
      records: [endpointRecord()],
      now: NOW,
    });

    expect(receipt.claims.endpointKey.status).toBe("unavailable");
    expect(receipt.claims.freshness.status).toBe("unavailable");
    expect(seal).toMatchObject({ state: "asserted", label: "Local key match" });
    expect(seal.detail).toContain("separate current endpoint record");
    expect(seal.detail).toContain("does not upgrade this immutable turn receipt");
  });

  it("does not infer a key match from subject correlation alone", () => {
    const record = endpointRecord();
    const seal = describeAttestationSeal({
      connected: true,
      receipt: encryptedReceipt(),
      records: [{
        ...record,
        claims: {
          ...record.claims,
          endpointKey: { ...record.claims.endpointKey, state: "unavailable" },
        },
      }],
      now: NOW,
    });

    expect(seal).toMatchObject({ state: "attention", label: "Separate evidence collected" });
    expect(seal.detail).toContain("did not establish both");
  });
});

function encryptedReceipt() {
  const receipt = createLocalReceipt({
    sessionId: "session-1",
    turnId: "turn-1",
    provider: "chutes-e2ee-v1",
    model: "model-1",
  });
  receipt.instanceId = "instance-1";
  receipt.posture = "encrypted-unattested";
  receipt.proofLevel = "encrypted";
  receipt.bindings.endpointKeyDigest = KEY_DIGEST;
  return receipt;
}

function endpointRecord(): ChutesEndpointEvidenceRecord {
  const claim = (state: ChutesEndpointEvidenceRecord["claims"][keyof ChutesEndpointEvidenceRecord["claims"]]["state"]) => ({
    state,
    title: "fixture",
    summary: "fixture",
    checkedAt: "2026-07-19T12:00:00.000Z",
  });
  return {
    version: 1,
    recordId: "urn:airship:attestation:fixture",
    provider: "chutes",
    kind: "endpoint-evidence",
    verdict: "evidence-only",
    subject: {
      scope: "endpoint",
      chuteId: "chute-1",
      instanceId: "instance-1",
      e2ePublicKey: "",
      e2ePublicKeyDigest: KEY_DIGEST,
    },
    acquisition: {
      endpoint: "instance-evidence",
      requestUrl: "https://api.chutes.ai/fixture",
      requestNonce: "",
      fetchedAt: "2026-07-19T12:00:00.000Z",
      cacheFreshUntil: "2026-07-19T12:05:00.000Z",
      freshUntil: "2026-07-19T12:05:00.000Z",
      authorization: "bearer",
      auth: "bearer",
      cache: "network",
    },
    evidence: {
      format: "chutes-tee-instance-evidence/v1",
      payloadDigest: KEY_DIGEST,
      quoteBytes: 1,
      certificateBytes: 1,
      gpuDeviceCount: 0,
      quote: { format: "intel-tdx-quote-v4", base64: "", byteLength: 1, version: 4, attestationKeyType: 2, teeType: "0x81", signatureDataLength: 1, reportDataHex: "" },
      gpu: { reportedEvidenceCount: 0, payloads: [] },
      certificate: { format: "der", base64: "", byteLength: 1, binding: "not-established" },
    },
    binding: { construction: "SHA-256(UTF8(nonce + e2e_pubkey))", state: "matched", expectedDigestHex: "", quotedDigestHex: "", reportDataHex: "" },
    claims: {
      evidenceStructure: claim("present"),
      nonceFreshness: claim("matched"),
      endpointKey: claim("matched"),
      cpuTee: claim("unverified"),
      gpuTee: claim("unavailable"),
      runtimePolicy: claim("unavailable"),
      modelArtifact: claim("unavailable"),
      conversation: claim("unavailable"),
      request: claim("unavailable"),
      response: claim("unavailable"),
      payment: claim("unavailable"),
    },
    warnings: [],
  };
}
