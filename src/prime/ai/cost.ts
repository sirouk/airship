import type { Api, Model } from "./types";

/** Port of prime-agent packages/ai/src/cache-pricing.ts. */

export type AnthropicCacheDuration = "5m" | "1h";

export interface AnthropicCacheCreationUsage {
  ephemeral_5m_input_tokens: number;
  ephemeral_1h_input_tokens: number;
}

const READ_MULTIPLIER = 0.1;
const FIVE_MINUTE_WRITE_MULTIPLIER = 1.25;
const ONE_HOUR_WRITE_MULTIPLIER = 2;

export function hasStandardAnthropicCachePricing<TApi extends Api>(model: Model<TApi>): boolean {
  const modelId = model.id.toLowerCase();
  const isAnthropicModel =
    model.provider === "anthropic" || modelId.startsWith("anthropic/") || modelId.startsWith("claude-");
  if (!isAnthropicModel) return false;

  const expected = model.cost.input * FIVE_MINUTE_WRITE_MULTIPLIER;
  const tolerance = Number.EPSILON * Math.max(1, model.cost.cacheWrite, expected);
  return Math.abs(model.cost.cacheWrite - expected) <= tolerance;
}

export function getAnthropicCacheCosts(
  inputCost: number,
  duration: AnthropicCacheDuration,
): { cacheRead: number; cacheWrite: number } {
  return {
    cacheRead: inputCost * READ_MULTIPLIER,
    cacheWrite: inputCost * (duration === "1h" ? ONE_HOUR_WRITE_MULTIPLIER : FIVE_MINUTE_WRITE_MULTIPLIER),
  };
}

export function getAnthropicCacheWriteCost(
  inputCost: number,
  duration: AnthropicCacheDuration,
  cacheCreation?: AnthropicCacheCreationUsage | null,
): number {
  if (!cacheCreation) {
    return getAnthropicCacheCosts(inputCost, duration).cacheWrite;
  }
  const fiveMinuteTokens = cacheCreation.ephemeral_5m_input_tokens;
  const oneHourTokens = cacheCreation.ephemeral_1h_input_tokens;
  const totalTokens = fiveMinuteTokens + oneHourTokens;
  if (totalTokens === 0) {
    return getAnthropicCacheCosts(inputCost, duration).cacheWrite;
  }
  return (
    (inputCost * (fiveMinuteTokens * FIVE_MINUTE_WRITE_MULTIPLIER + oneHourTokens * ONE_HOUR_WRITE_MULTIPLIER)) /
    totalTokens
  );
}

/** Compute a Usage.cost block from token counts and the model cost table ($/million tokens). */
export function usageCost(
  model: Pick<Model<Api>, "cost">,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } {
  const input = (usage.input / 1_000_000) * model.cost.input;
  const output = (usage.output / 1_000_000) * model.cost.output;
  const cacheRead = (usage.cacheRead / 1_000_000) * model.cost.cacheRead;
  const cacheWrite = (usage.cacheWrite / 1_000_000) * model.cost.cacheWrite;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
