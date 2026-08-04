/**
 * Who may mint a bearer for the confidential embedding chute, and who is
 * allowed to know that somebody can.
 *
 * This lives apart from `semantic-browser-provider.ts` for one reason, and it is
 * a measured one rather than a taste: the *writer* of this authority is the
 * connection code in `src/ui/app.tsx`, which is in the eagerly-loaded chunk,
 * while the provider module is behind `context-route.tsx`'s dynamic import and
 * drags `hash-embeddings`, `semantic-worker-provider` and a `?worker&url`
 * reference along with it. Importing the provider from `app.tsx` merely to call
 * a two-line setter would have moved all of that into first-party startup
 * JavaScript, which sits ~1.7 KiB under its release budget. A module with no
 * imports at all cannot do that.
 *
 * `semantic-browser-provider.ts` re-exports every name here, so the reading side
 * is unchanged.
 */

/**
 * Supplies the `cpk_`/`cak_` bearer for confidential embeddings, or `undefined`
 * when Chutes is not connected.
 *
 * Held in module state rather than passed at construction because the context
 * runtime is minted per workspace object (`src/retrieval/client-context-runtime.ts`,
 * a `WeakMap`) and re-minted on every profile switch, so whichever caller won
 * that race would otherwise decide whether the page has an authority at all.
 * It is memory-only and never persisted: this is a bearer token.
 */
export type ConfidentialEmbeddingAuthority = () => Promise<string | undefined> | string | undefined;

export type ConfidentialAuthorityListener = (installed: boolean) => void;

let confidentialAuthority: ConfidentialEmbeddingAuthority | undefined;
const listeners = new Set<ConfidentialAuthorityListener>();

/**
 * Installs (or, with `undefined`, withdraws) the confidential bearer supplier.
 *
 * Read at each embed rather than captured, so an authority that arrives after
 * the provider was materialized still serves the next request — a connection
 * completing during a page's first index build is the ordinary case, not an
 * edge one.
 */
export function setConfidentialAuthority(authority: ConfidentialEmbeddingAuthority | undefined): void {
  const wasInstalled = confidentialAuthority !== undefined;
  confidentialAuthority = authority;
  const installed = authority !== undefined;
  /*
   * Only the presence transition is announced. Re-installing a supplier for a
   * connection that is already live happens on every credential rotation, and
   * it is not a fact any reader of this signal can act on; announcing it would
   * re-render the engine picker on a token refresh. The listener set is copied
   * because a listener may withdraw itself while being notified.
   */
  if (wasInstalled === installed) return;
  for (const listener of [...listeners]) listener(installed);
}

export function hasConfidentialAuthority(): boolean {
  return confidentialAuthority !== undefined;
}

/** The installed supplier, or `undefined`. Called per embed, never cached. */
export function readConfidentialAuthority(): ConfidentialEmbeddingAuthority | undefined {
  return confidentialAuthority;
}

/**
 * Notifies when the confidential authority appears or is withdrawn.
 *
 * The `chutes` embedding mode was unreachable partly because nothing could
 * observe this: a control that offers confidential embeddings has to appear
 * when Chutes connects and has to stop claiming to work when Chutes is
 * released, and reading a module global during a render is not an observation.
 */
export function subscribeConfidentialAuthority(listener: ConfidentialAuthorityListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
