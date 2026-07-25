import { useEffect, useRef, useState } from "preact/hooks";
import type { ActiveChutesConnection } from "../auth/connection";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";

export type ModelControlOption = Readonly<{
  id: string;
  label: string;
  detail?: string;
}>;

export function ModelControl({
  active,
  models,
  busy,
  onSelect,
  onOpenConnection,
}: Readonly<{
  active?: Readonly<{
    providerLabel: string;
    modelId: string;
    boundaryLabel: string;
  }>;
  models: readonly ModelControlOption[];
  busy: boolean;
  onSelect: (modelId: string) => Promise<void>;
  onOpenConnection: () => void;
}>) {
  const [error, setError] = useState<string>();
  const [pendingModelId, setPendingModelId] = useState<string>();
  const operation = useRef(0);
  const options = modelControlOptions(models, active?.modelId);
  const switching = busy || Boolean(pendingModelId);

  useEffect(() => {
    operation.current += 1;
    setPendingModelId(undefined);
    setError(undefined);
  }, [active?.modelId, active?.providerLabel]);

  if (!active) {
    return (
      <button
        class="session-runtime local"
        type="button"
        aria-label="Open inference connections; the local demonstration model is active"
        onClick={onOpenConnection}
      >
        <span class="session-runtime-icon"><Icon name="model" size={17} /></span>
        <span><small>Session model</small><strong>airship/demo-v1</strong></span>
        <span class="runtime-posture">Local</span>
      </button>
    );
  }

  return (
    <div class="session-runtime remote" aria-busy={switching}>
      <span class="session-runtime-icon"><Icon name="model" size={17} /></span>
      <label>
        <small>{active.providerLabel} · session model</small>
        <MenuSelect
          ariaLabel={`${active.providerLabel} session model; choosing another starts a new pinned conversation`}
          value={active.modelId}
          placement="down"
          options={options}
          disabled={switching || options.length < 2}
          onChange={(modelId) => {
            const currentOperation = ++operation.current;
            setError(undefined);
            setPendingModelId(modelId);
            void onSelect(modelId)
              .catch((caught) => {
                if (operation.current === currentOperation) {
                  setError(safeModelControlErrorMessage(caught));
                }
              })
              .finally(() => {
                if (operation.current === currentOperation) setPendingModelId(undefined);
              });
          }}
        />
      </label>
      <button
        class="runtime-posture"
        type="button"
        onClick={onOpenConnection}
        aria-label={`Open inference connections. Current boundary: ${active.boundaryLabel}`}
        title="Open inference connections and credential details"
      >
        {switching ? "Switching…" : active.boundaryLabel}
      </button>
      {error ? <span class="session-runtime-error" role="alert">{error}</span> : null}
    </div>
  );
}

export function modelControlOptions(
  models: readonly ModelControlOption[],
  activeModelId?: string,
): readonly Readonly<{ value: string; label: string; description: string }>[] {
  const listed = models.map((model) => ({
    value: model.id,
    label: model.label,
    description: model.id === activeModelId
      ? model.detail
        ? `${model.detail} · current pinned model`
        : "Current pinned model"
      : model.detail
        ? `${model.detail} · starts a new pinned conversation`
        : "Starts a new pinned conversation",
  }));
  if (!activeModelId || listed.some((option) => option.value === activeModelId)) return listed;
  return [{
    value: activeModelId,
    label: activeModelId,
    description: "Current pinned model · catalog details unavailable",
  }, ...listed];
}

export function safeModelControlErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (!raw) return "The model could not be selected. The current conversation was not changed.";
  const redacted = raw
    .replace(/\bBearer\s+\S+/giu, "Bearer [credential]")
    .replace(/\b(?:c[ap]k|sk|xai|api)[_-][A-Za-z0-9._-]{8,}/giu, "[credential]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!redacted) return "The model could not be selected. The current conversation was not changed.";
  return redacted.length > 240 ? `${redacted.slice(0, 237)}…` : redacted;
}

export function activeConnectionProofLabel(connection: ActiveChutesConnection, busy = false): string {
  if (busy) return "E2EE · Switching…";
  if (connection.posture !== "encrypted-attested") return "E2EE · no proof gate";
  return connection.invokeAuthorization === "verified"
    ? "E2EE · last turn proved"
    : "E2EE · proof required";
}
