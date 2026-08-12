import { deepFreeze } from "../core/freeze";
import { sha256, stableStringify } from "../core/hash";
import { WorkspaceConflictError, type WorkspacePort } from "../workspace/contracts";
import { decodeCanonicalBase64, sha256Hex } from "./encoding";
import { extractTdxRuntimeMeasurements, parseTdxQuote } from "./tdx";
import type {
  AttestationClaimKey,
  AttestationClaimState,
  ChutesEndpointEvidenceRecord,
} from "./provider-types";
import type { ParsedTdxQuote } from "./types";

const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const RECORD_ID_PATTERN = /^urn:airship:attestation:[A-Za-z0-9_-]{43}$/u;
const SHA256_DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;
const LOWER_HEX_32_PATTERN = /^[0-9a-f]{64}$/u;
const LOWER_HEX_64_PATTERN = /^[0-9a-f]{128}$/u;
const EVIDENCE_ROOT = "/workspace/.airship/endpoint-evidence/profiles";
const TEXT_ENCODER = new TextEncoder();
const MAX_IDENTIFIER_BYTES = 1_024;
const MAX_TEXT_BYTES = 8 * 1_024;
const MAX_WARNING_COUNT = 32;
const MAX_GPU_PAYLOADS = 64;
const MAX_GPU_JSON_NODES = 100_000;
const MAX_GPU_JSON_DEPTH = 32;
const MAX_PUBLISHED_POLICY_MATCHES = 128;
const MAX_CAS_ATTEMPTS = 8;
const MAX_RESPONSE_SIGNATURE_BYTES = 8 * 1_024;
const MAX_ATTESTED_BODY_BYTES = 2 * 1_024 * 1_024;

export const MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORD_BYTES = 3 * 1_024 * 1_024;
export const MAX_ENDPOINT_EVIDENCE_CHECKPOINT_BYTES = 12 * 1_024 * 1_024;
export const MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORDS = 32;

export type EndpointEvidenceRecordIdentity = Readonly<{
  version: 1;
  profileId: string;
  sessionId: string;
  receiptId?: string;
  instanceId: string;
  endpointKeyDigest?: string;
}>;

export type PersistedEndpointEvidenceEntry = Readonly<{
  version: 1;
  identity: EndpointEvidenceRecordIdentity;
  recordedAt: number;
  record: ChutesEndpointEvidenceRecord;
}>;

export type EndpointEvidenceSnapshot = Readonly<{
  version: 1;
  profileId: string;
  savedAt: number;
  entries: readonly PersistedEndpointEvidenceEntry[];
}>;

type EndpointEvidenceEnvelope = Readonly<{
  version: 1;
  kind: "airship-endpoint-evidence-records";
  profileId: string;
  savedAt: number;
  entries: readonly PersistedEndpointEvidenceEntry[];
}>;

export type WorkspaceEndpointEvidenceScope = Readonly<{
  /** Object identity is the active storage-authority fence. */
  workspace: WorkspacePort;
  /** Diagnostic identity only; it is never interpolated into a path. */
  workspaceId: string;
  profileId: string;
}>;

export type WorkspaceEndpointEvidenceBinding = WorkspaceEndpointEvidenceScope & Readonly<{
  store: WorkspaceEndpointEvidencePersistence;
  snapshot: EndpointEvidenceSnapshot;
}>;

export type EndpointEvidenceCommitInput = Readonly<{
  identity: EndpointEvidenceRecordIdentity;
  record: ChutesEndpointEvidenceRecord;
}>;

export type EndpointEvidenceCommitResult = Readonly<{
  disposition: "persisted" | "page-only";
  entry: PersistedEndpointEvidenceEntry;
  snapshot?: EndpointEvidenceSnapshot;
  reason?: string;
}>;

export type EndpointEvidenceRemovalResult = Readonly<{
  removed: number;
  snapshot: EndpointEvidenceSnapshot;
}>;

export function endpointEvidenceCheckpointPath(profileId: string): string {
  return `${EVIDENCE_ROOT}/${validatedProfileId(profileId)}/records.v1.json`;
}

/**
 * Credential-free endpoint evidence persisted through the active WorkspacePort.
 * A MemoryWorkspace remains page-lifetime; an encrypted WorkspacePort preserves
 * the exact same bytes inside that provider's client-side encryption boundary.
 *
 * Raw quote, DER certificate, GPU payloads, nonce, endpoint public key and
 * binding digests are all part of `ChutesEndpointEvidenceRecord`. They are
 * retained together or rejected together: this adapter never truncates proof
 * material into an apparently complete but independently unverifiable record.
 */
export class WorkspaceEndpointEvidencePersistence {
  readonly path: string;
  private readonly profileId: string;

  constructor(
    private readonly workspace: WorkspacePort,
    profileId: string,
  ) {
    this.profileId = validatedProfileId(profileId);
    this.path = endpointEvidenceCheckpointPath(this.profileId);
  }

  async load(now = Date.now(), signal?: AbortSignal): Promise<Readonly<{
    revision?: string;
    snapshot: EndpointEvidenceSnapshot;
  }>> {
    signal?.throwIfAborted();
    const file = this.workspace.readBounded
      ? await this.workspace.readBounded(this.path, MAX_ENDPOINT_EVIDENCE_CHECKPOINT_BYTES + 1)
      : await this.workspace.read(this.path);
    signal?.throwIfAborted();
    if (!file) return Object.freeze({ snapshot: emptySnapshot(this.profileId, checkedNow(now)) });
    if (file.size > MAX_ENDPOINT_EVIDENCE_CHECKPOINT_BYTES) {
      throw new Error("The endpoint-evidence checkpoint exceeds its 12 MiB boundary.");
    }
    const envelope = await parseEnvelope(file.content, this.profileId);
    checkedNow(now);
    return Object.freeze({
      revision: file.revision,
      snapshot: freezeSnapshot({
        version: 1,
        profileId: this.profileId,
        savedAt: envelope.savedAt,
        entries: envelope.entries,
      }),
    });
  }

  async commit(
    input: EndpointEvidenceCommitInput,
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<EndpointEvidenceCommitResult> {
    const committedAt = checkedNow(now);
    const identity = validateIdentity(input.identity, this.profileId);
    const record = await validateEndpointEvidenceRecord(input.record);
    assertRecordMatchesIdentity(record, identity);
    const entry = deepFreeze({
      version: 1,
      identity,
      recordedAt: Date.parse(record.acquisition.fetchedAt),
      record,
    } satisfies PersistedEndpointEvidenceEntry);
    const recordBytes = jsonBytes(record);
    if (recordBytes > MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORD_BYTES) {
      return pageOnly(
        entry,
        `The complete endpoint-evidence record is ${recordBytes} bytes, above the 3 MiB durable-record boundary. Raw quote, certificate, GPU, nonce, key, and binding material remain together in page memory only; none was truncated.`,
      );
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const current = await this.load(committedAt, signal);
      const candidateKey = entryIdentityKey(entry.identity);
      const replacesExisting = current.snapshot.entries.some((candidate) =>
        entryIdentityKey(candidate.identity) === candidateKey);
      if (!replacesExisting && current.snapshot.entries.length >= MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORDS) {
        return pageOnly(
          entry,
          `The active Profile already retains ${MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORDS} complete endpoint-evidence records, its explicit durable-cache capacity. Existing proof was not evicted; this whole record remains in page memory only and no raw field was truncated.`,
        );
      }
      const merged = mergeEntries(current.snapshot.entries, entry);
      const envelope: EndpointEvidenceEnvelope = deepFreeze({
        version: 1,
        kind: "airship-endpoint-evidence-records",
        profileId: this.profileId,
        savedAt: committedAt,
        entries: merged,
      });
      const content = JSON.stringify(envelope);
      const checkpointBytes = TEXT_ENCODER.encode(content).byteLength;
      if (checkpointBytes > MAX_ENDPOINT_EVIDENCE_CHECKPOINT_BYTES) {
        return pageOnly(
          entry,
          `The complete endpoint-evidence checkpoint would be ${checkpointBytes} bytes, above the 12 MiB profile boundary. This whole record remains in page memory only; no raw field was truncated.`,
        );
      }
      try {
        const written = await this.workspace.write(this.path, content, {
          expectedRevision: current.revision ?? null,
        });
        // A successful WorkspacePort CAS is authoritative even when an abort is
        // delivered immediately after return. The caller receives the revision
        // implied by this exact snapshot rather than misreporting a rollback.
        return Object.freeze({
          disposition: "persisted",
          entry: merged.find((candidate) =>
            entryIdentityKey(candidate.identity) === entryIdentityKey(entry.identity))!,
          snapshot: freezeSnapshot({
            version: 1,
            profileId: this.profileId,
            savedAt: committedAt,
            entries: merged,
          }),
          revision: written.revision,
        } as EndpointEvidenceCommitResult & { revision: string });
      } catch (error) {
        if (!(error instanceof WorkspaceConflictError) || attempt === MAX_CAS_ATTEMPTS - 1) throw error;
      }
    }
    throw new Error("Endpoint-evidence persistence exhausted its compare-and-swap retry boundary.");
  }

  /** Remove only the records owned by one deleted conversation. */
  async removeSession(
    sessionId: string,
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<EndpointEvidenceRemovalResult> {
    const normalizedSessionId = boundedText(sessionId, "endpoint-evidence session ID", MAX_IDENTIFIER_BYTES);
    const committedAt = checkedNow(now);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const current = await this.load(committedAt, signal);
      const remaining = current.snapshot.entries.filter((entry) => entry.identity.sessionId !== normalizedSessionId);
      const removed = current.snapshot.entries.length - remaining.length;
      if (removed === 0) return Object.freeze({ removed: 0, snapshot: current.snapshot });
      const envelope: EndpointEvidenceEnvelope = deepFreeze({
        version: 1,
        kind: "airship-endpoint-evidence-records",
        profileId: this.profileId,
        savedAt: committedAt,
        entries: remaining,
      });
      try {
        await this.workspace.write(this.path, JSON.stringify(envelope), {
          expectedRevision: current.revision ?? null,
        });
        return Object.freeze({
          removed,
          snapshot: freezeSnapshot({
            version: 1,
            profileId: this.profileId,
            savedAt: committedAt,
            entries: remaining,
          }),
        });
      } catch (error) {
        if (!(error instanceof WorkspaceConflictError) || attempt === MAX_CAS_ATTEMPTS - 1) throw error;
      }
    }
    throw new Error("Endpoint-evidence removal exhausted its compare-and-swap retry boundary.");
  }
}

/**
 * Serializes profile and WorkspacePort changes around the record store. A
 * binding object is an unforgeable page authority token: commits through an
 * old binding may finish in its old silo, but can never publish through the
 * newly active binding.
 */
export class WorkspaceEndpointEvidenceAuthority {
  private bindingValue?: WorkspaceEndpointEvidenceBinding;
  private operations: Promise<void> = Promise.resolve();

  current(): WorkspaceEndpointEvidenceBinding | undefined {
    return this.bindingValue;
  }

  activate(
    scope: WorkspaceEndpointEvidenceScope,
    signal?: AbortSignal,
  ): Promise<WorkspaceEndpointEvidenceBinding> {
    const normalized = normalizeScope(scope);
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const current = this.bindingValue;
      if (current && sameScope(current, normalized)) return current;
      this.bindingValue = undefined;
      const store = new WorkspaceEndpointEvidencePersistence(normalized.workspace, normalized.profileId);
      const loaded = await store.load(Date.now(), signal);
      signal?.throwIfAborted();
      const binding = Object.freeze({ ...normalized, store, snapshot: loaded.snapshot });
      this.bindingValue = binding;
      return binding;
    });
  }

  commit(
    binding: WorkspaceEndpointEvidenceBinding,
    input: EndpointEvidenceCommitInput,
    signal?: AbortSignal,
  ): Promise<EndpointEvidenceCommitResult> {
    return this.exclusive(async () => {
      if (this.bindingValue !== binding) throw authorityAbort();
      const result = await binding.store.commit(input, Date.now(), signal);
      if (this.bindingValue !== binding) throw authorityAbort();
      if (result.snapshot) {
        this.bindingValue = Object.freeze({ ...binding, snapshot: result.snapshot });
      }
      return result;
    });
  }

  removeSession(
    binding: WorkspaceEndpointEvidenceBinding,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<EndpointEvidenceRemovalResult> {
    return this.exclusive(async () => {
      if (this.bindingValue !== binding) throw authorityAbort();
      const result = await binding.store.removeSession(sessionId, Date.now(), signal);
      if (this.bindingValue !== binding) throw authorityAbort();
      this.bindingValue = Object.freeze({ ...binding, snapshot: result.snapshot });
      return result;
    });
  }

  release(): Promise<void> {
    return this.exclusive(async () => {
      this.bindingValue = undefined;
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function endpointEvidenceEntriesForSession(
  snapshot: EndpointEvidenceSnapshot,
  sessionId: string,
): readonly PersistedEndpointEvidenceEntry[] {
  const normalized = boundedText(sessionId, "endpoint-evidence session ID", MAX_IDENTIFIER_BYTES);
  return Object.freeze(snapshot.entries.filter((entry) => entry.identity.sessionId === normalized));
}

export async function validateEndpointEvidenceRecord(
  value: unknown,
): Promise<ChutesEndpointEvidenceRecord> {
  const serialized = stringifyJson(value, "endpoint-evidence record");
  const parsed = JSON.parse(serialized) as unknown;
  const record = exactObject(parsed, "endpoint-evidence record", [
    "version", "recordId", "provider", "kind", "verdict", "subject", "acquisition",
    "evidence", "binding", "publishedPolicy", "claims", "warnings",
  ], ["publishedPolicy"]);
  exact(record.version, 1, "endpoint-evidence record version");
  const recordId = patternedString(record.recordId, "endpoint-evidence record ID", RECORD_ID_PATTERN, 128);
  exact(record.provider, "chutes", "endpoint-evidence provider");
  exact(record.kind, "endpoint-evidence", "endpoint-evidence kind");
  enumString(record.verdict, "endpoint-evidence verdict", ["evidence-only", "rejected"] as const);

  const subject = exactObject(record.subject, "endpoint-evidence subject", [
    "scope", "chuteId", "instanceId", "e2ePublicKey", "e2ePublicKeyDigest",
  ], ["chuteId"]);
  exact(subject.scope, "endpoint", "endpoint-evidence subject scope");
  const chuteId = subject.chuteId === undefined
    ? undefined
    : identifier(subject.chuteId, "Chutes chute ID");
  const instanceId = identifier(subject.instanceId, "Chutes instance ID");
  const e2ePublicKey = boundedText(subject.e2ePublicKey, "endpoint public key", 256 * 1_024);
  const e2ePublicKeyDigest = patternedString(
    subject.e2ePublicKeyDigest,
    "endpoint public-key digest",
    SHA256_DIGEST_PATTERN,
    80,
  );
  if (await sha256(e2ePublicKey) !== e2ePublicKeyDigest) {
    throw new Error("The endpoint-evidence public-key digest does not match its retained public key.");
  }

  const acquisition = exactObject(record.acquisition, "endpoint-evidence acquisition", [
    "endpoint", "requestUrl", "requestNonce", "fetchedAt", "cacheFreshUntil", "freshUntil",
    "authorization", "auth", "cache",
  ]);
  enumString(acquisition.endpoint, "endpoint-evidence route", ["instance-evidence", "chute-evidence"] as const);
  querylessUrl(acquisition.requestUrl);
  const requestNonce = boundedText(acquisition.requestNonce, "attestation request nonce", 16 * 1_024);
  timestamp(acquisition.fetchedAt, "attestation fetchedAt");
  timestamp(acquisition.cacheFreshUntil, "attestation cacheFreshUntil");
  timestamp(acquisition.freshUntil, "attestation freshUntil");
  if (acquisition.cacheFreshUntil !== acquisition.freshUntil) {
    throw new Error("The endpoint-evidence freshness aliases disagree.");
  }
  enumString(acquisition.authorization, "endpoint-evidence authorization disposition", ["bearer", "public"] as const);
  if (acquisition.auth !== acquisition.authorization) {
    throw new Error("The endpoint-evidence authorization aliases disagree.");
  }
  enumString(acquisition.cache, "endpoint-evidence cache state", ["network", "memory"] as const);

  const evidence = exactObject(record.evidence, "endpoint-evidence payload", [
    "format", "payloadDigest", "quoteBytes", "certificateBytes", "gpuDeviceCount",
    "quote", "gpu", "certificate", "signature", "attestedBody",
  ], ["signature", "attestedBody"]);
  exact(evidence.format, "chutes-tee-instance-evidence/v1", "endpoint-evidence format");
  const payloadDigest = patternedString(evidence.payloadDigest, "evidence payload digest", SHA256_DIGEST_PATTERN, 80);
  const quoteBytes = boundedInteger(evidence.quoteBytes, "quote byte length", 1, 2 * 1_024 * 1_024);
  const certificateBytes = boundedInteger(evidence.certificateBytes, "certificate byte length", 2, 64 * 1_024);
  const gpuDeviceCount = boundedInteger(evidence.gpuDeviceCount, "GPU device count", 0, MAX_GPU_PAYLOADS);

  const quote = exactObject(evidence.quote, "TDX quote", [
    "format", "base64", "byteLength", "version", "attestationKeyType", "teeType",
    "signatureDataLength", "reportDataHex",
  ]);
  enumString(quote.format, "TDX quote format", ["intel-tdx-quote-v4", "intel-tdx-quote-v5"] as const);
  const quoteBase64 = boundedText(quote.base64, "TDX quote base64", 3 * 1_024 * 1_024);
  const quoteDecoded = decodeCanonicalBase64({
    value: quoteBase64,
    label: "TDX quote",
    minBytes: 1,
    maxBytes: 2 * 1_024 * 1_024,
  });
  const quoteByteLength = boundedInteger(quote.byteLength, "TDX quote byte length", 1, 2 * 1_024 * 1_024);
  if (quoteDecoded.byteLength !== quoteByteLength || quoteByteLength !== quoteBytes) {
    throw new Error("The endpoint-evidence quote byte lengths disagree.");
  }
  const parsedQuote = parseTdxQuote(quoteBase64);
  const version = enumNumber(quote.version, "TDX quote version", [4, 5] as const);
  const attestationKeyType = enumNumber(quote.attestationKeyType, "TDX attestation-key type", [2, 3] as const);
  exact(quote.teeType, "0x81", "TDX TEE type");
  const signatureDataLength = boundedInteger(
    quote.signatureDataLength,
    "TDX signature-data length",
    0,
    2 * 1_024 * 1_024,
  );
  const quoteReportDataHex = patternedString(quote.reportDataHex, "TDX report_data", LOWER_HEX_64_PATTERN, 128);
  if (
    parsedQuote.version !== version
    || parsedQuote.attestationKeyType !== attestationKeyType
    || parsedQuote.signatureDataLength !== signatureDataLength
    || parsedQuote.reportDataHex !== quoteReportDataHex
    || quote.format !== `intel-tdx-quote-v${version}`
  ) {
    throw new Error("The retained TDX quote metadata does not match the raw quote.");
  }

  const gpu = exactObject(evidence.gpu, "GPU evidence", ["reportedEvidenceCount", "payloads"]);
  const reportedEvidenceCount = boundedInteger(
    gpu.reportedEvidenceCount,
    "reported GPU evidence count",
    0,
    MAX_GPU_PAYLOADS,
  );
  if (!Array.isArray(gpu.payloads) || gpu.payloads.length > MAX_GPU_PAYLOADS) {
    throw new Error(`GPU evidence payloads must contain at most ${MAX_GPU_PAYLOADS} entries.`);
  }
  scanRawJson(gpu.payloads, "GPU evidence payloads");
  if (reportedEvidenceCount !== gpu.payloads.length || gpuDeviceCount !== gpu.payloads.length) {
    throw new Error("The endpoint-evidence GPU counts disagree.");
  }

  const certificate = exactObject(evidence.certificate, "endpoint certificate", [
    "format", "base64", "byteLength", "binding",
  ]);
  exact(certificate.format, "der", "endpoint certificate format");
  const certificateBase64 = boundedText(certificate.base64, "endpoint certificate base64", 128 * 1_024);
  const certificateDecoded = decodeCanonicalBase64({
    value: certificateBase64,
    label: "endpoint certificate",
    minBytes: 2,
    maxBytes: 64 * 1_024,
  });
  const certificateByteLength = boundedInteger(
    certificate.byteLength,
    "endpoint certificate byte length",
    2,
    64 * 1_024,
  );
  if (certificateDecoded.byteLength !== certificateByteLength || certificateByteLength !== certificateBytes) {
    throw new Error("The endpoint-evidence certificate byte lengths disagree.");
  }
  exact(certificate.binding, "not-established", "endpoint certificate binding");

  const signature = evidence.signature === undefined
    ? undefined
    : exactObject(evidence.signature, "endpoint response signature", [
      "format", "base64", "byteLength",
    ]);
  const attestedBody = evidence.attestedBody === undefined
    ? undefined
    : exactObject(evidence.attestedBody, "attested response body", [
      "format", "base64", "byteLength",
    ]);
  if ((signature === undefined) !== (attestedBody === undefined)) {
    throw new Error("The endpoint response signature and attested body must be supplied together.");
  }
  let signatureBase64: string | undefined;
  let attestedBodyBase64: string | undefined;
  if (signature && attestedBody) {
    exact(signature.format, "rsa-pkcs1v15-sha256", "endpoint response signature format");
    signatureBase64 = boundedText(signature.base64, "endpoint response signature base64", 2 * MAX_RESPONSE_SIGNATURE_BYTES);
    const signatureDecoded = decodeCanonicalBase64({
      value: signatureBase64,
      label: "endpoint response signature",
      minBytes: 1,
      maxBytes: MAX_RESPONSE_SIGNATURE_BYTES,
    });
    const signatureByteLength = boundedInteger(
      signature.byteLength,
      "endpoint response signature byte length",
      1,
      MAX_RESPONSE_SIGNATURE_BYTES,
    );
    if (signatureDecoded.byteLength !== signatureByteLength) {
      throw new Error("The endpoint response signature byte lengths disagree.");
    }
    exact(attestedBody.format, "base64", "attested response body format");
    attestedBodyBase64 = boundedText(attestedBody.base64, "attested response body base64", 2 * MAX_ATTESTED_BODY_BYTES);
    const attestedBodyDecoded = decodeCanonicalBase64({
      value: attestedBodyBase64,
      label: "attested response body",
      minBytes: 1,
      maxBytes: MAX_ATTESTED_BODY_BYTES,
    });
    const attestedBodyByteLength = boundedInteger(
      attestedBody.byteLength,
      "attested response body byte length",
      1,
      MAX_ATTESTED_BODY_BYTES,
    );
    if (attestedBodyDecoded.byteLength !== attestedBodyByteLength) {
      throw new Error("The attested response body byte lengths disagree.");
    }
  }

  const binding = exactObject(record.binding, "endpoint-evidence binding", [
    "construction", "state", "expectedDigestHex", "quotedDigestHex", "reportDataHex",
  ]);
  exact(binding.construction, "SHA-256(UTF8(nonce + e2e_pubkey))", "endpoint-evidence binding construction");
  const bindingState = enumString(binding.state, "endpoint-evidence binding state", ["matched", "failed"] as const);
  const expectedDigestHex = patternedString(
    binding.expectedDigestHex,
    "expected endpoint-binding digest",
    LOWER_HEX_32_PATTERN,
    64,
  );
  const quotedDigestHex = patternedString(
    binding.quotedDigestHex,
    "quoted endpoint-binding digest",
    LOWER_HEX_32_PATTERN,
    64,
  );
  const bindingReportDataHex = patternedString(
    binding.reportDataHex,
    "endpoint-binding report_data",
    LOWER_HEX_64_PATTERN,
    128,
  );
  if (bindingReportDataHex !== quoteReportDataHex || quotedDigestHex !== quoteReportDataHex.slice(0, 64)) {
    throw new Error("The endpoint-evidence binding does not match the retained TDX report_data.");
  }
  if (await sha256Hex(`${requestNonce}${e2ePublicKey}`) !== expectedDigestHex) {
    throw new Error("The endpoint-evidence expected binding digest cannot be recomputed from its retained nonce and key.");
  }
  if ((expectedDigestHex === quotedDigestHex) !== (bindingState === "matched")) {
    throw new Error("The endpoint-evidence binding disposition disagrees with its retained digests.");
  }

  const reconstructedPayloadDigest = await sha256(stableStringify({
    quote: quoteBase64,
    gpu_evidence: gpu.payloads,
    instance_id: instanceId,
    certificate: certificateBase64,
    ...(signatureBase64 ? { signature: signatureBase64 } : {}),
    ...(attestedBodyBase64 ? { attested_body: attestedBodyBase64 } : {}),
  }));
  if (reconstructedPayloadDigest !== payloadDigest) {
    throw new Error("The endpoint-evidence payload digest does not commit its retained raw evidence.");
  }

  const claims = validateClaims(record.claims);
  // Freshness and endpoint-key are not independent verdicts: acquisition defines
  // both as the binding disposition itself. Storage that flipped them to a
  // stronger state while leaving the digests intact would otherwise survive every
  // recomputation above and reach the Proof surface as a checked claim.
  if (claims.nonceFreshness.state !== bindingState || claims.endpointKey.state !== bindingState) {
    throw new Error("The endpoint-evidence freshness and endpoint-key claims disagree with the recomputed binding disposition.");
  }
  const warnings = validateWarnings(record.warnings);
  const publishedPolicy = record.publishedPolicy === undefined
    ? undefined
    : validatePublishedPolicy(record.publishedPolicy, parsedQuote);
  const expectedRecordIdDigest = await sha256(stableStringify({
    version: 1,
    provider: "chutes",
    instanceId,
    chuteId: chuteId ?? null,
    e2ePublicKeyDigest,
    nonce: requestNonce,
    payloadDigest,
  }));
  if (recordId !== `urn:airship:attestation:${expectedRecordIdDigest.slice("sha256:".length)}`) {
    throw new Error("The endpoint-evidence record ID does not commit its immutable acquisition identity.");
  }

  return deepFreeze({
    ...(parsed as ChutesEndpointEvidenceRecord),
    claims,
    warnings,
    ...(publishedPolicy ? { publishedPolicy } : {}),
  });
}

function validateIdentity(value: unknown, profileId: string): EndpointEvidenceRecordIdentity {
  const identity = exactObject(value, "endpoint-evidence identity", [
    "version", "profileId", "sessionId", "receiptId", "instanceId", "endpointKeyDigest",
  ], ["receiptId", "endpointKeyDigest"]);
  exact(identity.version, 1, "endpoint-evidence identity version");
  if (identity.profileId !== profileId) throw new Error("Endpoint evidence crosses its active Profile scope.");
  const sessionId = boundedText(identity.sessionId, "endpoint-evidence session ID", MAX_IDENTIFIER_BYTES);
  const receiptId = identity.receiptId === undefined
    ? undefined
    : boundedText(identity.receiptId, "endpoint-evidence receipt ID", MAX_IDENTIFIER_BYTES);
  const instanceId = identifier(identity.instanceId, "endpoint-evidence instance ID");
  const endpointKeyDigest = identity.endpointKeyDigest === undefined
    ? undefined
    : patternedString(identity.endpointKeyDigest, "endpoint-evidence key digest", SHA256_DIGEST_PATTERN, 80);
  return Object.freeze({
    version: 1,
    profileId,
    sessionId,
    ...(receiptId ? { receiptId } : {}),
    instanceId,
    ...(endpointKeyDigest ? { endpointKeyDigest } : {}),
  });
}

async function parseEnvelope(content: string, profileId: string): Promise<EndpointEvidenceEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The endpoint-evidence checkpoint is not valid JSON.");
  }
  const envelope = exactObject(parsed, "endpoint-evidence checkpoint", [
    "version", "kind", "profileId", "savedAt", "entries",
  ]);
  exact(envelope.version, 1, "endpoint-evidence checkpoint version");
  exact(envelope.kind, "airship-endpoint-evidence-records", "endpoint-evidence checkpoint kind");
  if (envelope.profileId !== profileId) {
    throw new Error("The endpoint-evidence checkpoint does not match the active Profile scope.");
  }
  const savedAt = checkedNow(envelope.savedAt);
  if (!Array.isArray(envelope.entries) || envelope.entries.length > MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORDS) {
    throw new Error(`The endpoint-evidence checkpoint exceeds its ${MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORDS}-record boundary.`);
  }
  const entries: PersistedEndpointEvidenceEntry[] = [];
  const identities = new Set<string>();
  for (const [index, candidate] of envelope.entries.entries()) {
    const raw = exactObject(candidate, `endpoint-evidence entry ${index}`, ["version", "identity", "recordedAt", "record"]);
    exact(raw.version, 1, `endpoint-evidence entry ${index} version`);
    const identity = validateIdentity(raw.identity, profileId);
    const recordedAt = checkedNow(raw.recordedAt);
    const record = await validateEndpointEvidenceRecord(raw.record);
    assertRecordMatchesIdentity(record, identity);
    if (recordedAt !== Date.parse(record.acquisition.fetchedAt)) {
      throw new Error(`Endpoint-evidence entry ${index} recordedAt does not match its immutable acquisition time.`);
    }
    const key = entryIdentityKey(identity);
    if (identities.has(key)) throw new Error("The endpoint-evidence checkpoint contains a duplicate immutable identity.");
    identities.add(key);
    entries.push(deepFreeze({ version: 1, identity, recordedAt, record }));
  }
  return deepFreeze({
    version: 1,
    kind: "airship-endpoint-evidence-records",
    profileId,
    savedAt,
    entries: sortEntries(entries),
  });
}

function assertRecordMatchesIdentity(
  record: ChutesEndpointEvidenceRecord,
  identity: EndpointEvidenceRecordIdentity,
): void {
  if (record.subject.instanceId !== identity.instanceId) {
    throw new Error("Endpoint evidence does not match its session/receipt instance identity.");
  }
  if (identity.endpointKeyDigest && record.subject.e2ePublicKeyDigest !== identity.endpointKeyDigest) {
    throw new Error("Endpoint evidence does not match its session/receipt endpoint-key identity.");
  }
}

function mergeEntries(
  current: readonly PersistedEndpointEvidenceEntry[],
  candidate: PersistedEndpointEvidenceEntry,
): readonly PersistedEndpointEvidenceEntry[] {
  const key = entryIdentityKey(candidate.identity);
  const existing = current.find((entry) => entryIdentityKey(entry.identity) === key);
  const winner = existing && compareEntryEvidence(existing, candidate) >= 0 ? existing : candidate;
  return sortEntries([
    ...current.filter((entry) => entryIdentityKey(entry.identity) !== key),
    winner,
  ]);
}

function compareEntryEvidence(left: PersistedEndpointEvidenceEntry, right: PersistedEndpointEvidenceEntry): number {
  return left.recordedAt - right.recordedAt || left.record.recordId.localeCompare(right.record.recordId);
}

function sortEntries(entries: readonly PersistedEndpointEvidenceEntry[]): readonly PersistedEndpointEvidenceEntry[] {
  return Object.freeze([...entries].sort((left, right) =>
    right.recordedAt - left.recordedAt
    || entryIdentityKey(left.identity).localeCompare(entryIdentityKey(right.identity))
    || left.record.recordId.localeCompare(right.record.recordId)));
}

function entryIdentityKey(identity: EndpointEvidenceRecordIdentity): string {
  return identity.receiptId
    ? `receipt:${identity.sessionId}:${identity.receiptId}`
    : `endpoint:${identity.sessionId}:${identity.instanceId}:${identity.endpointKeyDigest ?? "unbound"}`;
}

function validateClaims(value: unknown): ChutesEndpointEvidenceRecord["claims"] {
  const keys: readonly AttestationClaimKey[] = [
    "evidenceStructure", "nonceFreshness", "endpointKey", "cpuTee", "gpuTee",
    "runtimePolicy", "modelArtifact", "conversation", "request", "response", "payment",
  ];
  const claims = exactObject(value, "endpoint-evidence claims", keys);
  const normalized: Partial<Record<AttestationClaimKey, ChutesEndpointEvidenceRecord["claims"][AttestationClaimKey]>> = {};
  const states: readonly AttestationClaimState[] = [
    "verified", "matched", "present", "unverified", "failed", "expired", "unavailable",
  ];
  for (const key of keys) {
    const claim = exactObject(claims[key], `endpoint-evidence claim ${key}`, [
      "state", "title", "summary", "verifier", "checkedAt",
    ], ["verifier", "checkedAt"]);
    normalized[key] = Object.freeze({
      state: enumString(claim.state, `endpoint-evidence claim ${key} state`, states),
      title: safePublicText(claim.title, `endpoint-evidence claim ${key} title`),
      summary: safePublicText(claim.summary, `endpoint-evidence claim ${key} summary`),
      ...(claim.verifier === undefined ? {} : {
        verifier: safePublicText(claim.verifier, `endpoint-evidence claim ${key} verifier`),
      }),
      ...(claim.checkedAt === undefined ? {} : {
        checkedAt: timestamp(claim.checkedAt, `endpoint-evidence claim ${key} checkedAt`),
      }),
    });
  }
  return deepFreeze(normalized as ChutesEndpointEvidenceRecord["claims"]);
}

function validateWarnings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_WARNING_COUNT) {
    throw new Error(`Endpoint-evidence warnings must contain at most ${MAX_WARNING_COUNT} entries.`);
  }
  return Object.freeze(value.map((warning, index) => safePublicText(warning, `endpoint-evidence warning ${index}`)));
}

function validatePublishedPolicy(
  value: unknown,
  parsedQuote: ParsedTdxQuote,
): NonNullable<ChutesEndpointEvidenceRecord["publishedPolicy"]> {
  const policy = exactObject(value, "published endpoint policy", [
    "sourceUrl", "fetchedAt", "cache", "policyDigest", "policyCount", "quoteMeasurements", "state", "matches",
  ]);
  querylessUrl(policy.sourceUrl);
  timestamp(policy.fetchedAt, "published policy fetchedAt");
  enumString(policy.cache, "published policy cache", ["network", "memory"] as const);
  patternedString(policy.policyDigest, "published policy digest", SHA256_DIGEST_PATTERN, 80);
  boundedInteger(policy.policyCount, "published policy count", 0, 128);
  const measurements = exactObject(policy.quoteMeasurements, "published policy quote measurements", [
    "mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3",
  ]);
  // The Proof surface prints these as the quote's own MRTD/RTMRs, so a
  // well-formed hex string is not enough: they must still be the bytes the
  // retained quote carries, not measurements a rewritten checkpoint chose.
  const quoteMeasurements = extractTdxRuntimeMeasurements(parsedQuote);
  for (const key of ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3"] as const) {
    if (patternedString(measurements[key], `published policy ${key}`, /^[0-9a-f]{96}$/u, 96) !== quoteMeasurements[key]) {
      throw new Error("The retained published-policy quote measurements do not match the raw TDX quote.");
    }
  }
  const policyState = enumString(policy.state, "published policy state", ["matched", "failed"] as const);
  if (!Array.isArray(policy.matches) || policy.matches.length > MAX_PUBLISHED_POLICY_MATCHES) {
    throw new Error(`Published policy matches exceed ${MAX_PUBLISHED_POLICY_MATCHES} entries.`);
  }
  if ((policy.matches.length > 0) !== (policyState === "matched")) {
    throw new Error("The published-policy disposition disagrees with its retained matches.");
  }
  for (const [index, match] of policy.matches.entries()) {
    const candidate = exactObject(match, `published policy match ${index}`, ["version", "name", "expectedGpus", "gpuCount"]);
    safePublicText(candidate.version, `published policy match ${index} version`);
    safePublicText(candidate.name, `published policy match ${index} name`);
    if (!Array.isArray(candidate.expectedGpus) || candidate.expectedGpus.length > MAX_GPU_PAYLOADS) {
      throw new Error(`Published policy match ${index} has too many expected GPUs.`);
    }
    candidate.expectedGpus.forEach((gpu, gpuIndex) =>
      safePublicText(gpu, `published policy match ${index} GPU ${gpuIndex}`));
    boundedInteger(candidate.gpuCount, `published policy match ${index} GPU count`, 0, MAX_GPU_PAYLOADS);
  }
  return deepFreeze(value as NonNullable<ChutesEndpointEvidenceRecord["publishedPolicy"]>);
}

function scanRawJson(value: unknown, label: string): void {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_GPU_JSON_NODES || depth > MAX_GPU_JSON_DEPTH) {
      throw new Error(`${label} exceeds its JSON complexity boundary.`);
    }
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error(`${label} contains a non-finite number.`);
      return;
    }
    if (typeof candidate === "string") {
      if (TEXT_ENCODER.encode(candidate).byteLength > MAX_PERSISTED_ENDPOINT_EVIDENCE_RECORD_BYTES) {
        throw new Error(`${label} contains an oversized string.`);
      }
      if (containsCredentialShapedMaterial(candidate)) {
        throw new Error(`${label} contains credential-shaped material that cannot enter durable evidence.`);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (!candidate || typeof candidate !== "object") throw new Error(`${label} is not a JSON value.`);
    for (const [key, item] of Object.entries(candidate)) {
      if (/^(?:authorization|access_token|refresh_token|id_token|api_key|cookie|credential|bearer|password|client_secret)$/iu.test(key)) {
        throw new Error(`${label} contains a credential-shaped field that cannot enter durable evidence.`);
      }
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function exactObject(
  value: unknown,
  label: string,
  allowed: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const candidate = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(candidate)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains unexpected field ${key}.`);
  }
  const optionalSet = new Set(optional);
  for (const key of allowed) {
    if (!optionalSet.has(key) && !(key in candidate)) throw new Error(`${label} is missing field ${key}.`);
  }
  return candidate;
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`${label} is invalid.`);
}

function enumString<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${label} is invalid.`);
  return value as T;
}

function enumNumber<T extends number>(value: unknown, label: string, values: readonly T[]): T {
  if (typeof value !== "number" || !values.includes(value as T)) throw new Error(`${label} is invalid.`);
  return value as T;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is outside its bounded integer range.`);
  }
  return value as number;
}

function identifier(value: unknown, label: string): string {
  return patternedString(value, label, IDENTIFIER_PATTERN, 256);
}

function patternedString(value: unknown, label: string, pattern: RegExp, maxBytes: number): string {
  const text = boundedText(value, label, maxBytes);
  if (!pattern.test(text)) throw new Error(`${label} has an invalid format.`);
  return text;
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value || TEXT_ENCODER.encode(value).byteLength > maxBytes) {
    throw new Error(`${label} is empty or exceeds its byte boundary.`);
  }
  if (/\u0000/u.test(value)) throw new Error(`${label} contains a null character.`);
  return value;
}

function safePublicText(value: unknown, label: string): string {
  const text = boundedText(value, label, MAX_TEXT_BYTES);
  if (containsCredentialShapedMaterial(text)) {
    throw new Error(`${label} contains credential-shaped material.`);
  }
  return text;
}

function containsCredentialShapedMaterial(value: string): boolean {
  return /\b(?:Bearer\s+\S+|cak_[A-Za-z0-9_-]{8,}|cpk_[A-Za-z0-9_-]{8,}|csc_[A-Za-z0-9_-]{8,})\b/iu.test(value)
    || /[?&](?:access_token|refresh_token|id_token|api_key|authorization|client_secret)=/iu.test(value);
}

function timestamp(value: unknown, label: string): string {
  const text = boundedText(value, label, 64);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) throw new Error(`${label} is not canonical ISO-8601.`);
  return text;
}

function querylessUrl(value: unknown): string {
  const text = boundedText(value, "endpoint-evidence source URL", 2 * 1_024);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("The endpoint-evidence source URL is invalid.");
  }
  if (
    !["https:", "http:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("The endpoint-evidence source URL must be queryless and credential-free.");
  }
  return text;
}

function stringifyJson(value: unknown, label: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not serializable JSON.`);
  }
  if (!serialized) throw new Error(`${label} is not serializable JSON.`);
  return serialized;
}

function jsonBytes(value: unknown): number {
  return TEXT_ENCODER.encode(stringifyJson(value, "endpoint-evidence checkpoint")).byteLength;
}

function checkedNow(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Endpoint-evidence time is invalid.");
  return value as number;
}

function validatedProfileId(value: string): string {
  const profileId = value.trim();
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new TypeError("Endpoint-evidence profile identity must be a lowercase, path-free identifier.");
  }
  return profileId;
}

function normalizeScope(scope: WorkspaceEndpointEvidenceScope): WorkspaceEndpointEvidenceScope {
  if (!scope.workspace || typeof scope.workspace !== "object") {
    throw new TypeError("Endpoint evidence requires an active WorkspacePort authority.");
  }
  const workspaceId = boundedText(scope.workspaceId.trim(), "endpoint-evidence workspace identity", MAX_IDENTIFIER_BYTES);
  if (/[\u0000-\u001f\u007f]/u.test(workspaceId)) {
    throw new TypeError("Endpoint-evidence workspace identity contains control characters.");
  }
  return Object.freeze({
    workspace: scope.workspace,
    workspaceId,
    profileId: validatedProfileId(scope.profileId),
  });
}

function sameScope(left: WorkspaceEndpointEvidenceScope, right: WorkspaceEndpointEvidenceScope): boolean {
  return left.workspace === right.workspace
    && left.workspaceId === right.workspaceId
    && left.profileId === right.profileId;
}

function emptySnapshot(profileId: string, savedAt: number): EndpointEvidenceSnapshot {
  return freezeSnapshot({ version: 1, profileId, savedAt, entries: Object.freeze([]) });
}

function freezeSnapshot(snapshot: EndpointEvidenceSnapshot): EndpointEvidenceSnapshot {
  return deepFreeze({ ...snapshot, entries: Object.freeze([...snapshot.entries]) });
}

function pageOnly(
  entry: PersistedEndpointEvidenceEntry,
  reason: string,
): EndpointEvidenceCommitResult {
  return Object.freeze({ disposition: "page-only", entry, reason });
}

function authorityAbort(): DOMException {
  return new DOMException("The endpoint-evidence storage authority changed.", "AbortError");
}
