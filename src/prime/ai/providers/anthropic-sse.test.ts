import { describe, expect, it } from "vitest";
import type { Context, Model } from "../index";
import { streamAnthropic } from "./anthropic";
import {
  collectEvents,
  expectEventProtocolConformance,
  jsonResponse,
  sseBody,
  sseJson,
  sseResponse,
  stubFetch,
} from "./provider.test-support";

/**
 * Anthropic SSE → AssistantMessageEvent conformance: event ordering, block
 * assembly (including malformed JSON recovery), usage + cache-pricing
 * mapping, stop-reason mapping, aborts, HTTP errors, and in-stream error
 * events. Ports the fetch-stub-compatible core of upstream
 * anthropic-sse-parsing.test.ts.
 */

function createModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
  return {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    // 1 $/MTok input, standard 1.25x 5m cache write pricing
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 64000,
    ...overrides,
  };
}

const CONTEXT: Context = {
  messages: [{ role: "user", content: "Say hello.", timestamp: 1 }],
};

function messageStart(usage: Record<string, unknown> = {}, id = "msg_test") {
  return sseJson("message_start", {
    type: "message_start",
    message: {
      id,
      usage: {
        input_tokens: 12,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        ...usage,
      },
    },
  });
}

function messageDelta(stopReason: string, usage: Record<string, unknown> = {}) {
  return sseJson("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
  });
}

function textConversation(text: string): Parameters<typeof sseResponse>[0] {
  return [
    messageStart(),
    sseJson("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sseJson("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    sseJson("content_block_stop", { type: "content_block_stop", index: 0 }),
    messageDelta("end_turn"),
    sseJson("message_stop", { type: "message_stop" }),
  ];
}

describe("anthropic SSE conformance", () => {
  it("emits start, ordered block events, exactly one terminal, and usage from message_delta", async () => {
    const stub = stubFetch(() => sseResponse(textConversation("Hello world")));
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }));
      expectEventProtocolConformance(events);

      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "start",
        "text_start",
        "text_delta",
        "text_end",
        "done",
      ]);
      const done = events[events.length - 1];
      if (done.type !== "done") throw new Error("expected done");
      expect(done.message.stopReason).toBe("stop");
      expect(done.message.responseId).toBe("msg_test");
      expect(done.message.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(done.message.usage).toMatchObject({ input: 12, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 17 });
    } finally {
      stub.restore();
    }
  });

  it("maps thinking blocks and accumulates signature deltas without emitting events for them", async () => {
    const records = [
      messageStart(),
      sseJson("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      sseJson("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me " },
      }),
      sseJson("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "think." },
      }),
      sseJson("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig_part1" },
      }),
      sseJson("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "_part2" },
      }),
      sseJson("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageDelta("end_turn"),
      sseJson("message_stop", { type: "message_stop" }),
    ];
    const stub = stubFetch(() => sseResponse(records));
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }));
      expectEventProtocolConformance(events);
      const unexpected = events.filter((e) => !(e.type === "start" || e.type === "done" || e.type.startsWith("thinking_")));
      expect(unexpected).toEqual([]);
      const done = events[events.length - 1];
      if (done.type !== "done") throw new Error("expected done");
      expect(done.message.content).toEqual([
        { type: "thinking", thinking: "Let me think.", thinkingSignature: "sig_part1_part2" },
      ]);
    } finally {
      stub.restore();
    }
  });

  it("maps redacted_thinking blocks with the opaque data as signature", async () => {
    const stub = stubFetch(() =>
      sseResponse([
        messageStart(),
        sseJson("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "redacted_thinking", data: "encrypted_payload" },
        }),
        sseJson("content_block_stop", { type: "content_block_stop", index: 0 }),
        messageDelta("end_turn"),
        sseJson("message_stop", { type: "message_stop" }),
      ]),
    );
    try {
      const message = await streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }).result();
      expect(message.content).toEqual([
        {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: "encrypted_payload",
          redacted: true,
        },
      ]);
    } finally {
      stub.restore();
    }
  });

  it("assembles tool calls and repairs malformed streamed JSON", async () => {
    // Port of upstream's malformed-SSE/tool-JSON repair case.
    const malformedToolJsonDelta = String.raw`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"A\H\",\"text\":\"col1	col2\"}"}}`;
    const records = [
      messageStart(),
      sseJson("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_test", name: "edit", input: {} },
      }),
      { event: "content_block_delta", data: malformedToolJsonDelta },
      sseJson("content_block_stop", { type: "content_block_stop", index: 0 }),
      messageDelta("tool_use"),
      sseJson("message_stop", { type: "message_stop" }),
    ];
    const stub = stubFetch(() => sseResponse(records));
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }));
      expectEventProtocolConformance(events);
      const done = events[events.length - 1];
      if (done.type !== "done") throw new Error("expected done");
      expect(done.message.stopReason).toBe("toolUse");
      const toolCall = done.message.content.find((b) => b.type === "toolCall");
      expect(toolCall).toMatchObject({
        type: "toolCall",
        id: "toolu_test",
        name: "edit",
        arguments: { path: "A\\H", text: "col1\tcol2" },
      });
      expect("partialJson" in (toolCall as object)).toBe(false);
      expect("index" in (toolCall as object)).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("orders events by contentIndex across interleaved blocks", async () => {
    const records = [
      messageStart(),
      sseJson("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sseJson("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } }),
      sseJson("content_block_stop", { type: "content_block_stop", index: 0 }),
      sseJson("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      sseJson("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "B" } }),
      sseJson("content_block_stop", { type: "content_block_stop", index: 1 }),
      messageDelta("end_turn"),
      sseJson("message_stop", { type: "message_stop" }),
    ];
    const stub = stubFetch(() => sseResponse(records));
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }));
      expectEventProtocolConformance(events);
      expect(events[1]).toMatchObject({ type: "text_start", contentIndex: 0 });
      expect(events[2]).toMatchObject({ type: "text_delta", contentIndex: 0 });
      expect(events[3]).toMatchObject({ type: "text_end", contentIndex: 0 });
      expect(events[4]).toMatchObject({ type: "text_start", contentIndex: 1 });
      expect(events[6]).toMatchObject({ type: "text_end", contentIndex: 1 });
    } finally {
      stub.restore();
    }
  });

  it("treats a stream ending before message_stop as malformed", async () => {
    const stub = stubFetch(() =>
      sseResponse([
        messageStart(),
        sseJson("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      ]),
    );
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.stopReason).toBe("error");
      expect(terminal.error.errorMessage).toBe("Anthropic stream ended before message_stop");
      expect(terminal.error.diagnostics?.[0]?.code).toBe("provider_stream_failure");
      const detail = JSON.parse(terminal.error.diagnostics?.[0]?.detail ?? "{}");
      expect(detail.kind).toBe("malformed_response");
    } finally {
      stub.restore();
    }
  });

  it("ignores unknown SSE events after message_stop", async () => {
    const stub = stubFetch(() =>
      sseResponse([
        ...textConversation("Hello"),
        { event: "done", data: "[DONE]" },
        { event: "proxy.stats", data: "not json" },
      ]),
    );
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "done") throw new Error("expected done");
      expect(terminal.message.content).toEqual([{ type: "text", text: "Hello" }]);
    } finally {
      stub.restore();
    }
  });

  it.each([
    ["end_turn", "stop", undefined, undefined],
    ["stop_sequence", "stop", undefined, undefined],
    ["pause_turn", "stop", undefined, undefined],
    ["max_tokens", "length", undefined, undefined],
    ["tool_use", "toolUse", undefined, undefined],
    ["refusal", "error", "refusal", "Model refused to respond (refusal)"],
    ["sensitive", "error", "sensitive", "Response blocked by provider safety filters (sensitive)"],
  ])("maps stop reason %s to %s", async (raw, expected, expectedRaw, expectedMessage) => {
    const stub = stubFetch(() => sseResponse([messageStart(), messageDelta(raw), sseJson("message_stop", { type: "message_stop" })]));
    try {
      const message = await streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }).result();
      expect(message.stopReason).toBe(expected);
      expect(message.stopReasonRaw).toBe(expectedRaw);
      if (expectedMessage !== undefined) {
        expect(message.errorMessage).toBe(expectedMessage);
      }
    } finally {
      stub.restore();
    }
  });

  it("classifies in-stream error SSE events by provider error type", async () => {
    const stub = stubFetch(() =>
      sseResponse([
        messageStart(),
        {
          event: "error",
          data: JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
            request_id: "req_xyz",
          }),
        },
      ]),
    );
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.errorMessage).toBe("Provider overloaded (overloaded_error): Overloaded [request_id: req_xyz]");
      const detail = JSON.parse(terminal.error.diagnostics?.[0]?.detail ?? "{}");
      expect(detail.kind).toBe("overloaded");
      expect(detail.requestId).toBe("req_xyz");
    } finally {
      stub.restore();
    }
  });

  it("retains usage captured at message_start when the stream fails mid-conversation", async () => {
    // Invariant: usage is captured from message_start FIRST so a stream that
    // dies before message_delta still reports its input counts.
    const stub = stubFetch(() =>
      sseResponse([
        messageStart({ input_tokens: 100 }),
        {
          event: "error",
          data: JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal error" } }),
        },
      ]),
    );
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.stopReason).toBe("error");
      expect(terminal.error.usage.input).toBe(100);
      expect(terminal.error.errorMessage).toBe("Provider server error (api_error): Internal error");
    } finally {
      stub.restore();
    }
  });
});

describe("anthropic HTTP failure taxonomy", () => {
  it("maps a 429 JSON error body to a rate_limit error with structure preserved", async () => {
    const stub = stubFetch(() =>
      jsonResponse(
        { type: "error", error: { type: "rate_limit_error", message: "Number of requests exceeded" } },
        { status: 429, headers: { "request-id": "req_rl" } },
      ),
    );
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k", maxRetries: 0 }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.errorMessage).toBe(
        "Provider rate limit exceeded (rate_limit_error, 429): Number of requests exceeded [request_id: req_rl]",
      );
      const detail = JSON.parse(terminal.error.diagnostics?.[0]?.detail ?? "{}");
      expect(detail).toMatchObject({ kind: "rate_limit", status: 429, providerErrorType: "rate_limit_error", requestId: "req_rl" });
    } finally {
      stub.restore();
    }
  });

  it("maps a bare 529 to overloaded without leaking the html body", async () => {
    const stub = stubFetch(() => jsonResponse("<html>Service Unavailable</html>", { status: 529 }));
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k", maxRetries: 0 }));
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.errorMessage).toBe("Provider overloaded (529)");
    } finally {
      stub.restore();
    }
  });

  it("retries retryable statuses honoring retry-after before surfacing", async () => {
    let calls = 0;
    const stub = stubFetch(() => {
      calls += 1;
      if (calls < 3) {
        return jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529, headers: { "retry-after-ms": "1" } });
      }
      return sseResponse(textConversation("recovered"));
    });
    const started = Date.now();
    try {
      const message = await streamAnthropic(createModel(), CONTEXT, { apiKey: "k" }).result();
      expect(message.stopReason).toBe("stop");
      expect(calls).toBe(3);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      stub.restore();
    }
  });

  it("surfaces the classified error after the retry budget is exhausted", async () => {
    let calls = 0;
    const stub = stubFetch(() => {
      calls += 1;
      return jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529, headers: { "retry-after-ms": "1" } });
    });
    try {
      const events = await collectEvents(
        streamAnthropic(createModel(), CONTEXT, { apiKey: "k", maxRetries: 2 }),
      );
      expect(calls).toBe(3); // initial + 2 retries
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.errorMessage).toContain("Provider overloaded (overloaded_error, 529): Overloaded");
    } finally {
      stub.restore();
    }
  });

  it("does not retry non-retryable statuses", async () => {
    let calls = 0;
    const stub = stubFetch(() => {
      calls += 1;
      return jsonResponse({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, { status: 400 });
    });
    try {
      const events = await collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k", maxRetries: 3 }));
      expect(calls).toBe(1);
      const terminal = events[events.length - 1];
      if (terminal.type !== "error") throw new Error("expected error event");
      expect(terminal.error.errorMessage).toBe("Provider rejected the request (invalid_request_error, 400): bad");
    } finally {
      stub.restore();
    }
  });

  it("aborts a pending request instead of starting the stream when the signal is already aborted", async () => {
    const controller = new AbortController();
    const stub = stubFetch(() => sseResponse(textConversation("late")));
    try {
      const eventsPromise = collectEvents(streamAnthropic(createModel(), CONTEXT, { apiKey: "k", signal: controller.signal }));
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

describe("anthropic cache write pricing (ported from upstream anthropic-sse-parsing)", () => {
  function cacheConversation(cacheCreation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number }) {
    const cacheWriteTokens = cacheCreation.ephemeral_5m_input_tokens + cacheCreation.ephemeral_1h_input_tokens;
    return [
      messageStart({ cache_creation_input_tokens: cacheWriteTokens, cache_creation: cacheCreation }, "msg_cache"),
      messageDelta("end_turn", { cache_creation_input_tokens: cacheWriteTokens, output_tokens: 5 }),
      sseJson("message_stop", { type: "message_stop" }),
    ];
  }

  it.each([
    ["five-minute writes", "short" as const, { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 }, 0.00125],
    ["one-hour writes", "long" as const, { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 }, 0.002],
    ["mixed TTL writes", "long" as const, { ephemeral_5m_input_tokens: 250, ephemeral_1h_input_tokens: 750 }, 0.0018125],
  ])("prices %s from the reported usage breakdown", async (_name, cacheRetention, cacheCreation, expectedCost) => {
    const stub = stubFetch(() => sseResponse(cacheConversation(cacheCreation)));
    try {
      const message = await streamAnthropic(createModel(), CONTEXT, { apiKey: "k", cacheRetention }).result();
      expect(message.usage.cacheWrite).toBe(1000);
      expect(message.usage.cost.cacheWrite).toBeCloseTo(expectedCost);
    } finally {
      stub.restore();
    }
  });

  it("preserves configured cache write pricing for non-Anthropic-pricing models", async () => {
    const model = createModel({
      id: "MiniMax-M2.7-highspeed",
      provider: "minimax",
      baseUrl: "https://api.minimax.io/anthropic",
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
    });
    const stub = stubFetch(() =>
      sseResponse(cacheConversation({ ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 })),
    );
    try {
      const message = await streamAnthropic(model, CONTEXT, { apiKey: "k" }).result();
      expect(message.usage.cacheWrite).toBe(1000);
      expect(message.usage.cost.cacheWrite).toBeCloseTo((1000 * model.cost.cacheWrite) / 1_000_000);
    } finally {
      stub.restore();
    }
  });
});
