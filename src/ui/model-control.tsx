import { useState } from "preact/hooks";
import { isChutesConnected, type ActiveChutesConnection, type ChutesConnection } from "../auth/connection";
import type { AirshipModel } from "../models";
import { Icon } from "./icons";
import { ModelPicker } from "./model-picker";

export function ModelControl({
  connection,
  models,
  busy,
  onSelect,
  onOpenConnection,
}: Readonly<{
  connection: ChutesConnection;
  models: readonly AirshipModel[];
  busy: boolean;
  onSelect: (modelId: string) => Promise<void>;
  onOpenConnection: () => void;
}>) {
  const [error, setError] = useState<string>();

  if (!isChutesConnected(connection)) {
    return (
      <button class="session-runtime local" type="button" onClick={onOpenConnection}>
        <span class="session-runtime-icon"><Icon name="model" size={17} /></span>
        <span><small>Session model</small><strong>airship/demo-v1</strong></span>
        <span class="runtime-posture">Local</span>
      </button>
    );
  }

  return (
    <div class="session-runtime remote">
      <span class="session-runtime-icon"><Icon name="model" size={17} /></span>
      <label>
        <small>Session model</small>
        <ModelPicker
          value={connection.model}
          models={models}
          disabled={busy || models.length < 2}
          onSelect={(modelId) => {
            setError(undefined);
            void onSelect(modelId).catch((caught) => {
              setError(caught instanceof Error ? caught.message : "The model could not be selected.");
            });
          }}
        />
      </label>
      <button class="runtime-posture" type="button" onClick={onOpenConnection} title="Open connection and credential capabilities">
        {activeConnectionProofLabel(connection, busy)}
      </button>
      {error ? <span class="session-runtime-error" role="alert">{error}</span> : null}
    </div>
  );
}

export function activeConnectionProofLabel(connection: ActiveChutesConnection, busy = false): string {
  if (busy) return "E2EE · Switching…";
  if (connection.posture !== "encrypted-attested") return "E2EE · no proof gate";
  return connection.invokeAuthorization === "verified"
    ? "E2EE · last turn proved"
    : "E2EE · proof required";
}
