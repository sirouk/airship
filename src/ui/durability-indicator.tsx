import { Seal, type SealState } from "./seal";

export type DurabilityState = "ephemeral" | "local" | "syncing" | "synced";

/**
 * Where this journal lives, in the one status vocabulary.
 *
 * The bespoke dashed pill with its own 8px dot is retired: durability is a
 * claim like any other, so it renders as a `<Seal>` chip. The wrapper survives
 * only to carry `role="status"` — adopting a vault is a state change a user
 * needs announced, and the seal itself is a `role="img"` by contract. It also
 * keeps `title`, which is what the shipped mobile-header assertion reads; the
 * seal now additionally folds the same detail into its accessible name, so the
 * sentence stops being hover-only for the first time.
 */
export function DurabilityIndicator({ state, detail }: { state: DurabilityState; detail?: string }) {
  // Page memory is `none`, not `failed`: nothing has gone wrong, no durability
  // evidence has been requested. A local device journal is verified evidence of
  // encryption at rest; a synced one is the same claim with the sync completed.
  const seal: SealState = state === "ephemeral" ? "none" : state === "syncing" ? "checking" : "verified";
  return (
    <span class={`durability-indicator ${state}`} role="status" title={detail}>
      <Seal state={seal} label={durabilityLabel(state)} detail={detail} />
    </span>
  );
}

export function durabilityLabel(state: DurabilityState): string {
  if (state === "ephemeral") return "Ephemeral · this page only";
  if (state === "local") return "Encrypted · this device";
  return state === "syncing" ? "Syncing encrypted state" : "Encrypted state synced";
}
