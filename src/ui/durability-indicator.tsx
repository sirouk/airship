
export type DurabilityState = "ephemeral" | "syncing" | "synced";

export function DurabilityIndicator({ state, detail }: { state: DurabilityState; detail?: string }) {
  const label = durabilityLabel(state);
  return <span class={`durability-indicator ${state}`} role="status" title={detail}><i aria-hidden="true" /><span>{label}</span></span>;
}

export function durabilityLabel(state: DurabilityState): string {
  return state === "ephemeral" ? "Ephemeral · this page only" : state === "syncing" ? "Syncing encrypted state" : "Encrypted state synced";
}
