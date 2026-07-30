import type { AttestationClaimState, ChutesEndpointEvidenceRecord } from "../attestation/provider-types";
import type { ClaimKey, ConversationReceipt, ProofStatus, ReceiptClaim, VerificationRecord } from "../receipts/types";

export type ClaimStackSource = "turn-receipt" | "endpoint-evidence";

export type ClaimStackFact = Readonly<{ label: string; value: string }>;

/**
 * The two independent reasons a claim cannot rise above what is shown.
 *
 * They are not one rule and they must never be spoken as one. Nothing in
 * Airship checks a signature, so any copy claiming a receipt "is not signed by
 * a trusted authority" would assert a mechanism the product does not implement.
 * What the code actually computes is:
 *
 * - `receipt-integrity` — `assertedState()` in `attestations-model.ts`: the
 *   receipt's own integrity and the authority embedded in its claims were never
 *   authenticated, so a claim the receipt *declares* verified is shown as an
 *   assertion. Applies to every conversation-receipt claim.
 * - `authority` — `statusWithAuthority()` in `attestations-model.ts`: the
 *   evidence record declared a claim verified without naming any verifier, so
 *   the declaration has no author to check. Applies to endpoint evidence.
 *
 * Both are rendered, separately and by name, wherever a capped figure is shown.
 */
export type ClaimCeiling = "receipt-integrity" | "authority";

/**
 * The model's own word for why a claim sits where it does.
 *
 * The strings are byte-identical to the vocabulary `attestations-model.ts`
 * already emits (`asserted-${declaredState}`, `verified-without-authority`, and
 * the raw provider states) so the Proof route's two tabs share one qualifier
 * dictionary instead of each inventing a second opinion about the same turn.
 */
export type ClaimQualifier =
  | `asserted-${ProofStatus}`
  | "verified-without-authority"
  | AttestationClaimState;

export type ClaimStackItem = Readonly<{
  key: ClaimKey;
  /**
   * The standing Airship will stand behind, after every ceiling is applied.
   *
   * `qualifier` records what the source declared and which rule capped it, so
   * the declared status and the ceiling are read back from it rather than
   * stored beside it — this module is entry-reachable and the startup cap has
   * tens of bytes of headroom. `declaredClaimStatus()` and `claimCeiling()` in
   * `claim-stack-facts.ts` are the readers.
   */
  status: ProofStatus;
  qualifier: ClaimQualifier;
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
      qualifier: "asserted-unavailable" as const,
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

/**
 * What is missing, named, for each of the eight axes.
 *
 * The five bindable axes share one sentence shape because they share one fact:
 * nothing has been bound to a turn. Saying it five different ways ("bound to",
 * "established for", "attached to") suggested five different mechanisms where
 * there is one — and "established" is retired as a verdict word throughout,
 * because the claim rail counted "7 established" to mean *recorded* while the
 * metric beside it read "Not established" to mean *unproven*.
 */
function absentClaimSummary(key: ClaimKey): string {
  if (key === "encryption") return "No completed turn records an authenticated encrypted channel.";
  if (key === "freshness") return "No turn-bound nonce or fresh endpoint evidence is available.";
  if (key === "conversation") return "No request and response commitment exists before the first completed turn.";
  const subject = key === "cpuTee" ? "CPU TEE quote"
    : key === "gpuTee" ? "protected-accelerator evidence"
      : key === "endpointKey" ? "attested endpoint key"
        : key === "model" ? "model artifact or runtime policy"
          : "account-standing or settlement receipt";
  return `No ${subject} has been bound to a completed turn.`;
}

function composeItem(
  key: ClaimKey,
  receipt: ConversationReceipt,
  endpoint: ChutesEndpointEvidenceRecord | undefined,
): ClaimStackItem {
  const verification = receipt.verifications.find((candidate) => candidate.claim === key);
  if (!endpoint || key === "encryption" || key === "conversation" || key === "payment") {
    const claim = receipt.claims[key];
    return Object.freeze({
      key,
      // Ceiling 1, applied to every claim a receipt carries.
      status: claim.status === "verified" ? "partial" : claim.status,
      qualifier: `asserted-${claim.status}` as const,
      source: "turn-receipt",
      claim,
      verification,
      facts: Object.freeze([]),
    });
  }

  if (key === "model") {
    const artifact = endpoint.claims.modelArtifact;
    const policy = endpoint.claims.runtimePolicy;
    const verifier = policy.verifier ?? artifact.verifier;
    const status = combineEndpointStates([artifact.state, policy.state], verifier);
    return Object.freeze({
      key,
      status,
      qualifier: endpointQualifier(policy.state, status),
      source: "endpoint-evidence",
      claim: Object.freeze({
        status,
        summary: [policy.summary, artifact.summary].filter(Boolean).join(" "),
        verifier,
        checkedAt: policy.checkedAt ?? artifact.checkedAt,
      }),
      facts: Object.freeze([
        ...(endpoint.publishedPolicy ? [{ label: "Policy", value: `${endpoint.publishedPolicy.matches[0]?.name ?? `${endpoint.publishedPolicy.policyCount} published candidate${endpoint.publishedPolicy.policyCount === 1 ? "" : "s"}`} · ${endpoint.publishedPolicy.state}` }] : []),
        { label: "Expected GPUs", value: endpoint.publishedPolicy?.matches[0]?.gpuCount?.toString() ?? "Not recorded" },
      ]),
    });
  }

  const providerKey = key === "freshness" ? "nonceFreshness" : key;
  const providerClaim = endpoint.claims[providerKey];
  const status = endpointState(providerClaim.state, providerClaim.verifier);
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
    qualifier: endpointQualifier(providerClaim.state, status),
    source: "endpoint-evidence",
    claim: Object.freeze({ status, summary: providerClaim.summary, verifier: providerClaim.verifier, checkedAt: providerClaim.checkedAt }),
    facts: Object.freeze(facts),
  });
}

/**
 * Ceiling 2: "verified" needs somebody who did the verifying.
 *
 * Mirrors `statusWithAuthority()` in `attestations-model.ts`. A record that
 * declares a claim verified without naming a verifier has made an assertion,
 * because there is no author to check. This is the ceiling that stopped the
 * Proof route's primary tab printing a green "VERIFIED · Protected CPU
 * runtime" for the exact turn whose Attestation tab read "Asserted".
 *
 * Both ceilings run in one direction only: they may lower a declared
 * `verified` and may never soften a negative. `assertedState()` used to map
 * `failed` to `partial` as well, which printed "Asserted" on the Attestation
 * tab for a claim this tab already called "Failed" — one turn, two verdicts,
 * one click apart. It now stops at `verified` for the same reason this model
 * always did: fail-closed means a stated failure keeps full weight even when
 * nobody authenticated the statement.
 */
function endpointQualifier(declared: AttestationClaimState, status: ProofStatus): ClaimQualifier {
  return declared === "verified" && status !== "verified" ? "verified-without-authority" : declared;
}

/**
 * The one endpoint record a receipt's claim stack may read.
 *
 * Selection is by instance AND endpoint-key digest — the same identity the
 * inspector (`attestationRecordMatchesReceipt`) and the export bundle already
 * bind on. An instance-only match picks the first record after an endpoint
 * re-key, which left the claim stack reporting "absent" while the same
 * route's export carried the matching evidence.
 */
export function claimStackEndpointRecord(
  records: readonly ChutesEndpointEvidenceRecord[],
  receipt: ConversationReceipt | undefined,
): ChutesEndpointEvidenceRecord | undefined {
  return receipt
    ? records.find((record) => endpointRecordMatchesReceiptSubject(record, receipt))
    : undefined;
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

function endpointState(state: AttestationClaimState, verifier?: string): ProofStatus {
  if (state === "verified") return verifier && verifier !== "unavailable" ? "verified" : "partial";
  if (state === "failed") return "failed";
  if (state === "expired") return "expired";
  if (state === "matched" || state === "present" || state === "unverified") return "partial";
  return "unavailable";
}

function combineEndpointStates(states: readonly AttestationClaimState[], verifier?: string): ProofStatus {
  const normalized = states.map((state) => endpointState(state, verifier));
  if (normalized.some((state) => state === "failed")) return "failed";
  if (normalized.some((state) => state === "expired")) return "expired";
  if (normalized.every((state) => state === "verified")) return "verified";
  if (normalized.some((state) => state === "partial" || state === "verified")) return "partial";
  return "unavailable";
}

/** Freezes the group container and each list inside it, in one pass. */
function freezeGroups(groups: ClaimStackModel["groups"]): ClaimStackModel["groups"] {
  for (const items of Object.values(groups)) Object.freeze(items);
  return Object.freeze(groups);
}
