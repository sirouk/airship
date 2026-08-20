import type {
  SessionInferenceBinding,
  SessionInferenceBindingV2,
  SessionManifest,
} from "./contracts";

/**
 * Compare credential-free inference authority without invoking caller-owned
 * values. Historical v1 pins may be satisfied by an equivalent v2 route. A v2
 * pin never accepts a v1 downgrade and always includes exact transport and
 * protocol identity.
 */
export function inferenceBindingsMatch(
  actual: SessionInferenceBinding | undefined,
  expected: SessionInferenceBinding | undefined,
): boolean {
  if (!actual || !expected) return actual === expected;
  const actualVersion = actual.version;
  const expectedVersion = expected.version;
  const baseMatches = actual.connectionId === expected.connectionId
    && actual.connectionGeneration === expected.connectionGeneration
    && actual.providerId === expected.providerId
    && actual.providerLabel === expected.providerLabel
    && actual.providerRevision === expected.providerRevision
    && actual.authMethod === expected.authMethod
    && actual.transportBoundary === expected.transportBoundary
    && actual.modelId === expected.modelId;
  if (!baseMatches) return false;
  return (actualVersion === 1 && expectedVersion === 2) || (
    actualVersion === 2 && expectedVersion === 2
    && actual.transportId === expected.transportId
    && actual.protocol === expected.protocol
  );
}


/** Canonical provider identity. A historical v1 manifest may store its legacy
 * transport ID in providerId, while its binding retains the actual provider. */
export function canonicalSessionInferenceProviderId(
  manifest: Pick<SessionManifest, "providerId" | "inferenceBinding">,
): string {
  return manifest.inferenceBinding?.providerId ?? manifest.providerId;
}

/** Replay compatibility for events minted before provider/transport identity
 * split. Only a durable v1 binding may use the historical manifest transport
 * ID as provider provenance; current v2 history is canonical-only. */
export function sessionInferenceProviderIdMatches(
  manifest: Pick<SessionManifest, "providerId" | "inferenceBinding">,
  observed: unknown,
): observed is string {
  const providerId = manifest.providerId;
  const binding = manifest.inferenceBinding;
  return observed === (binding?.providerId ?? providerId)
    || (binding?.version === 1 && observed === providerId);
}

function legacyProtocolForTransportId(transportId: string): SessionInferenceBindingV2["protocol"] | undefined {
  if (transportId === "openai-responses-v1" || transportId === "xai-responses-v1") {
    return "openai-responses";
  }
  if (transportId === "anthropic-messages-v1") return "anthropic-messages";
  if (
    transportId === "ollama-openai-local-v1"
    || transportId === "lm-studio-openai-local-v1"
    || transportId === "chutes-openai-compatible-v1"
    || /^openai-compatible-[0-9a-f]{64}-openai-compatible-v1$/u.test(transportId)
  ) return "openai-compatible";
  return undefined;
}

function projectBindingModel<T extends SessionInferenceBinding>(binding: T, modelId: string): T {
  return binding.modelId === modelId ? binding : { ...binding, modelId };
}

export function historicalInferenceBindingMayUpgrade(
  manifest: Pick<SessionManifest, "providerId" | "model" | "inferenceBinding">,
  activeBinding: SessionInferenceBinding | undefined,
  effectiveModelId: string = manifest.model,
): activeBinding is SessionInferenceBindingV2 {
  const pinned = manifest.inferenceBinding;
  const projectedActive = activeBinding?.version === 2
    ? projectBindingModel(activeBinding, effectiveModelId)
    : activeBinding;
  return pinned?.version === 1
    && projectedActive?.version === 2
    && inferenceBindingsMatch(projectBindingModel(pinned, effectiveModelId), projectedActive)
    && projectedActive.transportId === manifest.providerId
    && legacyProtocolForTransportId(manifest.providerId) === projectedActive.protocol;
}

/**
 * Resolve the current exact route authority without widening a durable pin.
 * Historical v1 bindings can become operational only through an equivalent
 * active v2 route. A durable in-place model override projects only modelId;
 * provider, connection, generation, transport, and protocol remain exact.
 */
export function currentInferenceBinding(
  manifest: Pick<SessionManifest, "providerId" | "model" | "inferenceBinding">,
  activeBinding?: SessionInferenceBinding,
  effectiveModelId: string = manifest.model,
): SessionInferenceBindingV2 | undefined {
  const pinned = manifest.inferenceBinding;
  if (pinned?.version === 2) {
    if (pinned.providerId !== manifest.providerId) {
      throw new Error("The session manifest provider and inference binding disagree; fork the session before continuing.");
    }
    const projected = projectBindingModel(pinned, effectiveModelId);
    const projectedActive = activeBinding && projectBindingModel(activeBinding, effectiveModelId);
    if (projectedActive && !inferenceBindingsMatch(projected, projectedActive)) {
      throw new Error("The active inference binding does not match the session's v2 authority; fork the session before continuing.");
    }
    return projected;
  }
  if (pinned?.version === 1) {
    if (!activeBinding) {
      throw new Error("This historical session requires an exact active v2 inference binding before it can continue; fork the session if that route is unavailable.");
    }
    if (!historicalInferenceBindingMayUpgrade(manifest, activeBinding, effectiveModelId)) {
      throw new Error("The active inference binding cannot upgrade this historical session authority; fork the session before continuing.");
    }
    return projectBindingModel(activeBinding, effectiveModelId);
  }
  return undefined;
}

/** Resolve the exact transport authorized for the effective durable model. */
export function pinnedInferenceTransportId(
  manifest: Pick<SessionManifest, "providerId" | "model" | "inferenceBinding">,
  activeBinding?: SessionInferenceBinding,
  effectiveModelId: string = manifest.model,
): string {
  return currentInferenceBinding(manifest, activeBinding, effectiveModelId)?.transportId ?? manifest.providerId;
}

export function assertPinnedInferenceTransport(
  manifest: Pick<SessionManifest, "providerId" | "model" | "inferenceBinding">,
  transportId: string,
  activeBinding?: SessionInferenceBinding,
  effectiveModelId: string = manifest.model,
): string {
  const ownedManifest = {
    providerId: manifest.providerId,
    model: manifest.model,
    inferenceBinding: manifest.inferenceBinding,
  };
  if (ownedManifest.inferenceBinding && activeBinding?.version !== 2) {
    throw new Error("A bound session requires its exact active v2 inference binding; a transport ID alone cannot prove protocol authority.");
  }
  const pinnedTransportId = pinnedInferenceTransportId(ownedManifest, activeBinding, effectiveModelId);
  if (transportId !== pinnedTransportId) {
    throw new Error(
      `Session inference transport is pinned to ${pinnedTransportId}; fork the session to use ${transportId}.`,
    );
  }
  return pinnedTransportId;
}

const INFERENCE_BINDING_BASE_FIELDS = Object.freeze([
  "version",
  "connectionId",
  "connectionGeneration",
  "providerId",
  "providerLabel",
  "providerRevision",
  "authMethod",
  "transportBoundary",
  "modelId",
  "boundAt",
] as const);
const INFERENCE_PROTOCOLS = new Set([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "openai-compatible",
]);

const UNSAFE_BINDING_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function boundedBindingString(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !UNSAFE_BINDING_CONTROL.test(value);
}

/**
 * Validate a credential-free binding at every pre-persistence boundary.
 * Exact own data fields prevent a runtime caller from smuggling secrets or
 * accessors through TypeScript's structural type into a durable manifest.
 */
export function assertValidSessionInferenceBinding(
  manifest: Pick<SessionManifest, "providerId" | "model" | "inferenceBinding">,
): void {
  const providerId = manifest.providerId;
  const model = manifest.model;
  const value: unknown = manifest.inferenceBinding;
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Session inference binding must be an exact plain record.");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError("Session inference binding could not be inspected safely.");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Session inference binding must have a plain-object prototype.");
  }
  const versionDescriptor = descriptors.version;
  const version = versionDescriptor && "value" in versionDescriptor ? versionDescriptor.value : undefined;
  if (version !== 1 && version !== 2) {
    throw new TypeError("Session inference binding version is unsupported.");
  }
  const allowed = new Set<string>([
    ...INFERENCE_BINDING_BASE_FIELDS,
    ...(version === 2 ? ["transportId", "protocol"] : []),
  ]);
  if (keys.length !== allowed.size) {
    throw new TypeError("Session inference binding has an unknown or missing field.");
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError("Session inference binding has an unknown field.");
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`Session inference binding ${key} must be an enumerable data property.`);
    }
    record[key] = descriptor.value;
  }
  if (
    !boundedBindingString(record.connectionId, 256)
    || !Number.isSafeInteger(record.connectionGeneration) || Number(record.connectionGeneration) <= 0
    || !boundedBindingString(record.providerId, 256)
    || !boundedBindingString(record.providerLabel, 256)
    || !Number.isSafeInteger(record.providerRevision) || Number(record.providerRevision) <= 0
    || !["oauth-pkce", "api-key", "local-none"].includes(String(record.authMethod))
    || !(version === 1
      ? ["e2ee-attestable", "provider-tls", "loopback-local"]
      : ["provider-tls", "loopback-local"]
    ).includes(String(record.transportBoundary))
    || !boundedBindingString(record.modelId, 512)
    || record.modelId !== model
    || !boundedBindingString(record.boundAt, 128)
    || !Number.isFinite(Date.parse(record.boundAt))
    || (version === 2 && (
      !boundedBindingString(record.transportId, 256)
      || !INFERENCE_PROTOCOLS.has(String(record.protocol))
      || record.providerId !== providerId
    ))
  ) {
    throw new TypeError("Session inference binding does not match a supported bounded authority.");
  }
}
