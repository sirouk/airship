/**
 * The `User-Agent` override, and the honest report of whether it exists.
 *
 * `User-Agent` is a forbidden header name: neither the page nor this worker's
 * `fetch` can set it. The only mechanisms a browser offers an extension are a
 * declarativeNetRequest header rewrite (Chromium) or a blocking webRequest
 * listener (Firefox). Safari offers neither. This module tries each, verifies
 * the result where the platform allows verification, and reports `live` only
 * when it observed the rule in place — never because the API existed.
 */

import {
  BRIDGE_DESTINATIONS,
  type BridgeDestination,
  type UserAgentOverrideState,
  destinationRequiresUserAgentOverride,
} from "./policy";

/** Session rule ids the extension owns. Fixed so a reinstall replaces them. */
export const USER_AGENT_RULE_ID_BASE = 8_100;

export type DeclarativeNetRequestRule = Readonly<{
  id: number;
  priority: number;
  action: Readonly<{
    type: "modifyHeaders";
    requestHeaders: readonly Readonly<{ header: string; operation: "set"; value: string }>[];
  }>;
  condition: Readonly<{
    urlFilter: string;
    resourceTypes: readonly string[];
    /** `-1` is "not a tab": only this worker's own requests are rewritten. */
    tabIds: readonly number[];
  }>;
}>;

/** Destinations whose measured behaviour requires a non-browser user agent. */
export function overrideDestinations(
  destinations: readonly BridgeDestination[] = BRIDGE_DESTINATIONS,
): readonly BridgeDestination[] {
  return Object.freeze(destinations.filter(destinationRequiresUserAgentOverride));
}

/**
 * One rule per destination, each carrying that destination's own agent: a
 * rewrite rule matches a URL rather than a request, so the value cannot come
 * from the caller. The two Anthropic agents differ — the token host was
 * measured to reject browser agents, and the OAuth inference path is served to
 * the Claude Code fingerprint.
 */
export function userAgentRules(
  destinations: readonly BridgeDestination[] = BRIDGE_DESTINATIONS,
): readonly DeclarativeNetRequestRule[] {
  return Object.freeze(overrideDestinations(destinations).map((destination, index) =>
    Object.freeze({
      id: USER_AGENT_RULE_ID_BASE + index,
      priority: 1,
      action: Object.freeze({
        type: "modifyHeaders" as const,
        requestHeaders: Object.freeze([
          Object.freeze({
            header: "user-agent",
            operation: "set" as const,
            value: destination.userAgent ?? "",
          }),
        ]),
      }),
      // `|` anchors the filter at the start of the URL, so the rule cannot
      // match a destination that merely contains the prefix.
      condition: Object.freeze({
        urlFilter: `|${destination.prefix}`,
        resourceTypes: Object.freeze(["xmlhttprequest"]),
        tabIds: Object.freeze([-1]),
      }),
    })
  ));
}

/**
 * A rule as the browser reads it back. Everything is optional because this is
 * the browser's word, not ours: a field the browser dropped must be visible as
 * missing rather than assumed to match.
 */
export type SessionRuleView = Readonly<{
  id: number;
  action?: Readonly<{
    type?: string;
    requestHeaders?: readonly Readonly<{
      header?: string;
      operation?: string;
      value?: string;
    }>[];
  }>;
}>;

export type DeclarativeNetRequestApi = Readonly<{
  updateSessionRules(options: Readonly<{
    addRules: readonly DeclarativeNetRequestRule[];
    removeRuleIds: readonly number[];
  }>): Promise<void>;
  getSessionRules(): Promise<readonly SessionRuleView[]>;
}>;

export type WebRequestHeader = { name: string; value?: string };

export type WebRequestDetails = Readonly<{
  url: string;
  tabId: number;
  requestHeaders?: readonly WebRequestHeader[];
}>;

export type WebRequestListener =
  (details: WebRequestDetails) => { requestHeaders: WebRequestHeader[] } | undefined;

export type WebRequestApi = Readonly<{
  onBeforeSendHeaders: Readonly<{
    addListener(
      listener: WebRequestListener,
      filter: Readonly<{ urls: readonly string[]; types?: readonly string[] }>,
      extra: readonly string[],
    ): void;
    /** Optional: not every engine exposes it, so it is read back only if present. */
    hasListener?(listener: WebRequestListener): boolean;
    /** Optional for the same reason; a replacement is only honest if it removes. */
    removeListener?(listener: WebRequestListener): void;
  }>;
}>;

export type OverrideHost = Readonly<{
  declarativeNetRequest?: DeclarativeNetRequestApi;
  webRequest?: WebRequestApi;
}>;

/**
 * The blocking-webRequest listener body, as a pure function.
 *
 * It rewrites nothing but this worker's own requests (`tabId === -1`) to a
 * destination that requires the override, so installing the extension never
 * changes the user agent of anything the user browses.
 */
export function applyUserAgentHeader(
  details: WebRequestDetails,
  destinations: readonly BridgeDestination[] = BRIDGE_DESTINATIONS,
): { requestHeaders: WebRequestHeader[] } | undefined {
  if (details.tabId !== -1) return undefined;
  const matched = overrideDestinations(destinations)
    .find((destination) => details.url.startsWith(destination.prefix));
  if (!matched?.userAgent) return undefined;
  const headers = (details.requestHeaders ?? [])
    .filter((header) => header.name.toLowerCase() !== "user-agent")
    .map((header) => ({ name: header.name, value: header.value }));
  headers.push({ name: "User-Agent", value: matched.userAgent });
  return { requestHeaders: headers };
}

/**
 * Did the browser read this rule back *with its rewrite intact*?
 *
 * Matching on the id and `action.type` alone would accept a browser that stored
 * the rule and dropped the header modification — the rule would read back and
 * the header would never be rewritten, which is the one failure mode that turns
 * an honest `unavailable` into a false claim of Anthropic support.
 */
function ruleReadsBack(
  rule: DeclarativeNetRequestRule,
  installed: readonly SessionRuleView[],
): boolean {
  const wanted = rule.action.requestHeaders[0];
  if (!wanted) return false;
  return installed.some((candidate) =>
    candidate.id === rule.id
    && candidate.action?.type === "modifyHeaders"
    && (candidate.action.requestHeaders ?? []).some((header) =>
      header.header?.toLowerCase() === wanted.header
      && header.operation === wanted.operation
      && header.value === wanted.value));
}

/**
 * The blocking listener this module attached, and what it was built for.
 *
 * `installUserAgentOverride` describes a desired state and is called again on
 * every capability re-observation. The declarativeNetRequest branch is already
 * idempotent — `updateSessionRules` removes the same ids it adds — but
 * `addListener` is additive, so without this reference each re-observation
 * stacked another blocking rewriter on the same requests, unremovable because
 * nothing held the previous function. The event surface is part of the identity
 * so a different host (a fresh worker, or a test) is a fresh install rather
 * than a `removeListener` aimed at somebody else's API.
 */
let installedWebRequest: { events: WebRequestApi["onBeforeSendHeaders"]; listener: WebRequestListener; signature: string } | undefined;

/**
 * Install the override and report what actually happened.
 *
 * The two mechanisms give evidence of different strength, and `live` is the
 * strongest word this function has, so the difference is stated rather than
 * flattened:
 *
 * - Chromium: the rules are read back after writing, and the read-back must
 *   still carry the exact header rewrite. That is an observation.
 * - Firefox: the blocking listener is registered, and read back with
 *   `hasListener` where the engine offers it. Registration is weaker evidence —
 *   it says the listener is attached, not that the engine will let it rewrite.
 *
 * Neither proves the *vendor* received the rewritten agent; only the vendor's
 * reply can show that, and the relay surfaces that reply verbatim. What both
 * rule out is the case that matters here: claiming Anthropic on a browser with
 * no rewrite mechanism at all, where `unavailable` is the honest answer.
 */
export async function installUserAgentOverride(
  host: OverrideHost | undefined,
  destinations: readonly BridgeDestination[] = BRIDGE_DESTINATIONS,
): Promise<UserAgentOverrideState> {
  const rules = userAgentRules(destinations);
  if (rules.length === 0) return "live";
  const dnr = host?.declarativeNetRequest;
  if (dnr) {
    try {
      await dnr.updateSessionRules({
        addRules: rules,
        removeRuleIds: rules.map((rule) => rule.id),
      });
      const installed = await dnr.getSessionRules();
      if (rules.every((rule) => ruleReadsBack(rule, installed))) return "live";
    } catch {
      // Firefox exposes declarativeNetRequest without `modifyHeaders`, so a
      // rejection here is expected and simply moves on to the next mechanism.
    }
  }
  const webRequest = host?.webRequest;
  if (webRequest) {
    try {
      const events = webRequest.onBeforeSendHeaders;
      const attached = events.hasListener;
      // Where the engine can be asked, ask: an `addListener` that returned
      // without attaching anything must not read as a live override. Asking
      // about the *retained* listener keeps this an observation rather than a
      // tautology about the object we just created.
      const isAttached = (candidate: WebRequestListener): boolean =>
        typeof attached !== "function" || attached.call(events, candidate);
      const wanted = destinationSignature(destinations);
      if (installedWebRequest && installedWebRequest.events === events) {
        // Same event surface, same destinations: this is a re-observation, not
        // a first install, and adding a second listener for the same requests
        // would leave a rewriter nobody holds a reference to.
        if (installedWebRequest.signature === wanted && isAttached(installedWebRequest.listener)) return "live";
        events.removeListener?.(installedWebRequest.listener);
        installedWebRequest = undefined;
      }
      const listener: WebRequestListener = (details) => applyUserAgentHeader(details, destinations);
      events.addListener(
        listener,
        {
          urls: overrideDestinations(destinations).map((destination) => `${destination.prefix}*`),
          types: ["xmlhttprequest"],
        },
        ["blocking", "requestHeaders"],
      );
      if (isAttached(listener)) {
        installedWebRequest = { events, listener, signature: wanted };
        return "live";
      }
    } catch {
      // Chromium MV3 rejects blocking listeners outright.
    }
  }
  return "unavailable";
}

/** Identity of the rewrite the retained listener performs, prefix and agent. */
function destinationSignature(destinations: readonly BridgeDestination[]): string {
  return overrideDestinations(destinations)
    .map((destination) => `${destination.prefix} ${destination.userAgent ?? ""}`)
    .join("");
}
