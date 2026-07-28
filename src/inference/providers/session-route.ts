import type {
  InferenceAvailabilityLimits,
  InferenceAvailabilitySnapshot,
  InferenceModelDescriptor,
  PinnedRouteResolution,
  SessionInferenceRoutePin,
} from "./contracts";
import type { InferenceConnectionRegistry } from "./connection-registry";
import type { InferenceModelCatalog } from "./model-catalog";
import type { InferenceProviderCatalog } from "./provider-catalog";
import {
  canonicalTimestamp,
  deepFreeze,
  positiveInteger,
} from "./validation";

export type PinInferenceRouteInput = Readonly<{
  connectionId: string;
  modelId: string;
  pinnedAt?: string;
}>;

export function pinInferenceRoute(
  providers: InferenceProviderCatalog,
  connections: InferenceConnectionRegistry,
  models: InferenceModelCatalog,
  input: PinInferenceRouteInput,
): SessionInferenceRoutePin {
  const connection = connections.require(input.connectionId);
  const provider = providers.require(connection.providerId);
  const model = models.require(connection.id, connection.generation, input.modelId);
  if (model.providerId !== connection.providerId) {
    throw new Error("The selected model was discovered through a different provider.");
  }
  if (
    connection.health.state !== "ready"
    && connection.health.state !== "degraded"
  ) {
    throw new Error("The inference connection must pass a live health check before session pinning.");
  }
  if (connection.capabilities.invoke.state !== "available") {
    throw new Error("The inference connection must prove invoke authorization before session pinning.");
  }
  if (model.availability.state !== "available") {
    throw new Error("The selected model is not currently proved available.");
  }
  return deepFreeze({
    version: 1,
    pinnedAt: canonicalTimestamp(
      input.pinnedAt ?? new Date().toISOString(),
      "Inference route pin timestamp",
    ),
    provider: {
      id: provider.provider.id,
      revision: provider.revision,
      label: provider.provider.label,
      protocol: provider.provider.protocol,
      transportBoundary: provider.provider.transportBoundary,
    },
    connection: {
      id: connection.id,
      generation: connection.generation,
      authKind: connection.authKind,
    },
    model,
  }) as SessionInferenceRoutePin;
}

/**
 * Resolve without mutating the pin. Mutable catalog improvements may be
 * reported, but the pinned model metadata remains the session authority.
 */
export function resolvePinnedInferenceRoute(
  providers: InferenceProviderCatalog,
  connections: InferenceConnectionRegistry,
  models: InferenceModelCatalog,
  pin: SessionInferenceRoutePin,
): PinnedRouteResolution {
  const provider = providers.get(pin.provider.id);
  if (!provider) {
    return deepFreeze({
      state: "provider-missing",
      pin,
      detail: `Pinned provider ${pin.provider.id} is no longer registered.`,
    });
  }
  if (
    provider.revision !== pin.provider.revision
    || provider.provider.protocol !== pin.provider.protocol
    || provider.provider.transportBoundary !== pin.provider.transportBoundary
  ) {
    return deepFreeze({
      state: "provider-changed",
      pin,
      detail: "The pinned provider route changed; fork or create a new session to adopt it.",
    });
  }
  const connection = connections.get(pin.connection.id);
  if (!connection) {
    return deepFreeze({
      state: "connection-missing",
      pin,
      detail: "The pinned inference connection is disconnected.",
    });
  }
  if (
    connection.generation !== pin.connection.generation
    || connection.providerId !== pin.provider.id
    || connection.authKind !== pin.connection.authKind
  ) {
    return deepFreeze({
      state: "connection-replaced",
      pin,
      detail: "The connection ID now refers to a different credential generation.",
    });
  }
  if (
    (connection.health.state !== "ready" && connection.health.state !== "degraded")
    || connection.capabilities.invoke.state !== "available"
  ) {
    return deepFreeze({
      state: "connection-unavailable",
      pin,
      detail: "The pinned connection is not currently authorized and healthy for inference.",
    });
  }
  const currentModel = models.get(
    pin.connection.id,
    pin.connection.generation,
    pin.model.id,
  );
  if (!currentModel || currentModel.availability.state !== "available") {
    return deepFreeze({
      state: "model-unavailable",
      pin,
      detail: "The pinned model is not currently present and available in the provider directory.",
    });
  }
  return deepFreeze({
    state: "ready",
    connection,
    pin,
    currentModelAvailability: currentModel.availability,
    modelMetadataChanged: modelSemantics(currentModel) !== modelSemantics(pin.model),
  });
}

export function createInferenceAvailabilitySnapshot(args: Readonly<{
  providers: InferenceProviderCatalog;
  connections: InferenceConnectionRegistry;
  models: InferenceModelCatalog;
  activeSession?: SessionInferenceRoutePin;
  capturedAt?: string;
  limits?: Partial<InferenceAvailabilityLimits>;
}>): InferenceAvailabilitySnapshot {
  const limits = {
    maxConnections: positiveInteger(args.limits?.maxConnections ?? 16, "Connection snapshot limit", 64),
    maxModelsPerConnection: positiveInteger(
      args.limits?.maxModelsPerConnection ?? 32,
      "Model snapshot limit",
      256,
    ),
  };
  const allConnections = args.connections.snapshot().connections;
  const boundedConnections = allConnections.slice(0, limits.maxConnections).map((connection) => {
    const provider = args.providers.require(connection.providerId).provider;
    const allModels = args.models.forConnection(connection.id, connection.generation);
    const modelRows = allModels.slice(0, limits.maxModelsPerConnection).map((model) =>
      deepFreeze({
        id: model.id,
        label: model.label,
        availability: model.availability.state,
        supportedCapabilities: Object.entries(model.capabilities)
          .filter(([, evidence]) => evidence?.state === "supported")
          .map(([capability]) => capability)
          .sort(),
        ...(model.contextWindowTokens
          ? { contextWindowTokens: model.contextWindowTokens }
          : {}),
        ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
      })
    );
    const availableCapabilities = Object.entries(connection.capabilities)
      .filter(([, evidence]) => evidence.state === "available")
      .map(([capability]) => capability)
      .sort();
    return deepFreeze({
      id: connection.id,
      providerId: provider.id,
      providerLabel: provider.label,
      connectionLabel: connection.label,
      authKind: connection.authKind,
      health: connection.health.state,
      canInvoke: (
        connection.capabilities.invoke.state === "available"
        && (connection.health.state === "ready" || connection.health.state === "degraded")
      ),
      availableCapabilities,
      models: modelRows,
      omittedModels: Math.max(0, allModels.length - modelRows.length),
    });
  });
  const activeResolution = args.activeSession
    ? resolvePinnedInferenceRoute(
        args.providers,
        args.connections,
        args.models,
        args.activeSession,
      )
    : undefined;

  return deepFreeze({
    version: 1,
    capturedAt: canonicalTimestamp(
      args.capturedAt ?? new Date().toISOString(),
      "Availability snapshot timestamp",
    ),
    connections: boundedConnections,
    omittedConnections: Math.max(0, allConnections.length - boundedConnections.length),
    ...(args.activeSession && activeResolution
      ? {
          activeSession: {
            providerId: args.activeSession.provider.id,
            connectionId: args.activeSession.connection.id,
            modelId: args.activeSession.model.id,
            immutable: true,
            resolution: activeResolution.state,
          },
        }
      : {}),
  }) as InferenceAvailabilitySnapshot;
}

/**
 * Compact prompt projection of the same credential-free inspection payload.
 * The object snapshot remains the preferred tool result.
 */
export function renderInferenceAvailabilityForPrompt(
  snapshot: InferenceAvailabilitySnapshot,
  maxChars = 12_000,
): string {
  positiveInteger(maxChars, "Inference prompt projection limit", 64 * 1_024);
  const lines = [
    "Live inference connections (credential-free; availability is observed, not assumed):",
  ];
  for (const connection of snapshot.connections) {
    lines.push(
      `- ${connection.id}: ${connection.providerLabel} (${connection.providerId}); `
      + `auth=${connection.authKind}; health=${connection.health}; invoke=${connection.canInvoke ? "ready" : "not-ready"}.`,
    );
    if (connection.models.length === 0) {
      lines.push("  Models: none cataloged.");
    } else {
      lines.push(
        `  Models: ${connection.models.map((model) =>
          `${model.id}[${model.availability};${model.supportedCapabilities.join(",") || "capabilities-unknown"}`
          + `${modelLimitFacets(model)}]`
        ).join(" | ")}${connection.omittedModels ? ` | +${connection.omittedModels} omitted` : ""}`,
      );
    }
  }
  if (snapshot.omittedConnections) lines.push(`- +${snapshot.omittedConnections} connections omitted.`);
  if (snapshot.activeSession) {
    lines.push(
      `Active session pin: ${snapshot.activeSession.providerId}/${snapshot.activeSession.modelId} `
      + `via ${snapshot.activeSession.connectionId}; immutable=true; resolution=${snapshot.activeSession.resolution}.`,
    );
    lines.push("Do not silently switch the active session to another provider, connection, or model.");
  }
  const rendered = lines.join("\n");
  if (rendered.length <= maxChars) return rendered;
  const suffix = "\n[Inference availability projection truncated; inspect the structured snapshot.]";
  return `${rendered.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

/**
 * Limits are rendered only when the catalog actually holds them. An absent
 * facet is the honest signal that nothing observed or declared the number, and
 * the agent must not read the omission as "unlimited".
 */
function modelLimitFacets(
  model: InferenceAvailabilitySnapshot["connections"][number]["models"][number],
): string {
  const facets = [
    ...(model.contextWindowTokens ? [`ctx=${model.contextWindowTokens}`] : []),
    ...(model.maxOutputTokens ? [`out=${model.maxOutputTokens}`] : []),
  ];
  return facets.length ? `;${facets.join(";")}` : "";
}

function modelSemantics(model: InferenceModelDescriptor): string {
  return JSON.stringify({
    providerId: model.providerId,
    connectionId: model.connectionId,
    connectionGeneration: model.connectionGeneration,
    id: model.id,
    capabilities: model.capabilities,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
  });
}
