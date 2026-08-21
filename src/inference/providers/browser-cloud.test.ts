import { describe, expect, it, vi } from "vitest";
import type { InferenceEvent, InferenceRequest } from "../../core/contracts";
import {
  AnthropicBrowserTransport,
  ResponsesBrowserTransport,
  OpenAiCompatibleBrowserTransport,
  ProviderTransportError,
  type ProviderFetch,
} from "./browser-cloud";
import { ExtensionBridgeError } from "../bridge/protocol";
import { InferenceConnectionRegistry } from "./connection-registry";
import { MAX_MODEL_OUTPUT_TOKENS, type InferenceProviderDescriptor } from "./contracts";
import { OFFICIAL_CLOUD_PROVIDERS,
  ANTHROPIC_PROVIDER,
  OPENAI_PROVIDER,
  XAI_PROVIDER,
} from "./official-providers";
import { InferenceProviderCatalog } from "./provider-catalog";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");

function objectHeadersOf(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers ?? {};
  return headers instanceof Headers ? Object.fromEntries(headers.entries()) : { ...headers as Record<string, string> };
}

describe("browser-direct cloud inference adapters", () => {
  it("discovers OpenAI models through a getter without retaining capability guesses", async () => {
    const getApiKey = vi.fn(() => "sk-memory-only");
    const fetch = vi.fn<ProviderFetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-memory-only");
      return jsonResponse({
        object: "list",
        data: [{ id: "model-a", object: "model", owned_by: "openai" }],
      });
    });
    const transport = new ResponsesBrowserTransport(OPENAI_PROVIDER, {
      connectionId: "openai-main",
      connectionGeneration: 1,
      getApiKey,
      fetch,
      now: () => NOW,
    });

    await expect(transport.listModels()).resolves.toEqual([
      {
        version: 1,
        connectionId: "openai-main",
        connectionGeneration: 1,
        providerId: "openai",
        id: "model-a",
        label: "model-a",
        capabilities: {},
        availability: {
          state: "unknown",
          source: "provider-directory",
          observedAt: "2026-07-24T12:00:00.000Z",
        },
        source: {
          kind: "provider-directory",
          observedAt: "2026-07-24T12:00:00.000Z",
          sourceUrl: "https://api.openai.com/v1/models",
        },
      },
    ]);
    expect(getApiKey).toHaveBeenCalledTimes(1);
  });

  it("supports an arbitrary registered HTTPS OpenAI-compatible base URL and API key", async () => {
    const provider = customOpenAiCompatibleProvider({
      authMethods: [{
        id: "custom-api-key",
        kind: "api-key",
        label: "Custom API key",
        header: { name: "Authorization", scheme: "bearer" },
        browserUse: "direct-contract-unpublished",
        warning: "This custom endpoint is user-configured and uses a page-memory bearer key.",
      }],
      oauth: {
        state: "not-documented",
        detail: "This provider uses a bearer API key on its OpenAI-compatible endpoint.",
      },
    });
    const requests: Array<{ url: string; headers: Headers; body?: Record<string, unknown> }> = [];
    const transport = new OpenAiCompatibleBrowserTransport(provider, {
      connectionId: "custom-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-custom-memory-only",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
        });
        return requests.length === 1
          ? jsonResponse({ data: [{ id: "custom-model" }] })
          : sseResponse([
              event("chat.completion.chunk", {
                id: "chunk-1",
                choices: [{ index: 0, delta: { content: "hello from custom" }, finish_reason: null }],
              }),
              event("chat.completion.chunk", {
                id: "chunk-2",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              }),
              "data: [DONE]\n\n",
            ]);
      },
    });

    await expect(transport.listModels()).resolves.toMatchObject([
      { providerId: "custom-openai", id: "custom-model" },
    ]);
    await expect(collect(transport.stream(request(), new AbortController().signal))).resolves.toEqual([
      { type: "text-delta", text: "hello from custom" },
      { type: "completed", finishReason: "stop" },
    ]);
    expect(transport.id).toBe("custom-openai-openai-compatible-v1");
    expect(requests.map((request) => request.url)).toEqual([
      "https://custom-openai.example.test/v1/models",
      "https://custom-openai.example.test/v1/chat/completions",
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer sk-custom-memory-only")).toBe(true);
  });

  it("keeps the full opaque provider digest in transport authority", () => {
    const providerId = `openai-compatible-${"a".repeat(64)}`;
    const provider = customOpenAiCompatibleProvider({
      id: providerId,
      authMethods: [{
        id: `${providerId}-key`,
        kind: "api-key",
        label: "Opaque provider key",
        header: { name: "Authorization", scheme: "bearer" },
        browserUse: "dangerous-user-opt-in",
        warning: "Test credential remains in memory.",
      }],
    });
    const transport = new OpenAiCompatibleBrowserTransport(provider, {
      connectionId: "opaque-main",
      connectionGeneration: 1,
      getApiKey: () => "memory-only",
      fetch: vi.fn(),
    });

    expect(transport.id).toBe(`${providerId}-openai-compatible-v1`);
  });

  it("never propagates provider SSE error prose or an echoed leased key", async () => {
    const apiKey = "sse-lease-must-not-be-durable";
    const providerProse = "Vendor account disabled; contact secret support";
    const provider = customOpenAiCompatibleProvider({
      authMethods: [{
        id: "custom-api-key",
        kind: "api-key",
        label: "Custom API key",
        header: { name: "Authorization", scheme: "bearer" },
        browserUse: "direct-contract-unpublished",
        warning: "Custom endpoint test key.",
      }],
    });
    const transport = new OpenAiCompatibleBrowserTransport(provider, {
      connectionId: "custom-error-main",
      connectionGeneration: 1,
      getApiKey: () => apiKey,
      fetch: async () => sseResponse([
        event("error", {
          error: {
            message: `${providerProse}; received credential ${apiKey}`,
          },
        }),
      ]),
    });

    const failure = await collect(
      transport.stream(request(), new AbortController().signal),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderTransportError);
    expect(failure).toMatchObject({ code: "invalid-response" });
    expect((failure as Error).message)
      .toBe("Inference provider returned an invalid streaming response.");
    const exposed = JSON.stringify({
      name: (failure as Error).name,
      message: (failure as Error).message,
      stack: (failure as Error).stack,
      cause: (failure as Error & { cause?: unknown }).cause,
      code: (failure as ProviderTransportError).code,
      status: (failure as ProviderTransportError).status,
    });
    expect(exposed).not.toContain(providerProse);
    expect(exposed).not.toContain(apiKey);
  });

  it("scrubs a fetch failure that echoes the key before its credential lease ends", async () => {
    const apiKey = "fetch-lease-must-not-be-durable";
    const transport = new ResponsesBrowserTransport(OPENAI_PROVIDER, {
      connectionId: "openai-echo-main",
      connectionGeneration: 1,
      getApiKey: () => apiKey,
      fetch: async (_input, init) => {
        const echoed = new Headers(init?.headers).get("authorization");
        throw new Error(`Host rejected ${echoed}`);
      },
    });

    const failure = await collect(
      transport.stream(request(), new AbortController().signal),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderTransportError);
    expect(failure).toMatchObject({ code: "network-or-cors" });
    expect((failure as Error).message)
      .toBe("Inference provider request failed before a response was accepted.");
    expect((failure as Error).message).not.toContain(apiKey);
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("honors a custom provider's declared raw API-key header without adding Authorization", async () => {
    const provider = customOpenAiCompatibleProvider({
      id: "custom-raw-openai",
      authMethods: [{
        id: "custom-raw-api-key",
        kind: "api-key",
        label: "Raw key",
        header: { name: "x-api-key", scheme: "raw" },
        browserUse: "direct-contract-unpublished",
        warning: "This custom endpoint is user-configured and uses a page-memory raw key.",
      }],
    });
    const requests: Headers[] = [];
    const transport = new OpenAiCompatibleBrowserTransport(provider, {
      connectionId: "custom-raw-main",
      connectionGeneration: 1,
      getApiKey: () => "sekret",
      fetch: async (_input, init) => {
        requests.push(new Headers(init?.headers));
        return jsonResponse({ data: [{ id: "custom-model" }] });
      },
    });

    await transport.listModels();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get("x-api-key")).toBe("sekret");
    expect(requests[0]?.get("authorization")).toBeNull();
  });

  it("uses the selected OAuth connection metadata for generic OpenAI-compatible auth", async () => {
    const provider = customOpenAiCompatibleProvider({
      id: "custom-oauth-openai",
      authMethods: [{
        id: "custom-oauth",
        kind: "oauth-public-pkce",
        label: "Custom account",
        authorizationEndpoint: "https://auth.custom-oauth-openai.example.test/authorize",
        tokenEndpoint: "https://auth.custom-oauth-openai.example.test/token",
        clientId: "custom-client",
        redirectUris: ["https://airship.test/callback"],
        scopes: ["models:read"],
        tokenEndpointAuthMethod: "none",
        codeChallengeMethod: "S256",
        browserUse: "reviewed-direct",
        review: {
          id: "fixture-review",
          reviewedAt: "2026-07-24T12:00:00.000Z",
          sourceUrl: "https://airship.test/review",
        },
      }, {
        id: "custom-api-key",
        kind: "api-key",
        label: "Custom key",
        header: { name: "x-api-key", scheme: "raw" },
        browserUse: "direct-contract-unpublished",
        warning: "This custom endpoint is user-configured and uses a page-memory raw key.",
      }],
      oauth: {
        state: "configured-public-pkce",
        authMethodId: "custom-oauth",
        detail: "The custom provider publishes reviewed page-safe OAuth metadata.",
      },
    });
    const providers = new InferenceProviderCatalog([provider]);
    const connections = new InferenceConnectionRegistry(providers, () => NOW);
    connections.connectOAuth({
      id: "custom-oauth-main",
      providerId: provider.id,
      authMethodId: "custom-oauth",
      label: "Custom OAuth",
      accessToken: "oauth-token-123",
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      scopes: ["models:read"],
      connectedAt: new Date(NOW).toISOString(),
    });
    const requests: Headers[] = [];
    const transport = new OpenAiCompatibleBrowserTransport(provider, {
      connectionId: "custom-oauth-main",
      connectionGeneration: 1,
      connections,
      fetch: async (_input, init) => {
        requests.push(new Headers(init?.headers));
        return jsonResponse({ data: [{ id: "custom-model" }] });
      },
    });

    await transport.listModels();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get("authorization")).toBe("Bearer oauth-token-123");
    expect(requests[0]?.get("x-api-key")).toBeNull();
  });

  it("rejects getApiKey() when custom metadata has no unique API-key method", async () => {
    const missingProvider = customOpenAiCompatibleProvider({
      id: "custom-oauth-only",
      authMethods: [{
        id: "custom-oauth",
        kind: "oauth-public-pkce",
        label: "Custom account",
        authorizationEndpoint: "https://auth.custom-oauth-only.example.test/authorize",
        tokenEndpoint: "https://auth.custom-oauth-only.example.test/token",
        clientId: "custom-client",
        redirectUris: ["https://airship.test/callback"],
        scopes: ["models:read"],
        tokenEndpointAuthMethod: "none",
        codeChallengeMethod: "S256",
        browserUse: "reviewed-direct",
        review: {
          id: "fixture-review",
          reviewedAt: "2026-07-24T12:00:00.000Z",
          sourceUrl: "https://airship.test/review",
        },
      }],
      oauth: {
        state: "configured-public-pkce",
        authMethodId: "custom-oauth",
        detail: "This provider exposes only reviewed OAuth metadata.",
      },
    });
    const ambiguousProvider = customOpenAiCompatibleProvider({
      id: "custom-ambiguous-openai",
      authMethods: [{
        id: "custom-api-key-a",
        kind: "api-key",
        label: "Header A",
        header: { name: "Authorization", scheme: "bearer" },
        browserUse: "direct-contract-unpublished",
        warning: "Custom provider header A.",
      }, {
        id: "custom-api-key-b",
        kind: "api-key",
        label: "Header B",
        header: { name: "x-api-key", scheme: "raw" },
        browserUse: "direct-contract-unpublished",
        warning: "Custom provider header B.",
      }],
    });

    await expect(new OpenAiCompatibleBrowserTransport(missingProvider, {
      connectionId: "custom-oauth-only-main",
      connectionGeneration: 1,
      getApiKey: () => "sekret",
      fetch: async () => jsonResponse({ data: [] }),
    }).listModels()).rejects.toThrow(/exactly one registered API-key auth method/u);
    await expect(new OpenAiCompatibleBrowserTransport(ambiguousProvider, {
      connectionId: "custom-ambiguous-main",
      connectionGeneration: 1,
      getApiKey: () => "sekret",
      fetch: async () => jsonResponse({ data: [] }),
    }).listModels()).rejects.toThrow(/exactly one registered API-key auth method/u);
  });

  it("rejects incompatible selected connection metadata instead of assuming bearer auth", async () => {
    const registryProvider = customOpenAiCompatibleProvider({
      id: "custom-metadata-openai",
      authMethods: [{
        id: "custom-oauth",
        kind: "oauth-public-pkce",
        label: "Custom account",
        authorizationEndpoint: "https://auth.custom-metadata-openai.example.test/authorize",
        tokenEndpoint: "https://auth.custom-metadata-openai.example.test/token",
        clientId: "custom-client",
        redirectUris: ["https://airship.test/callback"],
        scopes: ["models:read"],
        tokenEndpointAuthMethod: "none",
        codeChallengeMethod: "S256",
        browserUse: "reviewed-direct",
        review: {
          id: "fixture-review",
          reviewedAt: "2026-07-24T12:00:00.000Z",
          sourceUrl: "https://airship.test/review",
        },
      }],
      oauth: {
        state: "configured-public-pkce",
        authMethodId: "custom-oauth",
        detail: "This provider exposes reviewed OAuth metadata.",
      },
    });
    const connections = new InferenceConnectionRegistry(
      new InferenceProviderCatalog([registryProvider]),
      () => NOW,
    );
    connections.connectOAuth({
      id: "custom-metadata-main",
      providerId: registryProvider.id,
      authMethodId: "custom-oauth",
      label: "Custom OAuth",
      accessToken: "oauth-token-123",
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      scopes: ["models:read"],
      connectedAt: new Date(NOW).toISOString(),
    });
    const transport = new OpenAiCompatibleBrowserTransport(
      customOpenAiCompatibleProvider({
        id: registryProvider.id,
        authMethods: [{
          id: "custom-api-key",
          kind: "api-key",
          label: "Custom key",
          header: { name: "Authorization", scheme: "bearer" },
          browserUse: "direct-contract-unpublished",
          warning: "This provider was re-registered without the old OAuth metadata.",
        }],
      }),
      {
        connectionId: "custom-metadata-main",
        connectionGeneration: 1,
        connections,
        fetch: async () => jsonResponse({ data: [] }),
      },
    );

    await expect(transport.listModels()).rejects.toThrow(/unavailable authentication method/u);
  });

  it("uses only xAI-declared modalities and leaves undeclared tools unknown", async () => {
    const transport = new ResponsesBrowserTransport(XAI_PROVIDER, {
      connectionId: "xai-main",
      connectionGeneration: 1,
      getApiKey: () => "xai-memory-only",
      now: () => NOW,
      fetch: async () =>
        jsonResponse({
          models: [{
            id: "grok-test",
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
          }],
        }),
    });

    const [model] = await transport.listModels();
    expect(model?.capabilities).toMatchObject({
      "text-input": { state: "supported", source: "provider-directory" },
      "image-input": { state: "supported", source: "provider-directory" },
      "audio-input": { state: "unsupported", source: "provider-directory" },
      "text-output": { state: "supported", source: "provider-directory" },
    });
    expect(model?.capabilities["tool-calling"]).toBeUndefined();
  });

  /*
   * The seam used to `switch (provider.id)` over openai/anthropic/xai, so a
   * descriptor that declared one of these wires and was accepted by
   * `normalizeProvider` was then refused with "has no browser-cloud transport".
   * A provider is now whatever its descriptor says it is.
   */
  it("serves any descriptor that declares a reviewed wire, reading its own endpoints", async () => {
    const requested: string[] = [];
    const responses = new ResponsesBrowserTransport({
      version: 1,
      id: "acme-responses",
      label: "Acme Responses",
      protocol: "openai-responses",
      transportBoundary: "provider-tls",
      baseUrl: "https://api.acme.test/v2/",
      modelsUrl: "https://api.acme.test/v2/language-models",
      oauth: { state: "not-documented", detail: "No public-PKCE registration." },
      authMethods: [{
        id: "acme-api-key",
        kind: "api-key",
        label: "Acme key",
        header: { name: "Authorization", scheme: "bearer" },
        browserUse: "direct-contract-unpublished",
        warning: "Browser-direct key.",
      }],
      capabilities: ["invoke", "models:list"],
      documentationUrl: "https://acme.test/docs",
    }, {
      connectionId: "acme-main",
      connectionGeneration: 1,
      getApiKey: () => "acme-memory-only",
      now: () => NOW,
      fetch: async (input) => {
        requested.push(String(input));
        return jsonResponse({ models: [{ id: "acme-large" }] });
      },
    });

    expect(responses.id).toBe("acme-responses-responses-v1");
    const [model] = await responses.listModels();
    expect(model?.id).toBe("acme-large");
    expect(model?.providerId).toBe("acme-responses");
    expect(requested).toEqual(["https://api.acme.test/v2/language-models"]);

    // The reviewed first-party providers keep the exact transport identities
    // their sessions are pinned to.
    expect(new ResponsesBrowserTransport(OPENAI_PROVIDER, {
      connectionId: "openai-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-memory-only",
    }).id).toBe("openai-responses-v1");
    expect(new ResponsesBrowserTransport(XAI_PROVIDER, {
      connectionId: "xai-main",
      connectionGeneration: 1,
      getApiKey: () => "xai-memory-only",
    }).id).toBe("xai-responses-v1");
    expect(new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "anthropic-memory-only",
    }).id).toBe("anthropic-messages-v1");

    // A turn goes to the descriptor's own inference host, not to whatever host
    // its catalog happens to live on.
    const posted: string[] = [];
    const split = new ResponsesBrowserTransport({
      version: 1,
      id: "split-host",
      label: "Split Host",
      protocol: "openai-responses",
      transportBoundary: "provider-tls",
      baseUrl: "https://inference.acme.test/v3/",
      modelsUrl: "https://catalog.acme.test/v9/models",
      oauth: { state: "not-documented", detail: "No public-PKCE registration." },
      authMethods: [{
        id: "split-key",
        kind: "api-key",
        label: "Split key",
        header: { name: "x-acme-key", scheme: "raw" },
        browserUse: "direct-contract-unpublished",
        warning: "Browser-direct key.",
      }],
      capabilities: ["invoke", "models:list"],
      documentationUrl: "https://acme.test/docs",
    }, {
      connectionId: "split-main",
      connectionGeneration: 1,
      getApiKey: () => "split-secret",
      now: () => NOW,
      fetch: async (input, init) => {
        posted.push(String(input));
        // The declared header carries the key; `authorization` is not assumed.
        expect(objectHeadersOf(init)).toMatchObject({ "x-acme-key": "split-secret" });
        expect(objectHeadersOf(init).authorization).toBeUndefined();
        return sseResponse([event("response.completed", { type: "response.completed", response: {} })]);
      },
    });
    await collect(split.stream(request(), new AbortController().signal));
    expect(posted).toEqual(["https://inference.acme.test/v3/responses"]);

    // A wire nobody reviewed is still refused.
    expect(() => new ResponsesBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "anthropic-memory-only",
    })).toThrow(/does not use the openai-responses wire/u);
  });

  it("streams OpenAI Responses text, usage, and bounded function calls", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const transport = new ResponsesBrowserTransport(OPENAI_PROVIDER, {
      connectionId: "openai-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-memory-only",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse([
          event("response.output_text.delta", { type: "response.output_text.delta", delta: "hello" }),
          event("response.output_item.added", {
            type: "response.output_item.added",
            item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: "" },
          }),
          event("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            item_id: "item-1",
            delta: "{\"path\":\"README.md\"}",
          }),
          event("response.completed", {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 4 } },
          }),
        ]);
      },
    });

    const events = await collect(transport.stream(request(), new AbortController().signal));
    expect(events).toEqual([
      { type: "text-delta", text: "hello" },
      { type: "usage", inputTokens: 10, outputTokens: 4 },
      {
        type: "tool-call",
        call: { id: "call-1", name: "read_file", arguments: { path: "README.md" } },
      },
      { type: "completed", finishReason: "tool-calls" },
    ]);
    expect(requestBody).toMatchObject({
      model: "provider/model",
      stream: true,
      store: false,
      parallel_tool_calls: true,
    });
    expect(JSON.stringify(requestBody)).not.toContain("sk-memory-only");
  });


  it("streams OpenAI Responses reasoning as its own event beside the answer", async () => {
    const transport = new ResponsesBrowserTransport(OPENAI_PROVIDER, {
      connectionId: "openai-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-memory-only",
      fetch: async () => sseResponse([
        event("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "Plan: check the budget. " }),
        event("response.reasoning_text.delta", { type: "response.reasoning_text.delta", delta: "Numbers add up." }),
        event("response.output_text.delta", { type: "response.output_text.delta", delta: "The budget holds." }),
        event("response.completed", { type: "response.completed", response: { usage: {} } }),
      ]),
    });

    const events = await collect(transport.stream(request(), new AbortController().signal));
    expect(events.slice(0, 4)).toEqual([
      { type: "progress", phase: "reasoning" },
      { type: "reasoning-delta", text: "Plan: check the budget. " },
      { type: "progress", phase: "reasoning" },
      { type: "reasoning-delta", text: "Numbers add up." },
    ]);
    expect(events.some((event) => event.type === "text-delta" && event.text.includes("Plan"))).toBe(false);
  });

  it("streams Anthropic thinking deltas once as progress and every time as reasoning", async () => {
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      fetch: async () => sseResponse([
        event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Considering the cost. " } }),
        event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "It is fine." } }),
        event("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Ship it." } }),
        event("message_stop", { type: "message_stop" }),
      ]),
    });

    const events = await collect(transport.stream(request(), new AbortController().signal));
    expect(events.filter((event) => event.type === "progress")).toHaveLength(1);
    expect(events.filter((event) => event.type === "reasoning-delta")).toEqual([
      { type: "reasoning-delta", text: "Considering the cost. " },
      { type: "reasoning-delta", text: "It is fine." },
    ]);
    expect(events.some((event) => event.type === "text-delta" && event.text.includes("Considering"))).toBe(false);
  });

  it("adapts Anthropic Messages streaming and direct-browser headers", async () => {
    const requests: Array<{ url: string; headers: Headers; body?: Record<string, unknown> }> = [];
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      maxOutputTokens: 4_096,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          ...(init?.body
            ? { body: JSON.parse(String(init.body)) as Record<string, unknown> }
            : {}),
        });
        return sseResponse([
          event("message_start", {
            type: "message_start",
            message: { usage: { input_tokens: 12 } },
          }),
          event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tool-1", name: "list_files", input: {} },
          }),
          event("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{\"path\":\".\"}" },
          }),
          event("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 7 },
          }),
          event("message_stop", { type: "message_stop" }),
        ]);
      },
    });

    const events = await collect(transport.stream(request(), new AbortController().signal));
    expect(requests[0]?.headers.get("x-api-key")).toBe("sk-ant-memory-only");
    expect(requests[0]?.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(requests[0]?.body).toMatchObject({ model: "provider/model", max_tokens: 4_096, stream: true });
    expect(events).toEqual([
      { type: "usage", inputTokens: 12, outputTokens: 7 },
      {
        type: "tool-call",
        call: { id: "tool-1", name: "list_files", arguments: { path: "." } },
      },
      { type: "completed", finishReason: "tool-calls" },
    ]);
  });

  it("omits the tool block entirely when a turn declares no tools", async () => {
    const bodies: Record<string, unknown>[] = [];
    const capture = async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([
        event("response.completed", { type: "response.completed", response: {} }),
      ]);
    };
    const openai = new ResponsesBrowserTransport(OPENAI_PROVIDER, {
      connectionId: "openai-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-memory-only",
      fetch: capture,
    });
    const xai = new ResponsesBrowserTransport(XAI_PROVIDER, {
      connectionId: "xai-main",
      connectionGeneration: 1,
      getApiKey: () => "xai-memory-only",
      fetch: capture,
    });

    await collect(openai.stream(toollessRequest(), new AbortController().signal));
    await collect(xai.stream(toollessRequest(), new AbortController().signal));

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("tool_choice");
      expect(body).not.toHaveProperty("parallel_tool_calls");
      expect(body).toMatchObject({ stream: true, store: false });
    }
  });

  it("omits Anthropic tool_choice when the connection probe carries no tools", async () => {
    let body: Record<string, unknown> | undefined;
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse([event("message_stop", { type: "message_stop" })]);
      },
    });

    await collect(transport.stream(toollessRequest(), new AbortController().signal));
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    // Anthropic still requires max_tokens on every request.
    expect(body).toMatchObject({ max_tokens: 64_000, stream: true });
  });

  it("prefers a declared per-model output ceiling over the connection default", async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      maxOutputTokensForModel: (modelId) =>
        modelId === "declared/model" ? 200_000 : undefined,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sseResponse([event("message_stop", { type: "message_stop" })]);
      },
    });

    await collect(
      transport.stream(
        { ...toollessRequest(), model: "declared/model" },
        new AbortController().signal,
      ),
    );
    await collect(
      transport.stream(
        { ...toollessRequest(), model: "undeclared/model" },
        new AbortController().signal,
      ),
    );

    expect(bodies[0]).toMatchObject({ model: "declared/model", max_tokens: 200_000 });
    expect(bodies[1]).toMatchObject({ model: "undeclared/model", max_tokens: 64_000 });
  });

  it("refuses an out-of-range declared output ceiling instead of falling back", async () => {
    const fetch = vi.fn<ProviderFetch>();
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      maxOutputTokensForModel: () => 0,
      fetch,
    });

    await expect(
      collect(transport.stream(toollessRequest(), new AbortController().signal)),
    ).rejects.toThrow(/declared maximum output/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a declaration exactly at the shared catalog ceiling and refuses one above it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      maxOutputTokensForModel: (modelId) =>
        modelId === "at-ceiling/model" ? MAX_MODEL_OUTPUT_TOKENS : MAX_MODEL_OUTPUT_TOKENS + 1,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sseResponse([event("message_stop", { type: "message_stop" })]);
      },
    });

    await collect(
      transport.stream(
        { ...toollessRequest(), model: "at-ceiling/model" },
        new AbortController().signal,
      ),
    );
    expect(bodies).toEqual([expect.objectContaining({ max_tokens: MAX_MODEL_OUTPUT_TOKENS })]);

    await expect(
      collect(
        transport.stream(
          { ...toollessRequest(), model: "over-ceiling/model" },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/declared maximum output/u);
    expect(bodies).toHaveLength(1);
  });

  it("adopts the output ceiling Anthropic states in a refusal and re-sends exactly once", async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (body.max_tokens !== 8_192) return anthropicCeilingRefusal(Number(body.max_tokens), 8_192);
        return sseResponse([event("message_stop", { type: "message_stop" })]);
      },
    });

    await collect(transport.stream(toollessRequest(), new AbortController().signal));
    expect(bodies.map((body) => body.max_tokens)).toEqual([64_000, 8_192]);

    // The learned ceiling survives the turn, so the next one costs no refusal.
    await collect(transport.stream(toollessRequest(), new AbortController().signal));
    expect(bodies.map((body) => body.max_tokens)).toEqual([64_000, 8_192, 8_192]);
  });

  it("raises a 400 that names no ceiling instead of guessing a smaller one", async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "messages: at least one message is required" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    });

    const error = await collect(transport.stream(toollessRequest(), new AbortController().signal))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({ code: "http", status: 400 });
    // No retry, and the vendor's prose never reaches the caller.
    expect(bodies).toHaveLength(1);
    expect((error as Error).message)
      .toBe("Inference provider rejected the request with HTTP 400.");
  });

  it("adopts a ceiling only from a refusal that matches the whole published shape", async () => {
    // Each of these carries a plausible-looking number that a prefix-only match
    // would adopt. None is the refusal Anthropic documents, so none may change
    // what this client asks for; the original 400 has to propagate untouched.
    const nearMisses: readonly string[] = [
      // The numeric prefix, but a different sentence: a refusal about the
      // *input* budget, whose second number is not an output ceiling at all.
      "max_tokens: 64000 > 8192, which exceeds the remaining prompt budget for this request",
      // The right clause, but reporting on a request this client never sent.
      "max_tokens: 12000 > 8192, which is the maximum allowed number of output tokens for provider/model",
      // The clause, but not attached to a max_tokens comparison.
      "8192 is the maximum allowed number of output tokens for provider/model",
      // The clause pushed past the bounded gap the matcher will span.
      `max_tokens: 64000 > 8192,${" and".repeat(40)} which is the maximum allowed number of output tokens for provider/model`,
    ];

    for (const message of nearMisses) {
      const bodies: Record<string, unknown>[] = [];
      const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
        connectionId: "anthropic-main",
        connectionGeneration: 1,
        getApiKey: () => "sk-ant-memory-only",
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(
            JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
      });

      await expect(
        collect(transport.stream(toollessRequest(), new AbortController().signal)),
      ).rejects.toMatchObject({ code: "http", status: 400 });
      expect(bodies.map((body) => body.max_tokens)).toEqual([64_000]);
    }
  });

  it("stops after one corrected re-send when the stated ceiling is refused again", async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return anthropicCeilingRefusal(Number(body.max_tokens), Number(body.max_tokens) / 2);
      },
    });

    await expect(
      collect(transport.stream(toollessRequest(), new AbortController().signal)),
    ).rejects.toMatchObject({ code: "http", status: 400 });
    expect(bodies.map((body) => body.max_tokens)).toEqual([64_000, 32_000]);
  });

  it("does not re-send a refused operator declaration behind the operator's back", async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      maxOutputTokensForModel: () => 100_000,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return anthropicCeilingRefusal(Number(body.max_tokens), 8_192);
      },
    });

    await expect(
      collect(transport.stream(toollessRequest(), new AbortController().signal)),
    ).rejects.toMatchObject({ code: "http", status: 400 });
    expect(bodies.map((body) => body.max_tokens)).toEqual([100_000]);
  });

  it("reports browser reachability honestly without asserting CORS as fact", async () => {
    const transport = new ResponsesBrowserTransport(XAI_PROVIDER, {
      connectionId: "xai-main",
      connectionGeneration: 1,
      getApiKey: () => "xai-memory-only",
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    const error = await transport.listModels().catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({ code: "network-or-cors" });
    expect((error as Error).message)
      .toBe("Inference provider request failed before a response was accepted.");
  });

  /*
   * A bridged body fails through the stream rather than at the call, so the
   * bounded reader is the branch that has to name the provider. It named a
   * literal "The provider" into sentences that already supply their own
   * article, and the operator was shown "could not complete the The provider
   * request" — an unreadable sentence in the one place whose whole job is
   * saying which provider broke.
   */
  it("names the provider when a bridged catalog body fails mid-read", async () => {
    const transport = new AnthropicBrowserTransport(ANTHROPIC_PROVIDER, {
      connectionId: "anthropic-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-ant-memory-only",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new ExtensionBridgeError("bridge-error", "The relay closed."));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const error = await transport.listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({ code: "bridge-refused" });
    expect((error as Error).message).toContain("could not complete the Anthropic request");
  });

  it("rejects oversized model directories before parsing provider data", async () => {
    const transport = new ResponsesBrowserTransport(OPENAI_PROVIDER, {
      connectionId: "openai-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-memory-only",
      maxJsonBytes: 8,
      fetch: async () => jsonResponse({ data: [{ id: "too-large" }] }),
    });

    await expect(transport.listModels()).rejects.toMatchObject({ code: "response-too-large" });
  });

  it("borrows an API key from the page-memory registry and hardens browser requests", async () => {
    const providers = new InferenceProviderCatalog(OFFICIAL_CLOUD_PROVIDERS);
    const connections = new InferenceConnectionRegistry(providers, () => NOW);
    connections.connectApiKey({
      id: "openai-main",
      providerId: "openai",
      authMethodId: "openai-api-key",
      label: "OpenAI",
      apiKey: "sk-registry-only",
    });
    let requestInit: RequestInit | undefined;
    const transport = new ResponsesBrowserTransport(OPENAI_PROVIDER, {
      connectionId: "openai-main",
      connectionGeneration: 1,
      connections,
      fetch: async (_input, init) => {
        requestInit = init;
        return jsonResponse({ data: [] });
      },
    });

    await transport.listModels();
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer sk-registry-only");
    expect(requestInit).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(JSON.stringify(connections.snapshot())).not.toContain("sk-registry-only");

    connections.connectApiKey({
      id: "openai-main",
      providerId: "openai",
      authMethodId: "openai-api-key",
      label: "Replacement account",
      apiKey: "sk-replacement",
    });
    await expect(transport.listModels()).rejects.toThrow("credential generation 1");
  });

  it("accepts a conventional terminal [DONE] marker only as stream framing", async () => {
    const transport = new ResponsesBrowserTransport(OPENAI_PROVIDER, {
      connectionId: "openai-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-memory-only",
      fetch: async () => sseResponse([
        event("response.completed", {
          type: "response.completed",
          response: { usage: { input_tokens: 1, output_tokens: 1 } },
        }),
        "data: [DONE]\n\n",
      ]),
    });
    await expect(collect(transport.stream(request(), new AbortController().signal))).resolves.toEqual([
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "completed", finishReason: "stop" },
    ]);
  });
});

function customOpenAiCompatibleProvider(options: Readonly<{
  id?: string;
  label?: string;
  authMethods: InferenceProviderDescriptor["authMethods"];
  oauth?: InferenceProviderDescriptor["oauth"];
}>): InferenceProviderDescriptor {
  const id = options.id ?? "custom-openai";
  return {
    version: 1,
    id,
    label: options.label ?? "Custom OpenAI-compatible",
    protocol: "openai-compatible",
    transportBoundary: "provider-tls",
    baseUrl: `https://${id}.example.test/v1`,
    oauth: options.oauth ?? {
      state: "not-documented",
      detail: "This provider uses a direct OpenAI-compatible API route.",
    },
    authMethods: options.authMethods,
    capabilities: ["invoke", "models:list"],
    documentationUrl: `https://${id}.example.test/docs`,
  };
}

function request(): InferenceRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    turnId: "turn-1",
    model: "provider/model",
    systemPrompt: "Use the available tools.",
    messages: [{ role: "user", content: "Inspect the workspace." }],
    tools: [{
      name: "read_file",
      description: "Read a file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      effect: "read",
    }],
    idempotencyKey: "idempotency-1",
  };
}

/** Mirrors the fabric's mandatory toolless request, which declares no tools. */
function toollessRequest(): InferenceRequest {
  return { ...request(), tools: [] };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The refusal Anthropic's published Messages contract returns for an
 * over-large `max_tokens`. Reproduced from that contract, not from an observed
 * response: no Anthropic key exists in this repository.
 */
function anthropicCeilingRefusal(asked: number, ceiling: number): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          `max_tokens: ${asked} > ${ceiling}, which is the maximum allowed number of output tokens for provider/model`,
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}
function sseResponse(events: readonly string[]): Response {
  return new Response(events.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function event(name: string, value: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}

async function collect(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
