import { describe, expect, it } from "vitest";
import type { ChutesEndpointEvidenceRecord } from "../attestation/provider-client";
import { createLocalReceipt, type ConversationReceipt } from "../receipts/types";
import {
  normalizeAttestationEvidence,
  serializePublicAttestationSummary,
} from "./attestations-model";
import { composeClaimStack } from "./claim-stack-model";

const CHECKED = "2026-07-18T12:00:00.000Z";
const CACHE_UNTIL = "2026-07-18T12:01:30.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
const MEASUREMENT = "b".repeat(96);

describe("attestation presentation model", () => {
  it("keeps structural, matched, and unverified endpoint evidence visibly partial", () => {
    const [record] = normalizeAttestationEvidence({ endpointRecords: [endpointRecord()] });
    expect(record).toBeDefined();
    expect(record!.dimensions.transport).toMatchObject({ state: "unavailable", qualifier: "unavailable" });
    expect(record!.dimensions.freshness).toMatchObject({ state: "partial", qualifier: "present" });
    expect(record!.dimensions["endpoint-key"]).toMatchObject({ state: "partial", qualifier: "matched" });
    expect(record!.dimensions["cpu-tee"]).toMatchObject({ state: "partial", qualifier: "unverified" });
    expect(record!.dimensions["gpu-tee"]).toMatchObject({ state: "partial", qualifier: "unverified" });
    expect(record!.dimensions.model).toMatchObject({
      state: "partial",
      qualifier: "runtime-policy-matched/model-unavailable",
      authorityKind: "local",
    });
    expect(record!.dimensions.model.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "MRTD", value: MEASUREMENT, kind: "measurement" }),
      expect.objectContaining({ label: "Published policy feed", value: DIGEST, kind: "digest" }),
    ]));
    expect(record!.dimensions.freshness.expiresAt).toBeUndefined();
    expect(record!.overallState).toBe("partial");
    expect(record!.dimensions.freshness.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Memory cache until · not evidence expiry", value: CACHE_UNTIL }),
    ]));
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record!.dimensions)).toBe(true);
    expect(Object.isFrozen(record!.dimensions.model.facts)).toBe(true);
  });

  it("identifies only the bundled Intel QVL and NVIDIA binding checks as local authorities", () => {
    const base = endpointRecord();
    const input: ChutesEndpointEvidenceRecord = {
      ...base,
      claims: {
        ...base.claims,
        cpuTee: claim(
          "verified",
          "Intel TDX authenticity",
          "The bundled QVL completed every required check.",
          "intel-dcap-qvl-wasm@dcap-qvl/0.5.2",
        ),
        gpuTee: claim(
          "matched",
          "NVIDIA GPU evidence binding",
          "The SPDM request nonce matched; full NVIDIA verification is separate.",
          "airship-nvidia-spdm-binding/v1",
        ),
        nonceFreshness: claim(
          "verified",
          "Nonce freshness",
          "A third-party plugin declared freshness.",
          "airship-untrusted-plugin",
        ),
      },
    };

    const [record] = normalizeAttestationEvidence({ endpointRecords: [input] });
    expect(record!.dimensions["cpu-tee"]).toMatchObject({
      state: "verified",
      authorityKind: "local",
    });
    expect(record!.dimensions["gpu-tee"]).toMatchObject({
      state: "partial",
      qualifier: "matched",
      authorityKind: "local",
    });
    expect(record!.dimensions.freshness).toMatchObject({
      state: "verified",
      authorityKind: "external",
    });
  });

  it("keeps every structurally typed conversation receipt assertion-only", () => {
    const receipt = attestedReceipt();
    const [record] = normalizeAttestationEvidence({ receipts: [receipt] });
    expect(record!.receiptTrust).toBe("asserted");
    expect(record!.dimensions.transport).toMatchObject({ state: "partial", qualifier: "asserted-verified", authorityKind: "none" });
    expect(record!.dimensions["endpoint-key"]).toMatchObject({ state: "partial", qualifier: "asserted-verified", authorityKind: "none" });
    expect(record!.dimensions.model).toMatchObject({ state: "partial", qualifier: "asserted-verified", authorityKind: "none" });
    expect(record!.dimensions.conversation).toMatchObject({ state: "partial", qualifier: "asserted-partial", authorityKind: "none" });
    expect(record!.overallState).toBe("partial");
    expect(record!.dimensions.model.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Artifact digest", value: DIGEST }),
      expect.objectContaining({ label: "MRTD", value: MEASUREMENT }),
    ]));
    expect(record!.dimensions.model.facts.some((fact) => fact.label.toLowerCase().includes("api"))).toBe(false);
    expect(record!.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Plaintext commitments", value: "Withheld by default; use salted or keyed selective disclosure" }),
    ]));
    expect(JSON.stringify(record!.bindings)).not.toContain(`sha256:${"c".repeat(64)}`);
    expect(JSON.stringify(record!.bindings)).not.toContain(`sha256:${"d".repeat(64)}`);
  });

  it("downgrades authority-free verification and does not treat a prefix as a local verifier", () => {
    const receipt = attestedReceipt();
    receipt.claims.encryption = {
      status: "verified",
      summary: "Declared verified without a verifier.",
      checkedAt: CHECKED,
    };
    receipt.claims.freshness = {
      status: "verified",
      summary: "A verifier name only resembles an Airship verifier.",
      verifier: "airship-untrusted-plugin",
      checkedAt: CHECKED,
    };
    const [record] = normalizeAttestationEvidence({ receipts: [receipt] });
    expect(record!.dimensions.transport).toMatchObject({
      state: "partial",
      qualifier: "asserted-verified",
      authorityKind: "none",
    });
    expect(record!.dimensions.freshness).toMatchObject({
      state: "partial",
      qualifier: "asserted-verified",
      authorityKind: "none",
    });
    expect(record!.dimensions.freshness.authority).toContain("Claimed verifier: airship-untrusted-plugin");
    expect(record!.receiptTrust).toBe("asserted");
    expect(record!.warnings.join(" ")).toContain("declares verified is shown as an assertion");
  });

  /*
   * One turn, one verdict, on both Proof tabs.
   *
   * `assertedState()` used to map every non-`unavailable` receipt claim to
   * `partial`, so a receipt that declared `cpuTee` failed read "Asserted" on
   * the Attestation evidence tab and "Failed" on Receipt & journal — the same
   * claim, one click apart. The ceiling now runs in one direction only, and
   * this asserts the two models agree claim for claim rather than asserting
   * one of them in isolation, which is how they drifted.
   */
  it("reads one verdict per claim on both Proof tabs, and never softens a declared failure", () => {
    const receipt = attestedReceipt();
    receipt.claims.cpuTee = { status: "failed", summary: "The Intel quote did not verify.", verifier: "external-dcap", checkedAt: CHECKED };
    receipt.claims.gpuTee = { status: "expired", summary: "The GPU evidence window closed.", checkedAt: CHECKED };
    const [record] = normalizeAttestationEvidence({ receipts: [receipt] });
    const stack = composeClaimStack(receipt, undefined, Date.parse(CHECKED));
    const dimensionOf = {
      encryption: "transport",
      freshness: "freshness",
      cpuTee: "cpu-tee",
      gpuTee: "gpu-tee",
      endpointKey: "endpoint-key",
      model: "model",
      conversation: "conversation",
      payment: "payment",
    } as const;

    expect(stack.items).toHaveLength(8);
    for (const item of stack.items) {
      const dimension = record!.dimensions[dimensionOf[item.key]];
      expect(dimension.state, `${item.key} state`).toBe(item.status);
      expect(dimension.qualifier, `${item.key} qualifier`).toBe(item.qualifier);
    }
    // The two states the old ceiling erased, named on the evidence tab.
    expect(record!.dimensions["cpu-tee"]).toMatchObject({ state: "failed", qualifier: "asserted-failed" });
    expect(record!.dimensions["gpu-tee"]).toMatchObject({ state: "expired", qualifier: "asserted-expired" });
    expect(stack.groups.failed.map((item) => item.key)).toEqual(["cpuTee", "gpuTee"]);
    expect(record!.overallState).toBe("failed");
    // A declared failure may not be described as an assertion in its own prose.
    expect(record!.dimensions["cpu-tee"].summary).not.toContain("assertion-only");
    expect(record!.dimensions["cpu-tee"].summary).toContain("keeps full weight");
    // And an unauthenticated declaration is still never hardened into a finding.
    expect(record!.dimensions.transport).toMatchObject({ state: "partial", qualifier: "asserted-verified" });
    expect(record!.dimensions.transport.summary).toContain("assertion-only");
  });

  it("keeps a declared failure at full weight in a receipt's own verification records", () => {
    const receipt = attestedReceipt();
    receipt.verifications = [{
      claim: "cpuTee",
      status: "failed",
      verifier: "external-dcap",
      version: "1",
      checkedAt: CHECKED,
      detail: "The quote signature chain did not validate.",
    }];
    const [record] = normalizeAttestationEvidence({ receipts: [receipt] });
    expect(record!.verifications[0]).toMatchObject({ state: "failed", qualifier: "asserted-failed" });
    expect(record!.verifications[0]!.summary).not.toContain("assertion-only");
  });

  it("exports an unsigned status summary and strips raw provider artifacts, plaintext digests, and secrets", () => {
    const receipt = attestedReceipt();
    receipt.model = "PROPRIETARY_MODEL_DO_NOT_EXPORT";
    receipt.instanceId = "person@example.test/private/instance";
    receipt.claims.cpuTee.summary = "PROPRIETARY_CLAIM_PROSE_DO_NOT_EXPORT";
    receipt.verifications[0]!.verifier = "PRIVATE_VERIFIER_ID_DO_NOT_EXPORT";
    receipt.verifications[0]!.detail = "PROPRIETARY_VERIFIER_DETAIL_DO_NOT_EXPORT";
    const json = serializePublicAttestationSummary(
      { endpointRecords: [endpointRecord()], receipts: [receipt] },
      "2026-07-18T13:00:00.000Z",
    );
    expect(JSON.parse(json)).toMatchObject({
      schema: "airship-public-attestation-status-summary/v1",
      exportedAt: "2026-07-18T13:00:00.000Z",
      records: expect.arrayContaining([
        expect.objectContaining({ source: "endpoint-evidence" }),
        expect.objectContaining({ source: "conversation-receipt", receiptTrust: "asserted" }),
      ]),
    });
    expect(json).toContain(DIGEST);
    expect(json).toContain(MEASUREMENT);
    expect(json).not.toContain("https://api.chutes.ai/chutes/chute-1/evidence");
    expect(json).not.toContain(`sha256:${"c".repeat(64)}`);
    expect(json).not.toContain(`sha256:${"d".repeat(64)}`);
    for (const forbidden of [
      "RAW_PUBLIC_KEY_MATERIAL",
      "RAW_NONCE_MATERIAL",
      "RAW_QUOTE_BASE64",
      "RAW_CERTIFICATE_BASE64",
      "RAW_GPU_PROVIDER_BODY",
      "RAW_RECEIPT_PROVIDER_BODY",
      "cpk_this-must-never-export",
      "csc_this-also-must-never-export",
      "PROPRIETARY_MODEL_DO_NOT_EXPORT",
      "person@example.test/private/instance",
      "PROPRIETARY_CLAIM_PROSE_DO_NOT_EXPORT",
      "PRIVATE_VERIFIER_ID_DO_NOT_EXPORT",
      "PROPRIETARY_VERIFIER_DETAIL_DO_NOT_EXPORT",
    ]) expect(json).not.toContain(forbidden);
    expect(json).not.toContain("[redacted secret]");
  });

  it("keeps duplicate source IDs selectable without mutating their public identity", () => {
    const left = endpointRecord();
    const right = { ...endpointRecord(), acquisition: { ...endpointRecord().acquisition, fetchedAt: "2026-07-18T12:05:00.000Z" } };
    const records = normalizeAttestationEvidence({ endpointRecords: [left, right] });
    expect(new Set(records.map((record) => record.id)).size).toBe(2);
    expect(records.map((record) => record.sourceId)).toEqual([left.recordId, left.recordId]);
    expect(records[0]!.createdAt).toBe("2026-07-18T12:05:00.000Z");
  });

  it("sorts newest endpoint records before applying the bounded presentation cap", () => {
    const inputs = Array.from({ length: 129 }, (_, index) => {
      const record = endpointRecord();
      return {
        ...record,
        recordId: `urn:airship:attestation:endpoint-${index}`,
        acquisition: {
          ...record.acquisition,
          fetchedAt: new Date(Date.parse(CHECKED) + index * 1_000).toISOString(),
        },
      };
    });
    const records = normalizeAttestationEvidence({ endpointRecords: inputs });
    expect(records).toHaveLength(128);
    expect(records[0]!.sourceId).toBe("urn:airship:attestation:endpoint-128");
    expect(records.some((record) => record.sourceId === "urn:airship:attestation:endpoint-0")).toBe(false);
  });

  it("rejects an oversized source page before copying or sorting it", () => {
    const oversized = Array.from({ length: 513 }, () => endpointRecord());
    expect(() => normalizeAttestationEvidence({ endpointRecords: oversized })).toThrow(
      "Attestation endpoint evidence page exceeds the 512-record client boundary.",
    );
  });
});

function endpointRecord(): ChutesEndpointEvidenceRecord {
  const claims: ChutesEndpointEvidenceRecord["claims"] = {
    evidenceStructure: claim("present", "Evidence structure", "Bounded evidence fields are structurally valid."),
    nonceFreshness: claim("present", "Nonce freshness", "A caller nonce was used; quote authenticity is separate."),
    endpointKey: claim("matched", "Endpoint key", "The endpoint digest matched locally.", "airship-structural-check/v1"),
    cpuTee: claim("unverified", "CPU TEE", "An Intel quote is present but DCAP was not performed."),
    gpuTee: claim("unverified", "GPU TEE", "Eight GPU evidence objects are present but not verified."),
    runtimePolicy: claim("matched", "Runtime policy", "Measurements match a provider-published policy.", "airship-structural-check/v1"),
    modelArtifact: claim("unavailable", "Model artifact", "No model artifact signature is present."),
    conversation: claim("unavailable", "Conversation", "No conversation signature is present."),
    request: claim("unavailable", "Request", "No request binding is present."),
    response: claim("unavailable", "Response", "No response binding is present."),
    payment: claim("unavailable", "Payment", "No payment signature is present."),
  };
  return {
    version: 1,
    recordId: "urn:airship:attestation:endpoint-1",
    provider: "chutes",
    kind: "endpoint-evidence",
    verdict: "evidence-only",
    subject: {
      scope: "endpoint",
      chuteId: "chute-1",
      instanceId: "instance-1",
      e2ePublicKey: "RAW_PUBLIC_KEY_MATERIAL",
      e2ePublicKeyDigest: DIGEST,
    },
    acquisition: {
      endpoint: "chute-evidence",
      requestUrl: "https://api.chutes.ai/chutes/chute-1/evidence?nonce=RAW_NONCE_MATERIAL",
      requestNonce: "RAW_NONCE_MATERIAL",
      fetchedAt: CHECKED,
      cacheFreshUntil: CACHE_UNTIL,
      freshUntil: CACHE_UNTIL,
      authorization: "public",
      auth: "public",
      cache: "network",
    },
    evidence: {
      format: "chutes-tee-instance-evidence/v1",
      payloadDigest: DIGEST,
      quoteBytes: 1024,
      certificateBytes: 512,
      gpuDeviceCount: 8,
      quote: {
        format: "intel-tdx-quote-v4",
        base64: "RAW_QUOTE_BASE64",
        byteLength: 1024,
        version: 4,
        attestationKeyType: 2,
        teeType: "0x81",
        signatureDataLength: 256,
        reportDataHex: "e".repeat(128),
      },
      gpu: {
        reportedEvidenceCount: 8,
        payloads: [{ raw: "RAW_GPU_PROVIDER_BODY" }],
      },
      certificate: {
        format: "der",
        base64: "RAW_CERTIFICATE_BASE64",
        byteLength: 512,
        binding: "not-established",
      },
    },
    binding: {
      construction: "SHA-256(UTF8(nonce + e2e_pubkey))",
      state: "matched",
      expectedDigestHex: "f".repeat(64),
      quotedDigestHex: "f".repeat(64),
      reportDataHex: "f".repeat(128),
    },
    publishedPolicy: {
      sourceUrl: "https://api.chutes.ai/servers/tee/measurements",
      fetchedAt: CHECKED,
      cache: "network",
      policyDigest: DIGEST,
      policyCount: 2,
      quoteMeasurements: { mrtd: MEASUREMENT, rtmr0: MEASUREMENT, rtmr1: MEASUREMENT, rtmr2: MEASUREMENT, rtmr3: MEASUREMENT },
      state: "matched",
      matches: [{ version: "1", name: "production", expectedGpus: ["H100"], gpuCount: 8 }],
    },
    claims,
    warnings: ["Credential cpk_this-must-never-export was not used for a public route."],
  };
}

function attestedReceipt(): ConversationReceipt {
  const receipt = createLocalReceipt({
    sessionId: "session-1",
    turnId: "turn-1",
    provider: "chutes",
    model: "example/Model-TEE",
    requestDigest: `sha256:${"c".repeat(64)}`,
    responseDigest: `sha256:${"d".repeat(64)}`,
    now: CHECKED,
  });
  receipt.proofLevel = "model-bound";
  receipt.posture = "encrypted-attested";
  receipt.instanceId = "instance-1";
  receipt.claims.encryption = { status: "verified", summary: "Application payload encryption was established.", verifier: "airship-client", checkedAt: CHECKED };
  receipt.claims.freshness = { status: "verified", summary: "Freshness was externally verified.", verifier: "external-dcap", checkedAt: CHECKED };
  receipt.claims.cpuTee = { status: "verified", summary: "Intel DCAP passed.", verifier: "external-dcap", checkedAt: CHECKED, policyDigest: DIGEST };
  receipt.claims.endpointKey = { status: "verified", summary: "The endpoint key is quote-bound.", verifier: "external-dcap+airship-local-binding", checkedAt: CHECKED, policyDigest: DIGEST };
  receipt.claims.model = {
    status: "verified",
    summary: "The model artifact matched the required policy.",
    verifier: "external-model-verifier",
    checkedAt: CHECKED,
    policyDigest: DIGEST,
    details: {
      artifactDigest: DIGEST,
      mrtd: MEASUREMENT,
      apiKey: "csc_this-also-must-never-export",
      arbitraryProviderBody: "RAW_RECEIPT_PROVIDER_BODY",
    },
  };
  receipt.evidence = {
    format: "chutes-tee-instance-evidence/v1",
    payload: { quote: "RAW_RECEIPT_PROVIDER_BODY", token: "csc_this-also-must-never-export" },
  };
  receipt.bindings.evidenceDigest = DIGEST;
  receipt.verifications.push({
    verifier: "external-dcap",
    version: "1",
    checkedAt: CHECKED,
    status: "verified",
    claim: "cpuTee",
    policyDigest: DIGEST,
    detail: "DCAP signature, TCB, debug, and policy checks passed.",
  });
  return receipt;
}

function claim(
  state: ChutesEndpointEvidenceRecord["claims"][keyof ChutesEndpointEvidenceRecord["claims"]]["state"],
  title: string,
  summary: string,
  verifier?: string,
) {
  return { state, title, summary, ...(verifier ? { verifier } : {}), checkedAt: CHECKED };
}
