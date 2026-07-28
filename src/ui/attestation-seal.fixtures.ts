/*
 * Fixtures for the session attestation seal, shared by two guards.
 *
 * `attestation-seal.test.ts` pins what each branch of the reducer says;
 * `trust-language.test.ts` pins that the reducer never reaches the `asserted`
 * rung without a receipt, and needs the same receipt-bearing record to prove it
 * is not passing by having emptied the word out. Test-only: no surface imports
 * this module, so it is not shipped.
 */
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import { createLocalReceipt, type ConversationReceipt } from "../receipts/types";

export const ATTESTATION_FIXTURE_KEY_DIGEST = `sha256:${"a".repeat(64)}`;

/** An encrypted, unattested receipt that carries an endpoint-key digest. */
export function encryptedReceiptFixture(): ConversationReceipt {
  const receipt = createLocalReceipt({
    sessionId: "session-1",
    turnId: "turn-1",
    provider: "chutes-e2ee-v1",
    model: "model-1",
  });
  receipt.instanceId = "instance-1";
  receipt.posture = "encrypted-unattested";
  receipt.proofLevel = "encrypted";
  receipt.bindings.endpointKeyDigest = ATTESTATION_FIXTURE_KEY_DIGEST;
  return receipt;
}

/** A current endpoint record whose challenge and key both matched locally. */
export function endpointRecordFixture(): ChutesEndpointEvidenceRecord {
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
      e2ePublicKeyDigest: ATTESTATION_FIXTURE_KEY_DIGEST,
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
      payloadDigest: ATTESTATION_FIXTURE_KEY_DIGEST,
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
