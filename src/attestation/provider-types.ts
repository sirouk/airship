import type { AttestationVerifierPorts, JsonObject } from "./types";

export type AttestationClaimState =
  | "verified"
  | "matched"
  | "present"
  | "unverified"
  | "failed"
  | "expired"
  | "unavailable";

export type AttestationClaimKey =
  | "evidenceStructure"
  | "nonceFreshness"
  | "endpointKey"
  | "cpuTee"
  | "gpuTee"
  | "runtimePolicy"
  | "modelArtifact"
  | "conversation"
  | "request"
  | "response"
  | "payment";

export type AttestationClaimSummary = Readonly<{
  state: AttestationClaimState;
  title: string;
  summary: string;
  verifier?: string;
  checkedAt?: string;
}>;

export type ChutesAttestationSubject = Readonly<{
  scope: "endpoint";
  /** API/discovery correlation only; neither ID is carried in quote report_data. */
  chuteId?: string;
  instanceId: string;
  e2ePublicKey: string;
  /** `sha256:` base64url digest of the canonical base64 public-key string. */
  e2ePublicKeyDigest: string;
}>;

export type ChutesEvidenceRoute = "instance" | "public-chute";

export type ChutesAttestationAcquisition = Readonly<{
  endpoint: "instance-evidence" | "chute-evidence";
  requestUrl: string;
  requestNonce: string;
  fetchedAt: string;
  /** Airship's bounded memory-cache deadline, not a provider proof expiry. */
  cacheFreshUntil: string;
  /** Compatibility alias for `cacheFreshUntil`; this is not evidence expiry. */
  freshUntil: string;
  authorization: "bearer" | "public";
  /** Compatibility alias for `authorization`. */
  auth: "bearer" | "public";
  cache: "network" | "memory";
}>;

export type TdxRuntimeMeasurements = Readonly<{
  mrtd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
}>;

export type ChutesTeeMeasurementPolicy = Readonly<{
  version: string;
  name: string;
  mrtd: string;
  bootRtmrs: Readonly<Record<"RTMR0" | "RTMR1" | "RTMR2" | "RTMR3", string>>;
  runtimeRtmrs: Readonly<Record<"RTMR0" | "RTMR1" | "RTMR2" | "RTMR3", string>>;
  expectedGpus: readonly string[];
  gpuCount: number;
}>;

export type ChutesPublishedPolicyEvaluation = Readonly<{
  sourceUrl: string;
  fetchedAt: string;
  cache: "network" | "memory";
  policyDigest: string;
  policyCount: number;
  quoteMeasurements: TdxRuntimeMeasurements;
  state: "matched" | "failed";
  matches: readonly Readonly<{
    version: string;
    name: string;
    expectedGpus: readonly string[];
    gpuCount: number;
  }>[];
}>;

export type ChutesEndpointEvidenceRecord = Readonly<{
  version: 1;
  recordId: string;
  provider: "chutes";
  kind: "endpoint-evidence";
  /**
   * Envelope disposition, not the final trust tier. `evidence-only` permits
   * claim-by-claim evaluation; the gate still requires verified CPU QVL,
   * matched freshness/key binding, and matched runtime measurements.
   */
  verdict: "evidence-only" | "rejected";
  subject: ChutesAttestationSubject;
  acquisition: ChutesAttestationAcquisition;
  evidence: Readonly<{
    format: "chutes-tee-instance-evidence/v1";
    payloadDigest: string;
    quoteBytes: number;
    certificateBytes: number;
    gpuDeviceCount: number;
    quote: Readonly<{
      format: "intel-tdx-quote-v4" | "intel-tdx-quote-v5";
      base64: string;
      byteLength: number;
      version: 4 | 5;
      attestationKeyType: 2 | 3;
      teeType: "0x81";
      signatureDataLength: number;
      reportDataHex: string;
    }>;
    gpu: Readonly<{
      reportedEvidenceCount: number;
      payloads: readonly JsonObject[];
    }>;
    certificate: Readonly<{
      format: "der";
      base64: string;
      byteLength: number;
      /** Chutes documents this certificate as reference material only. */
      binding: "not-established";
    }>;
    /** Optional response-authentication material from attestation proxy >= 0.2.0. */
    signature?: Readonly<{
      format: "rsa-pkcs1v15-sha256";
      base64: string;
      byteLength: number;
    }>;
    /** Exact response bytes covered by `signature`, when supplied by Chutes. */
    attestedBody?: Readonly<{
      format: "base64";
      base64: string;
      byteLength: number;
    }>;
  }>;
  binding: Readonly<{
    construction: "SHA-256(UTF8(nonce + e2e_pubkey))";
    state: "matched" | "failed";
    expectedDigestHex: string;
    quotedDigestHex: string;
    reportDataHex: string;
  }>;
  publishedPolicy?: ChutesPublishedPolicyEvaluation;
  claims: Readonly<Record<AttestationClaimKey, AttestationClaimSummary>>;
  warnings: readonly string[];
}>;

export type ChutesAttestationAuthorization = Readonly<{
  kind: "oauth" | "api-key";
  /** Stable, non-secret connection revision used only to partition memory caches. */
  cachePartition: string;
  /** Called only for an authenticated network request and never copied into a record. */
  getBearerToken: (signal: AbortSignal) => string | Promise<string>;
}>;

export type GetChutesEndpointEvidenceOptions = Readonly<{
  route?: ChutesEvidenceRoute;
  chuteId?: string;
  instanceId: string;
  e2ePublicKey: string;
  includePublishedPolicy?: boolean;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}>;

export type ChutesAttestationEvidenceClientOptions = Readonly<{
  fetch?: typeof fetch;
  apiBase?: string;
  authorization?: ChutesAttestationAuthorization;
  cacheTtlMs?: number;
  policyCacheTtlMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxPolicyResponseBytes?: number;
  maxDiscoveryResponseBytes?: number;
  maxCacheEntries?: number;
  /** Total serialized size budget for raw evidence retained in memory. */
  maxCacheBytes?: number;
  discoveryCacheTtlMs?: number;
  now?: () => number;
  /** Optional real cryptographic verifiers (Intel DCAP, NVIDIA). When present, claims can reach `verified`. */
  verifierPorts?: AttestationVerifierPorts;
  randomValues?: (target: Uint8Array) => void;
}>;

export type ChutesE2eDiscoveredEndpoint = Readonly<{
  instanceId: string;
  e2ePublicKey: string;
  /** Invocation nonce values are deliberately discarded by this evidence client. */
  discardedInvocationNonceCount: number;
}>;

export type ChutesE2eDiscoverySnapshot = Readonly<{
  version: 1;
  provider: "chutes";
  kind: "e2e-endpoint-discovery";
  chuteId: string;
  sourceUrl: string;
  fetchedAt: string;
  cacheFreshUntil: string;
  cache: "network" | "memory";
  authorization: "bearer";
  providerNonceExpiresAt: string;
  providerNonceExpiresInSeconds: number;
  endpoints: readonly ChutesE2eDiscoveredEndpoint[];
}>;

export type ChutesAttestationUnavailable = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
}>;

export type ChutesEndpointAttestationSnapshot = Readonly<{
  version: 1;
  provider: "chutes";
  chuteId: string;
  requestedInstanceId: string;
  inspectedAt: string;
  status: "evidence" | "unavailable";
  discovery?: ChutesE2eDiscoverySnapshot;
  record?: ChutesEndpointEvidenceRecord;
  unavailable?: ChutesAttestationUnavailable;
}>;

export type InspectChutesEndpointOptions = Readonly<{
  chuteId: string;
  instanceId: string;
  /** Defaults to the exact authenticated per-instance evidence route. */
  evidenceRoute?: ChutesEvidenceRoute;
  includePublishedPolicy?: boolean;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}>;

export type DiscoverChutesE2eEndpointsOptions = Readonly<{
  signal?: AbortSignal;
  forceRefresh?: boolean;
}>;

export type AttestationEvidenceMemoryStats = Readonly<{
  evidenceEntries: number;
  evidenceBytes: number;
  discoveryEntries: number;
  policyCached: boolean;
}>;
