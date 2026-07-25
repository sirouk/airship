import { describe, expect, it, vi } from "vitest";
import type { InferenceRequest } from "../../core/contracts";
import { LocalOpenAiTransport } from "./openai-transport";

describe("LocalOpenAiTransport", () => {
  it("streams text, usage, and bounded tool calls directly to loopback", async () => {
    const credential = "page-memory-token";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "local-agent", stream: true });
      return sse([
        openAi({ content: "Hello " }),
        openAi({ content: "locally." }),
        openAi({
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
          }],
        }, "tool_calls"),
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
        "[DONE]",
      ]);
    }) as typeof fetch;
    const transport = new LocalOpenAiTransport({
      id: "test-local",
      endpoint: new URL("http://127.0.0.1:1234"),
      credential: () => credential,
      fetch: fetchMock,
    });

    const events = [];
    for await (const event of transport.stream(request(), new AbortController().signal)) {
      events.push(event);
    }

    expect(transport.posture).toBe("local");
    expect(events).toEqual([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "locally." },
      { type: "usage", inputTokens: 12, outputTokens: 4 },
      {
        type: "tool-call",
        call: { id: "call_1", name: "read_file", arguments: { path: "README.md" } },
      },
      { type: "completed", finishReason: "tool-calls" },
    ]);
  });

  it("requires a completion marker and rejects unbounded streams", async () => {
    const truncated = new LocalOpenAiTransport({
      id: "truncated",
      endpoint: new URL("http://localhost:11434"),
      fetch: vi.fn(async () => sse([openAi({ content: "partial" })])) as typeof fetch,
    });
    await expect(collect(truncated)).rejects.toMatchObject({
      diagnostic: { code: "invalid-payload" },
    });

    const oversized = new LocalOpenAiTransport({
      id: "oversized",
      endpoint: new URL("http://localhost:11434"),
      maxStreamBytes: 1_024,
      fetch: vi.fn(async () => sse([openAi({ content: "x".repeat(2_000) }), "[DONE]"])) as typeof fetch,
    });
    await expect(collect(oversized)).rejects.toMatchObject({
      diagnostic: { code: "response-too-large" },
    });
  });

  it("forwards cancellation to fetch and never retries or proxies", async () => {
    let observedUrl = "";
    let observedSignal: AbortSignal | undefined;
    const transport = new LocalOpenAiTransport({
      id: "cancel",
      endpoint: new URL("http://127.0.0.1:11434"),
      fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        observedUrl = String(input);
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }) as typeof fetch,
    });
    const controller = new AbortController();
    const result = collect(transport, controller.signal);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    controller.abort(new DOMException("User cancelled.", "AbortError"));
    await expect(result).rejects.toThrow("User cancelled");
    expect(observedSignal?.aborted).toBe(true);
    expect(observedUrl).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("rejects private-LAN transports at construction", () => {
    expect(() => new LocalOpenAiTransport({
      id: "lan",
      endpoint: new URL("https://models.local:11434"),
      fetch: vi.fn() as typeof fetch,
    })).toThrow("Private-LAN and public hosts are not supported");
  });

  it("classifies malformed response bytes as provider payload, not a CORS failure", async () => {
    const transport = new LocalOpenAiTransport({
      id: "invalid-utf8",
      endpoint: new URL("http://127.0.0.1:1234"),
      fetch: vi.fn(async () => new Response(
        new Uint8Array([0xff, 0xfe, 0xfd]),
        { headers: { "Content-Type": "text/event-stream" } },
      )) as typeof fetch,
    });
    await expect(collect(transport)).rejects.toMatchObject({
      diagnostic: { code: "invalid-payload" },
    });
  });

  it("rejects credential header injection without contacting the provider", async () => {
    const fetchMock = vi.fn();
    const transport = new LocalOpenAiTransport({
      id: "invalid-credential",
      endpoint: new URL("http://127.0.0.1:1234"),
      credential: () => "token\r\nX-Injected: yes",
      fetch: fetchMock as typeof fetch,
    });
    await expect(collect(transport)).rejects.toMatchObject({
      diagnostic: { code: "credential-invalid" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function request(): InferenceRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    turnId: "turn-1",
    model: "local-agent",
    systemPrompt: "You are a local agent.",
    messages: [{ role: "user", content: "Hello" }],
    tools: [{
      name: "read_file",
      description: "Read a file.",
      inputSchema: { type: "object" },
      effect: "read",
    }],
    idempotencyKey: "idempotency-1",
  };
}

async function collect(
  transport: LocalOpenAiTransport,
  signal = new AbortController().signal,
) {
  const events = [];
  for await (const event of transport.stream(request(), signal)) events.push(event);
  return events;
}

function openAi(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return JSON.stringify({
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function sse(events: readonly string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}
