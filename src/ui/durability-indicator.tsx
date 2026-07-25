
export type DurabilityState = "ephemeral" | "local" | "syncing" | "synced";

export function DurabilityIndicator({ state, detail }: { state: DurabilityState; detail?: string }) {
  const label = durabilityLabel(state);
  return <span class={`durability-indicator ${state}`} role="status" title={detail}><i aria-hidden="true" /><span>{label}</span></span>;
}

export function durabilityLabel(state: DurabilityState): string {
  if (state === "ephemeral") return "Ephemeral · this page only";
  if (state === "local") return "Encrypted · this device";
  return state === "syncing" ? "Syncing encrypted state" : "Encrypted state synced";
}
