import { describe, expect, it } from "vitest";
import { bytesToBase64, hexToBytes } from "../encoding";
import type { JsonObject } from "../types";
import { verifyNvidiaGpuEvidence } from "./nvidia-gpu";

const BINDING = "42".repeat(32);
const CERTIFICATE = bytesToBase64(new TextEncoder().encode(
  "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
));

describe("NVIDIA compact GPU evidence", () => {
  it("matches every SPDM request nonce without claiming NVIDIA verification", async () => {
    const result = await verifyNvidiaGpuEvidence([
      gpuEvidence(BINDING),
      gpuEvidence(BINDING),
    ], BINDING);

    expect(result).toMatchObject({
      state: "matched",
      deviceCount: 2,
      matchedNonceCount: 2,
      architectures: ["BLACKWELL"],
    });
    expect(result.summary).toContain("not NVIDIA NRAS/RIM/OCSP verification");
  });

  it("fails the complete batch when one device carries another binding", async () => {
    const result = await verifyNvidiaGpuEvidence([
      gpuEvidence(BINDING),
      gpuEvidence("24".repeat(32)),
    ], BINDING);

    expect(result).toMatchObject({
      state: "failed",
      deviceCount: 2,
      matchedNonceCount: 1,
    });
    expect(result.summary).toContain("does not carry the request binding");
  });

  it("rejects malformed or non-canonical provider fields", async () => {
    const evidence = gpuEvidence(BINDING);
    const result = await verifyNvidiaGpuEvidence([
      { ...evidence, certificate: "not base64" },
    ], BINDING);

    expect(result).toMatchObject({ state: "failed", matchedNonceCount: 0 });
    expect(result.summary).toContain("malformed");
  });

  it("rejects a mixed-architecture batch", async () => {
    const result = await verifyNvidiaGpuEvidence([
      gpuEvidence(BINDING, "BLACKWELL"),
      gpuEvidence(BINDING, "HOPPER"),
    ], BINDING);

    expect(result).toMatchObject({
      state: "failed",
      matchedNonceCount: 1,
      architectures: ["BLACKWELL", "HOPPER"],
    });
    expect(result.summary).toContain("mixes GPU architectures");
  });

  it("reports absent evidence and invalid expected bindings without promotion", async () => {
    await expect(verifyNvidiaGpuEvidence([], BINDING)).resolves.toMatchObject({
      state: "unavailable",
      deviceCount: 0,
    });
    await expect(verifyNvidiaGpuEvidence([gpuEvidence(BINDING)], "abcd")).resolves.toMatchObject({
      state: "failed",
      matchedNonceCount: 0,
    });
  });
});

function gpuEvidence(binding: string, arch = "BLACKWELL"): JsonObject {
  // NVIDIA's compact remote-verifier request is 37 bytes at minimum. Live
  // Blackwell records are currently 87 bytes; nonce/challenge bytes are 4..36.
  const evidence = new Uint8Array(87);
  evidence.set([0x11, 0xe0, 0x01, 0xff]);
  evidence.set(hexToBytes(binding), 4);
  return {
    arch,
    certificate: CERTIFICATE,
    evidence: bytesToBase64(evidence),
  };
}
