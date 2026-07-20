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
  evidence: "matched" | "stale" | "absent";
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
    return Object.freeze({
      evidence: "absent",
      evidenceSummary: "Complete a turn to create a receipt and bind endpoint evidence.",
      items: Object.freeze([]),
      groups: freezeGroups({ failed: [], verified: [], asserted: [], unavailable: [] }),
    });
  }

  const matches = endpointRecordMatchesReceipt(endpointRecord, receipt);
  const fresh = matches && isDisplayFresh(endpointRecord!, now);
  const evidence = fresh ? "matched" : matches ? "stale" : "absent";
  const endpoint = fresh ? endpointRecord : undefined;
  const items = claimKeys.map((key) => composeItem(key, receipt, endpoint));
  const groups = freezeGroups({
    failed: items.filter((item) => item.status === "failed" || item.status === "expired"),
    verified: items.filter((item) => item.status === "verified"),
    asserted: items.filter((item) => item.status === "partial"),
    unavailable: items.filter((item) => item.status === "unavailable"),
  });
  return Object.freeze({
    evidence,
    evidenceSummary: evidence === "matched"
      ? "Current endpoint evidence is joined to this turn by instance and endpoint-key digest. Each claim retains its own authority."
      : evidence === "stale"
        ? "Matching endpoint evidence is outside Airship’s display-freshness window. Refresh it before relying on a current comparison."
        : "This turn has no matching endpoint evidence. Receipt assertions remain visible, but hardware claims are not inferred.",
    items: Object.freeze(items),
    groups,
  });
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

function endpointRecordMatchesReceipt(record: ChutesEndpointEvidenceRecord | undefined, receipt: ConversationReceipt): boolean {
  return Boolean(record && receipt.instanceId && receipt.bindings.endpointKeyDigest &&
    record.subject.instanceId === receipt.instanceId &&
    record.subject.e2ePublicKeyDigest === receipt.bindings.endpointKeyDigest);
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
