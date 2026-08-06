/**
 * Which embedding deployment the person picked, when Chutes offered more than one.
 *
 * `prepareConfidentialEmbeddings` resolves a sole live deployment on its own.
 * When Chutes publishes two usable embedding chutes, catalog order and warmth
 * are not a decision, so the person must choose one before an index can use it.
 *
 * So this module holds one fact: the id the person chose. It is deliberately
 * dependency-free, exactly like `confidential-authority.ts`, so the Connection
 * route can write it without pulling the indexing graph into its chunk, and it
 * is deliberately matched against a live catalog at use time. A retired id is
 * never silently replaced with another deployment; the current Connection view
 * asks for a fresh choice instead.
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
 * "No preference" remains `undefined`, rather than a default this module would
 * have to invent.
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
