import type { SecurityPosture } from "../core/contracts";
import { Seal, type SealState } from "./seal";

export function PostureChip({ posture, prefix = "Minimum" }: { posture: SecurityPosture; prefix?: string }) {
  const presentation = posturePresentation(posture);
  return <span class="posture-chip" data-posture={posture}><small>{prefix}</small><Seal state={presentation.state} label={presentation.label} detail={presentation.detail} compact /></span>;
}

export function posturePresentation(posture: SecurityPosture): Readonly<{ state: SealState; label: string; detail: string }> {
  switch (posture) {
    case "local": return { state: "none", label: "Local", detail: "No remote inference required." };
    case "encrypted-unattested": return { state: "asserted", label: "Encrypted · unattested", detail: "Encryption required; TEE identity may be unverified." };
    case "encrypted-attested": return { state: "verified", label: "Encrypted · attested", detail: "Fresh verified attestation required." };
    case "plaintext-remote": return { state: "attention", label: "Plaintext remote", detail: "Remote plaintext permitted." };
  }
}
