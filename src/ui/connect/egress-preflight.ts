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
 * It named the catalog hosts and the logo host, which nothing on the page had
 * named before — and promised the key stayed put until Finish. That promise is
 * gone because the flow it described was the defect: an unchecked key reached a
 * priced model picker, since the catalog answers anyone. The key is now offered
 * to Chutes first, so the pre-flight says that first, in the order the requests
 * actually happen. Naming the credentialed host up front is the stronger
 * disclosure anyway: the reader decides about the one request that carries
 * their secret before pressing, not after.
 */
export const CHUTES_DISCOVERY_PREFLIGHT = `Pressing this sends your key to ${CHUTES_AUTHORIZATION_HOST} as a bearer token, to ask whether Chutes accepts it. If it does, Airship then reads the public Chutes catalog from ${hostPhrase(CHUTES_CATALOG_HOSTS)} without your key attached, and model cards load logos from ${CHUTES_LOGO_HOST}. If Chutes refuses the key, nothing else is contacted.`;
