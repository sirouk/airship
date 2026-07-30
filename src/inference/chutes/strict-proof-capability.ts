/**
 * Whether this build can require verified endpoint evidence — as a leaf module.
 *
 * The record used to live in `attestation-gate.ts`, which is correct company
 * for it but unreachable for anything that paints first: that module pulls in
 * the Intel DCAP QVL verifier and its ~1 MB WASM, so importing it to read one
 * frozen boolean would have moved the verifier into the startup chunk.
 *
 * Two surfaces need this answer and only one of them was getting it. The
 * Connection route reads it to disable strict fail-closed; the Profiles editor
 * did not, and so offered a minimum-proof floor of "Attested" that no transport
 * in this build can satisfy — a profile that could never start a conversation.
 * A shared answer with no dependencies is what lets both ask.
 *
 * Build-time verifier capability, not a provider or model assertion. The
 * shipped browser verifier authenticates NVIDIA device evidence but cannot yet
 * perform the nonce-bound RIM, revocation and freshness checks needed to
 * promote the GPU claim from `matched` to `verified`. Keep strict mode visibly
 * unavailable until that independent verifier path exists, rather than offering
 * a policy that is guaranteed to reject every turn.
 */
export const CHUTES_STRICT_ENDPOINT_PROOF_CAPABILITY = Object.freeze({
  available: false,
  reason: "Independent NVIDIA GPU verification is not yet browser-complete; strict endpoint proof would reject every turn.",
});
