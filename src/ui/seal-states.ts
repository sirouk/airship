import type { SecurityPosture } from "../core/contracts";
import type { ConversationReceipt } from "../receipts/types";
import type { SealState } from "./seal";

/**
 * Seal-state mappings that only evidence routes need.
 *
 * `seal.tsx` is reachable from the entry chunk, so everything left in it is
 * paid for at first paint. Both of these are consumed exclusively by the lazily
 * delivered Proof surface, so a user who never opens it never downloads them.
 * The grammar is unchanged — same states, same fail-closed rules — only the
 * delivery boundary moved.
 */

/** Maps runtime posture to the canonical proof-hero shape. */
export function postureSeal(posture: SecurityPosture | undefined): SealState {
  if (posture === "encrypted-attested") return "verified";
  if (posture === "encrypted-unattested") return "asserted";
  if (posture === "plaintext-remote") return "attention";
  return "none";
}

/** A stored receipt earns a green hero only when its attested fields agree. */
export function sealStateForReceipt(receipt: ConversationReceipt | undefined): SealState {
  if (!receipt) return "none";
  if (receipt.posture !== "encrypted-attested") return postureSeal(receipt.posture);
  const attestedLevel = receipt.proofLevel === "attested-endpoint"
    || receipt.proofLevel === "model-bound"
    || receipt.proofLevel === "conversation-bound"
    || receipt.proofLevel === "settled";
  return receipt.claims.endpointKey.status === "verified" && attestedLevel ? "verified" : "failed";
}
