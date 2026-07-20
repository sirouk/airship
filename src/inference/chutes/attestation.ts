import type { JsonValue } from "../../core/contracts";
import type { ReceiptClaim } from "../../receipts/types";

export type AttestationMode = "required" | "optional";

export type AttestationSubject = {
  provider: "chutes";
  chuteId: string;
  instanceId: string;
  e2ePublicKey: string;
};

/**
 * A verifier-produced endpoint receipt. Airship accepts it only when the
 * subject exactly matches discovery and its verification window is fresh.
 * This receipt deliberately does not represent model or transcript proof.
 */
export type VerifiedEndpointReceipt = {
  version: 1;
  status: "verified";
  provider: "chutes";
  chuteId: string;
  instanceId: string;
  e2ePublicKey: string;
  verifiedAt: string;
  expiresAt: string;
  verifier: string;
  verifierVersion: string;
  policyDigest?: string;
  cpuTee?: ReceiptClaim;
  gpuTee?: ReceiptClaim;
  evidence?: {
    format: string;
    payload: JsonValue;
    digest?: string;
  };
};

/** Safe, non-binary verifier output retained even when promotion fails. */
export type EvaluatedEndpointAttestation = {
  checkedAt: string;
  freshness: ReceiptClaim;
  endpointKey: ReceiptClaim;
  cpuTee: ReceiptClaim;
  gpuTee: ReceiptClaim;
  runtimePolicy: ReceiptClaim;
  evidenceDigest?: string;
  evidenceFormat?: string;
};

export type AttestationGateResult = {
  /** Present only for a genuinely verified exact-endpoint result. */
  receipt?: VerifiedEndpointReceipt;
  /** Bounded claims only: never raw quote, certificate, nonce, or endpoint key. */
  evaluation?: EvaluatedEndpointAttestation;
  unavailableReason?: string;
};

export interface AttestationGate {
  verifyEndpoint(
    subject: AttestationSubject,
    signal: AbortSignal,
  ): Promise<AttestationGateResult>;
}

export type AttestationOutcome = {
  receipt?: VerifiedEndpointReceipt;
  evaluation?: EvaluatedEndpointAttestation;
  unavailableReason?: string;
};

export function validateEndpointReceipt(
  receipt: VerifiedEndpointReceipt | undefined,
  subject: AttestationSubject,
  nowMs: number,
  maxAgeMs: number,
  clockSkewMs: number,
): string | undefined {
  if (!receipt) return "The attestation verifier returned no endpoint receipt.";
  if (receipt.version !== 1 || receipt.status !== "verified" || receipt.provider !== "chutes") {
    return "The attestation verifier did not return a verified Chutes v1 endpoint receipt.";
  }
  if (
    receipt.chuteId !== subject.chuteId ||
    receipt.instanceId !== subject.instanceId ||
    receipt.e2ePublicKey !== subject.e2ePublicKey
  ) {
    return "The attestation receipt does not bind the exact discovered chute, instance, and E2EE key.";
  }
  if (!receipt.verifier.trim() || !receipt.verifierVersion.trim()) {
    return "The attestation receipt is missing verifier identity or version.";
  }

  const verifiedAt = Date.parse(receipt.verifiedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt)) {
    return "The attestation receipt has invalid verification timestamps.";
  }
  if (verifiedAt > nowMs + clockSkewMs) {
    return "The attestation receipt verification time is in the future.";
  }
  if (nowMs - verifiedAt > maxAgeMs) {
    return "The attestation receipt is older than the configured freshness window.";
  }
  if (expiresAt <= nowMs) return "The attestation receipt has expired.";
  if (expiresAt <= verifiedAt) return "The attestation receipt expiry does not follow verification.";
  return undefined;
}
