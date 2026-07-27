/**
 * The browser-extension bridge as a capability observation.
 *
 * Presence is a live `hello` exchange per page load and nothing else. It is
 * never inferred from a user agent, never read from storage, and never carried
 * across a reload — an extension can be installed, disabled, or removed between
 * one load and the next, so a remembered "present" would be a claim this page
 * did not make. The record carries the version the extension itself returned,
 * so a surface can name it rather than describing an extension in general.
 *
 * The bridge client does keep a short-lived positive presence memo to gate
 * *requests* (`presenceTtlMs`, src/inference/bridge/client.ts). Nothing in this
 * module reads it: `probeExtensionBridge` runs `handshake()`, which always
 * performs a live exchange and refreshes that memo rather than consulting it.
 * That separation is deliberate — a capability record is a statement about now,
 * so it must not be answerable from a value up to thirty seconds old.
 */
import type {
  BridgeHandshakeResult,
  BridgeProviderId,
  BridgeProviderUnavailability,
} from "../inference/bridge/protocol";
import type {
  BrowserCapabilityObservation,
  BrowserCapabilityPromptEntry,
} from "./browser-runtime";
import type {
  CompanionCapabilities,
  CompanionHandshakeResult,
} from "../inference/bridge/companion-client";

export type ExtensionBridgeObservation = BrowserCapabilityObservation & Readonly<{
  /** Exactly what the extension answered with; absent when nothing answered. */
  extensionVersion?: string;
  /** Providers the extension said it will carry, not providers Airship wants. */
  providers: readonly BridgeProviderId[];
  /** Causes the extension itself named for the providers it will not carry. */
  unavailable: readonly BridgeProviderUnavailability[];
  /** Round trip of the handshake that produced an `available` record. */
  handshakeMs?: number;
  /** Optional services reported by the same installed extension, live now. */
  companion?: CompanionCapabilities;
}>;

/**
 * Map one handshake outcome onto the same state/evidence/detail shape the
 * browser runtime probes use. A silent bridge is `unavailable`/`not-observed`;
 * a bridge that answered with something the protocol rejects is `failed`,
 * because that is a bridge which is present and unusable, not an absent one.
 */
export function extensionBridgeObservation(
  result: BridgeHandshakeResult,
): ExtensionBridgeObservation {
  if (result.kind === "answered") {
    const refusals = result.unavailable
      .map((entry) => `${entry.provider} is not carried (${entry.reason})`)
      .join("; ");
    return Object.freeze({
      state: "available" as const,
      evidence: "probe-passed" as const,
      detail: `Airship browser extension ${result.version} answered the bridge handshake and declares ${
        result.providers.length > 0 ? result.providers.join(", ") : "no providers"
      }.${refusals ? ` ${refusals}.` : ""} Reachability only: the bridge creates no attestation or trust claim.`,
      extensionVersion: result.version,
      providers: Object.freeze([...result.providers]),
      unavailable: Object.freeze([...result.unavailable]),
      handshakeMs: result.elapsedMs,
    });
  }
  if (result.kind === "silent") {
    return Object.freeze({
      state: "unavailable" as const,
      evidence: "not-observed" as const,
      detail: `No browser extension answered the bridge handshake within ${String(result.deadlineMs)} ms. Anthropic and xAI OAuth stay unavailable; API keys and every other provider are unaffected.`,
      providers: Object.freeze([]),
      unavailable: Object.freeze([]),
    });
  }
  if (result.kind === "unsupported") {
    return Object.freeze({
      state: "unavailable" as const,
      evidence: "not-observed" as const,
      detail: `No extension bridge handshake could be sent: ${result.detail}.`,
      providers: Object.freeze([]),
      unavailable: Object.freeze([]),
    });
  }
  return Object.freeze({
    state: "failed" as const,
    evidence: "probe-failed" as const,
    detail: `A bridge handshake reply was rejected: ${result.detail}`,
    providers: Object.freeze([]),
    unavailable: Object.freeze([]),
  });
}

/**
 * Observe the bridge now. The default probe loads the bridge client lazily so a
 * page that never reaches a bridged provider never pays for the client, and
 * returns an honest `silent` result where no relay can exist at all.
 */
export async function probeExtensionBridge(
  handshake: () => Promise<BridgeHandshakeResult> = defaultHandshake,
  companionHandshake: () => Promise<CompanionHandshakeResult> = defaultCompanionHandshake,
): Promise<ExtensionBridgeObservation> {
  try {
    const observation = extensionBridgeObservation(await handshake());
    if (observation.state !== "available") return observation;
    const companion = await companionHandshake();
    if (companion.kind !== "answered") return observation;
    const storage = companion.capabilities.storage;
    const compute = companion.capabilities.compute;
    return Object.freeze({
      ...observation,
      companion: companion.capabilities,
      detail: `${observation.detail} Companion services: encrypted cache ${
        storage.state === "available" ? (storage.enabled ? "enabled" : "available but off") : "unavailable"
      }; background compute ${compute.state === "available" ? "available" : "unavailable"}.`,
    });
  } catch (error) {
    return Object.freeze({
      state: "failed" as const,
      evidence: "probe-failed" as const,
      detail: `The extension bridge handshake failed (${errorName(error)}).`,
      providers: Object.freeze([]),
      unavailable: Object.freeze([]),
    });
  }
}

/**
 * Session-prompt entries, following the browser-runtime convention that only
 * observed capabilities are stated. An absent bridge adds nothing here; the
 * providers it would have carried report their own unavailability at the point
 * of use, where the cause can be named.
 */
export function extensionBridgePromptEntries(
  observation: ExtensionBridgeObservation,
): readonly BrowserCapabilityPromptEntry[] {
  if (observation.state !== "available") return Object.freeze([]);
  return Object.freeze([Object.freeze({
    id: "extension-bridge",
    evidence: "probe-passed" as const,
    detail: observation.detail,
  })]);
}

async function defaultHandshake(): Promise<BridgeHandshakeResult> {
  const { pageExtensionBridge } = await import("../inference/bridge/client");
  const client = pageExtensionBridge();
  if (!client) {
    return Object.freeze({
      kind: "unsupported" as const,
      detail: "this runtime has no page window to relay one through",
    });
  }
  return client.handshake();
}

async function defaultCompanionHandshake(): Promise<CompanionHandshakeResult> {
  const { pageCompanionClient } = await import("../inference/bridge/companion-client");
  const client = pageCompanionClient();
  if (!client) {
    return Object.freeze({
      kind: "unsupported" as const,
      detail: "this runtime has no page window to relay one through",
    });
  }
  return client.handshake();
}

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z]{1,48}$/u.test(name) ? name : "Error";
}
