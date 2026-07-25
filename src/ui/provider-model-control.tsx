import { useState } from "preact/hooks";
import type {
  InferenceAvailabilityConnection,
  InferenceAvailabilitySnapshot,
  PinnedRouteResolution,
} from "../inference/providers";
import { Icon } from "./icons";
import { MenuSelect, type MenuSelectOption } from "./menu-select";
import { capabilityLabel } from "./provider-fabric-panel";
import "./provider-fabric-panel.css";

export type ProviderModelSelection = Readonly<{
  connectionId: string;
  modelId: string;
}>;

export type ProviderModelRoute = ProviderModelSelection & Readonly<{
  providerId: string;
  providerLabel: string;
  connectionLabel: string;
  modelLabel: string;
  available: boolean;
  canInvoke: boolean;
  health: InferenceAvailabilityConnection["health"];
  supportedCapabilities: readonly string[];
}>;

export function ProviderModelControl({
  snapshot,
  activeConnectionId = snapshot.activeSession?.connectionId,
  activeModelId = snapshot.activeSession?.modelId,
  busy = false,
  onSelect,
  onOpenConnections,
}: Readonly<{
  snapshot: InferenceAvailabilitySnapshot;
  activeConnectionId?: string;
  activeModelId?: string;
  busy?: boolean;
  /**
   * Selecting a different route is an explicit request to create or fork a
   * newly pinned conversation. The host must not mutate the current pin.
   */
  onSelect(selection: ProviderModelSelection): Promise<void>;
  onOpenConnections(): void;
}>) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string>();
  const routes = inferenceModelRoutes(snapshot);
  const activeValue = activeConnectionId && activeModelId
    ? inferenceRouteValue(activeConnectionId, activeModelId)
    : undefined;
  const activeRoute = routes.find((route) =>
    route.connectionId === activeConnectionId && route.modelId === activeModelId
  );
  const activeConnection = activeConnectionId
    ? snapshot.connections.find((connection) => connection.id === activeConnectionId)
    : undefined;
  const hasInvokableRoute = routes.some((route) => route.available && route.canInvoke);

  if (!hasInvokableRoute && !activeValue) {
    return (
      <button
        class="session-runtime local provider-model-control"
        type="button"
        onClick={onOpenConnections}
      >
        <span class="session-runtime-icon"><Icon name="model" size={17} /></span>
        <span>
          <small>Session model</small>
          <strong>Connect inference</strong>
        </span>
        <span class="runtime-posture">Local tools ready</span>
      </button>
    );
  }

  const options: MenuSelectOption[] = routes.map((route) => ({
    value: inferenceRouteValue(route.connectionId, route.modelId),
    label: `${route.providerLabel} · ${route.modelLabel}`,
    description: routeDescription(route),
    disabled: !route.available || !route.canInvoke,
  }));
  if (activeValue && !activeRoute) {
    options.unshift({
      value: activeValue,
      label: `${activeConnection?.providerLabel ?? snapshot.activeSession?.providerId ?? "Pinned provider"} · ${activeModelId}`,
      description: "Pinned route is outside the bounded live model view",
      disabled: true,
    });
  } else if (!activeValue) {
    options.unshift({
      value: "__airship_choose_model__",
      label: "Choose a connected model",
      description: "Creates a model-pinned conversation",
      disabled: true,
    });
  }

  const selectedValue = activeValue ?? "__airship_choose_model__";
  const posture = providerRoutePosture(
    activeConnection,
    snapshot.activeSession?.resolution,
    switching,
  );

  return (
    <div class="session-runtime remote provider-model-control">
      <span class="session-runtime-icon"><Icon name="model" size={17} /></span>
      <div class="provider-model-control__copy">
        <small>Session model</small>
        <MenuSelect
          ariaLabel="Session inference provider and model"
          placement="down"
          value={selectedValue}
          options={options}
          disabled={busy || switching}
          onChange={(value) => {
            const route = routes.find((candidate) =>
              inferenceRouteValue(candidate.connectionId, candidate.modelId) === value
            );
            if (!route || !route.available || !route.canInvoke) return;
            setError(undefined);
            setSwitching(true);
            void onSelect({
              connectionId: route.connectionId,
              modelId: route.modelId,
            }).catch(() => {
              setError("The route could not be activated. The existing conversation pin was preserved.");
            }).finally(() => {
              setSwitching(false);
            });
          }}
        />
      </div>
      <button
        class="runtime-posture"
        type="button"
        onClick={onOpenConnections}
        title="Open inference connections, live models, and capabilities"
      >
        {posture}
      </button>
      {error ? <span class="session-runtime-error" role="alert">{error}</span> : null}
    </div>
  );
}

export function inferenceModelRoutes(
  snapshot: Pick<InferenceAvailabilitySnapshot, "connections">,
): ProviderModelRoute[] {
  return snapshot.connections.flatMap((connection) =>
    connection.models.map((model) => ({
      connectionId: connection.id,
      modelId: model.id,
      providerId: connection.providerId,
      providerLabel: connection.providerLabel,
      connectionLabel: connection.connectionLabel,
      modelLabel: model.label,
      available: model.availability === "available",
      canInvoke: connection.canInvoke,
      health: connection.health,
      supportedCapabilities: model.supportedCapabilities,
    }))
  );
}

export function inferenceRouteValue(connectionId: string, modelId: string): string {
  return `${encodeURIComponent(connectionId)}::${encodeURIComponent(modelId)}`;
}

export function providerRoutePosture(
  connection: InferenceAvailabilityConnection | undefined,
  resolution: PinnedRouteResolution["state"] | undefined,
  switching = false,
): string {
  if (switching) return "Opening pinned thread…";
  if (!connection) return "Choose route";
  if (resolution && resolution !== "ready") return "Route needs attention";
  if (!connection.canInvoke) return "Invoke not proved";
  if (connection.health === "degraded") return "Ready · degraded";
  if (connection.health === "ready") return "Ready";
  return connection.health;
}

function routeDescription(route: ProviderModelRoute): string {
  const capabilityText = route.supportedCapabilities.length
    ? route.supportedCapabilities.map(capabilityLabel).join(", ")
    : "Capabilities not declared";
  const state = route.available && route.canInvoke
    ? route.health === "degraded" ? "Available · degraded" : "Available"
    : !route.available ? "Unavailable" : "Invoke not proved";
  return `${route.connectionLabel} · ${state} · ${capabilityText}`;
}
