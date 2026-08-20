import { registerApiProviderLoader, registerProviderDescriptor } from "../registry";

/**
 * Prime-agent's register-builtins.ts uses static imports with lazy internal
 * wiring; the browser port makes laziness structural: each provider family is
 * a separate bundler chunk, resolved on first use through the registry loader.
 * Providers that only make sense behind a host bridge (bedrock, google
 * vertex, codex OAuth) are deliberately not registered here.
 */

/*
 * Chutes speaks the generic chat-completions protocol with three compatibility
 * defaults. Keep them as provider data, not a hostname branch: a connection that
 * routes through a user proxy still gets the same declaration, while another
 * provider hosted on the same endpoint keeps the standard defaults.
 */
registerProviderDescriptor({
  api: "openai-completions",
  provider: "chutes",
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
  },
});

registerApiProviderLoader("anthropic-messages", async () => {
  const module = await import("./anthropic");
  return module.anthropicProvider;
});

registerApiProviderLoader("openai-completions", async () => {
  const module = await import("./openai-completions");
  return module.openAICompletionsProvider;
});

registerApiProviderLoader("openai-responses", async () => {
  const module = await import("./openai-responses");
  return module.openAIResponsesProvider;
});
