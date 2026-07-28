import { type BridgeChannel, type CallerOrigin, checkCallerUrl } from "./policy";

export type CurrentTabDiagnostic = Readonly<{
  state: "allowlisted" | "not-allowlisted" | "unavailable";
  label: string;
  origin: string;
}>;

export type PopupChannelDiagnostic = Readonly<{
  channel: BridgeChannel;
  label: "Development" | "Release";
  callerRules: readonly string[];
  connectionUrl: string;
}>;

/**
 * Describe the immutable boundary compiled into this exact extension build.
 *
 * This is intentionally independent of companion cache/compute availability:
 * an extension-owned IndexedDB database can be healthy while the current page
 * is outside the content-script allowlist.
 */
export function describePopupChannel(
  channel: BridgeChannel,
  callers: readonly CallerOrigin[],
): PopupChannelDiagnostic {
  const first = callers[0];
  const connectionUrl = channel === "development"
    ? "http://localhost:4173/#connection"
    : first
      ? `${first.origin}${first.pathPrefix}#connection`
      : "";
  return Object.freeze({
    channel,
    label: channel === "development" ? "Development" : "Release",
    callerRules: Object.freeze(callers.map(formatCallerRule)),
    connectionUrl,
  });
}

/**
 * Inspect only the active tab URL exposed by the narrowly scoped `activeTab`
 * grant created when the user opens the popup. "Allowlisted" means the build
 * is permitted to inject there; it deliberately does not claim a live relay.
 */
export function diagnoseCurrentTab(
  rawUrl: string | undefined,
  callers: readonly CallerOrigin[],
): CurrentTabDiagnostic {
  if (!rawUrl) {
    return Object.freeze({
      state: "unavailable",
      label: "Current tab address is not available",
      origin: "Not exposed by this browser",
    });
  }
  const origin = displayOrigin(rawUrl);
  const caller = checkCallerUrl(rawUrl, callers);
  return caller.ok
    ? Object.freeze({
      state: "allowlisted",
      label: "Current tab is in this build's caller allowlist",
      origin,
    })
    : Object.freeze({
      state: "not-allowlisted",
      label: "Current tab is outside this build's caller allowlist",
      origin,
    });
}

function formatCallerRule(caller: CallerOrigin): string {
  return `${caller.origin}${caller.pathPrefix}`;
}

function displayOrigin(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin === "null"
      ? `${parsed.protocol}${parsed.host ? `//${parsed.host}` : ""}`
      : parsed.origin;
  } catch {
    return "Unparseable tab address";
  }
}
