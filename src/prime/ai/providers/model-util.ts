import type { Api, Model, ModelThinkingLevel, Usage } from "../types";

/**
 * Port of the model-dependent thinking-level and cost arithmetic from
 * prime-agent packages/ai/src/models.ts (the generated model catalog around
 * these helpers is not ported — model discovery belongs to the host).
 */

const EXTENDED_THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
  if (!model.reasoning) return ["off"];

  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * Clamp a requested thinking level to what the model supports. xhigh on a
 * max-only model resolves to max rather than producing an invalid payload;
 * callers that bypass clamping and send effort verbatim get 400s (upstream
 * bug the mapping exists to prevent).
 */
export function clampThinkingLevel<TApi extends Api>(model: Model<TApi>, level: ModelThinkingLevel): ModelThinkingLevel {
  const availableLevels = getSupportedThinkingLevels(model);
  if (availableLevels.includes(level)) return level;

  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) return availableLevels[0] ?? "off";

  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
  }
  return availableLevels[0] ?? "off";
}

export interface UsageCostOverrides {
  /**
   * $/MTok rate for cache writes, replacing model.cost.cacheWrite. Anthropic
   * cache writes price differently by effective TTL (5m = 1.25x input, 1h =
   * 2x input) and the usage event reveals the actual split.
   */
  cacheWrite?: number;
}

/**
 * Upstream calculateCost: computes the Usage.cost block from model.cost
 * ($/MTok), mutating usage in place because providers call it at multiple
 * points of a stream (message_start and message_delta for Anthropic).
 */
export function applyUsageCost<TApi extends Api>(
  model: Model<TApi>,
  usage: Usage,
  overrides?: UsageCostOverrides,
): Usage["cost"] {
  usage.cost.input = (model.cost.input / 1000000) * usage.input;
  usage.cost.output = (model.cost.output / 1000000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
  usage.cost.cacheWrite = ((overrides?.cacheWrite ?? model.cost.cacheWrite) / 1000000) * usage.cacheWrite;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}
