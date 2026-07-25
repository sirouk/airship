/**
 * Browser-local checks for Chutes/NVIDIA GPU evidence.
 *
 * Chutes currently returns the NVIDIA SDK's compact remote-verifier artifact:
 * a base64 SPDM GET_MEASUREMENTS request/response plus a base64 PEM certificate
 * chain. The live Blackwell artifact is 87 bytes; it does not carry the
 * self-contained signature/RIM/OCSP material required for a complete local GPU
 * attestation decision. The request nonce is nevertheless explicit at bytes
 * 4..36, per NVIDIA's SPDM request parser, and Chutes binds that nonce to the
 * same SHA-256(nonce + E2E key) digest carried by the TDX quote.
 *
 * This module therefore proves exactly one thing: every bounded GPU evidence
 * object carries the expected request-binding digest. A match is `matched`,
 * never `verified`. Full GPU verification must arrive through an independent
 * verifier port (for example a signed NVIDIA NRAS EAT whose signature, claims,
 * nonce, RIM, revocation, freshness, and confidential-mode policy are checked).
 */
import { decodeCanonicalBase64 } from "../encoding";
import type { JsonObject } from "../types";

const SPDM_REQUEST_BYTES = 37;
const SPDM_NONCE_OFFSET = 4;
const SPDM_NONCE_BYTES = 32;
const MAX_GPU_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_GPU_CERTIFICATE_BYTES = 96 * 1024;
const MAX_GPU_ARCH_LENGTH = 64;
const HEX_32_BYTES = /^[0-9a-f]{64}$/u;

export type NvidiaGpuVerification = Readonly<{
  state: "matched" | "failed" | "unavailable";
  deviceCount: number;
  matchedNonceCount: number;
  architectures: readonly string[];
  summary: string;
}>;

export async function verifyNvidiaGpuEvidence(
  gpuEvidence: readonly JsonObject[],
  expectedBindingDigestHex: string,
): Promise<NvidiaGpuVerification> {
  if (!gpuEvidence || gpuEvidence.length === 0) {
    return result(
      "unavailable",
      0,
      0,
      [],
      "The response contains no NVIDIA GPU evidence objects.",
    );
  }
  const expected = expectedBindingDigestHex.toLowerCase();
  if (!HEX_32_BYTES.test(expected)) {
    return result(
      "failed",
      gpuEvidence.length,
      0,
      [],
      "The expected NVIDIA challenge binding is not a 32-byte hexadecimal digest.",
    );
  }

  const expectedBytes = hexBytes(expected);
  const architectures = new Set<string>();
  let matchedNonceCount = 0;
  try {
    for (const [index, gpu] of gpuEvidence.entries()) {
      const arch = boundedArchitecture(gpu.arch, index);
      if (architectures.size > 0 && !architectures.has(arch)) {
        return result(
          "failed",
          gpuEvidence.length,
          matchedNonceCount,
          [...architectures, arch],
          "The NVIDIA evidence batch mixes GPU architectures; Airship will not treat it as one attestation subject.",
        );
      }
      architectures.add(arch);
      // The certificate chain is not promoted into an authenticity claim here,
      // but canonical decoding prevents an arbitrary string from masquerading
      // as the documented NVIDIA evidence field.
      decodeCanonicalBase64({
        value: requiredString(gpu.certificate, `GPU evidence ${index + 1} certificate`),
        label: `gpu_evidence[${index}].certificate`,
        minBytes: 1,
        maxBytes: MAX_GPU_CERTIFICATE_BYTES,
      });
      const evidence = decodeCanonicalBase64({
        value: requiredString(gpu.evidence, `GPU evidence ${index + 1} payload`),
        label: `gpu_evidence[${index}].evidence`,
        minBytes: SPDM_REQUEST_BYTES,
        maxBytes: MAX_GPU_EVIDENCE_BYTES,
      });
      const reportedNonce = evidence.subarray(
        SPDM_NONCE_OFFSET,
        SPDM_NONCE_OFFSET + SPDM_NONCE_BYTES,
      );
      if (!constantTimeEqual(reportedNonce, expectedBytes)) {
        return result(
          "failed",
          gpuEvidence.length,
          matchedNonceCount,
          [...architectures],
          `NVIDIA GPU evidence ${index + 1} does not carry the request binding used by the Intel TDX quote.`,
        );
      }
      matchedNonceCount += 1;
    }
  } catch {
    return result(
      "failed",
      gpuEvidence.length,
      matchedNonceCount,
      [...architectures],
      "At least one NVIDIA GPU evidence object is malformed or exceeds the browser verifier bounds.",
    );
  }

  return result(
    "matched",
    gpuEvidence.length,
    matchedNonceCount,
    [...architectures],
    `${matchedNonceCount} NVIDIA GPU evidence record${matchedNonceCount === 1 ? "" : "s"} carry the same fresh endpoint-binding digest as the TDX quote. This is a local SPDM request-nonce match, not NVIDIA NRAS/RIM/OCSP verification or proof of confidential GPU mode.`,
  );
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is missing.`);
  return value;
}

function boundedArchitecture(value: unknown, index: number): string {
  const arch = requiredString(value, `GPU evidence ${index + 1} architecture`).trim();
  if (!arch || arch.length > MAX_GPU_ARCH_LENGTH || /[\u0000-\u001f\u007f]/u.test(arch)) {
    throw new TypeError(`GPU evidence ${index + 1} architecture is invalid.`);
  }
  return arch;
}

function hexBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function result(
  state: NvidiaGpuVerification["state"],
  deviceCount: number,
  matchedNonceCount: number,
  architectures: readonly string[],
  summary: string,
): NvidiaGpuVerification {
  return Object.freeze({
    state,
    deviceCount,
    matchedNonceCount,
    architectures: Object.freeze([...architectures].sort()),
    summary,
  });
}
