import type { JSX } from "preact";
import type { SecurityPosture } from "../core/contracts";
import type { ProofStatus } from "../receipts/types";

export const SEAL_STATES = [
  "none",
  "checking",
  "stale",
  "verified",
  "asserted",
  "attention",
  "failed",
] as const;

export type SealState = (typeof SEAL_STATES)[number];

export const SEAL_LABELS: Readonly<Record<SealState, string>> = Object.freeze({
  none: "Not checked",
  checking: "Checking",
  stale: "Stale",
  verified: "Verified",
  asserted: "Asserted",
  attention: "Attention",
  failed: "Failed",
});

export type SealProps = Readonly<{
  state: SealState;
  label?: string;
  detail?: string;
  size?: number;
  compact?: boolean;
  origin?: "local" | "remote";
  acting?: boolean;
  class?: string;
}>;

export function sealRenderedSize(size: number): number {
  return Math.max(16, size);
}

/**
 * Airship's single proof/status mark.
 *
 * Six SVG shapes express seven named states: checking and stale deliberately
 * share the arc shape, with stale rendered as the static dashed variant.
 * The adjacent word is part of the component contract so color is never the
 * only carrier of meaning.
 */
export function Seal({
  state,
  label = SEAL_LABELS[state],
  detail,
  size = 18,
  compact = false,
  origin,
  acting = false,
  class: className,
}: SealProps) {
  const renderedSize = sealRenderedSize(size);
  const accessibleLabel = detail ? `${label}. ${detail}` : label;
  return (
    <span
      class={["seal", compact ? "seal--compact" : undefined, className].filter(Boolean).join(" ")}
      data-state={state}
      data-origin={origin}
      data-acting={acting ? "true" : "false"}
      title={detail}
      role="img"
      aria-label={accessibleLabel}
    >
      <svg
        class="seal__svg"
        height={renderedSize}
        viewBox="0 0 24 24"
        width={renderedSize}
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.65"
      >
        {sealShape(state)}
      </svg>
      <span class="seal__label">{label}</span>
    </span>
  );
}

export function sealStateForProofStatus(status: ProofStatus | undefined): SealState {
  if (status === "verified") return "verified";
  if (status === "partial") return "asserted";
  if (status === "failed" || status === "expired") return "failed";
  return "none";
}

export function sealStateForRuntimeStatus(
  status: "checking" | "loading" | "stale" | "degraded" | "conflicted" | "attention" | undefined,
): SealState {
  if (status === "checking" || status === "loading") return "checking";
  if (status === "stale") return "stale";
  if (status === "degraded" || status === "conflicted" || status === "attention") return "attention";
  return "none";
}

/** Maps runtime posture to the canonical proof-hero shape. */
export function postureSeal(posture: SecurityPosture | undefined): SealState {
  if (posture === "encrypted-attested") return "verified";
  if (posture === "encrypted-unattested") return "asserted";
  if (posture === "plaintext-remote") return "attention";
  return "none";
}

function sealShape(state: SealState): JSX.Element {
  if (state === "checking" || state === "stale") {
    return (
      <path
        class={state === "stale" ? "seal__arc seal__arc--stale" : "seal__arc seal__arc--checking"}
        d="M18.4 6.6A9 9 0 1 0 19 16.5"
      />
    );
  }
  if (state === "verified") {
    return (
      <>
        <circle class="seal__fill" cx="12" cy="12" r="9" stroke="none" />
        <path class="seal__cutout" d="m7.8 12.1 2.7 2.7 5.8-6" />
      </>
    );
  }
  if (state === "asserted") {
    return (
      <>
        <circle cx="12" cy="12" r="9" />
        <path class="seal__fill" d="M12 3a9 9 0 0 0 0 18Z" stroke="none" />
        <path d="M12 3v18" />
      </>
    );
  }
  if (state === "attention") {
    return (
      <>
        <path d="m12 2.8 9.2 9.2-9.2 9.2L2.8 12Z" />
        <path d="M12 7.8v5.4M12 16.6v.1" />
      </>
    );
  }
  if (state === "failed") {
    return (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 8.5 7 7m0-7-7 7" />
      </>
    );
  }
  return <circle cx="12" cy="12" r="9" />;
}
