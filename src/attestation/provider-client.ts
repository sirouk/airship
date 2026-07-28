import type { JsonValue } from "../core/contracts";
import { sha256, stableStringify } from "../core/hash";
import {
  CHUTES_API_BASE,
  cloneBoundedJson,
  generateAttestationNonce,
  validateChutesEvidenceResponse,
} from "./client";
import { decodeCanonicalBase64 } from "./encoding";
import { verifyNvidiaGpuEvidence, type NvidiaGpuVerification } from "./dcap/nvidia-gpu";
import {
  checkChutesReportDataBinding,
  parseTdxQuote,
  validateChutesE2ePublicKey,
} from "./tdx";
import type {
  AttestationClaimKey,
  AttestationClaimSummary,
  AttestationEvidenceMemoryStats,
  ChutesAttestationAuthorization,
  ChutesAttestationEvidenceClientOptions,
  ChutesE2eDiscoverySnapshot,
  ChutesEndpointEvidenceRecord,
  ChutesEndpointAttestationSnapshot,
  ChutesEvidenceRoute,
  ChutesPublishedPolicyEvaluation,
  ChutesTeeMeasurementPolicy,
  DiscoverChutesE2eEndpointsOptions,
  GetChutesEndpointEvidenceOptions,
  InspectChutesEndpointOptions,
  TdxRuntimeMeasurements,
} from "./provider-types";
import type { AttestationVerifierPorts, ChutesInstanceEvidence, DcapVerificationResult, EvidenceFetchResult, JsonObject, NvidiaVerificationResult, ParsedTdxQuote } from "./types";

export const CHUTES_TEE_MEASUREMENTS_PATH = "/servers/tee/measurements";
export const DEFAULT_ATTESTATION_CACHE_TTL_MS = 90_000;
export const DEFAULT_POLICY_CACHE_TTL_MS = 60 * 60_000;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_POLICY_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_MAX_PROVIDER_EVIDENCE_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_DISCOVERY_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_DISCOVERY_CACHE_TTL_MS = 60_000;
export const MAX_CHUTE_EVIDENCE_ITEMS = 64;
export const MAX_PUBLISHED_TEE_POLICIES = 128;
export const MAX_DISCOVERED_E2E_ENDPOINTS = 16;
export const MAX_PORTABLE_ATTESTATION_BYTES = 3 * 1024 * 1024;

const DEFAULT_MAX_CACHE_ENTRIES = 16;
const DEFAULT_MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 8 * 1024;
const MAX_BEARER_TOKEN_LENGTH = 16 * 1024;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_POLICY_LABEL_LENGTH = 256;
const MAX_GPU_LABEL_LENGTH = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HEX_48_BYTES_PATTERN = /^[0-9a-fA-F]{96}$/;
const RTMR_KEYS = ["RTMR0", "RTMR1", "RTMR2", "RTMR3"] as const;
const CHUTE_EVIDENCE_FIELDS = new Set(["evidence", "failed_instance_ids"]);
const E2E_DISCOVERY_FIELDS = new Set(["instances", "nonce_expires_in", "nonce_expires_at"]);
const E2E_INSTANCE_FIELDS = new Set(["instance_id", "e2e_pubkey", "nonces"]);
const POLICY_FIELDS = new Set([
  "version",
  "name",
  "mrtd",
  "boot_rtmrs",
  "runtime_rtmrs",
  "expected_gpus",
  "gpu_count",
]);

export type AttestationEvidenceClientErrorCode =
  | "invalid-input"
  | "network"
  | "cross-origin-unreadable"
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "http"
  | "invalid-content-type"
  | "response-too-large"
  | "invalid-json"
  | "invalid-response"
  | "subject-not-found"
  | "evidence-unavailable";

export class AttestationEvidenceClientError extends Error {
  readonly context: Readonly<{
    status?: number;
    requestUrl?: string;
    retryable?: boolean;
  }>;

  constructor(
    readonly code: AttestationEvidenceClientErrorCode,
    message: string,
    context: Readonly<{
      status?: number;
      requestUrl?: string;
      retryable?: boolean;
      cause?: unknown;
    }> = {},
  ) {
    // Provider and credential exceptions can contain secrets. They are never
    // retained as public Error.cause/context data in this static client.
    super(message);
    this.name = "AttestationEvidenceClientError";
    this.context = Object.freeze({
      ...(context.status === undefined ? {} : { status: context.status }),
      ...(context.requestUrl === undefined ? {} : { requestUrl: context.requestUrl }),
      ...(context.retryable === undefined ? {} : { retryable: context.retryable }),
    });
  }
}

type ResolvedOptions = Readonly<{
  fetch: typeof fetch;
  apiBase: URL;
  authorization?: ChutesAttestationAuthorization;
  cacheTtlMs: number;
  policyCacheTtlMs: number;
  timeoutMs: number;
  maxResponseBytes: number;
  maxPolicyResponseBytes: number;
  maxDiscoveryResponseBytes: number;
  maxCacheEntries: number;
  maxCacheBytes: number;
  discoveryCacheTtlMs: number;
  now: () => number;
  randomValues?: (target: Uint8Array) => void;
  verifierPorts?: AttestationVerifierPorts;
}>;

type ValidatedRequest = Readonly<{
  route: ChutesEvidenceRoute;
  chuteId?: string;
  instanceId: string;
  e2ePublicKey: string;
  includePublishedPolicy: boolean;
}>;

type RecordCacheEntry = Readonly<{
  record: ChutesEndpointEvidenceRecord;
  freshUntil: number;
  bytes: number;
}>;

type SharedFlight<T> = {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
};

type PolicySnapshot = Readonly<{
  sourceUrl: string;
  fetchedAt: string;
  cache: "network" | "memory";
  digest: string;
  policies: readonly ChutesTeeMeasurementPolicy[];
}>;

type DiscoveryCacheEntry = Readonly<{
  snapshot: ChutesE2eDiscoverySnapshot;
  freshUntil: number;
}>;

/**
 * Browser-direct Chutes endpoint-evidence client.
 *
 * It intentionally produces endpoint evidence records, not conversation proof.
 * A configured browser verifier can independently establish Intel TDX and the
 * client also evaluates supported NVIDIA evidence, but Chutes does not currently
 * return a model-artifact- or transcript-bound enclave signature. Those claim
 * axes therefore remain separate and fail closed.
 */
export class ChutesAttestationEvidenceClient {
  private readonly options: ResolvedOptions;
  private readonly cache = new Map<string, RecordCacheEntry>();
  private readonly inFlight = new Map<string, SharedFlight<ChutesEndpointEvidenceRecord>>();
  private readonly discoveryCache = new Map<string, DiscoveryCacheEntry>();
  private readonly discoveryFlights = new Map<string, SharedFlight<ChutesE2eDiscoverySnapshot>>();
  private cacheBytes = 0;
  private cacheEvictionTimer?: ReturnType<typeof setTimeout>;
  private policyCache?: Readonly<{ snapshot: PolicySnapshot; freshUntil: number }>;
  private policyFlight?: SharedFlight<PolicySnapshot>;
  private disposed = false;

  constructor(options: ChutesAttestationEvidenceClientOptions = {}) {
    this.options = resolveOptions(options);
  }

  async get(options: GetChutesEndpointEvidenceOptions): Promise<ChutesEndpointEvidenceRecord> {
    this.assertActive();
    throwIfAborted(options.signal);
    const request = validateRequest(options, this.options.authorization);
    const key = cacheKey(request, this.options);
    const now = checkedNow(this.options.now);

    if (!options.forceRefresh) {
      const cached = this.cache.get(key);
      if (cached && cached.freshUntil > now) {
        this.touchCache(key, cached);
        return withRecordCacheState(cached.record, "memory");
      }
      if (cached) this.deleteRecordCacheEntry(key, cached);
    } else {
      this.abortFlight(key, "Superseded by a newer attestation evidence refresh.");
    }

    const flight = this.inFlight.get(key) ?? this.startRecordFlight(key, request);
    flight.waiters += 1;
    try {
      return await abortable(flight.promise, options.signal);
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(abortError("No attestation evidence callers remain."));
      }
    }
  }

  /** Latest-call-wins refresh for the exact endpoint subject. */
  refresh(options: GetChutesEndpointEvidenceOptions): Promise<ChutesEndpointEvidenceRecord> {
    return this.get({ ...options, forceRefresh: true });
  }

  memoryStats(): AttestationEvidenceMemoryStats {
    return Object.freeze({
      evidenceEntries: this.cache.size,
      evidenceBytes: this.cacheBytes,
      discoveryEntries: this.discoveryCache.size,
      policyCached: Boolean(this.policyCache),
    });
  }

  /**
   * Discover the current Chutes E2E key for the exact receipt instance, then
   * acquire endpoint evidence. This is current endpoint evidence only; it does
   * not retroactively bind a prior conversation.
   */
  async inspect(options: InspectChutesEndpointOptions): Promise<ChutesEndpointAttestationSnapshot> {
    this.assertActive();
    throwIfAborted(options.signal);
    const chuteId = validateIdentifier(options.chuteId, "Chutes chute ID");
    const instanceId = validateIdentifier(options.instanceId, "Chutes instance ID");
    const inspectedAt = new Date(checkedNow(this.options.now)).toISOString();
    let discovery: ChutesE2eDiscoverySnapshot | undefined;
    try {
      discovery = await this.discover(chuteId, {
        signal: options.signal,
        forceRefresh: options.forceRefresh,
      });
      const endpoint = discovery.endpoints.find((candidate) => candidate.instanceId === instanceId);
      if (!endpoint) {
        throw new AttestationEvidenceClientError(
          "subject-not-found",
          "The exact receipt instance was not present in the bounded Chutes E2E discovery result; no substitute instance was accepted.",
          { retryable: true, requestUrl: discovery.sourceUrl },
        );
      }
      const record = await this.get({
        route: options.evidenceRoute ?? "instance",
        chuteId,
        instanceId,
        e2ePublicKey: endpoint.e2ePublicKey,
        includePublishedPolicy: options.includePublishedPolicy,
        forceRefresh: options.forceRefresh,
        signal: options.signal,
      });
      return deepFreeze({
        version: 1,
        provider: "chutes",
        chuteId,
        requestedInstanceId: instanceId,
        inspectedAt,
        status: "evidence",
        discovery,
        record,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof AttestationEvidenceClientError && error.code === "invalid-input") {
        throw error;
      }
      const unavailable = publicUnavailable(error);
      return deepFreeze({
        version: 1,
        provider: "chutes",
        chuteId,
        requestedInstanceId: instanceId,
        inspectedAt,
        status: "unavailable",
        ...(discovery ? { discovery } : {}),
        unavailable,
      });
    }
  }

  /** Authenticated `/e2e/instances/{chuteId}` discovery with nonce redaction. */
  async discover(
    chuteIdValue: string,
    options: DiscoverChutesE2eEndpointsOptions = {},
  ): Promise<ChutesE2eDiscoverySnapshot> {
    this.assertActive();
    throwIfAborted(options.signal);
    if (!this.options.authorization) {
      throw new AttestationEvidenceClientError(
        "invalid-input",
        "Chutes E2E endpoint discovery requires bearer authorization.",
      );
    }
    const chuteId = validateIdentifier(chuteIdValue, "Chutes chute ID");
    const key = discoveryCacheKey(chuteId, this.options);
    const now = checkedNow(this.options.now);
    if (!options.forceRefresh) {
      const cached = this.discoveryCache.get(key);
      if (cached && cached.freshUntil > now) {
        this.discoveryCache.delete(key);
        this.discoveryCache.set(key, cached);
        return withDiscoveryCacheState(cached.snapshot, "memory");
      }
      if (cached) this.discoveryCache.delete(key);
    } else {
      this.abortDiscoveryFlight(key, "Superseded by a newer E2E discovery refresh.");
    }
    const flight = this.discoveryFlights.get(key) ?? this.startDiscoveryFlight(key, chuteId);
    flight.waiters += 1;
    try {
      return await abortable(flight.promise, options.signal);
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(abortError("No E2E discovery callers remain."));
      }
    }
  }

  /** Abort work for one subject, or all provider/policy requests when omitted. */
  cancel(options?: Omit<GetChutesEndpointEvidenceOptions, "signal" | "forceRefresh">): void {
    if (!options) {
      for (const [key] of this.inFlight) this.abortFlight(key, "Attestation refresh cancelled.");
      for (const [key] of this.discoveryFlights) {
        this.abortDiscoveryFlight(key, "E2E discovery refresh cancelled.");
      }
      const policyFlight = this.policyFlight;
      this.policyFlight = undefined;
      policyFlight?.controller.abort(abortError("Attestation policy refresh cancelled."));
      return;
    }
    const request = validateRequest(options, this.options.authorization);
    this.abortFlight(cacheKey(request, this.options), "Attestation refresh cancelled.");
    if (request.chuteId && this.options.authorization) {
      this.abortDiscoveryFlight(
        discoveryCacheKey(request.chuteId, this.options),
        "E2E discovery refresh cancelled.",
      );
    }
  }

  clear(): void {
    if (this.cacheEvictionTimer !== undefined) clearTimeout(this.cacheEvictionTimer);
    this.cacheEvictionTimer = undefined;
    this.cache.clear();
    this.cacheBytes = 0;
    this.discoveryCache.clear();
    this.policyCache = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.clear();
  }

  private startRecordFlight(
    key: string,
    request: ValidatedRequest,
  ): SharedFlight<ChutesEndpointEvidenceRecord> {
    const controller = new AbortController();
    const flight: SharedFlight<ChutesEndpointEvidenceRecord> = {
      controller,
      promise: Promise.resolve(undefined as never),
      waiters: 0,
      settled: false,
    };
    flight.promise = abortable(this.fetchRecord(request, controller.signal), controller.signal)
      .then((record) => {
        if (!this.disposed && this.inFlight.get(key) === flight) {
          const freshUntil = Date.parse(record.acquisition.cacheFreshUntil);
          this.putRecordCacheEntry(key, record, freshUntil);
        }
        return record;
      })
      .finally(() => {
        flight.settled = true;
        if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
      });
    this.inFlight.set(key, flight);
    return flight;
  }

  private async fetchRecord(
    request: ValidatedRequest,
    signal: AbortSignal,
  ): Promise<ChutesEndpointEvidenceRecord> {
    const timeout = createTimeout(signal, this.options.timeoutMs);
    let acquisitionStageComplete = false;
    try {
      const nonce = generateAttestationNonce(this.options.randomValues);
      const evidencePromise = this.fetchEvidence(request, nonce, timeout.signal);
      const policyPromise = request.includePublishedPolicy
        ? this.loadPublishedPolicy(timeout.signal).then(
            (value) => ({ value } as const),
            (error: unknown) => {
              // The policy feed is optional corroborating metadata. A timeout on
              // that public request must not erase evidence that was already
              // acquired successfully. Explicit cancellation of the shared
              // acquisition still propagates through the caller-owned signal.
              if (isAbortError(error) && signal.aborted) throw error;
              return { error } as const;
            },
          )
        : Promise.resolve(undefined);

      // Attach settlement handlers to both concurrent requests before either
      // can fail. Awaiting them one after another leaves the optional policy
      // promise unobserved when evidence fails first; cancelling the shared
      // flight would then surface a stray AbortError after the caller had
      // already received the primary failure.
      const [fetched, policyResult] = await Promise.all([evidencePromise, policyPromise]);
      // Evidence and the optional policy request have settled. Retire their
      // shared network deadline before starting local verifier work, which has
      // its own bounded deadline below.
      acquisitionStageComplete = true;
      timeout.dispose();
      const fetchedAtMs = Date.parse(fetched.fetchedAt);
      const cacheFreshUntil = new Date(fetchedAtMs + this.options.cacheTtlMs).toISOString();
      const parsedQuote = parseTdxQuote(fetched.evidence.quote);
      const certificate = decodeCanonicalBase64({
        value: fetched.evidence.certificate,
        label: "evidence.certificate",
        minBytes: 2,
        maxBytes: 64 * 1024,
      });
      const binding = await checkChutesReportDataBinding({
        quoteBase64: fetched.evidence.quote,
        nonce,
        e2ePublicKey: request.e2ePublicKey,
      });
      const evidenceJson = portableEvidenceJson(fetched.evidence);
      const payloadDigest = await sha256(stableStringify(evidenceJson));
      const e2ePublicKeyDigest = await sha256(request.e2ePublicKey);
      const publishedPolicy =
        policyResult && "value" in policyResult
          ? evaluatePublishedPolicy(parsedQuote, policyResult.value)
          : undefined;
      const policyUnavailable = policyResult && "error" in policyResult;
      const recordIdDigest = await sha256(stableStringify({
        version: 1,
        provider: "chutes",
        instanceId: request.instanceId,
        chuteId: request.chuteId ?? null,
        e2ePublicKeyDigest,
        nonce,
        payloadDigest,
      }));
      const checkedAt = fetched.fetchedAt;
      // Real Intel TDX (DCAP) verification when a verifier port is configured.
      // Fails closed: any thrown error leaves the claim at its structural default.
      let dcapResult: DcapVerificationResult | undefined;
      const dcapPort = this.options.verifierPorts?.dcap;
      let nvidiaResult: NvidiaGpuVerification | undefined;
      let nvidiaVerifierResult: NvidiaVerificationResult | undefined;
      const nvidiaPort = this.options.verifierPorts?.nvidia;
      const verifierTimeout = createTimeout(signal, this.options.timeoutMs);
      try {
        if (dcapPort) {
          try {
            dcapResult = await abortable(Promise.resolve(dcapPort.verify({
              instanceId: request.instanceId,
              nonce,
              e2ePublicKey: request.e2ePublicKey,
              evidence: fetched.evidence,
              parsedQuote,
              expectedBindingDigestHex: binding.expectedDigestHex,
            }, verifierTimeout.signal)), verifierTimeout.signal);
          } catch (error) {
            if (verifierTimeout.didTimeout() || signal.aborted) throw error;
            dcapResult = undefined;
          }
        }
        // The live Chutes artifact exposes the NVIDIA SPDM request nonce but
        // not a self-contained browser-verifiable NRAS/RIM/OCSP verdict. Match
        // that nonce locally, then allow an explicitly configured independent
        // verifier port to promote the claim. Never promote the byte match.
        try {
          nvidiaResult = await abortable(
            verifyNvidiaGpuEvidence(
              fetched.evidence.gpuEvidence,
              binding.expectedDigestHex,
            ),
            verifierTimeout.signal,
          );
          if (nvidiaPort && nvidiaResult.state === "matched") {
            nvidiaVerifierResult = await abortable(Promise.resolve(nvidiaPort.verify({
              instanceId: request.instanceId,
              nonce,
              e2ePublicKey: request.e2ePublicKey,
              gpuEvidence: fetched.evidence.gpuEvidence,
              expectedBindingDigestHex: binding.expectedDigestHex,
            }, verifierTimeout.signal)), verifierTimeout.signal);
          }
        } catch (error) {
          if (verifierTimeout.didTimeout() || signal.aborted) throw error;
          nvidiaVerifierResult = undefined;
        }
      } catch (error) {
        if (verifierTimeout.didTimeout()) {
          throw new AttestationEvidenceClientError(
            "timeout",
            "Chutes attestation evidence verification timed out.",
            { retryable: true },
          );
        }
        throw error;
      } finally {
        verifierTimeout.dispose();
      }
      const claims = buildClaims({
        bindingMatched: binding.matched,
        checkedAt,
        gpuEvidenceCount: fetched.evidence.gpuEvidence.length,
        policy: publishedPolicy,
        policyRequested: request.includePublishedPolicy,
        policyUnavailable: Boolean(policyUnavailable),
        dcapResult,
        dcapVerifier: dcapPort ? `${dcapPort.id}@${dcapPort.version}` : undefined,
        nvidiaResult,
        nvidiaVerifierResult,
        nvidiaVerifier: nvidiaPort ? `${nvidiaPort.id}@${nvidiaPort.version}` : undefined,
      });
      const warnings = buildWarnings({
        gpuEvidenceCount: fetched.evidence.gpuEvidence.length,
        policy: publishedPolicy,
        policyRequested: request.includePublishedPolicy,
        policyUnavailable: Boolean(policyUnavailable),
        dcapVerified: dcapResult?.status === "verified",
        nvidiaState: nvidiaResult?.state,
        nvidiaVerifierState: nvidiaVerifierResult?.status,
        nvidiaVerifierConfigured: Boolean(nvidiaPort),
      });

      return deepFreeze({
        version: 1,
        recordId: `urn:airship:attestation:${recordIdDigest.slice("sha256:".length)}`,
        provider: "chutes",
        kind: "endpoint-evidence",
        verdict:
          !binding.matched || publishedPolicy?.state === "failed"
            ? "rejected"
            : "evidence-only",
        subject: {
          scope: "endpoint",
          ...(request.chuteId ? { chuteId: request.chuteId } : {}),
          instanceId: request.instanceId,
          e2ePublicKey: request.e2ePublicKey,
          e2ePublicKeyDigest,
        },
        acquisition: {
          endpoint: request.route === "instance" ? "instance-evidence" : "chute-evidence",
          requestUrl: fetched.requestUrl,
          requestNonce: nonce,
          fetchedAt: fetched.fetchedAt,
          cacheFreshUntil,
          freshUntil: cacheFreshUntil,
          authorization: request.route === "instance" ? "bearer" : "public",
          auth: request.route === "instance" ? "bearer" : "public",
          cache: "network",
        },
        evidence: {
          format: "chutes-tee-instance-evidence/v1",
          payloadDigest,
          quoteBytes: parsedQuote.bytes.byteLength,
          certificateBytes: certificate.byteLength,
          gpuDeviceCount: fetched.evidence.gpuEvidence.length,
          quote: {
            format: parsedQuote.version === 4 ? "intel-tdx-quote-v4" : "intel-tdx-quote-v5",
            base64: fetched.evidence.quote,
            byteLength: parsedQuote.bytes.byteLength,
            version: parsedQuote.version,
            attestationKeyType: parsedQuote.attestationKeyType,
            teeType: "0x81",
            signatureDataLength: parsedQuote.signatureDataLength,
            reportDataHex: parsedQuote.reportDataHex,
          },
          gpu: {
            reportedEvidenceCount: fetched.evidence.gpuEvidence.length,
            payloads: fetched.evidence.gpuEvidence,
          },
          certificate: {
            format: "der",
            base64: fetched.evidence.certificate,
            byteLength: certificate.byteLength,
            binding: "not-established",
          },
        },
        binding: {
          construction: "SHA-256(UTF8(nonce + e2e_pubkey))",
          state: binding.matched ? "matched" : "failed",
          expectedDigestHex: binding.expectedDigestHex,
          quotedDigestHex: binding.quotedDigestHex,
          reportDataHex: binding.reportDataHex,
        },
        ...(publishedPolicy ? { publishedPolicy } : {}),
        claims,
        warnings,
      } satisfies ChutesEndpointEvidenceRecord);
    } catch (error) {
      if (timeout.didTimeout() && !acquisitionStageComplete) {
        throw new AttestationEvidenceClientError(
          "timeout",
          "Chutes attestation evidence request timed out.",
          { retryable: true, cause: error },
        );
      }
      throw error;
    } finally {
      timeout.dispose();
    }
  }

  private async fetchEvidence(
    request: ValidatedRequest,
    nonce: string,
    signal: AbortSignal,
  ): Promise<EvidenceFetchResult> {
    const url = request.route === "instance"
      ? new URL(`/instances/${encodeURIComponent(request.instanceId)}/evidence`, this.options.apiBase)
      : new URL(`/chutes/${encodeURIComponent(request.chuteId!)}/evidence`, this.options.apiBase);
    url.searchParams.set("nonce", nonce);
    const headers = new Headers({ Accept: "application/json" });
    if (request.route === "instance") {
      const authorization = this.options.authorization;
      if (!authorization) {
        throw new AttestationEvidenceClientError(
          "invalid-input",
          "The Chutes per-instance evidence route requires bearer authorization.",
        );
      }
      headers.set("Authorization", `Bearer ${await resolveBearer(authorization, signal)}`);
    }
    const body = await requestJson(
      this.options.fetch,
      url.toString(),
      headers,
      signal,
      this.options.maxResponseBytes,
    );
    let evidence: ChutesInstanceEvidence;
    try {
      evidence = request.route === "instance"
        ? validateChutesEvidenceResponse(body, request.instanceId)
        : selectChuteEvidence(body, request.instanceId);
    } catch (error) {
      if (error instanceof AttestationEvidenceClientError) throw error;
      throw new AttestationEvidenceClientError(
        "invalid-response",
        error instanceof Error ? error.message : "Chutes returned invalid attestation evidence.",
        { requestUrl: url.toString(), retryable: false, cause: error },
      );
    }
    return Object.freeze({
      nonce,
      requestUrl: url.toString(),
      fetchedAt: new Date(checkedNow(this.options.now)).toISOString(),
      evidence,
    });
  }

  private startDiscoveryFlight(
    key: string,
    chuteId: string,
  ): SharedFlight<ChutesE2eDiscoverySnapshot> {
    const controller = new AbortController();
    const flight: SharedFlight<ChutesE2eDiscoverySnapshot> = {
      controller,
      promise: Promise.resolve(undefined as never),
      waiters: 0,
      settled: false,
    };
    flight.promise = abortable(this.fetchDiscovery(chuteId, controller.signal), controller.signal)
      .then((snapshot) => {
        if (!this.disposed && this.discoveryFlights.get(key) === flight) {
          const freshUntil = Date.parse(snapshot.cacheFreshUntil);
          this.discoveryCache.set(key, Object.freeze({ snapshot, freshUntil }));
          this.trimDiscoveryCache();
        }
        return snapshot;
      })
      .finally(() => {
        flight.settled = true;
        if (this.discoveryFlights.get(key) === flight) this.discoveryFlights.delete(key);
      });
    this.discoveryFlights.set(key, flight);
    return flight;
  }

  private async fetchDiscovery(
    chuteId: string,
    signal: AbortSignal,
  ): Promise<ChutesE2eDiscoverySnapshot> {
    const authorization = this.options.authorization;
    if (!authorization) {
      throw new AttestationEvidenceClientError(
        "invalid-input",
        "Chutes E2E endpoint discovery requires bearer authorization.",
      );
    }
    const timeout = createTimeout(signal, this.options.timeoutMs);
    const url = new URL(`/e2e/instances/${encodeURIComponent(chuteId)}`, this.options.apiBase);
    try {
      const token = await resolveBearer(authorization, timeout.signal);
      const body = await requestJson(
        this.options.fetch,
        url.toString(),
        new Headers({ Accept: "application/json", Authorization: `Bearer ${token}` }),
        timeout.signal,
        this.options.maxDiscoveryResponseBytes,
      );
      let normalized: ReturnType<typeof validateDiscoveryResponse>;
      try {
        normalized = validateDiscoveryResponse(body);
      } catch (error) {
        if (error instanceof AttestationEvidenceClientError && error.code !== "invalid-input") {
          throw error;
        }
        throw new AttestationEvidenceClientError(
          "invalid-response",
          error instanceof Error ? error.message : "Chutes returned invalid E2E discovery data.",
          { requestUrl: url.toString(), retryable: false, cause: error },
        );
      }
      const fetchedAtMs = checkedNow(this.options.now);
      const providerExpiryMs = normalized.nonceExpiresAtSeconds * 1_000;
      if (providerExpiryMs <= fetchedAtMs) {
        throw new AttestationEvidenceClientError(
          "invalid-response",
          "Chutes E2E discovery returned an already-expired nonce window.",
          { requestUrl: url.toString(), retryable: true },
        );
      }
      const cacheFreshUntilMs = Math.min(
        fetchedAtMs + this.options.discoveryCacheTtlMs,
        providerExpiryMs,
      );
      return deepFreeze({
        version: 1,
        provider: "chutes",
        kind: "e2e-endpoint-discovery",
        chuteId,
        sourceUrl: url.toString(),
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        cacheFreshUntil: new Date(cacheFreshUntilMs).toISOString(),
        cache: "network",
        authorization: "bearer",
        providerNonceExpiresAt: new Date(providerExpiryMs).toISOString(),
        providerNonceExpiresInSeconds: normalized.nonceExpiresInSeconds,
        endpoints: normalized.endpoints,
      });
    } catch (error) {
      if (timeout.didTimeout()) {
        throw new AttestationEvidenceClientError(
          "timeout",
          "Chutes E2E endpoint discovery timed out.",
          { requestUrl: url.toString(), retryable: true, cause: error },
        );
      }
      throw error;
    } finally {
      timeout.dispose();
    }
  }

  private async loadPublishedPolicy(signal: AbortSignal): Promise<PolicySnapshot> {
    const now = checkedNow(this.options.now);
    if (this.policyCache && this.policyCache.freshUntil > now) {
      return withPolicyCacheState(this.policyCache.snapshot, "memory");
    }
    if (this.policyCache) this.policyCache = undefined;
    const flight = this.policyFlight ?? this.startPolicyFlight();
    flight.waiters += 1;
    try {
      return await abortable(flight.promise, signal);
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(abortError("No TEE policy callers remain."));
      }
    }
  }

  private startPolicyFlight(): SharedFlight<PolicySnapshot> {
    const controller = new AbortController();
    const flight: SharedFlight<PolicySnapshot> = {
      controller,
      promise: Promise.resolve(undefined as never),
      waiters: 0,
      settled: false,
    };
    flight.promise = abortable(this.fetchPublishedPolicy(controller.signal), controller.signal)
      .then((snapshot) => {
        if (!this.disposed && this.policyFlight === flight) {
          this.policyCache = Object.freeze({
            snapshot,
            freshUntil: checkedNow(this.options.now) + this.options.policyCacheTtlMs,
          });
        }
        return snapshot;
      })
      .finally(() => {
        flight.settled = true;
        if (this.policyFlight === flight) this.policyFlight = undefined;
      });
    this.policyFlight = flight;
    return flight;
  }

  private async fetchPublishedPolicy(signal: AbortSignal): Promise<PolicySnapshot> {
    const url = new URL(CHUTES_TEE_MEASUREMENTS_PATH, this.options.apiBase).toString();
    const body = await requestJson(
      this.options.fetch,
      url,
      new Headers({ Accept: "application/json" }),
      signal,
      this.options.maxPolicyResponseBytes,
    );
    let policies: readonly ChutesTeeMeasurementPolicy[];
    try {
      policies = validatePublishedTeePolicies(body);
    } catch (error) {
      throw new AttestationEvidenceClientError(
        "invalid-response",
        error instanceof Error ? error.message : "Chutes returned an invalid TEE policy feed.",
        { requestUrl: url, retryable: false, cause: error },
      );
    }
    const digest = await sha256(stableStringify(policyJson(policies)));
    return deepFreeze({
      sourceUrl: url,
      fetchedAt: new Date(checkedNow(this.options.now)).toISOString(),
      cache: "network",
      digest,
      policies,
    });
  }

  private abortFlight(key: string, message: string): void {
    const flight = this.inFlight.get(key);
    if (!flight) return;
    this.inFlight.delete(key);
    flight.controller.abort(abortError(message));
  }

  private abortDiscoveryFlight(key: string, message: string): void {
    const flight = this.discoveryFlights.get(key);
    if (!flight) return;
    this.discoveryFlights.delete(key);
    flight.controller.abort(abortError(message));
  }

  private trimCache(): void {
    while (
      this.cache.size > this.options.maxCacheEntries ||
      this.cacheBytes > this.options.maxCacheBytes
    ) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) return;
      const entry = this.cache.get(oldest);
      if (!entry) return;
      this.deleteRecordCacheEntry(oldest, entry, false);
    }
  }

  private putRecordCacheEntry(
    key: string,
    record: ChutesEndpointEvidenceRecord,
    freshUntil: number,
  ): void {
    const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    const existing = this.cache.get(key);
    if (existing) this.deleteRecordCacheEntry(key, existing, false);
    if (bytes > this.options.maxCacheBytes) return;
    this.cache.set(key, Object.freeze({ record, freshUntil, bytes }));
    this.cacheBytes += bytes;
    this.trimCache();
    this.scheduleCacheEviction();
  }

  private deleteRecordCacheEntry(
    key: string,
    entry: RecordCacheEntry,
    reschedule = true,
  ): void {
    if (!this.cache.delete(key)) return;
    this.cacheBytes = Math.max(0, this.cacheBytes - entry.bytes);
    if (reschedule) this.scheduleCacheEviction();
  }

  private scheduleCacheEviction(): void {
    if (this.cacheEvictionTimer !== undefined) clearTimeout(this.cacheEvictionTimer);
    this.cacheEvictionTimer = undefined;
    if (this.disposed || this.cache.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.cache.values()) earliest = Math.min(earliest, entry.freshUntil);
    let now: number;
    try {
      now = checkedNow(this.options.now);
    } catch {
      this.cache.clear();
      this.cacheBytes = 0;
      return;
    }
    const delay = Math.min(Math.max(0, earliest - now), 2_147_483_647);
    this.cacheEvictionTimer = setTimeout(() => {
      this.cacheEvictionTimer = undefined;
      let current: number;
      try {
        current = checkedNow(this.options.now);
      } catch {
        this.cache.clear();
        this.cacheBytes = 0;
        return;
      }
      for (const [key, entry] of this.cache) {
        if (entry.freshUntil <= current) this.deleteRecordCacheEntry(key, entry, false);
      }
      this.scheduleCacheEviction();
    }, delay);
  }

  private trimDiscoveryCache(): void {
    while (this.discoveryCache.size > this.options.maxCacheEntries) {
      const oldest = this.discoveryCache.keys().next().value as string | undefined;
      if (!oldest) return;
      this.discoveryCache.delete(oldest);
    }
  }

  private touchCache(key: string, entry: RecordCacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new AttestationEvidenceClientError(
        "invalid-input",
        "The Chutes attestation evidence client has been disposed.",
      );
    }
  }
}

export function validatePublishedTeePolicies(value: unknown): readonly ChutesTeeMeasurementPolicy[] {
  if (!Array.isArray(value)) throw new Error("TEE measurement policy response must be an array");
  if (value.length > MAX_PUBLISHED_TEE_POLICIES) {
    throw new Error(`TEE measurement policy response exceeds ${MAX_PUBLISHED_TEE_POLICIES} entries`);
  }
  return deepFreeze(value.map((entry, index) => validatePolicy(entry, index)));
}

export function extractTdxRuntimeMeasurements(quote: ParsedTdxQuote): TdxRuntimeMeasurements {
  const bodyOffset = quote.reportBodyOffset;
  return Object.freeze({
    mrtd: sliceHex(quote.bytes, bodyOffset + 136, 48),
    rtmr0: sliceHex(quote.bytes, bodyOffset + 328, 48),
    rtmr1: sliceHex(quote.bytes, bodyOffset + 376, 48),
    rtmr2: sliceHex(quote.bytes, bodyOffset + 424, 48),
    rtmr3: sliceHex(quote.bytes, bodyOffset + 472, 48),
  });
}

export type ExportChutesEndpointEvidenceOptions = Readonly<{
  /** Explicit opt-in: raw quote, certificate, and GPU payloads can be large. */
  includeRawEvidence?: boolean;
}>;

export function exportChutesEndpointEvidenceRecord(
  record: ChutesEndpointEvidenceRecord,
  options: ExportChutesEndpointEvidenceOptions = {},
): string {
  let portable: JsonValue;
  try {
    portable = cloneBoundedJson(
      options.includeRawEvidence ? record : redactedPortableRecord(record),
      "attestation evidence export",
    );
  } catch (error) {
    throw new AttestationEvidenceClientError(
      "invalid-input",
      "The attestation evidence record is not a bounded portable JSON value.",
      { cause: error },
    );
  }
  const serialized = JSON.stringify(portable, null, 2);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PORTABLE_ATTESTATION_BYTES) {
    throw new AttestationEvidenceClientError(
      "response-too-large",
      "The portable attestation evidence record exceeds the export limit.",
    );
  }
  return serialized;
}

function validateRequest(
  options: Omit<GetChutesEndpointEvidenceOptions, "signal" | "forceRefresh">,
  authorization: ChutesAttestationAuthorization | undefined,
): ValidatedRequest {
  const instanceId = validateIdentifier(options.instanceId, "Chutes instance ID");
  const chuteId = options.chuteId === undefined
    ? undefined
    : validateIdentifier(options.chuteId, "Chutes chute ID");
  validateChutesE2ePublicKey(options.e2ePublicKey);
  const route = options.route ?? (authorization ? "instance" : "public-chute");
  if (route === "instance" && !authorization) {
    throw new AttestationEvidenceClientError(
      "invalid-input",
      "The Chutes per-instance evidence route requires bearer authorization.",
    );
  }
  if (route === "public-chute" && !chuteId) {
    throw new AttestationEvidenceClientError(
      "invalid-input",
      "A chute ID is required for anonymous public-chute evidence.",
    );
  }
  return Object.freeze({
    route,
    ...(chuteId ? { chuteId } : {}),
    instanceId,
    e2ePublicKey: options.e2ePublicKey,
    includePublishedPolicy: options.includePublishedPolicy ?? true,
  });
}

function resolveOptions(options: ChutesAttestationEvidenceClientOptions): ResolvedOptions {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AttestationEvidenceClientError("invalid-input", "Fetch API is unavailable.");
  }
  if (options.authorization) {
    const partition = options.authorization.cachePartition;
    if (
      typeof partition !== "string" ||
      partition.length === 0 ||
      partition.length > MAX_IDENTIFIER_LENGTH ||
      /[\u0000-\u001f]/.test(partition)
    ) {
      throw new AttestationEvidenceClientError(
        "invalid-input",
        "Attestation authorization cachePartition is invalid.",
      );
    }
    if (typeof options.authorization.getBearerToken !== "function") {
      throw new AttestationEvidenceClientError(
        "invalid-input",
        "Attestation authorization requires getBearerToken.",
      );
    }
  }
  return Object.freeze({
    fetch: fetchImpl,
    apiBase: validateBaseUrl(options.apiBase ?? CHUTES_API_BASE),
    authorization: options.authorization,
    verifierPorts: options.verifierPorts,
    cacheTtlMs: boundedInteger(
      options.cacheTtlMs ?? DEFAULT_ATTESTATION_CACHE_TTL_MS,
      "cacheTtlMs",
      1,
      15 * 60_000,
    ),
    policyCacheTtlMs: boundedInteger(
      options.policyCacheTtlMs ?? DEFAULT_POLICY_CACHE_TTL_MS,
      "policyCacheTtlMs",
      1,
      24 * 60 * 60_000,
    ),
    timeoutMs: boundedInteger(
      options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      "timeoutMs",
      1,
      120_000,
    ),
    maxResponseBytes: boundedInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_PROVIDER_EVIDENCE_RESPONSE_BYTES,
      "maxResponseBytes",
      1,
      DEFAULT_MAX_PROVIDER_EVIDENCE_RESPONSE_BYTES,
    ),
    maxPolicyResponseBytes: boundedInteger(
      options.maxPolicyResponseBytes ?? DEFAULT_MAX_POLICY_RESPONSE_BYTES,
      "maxPolicyResponseBytes",
      1,
      DEFAULT_MAX_POLICY_RESPONSE_BYTES,
    ),
    maxDiscoveryResponseBytes: boundedInteger(
      options.maxDiscoveryResponseBytes ?? DEFAULT_MAX_DISCOVERY_RESPONSE_BYTES,
      "maxDiscoveryResponseBytes",
      1,
      DEFAULT_MAX_DISCOVERY_RESPONSE_BYTES,
    ),
    maxCacheEntries: boundedInteger(
      options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
      "maxCacheEntries",
      1,
      128,
    ),
    maxCacheBytes: boundedInteger(
      options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES,
      "maxCacheBytes",
      1,
      64 * 1024 * 1024,
    ),
    discoveryCacheTtlMs: boundedInteger(
      options.discoveryCacheTtlMs ?? DEFAULT_DISCOVERY_CACHE_TTL_MS,
      "discoveryCacheTtlMs",
      1,
      5 * 60_000,
    ),
    now: options.now ?? Date.now,
    randomValues: options.randomValues,
  });
}

function selectChuteEvidence(value: unknown, expectedInstanceId: string): ChutesInstanceEvidence {
  if (!isRecord(value)) throw new Error("Chute evidence response must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!CHUTE_EVIDENCE_FIELDS.has(key)) {
      throw new Error(`Chute evidence response contains unexpected field ${JSON.stringify(key)}`);
    }
  }
  if (!Array.isArray(value.evidence)) throw new Error("chute evidence must be an array");
  if (value.evidence.length > MAX_CHUTE_EVIDENCE_ITEMS) {
    throw new Error(`chute evidence exceeds ${MAX_CHUTE_EVIDENCE_ITEMS} instances`);
  }
  const byInstance = new Map<string, ChutesInstanceEvidence>();
  for (const [index, item] of value.evidence.entries()) {
    if (!isRecord(item) || typeof item.instance_id !== "string") {
      throw new Error(`evidence[${index}].instance_id must be a string`);
    }
    const instanceId = validateIdentifier(item.instance_id, `evidence[${index}].instance_id`);
    if (byInstance.has(instanceId)) {
      throw new Error(`chute evidence contains duplicate instance ${JSON.stringify(instanceId)}`);
    }
    byInstance.set(instanceId, validateChutesEvidenceResponse(item, instanceId));
  }
  if (!Array.isArray(value.failed_instance_ids)) {
    throw new Error("failed_instance_ids must be an array");
  }
  if (value.failed_instance_ids.length > MAX_CHUTE_EVIDENCE_ITEMS) {
    throw new Error(`failed_instance_ids exceeds ${MAX_CHUTE_EVIDENCE_ITEMS} entries`);
  }
  const failed = new Set<string>();
  for (const [index, item] of value.failed_instance_ids.entries()) {
    if (typeof item !== "string") throw new Error(`failed_instance_ids[${index}] must be a string`);
    const instanceId = validateIdentifier(item, `failed_instance_ids[${index}]`);
    if (failed.has(instanceId)) throw new Error("failed_instance_ids contains duplicates");
    if (byInstance.has(instanceId)) {
      throw new Error("an instance cannot have evidence and be listed as failed");
    }
    failed.add(instanceId);
  }
  const selected = byInstance.get(expectedInstanceId);
  if (selected) return selected;
  if (failed.has(expectedInstanceId)) {
    throw new AttestationEvidenceClientError(
      "evidence-unavailable",
      "Chutes reported that evidence retrieval failed for the selected instance.",
      { retryable: true },
    );
  }
  throw new AttestationEvidenceClientError(
    "subject-not-found",
    "The selected instance was not present in the chute evidence response.",
    { retryable: true },
  );
}

function validateDiscoveryResponse(value: unknown): Readonly<{
  nonceExpiresInSeconds: number;
  nonceExpiresAtSeconds: number;
  endpoints: ChutesE2eDiscoverySnapshot["endpoints"];
}> {
  if (!isRecord(value)) throw new Error("Chutes E2E discovery response must be an object");
  for (const key of Object.keys(value)) {
    if (!E2E_DISCOVERY_FIELDS.has(key)) {
      throw new Error(`Chutes E2E discovery contains unexpected field ${JSON.stringify(key)}`);
    }
  }
  if (!Array.isArray(value.instances) || value.instances.length > MAX_DISCOVERED_E2E_ENDPOINTS) {
    throw new Error(`Chutes E2E discovery must contain at most ${MAX_DISCOVERED_E2E_ENDPOINTS} instances`);
  }
  if (value.instances.length === 0) throw new Error("Chutes E2E discovery returned no instances");
  if (
    !Number.isSafeInteger(value.nonce_expires_in) ||
    (value.nonce_expires_in as number) < 1 ||
    (value.nonce_expires_in as number) > 3_600
  ) {
    throw new Error("nonce_expires_in must be an integer between 1 and 3600");
  }
  if (
    !Number.isSafeInteger(value.nonce_expires_at) ||
    (value.nonce_expires_at as number) < 1
  ) {
    throw new Error("nonce_expires_at must be a positive Unix timestamp");
  }
  const seen = new Set<string>();
  const endpoints = value.instances.map((entry, index) => {
    const label = `instances[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!E2E_INSTANCE_FIELDS.has(key)) {
        throw new Error(`${label} contains unexpected field ${JSON.stringify(key)}`);
      }
    }
    const instanceId = validateIdentifier(entry.instance_id, `${label}.instance_id`);
    if (seen.has(instanceId)) throw new Error("Chutes E2E discovery contains duplicate instances");
    seen.add(instanceId);
    if (typeof entry.e2e_pubkey !== "string") throw new Error(`${label}.e2e_pubkey must be a string`);
    validateChutesE2ePublicKey(entry.e2e_pubkey);
    if (!Array.isArray(entry.nonces) || entry.nonces.length > 32) {
      throw new Error(`${label}.nonces must contain at most 32 invocation nonces`);
    }
    for (const [nonceIndex, nonce] of entry.nonces.entries()) {
      if (
        typeof nonce !== "string" ||
        nonce.length < 16 ||
        nonce.length > 256 ||
        !/^[A-Za-z0-9_-]+$/.test(nonce)
      ) {
        throw new Error(`${label}.nonces[${nonceIndex}] is invalid`);
      }
    }
    return Object.freeze({
      instanceId,
      e2ePublicKey: entry.e2e_pubkey,
      discardedInvocationNonceCount: entry.nonces.length,
    });
  });
  return deepFreeze({
    nonceExpiresInSeconds: value.nonce_expires_in as number,
    nonceExpiresAtSeconds: value.nonce_expires_at as number,
    endpoints,
  });
}

function validatePolicy(value: unknown, index: number): ChutesTeeMeasurementPolicy {
  const label = `TEE measurement policy[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!POLICY_FIELDS.has(key)) throw new Error(`${label} contains unexpected field ${JSON.stringify(key)}`);
  }
  const version = boundedLabel(value.version, `${label}.version`, MAX_POLICY_LABEL_LENGTH);
  const name = boundedLabel(value.name, `${label}.name`, MAX_POLICY_LABEL_LENGTH);
  const mrtd = measurementHex(value.mrtd, `${label}.mrtd`);
  const bootRtmrs = validateRtmrs(value.boot_rtmrs, `${label}.boot_rtmrs`);
  const runtimeRtmrs = validateRtmrs(value.runtime_rtmrs, `${label}.runtime_rtmrs`);
  if (!Array.isArray(value.expected_gpus) || value.expected_gpus.length > 32) {
    throw new Error(`${label}.expected_gpus must contain at most 32 entries`);
  }
  const expectedGpus = value.expected_gpus.map((item, gpuIndex) =>
    boundedLabel(item, `${label}.expected_gpus[${gpuIndex}]`, MAX_GPU_LABEL_LENGTH));
  if (!Number.isSafeInteger(value.gpu_count) || (value.gpu_count as number) < 0 || (value.gpu_count as number) > 64) {
    throw new Error(`${label}.gpu_count must be an integer between 0 and 64`);
  }
  return deepFreeze({
    version,
    name,
    mrtd,
    bootRtmrs,
    runtimeRtmrs,
    expectedGpus,
    gpuCount: value.gpu_count as number,
  });
}

function validateRtmrs(
  value: unknown,
  label: string,
): Readonly<Record<"RTMR0" | "RTMR1" | "RTMR2" | "RTMR3", string>> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (Object.keys(value).length !== RTMR_KEYS.length || Object.keys(value).some((key) => !RTMR_KEYS.includes(key as typeof RTMR_KEYS[number]))) {
    throw new Error(`${label} must contain exactly RTMR0 through RTMR3`);
  }
  return Object.freeze({
    RTMR0: measurementHex(value.RTMR0, `${label}.RTMR0`),
    RTMR1: measurementHex(value.RTMR1, `${label}.RTMR1`),
    RTMR2: measurementHex(value.RTMR2, `${label}.RTMR2`),
    RTMR3: measurementHex(value.RTMR3, `${label}.RTMR3`),
  });
}

function evaluatePublishedPolicy(
  quote: ParsedTdxQuote,
  snapshot: PolicySnapshot,
): ChutesPublishedPolicyEvaluation {
  const quoteMeasurements = extractTdxRuntimeMeasurements(quote);
  const matches = snapshot.policies
    .filter((policy) =>
      policy.mrtd === quoteMeasurements.mrtd &&
      policy.runtimeRtmrs.RTMR0 === quoteMeasurements.rtmr0 &&
      policy.runtimeRtmrs.RTMR1 === quoteMeasurements.rtmr1 &&
      policy.runtimeRtmrs.RTMR2 === quoteMeasurements.rtmr2 &&
      policy.runtimeRtmrs.RTMR3 === quoteMeasurements.rtmr3)
    .map((policy) => Object.freeze({
      version: policy.version,
      name: policy.name,
      expectedGpus: policy.expectedGpus,
      gpuCount: policy.gpuCount,
    }));
  return deepFreeze({
    sourceUrl: snapshot.sourceUrl,
    fetchedAt: snapshot.fetchedAt,
    cache: snapshot.cache,
    policyDigest: snapshot.digest,
    policyCount: snapshot.policies.length,
    quoteMeasurements,
    state: matches.length > 0 ? "matched" : "failed",
    matches,
  });
}

function buildClaims(args: {
  bindingMatched: boolean;
  checkedAt: string;
  gpuEvidenceCount: number;
  policy?: ChutesPublishedPolicyEvaluation;
  policyRequested: boolean;
  policyUnavailable: boolean;
  dcapResult?: DcapVerificationResult;
  dcapVerifier?: string;
  nvidiaResult?: NvidiaGpuVerification;
  nvidiaVerifierResult?: NvidiaVerificationResult;
  nvidiaVerifier?: string;
}): Readonly<Record<AttestationClaimKey, AttestationClaimSummary>> {
  const checkedAt = args.checkedAt;
  const localVerifier = "airship-structural-check/v1";
  const dcapVerifier = args.dcapVerifier ?? "intel-dcap-not-configured";
  const nvidiaBindingVerifier = "airship-nvidia-spdm-binding/v1";
  const verifiedNvidia = args.nvidiaVerifierResult?.status === "verified"
    ? {
        state: "verified" as const,
        title: "NVIDIA GPU authenticity",
        summary: args.nvidiaVerifierResult.summary,
        verifier: args.nvidiaVerifier ?? "nvidia-verifier",
        checkedAt,
      }
    : undefined;
  const failedNvidia = args.nvidiaVerifierResult && args.nvidiaVerifierResult.status !== "partial" && args.nvidiaVerifierResult.status !== "unavailable"
    ? {
        state: args.nvidiaVerifierResult.status as "failed" | "expired",
        title: "NVIDIA GPU authenticity",
        summary: args.nvidiaVerifierResult.summary,
        verifier: args.nvidiaVerifier ?? "nvidia-verifier",
        checkedAt,
      }
    : undefined;
  const gpuTeeClaim: AttestationClaimSummary = args.nvidiaResult?.state === "failed"
    ? { state: "failed", title: "NVIDIA GPU evidence binding", summary: args.nvidiaResult.summary, verifier: nvidiaBindingVerifier, checkedAt }
    : verifiedNvidia
      ? verifiedNvidia
      : failedNvidia
        ? failedNvidia
        : args.nvidiaResult?.state === "matched"
          ? {
              state: args.nvidiaVerifierResult?.status === "partial" ? "unverified" : "matched",
              title: "NVIDIA GPU evidence binding",
              summary: args.nvidiaVerifierResult?.status === "partial"
                ? `${args.nvidiaResult.summary} ${args.nvidiaVerifierResult.summary}`
                : args.nvidiaVerifierResult?.status === "unavailable"
                  ? `${args.nvidiaResult.summary} The configured independent NVIDIA verifier was unavailable: ${args.nvidiaVerifierResult.summary}`
                  : args.nvidiaResult.summary,
              verifier: args.nvidiaVerifierResult ? `${nvidiaBindingVerifier}+${args.nvidiaVerifier ?? "nvidia-verifier"}` : nvidiaBindingVerifier,
              checkedAt,
            }
    : args.gpuEvidenceCount > 0
      ? { state: "unverified", title: "NVIDIA GPU evidence binding", summary: args.nvidiaResult?.summary ?? `${args.gpuEvidenceCount} GPU evidence object${args.gpuEvidenceCount === 1 ? " is" : "s are"} present, but the SPDM request binding could not be checked.`, checkedAt }
      : { state: "unavailable", title: "NVIDIA GPU authenticity", summary: "The response contains no GPU evidence objects.", checkedAt };
  const cpuTeeClaim: AttestationClaimSummary = args.dcapResult?.status === "verified"
    ? { state: "verified", title: "Intel TDX authenticity", summary: args.dcapResult.summary, verifier: dcapVerifier, checkedAt }
    : args.dcapResult?.status === "partial"
      ? { state: "unverified", title: "Intel TDX authenticity", summary: args.dcapResult.summary, verifier: dcapVerifier, checkedAt }
    : args.dcapResult && args.dcapResult.status !== "unavailable"
      ? { state: "failed", title: "Intel TDX authenticity", summary: args.dcapResult.summary, verifier: dcapVerifier, checkedAt }
      : args.dcapResult?.status === "unavailable"
        ? { state: "unavailable", title: "Intel TDX authenticity", summary: args.dcapResult.summary, verifier: dcapVerifier, checkedAt }
        : { state: "unverified", title: "Intel TDX authenticity", summary: "A supported TDX quote-v4/v5 structure is present, but DCAP signature, collateral, TCB status, debug state, and policy were not independently verified.", checkedAt };
  const unavailable = (title: string, summary: string): AttestationClaimSummary =>
    Object.freeze({ state: "unavailable", title, summary, checkedAt });
  return deepFreeze({
    evidenceStructure: {
      state: "present",
      title: "Evidence envelope",
      summary: "The bounded TDX quote, GPU evidence, and DER certificate envelope parsed structurally.",
      verifier: localVerifier,
      checkedAt,
    },
    nonceFreshness: {
      state: args.bindingMatched ? "matched" : "failed",
      title: "Challenge freshness",
      summary: args.bindingMatched
        ? args.dcapResult?.status === "verified"
          ? "The caller-generated nonce is bound by report_data in a locally QVL-verified TDX quote."
          : "The caller-generated nonce matches report_data locally; authenticity still depends on complete DCAP verification."
        : "The caller-generated nonce does not match the digest carried in report_data.",
      verifier: localVerifier,
      checkedAt,
    },
    endpointKey: {
      state: args.bindingMatched ? "matched" : "failed",
      title: "E2EE endpoint key",
      summary: args.bindingMatched
        ? args.dcapResult?.status === "verified"
          ? "The selected ML-KEM public key is bound by report_data in a locally QVL-verified TDX quote."
          : "The discovered ML-KEM public key matches report_data locally; quote authenticity is not fully verified."
        : "The discovered ML-KEM public key is not bound by the returned report_data.",
      verifier: localVerifier,
      checkedAt,
    },
    cpuTee: cpuTeeClaim,
    gpuTee: gpuTeeClaim,
    runtimePolicy: args.policy
      ? {
          state: args.policy.state,
          title: "Published runtime policy",
          summary: args.policy.state === "matched"
            ? `Quote measurements match ${args.policy.matches.length} Chutes-published runtime polic${args.policy.matches.length === 1 ? "y" : "ies"}; this is a local comparison to an unsigned provider feed.`
            : "Quote measurements do not match any currently published Chutes runtime policy.",
          verifier: localVerifier,
          checkedAt,
        }
      : unavailable(
          "Published runtime policy",
          args.policyRequested && args.policyUnavailable
            ? "The public Chutes TEE measurement policy could not be loaded or validated."
            : "Published TEE measurement comparison was not requested.",
        ),
    modelArtifact: unavailable(
      "Model artifact",
      "Chutes endpoint evidence does not carry a model-weights digest or model-artifact signature.",
    ),
    conversation: unavailable(
      "Conversation",
      "Chutes endpoint evidence is not an enclave-signed conversation receipt.",
    ),
    request: unavailable(
      "Request binding",
      "The endpoint evidence does not bind the plaintext or ciphertext request digest.",
    ),
    response: unavailable(
      "Response binding",
      "The endpoint evidence does not bind the plaintext or ciphertext response digest.",
    ),
    payment: unavailable(
      "Payment",
      "The endpoint evidence does not contain a signed usage or settlement receipt.",
    ),
  });
}

function buildWarnings(args: {
  gpuEvidenceCount: number;
  policy?: ChutesPublishedPolicyEvaluation;
  policyRequested: boolean;
  policyUnavailable: boolean;
  dcapVerified: boolean;
  nvidiaState?: NvidiaGpuVerification["state"];
  nvidiaVerifierState?: NvidiaVerificationResult["status"];
  nvidiaVerifierConfigured: boolean;
}): readonly string[] {
  const warnings = [
    args.dcapVerified
      ? "Intel DCAP QVL authenticity is locally verified; its collateral validity uses the browser wall clock."
      : "Evidence retrieval and local byte comparisons do not authenticate an Intel TDX quote.",
    "Chute and instance IDs are provider correlation metadata; quote report_data binds neither identifier.",
    "The certificate is reference material; this record does not establish a certificate-to-quote binding.",
    "Endpoint evidence does not prove model weights, a request, a response, a conversation, usage, or payment.",
  ];
  if (args.gpuEvidenceCount > 0) {
    warnings.push(args.nvidiaVerifierState === "verified"
      ? "The configured NVIDIA verifier reported a complete GPU verdict; Airship also matched every GPU evidence request nonce to the TDX endpoint binding."
      : args.nvidiaState === "matched"
        ? "Every NVIDIA SPDM request nonce matched the TDX endpoint binding locally; GPU authenticity, revocation, RIM/firmware, freshness, and confidential-mode policy remain unverified."
        : "NVIDIA evidence is present but complete GPU attestation is not established.");
    if (args.nvidiaVerifierConfigured && !args.nvidiaVerifierState) {
      warnings.push("The configured independent NVIDIA verifier did not return a usable result; the local nonce-binding result was retained without promotion.");
    }
  }
  if (args.policy) {
    warnings.push("The measurement policy is Chutes-published HTTPS data, not a separately signed transparency artifact.");
  } else if (args.policyRequested && args.policyUnavailable) {
    warnings.push("Published measurement policy was unavailable; no stale policy was used.");
  }
  return Object.freeze(warnings);
}

function portableEvidenceJson(evidence: ChutesInstanceEvidence): JsonValue {
  return {
    quote: evidence.quote,
    gpu_evidence: evidence.gpuEvidence,
    instance_id: evidence.reportedInstanceId ?? evidence.instanceId,
    certificate: evidence.certificate,
  } as JsonValue;
}

function policyJson(policies: readonly ChutesTeeMeasurementPolicy[]): JsonValue {
  return policies.map((policy) => ({
    version: policy.version,
    name: policy.name,
    mrtd: policy.mrtd,
    boot_rtmrs: { ...policy.bootRtmrs },
    runtime_rtmrs: { ...policy.runtimeRtmrs },
    expected_gpus: [...policy.expectedGpus],
    gpu_count: policy.gpuCount,
  })) as unknown as JsonValue;
}

function cacheKey(request: ValidatedRequest, options: ResolvedOptions): string {
  const partition = request.route === "instance"
    ? options.authorization?.cachePartition ?? "missing"
    : "anonymous-public";
  return [
    options.apiBase.origin,
    request.route,
    partition,
    request.chuteId ?? "-",
    request.instanceId,
    request.e2ePublicKey,
    request.includePublishedPolicy ? "policy" : "no-policy",
  ].join("|");
}

function discoveryCacheKey(chuteId: string, options: ResolvedOptions): string {
  return [
    options.apiBase.origin,
    "e2e-discovery",
    options.authorization?.cachePartition ?? "missing",
    chuteId,
  ].join("|");
}

function withRecordCacheState(
  record: ChutesEndpointEvidenceRecord,
  cache: "network" | "memory",
): ChutesEndpointEvidenceRecord {
  if (record.acquisition.cache === cache) return record;
  return deepFreeze({
    ...record,
    acquisition: { ...record.acquisition, cache },
  });
}

function withPolicyCacheState(snapshot: PolicySnapshot, cache: "network" | "memory"): PolicySnapshot {
  if (snapshot.cache === cache) return snapshot;
  return deepFreeze({ ...snapshot, cache });
}

function withDiscoveryCacheState(
  snapshot: ChutesE2eDiscoverySnapshot,
  cache: "network" | "memory",
): ChutesE2eDiscoverySnapshot {
  if (snapshot.cache === cache) return snapshot;
  return deepFreeze({ ...snapshot, cache });
}

function publicUnavailable(error: unknown): ChutesEndpointAttestationSnapshot["unavailable"] {
  if (error instanceof AttestationEvidenceClientError) {
    return Object.freeze({
      code: error.code,
      message: error.message,
      retryable: error.context.retryable ?? false,
      ...(error.context.status === undefined ? {} : { status: error.context.status }),
    });
  }
  return Object.freeze({
    code: "unexpected",
    message: "Attestation evidence inspection failed closed.",
    retryable: false,
  });
}

async function resolveBearer(
  authorization: ChutesAttestationAuthorization,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  let token: string;
  try {
    token = await abortable(Promise.resolve(authorization.getBearerToken(signal)), signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new AttestationEvidenceClientError(
      "invalid-input",
      "Could not obtain the ephemeral Chutes bearer token.",
      { cause: error },
    );
  }
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_BEARER_TOKEN_LENGTH ||
    /[\r\n]/.test(token)
  ) {
    throw new AttestationEvidenceClientError(
      "invalid-input",
      "The ephemeral Chutes bearer token is invalid.",
    );
  }
  return token;
}

async function requestJson(
  fetchImpl: typeof fetch,
  requestUrl: string,
  headers: Headers,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await abortable(Promise.resolve(fetchImpl(requestUrl, {
      method: "GET",
      headers,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    })), signal);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (isBrowserCrossOrigin(requestUrl)) {
      throw new AttestationEvidenceClientError(
        "cross-origin-unreadable",
        "The browser could not read the cross-origin Chutes attestation response. CORS authorization or the network path may have failed; no proof was accepted.",
        { requestUrl, retryable: true, cause: error },
      );
    }
    throw new AttestationEvidenceClientError(
      "network",
      "Chutes attestation evidence request failed.",
      { requestUrl, retryable: true, cause: error },
    );
  }
  if (!response.ok) {
    await drainBounded(response, MAX_ERROR_RESPONSE_BYTES, signal);
    const code = response.status === 401
      ? "unauthorized"
      : response.status === 403
        ? "forbidden"
        : "http";
    throw new AttestationEvidenceClientError(
      code,
      `Chutes attestation endpoint returned HTTP ${response.status}.`,
      {
        status: response.status,
        requestUrl,
        retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
      },
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/.test(contentType)) {
    await drainBounded(response, MAX_ERROR_RESPONSE_BYTES, signal);
    throw new AttestationEvidenceClientError(
      "invalid-content-type",
      "Chutes attestation endpoint did not return JSON.",
      { requestUrl, retryable: false },
    );
  }
  const text = await readBoundedUtf8(response, maxResponseBytes, requestUrl, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AttestationEvidenceClientError(
      "invalid-json",
      "Chutes attestation endpoint returned invalid JSON.",
      { requestUrl, retryable: false, cause: error },
    );
  }
}

async function readBoundedUtf8(
  response: Response,
  maximum: number,
  requestUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new AttestationEvidenceClientError(
        "invalid-response",
        "Chutes attestation endpoint returned an invalid Content-Length header.",
        { requestUrl, retryable: false },
      );
    }
    if (Number(contentLength) > maximum) {
      await response.body?.cancel();
      throw new AttestationEvidenceClientError(
        "response-too-large",
        "Chutes attestation response exceeded the safe byte limit.",
        { requestUrl, retryable: false },
      );
    }
  }
  if (!response.body) {
    throw new AttestationEvidenceClientError(
      "invalid-response",
      "Chutes attestation endpoint returned an empty body.",
      { requestUrl, retryable: true },
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel("attestation response too large");
        throw new AttestationEvidenceClientError(
          "response-too-large",
          "Chutes attestation response exceeded the safe byte limit.",
          { requestUrl, retryable: false },
        );
      }
      chunks.push(value);
    }
  } finally {
    if (signal.aborted) void reader.cancel(signal.reason).catch(() => undefined);
    try { reader.releaseLock(); } catch { /* an aborted body may retain its reader */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AttestationEvidenceClientError(
      "invalid-response",
      "Chutes attestation response was not valid UTF-8.",
      { requestUrl, retryable: false, cause: error },
    );
  }
}

async function drainBounded(response: Response, maximum: number, signal: AbortSignal): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (total <= maximum) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) return;
      total += value.byteLength;
    }
    await reader.cancel("attestation error response limit reached");
  } catch {
    // Provider error bodies may contain sensitive detail and are never surfaced.
  } finally {
    if (signal.aborted) void reader.cancel(signal.reason).catch(() => undefined);
    try { reader.releaseLock(); } catch { /* an aborted body may retain its reader */ }
  }
}

function createTimeout(parent: AbortSignal, timeoutMs: number): Readonly<{
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
}> {
  const controller = new AbortController();
  let timedOut = false;
  const forward = () => controller.abort(parent.reason);
  if (parent.aborted) forward();
  else parent.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(abortError("Attestation evidence request timed out."));
  }, timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", forward);
    },
  });
}

function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AttestationEvidenceClientError(
      "invalid-input",
      "Chutes API base URL is invalid.",
      { cause: error },
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new AttestationEvidenceClientError(
      "invalid-input",
      "Chutes API base URL must be HTTPS without credentials, query, or fragment.",
    );
  }
  return url;
}

function validateIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new AttestationEvidenceClientError("invalid-input", `${label} is invalid.`);
  }
  return value;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AttestationEvidenceClientError(
      "invalid-input",
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function boundedLabel(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function measurementHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX_48_BYTES_PATTERN.test(value)) {
    throw new Error(`${label} must be 48-byte hexadecimal`);
  }
  return value.toLowerCase();
}

function sliceHex(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.slice(offset, offset + length);
  if (slice.byteLength !== length) throw new Error("TDX quote is truncated before measurements");
  let value = "";
  for (const byte of slice) value += byte.toString(16).padStart(2, "0");
  return value;
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || value < 0) {
    throw new AttestationEvidenceClientError("invalid-input", "Attestation client clock is invalid.");
  }
  return value;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError("The operation was aborted.");
}

function abortError(message: string): Error {
  if (typeof DOMException === "function") return new DOMException(message, "AbortError");
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBrowserCrossOrigin(requestUrl: string): boolean {
  if (typeof globalThis.location?.origin !== "string") return false;
  try {
    return new URL(requestUrl).origin !== globalThis.location.origin;
  } catch {
    return false;
  }
}

function redactedPortableRecord(record: ChutesEndpointEvidenceRecord): JsonValue {
  return {
    ...record,
    subject: {
      scope: record.subject.scope,
      ...(record.subject.chuteId ? { chuteId: record.subject.chuteId } : {}),
      instanceId: record.subject.instanceId,
      e2ePublicKey: "omitted-by-default",
      e2ePublicKeyDigest: record.subject.e2ePublicKeyDigest,
    },
    acquisition: {
      ...record.acquisition,
      requestUrl: endpointUrlWithoutQuery(record.acquisition.requestUrl),
      requestNonce: "omitted-by-default",
    },
    evidence: {
      format: record.evidence.format,
      payloadDigest: record.evidence.payloadDigest,
      quoteBytes: record.evidence.quoteBytes,
      certificateBytes: record.evidence.certificateBytes,
      gpuDeviceCount: record.evidence.gpuDeviceCount,
      quote: {
        format: record.evidence.quote.format,
        byteLength: record.evidence.quote.byteLength,
        version: record.evidence.quote.version,
        attestationKeyType: record.evidence.quote.attestationKeyType,
        teeType: record.evidence.quote.teeType,
        signatureDataLength: record.evidence.quote.signatureDataLength,
        reportDataHex: "omitted-by-default",
        rawEvidence: "omitted-by-default",
      },
      gpu: {
        reportedEvidenceCount: record.evidence.gpu.reportedEvidenceCount,
        rawEvidence: "omitted-by-default",
      },
      certificate: {
        format: record.evidence.certificate.format,
        byteLength: record.evidence.certificate.byteLength,
        binding: record.evidence.certificate.binding,
        rawEvidence: "omitted-by-default",
      },
    },
    binding: {
      construction: record.binding.construction,
      state: record.binding.state,
      expectedDigestHex: "omitted-by-default",
      quotedDigestHex: "omitted-by-default",
      reportDataHex: "omitted-by-default",
    },
  } as unknown as JsonValue;
}

function endpointUrlWithoutQuery(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString();
  } catch {
    return "omitted-by-default";
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export type {
  AttestationClaimState,
  ChutesEndpointEvidenceRecord,
} from "./provider-types";
