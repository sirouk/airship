import type { AttestationClaimState, ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import type { ClaimKey, ConversationReceipt, ProofStatus, ReceiptClaim, VerificationRecord } from "../receipts/types";

export type ClaimStackSource = "turn-receipt" | "endpoint-evidence";

export type ClaimStackFact = Readonly<{ label: string; value: string }>;

export type ClaimStackItem = Readonly<{
  key: ClaimKey;
  status: ProofStatus;
  source: ClaimStackSource;
  claim: ReceiptClaim;
  verification?: VerificationRecord;
  facts: readonly ClaimStackFact[];
}>;

export type ClaimStackModel = Readonly<{
  /** Relationship between the displayed endpoint record and this exact receipt. */
  evidence: "turn-bound" | "same-endpoint" | "stale-turn-bound" | "stale-same-endpoint" | "absent";
  evidenceSummary: string;
  items: readonly ClaimStackItem[];
  groups: Readonly<{
    failed: readonly ClaimStackItem[];
    verified: readonly ClaimStackItem[];
    asserted: readonly ClaimStackItem[];
    unavailable: readonly ClaimStackItem[];
  }>;
}>;

const claimKeys = ["encryption", "freshness", "cpuTee", "gpuTee", "endpointKey", "model", "conversation", "payment"] as const;

export function composeClaimStack(
  receipt: ConversationReceipt | undefined,
  endpointRecord: ChutesEndpointEvidenceRecord | undefined,
  now = Date.now(),
): ClaimStackModel {
  if (!receipt) {
    const unavailable = claimKeys.map((key) => Object.freeze({
      key,
      status: "unavailable" as const,
      source: "turn-receipt" as const,
      claim: Object.freeze({
        status: "unavailable" as const,
        summary: absentClaimSummary(key),
      }),
      facts: Object.freeze([]),
    }));
    return Object.freeze({
      evidence: "absent",
      evidenceSummary: "Complete a turn to create a receipt and bind endpoint evidence.",
      items: Object.freeze(unavailable),
      groups: freezeGroups({ failed: [], verified: [], asserted: [], unavailable }),
    });
  }

  const sameEndpoint = endpointRecordMatchesReceiptSubject(endpointRecord, receipt);
  const turnBound = sameEndpoint && endpointRecordMatchesReceiptEvidence(endpointRecord!, receipt);
  const fresh = sameEndpoint && isDisplayFresh(endpointRecord!, now);
  const evidence = turnBound
    ? fresh ? "turn-bound" : "stale-turn-bound"
    : sameEndpoint
      ? fresh ? "same-endpoint" : "stale-same-endpoint"
      : "absent";
  // Endpoint claims may alter the composed receipt view only when the receipt
  // records the exact normalized evidence digest. A later fetch from the same
  // instance/key remains visible as a comparison, never as turn evidence.
  const endpoint = turnBound && fresh ? endpointRecord : undefined;
  const items = claimKeys.map((key) => composeItem(key, receipt, endpoint));
  const groups = freezeGroups({
    failed: items.filter((item) => item.status === "failed" || item.status === "expired"),
    verified: items.filter((item) => item.status === "verified"),
    asserted: items.filter((item) => item.status === "partial"),
    unavailable: items.filter((item) => item.status === "unavailable"),
  });
  return Object.freeze({
    evidence,
    evidenceSummary: evidence === "turn-bound"
      ? "The normalized endpoint-evidence payload digest exactly matches the digest recorded by this receipt. Claims retain their separate authorities; this local binding is not an enclave-signed conversation proof."
      : evidence === "same-endpoint"
        ? "This separately fetched record matches only the receipt’s instance and endpoint-key digest. It is not bound to this exact turn, so its endpoint claims are not composed into the receipt."
        : evidence === "stale-turn-bound"
          ? "The endpoint-evidence payload digest matches this receipt, but the record is outside Airship’s display-freshness window. Its claims are not composed as current evidence."
          : evidence === "stale-same-endpoint"
            ? "A record for the same instance and endpoint key is outside Airship’s display-freshness window and is not bound to this exact turn."
            : "This turn has no matching endpoint evidence. Receipt assertions remain visible, but hardware claims are not inferred.",
    items: Object.freeze(items),
    groups,
  });
}

function absentClaimSummary(key: ClaimKey): string {
  if (key === "encryption") return "No completed turn records an authenticated encrypted channel.";
  if (key === "freshness") return "No turn-bound nonce or fresh endpoint evidence is available.";
  if (key === "cpuTee") return "No CPU TEE quote has been bound to a completed turn.";
  if (key === "gpuTee") return "No protected-accelerator evidence has been bound to a completed turn.";
  if (key === "endpointKey") return "No attested endpoint key has been bound to a completed turn.";
  if (key === "model") return "No model artifact or runtime policy has been established for a completed turn.";
  if (key === "conversation") return "No request and response commitment exists before the first completed turn.";
  return "No account-standing or settlement receipt has been attached to a completed turn.";
}

function composeItem(
  key: ClaimKey,
  receipt: ConversationReceipt,
  endpoint: ChutesEndpointEvidenceRecord | undefined,
): ClaimStackItem {
  const verification = receipt.verifications.find((candidate) => candidate.claim === key);
  if (!endpoint || key === "encryption" || key === "conversation" || key === "payment") {
    return Object.freeze({ key, status: receipt.claims[key].status, source: "turn-receipt", claim: receipt.claims[key], verification, facts: Object.freeze([]) });
  }

  if (key === "model") {
    const artifact = endpoint.claims.modelArtifact;
    const policy = endpoint.claims.runtimePolicy;
    const status = combineEndpointStates([artifact.state, policy.state]);
    return Object.freeze({
      key,
      status,
      source: "endpoint-evidence",
      claim: Object.freeze({
        status,
        summary: [policy.summary, artifact.summary].filter(Boolean).join(" "),
        verifier: policy.verifier ?? artifact.verifier,
        checkedAt: policy.checkedAt ?? artifact.checkedAt,
      }),
      facts: Object.freeze([
        ...(endpoint.publishedPolicy ? [{ label: "Policy", value: `${endpoint.publishedPolicy.matches[0]?.name ?? `${endpoint.publishedPolicy.policyCount} published candidate${endpoint.publishedPolicy.policyCount === 1 ? "" : "s"}`} · ${endpoint.publishedPolicy.state}` }] : []),
        { label: "Expected GPUs", value: endpoint.publishedPolicy?.matches[0]?.gpuCount?.toString() ?? "Not established" },
      ]),
    });
  }

  const providerKey = key === "freshness" ? "nonceFreshness" : key;
  const providerClaim = endpoint.claims[providerKey];
  const status = endpointState(providerClaim.state);
  const facts: ClaimStackFact[] = key === "freshness"
    ? [
        { label: "Fetched", value: endpoint.acquisition.fetchedAt },
        { label: "Display fresh until", value: endpoint.acquisition.cacheFreshUntil },
      ]
    : key === "cpuTee"
      ? [{ label: "TDX quote", value: `${endpoint.evidence.quoteBytes.toLocaleString()} bytes · v${endpoint.evidence.quote.version}` }]
      : key === "gpuTee"
        ? [{ label: "GPU evidence", value: `${endpoint.evidence.gpuDeviceCount} device record${endpoint.evidence.gpuDeviceCount === 1 ? "" : "s"}` }]
        : key === "endpointKey"
          ? [
              { label: "Binding", value: endpoint.binding.state },
              { label: "Key digest", value: endpoint.subject.e2ePublicKeyDigest },
            ]
          : [];
  return Object.freeze({
    key,
    status,
    source: "endpoint-evidence",
    claim: Object.freeze({ status, summary: providerClaim.summary, verifier: providerClaim.verifier, checkedAt: providerClaim.checkedAt }),
    facts: Object.freeze(facts),
  });
}

function endpointRecordMatchesReceiptSubject(record: ChutesEndpointEvidenceRecord | undefined, receipt: ConversationReceipt): boolean {
  return Boolean(record && receipt.instanceId && receipt.bindings.endpointKeyDigest &&
    record.subject.instanceId === receipt.instanceId &&
    record.subject.e2ePublicKeyDigest === receipt.bindings.endpointKeyDigest);
}

function endpointRecordMatchesReceiptEvidence(record: ChutesEndpointEvidenceRecord, receipt: ConversationReceipt): boolean {
  return Boolean(
    receipt.bindings.evidenceDigest &&
    record.evidence.payloadDigest === receipt.bindings.evidenceDigest,
  );
}

function isDisplayFresh(record: ChutesEndpointEvidenceRecord, now: number): boolean {
  const deadline = Date.parse(record.acquisition.cacheFreshUntil);
  return Number.isFinite(deadline) && deadline > now;
}

function endpointState(state: AttestationClaimState): ProofStatus {
  if (state === "verified") return "verified";
  if (state === "failed") return "failed";
  if (state === "expired") return "expired";
  if (state === "matched" || state === "present" || state === "unverified") return "partial";
  return "unavailable";
}

function combineEndpointStates(states: readonly AttestationClaimState[]): ProofStatus {
  const normalized = states.map(endpointState);
  if (normalized.some((state) => state === "failed")) return "failed";
  if (normalized.some((state) => state === "expired")) return "expired";
  if (normalized.every((state) => state === "verified")) return "verified";
  if (normalized.some((state) => state === "partial" || state === "verified")) return "partial";
  return "unavailable";
}

function freezeGroups(groups: {
  failed: ClaimStackItem[];
  verified: ClaimStackItem[];
  asserted: ClaimStackItem[];
  unavailable: ClaimStackItem[];
}): ClaimStackModel["groups"] {
  return Object.freeze({
    failed: Object.freeze(groups.failed),
    verified: Object.freeze(groups.verified),
    asserted: Object.freeze(groups.asserted),
    unavailable: Object.freeze(groups.unavailable),
  });
}
