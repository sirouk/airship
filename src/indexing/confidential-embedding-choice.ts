/**
 * Which embedding deployment the person picked, when Chutes offered more than one.
 *
 * `prepareConfidentialEmbeddings` already resolves a deployment on its own —
 * live instance first, then catalog order — and that resolution is the right
 * answer for every case where there is nothing to decide. It stops being the
 * right answer the moment Chutes publishes two usable embedding chutes, because
 * then the tie is broken by whichever one happened to be warm, and the index a
 * corpus is built into is not something to settle by coincidence.
 *
 * So this module holds one fact: the id the person chose. It is deliberately
 * dependency-free, exactly like `confidential-authority.ts`, so the Connection
 * route can write it without pulling the indexing graph into its chunk, and it
 * is deliberately *advisory* — the id is matched against a live catalog at use
 * time, and an id that no longer exists silently loses to the automatic
 * resolution rather than failing an index build. A model can be retired between
 * two page loads and nothing here can prevent that; what it can do is not turn
 * it into an error.
 *
 * Persisted, unlike the credential: the credential is a secret whose lifetime is
 * this page, while this is a preference about how a durable index was built. A
 * storage denial is not a failure — the choice simply lasts as long as the tab.
 */

/** Namespaced beside `airship.context.embedding.v1`, the engine-mode key. */
const CHOICE_KEY = "airship.context.embedding.model.v1";

/** The tab's own answer, so a denied `localStorage` still honours a choice. */
let sessionChoice: string | undefined;

/**
 * The chosen deployment id, or nothing when no one has ever chosen.
 *
 * "No preference" and "prefers the automatic pick" are the same fact here, and
 * both resolve through the caller's own ordering — which is why this returns
 * `undefined` rather than a default it would have to invent.
 */
export function readConfidentialEmbeddingChoice(): string | undefined {
  if (sessionChoice) return sessionChoice;
  if (typeof localStorage === "undefined") return undefined;
  try {
    const stored = localStorage.getItem(CHOICE_KEY)?.trim();
    return stored ? stored : undefined;
  } catch {
    // Storage can be denied by browser privacy policy even when the API exists.
    return undefined;
  }
}

/** Records a choice, or clears it when the caller passes nothing. */
export function writeConfidentialEmbeddingChoice(modelId: string | undefined): void {
  const value = modelId?.trim();
  sessionChoice = value ? value : undefined;
  if (typeof localStorage === "undefined") return;
  try {
    if (value) localStorage.setItem(CHOICE_KEY, value);
    else localStorage.removeItem(CHOICE_KEY);
  } catch {
    // The tab-scoped answer above still applies; persistence is optional.
  }
}
