import { useEffect, useState } from "preact/hooks";

export const PRESENTATION_DENSITIES = ["minimal", "balanced", "instrumented"] as const;

export type PresentationDensity = (typeof PRESENTATION_DENSITIES)[number];

/**
 * The quiet screen is the ordinary one. Instrumented depth exists so the
 * expert can reach it in one action, never so the ordinary view reads like
 * the diagnostics console. A profile may raise its own default above this;
 * nothing ever sinks a profile below it without the profile saying so.
 */
export const DEFAULT_PRESENTATION_DENSITY: PresentationDensity = "minimal";

export function parsePresentationDensity(value: unknown): PresentationDensity {
  return value === "balanced" || value === "instrumented" ? value : DEFAULT_PRESENTATION_DENSITY;
}

/**
 * The classes of presentation a density can retire. Tagging is the contract:
 * a surface names what it *is*, and the density decides whether Preact
 * renders it at all. Retired is not hidden — the element never mounts, so
 * nothing pays for it — and re-raising the density mounts it back onto the
 * state the stores have kept the entire time.
 *
 * - telemetry: counters, timings, token and usage readouts, sync/indexing
 *   status beyond the line that says work is running.
 * - proof: attestation pills and proof chips next to results. The evidence
 *   itself always persists; only its inline echo is density-bound.
 * - suggestion: starter prompts and "try next" offerings.
 * - commentary: interpretation aimed at the interface rather than the work.
 * - chatter: reload/append/reconnect miles readouts inside a transcript.
 * - raw: digests, hashes, receipts, timing internals, protocol detail.
 */
export type DensityTag =
  | "telemetry"
  | "proof"
  | "suggestion"
  | "commentary"
  | "chatter"
  | "raw";

/** What each density renders. Sharp state (where am I, what is running
 *  now, controls, warnings that require attention) never passes through
 *  this function at all. */
export function densityAllows(tag: DensityTag, density: PresentationDensity): boolean {
  if (density === "instrumented") return true;
  if (density === "minimal") return false;
  return tag !== "raw";
}

type Listener = () => void;

let density: PresentationDensity = DEFAULT_PRESENTATION_DENSITY;
const listeners = new Set<Listener>();

export function presentationDensity(): PresentationDensity {
  return density;
}

/**
 * The Profile-level presentation preference, mirrored into the app the same
 * way the transcript visibility preference is: every surface reads the same
 * authority, so a profile switch changes every view in the frame the profile
 * lands. The document dataset mirrors it for pure-CSS consumers, and every
 * listener re-reads it for components that gate their own render.
 */
export function setPresentationDensity(next: PresentationDensity): void {
  /*
   * A dedicated dataset key, never the legacy `data-density` one: that one is
   * the Preferences spacing preference (comfortable/compact) and clobbering
   * it would collapse the spacing tokens on every profile switch. Two
   * densities, two axes — spacing and information.
   */
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.presentationDensity = next;
  }
  if (next === density) return;
  density = next;
  for (const listener of listeners) listener();
}

export function subscribePresentationDensity(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePresentationDensity(): PresentationDensity {
  const [value, setValue] = useState(density);
  useEffect(() => {
    setValue(density);
    return subscribePresentationDensity(() => setValue(presentationDensity()));
  }, []);
  return value;
}

/**
 * The render gate for tagged surfaces. Components call this where the
 * alternative is a mounted-but-hidden element: returning false means the
 * JSX never mounts, per the mandate that retired surfaces cost nothing.
 */
export function useDensityAllows(tag: DensityTag): boolean {
  return densityAllows(tag, usePresentationDensity());
}
