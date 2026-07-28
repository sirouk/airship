import type { InferenceTransport } from "../../core/contracts";

export type LocalModelProviderKind = "ollama" | "lm-studio";
export type LocalModelCapability =
  | "text-generation"
  | "tools"
  | "vision"
  | "embeddings"
  | "thinking";
export type CapabilityState = "supported" | "unsupported" | "unknown";

export type LocalCapabilityEvidence = Readonly<{
  capability: LocalModelCapability;
  state: CapabilityState;
  /** Exact provider response field used to reach the conclusion. */
  source: string;
}>;

export type LocalModelDescriptor = Readonly<{
  id: string;
  provider: LocalModelProviderKind;
  state: "loaded" | "not-loaded" | "unknown";
  capabilities: readonly LocalCapabilityEvidence[];
  contextTokens?: number;
  format?: string;
  architecture?: string;
  quantization?: string;
  parameterSize?: string;
  sizeBytes?: number;
  digest?: string;
  modifiedAt?: string;
}>;

export type LocalProviderDiagnosticCode =
  | "endpoint-invalid"
  | "endpoint-not-local"
  | "mixed-content"
  | "cors-or-private-network-access"
  | "offline"
  | "cancelled"
  | "timeout"
  | "http"
  | "invalid-content-type"
  | "credential-invalid"
  | "response-too-large"
  | "invalid-json"
  | "invalid-payload"
  | "model-details-unavailable";

export type LocalProviderDiagnostic = Readonly<{
  code: LocalProviderDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  blocking: boolean;
  modelId?: string;
  status?: number;
}>;

export type LocalModelDiscovery = Readonly<{
  provider: LocalModelProviderKind;
  endpoint: string;
  fetchedAt: string;
  models: readonly LocalModelDescriptor[];
  diagnostics: readonly LocalProviderDiagnostic[];
  complete: boolean;
}>;

export type LocalProviderHealth = Readonly<{
  provider: LocalModelProviderKind;
  endpoint: string;
  state: "ready";
  checkedAt: string;
  /** Available only when the provider returned a version field. */
  version?: string;
  /** A successful browser read proves CORS for this exact Airship origin. */
  cors: "confirmed";
}>;

export type LocalEndpointAccess = Readonly<{
  /**
   * Used only for deterministic environment diagnostics and tests. The stock
   * adapter accepts only its exact loopback origins; caller options cannot
   * broaden that network boundary.
   */
  pageUrl?: string;
}>;

/**
 * A page-memory credential resolver. The adapter intentionally does not accept
 * a credential string it could retain or serialize.
 */
export type MemoryCredential = () => string | undefined | Promise<string | undefined>;

export type LocalProviderOptions = LocalEndpointAccess & Readonly<{
  endpoint?: string;
  credential?: MemoryCredential;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxModels?: number;
  capabilityProbeConcurrency?: number;
}>;

export interface BrowserLocalModelProvider {
  readonly kind: LocalModelProviderKind;
  readonly endpoint: URL;
  /**
   * Fetches the provider's own model records. Airship does not infer tools or
   * vision support from model names.
   */
  discoverModels(signal?: AbortSignal): Promise<LocalModelDiscovery>;
  /** Performs a real direct request; it is not a socket-presence guess. */
  probeHealth(signal?: AbortSignal): Promise<LocalProviderHealth>;
  /** Creates a direct browser-to-provider transport. No proxy is involved. */
  createTransport(): InferenceTransport;
}
