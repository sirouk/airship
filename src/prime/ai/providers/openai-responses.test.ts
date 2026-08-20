import { describe, expect, it } from "vitest";
import { shortHash } from "../hash";
import type { AssistantMessage, Context, Model, Tool, ToolResultMessage } from "../types";
import { createAssistantMessageEventStream } from "../event-stream";
import { streamOpenAIResponses, type OpenAIResponsesOptions } from "./openai-responses";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
  type ResponsesInput,
  type ResponsesStreamEvent,
} from "./openai-responses-shared";
import {
  collectEvents,
  expectEventProtocolConformance,
  jsonResponse,
  sseJson,
  sseResponse,
  stubFetch,
  type CapturedRequest,
} from "./provider.test-support";

/**
 * OpenAI Responses provider: input-item goldens (signature/id replay
 * policy), stream conformance through the SSE lifecycle, usage + service-tier
 * cost mapping, stop mapping, aborts and HTTP errors. Ports the
 * fetch-stub-compatible upstream cases (partial-json cleanup, foreign id
 * hashing, empty tool results).
 */

const USAGE_ZERO = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
  return {
    id: "gpt-5-mini",
    name: "GPT 5 Mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
    ...overrides,
  };
}

const USER: Context["messages"][number] = { role: "user", content: "hi", timestamp: 1 };

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5-mini",
    usage: { ...USAGE_ZERO, cost: { ...USAGE_ZERO.cost } },
    stopReason: "stop",
    timestamp: 2,
    ...overrides,
  };
}

function ev(event: string, payload: Record<string, unknown>): { event: string; data: string } {
  return { event, data: JSON.stringify(payload) };
}

function completedResponse(overrides: Record<string, unknown> = {}): { event: string; data: string } {
  return ev("response.completed", {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 30 } },
      ...overrides,
    },
  });
}

function textConversation(text: string): Parameters<typeof sseResponse>[0] {
  return [
    ev("response.created", { type: "response.created", response: { id: "resp_1" } }),
    ev("response.output_item.added", { type: "response.output_item.added", item: { type: "message", id: "msg_1" } }),
    ev("response.content_part.added", { type: "response.content_part.added", part: { type: "output_text", text: "" } }),
    ev("response.output_text.delta", { type: "response.output_text.delta", delta: text }),
    ev("response.output_item.done", {
      type: "response.output_item.done",
      item: { type: "message", id: "msg_1", content: [{ type: "output_text", text }] },
    }),
    completedResponse(),
  ];
}

async function runAndCapture(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
): Promise<{ request: CapturedRequest; body: Record<string, unknown>; message: AssistantMessage }> {
  const stub = stubFetch(() => sseResponse(textConversation("Hello")));
  try {
    const message = await streamOpenAIResponses(model, context, { apiKey: "test-key", ...options }).result();
    if (stub.requests.length !== 1) throw new Error(`expected 1 request, got ${stub.requests.length}`);
    const request = stub.requests[0];
    return { request, message, body: request.body as Record<string, unknown> };
  } finally {
    stub.restore();
  }
}

describe("openai-responses request construction", () => {
  it("posts to {baseUrl}/responses with store:false and cache-affinity knobs", async () => {
    const { request, body } = await runAndCapture(createModel(), { messages: [USER] }, { sessionId: "sess-1" });
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.Authorization).toBe("Bearer test-key");
    expect(request.headers.session_id).toBe("sess-1");
    expect(request.headers["x-client-request-id"]).toBe("sess-1");
    expect(body.store).toBe(false);
    expect(body.prompt_cache_key).toBe("sess-1");
    expect(body.prompt_cache_retention).toBeUndefined();
  });

  it("sends prompt_cache_retention 24h under long cache retention and drops affinity under none", async () => {
    const longRun = await runAndCapture(createModel(), { messages: [USER] }, { sessionId: "s", cacheRetention: "long" });
    expect(longRun.body.prompt_cache_retention).toBe("24h");

    const noRetention = await runAndCapture(createModel(), { messages: [USER] }, { sessionId: "s", cacheRetention: "none" });
    expect(noRetention.body.prompt_cache_key).toBeUndefined();
    expect(noRetention.request.headers.session_id).toBeUndefined();

    const noSessionHeader = await runAndCapture(createModel({ compat: { sendSessionIdHeader: false } }), { messages: [USER] }, { sessionId: "s" });
    expect(noSessionHeader.request.headers.session_id).toBeUndefined();
    expect(noSessionHeader.request.headers["x-client-request-id"]).toBe("s");
  });

  it("requests encrypted reasoning content and maps effort through thinkingLevelMap", async () => {
    const { body } = await runAndCapture(createModel({ thinkingLevelMap: { high: "max" } }), { messages: [USER] }, { reasoningEffort: "high" });
    expect(body.reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);

    const summary = await runAndCapture(createModel(), { messages: [USER] }, { reasoningSummary: "detailed" });
    expect(summary.body.reasoning).toEqual({ effort: "medium", summary: "detailed" });

    // No effort requested: the off-state effort is sent unless explicitly null.
    const off = await runAndCapture(createModel(), { messages: [USER] });
    expect(off.body.reasoning).toEqual({ effort: "none" });

    // github-copilot never receives a reasoning field
    const copilot = await runAndCapture(
      createModel({ provider: "github-copilot", baseUrl: "https://api.githubcopilot.com" }),
      { messages: [USER] },
    );
    expect(copilot.body.reasoning).toBeUndefined();
  });

  it("maps tools and passes service tier through", async () => {
    const tool: Tool = { name: "read", description: "r", parameters: { type: "object", properties: { path: { type: "string" } } } };
    const { body } = await runAndCapture(createModel(), { messages: [USER], tools: [tool] }, { serviceTier: "priority" });
    expect(body.tools).toEqual([
      { type: "function", name: "read", description: "r", parameters: { type: "object", properties: { path: { type: "string" } } }, strict: false },
    ]);
    expect(body.service_tier).toBe("priority");
  });
});

describe("openai-responses convertResponsesMessages", () => {
  const model = createModel();
  const OPENAI_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

  it("emits the system prompt as a developer message for reasoning models", () => {
    const input = convertResponsesMessages(model, { systemPrompt: "sys", messages: [USER] }, OPENAI_PROVIDERS);
    expect(input[0]).toEqual({ role: "developer", content: "sys" });

    const plain = convertResponsesMessages(createModel({ reasoning: false }), { systemPrompt: "sys", messages: [USER] }, OPENAI_PROVIDERS);
    expect(plain[0]).toEqual({ role: "system", content: "sys" });
  });

  it("replays text with its TextSignatureV1 id and phase; synthesizes ids otherwise", () => {
    const signed = assistant([
      {
        type: "text",
        text: "first",
        textSignature: JSON.stringify({ v: 1, id: "msg_real_id", phase: "commentary" }),
      },
    ]);
    const unsigned = assistant([{ type: "text", text: "second" }], { timestamp: 3 });
    const input = convertResponsesMessages(model, { messages: [USER, signed, USER, unsigned] }, OPENAI_PROVIDERS);

    const firstMessage = input.find((i): i is Extract<typeof i, { type: "message" }> => (i as { type?: string }).type === "message");
    expect(firstMessage).toMatchObject({ id: "msg_real_id", phase: "commentary" });

    const messages = input.filter((i): i is Extract<typeof i, { type: "message" }> => (i as { type?: string }).type === "message");
    expect(messages[1]?.id).toBe("msg_3");
  });

  it("hashes over-long message ids to msg_<shortHash>", () => {
    const longId = `msg_${"x".repeat(200)}`;
    const signed = assistant([{ type: "text", text: "t", textSignature: JSON.stringify({ v: 1, id: longId }) }]);
    const input = convertResponsesMessages(model, { messages: [USER, signed] }, OPENAI_PROVIDERS);
    const msg = input.find((i) => (i as { type?: string }).type === "message");
    expect((msg as { id: string }).id).toBe(`msg_${shortHash(longId)}`);
    expect((msg as { id: string }).id.length).toBeLessThanOrEqual(64);
  });

  it("replays signed reasoning items verbatim", () => {
    const reasoningItem = { type: "reasoning", id: "rs_abc", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "enc" };
    const signed = assistant([{ type: "thinking", thinking: "thought", thinkingSignature: JSON.stringify(reasoningItem) }]);
    const input = convertResponsesMessages(model, { messages: [USER, signed] }, OPENAI_PROVIDERS);
    expect(input[1]).toEqual(reasoningItem);
  });

  it("keeps pipe-form ids for same-provider calls and builds function_call_output", () => {
    const call = assistant([{ type: "toolCall", id: "call_1|fc_abc", name: "read", arguments: { path: "a" } }], { stopReason: "toolUse" });
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1|fc_abc",
      toolName: "read",
      content: [{ type: "text", text: "content" }],
      isError: false,
      timestamp: 2,
    };
    const input = convertResponsesMessages(model, { messages: [USER, call, result] }, OPENAI_PROVIDERS);
    expect(input[1]).toEqual({ type: "function_call", id: "fc_abc", call_id: "call_1", name: "read", arguments: '{"path":"a"}' });
    expect(input[2]).toEqual({ type: "function_call_output", call_id: "call_1", output: "content" });
  });

  it("hashes foreign tool item ids into fc_<shortHash> (ported upstream case)", () => {
    const rawId = `call_4VnzVawQ|${"I9b95oN1wD/cHXK+Pw==".repeat(4)}`;
    const foreign = assistant([{ type: "toolCall", id: rawId, name: "edit", arguments: { path: "p" } }], {
      provider: "github-copilot",
      stopReason: "toolUse",
    });
    const input = convertResponsesMessages(createModel({ provider: "openai-codex" }), { messages: [USER, foreign] }, OPENAI_PROVIDERS);
    const fn = input.find((i) => (i as { type?: string }).type === "function_call");

    const expectedItemId = `fc_${shortHash(rawId.split("|")[1])}`;
    expect((fn as { id: string }).id).toBe(expectedItemId);
    expect((fn as { id: string }).id).toMatch(/^fc_[A-Za-z0-9]+$/);
    expect((fn as { id: string }).id.length).toBeLessThanOrEqual(64);
  });

  it("omits fc_ ids when replaying a different model of the same provider/api", () => {
    const otherModel = assistant([{ type: "toolCall", id: "call_1|fc_abc", name: "read", arguments: {} }], {
      model: "gpt-5.1",
      stopReason: "toolUse",
    });
    const input = convertResponsesMessages(model, { messages: [USER, otherModel] }, OPENAI_PROVIDERS);
    const fn = input.find((i) => (i as { type?: string }).type === "function_call");
    expect((fn as { id?: string }).id).toBeUndefined();

    // same model: id preserved
    const same = convertResponsesMessages(model, { messages: [USER, assistant([{ type: "toolCall", id: "call_1|fc_abc", name: "read", arguments: {} }], { stopReason: "toolUse" })] }, OPENAI_PROVIDERS);
    const fnSame = same.find((i) => (i as { type?: string }).type === "function_call");
    expect((fnSame as { id?: string }).id).toBe("fc_abc");
  });

  it("does not emit the image placeholder for empty-text tool results without images", () => {
    // Ported from upstream openai-responses-empty-tool-result.test.ts.
    const call = assistant([{ type: "toolCall", id: "tool-1", name: "bash", arguments: { cmd: "true" } }], { stopReason: "toolUse", model: "gpt-4o-mini" });
    const emptyResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: "" }],
      isError: false,
      timestamp: 2,
    };
    const input = convertResponsesMessages(model, { messages: [USER, call, emptyResult] }, OPENAI_PROVIDERS);
    const output = input.find((i) => (i as { type?: string }).type === "function_call_output");
    expect((output as { output: string }).output).toBe("");
  });

  it("attaches images for tool results with images when the model accepts them", () => {
    const call = assistant([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }], { stopReason: "toolUse" });
    const imageResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
      isError: false,
      timestamp: 2,
    };
    const input = convertResponsesMessages(model, { messages: [USER, call, imageResult] }, OPENAI_PROVIDERS);
    const output = input.find((i) => (i as { type?: string }).type === "function_call_output");
    const parts = (output as { output: { type: string }[] }).output;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p: { type: string }) => p.type === "input_image")).toBe(true);
  });

  it("converts tools with strict:false by default and honors strict:null", () => {
    const tools: Tool[] = [{ name: "t", description: "d", parameters: { type: "object" } }];
    expect(convertResponsesTools(tools)[0].strict).toBe(false);
    expect(convertResponsesTools(tools, { strict: null })[0].strict).toBeNull();
  });
});

describe("openai-responses stream conformance", () => {
  it("emits the full event lattice for a text turn and maps usage (input excludes cached)", async () => {
    const stub = stubFetch(() => sseResponse(textConversation("Hello")));
    try {
      const events = await collectEvents(streamOpenAIResponses(createModel(), { messages: [USER] }, { apiKey: "k" }));
      expectEventProtocolConformance(events);
      expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
      const done = events[events.length - 1];
      if (done.type !== "done") throw new Error("expected done");
      expect(done.message.stopReason).toBe("stop");
      expect(done.message.usage).toMatchObject({ input: 70, output: 10, cacheRead: 30, cacheWrite: 0, totalTokens: 110 });
      const text = done.message.content[0];
      expect(text).toMatchObject({ type: "text", text: "Hello" });
      expect((text as { textSignature?: string }).textSignature).toBe(JSON.stringify({ v: 1, id: "msg_1" }));
    } finally {
      stub.restore();
    }
  });

  it("assembles reasoning items from summary deltas and stores the item JSON as signature", async () => {
    const records = [
      ev("response.output_item.added", { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } }),
      ev("response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", part: { type: "summary_text", text: "" } }),
      ev("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "short " }),
      ev("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "summary" }),
      ev("response.output_item.done", {
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "short summary" }],
          encrypted_content: "encrypted",
        },
      }),
      completedResponse(),
    ];
    const stub = stubFetch(() => sseResponse(records));
    try {
      const events = await collectEvents(streamOpenAIResponses(createModel(), { messages: [USER] }, { apiKey: "k" }));
      expectEventProtocolConformance(events);
      const done = events[events.length - 1];
      if (done.type !== "done") throw new Error("expected done");
      const thinking = done.message.content[0];
      expect(thinking).toMatchObject({ type: "thinking", thinking: "short summary" });
      const signature = JSON.parse((thinking as { thinkingSignature: string }).thinkingSignature);
      expect(signature).toMatchObject({ type: "reasoning", id: "rs_1", encrypted_content: "encrypted" });
    } finally {
      stub.restore();
    }
  });

  it("streams function call arguments with done-event resync, then finalizes without scratch", async () => {
    const records = [
      ev("response.output_item.added", {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "edit", arguments: "" },
      }),
      ev("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", delta: '{"path":"a' }),
      ev("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", delta: '.ts"' }),
      // done carries the whole argument payload; only the missing suffix is emitted
      ev("response.function_call_arguments.done", { type: "response.function_call_arguments.done", arguments: '{"path":"a.ts","x":1}' }),
      ev("response.output_item.done", {
        type: "response.output_item.done",
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "edit", arguments: '{"path":"a.ts","x":1}' },
      }),
      completedResponse(),
    ];
    const stub = stubFetch(() => sseResponse(records));
    try {
      const events = await collectEvents(streamOpenAIResponses(createModel(), { messages: [USER] }, { apiKey: "k" }));
      expectEventProtocolConformance(events);
      const deltas = events.filter((e) => e.type === "toolcall_delta").map((e) => (e as { delta: string }).delta);
      expect(deltas.join("")).toBe('{"path":"a.ts","x":1}');
      const done = events[events.length - 1];
      if (done.type !== "done") throw new Error("expected done");
      // toolCall present -> stop promoted to toolUse
      expect(done.message.stopReason).toBe("toolUse");
      const call = done.message.content[0];
      expect(call).toMatchObject({ type: "toolCall", id: "call_1|fc_1", name: "edit", arguments: { path: "a.ts", x: 1 } });
      expect("partialJson" in (call as object)).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("cleans partialJson from persisted tool-call blocks (ported upstream direct test)", async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5-mini",
      usage: { ...USAGE_ZERO, cost: { ...USAGE_ZERO.cost } },
      stopReason: "stop",
      timestamp: 0,
    };
    const stream = createAssistantMessageEventStream();
    async function* eventsGen(): AsyncIterable<ResponsesStreamEvent> {
      yield {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_test", call_id: "call_test", name: "edit", arguments: "" },
      };
      yield { type: "response.function_call_arguments.delta", delta: '{"path":"README.md"' };
      yield { type: "response.function_call_arguments.delta", delta: ',"content":"updated"}' };
      const argsJson = '{"path":"README.md","content":"updated"}';
      yield { type: "response.function_call_arguments.done", arguments: argsJson };
      yield {
        type: "response.output_item.done",
        item: { type: "function_call", id: "fc_test", call_id: "call_test", name: "edit", arguments: argsJson },
      };
    }
    await processResponsesStream(eventsGen(), output, stream, createModel());
    expect(output.content).toHaveLength(1);
    const persisted = output.content[0];
    expect(persisted).toMatchObject({ type: "toolCall", arguments: { path: "README.md", content: "updated" } });
    expect("partialJson" in persisted).toBe(false);
  });

  it.each([
    ["completed", "stop", undefined],
    ["incomplete", "length", undefined],
    ["in_progress", "stop", undefined],
    ["queued", "stop", undefined],
    ["failed", "error", "failed"],
    ["cancelled", "error", "cancelled"],
  ])("maps response status %s -> %s", async (status, expected, expectedRaw) => {
    const stub = stubFetch(() =>
      sseResponse([
        ev("response.created", { type: "response.created", response: { id: "r" } }),
        completedResponse({ status, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } }),
      ]),
    );
    try {
      const message = await streamOpenAIResponses(createModel(), { messages: [USER] }, { apiKey: "k" }).result();
      expect(message.stopReason).toBe(expected);
      expect(message.stopReasonRaw).toBe(expectedRaw);
    } finally {
      stub.restore();
    }
  });

  it("applies flex and gpt-5.5 priority service-tier pricing from the response tier", async () => {
    const flexStub = stubFetch(() => sseResponse(textConversation("hi").concat(completedResponse({ service_tier: "flex" }))));
    try {
      const model = createModel({ cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 } });
      const message = await streamOpenAIResponses(model, { messages: [USER] }, { apiKey: "k" }).result();
      expect(message.usage.cost.input).toBeCloseTo(((70 / 1_000_000) * 1) * 0.5);
    } finally {
      flexStub.restore();
    }

    const priorityStub = stubFetch(() => sseResponse(textConversation("hi").concat(completedResponse({ service_tier: "priority" }))));
    try {
      const model = createModel({ id: "gpt-5.5" });
      const message = await streamOpenAIResponses(model, { messages: [USER] }, { apiKey: "k" }).result();
      expect(message.usage.cost.input).toBeCloseTo(((70 / 1_000_000) * 1) * 2.5);
    } finally {
      priorityStub.restore();
    }
  });

  it("turns response.failed and error SSE events into classified terminal errors", async () => {
    const failedStub = stubFetch(() =>
      sseResponse([
        ev("response.failed", {
          type: "response.failed",
          response: { error: { code: "rate_limit_exceeded", message: "slow down" } },
        }),
      ]),
    );
    try {
      const events = await collectEvents(streamOpenAIResponses(createModel(), { messages: [USER] }, { apiKey: "k" }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.errorMessage).toBe("rate_limit_exceeded: slow down");
      const detail = JSON.parse(terminal.error.diagnostics?.[0]?.detail ?? "{}");
      expect(detail.kind).toBe("rate_limit");
    } finally {
      failedStub.restore();
    }

    const errorStub = stubFetch(() => sseResponse([ev("error", { type: "error", code: "server_error", message: "boom" })]));
    try {
      const message = await streamOpenAIResponses(createModel(), { messages: [USER] }, { apiKey: "k" }).result();
      expect(message.errorMessage).toBe("Error Code server_error: boom");
    } finally {
      errorStub.restore();
    }
  });

  it("formats HTTP errors via the failure taxonomy", async () => {
    const stub = stubFetch(() =>
      jsonResponse({ error: { message: "Missing key", type: "authentication_error" } }, { status: 401, headers: { "x-request-id": "req_9" } }),
    );
    try {
      const events = await collectEvents(streamOpenAIResponses(createModel(), { messages: [USER] }, { apiKey: "k", maxRetries: 0 }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.errorMessage).toBe(
        "Provider authentication failed (authentication_error, 401): Missing key [request_id: req_9]",
      );
    } finally {
      stub.restore();
    }
  });

  it("aborts before streaming when the signal is already aborted", async () => {
    const controller = new AbortController();
    const stub = stubFetch(() => sseResponse(textConversation("late")));
    try {
      const eventsPromise = collectEvents(
        streamOpenAIResponses(createModel(), { messages: [USER] }, { apiKey: "k", signal: controller.signal }),
      );
      controller.abort();
      const events = await eventsPromise;
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.reason).toBe("aborted");
      expect(terminal.error.errorMessage).toBe("Request was aborted");
    } finally {
      stub.restore();
    }
  });
});
