import type { JsonValue, SecurityPosture } from "../core/contracts";
import { sha256 } from "../core/hash";
import type {
  ClaimKey,
  ConversationReceipt,
  ProofLevel,
  ProofStatus,
  ReceiptClaim,
  VerificationRecord,
} from "../receipts/types";
import { cloneBoundedJson, EvidenceClientError, fetchChutesInstanceEvidence } from "./client";
import type { FetchChutesEvidenceArgs } from "./client";
import { bytesToBase64, hexToBytes, sha256Hex } from "./encoding";
import { checkChutesReportDataBinding, validateChutesE2ePublicKey } from "./tdx";
import type {
  AttestationBadge,
  AttestationOutcome,
  AttestationStageState,
  AttestationVerifierPorts,
  ChutesInstanceEvidence,
  EvaluatedVerification,
  LocalKeyBindingCheck,
  LocalRequestBinding,
  ModelVerificationResult,
  NvidiaVerificationResult,
  DcapVerificationResult,
  PaymentVerificationResult,
  TranscriptVerificationResult,
} from "./types";
import {
  evaluateDcapVerifier,
  evaluateModelVerifier,
  evaluateNvidiaVerifier,
  evaluatePaymentVerifier,
  evaluateTranscriptVerifier,
} from "./verifiers";

export type AttestChutesInstanceArgs = Omit<FetchChutesEvidenceArgs, "now"> & {
  baseReceipt: ConversationReceipt;
  e2ePublicKey: string;
  verifiers?: AttestationVerifierPorts;
  requestBinding?: LocalRequestBinding;
  modelProof?: JsonValue;
  transcriptProof?: JsonValue;
  paymentProof?: JsonValue;
  now?: () => string;
};

type RequestBindingEvaluation = {
  state: "matched" | "failed" | "unavailable";
  summary: string;
};

/**
 * Fetch evidence, perform the local quote binding check, invoke configured
 * independent verifier ports, and compose a conservative ConversationReceipt.
 */
export async function attestChutesInstance(
  args: AttestChutesInstanceArgs,
): Promise<AttestationOutcome> {
  validateChutesE2ePublicKey(args.e2ePublicKey);
  await requireInvocationEndpointBinding(args.baseReceipt, args.instanceId, args.e2ePublicKey);
  const checkedAt = (args.now ?? (() => new Date().toISOString()))();
  const modelProof = optionalBoundedJson(args.modelProof, "model proof");
  const transcriptProof = optionalBoundedJson(args.transcriptProof, "transcript proof");
  const paymentProof = optionalBoundedJson(args.paymentProof, "payment proof");
  const requestBinding = evaluateLocalRequestBinding(args.baseReceipt, args.requestBinding);

  let fetched;
  try {
    fetched = await fetchChutesInstanceEvidence({
      apiKey: args.apiKey,
      instanceId: args.instanceId,
      baseUrl: args.baseUrl,
      fetchImpl: args.fetchImpl,
      signal: args.signal,
      timeoutMs: args.timeoutMs,
      maxResponseBytes: args.maxResponseBytes,
      randomValues: args.randomValues,
      now: () => checkedAt,
    });
  } catch (error) {
    if (error instanceof EvidenceClientError && error.code !== "invalid-input") {
      return buildFetchFailureOutcome(args.baseReceipt, args.instanceId, error, checkedAt);
    }
    throw error;
  }

  const localBinding = await checkChutesReportDataBinding({
    quoteBase64: fetched.evidence.quote,
    nonce: fetched.nonce,
    e2ePublicKey: args.e2ePublicKey,
  });
  const ports = args.verifiers ?? {};
  const transcriptInput =
    args.baseReceipt.bindings.requestDigest && args.baseReceipt.bindings.responseDigest
      ? {
          instanceId: args.instanceId,
          sessionId: args.baseReceipt.sessionId,
          turnId: args.baseReceipt.turnId,
          requestDigest: args.baseReceipt.bindings.requestDigest,
          responseDigest: args.baseReceipt.bindings.responseDigest,
          proof: transcriptProof,
        }
      : undefined;
  const expectedModel = validExpectedModel(args.baseReceipt.model)
    ? args.baseReceipt.model
    : undefined;
  const modelInput = expectedModel
    ? {
        instanceId: args.instanceId,
        model: expectedModel,
        evidence: fetched.evidence,
        parsedQuote: localBinding.quote,
        proof: modelProof,
      }
    : undefined;

  const [dcap, nvidia, model, transcript, payment] = await Promise.all([
    evaluateDcapVerifier(
      ports.dcap,
      {
        instanceId: args.instanceId,
        nonce: fetched.nonce,
        e2ePublicKey: args.e2ePublicKey,
        evidence: fetched.evidence,
        parsedQuote: localBinding.quote,
        expectedBindingDigestHex: localBinding.expectedDigestHex,
      },
      checkedAt,
      args.signal,
    ),
    evaluateNvidiaVerifier(
      ports.nvidia,
      {
        instanceId: args.instanceId,
        nonce: fetched.nonce,
        e2ePublicKey: args.e2ePublicKey,
        gpuEvidence: fetched.evidence.gpuEvidence,
        expectedBindingDigestHex: localBinding.expectedDigestHex,
      },
      checkedAt,
      args.signal,
    ),
    evaluateModelVerifier(
      ports.model,
      modelInput,
      checkedAt,
      args.signal,
    ),
    evaluateTranscriptVerifier(
      ports.transcript,
      transcriptInput,
      checkedAt,
      args.signal,
    ),
    evaluatePaymentVerifier(
      ports.payment,
      {
        sessionId: args.baseReceipt.sessionId,
        turnId: args.baseReceipt.turnId,
        proof: paymentProof,
      },
      checkedAt,
      args.signal,
    ),
  ]);

  const claims = composeClaims({
    baseReceipt: args.baseReceipt,
    checkedAt,
    localBinding,
    requestBinding,
    dcap,
    nvidia,
    model,
    transcript,
    payment,
  });
  const badges = composeBadges({
    checkedAt,
    localBinding,
    requestBinding,
    dcap,
    nvidia,
    model,
    transcript,
    payment,
  });
  const endpointVerified = claims.endpointKey.status === "verified";
  const proofLevel = deriveProofLevel(args.baseReceipt, claims);
  const posture = derivePosture(args.baseReceipt, endpointVerified);
  const evidenceForDigest = evidenceJson(fetched.evidence, fetched.nonce, args.e2ePublicKey);
  const evidenceDigest = await digestJson(evidenceForDigest);
  const verifications = composeVerificationRecords({
    base: args.baseReceipt.verifications,
    checkedAt,
    localBinding,
    requestBinding,
    endpointClaim: claims.endpointKey,
    dcap,
    nvidia,
    model,
    transcript,
    payment,
  });

  const receipt: ConversationReceipt = {
    ...args.baseReceipt,
    instanceId: args.instanceId,
    proofLevel,
    posture,
    claims,
    bindings: {
      ...args.baseReceipt.bindings,
      evidenceDigest,
    },
    evidence: {
      format: "chutes-tee-instance-evidence/v1",
      payload: {
        schemaVersion: 1,
        requestUrl: fetched.requestUrl,
        fetchedAt: fetched.fetchedAt,
        nonce: fetched.nonce,
        e2ePublicKey: args.e2ePublicKey,
        evidence: evidenceForDigest.evidence,
        localBinding: {
          algorithm: localBinding.algorithm,
          construction: localBinding.construction,
          matched: localBinding.matched,
          expectedDigestHex: localBinding.expectedDigestHex,
          quotedDigestHex: localBinding.quotedDigestHex,
          reportDataHex: localBinding.reportDataHex,
          quoteVersion: localBinding.quote.version,
          teeType: localBinding.quote.teeType,
          signatureDataLength: localBinding.quote.signatureDataLength,
        },
        stages: badges.map(badgeJson),
      },
    },
    verifications,
  };
  return {
    receipt,
    badges,
    evidence: fetched,
    localBinding,
    portableJson: serializePortableReceipt(receipt),
  };
}

export function exportPortableReceipt(receipt: ConversationReceipt): ConversationReceipt {
  const parsed = JSON.parse(JSON.stringify(receipt)) as ConversationReceipt;
  const claims = Object.fromEntries(
    Object.entries(parsed.claims).map(([key, claim]) => [key, {
      status: claim.status,
      summary: claim.summary,
      ...(claim.verifier ? { verifier: claim.verifier } : {}),
      ...(claim.policyDigest ? { policyDigest: claim.policyDigest } : {}),
      ...(claim.checkedAt ? { checkedAt: claim.checkedAt } : {}),
    }]),
  ) as ConversationReceipt["claims"];
  const publicReceipt: ConversationReceipt = {
    ...parsed,
    claims,
    bindings: {
      algorithm: parsed.bindings.algorithm,
      ...(parsed.bindings.endpointKeyDigest ? { endpointKeyDigest: parsed.bindings.endpointKeyDigest } : {}),
      ...(parsed.bindings.requestCiphertextDigest ? { requestCiphertextDigest: parsed.bindings.requestCiphertextDigest } : {}),
      ...(parsed.bindings.responseCiphertextDigest ? { responseCiphertextDigest: parsed.bindings.responseCiphertextDigest } : {}),
      ...(parsed.bindings.evidenceDigest ? { evidenceDigest: parsed.bindings.evidenceDigest } : {}),
    },
    ...(parsed.evidence ? {
      evidence: {
        format: parsed.evidence.format,
        payload: {
          schemaVersion: 1,
          rawEvidence: "omitted-by-default",
          evidenceDigest: parsed.bindings.evidenceDigest ?? null,
        },
      },
    } : {}),
    verifications: parsed.verifications.map((verification) => ({
      verifier: verification.verifier,
      version: verification.version,
      checkedAt: verification.checkedAt,
      status: verification.status,
      claim: verification.claim,
      ...(verification.policyDigest ? { policyDigest: verification.policyDigest } : {}),
    })),
  };
  const redacted = redactCredentialShapes(publicReceipt as unknown as JsonValue);
  cloneBoundedJson(redacted, "portable public receipt");
  return redacted as unknown as ConversationReceipt;
}

export function serializePortableReceipt(receipt: ConversationReceipt): string {
  const portable = exportPortableReceipt(receipt);
  return stableJsonStringify(portable as unknown as JsonValue);
}

async function requireInvocationEndpointBinding(
  receipt: ConversationReceipt,
  instanceId: string,
  e2ePublicKey: string,
): Promise<void> {
  if (
    (receipt.provider !== "chutes" && receipt.provider !== "chutes-e2ee-v1") ||
    !receipt.instanceId ||
    receipt.instanceId !== instanceId
  ) {
    throw new TypeError("Attestation evidence must target the exact Chutes instance pinned by the invocation receipt.");
  }
  if (!receipt.bindings.endpointKeyDigest) {
    throw new TypeError("The invocation receipt does not pin an endpoint public-key digest and cannot be upgraded post hoc.");
  }
  const suppliedDigest = await sha256(e2ePublicKey);
  if (suppliedDigest !== receipt.bindings.endpointKeyDigest) {
    throw new TypeError("Attestation evidence does not match the endpoint public key pinned by the invocation receipt.");
  }
}

function composeClaims(args: {
  baseReceipt: ConversationReceipt;
  checkedAt: string;
  localBinding: LocalKeyBindingCheck;
  requestBinding: RequestBindingEvaluation;
  dcap: EvaluatedVerification<DcapVerificationResult>;
  nvidia: EvaluatedVerification<NvidiaVerificationResult>;
  model: EvaluatedVerification<ModelVerificationResult>;
  transcript: EvaluatedVerification<TranscriptVerificationResult>;
  payment: EvaluatedVerification<PaymentVerificationResult>;
}): ConversationReceipt["claims"] {
  const endpointKey = aggregateEndpointClaim(args.localBinding, args.dcap, args.checkedAt);
  const freshness: ReceiptClaim = {
    ...endpointKey,
    summary:
      endpointKey.status === "verified"
        ? "A fresh caller nonce and endpoint public key are bound into a DCAP-verified TDX quote."
        : endpointKey.status === "partial"
          ? "The fresh nonce/key digest matched report_data locally, but the quote is not DCAP-verified."
          : endpointKey.summary,
  };
  const cpuTee = externalClaim(args.dcap, "Intel TDX DCAP verification is unavailable.");
  const gpuTee = externalClaim(args.nvidia, "NVIDIA confidential-compute verification is unavailable.");
  const model = aggregateDependentClaim(
    args.model,
    endpointKey.status === "verified",
    "The model artifact proof verified, but the serving endpoint is not fully attested.",
  );
  const conversation = aggregateConversationClaim(
    args.transcript,
    args.requestBinding,
    endpointKey.status === "verified",
    args.checkedAt,
    args.baseReceipt.claims.conversation,
  );
  const payment = externalClaim(args.payment, "Payment receipt verification is unavailable.");

  return {
    ...args.baseReceipt.claims,
    freshness,
    cpuTee,
    gpuTee,
    endpointKey,
    model,
    conversation,
    payment,
  };
}

function aggregateEndpointClaim(
  binding: LocalKeyBindingCheck,
  dcap: EvaluatedVerification<DcapVerificationResult>,
  checkedAt: string,
): ReceiptClaim {
  if (!binding.matched) {
    return {
      status: "failed",
      summary: "TDX report_data does not match SHA256(nonce + e2e_pubkey).",
      verifier: "airship-local-binding",
      checkedAt,
    };
  }
  if (dcap.result.status === "verified") {
    return {
      status: "verified",
      summary: "Endpoint key binding is covered by a DCAP signature, current TCB result, and verifier policy.",
      verifier: `${dcap.verifier}+airship-local-binding`,
      policyDigest: dcap.result.policyDigest,
      checkedAt,
    };
  }
  if (dcap.result.status === "failed" || dcap.result.status === "expired") {
    return {
      status: dcap.result.status,
      summary: `The local key binding matched, but Intel DCAP verification is ${dcap.result.status}.`,
      verifier: dcap.verifier,
      checkedAt,
    };
  }
  return {
    status: "partial",
    summary: "TDX report_data matches the fresh nonce and public key locally; quote authenticity and TCB are unverified.",
    verifier: "airship-local-binding",
    checkedAt,
  };
}

function externalClaim<Result extends { status: string; summary: string }>(
  evaluation: EvaluatedVerification<Result>,
  unavailableSummary: string,
): ReceiptClaim {
  const result = evaluation.result;
  const status = result.status as ProofStatus;
  return {
    status,
    summary: status === "unavailable" ? unavailableSummary : result.summary,
    verifier: evaluation.verifier,
    policyDigest:
      "policyDigest" in result && typeof result.policyDigest === "string"
        ? result.policyDigest
        : undefined,
    checkedAt: evaluation.record.checkedAt,
    details: "details" in result ? result.details : undefined,
  };
}

function aggregateDependentClaim<Result extends { status: string; summary: string }>(
  evaluation: EvaluatedVerification<Result>,
  dependencyVerified: boolean,
  partialSummary: string,
): ReceiptClaim {
  const claim = externalClaim(evaluation, evaluation.result.summary);
  if (claim.status === "verified" && !dependencyVerified) {
    return { ...claim, status: "partial", summary: partialSummary };
  }
  return claim;
}

function aggregateConversationClaim(
  transcript: EvaluatedVerification<TranscriptVerificationResult>,
  requestBinding: RequestBindingEvaluation,
  endpointVerified: boolean,
  checkedAt: string,
  baseClaim: ReceiptClaim,
): ReceiptClaim {
  if (transcript.result.status === "verified") {
    if (!endpointVerified) {
      return {
        status: "partial",
        summary: "The transcript signature verified, but the signer endpoint is not fully attested.",
        verifier: transcript.verifier,
        checkedAt,
      };
    }
    return externalClaim(transcript, transcript.result.summary);
  }
  if (transcript.result.status === "failed" || transcript.result.status === "expired") {
    return externalClaim(transcript, transcript.result.summary);
  }
  if (requestBinding.state === "failed") {
    return {
      status: "failed",
      summary: requestBinding.summary,
      verifier: "airship-local-request-binding",
      checkedAt,
    };
  }
  if (requestBinding.state === "matched") {
    return {
      status: "partial",
      summary: "A request digest matched locally; no enclave-signed response or transcript was verified.",
      verifier: "airship-local-request-binding",
      checkedAt,
    };
  }
  if (baseClaim.status === "partial") {
    return {
      ...baseClaim,
      summary: `${baseClaim.summary} No enclave-signed request/response transcript was verified.`,
    };
  }
  return {
    status: "unavailable",
    summary: "No enclave-signed request/response transcript was verified.",
    verifier: transcript.verifier,
    checkedAt,
  };
}

function composeBadges(args: {
  checkedAt: string;
  localBinding: LocalKeyBindingCheck;
  requestBinding: RequestBindingEvaluation;
  dcap: EvaluatedVerification<DcapVerificationResult>;
  nvidia: EvaluatedVerification<NvidiaVerificationResult>;
  model: EvaluatedVerification<ModelVerificationResult>;
  transcript: EvaluatedVerification<TranscriptVerificationResult>;
  payment: EvaluatedVerification<PaymentVerificationResult>;
}): AttestationBadge[] {
  const transcriptVerified = args.transcript.result.status === "verified";
  const requestState: AttestationStageState = transcriptVerified
    ? "verified"
    : args.requestBinding.state;
  return [
    {
      key: "evidence-fetched",
      label: "Evidence",
      state: "present",
      proofStatus: "partial",
      summary: "Fresh evidence was fetched and structurally validated; authenticity is not implied.",
      checkedAt: args.checkedAt,
    },
    {
      key: "key-binding-checked",
      label: "Key binding",
      state: args.localBinding.matched ? "matched" : "failed",
      proofStatus: args.localBinding.matched ? "partial" : "failed",
      summary: args.localBinding.matched
        ? "report_data locally matches SHA256(nonce + e2e_pubkey); DCAP is a separate check."
        : "report_data does not match SHA256(nonce + e2e_pubkey).",
      claim: "endpointKey",
      verifier: "airship-local-binding",
      checkedAt: args.checkedAt,
    },
    evaluationBadge("intel-dcap", "Intel TDX", "cpuTee", args.dcap),
    evaluationBadge("nvidia", "NVIDIA GPU", "gpuTee", args.nvidia),
    evaluationBadge("model-artifact", "Model", "model", args.model),
    {
      key: "request-bound",
      label: "Request",
      state: requestState,
      proofStatus: stageProofStatus(requestState),
      summary: transcriptVerified
        ? "The transcript verifier cryptographically bound the expected request digest."
        : args.requestBinding.summary,
      claim: "conversation",
      verifier: transcriptVerified ? args.transcript.verifier : "airship-local-request-binding",
      checkedAt: args.checkedAt,
    },
    evaluationBadge(
      "transcript-signed",
      "Transcript",
      "conversation",
      args.transcript,
    ),
    evaluationBadge("payment-receipt", "Payment", "payment", args.payment),
  ];
}

function evaluationBadge<Result extends { status: string; summary: string }>(
  key: AttestationBadge["key"],
  label: string,
  claim: ClaimKey,
  evaluation: EvaluatedVerification<Result>,
): AttestationBadge {
  const state = evaluation.result.status as AttestationStageState;
  return {
    key,
    label,
    state,
    proofStatus: stageProofStatus(state),
    summary: evaluation.result.summary,
    claim,
    verifier: evaluation.verifier,
    checkedAt: evaluation.record.checkedAt,
  };
}

function composeVerificationRecords(args: {
  base: VerificationRecord[];
  checkedAt: string;
  localBinding: LocalKeyBindingCheck;
  requestBinding: RequestBindingEvaluation;
  endpointClaim: ReceiptClaim;
  dcap: EvaluatedVerification<DcapVerificationResult>;
  nvidia: EvaluatedVerification<NvidiaVerificationResult>;
  model: EvaluatedVerification<ModelVerificationResult>;
  transcript: EvaluatedVerification<TranscriptVerificationResult>;
  payment: EvaluatedVerification<PaymentVerificationResult>;
}): VerificationRecord[] {
  const records = [
    ...args.base,
    {
      verifier: "airship-local-binding",
      version: "1",
      checkedAt: args.checkedAt,
      status: args.localBinding.matched ? ("partial" as const) : ("failed" as const),
      claim: "endpointKey" as const,
      detail: args.localBinding.matched
        ? "Local report_data comparison only; quote authenticity is not established."
        : "Local report_data comparison failed.",
    },
    args.dcap.record,
    args.nvidia.record,
    args.model.record,
    args.transcript.record,
    args.payment.record,
    {
      verifier: "airship-attestation-composer",
      version: "1",
      checkedAt: args.checkedAt,
      status: args.endpointClaim.status,
      claim: "freshness" as const,
      policyDigest: args.endpointClaim.policyDigest,
      detail: args.endpointClaim.summary,
    },
  ];
  if (args.requestBinding.state !== "unavailable") {
    records.push({
      verifier: "airship-local-request-binding",
      version: "1",
      checkedAt: args.checkedAt,
      status: args.requestBinding.state === "matched" ? "partial" : "failed",
      claim: "conversation",
      detail: args.requestBinding.summary,
    });
  }
  return records;
}

function deriveProofLevel(
  baseReceipt: ConversationReceipt,
  claims: ConversationReceipt["claims"],
): ProofLevel {
  const endpoint = claims.endpointKey.status === "verified";
  const model = endpoint && claims.model.status === "verified";
  const conversation = model && claims.conversation.status === "verified";
  const settled = conversation && claims.payment.status === "verified";
  if (settled) return "settled";
  if (conversation) return "conversation-bound";
  if (model) return "model-bound";
  if (endpoint) return "attested-endpoint";
  return isEncrypted(baseReceipt) ? "encrypted" : "local";
}

function derivePosture(
  baseReceipt: ConversationReceipt,
  endpointVerified: boolean,
): SecurityPosture {
  if (isEncrypted(baseReceipt)) {
    return endpointVerified ? "encrypted-attested" : "encrypted-unattested";
  }
  return baseReceipt.posture === "encrypted-attested" ||
    baseReceipt.posture === "encrypted-unattested"
    ? "encrypted-unattested"
    : baseReceipt.posture;
}

function isEncrypted(receipt: ConversationReceipt): boolean {
  return (
    receipt.posture === "encrypted-attested" ||
    receipt.posture === "encrypted-unattested" ||
    receipt.proofLevel === "encrypted" ||
    receipt.claims.encryption.status === "verified"
  );
}

function evaluateLocalRequestBinding(
  receipt: ConversationReceipt,
  binding: LocalRequestBinding | undefined,
): RequestBindingEvaluation {
  if (!binding) {
    return { state: "unavailable", summary: "No request-binding artifact was supplied." };
  }
  if (
    typeof binding.source !== "string" ||
    binding.source.length === 0 ||
    binding.source.length > 128 ||
    /[\u0000-\u001f]/.test(binding.source) ||
    typeof binding.boundDigest !== "string" ||
    binding.boundDigest.length === 0 ||
    binding.boundDigest.length > 512 ||
    /[\u0000-\u001f]/.test(binding.boundDigest)
  ) {
    return { state: "failed", summary: "The supplied request-binding artifact is malformed." };
  }
  if (!receipt.bindings.requestDigest) {
    return { state: "failed", summary: "The receipt has no request digest to bind." };
  }
  if (receipt.bindings.requestDigest !== binding.boundDigest) {
    return { state: "failed", summary: `The ${binding.source} request digest does not match.` };
  }
  return {
    state: "matched",
    summary: `The ${binding.source} request digest matched locally; no remote signature is implied.`,
  };
}

function buildFetchFailureOutcome(
  baseReceipt: ConversationReceipt,
  instanceId: string,
  error: EvidenceClientError,
  checkedAt: string,
): AttestationOutcome {
  const claims = {
    ...baseReceipt.claims,
    freshness: unavailableClaim("Fresh attestation evidence could not be fetched.", checkedAt),
    cpuTee: unavailableClaim("Intel DCAP verification was not performed.", checkedAt),
    gpuTee: unavailableClaim("NVIDIA verification was not performed.", checkedAt),
    endpointKey: unavailableClaim("Endpoint-key binding could not be checked.", checkedAt),
    model: unavailableClaim("Model-artifact verification was not performed.", checkedAt),
    payment: unavailableClaim("Payment-receipt verification was not performed.", checkedAt),
  };
  const badges: AttestationBadge[] = [
    {
      key: "evidence-fetched",
      label: "Evidence",
      state: "failed",
      proofStatus: "failed",
      summary: error.message,
      checkedAt,
    },
    unavailableBadge("key-binding-checked", "Key binding", "endpointKey", checkedAt),
    unavailableBadge("intel-dcap", "Intel TDX", "cpuTee", checkedAt),
    unavailableBadge("nvidia", "NVIDIA GPU", "gpuTee", checkedAt),
    unavailableBadge("model-artifact", "Model", "model", checkedAt),
    unavailableBadge("request-bound", "Request", "conversation", checkedAt),
    unavailableBadge("transcript-signed", "Transcript", "conversation", checkedAt),
    unavailableBadge("payment-receipt", "Payment", "payment", checkedAt),
  ];
  const payload: JsonValue = {
    schemaVersion: 1,
    instanceId,
    requestUrl: error.requestUrl ?? null,
    nonce: error.nonce ?? null,
    fetchError: {
      code: error.code,
      status: error.status ?? null,
      summary: error.message,
    },
    stages: badges.map(badgeJson),
  };
  const receipt: ConversationReceipt = {
    ...baseReceipt,
    instanceId,
    proofLevel: isEncrypted(baseReceipt) ? "encrypted" : "local",
    posture: isEncrypted(baseReceipt) ? "encrypted-unattested" : baseReceipt.posture,
    claims,
    evidence: { format: "chutes-tee-attestation-attempt/v1", payload },
  };
  return { receipt, badges, portableJson: serializePortableReceipt(receipt) };
}

function evidenceJson(
  evidence: ChutesInstanceEvidence,
  nonce: string,
  e2ePublicKey: string,
): { nonce: string; e2ePublicKey: string; evidence: JsonValue } {
  return {
    nonce,
    e2ePublicKey,
    evidence: {
      quote: evidence.quote,
      gpu_evidence: evidence.gpuEvidence,
      instance_id: evidence.reportedInstanceId ?? null,
      certificate: evidence.certificate,
      ...(evidence.signature ? { signature: evidence.signature } : {}),
      ...(evidence.attestedBody ? { attested_body: evidence.attestedBody } : {}),
    },
  };
}

function badgeJson(badge: AttestationBadge): JsonValue {
  return {
    key: badge.key,
    label: badge.label,
    state: badge.state,
    proofStatus: badge.proofStatus,
    summary: badge.summary,
    claim: badge.claim ?? null,
    verifier: badge.verifier ?? null,
    checkedAt: badge.checkedAt ?? null,
  };
}

function stageProofStatus(state: AttestationStageState): ProofStatus {
  if (state === "present" || state === "matched") return "partial";
  return state;
}

function unavailableClaim(summary: string, checkedAt: string): ReceiptClaim {
  return { status: "unavailable", summary, checkedAt };
}

function unavailableBadge(
  key: AttestationBadge["key"],
  label: string,
  claim: ClaimKey,
  checkedAt: string,
): AttestationBadge {
  return {
    key,
    label,
    state: "unavailable",
    proofStatus: "unavailable",
    summary: "This proof was not checked because evidence fetching failed.",
    claim,
    checkedAt,
  };
}

function optionalBoundedJson(value: JsonValue | undefined, label: string): JsonValue | undefined {
  return value === undefined ? undefined : cloneBoundedJson(value, label);
}

function validExpectedModel(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function redactCredentialShapes(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return value.replace(
      /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:cak|cpk|csc|sk)[_-][A-Za-z0-9._~-]{8,})/giu,
      "[redacted-credential]",
    );
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactCredentialShapes);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactCredentialShapes(item)]),
  );
}

async function digestJson(value: JsonValue): Promise<string> {
  const digestBytes = hexToBytes(await sha256Hex(stableJsonStringify(value)));
  const base64Url = bytesToBase64(digestBytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `sha256:${base64Url}`;
}

function stableJsonStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`)
    .join(",")}}`;
}
