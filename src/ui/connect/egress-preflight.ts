/**
 * The hosts a control will contact, named before it is pressed.
 *
 * The Connection route disclosed its credential custody, its OAuth boundary and
 * its loopback allowlist, and disclosed nowhere that pressing "Discover models
 * with key" reaches three hosts. A person deciding whether to paste a secret is
 * deciding about egress, and egress was the one thing the page did not name.
 *
 * These are literals rather than imports of `CHUTES_LLM_MODELS_URL`,
 * `CHUTES_API_BASE` (src/models/types.ts) and the logo URL that
 * `model-picker.tsx` builds — importing across those seams makes Rollup emit a
 * shared chunk and the release gate refuses the unclassified artifact, which is
 * the same pack-boundary hazard `access-view.tsx` documents about the provider
 * fabric. Drift is closed the other way instead: `egress-preflight.test.ts`
 * imports both real constants and reads `model-picker.tsx`, and fails the build
 * if any of the three moves. A disclosure that can silently go stale is worse
 * than no disclosure, so the binding is a test rather than a hope.
 */
export const CHUTES_CATALOG_HOSTS: readonly string[] = Object.freeze([
  "llm.chutes.ai",
  "api.chutes.ai",
]);

/** Where the pasted key itself goes — and only at "Finish: verify & connect". */
export const CHUTES_AUTHORIZATION_HOST = "api.chutes.ai";

/**
 * Model card logos. Measured leaving this build 4.8 s after discovery, one
 * request per discovered model, disclosed by nothing on the page.
 */
export const CHUTES_LOGO_HOST = "logos.chutes.ai";

/** How a list of hosts reads in a sentence. */
export function hostPhrase(hosts: readonly string[]): string {
  if (hosts.length === 0) return "no host";
  if (hosts.length === 1) return hosts[0]!;
  return `${hosts.slice(0, -1).join(", ")} and ${hosts[hosts.length - 1]!}`;
}

/**
 * The sentence above "Discover models with key".
 *
 * Measured, in this order, from one press: three unauthenticated catalog reads
 * at t=28ms, then one logo image per model card. The key is not attached to any
 * of them — it goes on the wire only at "Finish: verify & connect", as a Bearer
 * token to api.chutes.ai/e2e/instances/… — so the pre-flight says exactly that
 * rather than the vaguer, scarier truth-adjacent "this contacts Chutes".
 */
export const CHUTES_DISCOVERY_PREFLIGHT = `Pressing this reads the public Chutes catalog from ${hostPhrase(CHUTES_CATALOG_HOSTS)}, and model cards then load logos from ${CHUTES_LOGO_HOST}. Your key is not attached to any of those requests: it leaves this device only at “Finish: verify & connect”, as a bearer token to ${CHUTES_AUTHORIZATION_HOST}.`;
