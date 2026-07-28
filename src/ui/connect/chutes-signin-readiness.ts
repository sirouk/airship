/**
 * Whether this build's Chutes sign-in exchange can actually run — asked once,
 * at load, rather than discovered by a person pressing the primary button.
 *
 * The measured defect: `#connection` opened with the OAuth tab marked
 * "Primary" and a filled brass "Sign in to Chutes", and pressing it returned a
 * sentence addressed to whoever restarts the lab. The readiness endpoint that
 * produced that 503 already existed — it was simply only ever consulted *after*
 * the press. Consulting it at load is what lets the lane stop advertising a
 * route it cannot take.
 *
 * Two arms and no third: `undefined` is the in-flight reading, exactly as the
 * extension-bridge observation does it. An unfinished probe may not stand in
 * for either answer, because "we have not asked yet" is not "sign-in works".
 */
export type ChutesSignInReadiness =
  | Readonly<{ state: "ready" }>
  | Readonly<{ state: "blocked"; reason: string }>;

/** The readiness endpoint the localhost token handler answers on. */
export const CHUTES_OAUTH_HANDLER_URL = "/__airship/chutes/oauth/token";

/**
 * The operator sentences, verbatim and in one place.
 *
 * These are provenance lines: they name the process that has to change and the
 * thing it is missing. They are not softened and not deleted anywhere — the
 * lane renders the consequence at lane altitude and keeps whichever of these
 * applies one rung down, inside a disclosure that says what it contains.
 */
export const CHUTES_HANDLER_UNCONFIGURED = "The local Chutes OAuth handler is not configured. Restart the Airship lab with its process-held client secret.";
export const CHUTES_HANDLER_UNREACHABLE = "The local Chutes OAuth handler is unavailable. Restart the Airship lab with its OAuth registration configured.";

/**
 * The readiness reading for one HTTP outcome. `"network-error"` is the fetch
 * that never landed, which is a different fact from any status code.
 */
export function readChutesSignInReadiness(outcome: number | "network-error"): ChutesSignInReadiness {
  if (outcome === "network-error") return Object.freeze({ state: "blocked", reason: CHUTES_HANDLER_UNREACHABLE });
  if (outcome === 503) return Object.freeze({ state: "blocked", reason: CHUTES_HANDLER_UNCONFIGURED });
  if (outcome === 204) return Object.freeze({ state: "ready" });
  return Object.freeze({
    state: "blocked",
    reason: `The local Chutes OAuth handler readiness check failed with HTTP ${String(outcome)}.`,
  });
}

/**
 * Asks the handler, once. Resolves a named blocked reading rather than
 * rejecting, so no caller has a silent-catch path in which a failed probe can
 * become "no problem here".
 */
export async function probeChutesSignInHandler(
  fetchImpl: typeof fetch = fetch,
): Promise<ChutesSignInReadiness> {
  let response: Response;
  try {
    response = await fetchImpl(CHUTES_OAUTH_HANDLER_URL, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return readChutesSignInReadiness("network-error");
  }
  return readChutesSignInReadiness(response.status);
}
