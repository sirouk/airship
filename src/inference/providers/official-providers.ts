import { deepFreeze } from "../../core/freeze";
import type {
  InferenceProviderDescriptor,
} from "./contracts";

export type BuiltinLocalProviderId = "ollama" | "lm-studio";

const BROWSER_DIRECT_API_KEY_WARNING = "This screen uses a browser-direct API key. It remains in this tab and is sent to the configured provider endpoint.";

/**
 * Provider declarations intentionally contain no model list. Models are
 * connection-scoped runtime data acquired from each provider's own directory.
 */
export const OPENAI_PROVIDER = provider({
  version: 1,
  id: "openai",
  label: "OpenAI",
  protocol: "openai-responses",
  transportBoundary: "provider-tls",
  baseUrl: "https://api.openai.com/v1/",
  modelsUrl: "https://api.openai.com/v1/models",
  oauth: {
    state: "configuration-required",
    detail: "No account sign-in flow is wired into this static build.",
  },
  authMethods: [{
    id: "openai-api-key",
    kind: "api-key",
    label: "OpenAI API key",
    header: { name: "Authorization", scheme: "bearer" },
    browserUse: "dangerous-user-opt-in",
    warning: BROWSER_DIRECT_API_KEY_WARNING,
  }],
  capabilities: ["invoke", "models:list"],
  documentationUrl: "https://developers.openai.com/api/reference/overview/",
});

export const ANTHROPIC_PROVIDER = provider({
  version: 1,
  id: "anthropic",
  label: "Anthropic",
  protocol: "anthropic-messages",
  transportBoundary: "provider-tls",
  baseUrl: "https://api.anthropic.com/v1/",
  modelsUrl: "https://api.anthropic.com/v1/models",
  oauth: {
    // The optional extension bridge is separate from this API-key route. This
    // descriptor does not configure a public-PKCE registration for the page.
    state: "first-party-only",
    detail: "No public-PKCE registration is configured for Anthropic in this build.",
  },
  authMethods: [{
    id: "anthropic-api-key",
    kind: "api-key",
    label: "Anthropic API key",
    header: { name: "x-api-key", scheme: "raw" },
    browserUse: "dangerous-user-opt-in",
    warning: BROWSER_DIRECT_API_KEY_WARNING,
  }],
  capabilities: ["invoke", "models:list"],
  documentationUrl: "https://platform.claude.com/docs/en/api/",
});

export const XAI_PROVIDER = provider({
  version: 1,
  id: "xai",
  label: "xAI",
  protocol: "openai-responses",
  transportBoundary: "provider-tls",
  baseUrl: "https://api.x.ai/v1/",
  modelsUrl: "https://api.x.ai/v1/language-models",
  oauth: {
    // The optional device flow does not match this public-PKCE field, so this
    // descriptor does not configure OAuth for the page.
    state: "not-documented",
    detail: "No public-PKCE registration is configured for xAI in this build.",
  },
  authMethods: [{
    id: "xai-api-key",
    kind: "api-key",
    label: "xAI API key",
    header: { name: "Authorization", scheme: "bearer" },
    browserUse: "direct-contract-unpublished",
    warning: BROWSER_DIRECT_API_KEY_WARNING,
  }],
  capabilities: ["invoke", "models:list"],
  documentationUrl: "https://docs.x.ai/developers/rest-api-reference/inference",
});

export const CHUTES_PROVIDER = provider({
  version: 1,
  id: "chutes",
  label: "Chutes",
  protocol: "openai-compatible",
  transportBoundary: "provider-tls",
  baseUrl: "https://llm.chutes.ai/v1/",
  modelsUrl: "https://llm.chutes.ai/v1/models",
  oauth: {
    state: "not-documented",
    detail: "No public-PKCE registration is configured for Chutes in this build.",
  },
  authMethods: [{
    id: "chutes-api-key",
    kind: "api-key",
    label: "Chutes API key",
    header: { name: "Authorization", scheme: "bearer" },
    browserUse: "direct-contract-unpublished",
    warning: BROWSER_DIRECT_API_KEY_WARNING,
  }],
  capabilities: ["invoke", "models:list"],
  documentationUrl: "https://chutes.ai/",
});

export const OFFICIAL_CLOUD_PROVIDERS = deepFreeze([
  OPENAI_PROVIDER,
  ANTHROPIC_PROVIDER,
  XAI_PROVIDER,
  CHUTES_PROVIDER,
]) as readonly InferenceProviderDescriptor[];

/**
 * Browser-local services are connection authorities, not Airship backends.
 * Their exact endpoint remains page-memory connection state; this descriptor
 * only declares the configured loopback protocol and authentication contract.
 */
export const OFFICIAL_LOCAL_PROVIDERS = deepFreeze([
  localProvider({
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/",
    modelsUrl: "http://127.0.0.1:11434/api/tags",
    documentationUrl: "https://ollama.com/",
  }),
  localProvider({
    id: "lm-studio",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/",
    modelsUrl: "http://127.0.0.1:1234/api/v1/models",
    documentationUrl: "https://lmstudio.ai/docs/",
  }),
]) as readonly InferenceProviderDescriptor[];

function provider(value: InferenceProviderDescriptor): InferenceProviderDescriptor {
  return deepFreeze(value) as InferenceProviderDescriptor;
}

function localProvider(input: Readonly<{
  id: BuiltinLocalProviderId;
  label: string;
  baseUrl: string;
  modelsUrl: string;
  documentationUrl: string;
}>): InferenceProviderDescriptor {
  return provider({
    version: 1,
    id: input.id,
    label: input.label,
    protocol: "openai-compatible",
    transportBoundary: "loopback-local",
    baseUrl: input.baseUrl,
    modelsUrl: input.modelsUrl,
    oauth: {
      state: "not-documented",
      detail: "A browser-local model service uses no remote account or Airship backend.",
    },
    authMethods: [{
      id: `${input.id}-loopback`,
      kind: "local-none",
      label: "This machine",
      browserUse: "loopback-only",
    }],
    capabilities: ["invoke", "models:list"],
    documentationUrl: input.documentationUrl,
  });
}
