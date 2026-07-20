import type { JsonValue, SecurityPosture } from "../core/contracts";
import { randomUuid } from "../core/id";

export type ProofStatus = "verified" | "partial" | "failed" | "expired" | "unavailable";

export type ProofLevel =
  | "local"
  | "encrypted"
  | "attested-endpoint"
  | "model-bound"
  | "conversation-bound"
  | "settled";

export type ClaimKey =
  | "encryption"
  | "freshness"
  | "cpuTee"
  | "gpuTee"
  | "endpointKey"
  | "model"
  | "conversation"
  | "payment";

export type ReceiptClaim = {
  status: ProofStatus;
  summary: string;
  verifier?: string;
  policyDigest?: string;
  checkedAt?: string;
  details?: JsonValue;
};

export type ReceiptBinding = {
  algorithm: "SHA-256";
  /** Digest of the exact E2E public key selected at invocation time. */
  endpointKeyDigest?: string;
  requestDigest?: string;
  responseDigest?: string;
  requestCiphertextDigest?: string;
  responseCiphertextDigest?: string;
  evidenceDigest?: string;
};

export type VerificationRecord = {
  verifier: string;
  version: string;
  checkedAt: string;
  status: ProofStatus;
  claim: ClaimKey;
  policyDigest?: string;
  detail?: string;
};

export type ConversationReceipt = {
  version: 1;
  receiptId: string;
  sessionId: string;
  turnId: string;
  createdAt: string;
  proofLevel: ProofLevel;
  posture: SecurityPosture;
  provider: string;
  instanceId?: string;
  model?: string;
  claims: Record<ClaimKey, ReceiptClaim>;
  bindings: ReceiptBinding;
  evidence?: {
    format: string;
    payload: JsonValue;
  };
  verifications: VerificationRecord[];
};

const unavailable = (summary: string): ReceiptClaim => ({ status: "unavailable", summary });

export function emptyClaims(): Record<ClaimKey, ReceiptClaim> {
  return {
    encryption: unavailable("No remote encryption proof applies."),
    freshness: unavailable("No hardware freshness evidence is present."),
    cpuTee: unavailable("No Intel TDX verification is present."),
    gpuTee: unavailable("No GPU confidential-compute verification is present."),
    endpointKey: unavailable("No attested endpoint-key binding is present."),
    model: unavailable("No model artifact proof is present."),
    conversation: unavailable("No enclave-signed conversation proof is present."),
    payment: unavailable("No payment receipt is present."),
  };
}

export function createLocalReceipt(args: {
  sessionId: string;
  turnId: string;
  provider: string;
  model: string;
  requestDigest?: string;
  responseDigest?: string;
  now?: string;
}): ConversationReceipt {
  const now = args.now ?? new Date().toISOString();
  const claims = emptyClaims();
  claims.conversation = {
    status: "partial",
    summary: "Airship recorded local request and response digests; this is client evidence, not a TEE signature.",
    verifier: "airship-client",
    checkedAt: now,
  };
  return {
    version: 1,
    receiptId: `urn:airship:receipt:${randomUuid()}`,
    sessionId: args.sessionId,
    turnId: args.turnId,
    createdAt: now,
    proofLevel: "local",
    posture: "local",
    provider: args.provider,
    model: args.model,
    claims,
    bindings: {
      algorithm: "SHA-256",
      requestDigest: args.requestDigest,
      responseDigest: args.responseDigest,
    },
    verifications: [
      {
        verifier: "airship-client",
        version: "1",
        checkedAt: now,
        status: "partial",
        claim: "conversation",
        detail: "Locally computed digests; no external signer.",
      },
    ],
  };
}
