import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import { createLocalReceipt } from "../receipts/types";
import { describeAttestationSeal } from "./app";
import { TURN_EVIDENCE_COPY } from "./turn-evidence";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const KEY_DIGEST = `sha256:${"a".repeat(64)}`;

describe("session attestation seal", () => {
  it("distinguishes strict and record-only policies from actual endpoint evidence", () => {
    expect(describeAttestationSeal({ connected: true, proofPolicy: "strict", records: [], now: NOW })).toEqual({
      state: "asserted",
      label: "Proof required next turn",
      detail: "The fail-closed endpoint-proof policy is armed, but no active turn receipt currently establishes a hardware claim.",
    });
    expect(describeAttestationSeal({ connected: true, proofPolicy: "record", records: [], now: NOW })).toEqual({
      state: "asserted",
      label: "Evidence checked per turn",
      detail: "Verify & record will collect fresh endpoint evidence on the next turn and keep every incomplete claim explicit without blocking encrypted inference.",
    });
  });

  it("states the disconnected fallback in plain language without inventing a provider", () => {
    const seal = describeAttestationSeal({ connected: false, records: [], now: NOW });
    expect(seal.state).toBe("none");
    expect(seal.label).toBe("Secure hardware not checked");
    // P11: the acronym is allowed in the expansion, never in the primary label.
    expect(seal.label).not.toContain("TEE");
    expect(seal.detail).toContain("TEE");
    // There is no demo provider in this product; the old copy asserted one.
    expect(seal.detail).not.toContain("Demo");
  });

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

  /*
   * The session band and the turn band used to be two functions with the same
   * five branches and different words for each, so one turn read "Evidence
   * unavailable" in the session bar and "Evidence not pulled" under its own
   * answer. They share one describer now; this is what stops them drifting
   * apart again.
   */
  it("speaks an acquisition failure in the canonical word, with the reason kept verbatim", () => {
    const seal = describeAttestationSeal({
      connected: true,
      records: [],
      failure: { label: "Evidence unavailable", code: "evidence-unavailable" } as never,
      now: NOW,
    });

    expect(seal.label).toBe(TURN_EVIDENCE_COPY["evidence-blocked"].chip);
    expect(seal.state).toBe(TURN_EVIDENCE_COPY["evidence-blocked"].seal);
    // The specific reason is not deleted by the canonical headline; it leads
    // the sentence, which is visible body text in the session status popover.
    expect(seal.detail).toContain("Evidence unavailable");
    expect(seal.detail).toContain("This provider/acquisition state is not a TEE verdict.");
  });

  it("keeps the one branch that genuinely differs by scope, and only that one", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");

    // A live session has a *next* turn its policy can speak about; a settled
    // receipt does not. Every other branch is shared, so the two bands cannot
    // describe the same endpoint record in two vocabularies.
    expect(source).toContain('if (args.scope === "turn") {');
    expect(source.match(/args\.scope === "turn"/gu)?.length).toBe(1);
    expect(source).toContain('describeEndpointEvidence({ ...args, scope: "session" })');
    expect(source).toContain('describeEndpointEvidence({ scope: "turn", receipt, records, failure, now })');
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
