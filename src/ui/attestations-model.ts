import type { JsonValue } from "../core/contracts";
import type {
  AttestationClaimState,
  ChutesEndpointEvidenceRecord,
} from "../attestation/provider-client";
import type {
  ClaimKey,
  ConversationReceipt,
  ProofLevel,
  ProofStatus,
  VerificationRecord,
} from "../receipts/types";

export const ATTESTATION_DIMENSIONS = [
  "transport",
  "freshness",
  "cpu-tee",
  "gpu-tee",
  "endpoint-key",
  "model",
  "conversation",
  "payment",
] as const;

export type AttestationDimensionKey = (typeof ATTESTATION_DIMENSIONS)[number];
export type AttestationRecordSource = "endpoint-evidence" | "conversation-receipt";
export type AttestationAuthorityKind = "local" | "external" | "mixed" | "none";

export type AttestationFact = Readonly<{
  key: string;
  label: string;
  value: string;
  kind: "digest" | "measurement" | "timestamp" | "identity" | "count" | "property";
}>;

export type AttestationDimension = Readonly<{
  key: AttestationDimensionKey;
  title: string;
  state: ProofStatus;
  /** Exact provider/receipt vocabulary. `matched` is intentionally not verified. */
  qualifier: string;
  summary: string;
  authority: string;
  authorityKind: AttestationAuthorityKind;
  checkedAt?: string;
  expiresAt?: string;
  policyDigest?: string;
  facts: readonly AttestationFact[];
}>;

export type AttestationVerification = Readonly<{
  id: string;
  claim: string;
  title: string;
  state: ProofStatus;
  qualifier: string;
  authority: string;
  authorityKind: AttestationAuthorityKind;
  version?: string;
  checkedAt?: string;
  policyDigest?: string;
  summary: string;
  facts: readonly AttestationFact[];
}>;

export type NormalizedAttestationRecord = Readonly<{
  id: string;
  sourceId: string;
  source: AttestationRecordSource;
  provider: string;
  title: string;
  subtitle: string;
  createdAt?: string;
  /** Client memory-cache deadline; never presented as evidence expiry. */
  cacheFreshUntil?: string;
  instanceId?: string;
  model?: string;
  posture?: string;
  proofLevel?: ProofLevel;
  evidenceFormat?: string;
  /** Receipt claims are assertion-only unless an upstream digest-and-policy validator supplied a bound marker. */
  receiptTrust?: "asserted";
  overallState: ProofStatus;
  dimensions: Readonly<Record<AttestationDimensionKey, AttestationDimension>>;
  verifications: readonly AttestationVerification[];
  bindings: readonly AttestationFact[];
  evidenceFacts: readonly AttestationFact[];
  warnings: readonly string[];
}>;

export type NormalizeAttestationInput = Readonly<{
  endpointRecords?: readonly ChutesEndpointEvidenceRecord[];
  /** Structurally valid but unauthenticated receipts; a declared verification renders as an assertion, a declared failure keeps its full weight. */
  receipts?: readonly ConversationReceipt[];
}>;

const MAX_RECORDS_PER_SOURCE = 128;
export const MAX_ATTESTATION_INPUTS_PER_SOURCE = 512;
const MAX_VERIFICATIONS = 256;
const MAX_FACTS = 64;
const MAX_TEXT = 768;
const MAX_ID = 256;
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:cak|cpk|csc|sk)[_-][A-Za-z0-9_-]{8,})/giu;
const LOCAL_VERIFIER_IDS = new Set([
  "airship-client",
  "airship-local-binding",
  "airship-local-request-binding",
  "airship-attestation-composer",
  "airship-structural-check/v1",
  "airship-nvidia-spdm-binding/v1",
]);
const LOCAL_VERIFIER_PATTERNS = Object.freeze([
  /^intel-dcap-qvl-wasm@dcap-qvl\/0\.5\.2$/u,
  /^intel-dcap-webcrypto@1\.0\.0$/u,
]);

const dimensionTitles: Readonly<Record<AttestationDimensionKey, string>> = Object.freeze({
  transport: "Encrypted transport",
  freshness: "Freshness",
  "cpu-tee": "Protected CPU runtime",
  "gpu-tee": "Protected accelerator",
  "endpoint-key": "Endpoint identity",
  model: "Model artifact",
  conversation: "Conversation integrity",
  payment: "Payment standing",
});

export const ATTESTATION_TECHNICAL_LABELS: Readonly<Record<AttestationDimensionKey, string>> = Object.freeze({
  transport: "E2EE channel",
  freshness: "Nonce and evidence age",
  "cpu-tee": "CPU TEE",
  "gpu-tee": "GPU TEE",
  "endpoint-key": "Attested endpoint-key binding",
  model: "Artifact and runtime policy",
  conversation: "Request/response binding",
  payment: "Settlement receipt",
});

export function normalizeAttestationEvidence(input: NormalizeAttestationInput): readonly NormalizedAttestationRecord[] {
  const overflow = attestationInputOverflow(input);
  if (overflow) {
    throw new RangeError(`Attestation ${overflow.source} page exceeds the ${overflow.limit}-record client boundary.`);
  }
  const records: NormalizedAttestationRecord[] = [];
  const endpointRecords = [...(input.endpointRecords ?? [])]
    .sort((left, right) => timestampNumber(right.acquisition.fetchedAt) - timestampNumber(left.acquisition.fetchedAt))
    .slice(0, MAX_RECORDS_PER_SOURCE);
  for (const record of endpointRecords) records.push(endpointRecord(record));

  const receipts = [...(input.receipts ?? [])]
    .sort((left, right) => timestampNumber(right.createdAt) - timestampNumber(left.createdAt))
    .slice(0, MAX_RECORDS_PER_SOURCE);
  for (const receipt of receipts) records.push(receiptRecord(receipt));
  const unique = uniqueIds(records);
  unique.sort((left, right) => timestampNumber(right.createdAt) - timestampNumber(left.createdAt) || left.id.localeCompare(right.id));
  return deepFreeze(unique);
}

export function attestationInputOverflow(
  input: NormalizeAttestationInput,
): Readonly<{ source: "endpoint evidence" | "receipt"; count: number; limit: number }> | undefined {
  if ((input.endpointRecords?.length ?? 0) > MAX_ATTESTATION_INPUTS_PER_SOURCE) {
    return { source: "endpoint evidence", count: input.endpointRecords!.length, limit: MAX_ATTESTATION_INPUTS_PER_SOURCE };
  }
  if ((input.receipts?.length ?? 0) > MAX_ATTESTATION_INPUTS_PER_SOURCE) {
    return { source: "receipt", count: input.receipts!.length, limit: MAX_ATTESTATION_INPUTS_PER_SOURCE };
  }
  return undefined;
}

export function serializePublicAttestationSummary(
  input: NormalizeAttestationInput,
  exportedAt = new Date().toISOString(),
): string {
  const records = normalizeAttestationEvidence(input).map((record, index) => ({
    ordinal: index + 1,
    source: record.source,
    createdAt: record.createdAt ?? null,
    cacheFreshUntil: record.cacheFreshUntil ?? null,
    receiptTrust: record.receiptTrust ?? null,
    overallState: record.overallState,
    dimensions: ATTESTATION_DIMENSIONS.map((key) => publicDimension(record.dimensions[key])),
    verifications: record.verifications.map((verification) => ({
      claim: verification.claim,
      state: verification.state,
      qualifier: verification.qualifier,
      authorityKind: verification.authorityKind,
      checkedAt: verification.checkedAt ?? null,
      policyDigest: verification.policyDigest ?? null,
      facts: publicSummaryFacts(verification.facts),
    })),
    bindings: publicSummaryFacts(record.bindings),
    evidenceFacts: publicSummaryFacts(record.evidenceFacts),
  }));
  return JSON.stringify({
    schema: "airship-public-attestation-status-summary/v1",
    exportedAt: validTimestamp(exportedAt) ?? new Date(0).toISOString(),
    safety: "Unsigned privacy-safe status summary only; it is not an independently verifiable proof bundle. Free-form prose and identity metadata are omitted along with raw evidence, keys, nonces, signatures, provider bodies, and plaintext request/response digests.",
    records,
  }, null, 2);
}

function endpointRecord(record: ChutesEndpointEvidenceRecord): NormalizedAttestationRecord {
  const dimensions = {
    transport: unavailableDimension(
      "transport",
      "Endpoint evidence does not prove that an inference request or response used application-layer encrypted transport.",
    ),
    freshness: endpointDimension("freshness", record.claims.nonceFreshness, {
      facts: compactFacts([
        timestampFact("fetched-at", "Fetched", record.acquisition.fetchedAt),
        timestampFact("cache-fresh-until", "Memory cache until · not evidence expiry", record.acquisition.cacheFreshUntil),
        propertyFact("nonce", "Fresh nonce", record.acquisition.requestNonce ? "Present; value withheld" : "Unavailable"),
      ]),
    }),
    "cpu-tee": endpointDimension("cpu-tee", record.claims.cpuTee, {
      facts: compactFacts([
        countFact("quote-bytes", "Quote size", record.evidence.quoteBytes),
      ]),
    }),
    "gpu-tee": endpointDimension("gpu-tee", record.claims.gpuTee, {
      facts: compactFacts([
        countFact("gpu-devices", "GPU evidence records", record.evidence.gpuDeviceCount),
      ]),
    }),
    "endpoint-key": endpointDimension("endpoint-key", record.claims.endpointKey, {
      facts: compactFacts([
        digestFact("e2e-key-digest", "Discovered endpoint key", record.subject.e2ePublicKeyDigest),
        digestFact("payload-digest", "Evidence payload", record.evidence.payloadDigest),
        digestFact("expected-binding", "Expected binding", record.binding.expectedDigestHex),
        digestFact("quoted-binding", "Quoted binding", record.binding.quotedDigestHex),
        propertyFact("construction", "Binding construction", record.binding.construction),
      ]),
    }),
    model: providerModelDimension(record),
    conversation: endpointDimension("conversation", record.claims.conversation, {
      facts: compactFacts([
        propertyFact("request-proof", "Request binding", displayProviderState(record.claims.request.state)),
        propertyFact("response-proof", "Response binding", displayProviderState(record.claims.response.state)),
      ]),
    }),
    payment: endpointDimension("payment", record.claims.payment),
  } satisfies Record<AttestationDimensionKey, AttestationDimension>;
  const evidenceFacts = compactFacts([
    propertyFact("format", "Evidence format", record.evidence.format),
    countFact("quote-bytes", "Quote bytes", record.evidence.quoteBytes),
    countFact("certificate-bytes", "Certificate bytes", record.evidence.certificateBytes),
    countFact("gpu-devices", "GPU evidence records", record.evidence.gpuDeviceCount),
    digestFact("payload-digest", "Normalized payload digest", record.evidence.payloadDigest),
    propertyFact("acquisition", "Acquisition", `${record.acquisition.cache} · ${record.acquisition.authorization} auth`),
    propertyFact("endpoint", "Provider endpoint", publicEndpoint(record.acquisition.requestUrl)),
  ]);
  const verifications = providerVerifications(record);
  return deepFreeze({
    id: `endpoint:${boundedId(record.recordId)}`,
    sourceId: boundedId(record.recordId),
    source: "endpoint-evidence",
    provider: "chutes",
    title: "Endpoint evidence",
    subtitle: `Instance ${publicText(record.subject.instanceId, 180)}`,
    createdAt: validTimestamp(record.acquisition.fetchedAt),
    cacheFreshUntil: validTimestamp(record.acquisition.cacheFreshUntil),
    instanceId: publicText(record.subject.instanceId, 256),
    evidenceFormat: publicText(record.evidence.format, 128),
    overallState: overallState(dimensions),
    dimensions,
    verifications,
    bindings: compactFacts([
      digestFact("e2e-key-digest", "Discovered endpoint-key digest", record.subject.e2ePublicKeyDigest),
      digestFact("expected-binding", "Expected endpoint-key digest", record.binding.expectedDigestHex),
      digestFact("quoted-binding", "Quote report-data digest", record.binding.quotedDigestHex),
    ]),
    evidenceFacts,
    warnings: deepFreeze(record.warnings.slice(0, 24).map((warning) => publicText(warning, MAX_TEXT))),
  });
}

function receiptRecord(receipt: ConversationReceipt): NormalizedAttestationRecord {
  const dimensions = {
    transport: receiptDimension("transport", receipt.claims.encryption),
    freshness: receiptDimension("freshness", receipt.claims.freshness),
    "cpu-tee": receiptDimension("cpu-tee", receipt.claims.cpuTee),
    "gpu-tee": receiptDimension("gpu-tee", receipt.claims.gpuTee),
    "endpoint-key": receiptDimension("endpoint-key", receipt.claims.endpointKey, {
      facts: compactFacts([digestFact("evidence-digest", "Evidence payload", receipt.bindings.evidenceDigest)]),
    }),
    model: receiptDimension("model", receipt.claims.model, {
      facts: compactFacts([
        identityFact("model", "Expected model", receipt.model),
        digestFact("model-policy", "Model policy", receipt.claims.model.policyDigest),
      ]),
    }),
    conversation: receiptDimension("conversation", receipt.claims.conversation, {
      facts: receiptBindingFacts(receipt),
    }),
    payment: receiptDimension("payment", receipt.claims.payment),
  } satisfies Record<AttestationDimensionKey, AttestationDimension>;
  const warnings = [
    // Byte-identical to CLAIM_CEILING_SENTENCES["receipt-integrity"] in
    // `claim-stack-facts.ts`. Not imported: that module travels with the
    // disclosure surfaces, and this one is reached by the evidence pack.
    "Receipt integrity and embedded claim authority were not authenticated, so a claim this receipt declares verified is shown as an assertion. A declared failure keeps its full weight.",
    ...(receipt.evidence && !receipt.bindings.evidenceDigest
      ? ["Evidence is present without a receipt-level evidence digest."]
      : []),
  ];
  return deepFreeze({
    id: `receipt:${boundedId(receipt.receiptId)}`,
    sourceId: boundedId(receipt.receiptId),
    source: "conversation-receipt",
    provider: publicText(receipt.provider, 128),
    title: "Conversation receipt · asserted",
    subtitle: receipt.model ? publicText(receipt.model, 180) : `Turn ${publicText(receipt.turnId, 96)}`,
    createdAt: validTimestamp(receipt.createdAt),
    instanceId: receipt.instanceId ? publicText(receipt.instanceId, 256) : undefined,
    model: receipt.model ? publicText(receipt.model, 512) : undefined,
    posture: publicText(receipt.posture, 64),
    proofLevel: receipt.proofLevel,
    evidenceFormat: receipt.evidence ? publicText(receipt.evidence.format, 128) : undefined,
    receiptTrust: "asserted",
    overallState: overallState(dimensions),
    dimensions,
    verifications: deepFreeze(receipt.verifications.slice(0, MAX_VERIFICATIONS)
      .map((record, index) => normalizeVerification(record, index))),
    bindings: receiptBindingFacts(receipt),
    evidenceFacts: compactFacts([
      propertyFact("format", "Evidence format", receipt.evidence?.format),
      digestFact("evidence-digest", "Evidence digest", receipt.bindings.evidenceDigest),
      identityFact("instance", "Instance", receipt.instanceId),
    ]),
    warnings: deepFreeze(warnings),
  });
}

function providerModelDimension(record: ChutesEndpointEvidenceRecord): AttestationDimension {
  const artifact = record.claims.modelArtifact;
  const policy = record.claims.runtimePolicy;
  const declaredState = providerPairState(artifact.state, policy.state);
  const authority = authorityFor([policy.verifier, artifact.verifier].filter((value): value is string => Boolean(value)).join("+") || undefined);
  const state = statusWithAuthority(declaredState, authority);
  const published = record.publishedPolicy;
  return deepFreeze({
    key: "model",
    title: dimensionTitles.model,
    state,
    qualifier: declaredState === "verified" && state !== "verified"
      ? "verified-without-authority"
      : policy.state === "matched" && artifact.state === "unavailable"
      ? "runtime-policy-matched/model-unavailable"
      : `${policy.state}/${artifact.state}`,
    summary: authorityBoundSummary(
      `${publicText(policy.summary, MAX_TEXT / 2)} ${publicText(artifact.summary, MAX_TEXT / 2)}`.trim(),
      declaredState === "verified" && state !== "verified",
    ),
    authority: authority.label,
    authorityKind: authority.kind,
    checkedAt: validTimestamp(policy.checkedAt ?? artifact.checkedAt),
    policyDigest: safeDigest(published?.policyDigest),
    facts: compactFacts([
      digestFact("published-policy", "Published policy feed", published?.policyDigest),
      countFact("published-policy-count", "Published policies", published?.policyCount),
      countFact("published-policy-matches", "Measurement matches", published?.matches.length),
      measurementFact("mrtd", "MRTD", published?.quoteMeasurements.mrtd),
      measurementFact("rtmr0", "RTMR 0", published?.quoteMeasurements.rtmr0),
      measurementFact("rtmr1", "RTMR 1", published?.quoteMeasurements.rtmr1),
      measurementFact("rtmr2", "RTMR 2", published?.quoteMeasurements.rtmr2),
      measurementFact("rtmr3", "RTMR 3", published?.quoteMeasurements.rtmr3),
    ]),
  });
}

function endpointDimension(
  key: AttestationDimensionKey,
  claim: Readonly<{ state: AttestationClaimState; summary: string; verifier?: string; checkedAt?: string }>,
  extras: Readonly<{ expiresAt?: string; facts?: readonly AttestationFact[] }> = {},
): AttestationDimension {
  const authority = authorityFor(claim.verifier);
  const state = statusWithAuthority(providerState(claim.state), authority);
  return deepFreeze({
    key,
    title: dimensionTitles[key],
    state,
    qualifier: claim.state === "verified" && state !== "verified" ? "verified-without-authority" : claim.state,
    summary: authorityBoundSummary(claim.summary, claim.state === "verified" && state !== "verified"),
    authority: authority.label,
    authorityKind: authority.kind,
    checkedAt: validTimestamp(claim.checkedAt),
    expiresAt: validTimestamp(extras.expiresAt),
    facts: extras.facts ?? [],
  });
}

function receiptDimension(
  key: AttestationDimensionKey,
  claim: ConversationReceipt["claims"][ClaimKey],
  extras: Readonly<{ facts?: readonly AttestationFact[] }> = {},
): AttestationDimension {
  const authority = assertedAuthorityFor(claim.verifier);
  const detailFacts = extractPublicFacts(claim.details);
  const declaredState = proofStatus(claim.status);
  const state = assertedState(declaredState);
  return deepFreeze({
    key,
    title: dimensionTitles[key],
    state,
    qualifier: `asserted-${declaredState}`,
    summary: assertedSummary(claim.summary, declaredState),
    authority: authority.label,
    authorityKind: authority.kind,
    checkedAt: validTimestamp(claim.checkedAt),
    expiresAt: expiryFromFacts(detailFacts),
    policyDigest: safeDigest(claim.policyDigest),
    facts: compactFacts([...(extras.facts ?? []), ...detailFacts]),
  });
}

function unavailableDimension(key: AttestationDimensionKey, summary: string): AttestationDimension {
  return deepFreeze({
    key,
    title: dimensionTitles[key],
    state: "unavailable",
    qualifier: "unavailable",
    summary,
    authority: "No verification authority",
    authorityKind: "none",
    facts: [],
  });
}

function providerVerifications(record: ChutesEndpointEvidenceRecord): readonly AttestationVerification[] {
  const claims: Array<[string, string, ChutesEndpointEvidenceRecord["claims"][keyof ChutesEndpointEvidenceRecord["claims"]]]> = [
    ["evidence-structure", "Evidence structure", record.claims.evidenceStructure],
    ["nonce-freshness", "Nonce freshness", record.claims.nonceFreshness],
    ["endpoint-key", "Endpoint key", record.claims.endpointKey],
    ["cpu-tee", "CPU TEE", record.claims.cpuTee],
    ["gpu-tee", "GPU TEE", record.claims.gpuTee],
    ["runtime-policy", "Published runtime policy", record.claims.runtimePolicy],
    ["model-artifact", "Model artifact", record.claims.modelArtifact],
    ["request", "Request binding", record.claims.request],
    ["response", "Response binding", record.claims.response],
    ["conversation", "Conversation signature", record.claims.conversation],
    ["payment", "Settlement receipt", record.claims.payment],
  ];
  return deepFreeze(claims.map(([claimKey, title, claim], index) => {
    const authority = authorityFor(claim.verifier);
    const declaredState = providerState(claim.state);
    const state = statusWithAuthority(declaredState, authority);
    return {
      id: `provider:${claimKey}:${index}`,
      claim: claimKey,
      title,
      state,
      qualifier: claim.state === "verified" && state !== "verified" ? "verified-without-authority" : claim.state,
      authority: authority.label,
      authorityKind: authority.kind,
      checkedAt: validTimestamp(claim.checkedAt),
      summary: authorityBoundSummary(claim.summary, claim.state === "verified" && state !== "verified"),
      facts: [],
    };
  }));
}

function normalizeVerification(record: VerificationRecord, index: number): AttestationVerification {
  const authority = assertedAuthorityFor(record.verifier);
  const declaredState = proofStatus(record.status);
  const state = assertedState(declaredState);
  const claim = safeClaimKey(record.claim);
  return deepFreeze({
    id: `verification:${index}:${boundedId(record.verifier)}`,
    claim,
    title: claim === "unknown" ? "Unknown claim" : claimTitle(claim),
    state,
    qualifier: `asserted-${declaredState}`,
    authority: authority.label,
    authorityKind: authority.kind,
    version: publicText(record.version, 64),
    checkedAt: validTimestamp(record.checkedAt),
    policyDigest: safeDigest(record.policyDigest),
    summary: assertedSummary(record.detail ?? "No verifier detail was supplied.", declaredState),
    facts: compactFacts([digestFact("verification-policy", "Verifier policy", record.policyDigest)]),
  });
}

function safeClaimKey(value: unknown): ClaimKey | "unknown" {
  return value === "encryption" ||
    value === "freshness" ||
    value === "cpuTee" ||
    value === "gpuTee" ||
    value === "endpointKey" ||
    value === "model" ||
    value === "conversation" ||
    value === "payment"
    ? value
    : "unknown";
}

function receiptBindingFacts(receipt: ConversationReceipt): readonly AttestationFact[] {
  return compactFacts([
    propertyFact("binding-algorithm", "Binding algorithm", receipt.bindings.algorithm),
    propertyFact(
      "plaintext-commitments",
      "Plaintext commitments",
      receipt.bindings.requestDigest || receipt.bindings.responseDigest
        ? "Withheld by default; use salted or keyed selective disclosure"
        : "Unavailable",
    ),
    digestFact("endpoint-key", "Invocation endpoint key", receipt.bindings.endpointKeyDigest),
    digestFact("request-ciphertext", "Request ciphertext", receipt.bindings.requestCiphertextDigest),
    digestFact("response-ciphertext", "Response ciphertext", receipt.bindings.responseCiphertextDigest),
    digestFact("evidence-digest", "Evidence payload", receipt.bindings.evidenceDigest),
  ]);
}

function extractPublicFacts(details: JsonValue | undefined): readonly AttestationFact[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const result: AttestationFact[] = [];
  visitDetails(details, result, 0);
  return compactFacts(result);
}

function visitDetails(value: Record<string, JsonValue>, result: AttestationFact[], depth: number): void {
  if (depth > 3 || result.length >= MAX_FACTS) return;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (result.length >= MAX_FACTS) return;
    const child = value[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      visitDetails(child, result, depth + 1);
      continue;
    }
    const normalized = key.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
    const metadata = allowedDetailFact(normalized);
    if (!metadata || (typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean")) continue;
    const raw = String(child);
    if (SECRET_VALUE.test(raw)) {
      SECRET_VALUE.lastIndex = 0;
      continue;
    }
    SECRET_VALUE.lastIndex = 0;
    if ((metadata.kind === "digest" || metadata.kind === "measurement") && !safeDigest(raw)) continue;
    if (metadata.kind === "timestamp" && !validTimestamp(raw)) continue;
    const fact = factValue(`detail-${normalized}`, metadata.label, raw, metadata.kind);
    if (fact) result.push(fact);
  }
}

function allowedDetailFact(key: string): { label: string; kind: AttestationFact["kind"] } | undefined {
  const direct: Record<string, { label: string; kind: AttestationFact["kind"] }> = {
    measurement: { label: "Measurement", kind: "measurement" },
    measurementdigest: { label: "Measurement digest", kind: "measurement" },
    mrtd: { label: "MRTD", kind: "measurement" },
    mrseam: { label: "MRSEAM", kind: "measurement" },
    rtmr0: { label: "RTMR 0", kind: "measurement" },
    rtmr1: { label: "RTMR 1", kind: "measurement" },
    rtmr2: { label: "RTMR 2", kind: "measurement" },
    rtmr3: { label: "RTMR 3", kind: "measurement" },
    artifactdigest: { label: "Artifact digest", kind: "digest" },
    policydigest: { label: "Policy digest", kind: "digest" },
    signer: { label: "Signer", kind: "identity" },
    signaturealgorithm: { label: "Signature algorithm", kind: "property" },
    expiresat: { label: "Expires", kind: "timestamp" },
    notafter: { label: "Not after", kind: "timestamp" },
    tcbstatus: { label: "TCB status", kind: "property" },
    tcblevel: { label: "TCB level", kind: "property" },
    debugdisabled: { label: "Debug disabled", kind: "property" },
    quoteversion: { label: "Quote version", kind: "property" },
    teetype: { label: "TEE type", kind: "property" },
  };
  return direct[key];
}

function overallState(dimensions: Readonly<Record<AttestationDimensionKey, AttestationDimension>>): ProofStatus {
  const claims = ATTESTATION_DIMENSIONS.map((key) => dimensions[key].state);
  if (claims.includes("failed")) return "failed";
  if (claims.includes("expired")) return "expired";
  if (claims.every((state) => state === "verified")) return "verified";
  if (claims.every((state) => state === "unavailable")) return "unavailable";
  return "partial";
}

function providerState(state: AttestationClaimState): ProofStatus {
  if (state === "verified" || state === "failed" || state === "expired" || state === "unavailable") return state;
  return "partial";
}

function providerPairState(left: AttestationClaimState, right: AttestationClaimState): ProofStatus {
  if (left === "failed" || right === "failed") return "failed";
  if (left === "expired" || right === "expired") return "expired";
  if (left === "verified" && right === "verified") return "verified";
  if (left === "unavailable" && right === "unavailable") return "unavailable";
  return "partial";
}

function proofStatus(value: unknown): ProofStatus {
  return value === "verified" || value === "partial" || value === "failed" || value === "expired" || value === "unavailable"
    ? value
    : "unavailable";
}

function displayProviderState(state: AttestationClaimState): string {
  if (state === "matched") return "Locally matched; not independently verified";
  if (state === "present") return "Present; authenticity not verified";
  if (state === "unverified") return "Not independently verified";
  return state;
}

function authorityFor(verifier: string | undefined): { label: string; kind: AttestationAuthorityKind } {
  const safe = verifier ? publicText(verifier, 160) : "";
  if (!safe || safe === "unavailable") return { label: "No verification authority", kind: "none" };
  const parts = safe.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { label: "No verification authority", kind: "none" };
  const local = parts.filter(isLocalVerifierId).length;
  if (local === parts.length) return { label: `${safe} · local client check`, kind: "local" };
  if (local > 0) return { label: `${safe} · mixed verifier chain`, kind: "mixed" };
  return { label: `${safe} · external verifier`, kind: "external" };
}

function isLocalVerifierId(verifier: string): boolean {
  return LOCAL_VERIFIER_IDS.has(verifier)
    || LOCAL_VERIFIER_PATTERNS.some((pattern) => pattern.test(verifier));
}

function assertedAuthorityFor(verifier: string | undefined): { label: string; kind: AttestationAuthorityKind } {
  const safe = verifier ? publicText(verifier, 160) : "";
  return safe && safe !== "[redacted secret]"
    ? { label: `Claimed verifier: ${safe} · receipt unauthenticated`, kind: "none" }
    : { label: "No trusted verification authority · receipt unauthenticated", kind: "none" };
}

function statusWithAuthority(
  state: ProofStatus,
  authority: Readonly<{ kind: AttestationAuthorityKind }>,
): ProofStatus {
  return state === "verified" && authority.kind === "none" ? "partial" : state;
}

/**
 * Ceiling 1: a receipt Airship never authenticated cannot promote itself.
 *
 * It runs in one direction only. A declared `verified` becomes `partial`
 * because nothing checked the declaration; a declared `failed` or `expired`
 * keeps its full weight, because fail-closed means an unauthenticated *bad*
 * report is still a bad report and softening it is the one edit that turns a
 * disclosure into a cover.
 *
 * This used to map every non-`unavailable` state to `partial`, so one turn read
 * "Failed" on the Receipt & journal tab (`composeClaimStack`, which never
 * copied that half) and "Asserted" on the Attestation evidence tab, one click
 * apart. The qualifier still carries the declaration verbatim as
 * `asserted-${declaredState}`, so the ceiling is read, never inferred.
 */
function assertedState(state: ProofStatus): ProofStatus {
  return state === "verified" ? "partial" : state;
}

function authorityBoundSummary(summary: string, downgraded: boolean): string {
  const safe = publicText(summary, downgraded ? MAX_TEXT - 92 : MAX_TEXT);
  return downgraded
    ? `${safe}${safe ? " " : ""}The claim declared verification without naming an authority, so Airship shows it as partial.`
    : safe;
}

/**
 * The receipt-integrity caveat, in the direction the ceiling actually runs.
 *
 * A declared negative is no longer described as "assertion-only": that phrasing
 * beneath a "Failed" verdict reads as a softening of the very failure the
 * receipt is reporting. Both branches say the same unauthenticated fact; only
 * the consequence differs, because the consequence genuinely differs.
 */
function assertedSummary(summary: string, declared: ProofStatus): string {
  const negative = declared === "failed" || declared === "expired";
  const safe = publicText(summary, MAX_TEXT - (negative ? 124 : 112));
  const caveat = negative
    ? "Airship did not authenticate this receipt; this negative result is the receipt's own report and keeps full weight."
    : "Receipt authenticity and claim-authority policy were not checked, so this result is assertion-only.";
  return `${safe}${safe ? " " : ""}${caveat}`;
}

function expiryFromFacts(facts: readonly AttestationFact[]): string | undefined {
  const value = facts.find((fact) => fact.kind === "timestamp" && /expires|not after/iu.test(fact.label))?.value;
  return validTimestamp(value);
}

function publicDimension(dimension: AttestationDimension) {
  return {
    key: dimension.key,
    state: dimension.state,
    qualifier: dimension.qualifier,
    authorityKind: dimension.authorityKind,
    checkedAt: dimension.checkedAt ?? null,
    expiresAt: dimension.expiresAt ?? null,
    policyDigest: dimension.policyDigest ?? null,
    facts: publicSummaryFacts(dimension.facts),
  };
}

function publicSummaryFacts(facts: readonly AttestationFact[]): readonly AttestationFact[] {
  return facts.filter((fact) =>
    fact.kind === "digest" ||
    fact.kind === "measurement" ||
    fact.kind === "timestamp" ||
    fact.kind === "count");
}

function uniqueIds(records: NormalizedAttestationRecord[]): NormalizedAttestationRecord[] {
  const counts = new Map<string, number>();
  return records.map((record) => {
    const count = counts.get(record.id) ?? 0;
    counts.set(record.id, count + 1);
    return count === 0 ? record : deepFreeze({ ...record, id: `${record.id}:${count + 1}` });
  });
}

function claimTitle(claim: ClaimKey): string {
  const map: Record<ClaimKey, string> = {
    encryption: "Encrypted transport",
    freshness: "Freshness",
    cpuTee: "CPU TEE",
    gpuTee: "GPU TEE",
    endpointKey: "Endpoint key binding",
    model: "Model artifact",
    conversation: "Conversation signature",
    payment: "Settlement receipt",
  };
  return map[claim];
}

function timestampFact(key: string, label: string, value: string | undefined): AttestationFact | undefined {
  const valid = validTimestamp(value);
  return valid ? factValue(key, label, valid, "timestamp") : undefined;
}

function digestFact(key: string, label: string, value: string | undefined): AttestationFact | undefined {
  const valid = safeDigest(value);
  return valid ? factValue(key, label, valid, "digest") : undefined;
}

function measurementFact(key: string, label: string, value: string | undefined): AttestationFact | undefined {
  const valid = safeDigest(value);
  return valid ? factValue(key, label, valid, "measurement") : undefined;
}

function identityFact(key: string, label: string, value: string | undefined): AttestationFact | undefined {
  return value ? factValue(key, label, value, "identity") : undefined;
}

function propertyFact(key: string, label: string, value: string | undefined): AttestationFact | undefined {
  return value ? factValue(key, label, value, "property") : undefined;
}

function countFact(key: string, label: string, value: number | undefined): AttestationFact | undefined {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? factValue(key, label, String(value), "count") : undefined;
}

function factValue(key: string, label: string, value: string, kind: AttestationFact["kind"]): AttestationFact | undefined {
  const safe = publicText(value, 512);
  if (!safe || safe === "[redacted secret]") return undefined;
  return Object.freeze({ key, label, value: safe, kind });
}

function compactFacts(values: readonly (AttestationFact | undefined)[]): readonly AttestationFact[] {
  const byKey = new Map<string, AttestationFact>();
  for (const value of values) if (value && !byKey.has(value.key) && byKey.size < MAX_FACTS) byKey.set(value.key, value);
  return deepFreeze([...byKey.values()]);
}

function safeDigest(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const safe = publicText(value, 512);
  if (safe === "[redacted secret]") return undefined;
  if (/^(?:sha(?:256|384|512):[A-Za-z0-9_-]{16,}|[0-9a-f]{32,256})$/iu.test(safe)) return safe;
  return undefined;
}

function publicEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "Provider endpoint withheld";
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return "Provider endpoint withheld";
  }
}

function publicText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const scan = value.length > maxLength + 256 ? value.slice(0, maxLength + 256) : value;
  const bounded = scan.replace(/[\u0000-\u001f\u007f]/gu, " ").replaceAll(SECRET_VALUE, "[redacted secret]").trim();
  return bounded.length <= maxLength ? bounded : `${bounded.slice(0, maxLength)}…`;
}

function boundedId(value: string): string {
  return publicText(value, MAX_ID) || "unidentified";
}

function validTimestamp(value: string | undefined): string | undefined {
  if (!value || value.length > 128 || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function timestampNumber(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
