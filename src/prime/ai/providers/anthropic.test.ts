import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Model, Tool, ToolResultMessage } from "../index";
import { streamAnthropic, type AnthropicMessagesRequest, type AnthropicOptions } from "./anthropic";
import { sseJson, sseResponse, stubFetch, type CapturedRequest } from "./test-helpers";

/**
 * Anthropic provider request-shape goldens: payload mapping for system
 * prompts, tools, tool results, cache markers, thinking configuration, and
 * the auth/header matrix. Every test answers through the fetch stub with a
 * minimal valid SSE conversation.
 */

function createModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
    ...overrides,
  };
}

const USAGE_ZERO = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function minimalConversation(text = "Hello"): Parameters<typeof sseResponse>[0] {
  return [
    sseJson("message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
    sseJson("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sseJson("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    sseJson("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseJson("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
    sseJson("message_stop", { type: "message_stop" }),
  ];
}

async function runAndCapture(
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
): Promise<{ request: CapturedRequest; message: AssistantMessage; body: AnthropicMessagesRequest }> {
  const stub = stubFetch(() => sseResponse(minimalConversation()));
  try {
    const message = await streamAnthropic(model, context, { apiKey: "sk-ant-test", ...options }).result();
    if (stub.requests.length !== 1) throw new Error(`expected 1 request, got ${stub.requests.length}`);
    const request = stub.requests[0];
    return { request, message, body: request.body as AnthropicMessagesRequest };
  } finally {
    stub.restore();
  }
}

const TOOL: Tool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

describe("anthropic request construction", () => {
  it("posts to {baseUrl}/v1/messages with the API-key header matrix", async () => {
    const { request } = await runAndCapture(createModel(), {
      messages: [{ role: "user", content: "Say hello.", timestamp: 1 }],
    });

    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.method).toBe("POST");
    expect(request.headers["x-api-key"]).toBe("sk-ant-test");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.headers.accept).toBe("application/json");
    expect(request.headers["content-type"]).toBe("application/json");
    // Browser origin default for api.anthropic.com
    expect(request.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("controls anthropic-dangerous-direct-browser-access by baseUrl and compat", async () => {
    const proxied = await runAndCapture(createModel({ baseUrl: "https://proxy.example.com/anthropic" }), {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(proxied.request.headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();

    const optedIn = await runAndCapture(
      createModel({ baseUrl: "https://proxy.example.com", compat: { directBrowserAccess: true } }),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    );
    expect(optedIn.request.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");

    const optedOut = await runAndCapture(createModel({ compat: { directBrowserAccess: false } }), {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(optedOut.request.headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
  });

  it("sends the system prompt as a top-level block array with cache_control", async () => {
    const { body } = await runAndCapture(createModel(), {
      systemPrompt: "You are terse.",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(body.system).toEqual([{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } }]);
  });

  it("marks long cache retention with ttl 1h on system, tools, and last user block", async () => {
    const { body } = await runAndCapture(
      createModel(),
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [TOOL] },
      { cacheRetention: "long" },
    );

    expect(body.system?.[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.tools?.[body.tools.length - 1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const last = body.messages[body.messages.length - 1];
    expect(last.content).toEqual([{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  });

  it("caps ttl at the default 5m ephemeral when the model cannot do long retention", async () => {
    const { body } = await runAndCapture(
      createModel({ compat: { supportsLongCacheRetention: false } }),
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { cacheRetention: "long" },
    );
    expect(body.system?.[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits cache markers entirely when cacheRetention is none", async () => {
    const { body } = await runAndCapture(
      createModel(),
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [TOOL] },
      { cacheRetention: "none" },
    );
    expect(body.system?.[0]).toEqual({ type: "text", text: "sys" });
    expect(body.tools?.[0].cache_control).toBeUndefined();
    expect(body.messages[0].content).toBe("hi");
  });

  it("sends eager_input_streaming per tool by default, plus the interleaved-thinking beta on non-adaptive models", async () => {
    const { body, request } = await runAndCapture(
      createModel(),
      { messages: [{ role: "user", content: "x", timestamp: 1 }], tools: [TOOL] },
      {},
    );
    expect(body.tools).toEqual([
      {
        name: "read",
        description: "Read a file",
        eager_input_streaming: true,
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        cache_control: { type: "ephemeral" },
      },
    ]);
    // claude-sonnet-4-5 is not an adaptive-thinking model: the interleaved
    // thinking beta rides along by default.
    expect(request.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
  });

  it("skips the interleaved-thinking beta on adaptive-thinking models", async () => {
    const { request } = await runAndCapture(createModel({ id: "claude-opus-4-7" }), {
      messages: [{ role: "user", content: "x", timestamp: 1 }],
    });
    expect(request.headers["anthropic-beta"]).toBeUndefined();
  });

  it("falls back to the fine-grained tool streaming beta when eager tool input streaming is off", async () => {
    // Mirror of upstream anthropic-eager-tool-input-compat.test.ts, which
    // used the adaptive claude-opus-4-7 so only the tool beta matters.
    const model = createModel({ id: "claude-opus-4-7", compat: { supportsEagerToolInputStreaming: false } });

    const { body, request } = await runAndCapture(
      model,
      { messages: [{ role: "user", content: "x", timestamp: 1 }], tools: [TOOL] },
      {},
    );
    expect(body.tools?.[0].eager_input_streaming).toBeUndefined();
    expect(request.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");

    // No tools: no fine-grained beta, and on adaptive models no beta at all.
    const noTools = await runAndCapture(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }, {});
    expect(noTools.body.tools).toBeUndefined();
    expect(noTools.request.headers["anthropic-beta"]).toBeUndefined();
  });

  it("coalesces consecutive tool results into one user message with is_error preserved", async () => {
    const model = createModel();
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } },
        { type: "toolCall", id: "toolu_2", name: "read", arguments: { path: "b" } },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { ...USAGE_ZERO, cost: { ...USAGE_ZERO.cost } },
      stopReason: "toolUse",
      timestamp: 1,
    };
    const results: ToolResultMessage[] = [1, 2].map((n) => ({
      role: "toolResult",
      toolCallId: `toolu_${n}`,
      toolName: "read",
      content: [{ type: "text", text: `content ${n}` }],
      isError: n === 2,
      timestamp: 2,
    }));

    const { body } = await runAndCapture(model, {
      messages: [{ role: "user", content: "read both", timestamp: 0 }, assistant, ...results],
    });

    const toolResultMessage = body.messages[body.messages.length - 1];
    expect(toolResultMessage.role).toBe("user");
    expect(toolResultMessage.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "content 1", is_error: false },
      {
        type: "tool_result",
        tool_use_id: "toolu_2",
        content: "content 2",
        is_error: true,
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("normalizes foreign tool call ids for call and result alike", async () => {
    const foreign: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_xyz|fc_Odd/Chars+Here==", name: "edit", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
      usage: { ...USAGE_ZERO, cost: { ...USAGE_ZERO.cost } },
      stopReason: "toolUse",
      timestamp: 1,
    };
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_xyz|fc_Odd/Chars+Here==",
      toolName: "edit",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 2,
    };
    const { body } = await runAndCapture(createModel(), {
      messages: [{ role: "user", content: "go", timestamp: 0 }, foreign, result],
    });

    const assistantMsg = body.messages[1];
    const toolResultMsg = body.messages[2];
    const useBlock = Array.isArray(assistantMsg.content)
      ? (assistantMsg.content.find((b) => b.type === "tool_use") as { id: string } | undefined)
      : undefined;
    expect(useBlock?.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    const resultBlock = Array.isArray(toolResultMsg.content) ? toolResultMsg.content[0] : undefined;
    expect((resultBlock as { tool_use_id: string }).tool_use_id).toBe(useBlock?.id);
  });

  it("configures thinking: disabled without reasoning, budget-based for older models, adaptive for new ones", async () => {
    const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

    const disabled = await runAndCapture(createModel(), context, { thinkingEnabled: false });
    expect(disabled.body.thinking).toEqual({ type: "disabled" });

    const budgeted = await runAndCapture(createModel(), context, { thinkingEnabled: true, thinkingBudgetTokens: 4096 });
    expect(budgeted.body.thinking).toEqual({ type: "enabled", budget_tokens: 4096, display: "summarized" });

    const adaptive = await runAndCapture(createModel({ id: "claude-opus-4-6" }), context, {
      thinkingEnabled: true,
      effort: "high",
    });
    expect(adaptive.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(adaptive.body.output_config).toEqual({ effort: "high" });

    const withTemp = await runAndCapture(createModel(), context, { thinkingEnabled: true, temperature: 0.2 });
    expect(withTemp.body.temperature).toBeUndefined();
  });

  it("passes metadata.user_id and maps tool_choice", async () => {
    const withMeta = await runAndCapture(
      createModel(),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { metadata: { user_id: "user-1" }, toolChoice: { type: "tool", name: "edit" } },
    );
    expect(withMeta.body.metadata).toEqual({ user_id: "user-1" });
    expect(withMeta.body.tool_choice).toEqual({ type: "tool", name: "edit" });

    const stringChoice = await runAndCapture(
      createModel(),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { toolChoice: "any" },
    );
    expect(stringChoice.body.tool_choice).toEqual({ type: "any" });
  });

  it("computes max_tokens as one third of the model max when unset", async () => {
    const { body } = await runAndCapture(createModel(), { messages: [] }, {});
    expect(body.max_tokens).toBe((64000 / 3) | 0);
    const custom = await runAndCapture(createModel(), { messages: [] }, { maxTokens: 1234 });
    expect(custom.body.max_tokens).toBe(1234);
  });

  it("sends thinking.display omitted when requested", async () => {
    const { body } = await runAndCapture(
      createModel(),
      { messages: [] },
      { thinkingEnabled: true, thinkingBudgetTokens: 1024, thinkingDisplay: "omitted" },
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024, display: "omitted" });
  });

  it("lets onPayload rewrite the request body before sending", async () => {
    const { body } = await runAndCapture(
      createModel(),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { onPayload: (payload) => ({ ...(payload as Record<string, unknown>), max_tokens: 42 }) },
    );
    expect(body.max_tokens).toBe(42);
  });

  it("uses bearer auth and copilot dynamic headers for github-copilot", async () => {
    const copilot = createModel({ provider: "github-copilot", baseUrl: "https://api.githubcopilot.com" });
    const { request } = await runAndCapture(copilot, {
      messages: [{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 }],
    });
    expect(request.headers.Authorization).toBe("Bearer sk-ant-test");
    expect(request.headers["x-api-key"]).toBeUndefined();
    expect(request.headers["X-Initiator"]).toBe("user");
    expect(request.headers["Copilot-Vision-Request"]).toBe("true");
    expect(request.headers["Openai-Intent"]).toBe("conversation-edits");
  });
});
