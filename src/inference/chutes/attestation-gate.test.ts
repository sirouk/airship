import { describe, expect, it, vi } from "vitest";
import { AttestationEvidenceClientError, type ChutesAttestationEvidenceClient } from "../../attestation/provider-client";
import type { AttestationClaimState, ChutesEndpointEvidenceRecord } from "../../attestation/provider-types";
import { createChutesAttestationGateFromClient } from "./attestation-gate";
import type { AttestationSubject } from "./attestation";

const CHECKED = "2026-07-19T12:00:00.000Z";
const SUBJECT: AttestationSubject = {
  provider: "chutes",
  chuteId: "chute-1",
  instanceId: "instance-1",
  e2ePublicKey: "endpoint-key-1",
};

describe("Chutes invocation attestation gate", () => {
  it("preserves bounded partial and failed evaluation without promoting proof", async () => {
    const get = vi.fn(async () => endpointRecord({ cpu: "unverified", gpu: "failed" }));
    const gate = createChutesAttestationGateFromClient({ get } as Pick<ChutesAttestationEvidenceClient, "get">);

    const result = await gate.verifyEndpoint(SUBJECT, new AbortController().signal);

    expect(result.receipt).toBeUndefined();
    expect(result.evaluation).toMatchObject({
      freshness: { status: "partial" },
      endpointKey: { status: "partial" },
      cpuTee: { status: "partial" },
      gpuTee: { status: "failed" },
      runtimePolicy: { status: "partial", policyDigest: "sha256:policy" },
      evidenceDigest: "sha256:evidence",
      evidenceFormat: "chutes-tee-instance-evidence/v1",
    });
    expect(JSON.stringify(result)).not.toContain("RAW_QUOTE");
    expect(JSON.stringify(result)).not.toContain(SUBJECT.e2ePublicKey);
  });

  it("falls back from forbidden exact-instance evidence to the public chute route", async () => {
    const get = vi.fn(async (options: { route?: string }) => {
      if (options.route === "instance") {
        throw new AttestationEvidenceClientError("forbidden", "Instance evidence access denied.", { status: 403 });
      }
      return endpointRecord({ cpu: "verified" });
    });
    const gate = createChutesAttestationGateFromClient(
      { get } as Pick<ChutesAttestationEvidenceClient, "get">,
      () => Date.parse(CHECKED),
    );

    const result = await gate.verifyEndpoint(SUBJECT, new AbortController().signal);

    expect(get.mock.calls.map(([options]) => options.route)).toEqual(["instance", "public-chute"]);
    expect(result.receipt).toMatchObject({
      status: "verified",
      chuteId: SUBJECT.chuteId,
      instanceId: SUBJECT.instanceId,
      e2ePublicKey: SUBJECT.e2ePublicKey,
    });
  });

  it("never substitutes another public evidence instance or key", async () => {
    const get = vi.fn(async (options: { route?: string }) => {
      if (options.route === "instance") {
        throw new AttestationEvidenceClientError("unauthorized", "Authentication expired.", { status: 401 });
      }
      return endpointRecord({ cpu: "verified", instanceId: "instance-other", e2ePublicKey: "other-key" });
    });
    const gate = createChutesAttestationGateFromClient({ get } as Pick<ChutesAttestationEvidenceClient, "get">);

    const result = await gate.verifyEndpoint(SUBJECT, new AbortController().signal);

    expect(result.receipt).toBeUndefined();
    expect(result.evaluation).toBeUndefined();
    expect(result.unavailableReason).toContain("exact authenticated discovery instance and key");
  });
});

function endpointRecord(options: {
  cpu: AttestationClaimState;
  gpu?: AttestationClaimState;
  instanceId?: string;
  e2ePublicKey?: string;
}): ChutesEndpointEvidenceRecord {
  const claim = (state: AttestationClaimState, verifier?: string) => ({
    state,
    title: "fixture",
    summary: `Fixture ${state} result.`,
    ...(verifier ? { verifier } : {}),
    checkedAt: CHECKED,
  });
  return {
    version: 1,
    recordId: "urn:airship:attestation:fixture",
    provider: "chutes",
    kind: "endpoint-evidence",
    verdict: "evidence-only",
    subject: {
      scope: "endpoint",
      chuteId: SUBJECT.chuteId,
      instanceId: options.instanceId ?? SUBJECT.instanceId,
      e2ePublicKey: options.e2ePublicKey ?? SUBJECT.e2ePublicKey,
      e2ePublicKeyDigest: "sha256:key",
    },
    acquisition: {
      endpoint: "instance-evidence",
      requestUrl: "https://api.chutes.ai/fixture",
      requestNonce: "withheld",
      fetchedAt: CHECKED,
      cacheFreshUntil: "2026-07-19T12:05:00.000Z",
      freshUntil: "2026-07-19T12:05:00.000Z",
      authorization: "bearer",
      auth: "bearer",
      cache: "network",
    },
    evidence: {
      format: "chutes-tee-instance-evidence/v1",
      payloadDigest: "sha256:evidence",
      quoteBytes: 1024,
      certificateBytes: 512,
      gpuDeviceCount: 1,
      quote: { format: "intel-tdx-quote-v4", base64: "RAW_QUOTE", byteLength: 1024, version: 4, attestationKeyType: 2, teeType: "0x81", signatureDataLength: 1, reportDataHex: "RAW_REPORT_DATA" },
      gpu: { reportedEvidenceCount: 1, payloads: [{ raw: "RAW_GPU" }] },
      certificate: { format: "der", base64: "RAW_CERT", byteLength: 512, binding: "not-established" },
    },
    binding: { construction: "SHA-256(UTF8(nonce + e2e_pubkey))", state: "matched", expectedDigestHex: "", quotedDigestHex: "", reportDataHex: "" },
    publishedPolicy: {
      sourceUrl: "https://api.chutes.ai/policy",
      fetchedAt: CHECKED,
      cache: "network",
      policyDigest: "sha256:policy",
      policyCount: 1,
      quoteMeasurements: { mrtd: "", rtmr0: "", rtmr1: "", rtmr2: "", rtmr3: "" },
      state: "matched",
      matches: [],
    },
    claims: {
      evidenceStructure: claim("present", "airship-structural-check/v1"),
      nonceFreshness: claim("matched", "airship-structural-check/v1"),
      endpointKey: claim("matched", "airship-structural-check/v1"),
      cpuTee: claim(options.cpu, "intel-dcap-webcrypto/v1"),
      gpuTee: claim(options.gpu ?? "unavailable", "nvidia-gpu-webcrypto/v1"),
      runtimePolicy: claim("matched", "airship-structural-check/v1"),
      modelArtifact: claim("unavailable"),
      conversation: claim("unavailable"),
      request: claim("unavailable"),
      response: claim("unavailable"),
      payment: claim("unavailable"),
    },
    warnings: [],
  };
}
