import type { JsonValue } from "../core/contracts";
import type {
  ClaimKey,
  ConversationReceipt,
  ProofStatus,
  VerificationRecord,
} from "../receipts/types";

export type JsonObject = { [key: string]: JsonValue };

export type ChutesInstanceEvidence = {
  quote: string;
  gpuEvidence: JsonObject[];
  instanceId: string;
  reportedInstanceId?: string;
  certificate: string;
};

export type EvidenceFetchResult = {
  nonce: string;
  requestUrl: string;
  fetchedAt: string;
  evidence: ChutesInstanceEvidence;
};

export type ParsedTdxQuote = {
  bytes: Uint8Array;
  version: 4 | 5;
  attestationKeyType: 2 | 3;
  teeType: 0x81;
  /** Quote-v5 body discriminator; quote-v4 has an implicit TDX 1.0 body. */
  bodyType: 2 | 3;
  reportBodyOffset: number;
  reportBodyLength: 584 | 648;
  signatureDataLength: number;
  reportData: Uint8Array;
  reportDataHex: string;
};

export type LocalKeyBindingCheck = {
  algorithm: "SHA-256";
  construction: "utf8(nonce + e2e_pubkey)";
  matched: boolean;
  expectedDigestHex: string;
  quotedDigestHex: string;
  reportDataHex: string;
  quote: ParsedTdxQuote;
};

export type AttestationStageKey =
  | "evidence-fetched"
  | "key-binding-checked"
  | "intel-dcap"
  | "nvidia"
  | "model-artifact"
  | "request-bound"
  | "transcript-signed"
  | "payment-receipt";

/**
 * `present` and `matched` are deliberately distinct from `verified`: receiving
 * JSON or comparing bytes locally does not authenticate the quote.
 */
export type AttestationStageState =
  | "present"
  | "matched"
  | "verified"
  | "partial"
  | "failed"
  | "expired"
  | "unavailable";

export type AttestationBadge = {
  key: AttestationStageKey;
  label: string;
  state: AttestationStageState;
  proofStatus: ProofStatus;
  summary: string;
  claim?: ClaimKey;
  verifier?: string;
  checkedAt?: string;
};

export type AttestationOutcome = {
  receipt: ConversationReceipt;
  badges: AttestationBadge[];
  evidence?: EvidenceFetchResult;
  localBinding?: LocalKeyBindingCheck;
  portableJson: string;
};

export type NonVerifiedResult = {
  status: "partial" | "failed" | "expired" | "unavailable";
  summary: string;
  details?: JsonValue;
};

export type DcapVerificationResult =
  | NonVerifiedResult
  | {
      status: "verified";
      summary: string;
      signatureVerified: true;
      tcbVerified: true;
      policyVerified: true;
      debugDisabled: true;
      policyDigest: string;
      details?: JsonValue;
    };

export type NvidiaVerificationResult =
  | NonVerifiedResult
  | {
      status: "verified";
      summary: string;
      allDevicesVerified: true;
      confidentialComputeVerified: true;
      bindingVerified: true;
      policyDigest: string;
      details?: JsonValue;
    };

export type ModelVerificationResult =
  | NonVerifiedResult
  | {
      status: "verified";
      summary: string;
      artifactVerified: true;
      measurementBound: true;
      artifactDigest: string;
      policyDigest: string;
      details?: JsonValue;
    };

export type TranscriptVerificationResult =
  | NonVerifiedResult
  | {
      status: "verified";
      summary: string;
      signatureVerified: true;
      endpointBound: true;
      requestBound: true;
      responseBound: true;
      requestDigest: string;
      responseDigest: string;
      signer: string;
      signatureAlgorithm: string;
      policyDigest?: string;
      details?: JsonValue;
    };

export type PaymentVerificationResult =
  | NonVerifiedResult
  | {
      status: "verified";
      summary: string;
      settlementVerified: true;
      receiptDigest: string;
      policyDigest?: string;
      details?: JsonValue;
    };

export interface VerifierPort<Input, Result> {
  readonly id: string;
  readonly version: string;
  verify(input: Input, signal?: AbortSignal): Promise<Result>;
}

export type DcapVerifierInput = {
  instanceId: string;
  nonce: string;
  e2ePublicKey: string;
  evidence: ChutesInstanceEvidence;
  parsedQuote: ParsedTdxQuote;
  expectedBindingDigestHex: string;
};

export type NvidiaVerifierInput = {
  instanceId: string;
  nonce: string;
  e2ePublicKey: string;
  gpuEvidence: JsonObject[];
  expectedBindingDigestHex: string;
};

export type ModelVerifierInput = {
  instanceId: string;
  model: string;
  evidence: ChutesInstanceEvidence;
  parsedQuote: ParsedTdxQuote;
  proof?: JsonValue;
};

export type TranscriptVerifierInput = {
  instanceId: string;
  sessionId: string;
  turnId: string;
  requestDigest: string;
  responseDigest: string;
  proof?: JsonValue;
};

export type PaymentVerifierInput = {
  sessionId: string;
  turnId: string;
  proof?: JsonValue;
};

export type AttestationVerifierPorts = {
  dcap?: VerifierPort<DcapVerifierInput, DcapVerificationResult>;
  nvidia?: VerifierPort<NvidiaVerifierInput, NvidiaVerificationResult>;
  model?: VerifierPort<ModelVerifierInput, ModelVerificationResult>;
  transcript?: VerifierPort<TranscriptVerifierInput, TranscriptVerificationResult>;
  payment?: VerifierPort<PaymentVerifierInput, PaymentVerificationResult>;
};

export type EvaluatedVerification<Result> = {
  result: Result | NonVerifiedResult;
  record: VerificationRecord;
  verifier: string;
  version: string;
};

export type LocalRequestBinding = {
  /** Digest asserted by an envelope or other request-binding artifact. */
  boundDigest: string;
  source: string;
};
