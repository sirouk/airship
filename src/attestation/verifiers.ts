import { cloneBoundedJson } from "./client";
import type {
  DcapVerificationResult,
  DcapVerifierInput,
  EvaluatedVerification,
  ModelVerificationResult,
  ModelVerifierInput,
  NvidiaVerificationResult,
  NvidiaVerifierInput,
  NonVerifiedResult,
  PaymentVerificationResult,
  PaymentVerifierInput,
  TranscriptVerificationResult,
  TranscriptVerifierInput,
  VerifierPort,
  AttestationVerifierPorts,
} from "./types";

const MAX_VERIFIER_ID_LENGTH = 128;
const MAX_SUMMARY_LENGTH = 512;
const MAX_DIGEST_LENGTH = 512;

export const UNAVAILABLE_VERIFIER_PORTS: Readonly<AttestationVerifierPorts> = Object.freeze({});

export async function evaluateDcapVerifier(
  port: VerifierPort<DcapVerifierInput, DcapVerificationResult> | undefined,
  input: DcapVerifierInput,
  checkedAt: string,
  signal?: AbortSignal,
): Promise<EvaluatedVerification<DcapVerificationResult>> {
  return evaluate(
    "intel-dcap",
    "cpuTee",
    port,
    input,
    checkedAt,
    isDcapResult,
    "No Intel DCAP verifier is configured in this browser runtime.",
    signal,
  );
}

export async function evaluateNvidiaVerifier(
  port: VerifierPort<NvidiaVerifierInput, NvidiaVerificationResult> | undefined,
  input: NvidiaVerifierInput,
  checkedAt: string,
  signal?: AbortSignal,
): Promise<EvaluatedVerification<NvidiaVerificationResult>> {
  if (input.gpuEvidence.length === 0) {
    return unavailable(
      "gpuTee",
      "nvidia",
      "The evidence response did not contain NVIDIA GPU evidence.",
      checkedAt,
    );
  }
  return evaluate(
    "nvidia",
    "gpuTee",
    port,
    input,
    checkedAt,
    isNvidiaResult,
    "No NVIDIA attestation verifier is configured in this browser runtime.",
    signal,
  );
}

export async function evaluateModelVerifier(
  port: VerifierPort<ModelVerifierInput, ModelVerificationResult> | undefined,
  input: ModelVerifierInput | undefined,
  checkedAt: string,
  signal?: AbortSignal,
): Promise<EvaluatedVerification<ModelVerificationResult>> {
  if (!input) {
    return unavailable(
      "model",
      "model-artifact",
      "An expected model identifier is required before a model artifact can be verified.",
      checkedAt,
    );
  }
  return evaluate(
    "model-artifact",
    "model",
    port,
    input,
    checkedAt,
    isModelResult,
    "No model-artifact verifier is configured in this browser runtime.",
    signal,
  );
}

export async function evaluateTranscriptVerifier(
  port: VerifierPort<TranscriptVerifierInput, TranscriptVerificationResult> | undefined,
  input: TranscriptVerifierInput | undefined,
  checkedAt: string,
  signal?: AbortSignal,
): Promise<EvaluatedVerification<TranscriptVerificationResult>> {
  if (!input) {
    return unavailable(
      "conversation",
      "transcript",
      "Request and response digests are required before a transcript can be verified.",
      checkedAt,
    );
  }
  const evaluation = await evaluate(
    "transcript",
    "conversation",
    port,
    input,
    checkedAt,
    isTranscriptResult,
    "No enclave transcript-signature verifier is configured in this browser runtime.",
    signal,
  );
  const result = evaluation.result;
  if (
    result.status === "verified" &&
    (result.requestDigest !== input.requestDigest || result.responseDigest !== input.responseDigest)
  ) {
    return failed(
      "conversation",
      evaluation.verifier,
      evaluation.version,
      "Transcript verifier returned digests that do not match the receipt.",
      checkedAt,
    );
  }
  return evaluation;
}

export async function evaluatePaymentVerifier(
  port: VerifierPort<PaymentVerifierInput, PaymentVerificationResult> | undefined,
  input: PaymentVerifierInput,
  checkedAt: string,
  signal?: AbortSignal,
): Promise<EvaluatedVerification<PaymentVerificationResult>> {
  return evaluate(
    "payment",
    "payment",
    port,
    input,
    checkedAt,
    isPaymentResult,
    "No payment-receipt verifier is configured in this browser runtime.",
    signal,
  );
}

async function evaluate<Input, Result extends { status: string; summary: string }>(
  name: string,
  claim: "cpuTee" | "gpuTee" | "model" | "conversation" | "payment",
  port: VerifierPort<Input, Result> | undefined,
  input: Input,
  checkedAt: string,
  validate: (value: unknown) => value is Result,
  unavailableSummary: string,
  signal?: AbortSignal,
): Promise<EvaluatedVerification<Result>> {
  if (!port) return unavailable(claim, name, unavailableSummary, checkedAt);

  let verifier: string;
  let version: string;
  try {
    verifier = boundedString(port.id, "verifier id", MAX_VERIFIER_ID_LENGTH);
    version = boundedString(port.version, "verifier version", MAX_VERIFIER_ID_LENGTH);
  } catch {
    return failed(claim, "invalid-verifier", "unknown", "Verifier identity is invalid.", checkedAt);
  }

  let raw: unknown;
  try {
    raw = await port.verify(input, signal);
  } catch {
    return failed(claim, verifier, version, `${name} verifier threw an error.`, checkedAt);
  }
  if (!validate(raw)) {
    return failed(
      claim,
      verifier,
      version,
      `${name} verifier returned an invalid or incomplete result.`,
      checkedAt,
    );
  }

  let result: Result;
  try {
    result = sanitizeResult(raw);
  } catch {
    return failed(
      claim,
      verifier,
      version,
      `${name} verifier returned unbounded result data.`,
      checkedAt,
    );
  }

  const policyDigest =
    "policyDigest" in result && typeof result.policyDigest === "string"
      ? result.policyDigest
      : undefined;
  return {
    result,
    verifier,
    version,
    record: {
      verifier,
      version,
      checkedAt,
      status: result.status as "verified" | "partial" | "failed" | "expired" | "unavailable",
      claim,
      policyDigest,
      detail: result.summary,
    },
  };
}

function unavailable<Result>(
  claim: "cpuTee" | "gpuTee" | "model" | "conversation" | "payment",
  verifier: string,
  summary: string,
  checkedAt: string,
): EvaluatedVerification<Result> {
  const result: NonVerifiedResult = { status: "unavailable", summary };
  return {
    result,
    verifier,
    version: "unavailable",
    record: {
      verifier,
      version: "unavailable",
      checkedAt,
      status: "unavailable",
      claim,
      detail: summary,
    },
  };
}

function failed<Result>(
  claim: "cpuTee" | "gpuTee" | "model" | "conversation" | "payment",
  verifier: string,
  version: string,
  summary: string,
  checkedAt: string,
): EvaluatedVerification<Result> {
  const result: NonVerifiedResult = { status: "failed", summary };
  return {
    result,
    verifier,
    version,
    record: {
      verifier,
      version,
      checkedAt,
      status: "failed",
      claim,
      detail: summary,
    },
  };
}

function isDcapResult(value: unknown): value is DcapVerificationResult {
  if (isNonVerified(value)) return true;
  return (
    isRecord(value) &&
    value.status === "verified" &&
    boundedBooleanTrue(value.signatureVerified) &&
    boundedBooleanTrue(value.tcbVerified) &&
    boundedBooleanTrue(value.policyVerified) &&
    boundedBooleanTrue(value.debugDisabled) &&
    isBoundedString(value.summary, MAX_SUMMARY_LENGTH) &&
    isBoundedString(value.policyDigest, MAX_DIGEST_LENGTH) &&
    isOptionalJson(value.details)
  );
}

function isNvidiaResult(value: unknown): value is NvidiaVerificationResult {
  if (isNonVerified(value)) return true;
  return (
    isRecord(value) &&
    value.status === "verified" &&
    boundedBooleanTrue(value.allDevicesVerified) &&
    boundedBooleanTrue(value.confidentialComputeVerified) &&
    boundedBooleanTrue(value.bindingVerified) &&
    isBoundedString(value.summary, MAX_SUMMARY_LENGTH) &&
    isBoundedString(value.policyDigest, MAX_DIGEST_LENGTH) &&
    isOptionalJson(value.details)
  );
}

function isModelResult(value: unknown): value is ModelVerificationResult {
  if (isNonVerified(value)) return true;
  return (
    isRecord(value) &&
    value.status === "verified" &&
    boundedBooleanTrue(value.artifactVerified) &&
    boundedBooleanTrue(value.measurementBound) &&
    isBoundedString(value.summary, MAX_SUMMARY_LENGTH) &&
    isBoundedString(value.artifactDigest, MAX_DIGEST_LENGTH) &&
    isBoundedString(value.policyDigest, MAX_DIGEST_LENGTH) &&
    isOptionalJson(value.details)
  );
}

function isTranscriptResult(value: unknown): value is TranscriptVerificationResult {
  if (isNonVerified(value)) return true;
  return (
    isRecord(value) &&
    value.status === "verified" &&
    boundedBooleanTrue(value.signatureVerified) &&
    boundedBooleanTrue(value.endpointBound) &&
    boundedBooleanTrue(value.requestBound) &&
    boundedBooleanTrue(value.responseBound) &&
    isBoundedString(value.summary, MAX_SUMMARY_LENGTH) &&
    isBoundedString(value.requestDigest, MAX_DIGEST_LENGTH) &&
    isBoundedString(value.responseDigest, MAX_DIGEST_LENGTH) &&
    isBoundedString(value.signer, MAX_VERIFIER_ID_LENGTH) &&
    isBoundedString(value.signatureAlgorithm, MAX_VERIFIER_ID_LENGTH) &&
    (value.policyDigest === undefined || isBoundedString(value.policyDigest, MAX_DIGEST_LENGTH)) &&
    isOptionalJson(value.details)
  );
}

function isPaymentResult(value: unknown): value is PaymentVerificationResult {
  if (isNonVerified(value)) return true;
  return (
    isRecord(value) &&
    value.status === "verified" &&
    boundedBooleanTrue(value.settlementVerified) &&
    isBoundedString(value.summary, MAX_SUMMARY_LENGTH) &&
    isBoundedString(value.receiptDigest, MAX_DIGEST_LENGTH) &&
    (value.policyDigest === undefined || isBoundedString(value.policyDigest, MAX_DIGEST_LENGTH)) &&
    isOptionalJson(value.details)
  );
}

function isNonVerified(value: unknown): value is NonVerifiedResult {
  return (
    isRecord(value) &&
    (value.status === "partial" || value.status === "failed" || value.status === "expired" || value.status === "unavailable") &&
    isBoundedString(value.summary, MAX_SUMMARY_LENGTH) &&
    isOptionalJson(value.details)
  );
}

function sanitizeResult<Result extends { status: string; summary: string }>(value: Result): Result {
  const clone = cloneBoundedJson(value, "verifier result");
  return clone as unknown as Result;
}

function isOptionalJson(value: unknown): boolean {
  if (value === undefined) return true;
  try {
    cloneBoundedJson(value, "verifier result details");
    return true;
  } catch {
    return false;
  }
}

function boundedBooleanTrue(value: unknown): value is true {
  return value === true;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (!isBoundedString(value, maximum)) throw new Error(`${label} is invalid`);
  return value;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
