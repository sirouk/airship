import type { Api, Model, SimpleStreamOptions, StreamOptions, ThinkingBudgets, ThinkingLevel } from "../types";

/** Port of prime-agent packages/ai/src/providers/simple-options.ts. */

export function buildBaseOptions(model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string): StreamOptions {
  return {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32000) : undefined),
    signal: options?.signal,
    apiKey: apiKey || options?.apiKey,
    transport: options?.transport,
    serviceTier: options?.serviceTier,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    timeoutMs: options?.timeoutMs,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
  };
}

export function clampReasoning(effort: ThinkingLevel): Exclude<ThinkingLevel, "xhigh" | "max">;
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined;
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
  // Token-budget providers have no distinct xhigh/max budget tier; clamp both to high.
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

export function adjustMaxTokensForThinking(
  baseMaxTokens: number,
  modelMaxTokens: number,
  reasoningLevel: ThinkingLevel,
  customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  const budgets: Record<Exclude<ThinkingLevel, "xhigh" | "max">, number> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    ...customBudgets,
  };

  const minOutputTokens = 1024;
  const level = clampReasoning(reasoningLevel);
  let thinkingBudget = budgets[level];
  const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }

  return { maxTokens, thinkingBudget };
}
