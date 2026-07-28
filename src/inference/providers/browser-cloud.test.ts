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
import { MAX_MODEL_OUTPUT_TOKENS } from "./contracts";
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

  it("omits the tool block entirely when a turn declares no tools", async () => {
    const bodies: Record<string, unknown>[] = [];
    const capture = async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([
        event("response.completed", { type: "response.completed", response: {} }),
      ]);
    };
    const openai = new OpenAiBrowserTransport({
      connectionId: "openai-main",
      connectionGeneration: 1,
      getApiKey: () => "sk-memory-only",
      fetch: capture,
    });
    const xai = new XaiBrowserTransport({
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
    const transport = new AnthropicBrowserTransport({
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
    const transport = new AnthropicBrowserTransport({
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
    const transport = new AnthropicBrowserTransport({
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
    const transport = new AnthropicBrowserTransport({
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
    const transport = new AnthropicBrowserTransport({
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
    const transport = new AnthropicBrowserTransport({
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
    expect((error as Error).message).toBe("Anthropic rejected the request with HTTP 400.");
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
      const transport = new AnthropicBrowserTransport({
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
    const transport = new AnthropicBrowserTransport({
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
    const transport = new AnthropicBrowserTransport({
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

/** Mirrors the fabric's mandatory activation probe, which declares no tools. */
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
