import type { SessionInferenceBinding } from "../core/contracts";

/**
 * The one sentence this build says about an inference transport boundary.
 *
 * Two functions named the same three boundaries differently and described them
 * differently: the top bar's `inferenceBoundaryLabel` said "provider TLS" and
 * "application E2EE · evidence capable"; the Connect route's
 * `providerBoundaryLabel` said "Provider TLS · browser direct" and "Application
 * E2EE · evidence evaluated separately". The second set is the true one, and
 * the difference is not cosmetic — "evidence capable" reads as a property the
 * transport already has, where the fact is that endpoint evidence is judged by
 * a separate verifier that is free to reject it. `provider-connections-view`'s
 * test pins that the word "verified" never appears here for that reason.
 *
 * A leaf module rather than the Connect route, for the same reason
 * `chutes/strict-proof-capability.ts` is one: `provider-connections-view.tsx`
 * is a deferred chunk that `app.tsx` reaches only through a dynamic import, so
 * importing it to read one switch statement would move an entire route into the
 * first-paint bundle. A shared answer with no dependencies is what lets both
 * surfaces ask.
 */
export function providerBoundaryLabel(
  boundary: SessionInferenceBinding["transportBoundary"],
): string {
  switch (boundary) {
    case "e2ee-attestable": return "Application E2EE · evidence evaluated separately";
    case "provider-tls": return "Provider TLS · browser direct";
    case "loopback-local": return "This machine · loopback";
  }
}
