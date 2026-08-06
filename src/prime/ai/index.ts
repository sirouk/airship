/**
 * Public surface of the ported prime-agent model/streaming core.
 * Mirrors packages/ai/src/index.ts, minus host-only surfaces (oauth flows,
 * env api keys, the generated model catalog, mcp, diagnostics logging).
 */

export * from "./types";
export {
  EventStream,
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "./event-stream";
export {
  stream,
  complete,
  streamSimple,
  completeSimple,
  streamLazy,
  pushStreamError,
  emptyUsage,
} from "./stream";
export {
  registerApiProvider,
  unregisterApiProviders,
  registerApiProviderLoader,
  getApiProvider,
  resolveApiProvider,
  hasApiProvider,
  registeredApis,
} from "./registry";
export { repairJson, parseJsonWithRepair, parsePartialJson, parseStreamingJson } from "./stream-json";
export { sanitizeSurrogates } from "./sanitize";
export { isContextOverflow, getOverflowPatterns } from "./overflow";
export { shortHash, sha256Hex, hmacSha256Hex } from "./hash";
export { validateJson, deepEqual, isPlainObject } from "./validate";
export type { ValidationResult } from "./validate";
export {
  getAnthropicCacheCosts,
  getAnthropicCacheWriteCost,
  hasStandardAnthropicCachePricing,
  usageCost,
} from "./cost";
export type { AnthropicCacheCreationUsage, AnthropicCacheDuration } from "./cost";
export { SseParser, sseRecords } from "./sse";
export type { SseRecord } from "./sse";
