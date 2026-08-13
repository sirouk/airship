import { describe, expect, it } from "vitest";
import type { ConversationReceipt } from "../receipts/types";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "../core/contracts";
import { UUID_V4_PATTERN } from "../core/id";
import { namedTransportFailure } from "../core/inference-retry";
import { createAssistantMessageEventStream } from "./ai/event-stream";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  StreamFunction,
  Usage,
} from "./ai/types";
import {
  PrimeBridgeTransportError,
  UNNAMED_TRANSPORT_FAILURE_CODE,
  createInferenceTransportForPrimeStream,
  createTransportForPrimeModel,
  primeDiagnosticsFromError,
  type PrimeModelStreamFunction,
} from "./transport-adapter";

/**
 * Golden mapping tests for the transport bridge. Scripted transports stand in
 * for the canonical side; scripted prime streams stand in for providers. The
 * round-trip suites pin the exact points where the two vocabularies lose
 * information, so a future "fix" that silently restores one of them fails here
 * until the loss is removed on purpose.
 */

const MODEL: Model<Api> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

function zeroUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

function makeReceipt(): ConversationReceipt {
  const claim = { status: "unavailable" as const, summary: "not applicable" };
  return {
    version: 1,
    receiptId: "urn:airship:receipt:test",
    sessionId: "s-1",
    turnId: "t-1",
    createdAt: "2024-01-01T00:00:00.000Z",
    proofLevel: "local",
    posture: "local",
    provider: "test-provider",
    claims: {
      encryption: claim,
      freshness: claim,
      cpuTee: claim,
      gpuTee: claim,
      endpointKey: claim,
      model: claim,
      conversation: claim,
      payment: claim,
    },
    bindings: { algorithm: "SHA-256" },
    verifications: [],
  };
}

type ScriptedTransport = InferenceTransport & Readonly<{ requests: InferenceRequest[] }>;

function scriptedTransport(events: readonly InferenceEvent[]): ScriptedTransport {
  const requests: InferenceRequest[] = [];
  return {
    id: "scripted",
    posture: "local",
    requests,
    async *stream(request: InferenceRequest) {
      requests.push(structuredClone(request));
      for (const event of events) yield event;
    },
  };
}

function failingTransport(error: unknown): InferenceTransport {
  return {
    id: "failing",
    posture: "local",
    async *stream() {
      throw error;
    },
  };
}

function structuralHttpError(): Error {
  return Object.assign(new Error("OpenAI rejected the request with HTTP 429."), {
    code: "http",
    status: 429,
    retryAfter: "7",
  });
}

async function collectPrime(iterable: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function collectInference(iterable: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function eventTypes(events: readonly AssistantMessageEvent[]): string[] {
  return events.map((event) => event.type);
}

function canonicalRequest(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    requestId: "r-1",
    sessionId: "s-1",
    turnId: "t-1",
    model: "test-model",
    systemPrompt: "You are an agent.",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    idempotencyKey: "s-1:t-1:1",
    ...overrides,
  };
}

function primeContext(overrides: Partial<Context> = {}): Context {
  return { messages: [{ role: "user", content: "hi", timestamp: 1 }], ...overrides };
}

/*
 * The seam the provider's reasoning died at.
 *
 * This bridge was written when `InferenceEvent` really did carry only a
 * reasoning *phase*, so it mapped `progress` to an empty thinking block and
 * said in as many words that "thinking_delta text never does" cross. Then
 * `reasoning-delta` joined the canonical vocabulary and every vendor transport
 * started emitting it — `chutes/openai.ts` from `delta.reasoning_content`,
 * `browser-cloud.ts` from `delta.thinking` — while this adapter still had no
 * branch for it. Prime became the default engine, prime reaches its provider
 * through here, and the live reasoning block had nothing to render: the phase
 * marker crossed, the words were dropped one layer above the wire.
 */
describe("reasoning text crosses the bridge in both directions", () => {
  it("turns canonical reasoning deltas into a filled prime thinking block", async () => {
    const transport = scriptedTransport([
      { type: "progress", phase: "reasoning" },
      { type: "reasoning-delta", text: "First the plan. " },
      { type: "reasoning-delta", text: "Then the answer." },
      { type: "text-delta", text: "The answer." },
      { type: "completed", finishReason: "stop" },
    ]);

    const events = await collectPrime(createTransportForPrimeModel(MODEL, transport)(MODEL, primeContext()));

    expect(eventTypes(events)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    const thinking = events.filter((event) => event.type === "thinking_delta");
    expect(thinking.map((event) => event.type === "thinking_delta" && event.delta))
      .toEqual(["First the plan. ", "Then the answer."]);
    // The block closes carrying the whole chain, so a consumer reading only
    // boundaries sees the same text as one reading deltas.
    expect(events.find((event) => event.type === "thinking_end"))
      .toMatchObject({ content: "First the plan. Then the answer." });
  });

  it("opens the block for a provider that streams reasoning without announcing a phase", async () => {
    const transport = scriptedTransport([
      { type: "reasoning-delta", text: "Straight into it." },
      { type: "completed", finishReason: "stop" },
    ]);

    const events = await collectPrime(createTransportForPrimeModel(MODEL, transport)(MODEL, primeContext()));

    expect(eventTypes(events)).toEqual(["start", "thinking_start", "thinking_delta", "thinking_end", "done"]);
  });

  it("still refuses to invent a delta for a phase that streamed nothing", async () => {
    // The honesty the original comment was protecting, kept: an announced
    // reasoning phase with no text is an empty block, not a fabricated one.
    const transport = scriptedTransport([
      { type: "progress", phase: "reasoning" },
      { type: "text-delta", text: "Answer." },
      { type: "completed", finishReason: "stop" },
    ]);

    const events = await collectPrime(createTransportForPrimeModel(MODEL, transport)(MODEL, primeContext()));

    expect(events.some((event) => event.type === "thinking_delta")).toBe(false);
    expect(events.find((event) => event.type === "thinking_end")).toMatchObject({ content: "" });
  });
});

describe("createTransportForPrimeModel", () => {
  it("maps text, a tool call, usage, and completion through the golden event sequence", async () => {
    const args = { path: "/workspace/a.md" };
    const transport = scriptedTransport([
      { type: "text-delta", text: "Hello, " },
      { type: "text-delta", text: "world" },
      { type: "tool-call", call: { id: "call-1", name: "read_file", arguments: args } },
      { type: "usage", inputTokens: 1_000_000, outputTokens: 200_000 },
      { type: "completed", finishReason: "tool-calls" },
    ]);
    const streamFn = createTransportForPrimeModel(MODEL, transport);

    const events = await collectPrime(streamFn(MODEL, primeContext()));

    expect(eventTypes(events)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => event.type === "text_delta" && event.delta)).toEqual(["Hello, ", "world"]);
    expect(deltas.every((event) => event.type === "text_delta" && event.contentIndex === 0)).toBe(true);
    const textEnd = events.find((event) => event.type === "text_end");
    expect(textEnd).toMatchObject({ contentIndex: 0, content: "Hello, world" });
    const toolcallEnd = events.find((event) => event.type === "toolcall_end");
    expect(toolcallEnd).toMatchObject({
      contentIndex: 1,
      toolCall: { type: "toolCall", id: "call-1", name: "read_file", arguments: args },
    });
    const toolcallDelta = events.find((event) => event.type === "toolcall_delta");
    expect(toolcallDelta).toMatchObject({ contentIndex: 1, delta: JSON.stringify(args) });
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: "done",
      reason: "toolUse",
      message: {
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Hello, world" },
          { type: "toolCall", id: "call-1", name: "read_file", arguments: args },
        ],
        // Cost does not cross the canonical wire; it is recomputed from the
        // model's own table: 1M input @ $3/M, 200k output @ $15/M.
        usage: {
          input: 1_000_000,
          output: 200_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1_200_000,
          cost: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0, total: 6 },
        },
      },
    });
    // Port invariant: every event references the one mutable partial.
    const start = events[0];
    if (start?.type !== "start" || done?.type !== "done") throw new Error("trace shape changed");
    expect(done.message).toBe(start.partial);
  });

  it("marks reasoning phases with thinking block boundaries and honest empty content", async () => {
    const transport = scriptedTransport([
      { type: "progress", phase: "reasoning" },
      { type: "text-delta", text: "A" },
      { type: "progress", phase: "reasoning" },
      { type: "progress", phase: "reasoning" },
      { type: "text-delta", text: "B" },
      { type: "completed", finishReason: "stop" },
    ]);
    const streamFn = createTransportForPrimeModel(MODEL, transport);

    const events = await collectPrime(streamFn(MODEL, primeContext()));

    expect(eventTypes(events)).toEqual([
      "start",
      "thinking_start",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "thinking_start",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    // The canonical wire carries the phase but never its text, so a
    // thinking_delta would be a fabrication and none exists.
    expect(events.filter((event) => event.type === "thinking_delta")).toEqual([]);
    const thinkingEnds = events.filter((event) => event.type === "thinking_end");
    expect(thinkingEnds.map((event) => event.type === "thinking_end" && event.content)).toEqual(["", ""]);
    expect(events[1]).toMatchObject({ type: "thinking_start", contentIndex: 0 });
    expect(events[3]).toMatchObject({ type: "text_start", contentIndex: 1 });
    expect(events[6]).toMatchObject({ type: "thinking_start", contentIndex: 2 });
    expect(events[8]).toMatchObject({ type: "text_start", contentIndex: 3 });
  });

  it.each([
    ["stop", "stop"],
    ["tool-calls", "toolUse"],
    ["length", "length"],
  ] as const)("maps finishReason %s to done reason %s", async (finishReason, reason) => {
    const transport = scriptedTransport([{ type: "completed", finishReason }]);
    const streamFn = createTransportForPrimeModel(MODEL, transport);

    const events = await collectPrime(streamFn(MODEL, primeContext()));
    const done = events.at(-1);

    expect(done).toMatchObject({ type: "done", reason, message: { stopReason: reason } });
  });

  it("routes the completed receipt through the out-channel, never into the message", async () => {
    const receipt = makeReceipt();
    const transport = scriptedTransport([{ type: "completed", finishReason: "stop", receipt }]);
    const receipts: unknown[] = [];
    const streamFn = createTransportForPrimeModel(MODEL, transport, { onReceipt: (value) => receipts.push(value) });

    const events = await collectPrime(streamFn(MODEL, primeContext()));
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done terminal");

    expect(streamFn.getLastReceipt()).toBe(receipt);
    expect(receipts).toEqual([receipt]);
    expect("receipt" in done.message).toBe(false);

    // A later failed stream must not surface the earlier success's receipt.
    const failing = createTransportForPrimeModel(MODEL, failingTransport(new Error("boom")));
    await collectPrime(failing(MODEL, primeContext()));
    expect(failing.getLastReceipt()).toBeUndefined();
  });

  it("names a stream that ended without completed as stream-truncated", async () => {
    const transport = scriptedTransport([{ type: "text-delta", text: "half" }]);
    const streamFn = createTransportForPrimeModel(MODEL, transport);

    const events = await collectPrime(streamFn(MODEL, primeContext()));
    const terminal = events.at(-1);

    expect(terminal).toMatchObject({
      type: "error",
      reason: "error",
      error: {
        stopReason: "error",
        content: [{ type: "text", text: "half" }],
        diagnostics: [
          {
            code: "stream-truncated",
            message: "Inference stream ended without a terminal completed event.",
          },
        ],
      },
    });
  });

  it("preserves the structural failure name into error text and diagnostics", async () => {
    const transport: InferenceTransport = {
      id: "failing",
      posture: "local",
      async *stream() {
        yield { type: "text-delta", text: "Half an answer. " };
        throw structuralHttpError();
      },
    };
    const streamFn = createTransportForPrimeModel(MODEL, transport);

    const events = await collectPrime(streamFn(MODEL, primeContext()));
    const terminal = events.at(-1);

    expect(terminal).toMatchObject({
      type: "error",
      reason: "error",
      error: {
        stopReason: "error",
        // Partial content survives — everything already streamed is real.
        content: [{ type: "text", text: "Half an answer. " }],
        errorMessage:
          "OpenAI rejected the request with HTTP 429. [code=http status=429 retryAfter=7]",
        diagnostics: [
          {
            code: "http",
            message: "OpenAI rejected the request with HTTP 429.",
            detail: "status=429; retryAfter=7",
          },
        ],
      },
    });
  });

  it("ends with stopReason aborted (and no failure diagnostics) when the caller cancels", async () => {
    const hanging: InferenceTransport = {
      id: "hanging",
      posture: "local",
      async *stream(_request, signal) {
        yield { type: "text-delta", text: "partial " };
        await new Promise((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const streamFn: PrimeModelStreamFunction = createTransportForPrimeModel(MODEL, hanging);
    const controller = new AbortController();

    const events: AssistantMessageEvent[] = [];
    for await (const event of streamFn(MODEL, primeContext(), { signal: controller.signal })) {
      events.push(event);
      if (event.type === "text_delta") controller.abort(new Error("Stopped by user."));
    }
    const terminal = events.at(-1);

    expect(terminal).toMatchObject({
      type: "error",
      reason: "aborted",
      error: {
        stopReason: "aborted",
        errorMessage: "Stopped by user.",
        content: [{ type: "text", text: "partial " }],
      },
    });
    // Aborts are the caller's verdict: no failure name is attached, so
    // nothing downstream can classify this as retryable.
    expect(terminal?.type === "error" && terminal.error.diagnostics).toBeUndefined();
    expect(streamFn.getLastReceipt()).toBeUndefined();
  });

  it("builds the canonical request from the prime context", async () => {
    const transport = scriptedTransport([{ type: "completed", finishReason: "stop" }]);
    const streamFn = createTransportForPrimeModel(MODEL, transport, {
      turnId: "t-9",
      toolEffect: (tool) => (tool.name === "read_file" ? "read" : "write"),
    });
    const context = primeContext({
      systemPrompt: "You are an agent.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe " },
            { type: "text", text: "this" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
        {
          ...assistantMessage({
            content: [
              { type: "text", text: "Sure." },
              { type: "thinking", thinking: "secret reasoning never crosses" },
              { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "/x" } },
            ],
            stopReason: "toolUse",
          }),
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read_file",
          content: [
            { type: "text", text: "file body" },
            { type: "image", data: "AAE=", mimeType: "image/gif" },
          ],
          isError: true,
          timestamp: 3,
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
        { name: "write_file", description: "Write a file.", parameters: { type: "object" } },
      ],
    });

    await collectPrime(streamFn(MODEL, context, { sessionId: "s-1" }));
    const request = transport.requests.at(-1);

    expect(request?.model).toBe("test-model");
    expect(request?.systemPrompt).toBe("You are an agent.");
    expect(request?.sessionId).toBe("s-1");
    expect(request?.turnId).toBe("t-9");
    expect(request?.requestId).toMatch(UUID_V4_PATTERN);
    expect(request?.idempotencyKey).toBe(`s-1:t-9:${request?.requestId}`);
    expect(request?.messages).toEqual([
      {
        role: "user",
        content: "describe this",
        images: [
          {
            type: "image",
            name: "image-1",
            mediaType: "image/png",
            dataUrl: "data:image/png;base64,aGVsbG8=",
            sizeBytes: 5,
          },
        ],
      },
      {
        // Thinking has no canonical home and drops exactly here.
        role: "assistant",
        content: "Sure.",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "/x" } }],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: "file body",
        images: [
          {
            type: "image",
            name: "image-1",
            mediaType: "image/gif",
            dataUrl: "data:image/gif;base64,AAE=",
            sizeBytes: 2,
          },
        ],
      },
    ]);
    expect(request?.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        effect: "read",
      },
      { name: "write_file", description: "Write a file.", inputSchema: { type: "object" }, effect: "write" },
    ]);
  });
});

describe("createInferenceTransportForPrimeStream", () => {
  function streamOf(events: readonly AssistantMessageEvent[]): StreamFunction {
    return () => {
      const stream = createAssistantMessageEventStream();
      for (const event of events) stream.push(event);
      return stream;
    };
  }

  it("maps the golden sequence back, dropping thinking text and block boundaries", async () => {
    const partial = assistantMessage();
    const toolCall = { type: "toolCall" as const, id: "call-9", name: "list_files", arguments: { path: "/" } };
    const final = assistantMessage({
      usage: zeroUsage({
        input: 1_200,
        output: 34,
        // Cache tokens exist only in the prime vocabulary and do not cross.
        cacheRead: 56,
        totalTokens: 1_290,
      }),
      stopReason: "toolUse",
    });
    const transport = createInferenceTransportForPrimeStream(
      streamOf([
        { type: "start", partial },
        { type: "text_start", contentIndex: 0, partial },
        { type: "text_delta", contentIndex: 0, delta: "A", partial },
        { type: "text_end", contentIndex: 0, content: "A", partial },
        { type: "thinking_start", contentIndex: 1, partial },
        { type: "thinking_delta", contentIndex: 1, delta: "secret reasoning", partial },
        { type: "thinking_end", contentIndex: 1, content: "secret reasoning", partial },
        { type: "text_start", contentIndex: 2, partial },
        { type: "text_delta", contentIndex: 2, delta: "B", partial },
        { type: "text_end", contentIndex: 2, content: "B", partial },
        { type: "toolcall_start", contentIndex: 3, partial },
        { type: "toolcall_end", contentIndex: 3, toolCall, partial },
        { type: "done", reason: "toolUse", message: final },
      ]),
      "prime-test",
      "plaintext-remote",
    );

    const events = await collectInference(transport.stream(canonicalRequest(), new AbortController().signal));

    expect(events).toEqual([
      { type: "text-delta", text: "A" },
      { type: "progress", phase: "reasoning" },
      { type: "text-delta", text: "B" },
      { type: "tool-call", call: { id: "call-9", name: "list_files", arguments: { path: "/" } } },
      { type: "usage", inputTokens: 1_200, outputTokens: 34 },
      { type: "completed", finishReason: "tool-calls" },
    ]);
    expect(transport.id).toBe("prime-test");
    expect(transport.posture).toBe("plaintext-remote");
  });

  it.each([
    ["stop", "stop"],
    ["toolUse", "tool-calls"],
    ["length", "length"],
  ] as const)("maps done reason %s to finishReason %s", async (reason, finishReason) => {
    const message = assistantMessage({ stopReason: reason });
    const transport = createInferenceTransportForPrimeStream(
      streamOf([{ type: "done", reason, message }]),
      "prime-test",
      "local",
    );

    const events = await collectInference(transport.stream(canonicalRequest(), new AbortController().signal));

    expect(events).toEqual([{ type: "completed", finishReason }]);
  });

  it("emits no usage event for a zeroed usage block, which is the absence of a report", async () => {
    const transport = createInferenceTransportForPrimeStream(
      streamOf([{ type: "done", reason: "stop", message: assistantMessage() }]),
      "prime-test",
      "local",
    );

    const events = await collectInference(transport.stream(canonicalRequest(), new AbortController().signal));

    expect(events).toEqual([{ type: "completed", finishReason: "stop" }]);
  });

  it("folds an error with diagnostics back into the structural failure shape", async () => {
    const transport = createInferenceTransportForPrimeStream(
      streamOf([
        {
          type: "error",
          reason: "error",
          error: assistantMessage({
            stopReason: "error",
            errorMessage: "OpenAI rejected the request with HTTP 429. [code=http status=429 retryAfter=7]",
            diagnostics: [
              {
                code: "http",
                message: "OpenAI rejected the request with HTTP 429.",
                detail: "status=429; retryAfter=7",
              },
            ],
          }),
        },
      ]),
      "prime-test",
      "local",
    );

    const failure = await collectInference(transport.stream(canonicalRequest(), new AbortController().signal)).then(
      () => undefined,
      (error: unknown) => error,
    );

    // The retry layer reads this error unchanged: code survived via
    // diagnostics, status was recovered from the message text, and no
    // Retry-After exists structurally (it only ever lived in text).
    expect(failure).toBeInstanceOf(PrimeBridgeTransportError);
    expect((failure as Error).message).toBe("OpenAI rejected the request with HTTP 429. [code=http status=429 retryAfter=7]");
    expect(namedTransportFailure(failure)).toEqual({ code: "http", status: 429 });
  });

  it("names an unnamed error event stream-interrupted", async () => {
    const transport = createInferenceTransportForPrimeStream(
      streamOf([
        { type: "error", reason: "error", error: assistantMessage({ stopReason: "error", errorMessage: "broken pipe" }) },
      ]),
      "prime-test",
      "local",
    );

    const failure = await collectInference(transport.stream(canonicalRequest(), new AbortController().signal)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PrimeBridgeTransportError);
    expect(namedTransportFailure(failure)).toEqual({ code: "stream-interrupted" });
  });

  it("throws the caller's reason on abort and names provider-side cancel as cancelled", async () => {
    const aborted: StreamFunction = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener(
        "abort",
        () =>
          stream.push({
            type: "error",
            reason: "aborted",
            error: assistantMessage({ stopReason: "aborted", errorMessage: "Request was aborted" }),
          }),
        { once: true },
      );
      return stream;
    };
    const controller = new AbortController();
    const transport = createInferenceTransportForPrimeStream(aborted, "prime-test", "local");

    const callerFailure = await (async () => {
      try {
        const pending = collectInference(transport.stream(canonicalRequest(), controller.signal));
        controller.abort(new Error("Stopped by user."));
        await pending;
      } catch (error) {
        return error;
      }
      throw new Error("expected abort");
    })();
    expect(callerFailure).toBeInstanceOf(Error);
    expect((callerFailure as Error).message).toBe("Stopped by user.");
    expect(namedTransportFailure(callerFailure)).toBeUndefined();

    const providerCancelled = createInferenceTransportForPrimeStream(
      () => {
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "error",
          reason: "aborted",
          error: assistantMessage({ stopReason: "aborted", errorMessage: "Provider cancelled the request." }),
        });
        return stream;
      },
      "prime-test",
      "local",
    );
    const failure = await Promise.resolve().then(() =>
      collectInference(providerCancelled.stream(canonicalRequest(), new AbortController().signal)).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
    expect(failure).toBeInstanceOf(PrimeBridgeTransportError);
    expect(namedTransportFailure(failure)).toEqual({ code: "cancelled" });
  });

  it("delivers exactly one terminal and nothing after it, even for a broken producer", async () => {
    const message = assistantMessage();
    const broken = (async function* (): AsyncGenerator<AssistantMessageEvent> {
      yield { type: "text_delta", contentIndex: 0, delta: "A", partial: message };
      yield { type: "done", reason: "stop", message };
      // Contract violation on purpose: anything after the terminal must die.
      yield { type: "text_delta", contentIndex: 0, delta: "B", partial: message };
      yield { type: "done", reason: "stop", message };
    })();
    const transport = createInferenceTransportForPrimeStream(
      (() => broken) as unknown as StreamFunction,
      "prime-test",
      "local",
    );

    const events = await collectInference(transport.stream(canonicalRequest(), new AbortController().signal));

    expect(events).toEqual([
      { type: "text-delta", text: "A" },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("names a prime stream without a terminal as stream-truncated", async () => {
    const message = assistantMessage();
    const dangling = (async function* (): AsyncGenerator<AssistantMessageEvent> {
      yield { type: "text_delta", contentIndex: 0, delta: "A", partial: message };
    })();
    const transport = createInferenceTransportForPrimeStream(
      (() => dangling) as unknown as StreamFunction,
      "prime-test",
      "local",
    );

    const failure = await collectInference(transport.stream(canonicalRequest(), new AbortController().signal)).then(
      (events) => events,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PrimeBridgeTransportError);
    expect(namedTransportFailure(failure)).toEqual({ code: "stream-truncated" });
  });

  it("rebuilds the prime context from the canonical request", async () => {
    let seen: Context | undefined;
    let seenModel: Model<Api> | undefined;
    const capturing: StreamFunction = (model, context) => {
      seen = context;
      seenModel = model;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: assistantMessage() });
      return stream;
    };
    const transport = createInferenceTransportForPrimeStream(capturing, "prime-test", "local");
    const request = canonicalRequest({
      systemPrompt: "You are an agent.",
      messages: [
        {
          role: "user",
          content: "look",
          images: [
            {
              type: "image",
              name: "image-1",
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,aGVsbG8=",
              sizeBytes: 5,
            },
          ],
        },
        {
          role: "assistant",
          content: "reading",
          toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "/x" } }],
        },
        { role: "tool", toolCallId: "c1", content: "body" },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          // effect is an airship approval concern; it never crosses to prime.
          effect: "read",
        },
      ],
    });

    await collectInference(transport.stream(request, new AbortController().signal));

    expect(seenModel?.id).toBe("test-model");
    expect(seen?.systemPrompt).toBe("You are an agent.");
    expect(seen?.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    const [user, assistant, tool] = seen?.messages ?? [];
    expect(user).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
    expect(assistant).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        { type: "toolCall", id: "c1", name: "read_file", arguments: { path: "/x" } },
      ],
      model: "test-model",
      stopReason: "toolUse",
      usage: zeroUsage(),
    });
    expect(tool).toMatchObject({
      role: "toolResult",
      toolCallId: "c1",
      // The name was recovered from the assistant call this result answers.
      toolName: "read_file",
      content: [{ type: "text", text: "body" }],
      isError: false,
    });
  });
});

describe("primeDiagnosticsFromError", () => {
  it("reads the structural name transports put on their own errors", () => {
    expect(primeDiagnosticsFromError(structuralHttpError())).toEqual([
      {
        code: "http",
        message: "OpenAI rejected the request with HTTP 429.",
        detail: "status=429; retryAfter=7",
      },
    ]);
  });

  it("reads the name off a diagnostic sub-record, as local transports write it", () => {
    const error = Object.assign(new Error("The provider is offline."), {
      diagnostic: { code: "offline" },
    });
    expect(primeDiagnosticsFromError(error)).toEqual([{ code: "offline", message: "The provider is offline." }]);
  });

  it("names an error nobody classified as exactly that", () => {
    expect(primeDiagnosticsFromError(new Error("boom"))).toEqual([
      { code: UNNAMED_TRANSPORT_FAILURE_CODE, message: "boom" },
    ]);
    expect(primeDiagnosticsFromError("nope")).toEqual([{ code: UNNAMED_TRANSPORT_FAILURE_CODE, message: "nope" }]);
  });
});

describe("round trip: canonical → prime → canonical", () => {
  function roundTrip(originals: readonly InferenceEvent[]): {
    transport: InferenceTransport;
    primeStream: PrimeModelStreamFunction;
  } {
    const primeStream = createTransportForPrimeModel(MODEL, scriptedTransport(originals));
    return {
      transport: createInferenceTransportForPrimeStream(primeStream, "roundtrip", "local"),
      primeStream,
    };
  }

  it("preserves events semantically and documents exactly what is lost", async () => {
    const receipt = makeReceipt();
    const originals: InferenceEvent[] = [
      { type: "progress", phase: "reasoning" },
      { type: "text-delta", text: "Hello, " },
      { type: "text-delta", text: "world" },
      { type: "tool-call", call: { id: "call-1", name: "read_file", arguments: { path: "/workspace/a.md" } } },
      { type: "tool-call", call: { id: "call-2", name: "list_files", arguments: {} } },
      { type: "usage", inputTokens: 1_500, outputTokens: 120 },
      { type: "completed", finishReason: "tool-calls", receipt },
    ];
    const { transport, primeStream } = roundTrip(originals);

    const events = await collectInference(transport.stream(canonicalRequest(), new AbortController().signal));

    expect(events).toEqual([
      { type: "progress", phase: "reasoning" },
      { type: "text-delta", text: "Hello, " },
      { type: "text-delta", text: "world" },
      { type: "tool-call", call: { id: "call-1", name: "read_file", arguments: { path: "/workspace/a.md" } } },
      { type: "tool-call", call: { id: "call-2", name: "list_files", arguments: {} } },
      { type: "usage", inputTokens: 1_500, outputTokens: 120 },
      // Lossy point #1: receipts have no prime representation; the receipt
      // comes back undefined on the wire...
      { type: "completed", finishReason: "tool-calls" },
    ]);
    // ...and survives only beside the stream, through the out-channel.
    expect(primeStream.getLastReceipt()).toBe(receipt);
  });

  it("drops an all-zero usage frame rather than reporting tokens nobody reported", async () => {
    const { transport } = roundTrip([
      { type: "text-delta", text: "hi" },
      { type: "usage", inputTokens: 0, outputTokens: 0 },
      { type: "completed", finishReason: "stop" },
    ]);

    const events = await collectInference(transport.stream(canonicalRequest(), new AbortController().signal));

    // Lossy point #2: a zeroed usage block is indistinguishable from no
    // report at all, so it does not survive the round trip.
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("round-trips a named transport failure with status intact and retryAfter textually preserved", async () => {
    const primeStream = createTransportForPrimeModel(MODEL, failingTransport(structuralHttpError()));
    const transport = createInferenceTransportForPrimeStream(primeStream, "roundtrip", "local");

    const failure = await collectInference(transport.stream(canonicalRequest(), new AbortController().signal)).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Lossy point #3: code and status survive (status via the preserved
    // message text), so the retry layer still sees a retryable 429.
    expect(failure).toBeInstanceOf(PrimeBridgeTransportError);
    expect(namedTransportFailure(failure)).toEqual({ code: "http", status: 429 });
    // Retry-After has no structural home in diagnostics; it survives only as
    // text inside the folded error message.
    expect((failure as Error).message).toContain("retryAfter=7");
  });

  it("keeps a single terminal under double reverse-wrapping", async () => {
    const success = createTransportForPrimeModel(
      MODEL,
      createInferenceTransportForPrimeStream(
        createTransportForPrimeModel(
          MODEL,
          scriptedTransport([
            { type: "text-delta", text: "A" },
            { type: "completed", finishReason: "stop" },
          ]),
        ),
        "inner",
        "local",
      ),
    );
    const successEvents = await collectPrime(success(MODEL, primeContext()));
    expect(successEvents.filter((event) => event.type === "done")).toHaveLength(1);
    expect(successEvents.at(-1)).toMatchObject({ type: "done", reason: "stop" });

    const failing = createTransportForPrimeModel(
      MODEL,
      createInferenceTransportForPrimeStream(
        createTransportForPrimeModel(MODEL, failingTransport(structuralHttpError())),
        "inner",
        "local",
      ),
    );
    const failingEvents = await collectPrime(failing(MODEL, primeContext()));
    expect(failingEvents.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
    expect(failingEvents.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: { stopReason: "error", diagnostics: [{ code: "http", message: expect.stringContaining("HTTP 429") }] },
    });
  });
});
