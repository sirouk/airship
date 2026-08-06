import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Model, Tool, ToolResultMessage } from "../index";
import { streamOpenAICompletions, type OpenAICompletionsOptions } from "./openai-completions";
import {
  collectEvents,
  expectEventProtocolConformance,
  jsonResponse,
  sseJson,
  sseResponse,
  stubFetch,
  type CapturedRequest,
} from "./test-helpers";

/**
 * OpenAI chat-completions provider: payload goldens (compat auto-detection,
 * thinking-format dispatch, tool/result framing, cache markers) and SSE
 * conformance (text/reasoning/tool-call assembly, usage normalization, stop
 * mapping, aborts, HTTP error surfaces).
 */

function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
  return {
    id: "gpt-5-mini",
    name: "GPT 5 Mini",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 400000,
    maxTokens: 128000,
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

function chunk(payload: Record<string, unknown>): { data: string } {
  return { data: JSON.stringify(payload) };
}

function stopChunks(usage?: Record<string, unknown>) {
  return [
    chunk({
      id: "chatcmpl-1",
      model: "gpt-5-mini",
      choices: [{ delta: { content: "Hello" }, finish_reason: null }],
    }),
    ...(usage
      ? [
          chunk({
            id: "chatcmpl-1",
            model: "gpt-5-mini",
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage,
          }),
        ]
      : [chunk({ id: "chatcmpl-1", model: "gpt-5-mini", choices: [{ delta: {}, finish_reason: "stop" }] })]),
    { data: "[DONE]" },
  ];
}

interface ChatParams {
  model: string;
  messages: { role: string; content?: unknown; [key: string]: unknown }[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  store?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: unknown[];
  reasoning_effort?: string;
  reasoning?: { effort?: string };
  thinking?: { type: string };
  enable_thinking?: boolean;
  chat_template_kwargs?: Record<string, unknown>;
  prompt_cache_key?: string;
  prompt_cache_retention?: string;
  [key: string]: unknown;
}

async function runAndCapture(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
): Promise<{ request: CapturedRequest; body: ChatParams; message: AssistantMessage }> {
  const stub = stubFetch(() => sseResponse(stopChunks({ prompt_tokens: 10, completion_tokens: 2 })));
  try {
    const message = await streamOpenAICompletions(model, context, { apiKey: "test-key", ...options }).result();
    if (stub.requests.length !== 1) throw new Error(`expected 1 request, got ${stub.requests.length}`);
    const request = stub.requests[0];
    return { request, message, body: request.body as ChatParams };
  } finally {
    stub.restore();
  }
}

const USER: Context["messages"][number] = { role: "user", content: "hi", timestamp: 1 };

describe("openai-completions request construction", () => {
  it("posts to {baseUrl}/chat/completions with bearer auth and stream_options", async () => {
    const { request, body } = await runAndCapture(createModel(), { messages: [USER] });
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer test-key");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.store).toBe(false);
  });

  it("uses developer role for reasoning models and system role otherwise", async () => {
    const reasoningRun = await runAndCapture(createModel(), { systemPrompt: "be terse", messages: [USER] });
    expect(reasoningRun.body.messages[0]).toEqual({ role: "developer", content: "be terse" });

    const plainRun = await runAndCapture(createModel({ reasoning: false }), { systemPrompt: "be terse", messages: [USER] });
    expect(plainRun.body.messages[0]).toEqual({ role: "system", content: "be terse" });
  });

  it("maps maxTokens to max_completion_tokens by default and max_tokens for detected providers", async () => {
    const openai = await runAndCapture(createModel(), { messages: [USER] }, { maxTokens: 100 });
    expect(openai.body.max_completion_tokens).toBe(100);
    expect(openai.body.max_tokens).toBeUndefined();

    const chutes = await runAndCapture(createModel({ provider: "chutes", baseUrl: "https://llm.chutes.ai/v1" }), { messages: [USER] }, { maxTokens: 100 });
    expect(chutes.body.max_tokens).toBe(100);
    expect(chutes.body.max_completion_tokens).toBeUndefined();

    const moonshot = await runAndCapture(createModel({ provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" }), { messages: [USER] }, { maxTokens: 100 });
    expect(moonshot.body.max_tokens).toBe(100);
  });

  it("auto-detects non-standard providers and omits store/developer/reasoning knobs", async () => {
    // cerebras provider: non-standard -> no store, system role for reasoning model
    const cerebras = await runAndCapture(createModel({ provider: "cerebras", baseUrl: "https://api.cerebras.ai/v1" }), {
      systemPrompt: "sys",
      messages: [USER],
    });
    expect(cerebras.body.store).toBeUndefined();
    expect(cerebras.body.messages[0].role).toBe("system");

    // xai: no reasoning_effort support even for reasoning models
    const xai = await runAndCapture(createModel({ provider: "xai", baseUrl: "https://api.x.ai/v1" }), { messages: [USER] }, { reasoningEffort: "high" });
    expect(xai.body.reasoning_effort).toBeUndefined();
  });

  it("omits tools entirely for empty arrays and emits tools: [] only with tool history", async () => {
    const empty = await runAndCapture(createModel(), { messages: [USER], tools: [] });
    expect("tools" in empty.body).toBe(false);

    const withHistory: Context = {
      messages: [
        USER,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
          api: "openai-completions",
          provider: "openai",
          model: "gpt-5-mini",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    const historyRun = await runAndCapture(createModel(), withHistory);
    expect(historyRun.body.tools).toEqual([]);
  });

  it("maps tools to function definitions with strict:false when supported", async () => {
    const tool: Tool = {
      name: "read",
      description: "Read file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    };
    const openai = await runAndCapture(createModel(), { messages: [USER], tools: [tool] });
    expect(openai.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
          strict: false,
        },
      },
    ]);

    // moonshotai detected: strict mode unsupported -> strict key absent
    const moonshot = await runAndCapture(createModel({ provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" }), { messages: [USER], tools: [tool] });
    expect(JSON.stringify(moonshot.body.tools)).not.toContain("strict");
  });

  it("dispatches thinking params by thinkingFormat", async () => {
    // openrouter: nested reasoning object
    const openrouter = await runAndCapture(createModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }), { messages: [USER] }, { reasoningEffort: "high" });
    expect(openrouter.body.reasoning).toEqual({ effort: "high" });
    expect(openrouter.body.reasoning_effort).toBeUndefined();

    // openrouter with thinkingLevelMap override
    const openrouterMapped = await runAndCapture(
      createModel({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        thinkingLevelMap: { high: "max" },
      }),
      { messages: [USER] },
      { reasoningEffort: "high" },
    );
    expect(openrouterMapped.body.reasoning).toEqual({ effort: "max" });

    // deepseek: thinking toggle + reasoning_effort
    const deepseek = await runAndCapture(createModel({ provider: "deepseek", baseUrl: "https://api.deepseek.com" }), { messages: [USER] }, { reasoningEffort: "high" });
    expect(deepseek.body.thinking).toEqual({ type: "enabled" });
    expect(deepseek.body.reasoning_effort).toBe("high");
    const deepseekOff = await runAndCapture(createModel({ provider: "deepseek", baseUrl: "https://api.deepseek.com" }), { messages: [USER] });
    expect(deepseekOff.body.thinking).toEqual({ type: "disabled" });

    // zai: enable_thinking only
    const zai = await runAndCapture(createModel({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4" }), { messages: [USER] }, { reasoningEffort: "high" });
    expect(zai.body.enable_thinking).toBe(true);
    expect(zai.body.reasoning_effort).toBeUndefined();
    const zaiOff = await runAndCapture(createModel({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4" }), { messages: [USER] });
    expect(zaiOff.body.enable_thinking).toBe(false);

    // qwen-chat-template: chat_template_kwargs
    const qwen = await runAndCapture(
      createModel({ provider: "alibaba", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", compat: { thinkingFormat: "qwen-chat-template" } }),
      { messages: [USER] },
      { reasoningEffort: "high" },
    );
    expect(qwen.body.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });

    // plain openai: reasoning_effort; effort-off via thinkingLevelMap.off string
    const openai = await runAndCapture(createModel({ thinkingLevelMap: { off: "none" } }), { messages: [USER] });
    expect(openai.body.reasoning_effort).toBe("none");
  });

  it("sends prompt_cache_key for api.openai.com with a sessionId, and 24h retention for long caching", async () => {
    const openai = await runAndCapture(createModel(), { messages: [USER] }, { sessionId: "sess-1" });
    expect(openai.body.prompt_cache_key).toBe("sess-1");
    expect(openai.body.prompt_cache_retention).toBeUndefined();

    const long = await runAndCapture(createModel(), { messages: [USER] }, { sessionId: "sess-1", cacheRetention: "long" });
    expect(long.body.prompt_cache_retention).toBe("24h");

    const none = await runAndCapture(createModel(), { messages: [USER] }, { sessionId: "sess-1", cacheRetention: "none" });
    expect(none.body.prompt_cache_key).toBeUndefined();

    // Non-openai hosts only get a cache key under long retention.
    const other = await runAndCapture(createModel({ provider: "groq", baseUrl: "https://api.groq.com/openai/v1" }), { messages: [USER] }, { sessionId: "sess-1" });
    expect(other.body.prompt_cache_key).toBeUndefined();
  });

  it("applies anthropic-style cache_control markers for anthropic models on openrouter/prime-inference", async () => {
    const tool: Tool = { name: "read", description: "r", parameters: { type: "object", properties: {} } };
    const model = createModel({
      id: "anthropic/claude-sonnet-4",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    const { body } = await runAndCapture(model, { systemPrompt: "sys", messages: [USER], tools: [tool] });

    const sysMsg = body.messages[0];
    expect((sysMsg.content as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });
    const tools = body.tools as { cache_control?: unknown }[];
    expect(tools[tools.length - 1].cache_control).toEqual({ type: "ephemeral" });
    const lastMsg = body.messages[body.messages.length - 1];
    expect((lastMsg.content as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });

    // long retention upgrades the ttl
    const longRun = await runAndCapture(model, { systemPrompt: "sys", messages: [USER] }, { cacheRetention: "long" });
    expect((longRun.body.messages[0].content as { cache_control?: unknown }[])[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    // cacheRetention none: no markers at all
    const noneRun = await runAndCapture(model, { systemPrompt: "sys", messages: [USER] }, { cacheRetention: "none" });
    expect(typeof noneRun.body.messages[0].content).toBe("string");
    expect(JSON.stringify(noneRun.body)).not.toContain("cache_control");

    // non-anthropic model on the same provider: no markers
    const gpt = await runAndCapture(createModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }), { systemPrompt: "sys", messages: [USER] });
    expect(JSON.stringify(gpt.body)).not.toContain("cache_control");
  });

  it("frames tool results with tool role, batching consecutive results and hoisting images", async () => {
    const model = createModel({ input: ["text", "image"] });
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        { type: "toolCall", id: "call_2", name: "screenshot", arguments: {} },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2,
    };
    const results: ToolResultMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "text result" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "screenshot",
        content: [
          { type: "text", text: "captured" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 4,
      },
    ];
    const { body } = await runAndCapture(model, { messages: [USER, assistant, ...results] });

    const toolMsgs = body.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toEqual([
      { role: "tool", content: "text result", tool_call_id: "call_1" },
      { role: "tool", content: "captured", tool_call_id: "call_2" },
    ]);
    const imageMsg = body.messages[body.messages.length - 1];
    expect(imageMsg.role).toBe("user");
    expect(imageMsg.content).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("inserts assistant bridges and requires name when the provider demands them", async () => {
    const model = createModel({
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      compat: { requiresAssistantAfterToolResult: true, requiresToolResultName: true },
    });
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 2,
    };
    const { body } = await runAndCapture(model, {
      messages: [USER, {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 1,
      }, toolResult, { role: "user", content: "thanks", timestamp: 3 }],
    });

    const roles = body.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(body.messages[3].content).toBe("I have processed the tool results.");
    expect(body.messages[2].name).toBe("read");
  });

  it("replays deepseek reasoning through reasoning_content with the blank-field rule", async () => {
    const model = createModel({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const assistantWithThinking: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "pondered", thinkingSignature: "reasoning_content" },
        { type: "text", text: "answer" },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1,
    };
    const { body } = await runAndCapture(model, { messages: [USER, assistantWithThinking, { role: "user", content: "again", timestamp: 2 }] });
    const replay = body.messages[1];
    expect(replay.role).toBe("assistant");
    expect(replay.content).toBe("answer");
    expect(replay.reasoning_content).toBe("pondered");

    const plainAssistant: AssistantMessage = { ...assistantWithThinking, content: [{ type: "text", text: "hi" }] };
    const second = await runAndCapture(model, { messages: [USER, plainAssistant, { role: "user", content: "again", timestamp: 2 }] });
    expect(second.body.messages[1].reasoning_content).toBe("");
  });

  it("normalizes pipe-form tool call ids to the 40-char call-id form", async () => {
    const model = createModel();
    const longId = `call_AbcDef|fc_${"x".repeat(420)}+/=`;
    const context: Context = {
      messages: [
        { role: "user", content: "go", timestamp: 0 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: longId, name: "edit", arguments: {} }],
          api: "openai-responses",
          provider: "openai-codex",
          model: "gpt-5.3-codex",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: longId,
          toolName: "edit",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };
    const { body } = await runAndCapture(model, context);
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    const toolMsg = body.messages.find((m) => m.role === "tool");
    const callId = (assistantMsg?.tool_calls as { id: string }[])[0].id;
    expect(callId).toBe("call_AbcDef");
    expect(toolMsg?.tool_call_id).toBe("call_AbcDef");
  });
});

describe("openai-completions SSE conformance", () => {
  it("streams text deltas into a text block and completes with usage", async () => {
    const stub = stubFetch(() => sseResponse(stopChunks({ prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } })));
    try {
      const events = await collectEvents(streamOpenAICompletions(createModel(), { messages: [USER] }, { apiKey: "k" }));
      expectEventProtocolConformance(events);
      expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
      const done = events[events.length - 1];
      if (done.type !== "done") throw new Error("expected done");
      expect(done.message.content).toEqual([{ type: "text", text: "Hello" }]);
      expect(done.message.usage.input).toBe(6); // 10 prompt - 4 cached
      expect(done.message.usage.cacheRead).toBe(4);
      expect(done.message.responseId).toBe("chatcmpl-1");
    } finally {
      stub.restore();
    }
  });

  it("routes reasoning_content into a thinking block keyed by the field name", async () => {
    const stub = stubFetch(() =>
      sseResponse([
        chunk({
          id: "c1",
          model: "m",
          choices: [{ delta: { reasoning_content: "thinking " }, finish_reason: null }],
        }),
        chunk({
          id: "c1",
          model: "m",
          choices: [{ delta: { reasoning: "more" }, finish_reason: null }],
        }),
        chunk({ id: "c1", model: "m", choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }),
        { data: "[DONE]" },
      ]),
    );
    try {
      const events = await collectEvents(
        streamOpenAICompletions(createModel({ provider: "deepseek", baseUrl: "https://api.deepseek.com" }), { messages: [USER] }, { apiKey: "k" }),
      );
      expectEventProtocolConformance(events);
      const done = events[events.length - 1];
      if (done.type !== "done") throw new Error("expected done");
      // first non-empty reasoning field wins per delta; the block records the field
      expect(done.message.content[0]).toMatchObject({ type: "thinking", thinking: "thinking more", thinkingSignature: "reasoning_content" });
    } finally {
      stub.restore();
    }
  });

  it("assembles tool calls across index-based and id-only deltas with arg repair", async () => {
    const stub = stubFetch(() =>
      sseResponse([
        chunk({
          id: "c1",
          model: "m",
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{\"pa" } },
                  { index: 1, id: "call_2", type: "function", function: { name: "grep", arguments: "" } },
                ],
              },
            },
          ],
        }),
        chunk({
          id: "c1",
          model: "m",
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: "th\":\"a.ts\"}" } },
                  // id-only follow-up delta, no index (seen on some gateways)
                  { id: "call_2", function: { arguments: "{\"q\":\"x\"" } },
                ],
              },
            },
          ],
        }),
        chunk({
          id: "c1",
          model: "m",
          choices: [
            {
              delta: {
                tool_calls: [{ id: "call_2", function: { arguments: "}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { data: "[DONE]" },
      ]),
    );
    try {
      const events = await collectEvents(streamOpenAICompletions(createModel(), { messages: [USER] }, { apiKey: "k" }));
      expectEventProtocolConformance(events);
      const done = events[events.length - 1];
      if (done.type !== "done") throw new Error("expected done");
      expect(done.message.stopReason).toBe("toolUse");
      const calls = done.message.content.filter((b) => b.type === "toolCall");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ id: "call_1", name: "read", arguments: { path: "a.ts" } });
      expect(calls[1]).toMatchObject({ id: "call_2", name: "grep", arguments: { q: "x" } });
      for (const call of calls) {
        expect("partialArgs" in (call as object)).toBe(false);
        expect("streamIndex" in (call as object)).toBe(false);
      }
      // toolcall_start events precede their deltas
      const names = events.map((e) => e.type);
      expect(names.indexOf("toolcall_start")).toBeLessThan(names.indexOf("toolcall_delta"));
      const ends = events.filter((e) => e.type === "toolcall_end");
      expect(ends).toHaveLength(2);
    } finally {
      stub.restore();
    }
  });

  it("attaches reasoning.encrypted details as thoughtSignature on the matching tool call", async () => {
    const encrypted = { type: "reasoning.encrypted", id: "call_1", data: "opaque" };
    const stub = stubFetch(() =>
      sseResponse([
        chunk({
          id: "c1",
          model: "m",
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
                reasoning_details: [encrypted],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        chunk({ id: "c1", model: "m", choices: [] }),
        { data: "[DONE]" },
      ]),
    );
    try {
      const message = await streamOpenAICompletions(createModel(), { messages: [USER] }, { apiKey: "k" }).result();
      const toolCall = message.content.find((b) => b.type === "toolCall");
      expect(toolCall?.thoughtSignature).toBe(JSON.stringify(encrypted));
    } finally {
      stub.restore();
    }
  });

  it("records responseModel when the provider reports a different model id", async () => {
    const stub = stubFetch(() =>
      sseResponse([
        chunk({ id: "c1", model: "anthropic/claude-sonnet-4", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
        { data: "[DONE]" },
      ]),
    );
    try {
      const message = await streamOpenAICompletions(
        createModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", id: "openrouter/auto" }),
        { messages: [USER] },
        { apiKey: "k" },
      ).result();
      expect(message.responseModel).toBe("anthropic/claude-sonnet-4");
    } finally {
      stub.restore();
    }
  });

  it("normalizes OpenRouter cache-write double counting out of cacheRead", async () => {
    const stub = stubFetch(() =>
      sseResponse(
        stopChunks({
          prompt_tokens: 160,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 80 },
        }),
      ),
    );
    try {
      const model = createModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } });
      const message = await streamOpenAICompletions(model, { messages: [USER] }, { apiKey: "k" }).result();
      expect(message.usage.cacheRead).toBe(0); // 80 reported - 80 write
      expect(message.usage.cacheWrite).toBe(80);
      expect(message.usage.input).toBe(80);
      expect(message.usage.totalTokens).toBe(170);
    } finally {
      stub.restore();
    }
  });

  it("reads usage from choice.usage when chunk.usage is absent (Moonshot)", async () => {
    const stub = stubFetch(() =>
      sseResponse([
        chunk({
          id: "c1",
          model: "m",
          choices: [{ delta: {}, finish_reason: "stop", usage: { prompt_tokens: 7, completion_tokens: 3 } }],
        }),
        { data: "[DONE]" },
      ]),
    );
    try {
      const message = await streamOpenAICompletions(createModel(), { messages: [USER] }, { apiKey: "k" }).result();
      expect(message.usage.input).toBe(7);
      expect(message.usage.output).toBe(3);
    } finally {
      stub.restore();
    }
  });

  it.each([
    ["stop", "stop"],
    ["end", "stop"],
    ["length", "length"],
    ["tool_calls", "toolUse"],
    ["function_call", "toolUse"],
  ])("maps finish_reason %s -> %s", async (finishReason, expected) => {
    const stub = stubFetch(() =>
      sseResponse([chunk({ id: "c1", model: "m", choices: [{ delta: {}, finish_reason: finishReason }] }), { data: "[DONE]" }]),
    );
    try {
      const message = await streamOpenAICompletions(createModel(), { messages: [USER] }, { apiKey: "k" }).result();
      expect(message.stopReason).toBe(expected);
    } finally {
      stub.restore();
    }
  });

  it.each([
    ["content_filter", "Provider finish_reason: content_filter"],
    ["network_error", "Provider finish_reason: network_error"],
    ["weird_new_reason", "Provider finish_reason: weird_new_reason"],
  ])("maps error finish_reason %s to an error event", async (finishReason, expectedMessage) => {
    const stub = stubFetch(() =>
      sseResponse([chunk({ id: "c1", model: "m", choices: [{ delta: {}, finish_reason: finishReason }] }), { data: "[DONE]" }]),
    );
    try {
      const events = await collectEvents(streamOpenAICompletions(createModel(), { messages: [USER] }, { apiKey: "k" }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.errorMessage).toBe(expectedMessage);
    } finally {
      stub.restore();
    }
  });

  it("aborts mid-stream when the signal fires between chunks", async () => {
    const controller = new AbortController();
    const stub = stubFetch(() =>
      sseResponse(stopChunks()),
    );
    try {
      const eventsPromise = collectEvents(
        streamOpenAICompletions(createModel(), { messages: [USER] }, {
          apiKey: "k",
          signal: controller.signal,
          onResponse: () => controller.abort(),
        }),
      );
      const events = await eventsPromise;
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.reason).toBe("aborted");
      expect(terminal.error.errorMessage).toBe("Request was aborted");
    } finally {
      stub.restore();
    }
  });

  it("surfaces HTTP error bodies with the parsed message and appended OpenRouter raw metadata", async () => {
    const stub = stubFetch(() =>
      jsonResponse(
        { error: { message: "Invalid API key", type: "authentication_error", metadata: { raw: "upstream rejected key" } } },
        { status: 401 },
      ),
    );
    try {
      const events = await collectEvents(streamOpenAICompletions(createModel(), { messages: [USER] }, { apiKey: "k", maxRetries: 0 }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.errorMessage).toContain("401");
      expect(terminal.error.errorMessage).toContain("Invalid API key");
      expect(terminal.error.errorMessage).toContain("upstream rejected key");
      // structural diagnostics preserved (deliberate upstream normalization)
      expect(terminal.error.diagnostics?.[0]?.code).toBe("provider_stream_failure");
      const detail = JSON.parse(terminal.error.diagnostics?.[0]?.detail ?? "{}");
      expect(detail).toMatchObject({ kind: "auth", status: 401 });
    } finally {
      stub.restore();
    }
  });
});
