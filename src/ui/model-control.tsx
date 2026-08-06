import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { ActiveChutesConnection } from "../auth/connection";
import { Icon } from "./icons";
import { MenuSelect } from "./menu-select";

export type ModelControlOption = Readonly<{
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}>;

export function ModelControl({
  active,
  models,
  providerLabel,
  busy,
  switching: routeSwitching,
  onSelect,
  onOpenConnection,
  picker,
}: Readonly<{
  active?: Readonly<{
    providerLabel: string;
    modelId: string;
    boundaryLabel: string;
  }>;
  models: readonly ModelControlOption[];
  /**
   * A connected provider whose catalog is ready, but whose model has not been
   * pinned to a conversation yet. Chat uses this to make the advertised
   * catalog selectable without pretending a model is active.
   */
  providerLabel?: string;
  busy: boolean;
  switching: boolean;
  onSelect: (modelId: string) => Promise<void>;
  onOpenConnection: () => void;
  /**
   * The catalogue-aware picker, for a route whose models are real
   * `AirshipModel`s.
   *
   * A slot rather than an import: `ModelPicker` travels in a deferred pack with
   * its own stylesheet, and this control is in the entry chunk. Chat and
   * Connection now open the same picker over the same catalogue instead of two
   * controls with two capability vocabularies — but the chrome around it stays
   * here, because the provider caption, the "Switching…" live region and the
   * selection-failure alert are facts about *this* control and are stated
   * nowhere else.
   *
   * A render prop rather than an element, so the picker's choice runs through
   * the same instrumented `select` the menu uses. Handed a finished element,
   * the caller would have to fire its own promise, and a failed switch would
   * become an unhandled rejection with nothing on screen.
   */
  picker?: (control: Readonly<{ select(modelId: string): void; disabled: boolean }>) => ComponentChildren;
}>) {
  const [error, setError] = useState<string>();
  const [pendingModelId, setPendingModelId] = useState<string>();
  const operation = useRef(0);
  const options = modelControlOptions(models, active?.modelId);
  const activity = modelControlActivity(busy, routeSwitching, pendingModelId);

  /**
   * One selection path for both renderings. The operation counter is what makes
   * a late failure from a superseded choice unable to overwrite the current
   * one's state.
   */
  function select(modelId: string): void {
    const currentOperation = ++operation.current;
    setError(undefined);
    setPendingModelId(modelId);
    void onSelect(modelId)
      .catch((caught) => {
        if (operation.current === currentOperation) setError(safeModelControlErrorMessage(caught));
      })
      .finally(() => {
        if (operation.current === currentOperation) setPendingModelId(undefined);
      });
  }

  useEffect(() => {
    operation.current += 1;
    setPendingModelId(undefined);
    setError(undefined);
  }, [active?.modelId, active?.providerLabel]);

  if (!active && models.length > 0) {
    const label = providerLabel ?? "Connected models";
    return (
      <div class="session-runtime remote" aria-busy={activity.switching}>
        <span class="session-runtime-icon"><Icon name="model" size={17} /></span>
        <label>
          <small>{label} · choose a model</small>
          <MenuSelect
            ariaLabel={`${label} model; choosing one starts a new pinned conversation`}
            value=""
            placement="down"
            options={options}
            disabled={activity.disabled}
            onChange={select}
          />
        </label>
        {activity.switching ? <span class="runtime-posture" role="status">Checking…</span> : null}
        {error ? <span class="session-runtime-error" role="alert">{error}</span> : null}
      </div>
    );
  }

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
    <div class="session-runtime remote" aria-busy={activity.switching}>
      <span class="session-runtime-icon"><Icon name="model" size={17} /></span>
      {picker ? (
        // Not a `<label>`: the picker's trigger is a button that names itself
        // from its contents, and wrapping it would forward stray clicks inside
        // the open popover back to the trigger.
        <div class="session-runtime-picker">
          <small>{active.providerLabel} · session model</small>
          {picker({ select, disabled: activity.disabled })}
        </div>
      ) : (
      <label>
        <small>{active.providerLabel} · session model</small>
        <MenuSelect
          ariaLabel={`${active.providerLabel} session model; choosing another starts a new pinned conversation`}
          value={active.modelId}
          placement="down"
          options={options}
          disabled={activity.disabled || options.length < 2}
          onChange={select}
        />
      </label>
      )}
      {/*
        The posture pill is gone from this control, and only from this control.
        It rendered `activeConnectionBoundaryLabel(connection)` — the identical
        string the session status chip carries 140px away, whose popover shows
        it in full with the same `→ Models` navigation into `#access`. Two click
        targets for one fact, 140px apart, and the 185px it took was measured
        against a 169px model field: the name this control exists to show was
        ellipsised to `Qwen3-32B-T…` so a duplicate could be spelled out.

        The transient stays. "Switching…" is a lifecycle state of *this* control
        and is stated nowhere else, so it keeps its own live region.
      */}
      {activity.switching ? <span class="runtime-posture" role="status">Switching…</span> : null}
      {error ? <span class="session-runtime-error" role="alert">{error}</span> : null}
    </div>
  );
}

/**
 * A running turn disables route changes, but it is not itself a route change.
 * Keep those facts separate so sending a message never claims that the pinned
 * model is switching while still preventing a mid-turn selection.
 */
export function modelControlActivity(
  busy: boolean,
  routeSwitching: boolean,
  pendingModelId?: string,
): Readonly<{ disabled: boolean; switching: boolean }> {
  const switching = routeSwitching || Boolean(pendingModelId);
  return Object.freeze({
    disabled: busy || switching,
    switching,
  });
}

export function modelControlOptions(
  models: readonly ModelControlOption[],
  activeModelId?: string,
): readonly Readonly<{ value: string; label: string; description: string }>[] {
  const listed = models.map((model) => ({
    value: model.id,
    label: model.label,
    ...(model.disabled ? { disabled: true } : {}),
    description: model.id === activeModelId
      ? model.detail
        ? `${model.detail} · current pinned model`
        : "Current pinned model"
      : model.detail
        ? `${model.detail}${model.disabled ? " · not a chat model" : " · starts a new pinned conversation"}`
        : model.disabled ? "Not a chat model" : "Starts a new pinned conversation",
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

/**
 * The one string every surface uses for a live connection's proof boundary.
 *
 * The topbar E2EE axis, the session status chip and this card's own
 * `boundaryLabel` all read it; `app.tsx` used to keep a second copy that still
 * said "E2EE · evidence recorded" for an ungated connection, which states a
 * *turn* outcome where the fact is a *policy* one.
 *
 * The `busy` parameter is gone with that duplication. It returned a
 * switching transient and had no caller outside its own test, so making this
 * the shared reader would have shipped a test-only branch into the entry chunk;
 * the transient it described is stated by this control's own live region above,
 * which is the surface that actually knows a switch is in flight.
 */
export function activeConnectionProofLabel(connection: ActiveChutesConnection): string {
  if (connection.posture !== "encrypted-attested") return "E2EE · no proof gate";
  return connection.invokeAuthorization === "verified"
    ? "E2EE · last turn proved"
    : "E2EE · proof required";
}
