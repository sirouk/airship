import { h, render } from "preact";
import { useState } from "preact/hooks";
import {
  InferenceConnectionRegistry,
  InferenceModelCatalog,
  InferenceProviderCatalog,
  OFFICIAL_CLOUD_PROVIDERS,
  createInferenceAvailabilitySnapshot,
  type InferenceAvailabilitySnapshot,
} from "../../src/inference/providers";
import {
  ProviderFabricPanel,
  type ProviderConnectDraft,
} from "../../src/ui/provider-fabric-panel";

type AcceptanceState = {
  snapshot: InferenceAvailabilitySnapshot;
  activations: readonly Readonly<{ connectionId: string; modelId: string }>[];
};

declare global {
  // eslint-disable-next-line no-var
  var __airshipProviderAcceptance: AcceptanceState | undefined;
}

export function mountProviderFabricAcceptance(mode: "empty" | "ready-models"): void {
  const providers = new InferenceProviderCatalog(OFFICIAL_CLOUD_PROVIDERS);
  const connections = new InferenceConnectionRegistry(
    providers,
    () => Date.parse("2026-07-24T12:00:00.000Z"),
  );
  const models = new InferenceModelCatalog(providers);
  const observedAt = "2026-07-24T12:00:01.000Z";

  const connectReady = (
    connectionId: string,
    providerId: "openai" | "anthropic",
    apiKey: string,
    modelRows: readonly Readonly<{ id: string; label: string }>[],
  ) => {
    const connection = connections.connectApiKey({
      id: connectionId,
      providerId,
      authMethodId: `${providerId}-api-key`,
      label: providerId === "openai" ? "OpenAI main" : "Anthropic review",
      apiKey,
      connectedAt: "2026-07-24T12:00:00.000Z",
    });
    connections.updateHealth(connectionId, {
      state: "ready",
      checkedAt: observedAt,
      latencyMs: 12,
    });
    connections.updateCapabilities(connectionId, {
      invoke: { state: "available", source: "live-probe", checkedAt: observedAt },
      "models:list": { state: "available", source: "live-probe", checkedAt: observedAt },
    });
    models.replaceConnectionModels(
      connectionId,
      connection.generation,
      providerId,
      modelRows.map((model) => ({
        version: 1,
        connectionId,
        connectionGeneration: connection.generation,
        providerId,
        id: model.id,
        label: model.label,
        capabilities: {
          "text-input": { state: "supported", source: "live-probe", observedAt },
          "text-output": { state: "supported", source: "live-probe", observedAt },
        },
        availability: { state: "available", source: "live-probe", observedAt },
        source: { kind: "live-probe", observedAt },
      })),
    );
  };

  if (mode === "ready-models") {
    connectReady("openai-main", "openai", "page-memory-openai", [
      { id: "gpt-alpha", label: "GPT Alpha" },
      { id: "gpt-beta", label: "GPT Beta" },
    ]);
    connectReady("anthropic-review", "anthropic", "page-memory-anthropic", [
      { id: "claude-review", label: "Claude Review" },
    ]);
  }

  const snapshot = () => createInferenceAvailabilitySnapshot({
    providers,
    connections,
    models,
    capturedAt: observedAt,
  });
  const acceptance: AcceptanceState = {
    snapshot: snapshot(),
    activations: [],
  };
  globalThis.__airshipProviderAcceptance = acceptance;

  function Harness() {
    const [current, setCurrent] = useState(snapshot());
    const connect = async (draft: ProviderConnectDraft) => {
      if (draft.kind !== "cloud-api-key" || draft.providerId === "xai") {
        throw new Error("This acceptance harness connects OpenAI or Anthropic API keys.");
      }
      connectReady(
        `${draft.providerId}-main`,
        draft.providerId,
        draft.apiKey,
        [],
      );
      acceptance.snapshot = snapshot();
      setCurrent(acceptance.snapshot);
    };
    return (
      <ProviderFabricPanel
        snapshot={current}
        online
        onConnect={connect}
        onDisconnect={async () => undefined}
        onActivate={async (connectionId, modelId) => {
          acceptance.activations = [...acceptance.activations, { connectionId, modelId }];
        }}
      />
    );
  }

  document.querySelector("#provider-fabric-acceptance")?.remove();
  const host = document.createElement("div");
  host.id = "provider-fabric-acceptance";
  document.body.append(host);
  render(h(Harness, {}), host);
}
