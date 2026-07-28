import type { SessionManifest } from "../../core/contracts";

export type CapabilityTier = SessionManifest["capabilityTier"];

const CAPABILITY_TIERS = new Set<CapabilityTier>([
  "web-baseline",
  "web-enhanced",
  "native",
  "remote-confidential",
]);

export function parseCapabilityTier(value: unknown): CapabilityTier | undefined {
  return typeof value === "string" && CAPABILITY_TIERS.has(value as CapabilityTier)
    ? value as CapabilityTier
    : undefined;
}

export function capabilityTierLabel(tier: CapabilityTier): string {
  if (tier === "web-baseline") return "Browser baseline";
  if (tier === "web-enhanced") return "Browser enhanced";
  if (tier === "native") return "Native companion";
  return "Remote confidential";
}

export function capabilityTierDetail(tier: CapabilityTier): string {
  return `${capabilityTierLabel(tier)} capability tier.`;
}
