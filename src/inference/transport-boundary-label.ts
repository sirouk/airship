import type { InferenceTransportBoundary } from "./providers/contracts";

/**
 * The one sentence this build says about an inference transport boundary.
 *
 * Two functions used to name the same boundaries differently — the top bar
 * said "provider TLS" while the Connect route said "Provider TLS · browser
 * direct" — so both surfaces now read this single answer.
 *
 * A leaf module rather than part of the Connect route because that route is a
 * deferred chunk `app.tsx` reaches only through a dynamic import: importing it
 * to read one switch statement would move an entire route into the
 * first-paint bundle. A shared answer with no dependencies is what lets both
 * surfaces ask.
 */
export function providerBoundaryLabel(boundary: InferenceTransportBoundary): string {
  switch (boundary) {
    case "provider-tls": return "Provider TLS · browser direct";
    case "loopback-local": return "This machine · loopback";
  }
}
