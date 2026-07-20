import type { SecurityPosture } from "../core/contracts";
import type { JsonValue } from "../core/contracts";
import type { ClaimKey, ProofLevel, ProofStatus } from "../receipts/types";

export function proofLevelLabel(value: ProofLevel): string {
  const labels: Readonly<Record<ProofLevel, string>> = {
    local: "Local evidence only",
    encrypted: "Encrypted",
    "attested-endpoint": "Endpoint attested",
    "model-bound": "Model policy bound",
    "conversation-bound": "Conversation bound",
    settled: "Settlement verified",
  };
  return labels[value];
}

export function postureLabel(value: SecurityPosture): string {
  if (value === "local") return "Local only";
  if (value === "plaintext-remote") return "Remote · not encrypted end to end";
  if (value === "encrypted-unattested") return "Encrypted · no required endpoint proof";
  return "Encrypted · fresh endpoint proof required";
}

export function proofStatusLabel(value: ProofStatus): string {
  if (value === "verified") return "Verified";
  if (value === "partial") return "Asserted";
  if (value === "failed") return "Failed";
  if (value === "expired") return "Expired";
  return "Unavailable";
}

export function relativeEvidenceAge(timestamp: string, now = Date.now()): string {
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return "Time unavailable";
  const seconds = Math.round((then - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function claimLanguage(key: ClaimKey): Readonly<{ primary: string; technical: string }> {
  const labels: Readonly<Record<ClaimKey, readonly [string, string]>> = {
    encryption: ["Encrypted transport", "E2EE channel"],
    freshness: ["Fresh evidence", "Nonce and evidence age"],
    cpuTee: ["Protected CPU runtime", "CPU TEE"],
    gpuTee: ["Protected accelerator", "GPU TEE"],
    endpointKey: ["Endpoint identity", "Attested endpoint-key binding"],
    model: ["Model artifact", "Artifact and runtime policy"],
    conversation: ["Conversation integrity", "Request/response binding"],
    payment: ["Payment standing", "Settlement receipt"],
  };
  const [primary, technical] = labels[key];
  return Object.freeze({ primary, technical });
}

export function rankedReceiptVerdict(args: Readonly<{ proofLevel: ProofLevel; posture: SecurityPosture; statuses: readonly ProofStatus[] }>): string {
  if (args.statuses.some((status) => status === "failed" || status === "expired")) return "Verification failed or expired · do not rely on this receipt";
  if (args.statuses.some((status) => status === "partial")) return `${postureLabel(args.posture)} · some claims are assertions`;
  if (args.statuses.some((status) => status === "verified")) return `${proofLevelLabel(args.proofLevel)} · verified claims are listed below`;
  return `${postureLabel(args.posture)} · no independently verified claim is available`;
}

export function claimExpiry(details: JsonValue | undefined): string | undefined {
  if (!details || Array.isArray(details) || typeof details !== "object") return undefined;
  for (const key of ["expiresAt", "expires_at", "notAfter", "not_after"]) {
    const value = details[key];
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}
