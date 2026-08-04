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

/**
 * A fourth Chutes host the same key authorizes, and deliberately not in the
 * sentence below.
 *
 * `connect-src` permits it (`index.html`), `ChutesEmbeddingProvider` sends the
 * `cpk_` bearer this route collects, and what it would embed is the text of the
 * person's own workspace files and memories — so leaving it unnamed anywhere
 * would be the same defect this module was written to fix. But it does not belong in the discovery pre-flight, because
 * that sentence makes one promise: *these are the hosts this button reaches, in
 * the order it reaches them*. "Discover models with key" never contacts this
 * host. Adding it would buy breadth by making the sentence false, and a
 * disclosure that over-names is not more honest than one that under-names — it
 * is differently wrong, and it teaches the reader that the list is decorative.
 *
 * That day has arrived. The embedding-engine control now offers a third
 * choice, so the exemption's third half — "no control selects the mode" — has
 * been paid off in the only currency it accepted: the disclosure below, on
 * screen beside the control, before the press. `egress-preflight.test.ts` still
 * asserts all three halves; the third one now reads the other way round.
 */
export const CHUTES_CONFIDENTIAL_EMBEDDING_HOST = "chutes-qwen-qwen3-embedding-8b-tee.chutes.ai";

/**
 * The sentence beside the Confidential embedding button.
 *
 * The discovery pre-flight above discloses one credentialed request. This one
 * discloses something larger and has to say so plainly: selecting confidential
 * embeddings sends *the text of every indexed workspace file and memory* to a
 * host outside this page, and keeps doing it on every rebuild — not one request
 * at the moment of a button press.
 *
 * It says "leaves this page" rather than "is uploaded" because the TEE posture
 * is the only reason this option is admissible at all, and eliding it would
 * make the choice look worse than it is; it says it *before* naming the TEE
 * because a caveat that arrives after the reassurance is not read. Both
 * on-device engines are named in the same breath so the alternative to the
 * egress is a thing the reader can see rather than infer.
 *
 * Placed where the choice is made, not behind the disclosure the status row can
 * collapse: this is the reader deciding about the request that carries their
 * corpus, and they decide before pressing.
 */
export const CHUTES_CONFIDENTIAL_EMBEDDING_PREFLIGHT = `Choosing this sends the text of every indexed file and memory to ${CHUTES_CONFIDENTIAL_EMBEDDING_HOST}, with your Chutes credential as a bearer token, and again on every rebuild. That chute is confidential compute, which is why it is offered here at all — but the text does leave this page. Bootstrap and Local semantic never send it anywhere.`;

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
