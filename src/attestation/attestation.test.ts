import { describe, expect, test, vi } from "vitest";
import { sha256 } from "../core/hash";
import { createLocalReceipt } from "../receipts/types";
import {
  attestChutesInstance,
  checkChutesReportDataBinding,
  fetchChutesInstanceEvidence,
  generateAttestationNonce,
  parseTdxQuoteV4,
  serializePortableReceipt,
  type AttestationVerifierPorts,
  type DcapVerificationResult,
} from "./index";
import { bytesToBase64, hexToBytes, sha256Hex } from "./encoding";
import { TDX_QUOTE_PREFIX_BYTES, TDX_REPORT_DATA_OFFSET, TDX_SIGNATURE_LENGTH_OFFSET } from "./tdx";

const INSTANCE_ID = "instance-1";
const API_KEY = "test-api-key-never-export";
const CHECKED_AT = "2026-07-18T12:00:00.000Z";
const DETERMINISTIC_NONCE = Array.from({ length: 32 }, (_, index) =>
  index.toString(16).padStart(2, "0"),
).join("");
const E2E_PUBLIC_KEY = bytesToBase64(
  Uint8Array.from({ length: 1184 }, (_, index) => index % 251),
);
const CERTIFICATE = bytesToBase64(Uint8Array.of(0x30, 0x00));

describe("Chutes evidence client", () => {
  test("generates a fresh 32-byte lowercase-hex nonce", () => {
    let invocation = 0;
    const randomValues = (target: Uint8Array) => {
      target.fill(invocation);
      invocation += 1;
    };
    expect(generateAttestationNonce(randomValues)).toBe("00".repeat(32));
    expect(generateAttestationNonce(randomValues)).toBe("01".repeat(32));
  });

  test("calls the exact instance evidence endpoint with bounded validated output", async () => {
    const quote = await buildQuote(DETERMINISTIC_NONCE, E2E_PUBLIC_KEY);
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse(evidenceBody(quote));
    });

    const result = await fetchChutesInstanceEvidence({
      apiKey: ` ${API_KEY} `,
      instanceId: INSTANCE_ID,
      fetchImpl,
      randomValues: deterministicRandom,
      now: () => CHECKED_AT,
    });

    expect(capturedUrl).toBe(
      `https://api.chutes.ai/instances/${INSTANCE_ID}/evidence?nonce=${DETERMINISTIC_NONCE}`,
    );
    expect(capturedInit?.method).toBe("GET");
    expect(capturedInit?.credentials).toBe("omit");
    expect(capturedInit?.redirect).toBe("error");
    expect(capturedInit?.headers).toEqual({
      Accept: "application/json",
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(result.nonce).toBe(DETERMINISTIC_NONCE);
    expect(result.fetchedAt).toBe(CHECKED_AT);
    expect(result.evidence.instanceId).toBe(INSTANCE_ID);
    expect(result.evidence.reportedInstanceId).toBe(INSTANCE_ID);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  test("rejects oversized bodies before accepting evidence", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      jsonResponse({ padding: "x".repeat(128) }),
    );
    await expect(
      fetchChutesInstanceEvidence({
        apiKey: API_KEY,
        instanceId: INSTANCE_ID,
        fetchImpl,
        maxResponseBytes: 64,
        randomValues: deterministicRandom,
      }),
    ).rejects.toMatchObject({ code: "response-too-large" });
  });

  test("rejects unknown response fields and mismatched instance IDs", async () => {
    const quote = await buildQuote(DETERMINISTIC_NONCE, E2E_PUBLIC_KEY);
    const withUnknown = { ...evidenceBody(quote), surprise: true };
    await expect(
      fetchChutesInstanceEvidence({
        apiKey: API_KEY,
        instanceId: INSTANCE_ID,
        fetchImpl: vi.fn(async () => jsonResponse(withUnknown)),
        randomValues: deterministicRandom,
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });

    const mismatch = { ...evidenceBody(quote), instance_id: "other-instance" };
    await expect(
      fetchChutesInstanceEvidence({
        apiKey: API_KEY,
        instanceId: INSTANCE_ID,
        fetchImpl: vi.fn(async () => jsonResponse(mismatch)),
        randomValues: deterministicRandom,
      }),
    ).rejects.toThrow("does not match the requested instance");
  });
});

describe("Intel TDX local report_data parsing", () => {
  test("matches only the documented SHA256(nonce + e2e_pubkey) binding", async () => {
    const quote = await buildQuote(DETERMINISTIC_NONCE, E2E_PUBLIC_KEY);
    const result = await checkChutesReportDataBinding({
      quoteBase64: quote,
      nonce: DETERMINISTIC_NONCE,
      e2ePublicKey: E2E_PUBLIC_KEY,
    });
    expect(result.matched).toBe(true);
    expect(result.quotedDigestHex).toBe(result.expectedDigestHex);
    expect(result.reportDataHex).toBe(`${result.expectedDigestHex}${"00".repeat(32)}`);
    expect(result.quote.version).toBe(4);
    expect(result.quote.teeType).toBe(0x81);

    const changedNonce = `${DETERMINISTIC_NONCE.slice(0, -2)}ff`;
    const mismatch = await checkChutesReportDataBinding({
      quoteBase64: quote,
      nonce: changedNonce,
      e2ePublicKey: E2E_PUBLIC_KEY,
    });
    expect(mismatch.matched).toBe(false);
  });

  test("normalizes quote v5 and fails closed for unsupported versions and inconsistent lengths", async () => {
    const quote = await buildQuote(DETERMINISTIC_NONCE, E2E_PUBLIC_KEY);
    const wrongVersion = decodeBase64(quote);
    new DataView(wrongVersion.buffer).setUint16(0, 6, true);
    expect(() => parseTdxQuoteV4(bytesToBase64(wrongVersion))).toThrow("unsupported TDX quote version");

    const quoteV5 = await buildQuote(DETERMINISTIC_NONCE, E2E_PUBLIC_KEY, { version: 5 });
    const parsedV5 = parseTdxQuoteV4(quoteV5);
    expect(parsedV5).toMatchObject({
      version: 5,
      bodyType: 2,
      reportBodyOffset: 54,
      reportBodyLength: 584,
    });
    expect(parsedV5.reportDataHex).toBe(`${await sha256Hex(`${DETERMINISTIC_NONCE}${E2E_PUBLIC_KEY}`)}${"00".repeat(32)}`);

    const keyType3 = parseTdxQuoteV4(await buildQuote(DETERMINISTIC_NONCE, E2E_PUBLIC_KEY, { attestationKeyType: 3 }));
    expect(keyType3.attestationKeyType).toBe(3);

    const wrongLength = decodeBase64(quote);
    new DataView(wrongLength.buffer).setUint32(TDX_SIGNATURE_LENGTH_OFFSET, 32, true);
    expect(() => parseTdxQuoteV4(bytesToBase64(wrongLength))).toThrow(
      "truncated before its signature data",
    );
  });
});

describe("attestation receipts", () => {
  test("refuses to upgrade evidence without the invocation-time instance and endpoint-key digest", async () => {
    const baseReceipt = await encryptedReceipt();
    baseReceipt.bindings.endpointKeyDigest = undefined;
    const fetchImpl: typeof fetch = vi.fn(async () => jsonResponse(evidenceBody("unused")));
    await expect(attestChutesInstance({
      apiKey: API_KEY,
      baseReceipt,
      e2ePublicKey: E2E_PUBLIC_KEY,
      instanceId: INSTANCE_ID,
      fetchImpl,
      randomValues: deterministicRandom,
    })).rejects.toThrow("does not pin an endpoint public-key digest");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("default portable receipts omit raw evidence, claim details, and credential-shaped text", async () => {
    const receipt = await encryptedReceipt();
    receipt.claims.encryption.summary = "transport used cak_supersecretvalue";
    receipt.claims.encryption.details = { token: "cpk_anothersecretvalue" };
    receipt.evidence = {
      format: "test/raw-evidence",
      payload: { quote: "raw-quote", certificate: "raw-certificate", bearer: "Bearer csc_secretsecret" },
    };
    const serialized = serializePortableReceipt(receipt);
    expect(serialized).not.toContain("raw-quote");
    expect(serialized).not.toContain("raw-certificate");
    expect(serialized).not.toContain("supersecretvalue");
    expect(serialized).not.toContain("anothersecretvalue");
    expect(serialized).not.toContain("secretsecret");
    expect(serialized).not.toContain("details");
    expect(serialized).not.toContain("sha256:request");
    expect(serialized).not.toContain("sha256:response");
    expect(JSON.parse(serialized)).toMatchObject({
      evidence: { format: "test/raw-evidence", payload: { rawEvidence: "omitted-by-default" } },
    });
  });

  test("does not promote a locally matched binding to an attested endpoint", async () => {
    const baseReceipt = await encryptedReceipt();
    const result = await runAttestation(baseReceipt);

    expect(result.receipt.claims.endpointKey.status).toBe("partial");
    expect(result.receipt.claims.freshness.status).toBe("partial");
    expect(result.receipt.claims.cpuTee.status).toBe("unavailable");
    expect(result.receipt.claims.gpuTee.status).toBe("unavailable");
    expect(result.receipt.claims.model.status).toBe("unavailable");
    expect(result.receipt.claims.conversation.status).toBe("partial");
    expect(result.receipt.claims.payment.status).toBe("unavailable");
    expect(result.receipt.proofLevel).toBe("encrypted");
    expect(result.receipt.posture).toBe("encrypted-unattested");
    expect(badgeState(result, "evidence-fetched")).toBe("present");
    expect(badgeState(result, "key-binding-checked")).toBe("matched");
    expect(badgeState(result, "intel-dcap")).toBe("unavailable");
    expect(result.portableJson).not.toContain(API_KEY);
    expect(JSON.parse(result.portableJson)).toMatchObject({ version: 1, instanceId: INSTANCE_ID });
  });

  test("promotes the endpoint only after strict DCAP signature, TCB, debug, and policy success", async () => {
    const result = await runAttestation(await encryptedReceipt(), {
      dcap: {
        id: "test-dcap",
        version: "1",
        async verify() {
          return verifiedDcap();
        },
      },
    });

    expect(result.receipt.claims.cpuTee.status).toBe("verified");
    expect(result.receipt.claims.endpointKey.status).toBe("verified");
    expect(result.receipt.claims.freshness.status).toBe("verified");
    expect(result.receipt.proofLevel).toBe("attested-endpoint");
    expect(result.receipt.posture).toBe("encrypted-attested");
    expect(badgeState(result, "key-binding-checked")).toBe("matched");
    expect(badgeState(result, "intel-dcap")).toBe("verified");
    expect(badgeState(result, "transcript-signed")).toBe("unavailable");
  });

  test("never promotes an authenticated quote whose endpoint-key binding mismatches", async () => {
    const baseReceipt = await encryptedReceipt();
    const result = await attestChutesInstance({
      apiKey: API_KEY,
      baseReceipt,
      e2ePublicKey: E2E_PUBLIC_KEY,
      instanceId: INSTANCE_ID,
      fetchImpl: vi.fn(async () => {
        const wrongNonce = "ff".repeat(32);
        return jsonResponse(evidenceBody(await buildQuote(wrongNonce, E2E_PUBLIC_KEY)));
      }),
      randomValues: deterministicRandom,
      verifiers: {
        dcap: {
          id: "test-dcap",
          version: "1",
          async verify() {
            return verifiedDcap();
          },
        },
      },
      now: () => CHECKED_AT,
    });

    expect(result.receipt.claims.cpuTee.status).toBe("verified");
    expect(result.receipt.claims.endpointKey.status).toBe("failed");
    expect(result.receipt.claims.freshness.status).toBe("failed");
    expect(result.receipt.proofLevel).toBe("encrypted");
    expect(result.receipt.posture).toBe("encrypted-unattested");
    expect(badgeState(result, "key-binding-checked")).toBe("failed");
    expect(badgeState(result, "intel-dcap")).toBe("verified");
  });

  test("fails closed when a DCAP port claims success without every required check", async () => {
    const incomplete = {
      status: "verified",
      summary: "not enough",
      signatureVerified: true,
      tcbVerified: true,
      policyVerified: false,
      debugDisabled: true,
      policyDigest: "sha256:policy",
    } as unknown as DcapVerificationResult;
    const result = await runAttestation(await encryptedReceipt(), {
      dcap: {
        id: "bad-dcap",
        version: "1",
        async verify() {
          return incomplete;
        },
      },
    });

    expect(result.receipt.claims.cpuTee.status).toBe("failed");
    expect(result.receipt.claims.endpointKey.status).toBe("failed");
    expect(result.receipt.proofLevel).toBe("encrypted");
    expect(result.receipt.posture).toBe("encrypted-unattested");
  });

  test("keeps model, transcript, and payment as distinct proofs before reaching settled", async () => {
    const result = await runAttestation(await encryptedReceipt(), fullVerifierPorts());

    expect(result.receipt.claims.endpointKey.status).toBe("verified");
    expect(result.receipt.claims.gpuTee.status).toBe("verified");
    expect(result.receipt.claims.model.status).toBe("verified");
    expect(result.receipt.claims.conversation.status).toBe("verified");
    expect(result.receipt.claims.payment.status).toBe("verified");
    expect(result.receipt.proofLevel).toBe("settled");
    expect(badgeState(result, "request-bound")).toBe("verified");
    expect(badgeState(result, "transcript-signed")).toBe("verified");
    expect(badgeState(result, "payment-receipt")).toBe("verified");
  });

  test("returns a portable failed attempt without leaking credentials", async () => {
    const result = await attestChutesInstance({
      apiKey: API_KEY,
      baseReceipt: await encryptedReceipt(),
      e2ePublicKey: E2E_PUBLIC_KEY,
      instanceId: INSTANCE_ID,
      fetchImpl: vi.fn(async () => new Response("unavailable", { status: 502 })),
      randomValues: deterministicRandom,
      now: () => CHECKED_AT,
    });
    expect(result.receipt.claims.endpointKey.status).toBe("unavailable");
    expect(badgeState(result, "evidence-fetched")).toBe("failed");
    expect(result.receipt.proofLevel).toBe("encrypted");
    expect(result.portableJson).not.toContain(API_KEY);
    expect(JSON.parse(result.portableJson)).toMatchObject({
      evidence: { format: "chutes-tee-attestation-attempt/v1" },
    });
  });
});

async function runAttestation(
  baseReceipt?: ReturnType<typeof createLocalReceipt>,
  verifiers?: AttestationVerifierPorts,
) {
  const receipt = baseReceipt ?? await encryptedReceipt();
  const fetchImpl: typeof fetch = vi.fn(async (input) => {
    const nonce = new URL(String(input)).searchParams.get("nonce");
    if (!nonce) throw new Error("nonce missing");
    return jsonResponse(evidenceBody(await buildQuote(nonce, E2E_PUBLIC_KEY)));
  });
  return attestChutesInstance({
    apiKey: API_KEY,
    baseReceipt: receipt,
    e2ePublicKey: E2E_PUBLIC_KEY,
    instanceId: INSTANCE_ID,
    fetchImpl,
    randomValues: deterministicRandom,
    requestBinding: {
      boundDigest: receipt.bindings.requestDigest ?? "",
      source: "test-envelope",
    },
    verifiers,
    now: () => CHECKED_AT,
  });
}

async function encryptedReceipt() {
  const receipt = createLocalReceipt({
    sessionId: "session-1",
    turnId: "turn-1",
    provider: "chutes",
    model: "example/Model-TEE",
    requestDigest: "sha256:request",
    responseDigest: "sha256:response",
    now: CHECKED_AT,
  });
  receipt.proofLevel = "encrypted";
  receipt.posture = "encrypted-unattested";
  receipt.instanceId = INSTANCE_ID;
  receipt.bindings.endpointKeyDigest = await sha256(E2E_PUBLIC_KEY);
  receipt.claims.encryption = {
    status: "verified",
    summary: "The transport recorded an encrypted inference exchange.",
    verifier: "test-transport",
    checkedAt: CHECKED_AT,
  };
  return receipt;
}

function fullVerifierPorts(): AttestationVerifierPorts {
  return {
    dcap: {
      id: "test-dcap",
      version: "1",
      async verify() {
        return verifiedDcap();
      },
    },
    nvidia: {
      id: "test-nvidia",
      version: "1",
      async verify() {
        return {
          status: "verified",
          summary: "All GPUs verified.",
          allDevicesVerified: true,
          confidentialComputeVerified: true,
          bindingVerified: true,
          policyDigest: "sha256:nvidia-policy",
        };
      },
    },
    model: {
      id: "test-model",
      version: "1",
      async verify() {
        return {
          status: "verified",
          summary: "Model artifact verified.",
          artifactVerified: true,
          measurementBound: true,
          artifactDigest: "sha256:model",
          policyDigest: "sha256:model-policy",
        };
      },
    },
    transcript: {
      id: "test-transcript",
      version: "1",
      async verify(input) {
        return {
          status: "verified",
          summary: "Transcript signature verified.",
          signatureVerified: true,
          endpointBound: true,
          requestBound: true,
          responseBound: true,
          requestDigest: input.requestDigest,
          responseDigest: input.responseDigest,
          signer: "instance-signing-key",
          signatureAlgorithm: "Ed25519",
        };
      },
    },
    payment: {
      id: "test-payment",
      version: "1",
      async verify() {
        return {
          status: "verified",
          summary: "Payment receipt verified.",
          settlementVerified: true,
          receiptDigest: "sha256:payment",
        };
      },
    },
  };
}

function verifiedDcap() {
  return {
    status: "verified" as const,
    summary: "Intel DCAP quote, TCB, debug mode, and policy verified.",
    signatureVerified: true as const,
    tcbVerified: true as const,
    policyVerified: true as const,
    debugDisabled: true as const,
    policyDigest: "sha256:dcap-policy",
  };
}

async function buildQuote(
  nonce: string,
  e2ePublicKey: string,
  options: { version?: 4 | 5; attestationKeyType?: 2 | 3 } = {},
): Promise<string> {
  const version = options.version ?? 4;
  const bodyOffset = version === 5 ? 54 : 48;
  const signatureLengthOffset = bodyOffset + 584;
  const bytes = new Uint8Array(signatureLengthOffset + 4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, version, true);
  view.setUint16(2, options.attestationKeyType ?? 2, true);
  view.setUint32(4, 0x81, true);
  if (version === 5) {
    view.setUint16(48, 2, true);
    view.setUint32(50, 584, true);
  }
  view.setUint32(signatureLengthOffset, 0, true);
  const digest = hexToBytes(await sha256Hex(`${nonce}${e2ePublicKey}`));
  bytes.set(digest, bodyOffset + 520);
  return bytesToBase64(bytes);
}

function evidenceBody(quote: string) {
  return {
    quote,
    gpu_evidence: [{ arch: "HOPPER", evidence: "test-evidence" }],
    instance_id: INSTANCE_ID,
    certificate: CERTIFICATE,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function deterministicRandom(target: Uint8Array) {
  for (let index = 0; index < target.length; index += 1) target[index] = index;
}

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function badgeState(
  outcome: Awaited<ReturnType<typeof runAttestation>>,
  key: (typeof outcome.badges)[number]["key"],
) {
  return outcome.badges.find((badge) => badge.key === key)?.state;
}
