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

/** One sealed call into a path inside a chute. */
export type ConfidentialEmbeddingInvocation = Readonly<{
  chuteId: string;
  /** The path *inside* the chute, e.g. the discovered `/v1/embeddings`. */
  path: string;
  payload: unknown;
  signal?: AbortSignal;
}>;

/**
 * Performs one end-to-end encrypted invocation on behalf of the embedding
 * provider, or is absent when Chutes is not connected.
 *
 * This used to hand out the raw `cpk_`/`cak_` bearer, because the provider
 * opened its own plain HTTPS connection to a named embedding host and needed
 * something to put in an `Authorization` header. It does not any more: the
 * corpus is sealed to the instance's public key and posted to `/e2e/invoke` by
 * the same transport the chat lane uses, so what the indexing side needs is the
 * *capability to invoke*, not the credential that authorizes it. The bearer now
 * never leaves the connection that owns it.
 *
 * Held in module state rather than passed at construction because the context
 * runtime is minted per workspace object (`src/retrieval/client-context-runtime.ts`,
 * a `WeakMap`) and re-minted on every profile switch, so whichever caller won
 * that race would otherwise decide whether the page has an authority at all.
 * It is memory-only and never persisted.
 */
export type ConfidentialEmbeddingAuthority = (
  request: ConfidentialEmbeddingInvocation,
) => Promise<unknown>;

export type ConfidentialAuthorityListener = (installed: boolean) => void;

let confidentialAuthority: ConfidentialEmbeddingAuthority | undefined;
const listeners = new Set<ConfidentialAuthorityListener>();

/**
 * Installs (or, with `undefined`, withdraws) the confidential invoker.
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

/** The installed invoker, or `undefined`. Read per embed, never cached. */
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
