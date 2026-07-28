/**
 * Page side of the optional browser-extension bridge. Importing this module is
 * not a claim that an extension exists: only `ExtensionBridgeClient.handshake`
 * can answer that, live, per page load.
 */
export {
  ExtensionBridgeClient,
  absenceDetail,
  pageBridgeChannel,
  pageExtensionBridge,
  resetPageExtensionBridge,
  type BridgeFetchRequest,
  type BridgeMessageChannel,
  type BridgeMessageEventLike,
  type ExtensionBridgeClientOptions,
} from "./client";
export {
  createExtensionBridgeOAuthTransport,
  bridgeProviderOfUrl,
  type ExtensionBridgeOAuthTransport,
  type ExtensionBridgeOAuthTransportOptions,
} from "./oauth-transport";
export {
  ANTHROPIC_OAUTH_INFERENCE_HEADERS,
  BRIDGE_DESTINATIONS,
  BRIDGE_HEADER_ALLOWLIST,
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_PROVIDER_IDS,
  ExtensionBridgeError,
  bridgeReplyId,
  bridgeRequestHeaders,
  isBridgeDestination,
  parseBridgeReply,
  type BridgeHandshakeResult,
  type BridgeLimits,
  type BridgeProviderId,
  type BridgeReply,
  type BridgeRequestMessage,
  type BridgeRequestMethod,
  type ExtensionBridgeErrorCode,
} from "./protocol";
