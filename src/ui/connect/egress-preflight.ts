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
 * Where a confidential embedding request actually goes, and deliberately not in
 * the discovery sentence below.
 *
 * This used to name one chute's own hostname —
 * `chutes-qwen-qwen3-embedding-8b-tee.chutes.ai` — because the embedding
 * provider opened a plain HTTPS connection to it and put the `cpk_` bearer in an
 * `Authorization` header. Two things were wrong with that and one of them was
 * this constant: a per-chute hostname is a fact about today's catalog, so a
 * disclosure built on it could only stay true while exactly one embedding chute
 * existed, and the `connect-src` grant it needed could never be written for a
 * chute discovered tomorrow.
 *
 * The corpus now travels the same way a conversation does: sealed on this device
 * to the serving instance's own public key and posted to `/e2e/invoke` on the
 * Chutes API host. So the host named here is the one the reader has already been
 * told about at connection time, it does not move when the catalog does, and the
 * sentence below can describe the request honestly rather than approximately.
 *
 * It is still kept out of the *discovery* pre-flight, which makes one promise:
 * *these are the hosts this button reaches, in the order it reaches them*.
 * "Discover models with key" does not embed anything. Adding it there would buy
 * breadth by making that sentence false.
 */
export const CHUTES_CONFIDENTIAL_EMBEDDING_HOST = "api.chutes.ai";

/**
 * The sentence beside the Confidential embedding button.
 *
 * The discovery pre-flight above discloses one credentialed request. This one
 * discloses something larger and has to say so plainly: selecting confidential
 * embeddings sends *the text of every indexed workspace file and memory* off
 * this device, and keeps doing it on every rebuild — not one request at the
 * moment of a button press.
 *
 * It says the text is encrypted here *and* that it leaves, in that order and in
 * one breath, because both are true and either alone is a lie by omission. The
 * TEE and the sealing are the only reasons this option is admissible at all, so
 * eliding them would make the choice look worse than it is; but "encrypted" is
 * not "stays here", and a reader who takes it that way has been misled. Both
 * on-device engines are named in the same breath so the alternative is a thing
 * the reader can see rather than infer.
 *
 * It names no model, because the model is discovered and this string is not.
 *
 * Placed where the choice is made, not behind the disclosure the status row can
 * collapse: this is the reader deciding about the request that carries their
 * corpus, and they decide before pressing.
 */
export const CHUTES_CONFIDENTIAL_EMBEDDING_PREFLIGHT = `Choosing this sends the text of every indexed file and memory to a Chutes embedding model, and again on every rebuild. Each request is encrypted on this device to the serving enclave's own key and posted to ${CHUTES_CONFIDENTIAL_EMBEDDING_HOST}, so Chutes routes ciphertext it cannot read and only the confidential-compute enclave opens it — but the text does leave this page. Bootstrap and Local semantic never send it anywhere.`;

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
