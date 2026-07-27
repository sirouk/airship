/**
 * Content-script entry.
 *
 * Injected only on the compiled-in Airship match patterns, in the top frame
 * only. It owns no policy: it hands every page message to `createPageChannel`
 * and hands every reply back to the exact page origin.
 */

import { BRIDGE_PORT_NAME, RELEASE_CALLERS, developmentCallers } from "./policy";
import { createPageChannel } from "./content-bridge";
import { installCompanionContentBridge } from "./companion-content";
import { resolveExtensionApi } from "./webextension";

declare const __AIRSHIP_BRIDGE_CHANNEL__: string;

// The channel is a build-time define, so this ternary folds to one branch and
// a release artifact does not carry the development origins at all.
const callers = __AIRSHIP_BRIDGE_CHANNEL__ === "development" ? developmentCallers() : RELEASE_CALLERS;
const api = resolveExtensionApi(globalThis as unknown as Record<string, unknown>);

if (api && window.top === window) {
  const bridge = createPageChannel({
    context: Object.freeze({ self: window, url: location.href, callers }),
    connect: () => api.runtime.connect({ name: BRIDGE_PORT_NAME }),
    postToPage(message, targetOrigin) {
      window.postMessage(message, targetOrigin);
    },
  });
  window.addEventListener("message", (event) => {
    bridge.receive({ data: event.data, origin: event.origin, source: event.source });
  });
  installCompanionContentBridge({
    runtime: api.runtime,
    self: window,
    documentUrl: location.href,
    callers,
  });
}
