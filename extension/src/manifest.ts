/**
 * One source tree, three manifests.
 *
 * The match patterns are generated from the same compiled-in allowlists the
 * background worker enforces, so the set of pages that can reach the extension
 * and the set of hosts it may fetch cannot drift from the code that checks
 * them. `externally_connectable` is deliberately absent: it is Chromium-only,
 * and a content script plus `postMessage` is the one shape that works on
 * Chromium, Firefox and Safari alike.
 */

import {
  BRIDGE_DESTINATIONS,
  type BridgeChannel,
  type BridgeDestination,
  EXTENSION_VERSION,
  callerAllowlist,
  callerMatchPatterns,
  destinationMatchPatterns,
} from "./policy";

export type ExtensionTarget = "chromium" | "firefox" | "safari";

export const EXTENSION_TARGETS: readonly ExtensionTarget[] = Object.freeze([
  "chromium",
  "firefox",
  "safari",
]);

export const EXTENSION_NAME = "Airship Bridge";
export const GECKO_EXTENSION_ID = "airship-bridge@airship.chutes.ai";

/**
 * Oldest engine each target is built and declared for. The values match
 * `SYNTAX_TARGETS` in `build.mjs`, so a manifest cannot claim to run somewhere
 * the bundle's syntax would not parse.
 *
 * - Firefox 128 is the first ESR with MV3 event pages and `webRequestBlocking`
 *   available to an MV3 extension.
 * - Safari 16.4 is the first release with a usable MV3 implementation; it is
 *   also where `browser_specific_settings.safari` is honoured.
 */
export const FIREFOX_MIN_VERSION = "128.0";
export const SAFARI_MIN_VERSION = "16.4";

const DESCRIPTION = "Relays only Airship's xAI and Anthropic OAuth and inference calls, from"
  + " airship pages only, with no stored credentials.";

export function buildManifest(
  target: ExtensionTarget,
  channel: BridgeChannel,
  destinations: readonly BridgeDestination[] = BRIDGE_DESTINATIONS,
): Readonly<Record<string, unknown>> {
  const common = {
    manifest_version: 3,
    name: channel === "development" ? `${EXTENSION_NAME} (development)` : EXTENSION_NAME,
    version: EXTENSION_VERSION,
    description: DESCRIPTION,
    content_scripts: [
      {
        matches: [...callerMatchPatterns(callerAllowlist(channel))],
        js: ["content-script.js"],
        run_at: "document_start",
        // The bridge is for the Airship document itself. A subframe of an
        // Airship page is a different document and gets no relay.
        all_frames: false,
      },
    ],
    host_permissions: [...destinationMatchPatterns(destinations)],
  };

  if (target === "firefox") {
    return Object.freeze({
      ...common,
      // Firefox MV3 runs a non-persistent event page rather than a service
      // worker. `persistent` is not a valid MV3 key in Gecko — an event page is
      // non-persistent by definition — so it is deliberately absent here and
      // present for Safari, where the key is both accepted and required.
      background: { scripts: ["background.js"] },
      // Firefox's declarativeNetRequest has no header rewriting, so the
      // `User-Agent` override needs a blocking webRequest listener, which
      // Firefox — unlike Chromium — still supports under MV3.
      permissions: ["webRequest", "webRequestBlocking"],
      browser_specific_settings: {
        gecko: { id: GECKO_EXTENSION_ID, strict_min_version: FIREFOX_MIN_VERSION },
      },
    });
  }

  if (target === "safari") {
    // Safari has neither declarativeNetRequest header rewriting nor blocking
    // webRequest, so it is offered no rewrite permission and the worker will
    // observe no `User-Agent` override and report Anthropic as unavailable.
    // xAI needs no override and works. That report is still made from what the
    // worker observed at runtime — this manifest withholds a mechanism, it does
    // not pre-decide the answer from the browser's name.
    return Object.freeze({
      ...common,
      // A non-persistent background page, not a service worker. Safari's
      // service-worker backing is the newer and less predictable of the two —
      // notably on iOS, where the extension shares the host app's lifetime —
      // and the relay is already written to hold no state across a wake.
      background: { scripts: ["background.js"], persistent: false },
      browser_specific_settings: {
        safari: { strict_min_version: SAFARI_MIN_VERSION },
      },
    });
  }

  return Object.freeze({
    ...common,
    background: { service_worker: "background.js" },
    // `declarativeNetRequestWithHostAccess` scopes rules to hosts the user
    // already granted, rather than asking for the broader rule permission.
    permissions: ["declarativeNetRequestWithHostAccess"],
    // The first Chromium with stable MV3 session-rule support this relies on.
    minimum_chrome_version: "116",
  });
}
