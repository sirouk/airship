/**
 * Background worker entry.
 *
 * This file supplies the platform — `fetch`, timers, the extension APIs — and
 * nothing else. Every decision lives in the pure modules it wires together, so
 * the boundary is testable without a browser and this entry stays small enough
 * to read in one sitting.
 */

import {
  BRIDGE_PORT_NAME,
  type BridgeRuntimeCapabilities,
  type HostAccessState,
  RELEASE_CALLERS,
  checkSender,
  destinationMatchPatterns,
  developmentCallers,
} from "./policy";
import { type BridgeClock, type RelayFetch, createBridgeRelay } from "./relay";
import { installUserAgentOverride } from "./user-agent";
import { type WebExtensionApi, resolveExtensionApi } from "./webextension";

declare const __AIRSHIP_BRIDGE_CHANNEL__: string;

// The channel is a build-time define, so this ternary folds to one branch and
// a release artifact does not carry the development origins at all.
const callers = __AIRSHIP_BRIDGE_CHANNEL__ === "development" ? developmentCallers() : RELEASE_CALLERS;
const api: WebExtensionApi | undefined = resolveExtensionApi(globalThis as unknown as Record<string, unknown>);

/**
 * Capabilities are re-observed rather than assumed, but not on every request:
 * Firefox can grant host access while the worker is already running, and a
 * bounded cache keeps that observable without re-installing rules per call.
 */
const CAPABILITY_TTL_MS = 30_000;
let observed: Readonly<{ at: number; value: Promise<BridgeRuntimeCapabilities> }> | undefined;

async function observeHostAccess(): Promise<HostAccessState> {
  if (!api?.permissions) return "unknown";
  try {
    const granted = await api.permissions.contains({ origins: [...destinationMatchPatterns()] });
    return granted ? "granted" : "missing";
  } catch {
    return "unknown";
  }
}

async function observeCapabilities(): Promise<BridgeRuntimeCapabilities> {
  const hostAccess = await observeHostAccess();
  // A header-rewrite rule cannot apply to a host the extension may not touch,
  // so a missing grant is reported as no override rather than an untried one.
  const userAgentOverride = hostAccess === "missing"
    ? "unavailable"
    : await installUserAgentOverride(api);
  return Object.freeze({ hostAccess, userAgentOverride });
}

function resolveCapabilities(): Promise<BridgeRuntimeCapabilities> {
  const now = Date.now();
  if (!observed || now - observed.at > CAPABILITY_TTL_MS) {
    observed = Object.freeze({ at: now, value: observeCapabilities() });
  }
  return observed.value;
}

const clock: BridgeClock = Object.freeze({
  now: () => Date.now(),
  setTimer(delayMs: number, fn: () => void) {
    const timer = setTimeout(fn, delayMs);
    return () => clearTimeout(timer);
  },
});

const relayFetch: RelayFetch = (url, init) => fetch(url, init);

api?.runtime.onConnect.addListener((port) => {
  if (port.name !== BRIDGE_PORT_NAME) {
    port.disconnect();
    return;
  }
  // The content-script registration says where the code runs; this says who
  // the worker will answer. Both are required.
  const sender = checkSender(port.sender, callers);
  if (!sender.ok) {
    port.disconnect();
    return;
  }
  const relay = createBridgeRelay({
    fetchImpl: relayFetch,
    clock,
    resolveCapabilities,
    send(message) {
      try {
        port.postMessage(message);
      } catch {
        // The page navigated away mid-request. There is no channel left to
        // report the failure on; `onDisconnect` releases the request.
      }
    },
  });
  port.onMessage.addListener((message) => {
    void relay.handle(message);
  });
  port.onDisconnect.addListener(() => {
    relay.dispose();
  });
});
