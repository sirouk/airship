import { Seal, type SealState } from "./seal";

/**
 * Where a journal lives, and whether its sync is running.
 *
 * `sync-paused` is its own member rather than a reading of `syncing`. An adopted
 * cloud vault in an offline browser is not synchronizing, and `syncing` renders
 * as "Syncing encrypted state" — a present-progressive activity claim, which is
 * the opposite of what that state's own detail sentence says. Borrowing the
 * in-progress word for a stopped sync makes the chip contradict itself in its
 * own accessible name, and a reader who believes a sync is under way can close
 * the tab on work that never left the browser.
 */
export const DURABILITY_STATES = ["ephemeral", "local", "syncing", "sync-paused", "synced"] as const;

export type DurabilityState = (typeof DURABILITY_STATES)[number];

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
  return (
    <span class={`durability-indicator ${state}`} role="status" title={detail}>
      <Seal state={durabilitySeal(state)} label={durabilityLabel(state)} detail={detail} />
    </span>
  );
}

/**
 * The one durability→seal mapping, for every surface that renders the claim.
 *
 * Page memory is `attention`. It shipped as `none` — "nothing has gone wrong,
 * no durability evidence has been requested" — and the Journey Atlas measured
 * what that costs: 180 turns accumulated a chained-looking journal while the
 * only durability warning in the product was a transient status string that the
 * first turn overwrote and never restored, and a reload destroyed all of it.
 * `attention` is this vocabulary's own definition of the state a reader has to
 * do something about, and doing nothing about page memory destroys the work.
 * The rung is not a verdict on the person's choice: the Vault route offers
 * Ephemeral deliberately, and nothing here blocks it — the chip states the
 * consequence the route's own comparison table states ("What can lose it:
 * Closing the page") instead of rendering it as the neutral resting state.
 *
 * A local device journal is verified evidence of encryption at rest; a synced
 * one is the same claim with the round-trip completed. A sync that is *running*
 * is `checking`; a sync that has stopped is `attention`, because it is a state
 * that needs the reader to do something — the same rung the vault trust axis
 * gives an unreachable adopted vault.
 */
export function durabilitySeal(state: DurabilityState): SealState {
  if (state === "ephemeral") return "attention";
  if (state === "syncing") return "checking";
  return state === "sync-paused" ? "attention" : "verified";
}

export function durabilityLabel(state: DurabilityState): string {
  if (state === "ephemeral") return "Ephemeral · this page only";
  if (state === "local") return "Encrypted · this device";
  if (state === "syncing") return "Syncing encrypted state";
  // No present-progressive verb: nothing is synchronizing, and the reason is the
  // words a reader can act on.
  return state === "sync-paused" ? "Encrypted · sync paused offline" : "Encrypted state synced";
}

/**
 * The resting word for a chip too narrow to render the whole label.
 *
 * `sessionStatusShort` derives one by taking the head before " · ", which turns
 * this vocabulary's page-memory claim into the bare word "Ephemeral" — a term
 * the Atlas found novices could not read: the persona who lost a conversation
 * to a refresh had met "Ephemeral · this page only" four times and still could
 * not tell that their work was not being kept. The abbreviation belongs to the
 * vocabulary rather than to the chip, and it says the consequence.
 */
export function durabilityShort(state: DurabilityState): string {
  if (state === "ephemeral") return "Not saved";
  if (state === "syncing") return "Syncing";
  if (state === "sync-paused") return "Sync paused";
  return "Encrypted";
}
