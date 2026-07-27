import type { ClaimStackFact, ClaimStackItem } from "./claim-stack-model";

/**
 * The rows a claim's chip expands into.
 *
 * Rung L1 of the disclosure ladder promises the *whole* claim behind one
 * gesture: who asserted it, over what, how old it is, and the facts that let
 * someone else recompute it. Composing that list once keeps every popover in
 * the product showing the same fields for the same claim.
 *
 * It lives beside `claim-stack-model.ts` rather than inside it because that
 * module is reachable from the entry chunk, and the startup budget currently
 * has bytes rather than kilobytes of headroom. A projection used only by
 * disclosure surfaces belongs in the chunks those surfaces travel in.
 */
export function claimStackPopoverFacts(item: ClaimStackItem): readonly ClaimStackFact[] {
  const { verifier, checkedAt } = item.claim;
  return Object.freeze([
    { label: "Issuer", value: verifier ?? "Not established" },
    { label: "Scope", value: item.source === "endpoint-evidence" ? "Endpoint evidence" : "Turn receipt" },
    { label: "Checked", value: checkedAt ?? "Never" },
    ...item.facts,
  ]);
}
