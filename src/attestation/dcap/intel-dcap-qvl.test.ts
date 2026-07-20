import { describe, expect, it, vi } from "vitest";
import type { DcapVerifierInput, VerifierPort, DcapVerificationResult } from "../types";
import { createIntelDcapQvlVerifierPort } from "./intel-dcap-qvl";

const bindingHex = "ab".repeat(32);

function input(): DcapVerifierInput {
  const reportData = new Uint8Array(64);
  reportData.set(Uint8Array.from({ length: 32 }, () => 0xab));
  return {
    instanceId: "instance-1",
    nonce: "11".repeat(32),
    e2ePublicKey: "endpoint-key",
    evidence: {
      quote: "AA==",
      gpuEvidence: [],
      instanceId: "instance-1",
      certificate: "AA==",
    },
    parsedQuote: {
      bytes: new Uint8Array([1, 2, 3]),
      version: 4,
      attestationKeyType: 2,
      teeType: 0x81,
      bodyType: 2,
      reportBodyOffset: 48,
      reportBodyLength: 584,
      signatureDataLength: 0,
      reportData,
      reportDataHex: `${bindingHex}${"00".repeat(32)}`,
    },
    expectedBindingDigestHex: bindingHex,
  };
}

describe("Intel DCAP QVL WASM port", () => {
  it("promotes only a complete, current, advisory-free local QVL result", async () => {
    const getCollateral = vi.fn(async () => ({ pck_crl: [1], qe_identity: "signed" }));
    const verifyQuote = vi.fn(() => ({
      status: "UpToDate",
      advisory_ids: [],
      qe_status: { status: "UpToDate", advisory_ids: [] },
      platform_status: { status: "UpToDate", advisory_ids: [] },
      report: { TD10: { mr_td: [] } },
    }));
    const verifier = createIntelDcapQvlVerifierPort({
      loadQvl: async () => ({
        default: vi.fn(async () => ({}) as never),
        parse_quote: vi.fn(() => parsedQuoteResult()),
        get_collateral: getCollateral,
        verify_quote: verifyQuote,
      }) as never,
    });

    const result = await verifier.verify(input());

    expect(result).toMatchObject({
      status: "verified",
      signatureVerified: true,
      tcbVerified: true,
      debugDisabled: true,
    });
    expect(getCollateral).toHaveBeenCalledOnce();
    expect(verifyQuote).toHaveBeenCalledOnce();
  });

  it("preserves a compact partial diagnosis when full QVL is unavailable", async () => {
    const compact: VerifierPort<DcapVerifierInput, DcapVerificationResult> = {
      id: "compact",
      version: "1",
      verify: vi.fn(async (): Promise<DcapVerificationResult> => ({
        status: "partial",
        summary: "Six local checks passed.",
      })),
    };
    const verifier = createIntelDcapQvlVerifierPort({
      loadQvl: async () => { throw new Error("WASM unavailable"); },
      compactFallback: compact,
    });

    const result = await verifier.verify(input());

    expect(result.status).toBe("partial");
    expect(result.summary).toContain("Six local checks passed");
    expect(result.summary).toContain("Full local DCAP QVL was unavailable");
  });

  it("never promotes a malformed QVL response", async () => {
    const compact: VerifierPort<DcapVerifierInput, DcapVerificationResult> = {
      id: "compact",
      version: "1",
      verify: async () => ({ status: "partial", summary: "Compact checks passed." }),
    };
    const verifier = createIntelDcapQvlVerifierPort({
      loadQvl: async () => ({
        default: vi.fn(async () => ({}) as never),
        parse_quote: vi.fn(() => parsedQuoteResult()),
        get_collateral: vi.fn(async () => ({ collateral: true })),
        verify_quote: vi.fn(() => ({ status: "UpToDate" })),
      }) as never,
      compactFallback: compact,
    });

    const result = await verifier.verify(input());

    expect(result.status).toBe("partial");
    expect(result.summary).toContain("malformed verified report");
  });

  it("fails before QVL when report_data does not bind the selected key", async () => {
    const bad = input();
    bad.expectedBindingDigestHex = "00".repeat(32);
    const loadQvl = vi.fn();
    const verifier = createIntelDcapQvlVerifierPort({ loadQvl: loadQvl as never });

    const result = await verifier.verify(bad);

    expect(result.status).toBe("failed");
    expect(loadQvl).not.toHaveBeenCalled();
  });

  it("surfaces key type 3 as verifier-unsupported without loading QVL or fallback", async () => {
    const candidate = input();
    candidate.parsedQuote.attestationKeyType = 3;
    const loadQvl = vi.fn();
    const compact = { id: "compact", version: "1", verify: vi.fn() } as never;
    const verifier = createIntelDcapQvlVerifierPort({ loadQvl: loadQvl as never, compactFallback: compact });

    const result = await verifier.verify(candidate);

    expect(result.status).toBe("unavailable");
    expect(result.summary).toContain("key type 3");
    expect(loadQvl).not.toHaveBeenCalled();
  });
});

function parsedQuoteResult() {
  const source = input().parsedQuote;
  return {
    version: source.version,
    attestationKeyType: source.attestationKeyType,
    teeType: source.teeType,
    bodyType: source.bodyType,
    reportBodyOffset: source.reportBodyOffset,
    reportBodyLength: source.reportBodyLength,
    signatureDataLength: source.signatureDataLength,
    reportData: Array.from(source.reportData),
  };
}
