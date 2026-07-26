/**
 * What the connect surface is allowed to say about the browser extension.
 *
 * Two facts drive every Claude/Grok state, and they are different in kind:
 *
 * 1. **Is the bridge answering right now.** That is a live per-page-load
 *    observation, and this module deliberately owns no record of its own: the
 *    authoritative one is `ExtensionBridgeObservation` from
 *    `src/capabilities/extension-bridge`, produced by `probeExtensionBridge`
 *    from a real `hello` exchange. A second, restated copy of that shape is
 *    exactly how a surface drifts into rendering a state nothing ever
 *    produced, so there is none — only the readers below. `undefined` means
 *    the probe for this page load has not settled yet; there is no "last
 *    known" arm, so a stale value cannot be represented, let alone rendered.
 * 2. **Could this browser host an extension at all.** The only evidence a page
 *    has is the browser's own self-report, so the record says exactly that and
 *    the copy is written as a report rather than a verdict about the person's
 *    setup.
 */

import type { ExtensionBridgeObservation } from "../../capabilities/extension-bridge";
import type { BridgeProviderId } from "../../inference/bridge/protocol";

/*
 * Both imports are type-only and erase at build time, so naming the bridge
 * here adds no module edge: a page with no bridge client still renders this
 * surface, and `absent` stays reachable without one.
 */
export type { ExtensionBridgeObservation };

export type ExtensionBridgeProviderId = BridgeProviderId;

export type HostExtensionSupport =
  | Readonly<{ kind: "installable"; evidence: "browser-self-report" }>
  | Readonly<{ kind: "cannot-host"; reason: string; evidence: "browser-self-report" }>
  | Readonly<{ kind: "not-published"; reason: string; evidence: "browser-self-report" }>;

const IOS_FAMILY = /iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS/u;
const ANDROID = /Android/u;
const ANDROID_GECKO = /Firefox|Fennec/u;

/**
 * Classifies the running browser from its own user-agent string.
 *
 * Deliberately conservative: only the two families that are documented to be
 * unable to run this extension are named, and everything else is `installable`
 * — which the surface renders as "add the extension", not as "the extension is
 * present". A wrong guess here can only cost an extra sentence, never a claim.
 */
export function observeHostExtensionSupport(userAgent: string): HostExtensionSupport {
  if (IOS_FAMILY.test(userAgent)) {
    return Object.freeze({
      kind: "not-published" as const,
      reason: "This browser reports itself as iOS or iPadOS, where an extension has to ship as an App Store app. Airship does not publish one yet.",
      evidence: "browser-self-report" as const,
    });
  }
  if (ANDROID.test(userAgent) && !ANDROID_GECKO.test(userAgent)) {
    return Object.freeze({
      kind: "cannot-host" as const,
      reason: "This browser reports itself as Chrome on Android, which cannot install extensions at all. Firefox for Android can.",
      evidence: "browser-self-report" as const,
    });
  }
  return Object.freeze({ kind: "installable" as const, evidence: "browser-self-report" as const });
}

/**
 * Whether the bridge will carry a specific provider, right now.
 *
 * Presence of the extension is not presence of a provider: an older build may
 * answer `hello` while carrying a smaller set, and claiming otherwise would let
 * the surface promise a route the extension refuses. An unsettled observation
 * carries nothing, because nothing has answered yet.
 */
export function bridgeCarriesProvider(
  observation: ExtensionBridgeObservation | undefined,
  provider: ExtensionBridgeProviderId,
): boolean {
  return observation?.state === "available" && observation.providers.includes(provider);
}

/**
 * The cause the extension itself named for a provider it will not carry.
 *
 * Only the extension knows why — a missing header-rewrite mechanism, a
 * permission the person has not granted yet — so an absent cause stays absent
 * rather than being replaced by a guess.
 */
export function bridgeRefusalReason(
  observation: ExtensionBridgeObservation | undefined,
  provider: ExtensionBridgeProviderId,
): string | undefined {
  return observation?.unavailable.find((entry) => entry.provider === provider)?.reason;
}

/** The one sentence the surface may print about the bridge itself. */
export function bridgeSummary(observation: ExtensionBridgeObservation | undefined): string {
  return observation?.detail ?? "Checking whether the Airship extension is answering in this tab.";
}
