/** Invocation-time Chutes endpoint attestation with bounded non-binary output. */
import {
  AttestationEvidenceClientError,
  ChutesAttestationEvidenceClient,
} from "../../attestation/provider-client";
import { createIntelDcapQvlVerifierPort } from "../../attestation/dcap/intel-dcap-qvl";
import type {
  AttestationClaimState,
  AttestationClaimSummary,
  ChutesEndpointEvidenceRecord,
} from "../../attestation/provider-types";
import type { ProofStatus, ReceiptClaim } from "../../receipts/types";
import type {
  AttestationGate,
  AttestationGateResult,
  AttestationSubject,
  EvaluatedEndpointAttestation,
} from "./attestation";

const GATE_FRESHNESS_MS = 5 * 60_000;

/**
 * Build-time verifier capability, not a provider/model assertion. The shipped
 * browser verifier authenticates NVIDIA device evidence but cannot yet perform
 * the nonce-bound RIM, revocation, and freshness checks needed to promote the
 * GPU claim from `matched` to `verified`. Keep strict mode visibly unavailable
 * until that independent verifier path exists instead of offering a policy
 * that is guaranteed to reject every turn.
 */
export const CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY = Object.freeze({
  available: false,
  reason: "Independent NVIDIA GPU verification is not yet browser-complete; strict endpoint proof would reject every turn.",
});

function toProofStatus(state: AttestationClaimState): ProofStatus {
  return state === "verified"
    ? "verified"
    : state === "matched" || state === "present" || state === "unverified"
      ? "partial"
      : state === "failed"
        ? "failed"
        : state === "expired"
          ? "expired"
          : "unavailable";
}

function toReceiptClaim(
  claim: AttestationClaimSummary,
  checkedAt: string,
  policyDigest?: string,
): ReceiptClaim {
  return {
    status: toProofStatus(claim.state),
    summary: claim.summary,
    ...(claim.verifier ? { verifier: claim.verifier } : {}),
    ...(policyDigest ? { policyDigest } : {}),
    checkedAt,
  };
}

type EvidenceClient = Pick<ChutesAttestationEvidenceClient, "get">;

export function createChutesAttestationGate(options: Readonly<{
  getBearerToken: (signal: AbortSignal) => string | Promise<string>;
  apiBase?: string;
}>): AttestationGate {
  const client = new ChutesAttestationEvidenceClient({
    authorization: {
      kind: "api-key",
      cachePartition: `gate-${globalThis.crypto?.randomUUID?.() ?? "session"}`,
      getBearerToken: options.getBearerToken,
    },
    verifierPorts: { dcap: createIntelDcapQvlVerifierPort() },
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
  });
  return createChutesAttestationGateFromClient(client);
}

/** Exported for contract tests and alternative in-browser evidence clients. */
export function createChutesAttestationGateFromClient(
  client: EvidenceClient,
  now: () => number = Date.now,
): AttestationGate {
  return {
    async verifyEndpoint(subject, signal): Promise<AttestationGateResult> {
      let record: ChutesEndpointEvidenceRecord;
      try {
        record = await acquireExactRecord(client, subject, signal);
      } catch (error) {
        return {
          unavailableReason: error instanceof AttestationEvidenceClientError
            ? error.message
            : "Endpoint evidence acquisition failed.",
        };
      }

      const checkedAt = record.claims.endpointKey.checkedAt ?? new Date(now()).toISOString();
      if (!matchesExactSubject(record, subject)) {
        return {
          evaluation: rejectedSubjectEvaluation(checkedAt),
          unavailableReason: "Endpoint evidence did not match the exact discovered chute, instance, and E2EE key.",
        };
      }

      const evaluation = evaluationFromRecord(record, checkedAt);
      const policyFailure = verifiedEndpointPolicyFailure(record);
      if (policyFailure) {
        return {
          evaluation,
          unavailableReason: policyFailure,
        };
      }

      const verifiedAtMs = now();
      const verifiedAt = new Date(verifiedAtMs).toISOString();
      return {
        evaluation,
        receipt: {
          version: 1,
          status: "verified",
          provider: "chutes",
          chuteId: subject.chuteId,
          instanceId: subject.instanceId,
          e2ePublicKey: subject.e2ePublicKey,
          verifiedAt,
          expiresAt: new Date(verifiedAtMs + GATE_FRESHNESS_MS).toISOString(),
          verifier: "airship-endpoint-gate",
          verifierVersion: "1.1.0",
          ...(record.publishedPolicy?.policyDigest ? { policyDigest: record.publishedPolicy.policyDigest } : {}),
          cpuTee: toReceiptClaim(record.claims.cpuTee, checkedAt),
          gpuTee: toReceiptClaim(record.claims.gpuTee, checkedAt),
        },
      };
    },
  };
}

/**
 * Chutes inference endpoints are CPU + GPU confidential-compute subjects. A
 * verified CPU quote cannot promote the aggregate endpoint/TEE posture while
 * the accelerator claim is merely present or partially authenticated. The
 * current browser NVIDIA verifier deliberately tops out at `matched`, so this
 * gate remains partial until an independent verifier establishes nonce-bound
 * GPU authenticity, firmware/RIM policy, revocation, and freshness.
 */
function verifiedEndpointPolicyFailure(record: ChutesEndpointEvidenceRecord): string | undefined {
  if (record.verdict !== "evidence-only") {
    return "Endpoint evidence was rejected and cannot satisfy the verified endpoint policy.";
  }
  if (
    record.binding.state !== "matched" ||
    record.claims.nonceFreshness.state !== "matched" ||
    record.claims.endpointKey.state !== "matched"
  ) {
    return "Endpoint evidence did not establish the fresh nonce and exact E2EE endpoint-key binding.";
  }
  if (record.claims.cpuTee.state !== "verified") {
    return "Endpoint evidence is not fully attested: independent Intel TDX verification did not reach verified.";
  }
  if (record.claims.gpuTee.state !== "verified") {
    return `Endpoint evidence is not fully attested: independent NVIDIA GPU verification did not reach verified (claim state: ${record.claims.gpuTee.state}).`;
  }
  if (record.claims.runtimePolicy.state !== "matched") {
    return "Endpoint evidence did not match the required runtime measurement policy.";
  }
  return undefined;
}

async function acquireExactRecord(
  client: EvidenceClient,
  subject: AttestationSubject,
  signal: AbortSignal,
): Promise<ChutesEndpointEvidenceRecord> {
  const request = {
    chuteId: subject.chuteId,
    instanceId: subject.instanceId,
    e2ePublicKey: subject.e2ePublicKey,
    includePublishedPolicy: true,
    forceRefresh: true,
    signal,
  } as const;
  try {
    return await client.get({ ...request, route: "instance" });
  } catch (error) {
    if (!(error instanceof AttestationEvidenceClientError) || !["unauthorized", "forbidden"].includes(error.code)) {
      throw error;
    }
    // The public chute response may contain many instances. Provider-client
    // selection is constrained to this exact authenticated discovery subject,
    // and the explicit postcondition below rejects any substituted record.
    const record = await client.get({ ...request, route: "public-chute" });
    if (!matchesExactSubject(record, subject)) {
      throw new AttestationEvidenceClientError(
        "subject-not-found",
        "Public endpoint evidence did not contain the exact authenticated discovery instance and key.",
      );
    }
    return record;
  }
}

function matchesExactSubject(record: ChutesEndpointEvidenceRecord, subject: AttestationSubject): boolean {
  return record.subject.chuteId === subject.chuteId
    && record.subject.instanceId === subject.instanceId
    && record.subject.e2ePublicKey === subject.e2ePublicKey;
}

function evaluationFromRecord(
  record: ChutesEndpointEvidenceRecord,
  checkedAt: string,
): EvaluatedEndpointAttestation {
  return {
    checkedAt,
    freshness: toReceiptClaim(record.claims.nonceFreshness, checkedAt),
    endpointKey: toReceiptClaim(record.claims.endpointKey, checkedAt),
    cpuTee: toReceiptClaim(record.claims.cpuTee, checkedAt),
    gpuTee: toReceiptClaim(record.claims.gpuTee, checkedAt),
    runtimePolicy: toReceiptClaim(
      record.claims.runtimePolicy,
      checkedAt,
      record.publishedPolicy?.policyDigest,
    ),
    evidenceDigest: record.evidence.payloadDigest,
    evidenceFormat: record.evidence.format,
  };
}

function rejectedSubjectEvaluation(checkedAt: string): EvaluatedEndpointAttestation {
  const unavailable = (summary: string): ReceiptClaim => ({ status: "unavailable", summary, checkedAt });
  return {
    checkedAt,
    freshness: unavailable("Freshness was not projected from evidence for a different endpoint subject."),
    endpointKey: {
      status: "failed",
      summary: "Endpoint evidence did not match the exact discovered chute, instance, and E2EE key.",
      verifier: "airship-endpoint-gate",
      checkedAt,
    },
    cpuTee: unavailable("CPU TEE state was not projected from evidence for a different endpoint subject."),
    gpuTee: unavailable("GPU TEE state was not projected from evidence for a different endpoint subject."),
    runtimePolicy: unavailable("Runtime policy was not projected from evidence for a different endpoint subject."),
  };
}
