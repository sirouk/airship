import type { Api, Model } from "../types";

/**
 * Port of prime-agent packages/ai/src/providers/cloudflare.ts with a hard
 * browser boundary: upstream substitutes `{VAR}` placeholders from
 * process.env. There are no environment variables in a browser page, so a
 * placeholder-bearing baseUrl fails closed with a descriptive error instead
 * of silently leaking the template into a request URL. Hosts model
 * Cloudflare accounts by materializing the resolved baseUrl into the model
 * definition.
 */

/** Workers AI direct endpoint. */
export const CLOUDFLARE_WORKERS_AI_BASE_URL =
  "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";

/** AI Gateway Unified API. https://developers.cloudflare.com/ai-gateway/usage/unified-api/ */
export const CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL =
  "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat";

/** AI Gateway → OpenAI passthrough. Used until /compat supports /v1/responses. */
export const CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL =
  "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai";

/** AI Gateway → Anthropic passthrough. */
export const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL =
  "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic";

export function isCloudflareProvider(provider: string): boolean {
  return provider === "cloudflare-workers-ai" || provider === "cloudflare-ai-gateway";
}

/**
 * Fail closed on `{VAR}` placeholders: the browser port cannot resolve them
 * from the environment, and sending a templated URL would leak the template
 * to a proxy. Hosts must ship the resolved baseUrl in the model definition.
 */
export function resolveCloudflareBaseUrl(model: Model<Api>): string {
  const url = model.baseUrl;
  if (!url.includes("{")) return url;
  throw new Error(
    `Cloudflare baseUrl for provider ${model.provider} contains unresolved placeholders; ` +
      "the browser port cannot read environment variables — ship the resolved baseUrl in the model definition.",
  );
}
