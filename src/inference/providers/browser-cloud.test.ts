import { describe, expect, it, vi } from "vitest";
import type { InferenceEvent, InferenceRequest } from "../../core/contracts";
import {
  AnthropicBrowserTransport,
  OpenAiBrowserTransport,
  ProviderTransportError,
  XaiBrowserTransport,
  type ProviderFetch,
} from "./browser-cloud";
import { InferenceConnectionRegistry } from "./connection-registry";
import { OFFICIAL_CLOUD_PROVIDERS } from "./official-providers";
import { InferenceProviderCatalog } from "./provider-catalog";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");

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
    const transport = new OpenAiBrowserTransport({
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

  it("uses only xAI-declared modalities and leaves undeclared tools unknown", async () => {
    const transport = new XaiBrowserTransport({
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

  it("streams OpenAI Responses text, usage, and bounded function calls", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const transport = new OpenAiBrowserTransport({
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

  it("adapts Anthropic Messages streaming and direct-browser headers", async () => {
    const requests: Array<{ url: string; headers: Headers; body?: Record<string, unknown> }> = [];
    const transport = new AnthropicBrowserTransport({
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

  it("reports browser reachability honestly without asserting CORS as fact", async () => {
    const transport = new XaiBrowserTransport({
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
    expect((error as Error).message).toMatch(/may be network reachability, provider availability, or CORS/u);
  });

  it("rejects oversized model directories before parsing provider data", async () => {
    const transport = new OpenAiBrowserTransport({
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
    const transport = new OpenAiBrowserTransport({
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
    const transport = new OpenAiBrowserTransport({
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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
