/**
 * The exact build-time opt-in for the host-composed loopback storage lab.
 *
 * `vite.config.ts` replaces the environment read with the literal `"1"` or
 * `"0"`, so this constant folds at build time. Every lab-only branch, module
 * and dynamic import in the product is written against it, which is what keeps
 * a stock build from *carrying* the lab rather than merely refusing it at
 * runtime. `scripts/release-gate.mjs` checks the artifact, not this promise.
 */
export const LOCAL_LAB_BUILD: boolean = import.meta.env.VITE_AIRSHIP_ENABLE_LOCAL_LAB === "1";
