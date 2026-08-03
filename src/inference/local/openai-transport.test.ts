import { describe, expect, it, vi } from "vitest";
import type { InferenceEvent, InferenceRequest } from "../../core/contracts";
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

  /*
   * Driven offline mid-turn: the console showed
   * `net::ERR_INCOMPLETE_CHUNKED_ENCODING` and the screen showed "The local
   * inference endpoint returned malformed UTF-8 or stream framing" — a verdict
   * about the provider's data, for a failure of the connection, which points
   * the person at the wrong system to fix.
   */
  it("names a dropped connection as a dropped connection, not as corrupt provider data", async () => {
    let delivered = false;
    const transport = new LocalOpenAiTransport({
      id: "cut-stream",
      endpoint: new URL("http://127.0.0.1:1234"),
      fetch: vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            // One chunk delivered, then the connection dies: `error()` discards
            // anything still queued, so the drop has to land on a later pull to
            // reproduce what a person actually sees — a partial reply on screen.
            if (delivered) return controller.error(new TypeError("Failed to fetch"));
            delivered = true;
            controller.enqueue(new TextEncoder().encode(`data: ${openAi({ content: "Half a repl" })}\n\n`));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )) as typeof fetch,
    });
    const events: InferenceEvent[] = [];
    const failure = await (async () => {
      try {
        for await (const event of transport.stream(request(), new AbortController().signal)) events.push(event);
        return undefined;
      } catch (caught) {
        return caught as { diagnostic: { code: string; message: string } };
      }
    })();
    expect(events).toEqual([{ type: "text-delta", text: "Half a repl" }]);
    expect(failure?.diagnostic.code).toBe("stream-interrupted");
    expect(failure?.diagnostic.message).toContain("dropped before the reply finished");
    expect(failure?.diagnostic.message).not.toContain("malformed UTF-8");
  });

  it("still blames the payload when the payload really is malformed mid-stream", async () => {
    /*
     * The other producer of a `TypeError` in this loop is the fatal
     * `TextDecoder`, and it has to keep the payload verdict the connection
     * failure was borrowing — otherwise this fix has only moved the wrong
     * diagnosis to the other case. (The exact sentence differs by runtime:
     * Node's decoder rejects with an error carrying a `code`, a browser's does
     * not. The class of verdict is what must hold, and does in both.)
     */
    const transport = new LocalOpenAiTransport({
      id: "bad-bytes-midstream",
      endpoint: new URL("http://127.0.0.1:1234"),
      fetch: vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${openAi({ content: "ok" })}\n\n`));
            controller.enqueue(new Uint8Array([0xff, 0xfe, 0xfd]));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )) as typeof fetch,
    });
    const failure = await collect(transport).then(() => undefined, (caught: { diagnostic: { code: string; message: string } }) => caught);
    expect(failure?.diagnostic.code).toBe("invalid-payload");
    expect(failure?.diagnostic.message).not.toContain("dropped before the reply finished");
  });

  it("keeps a cancellation a cancellation when the reader rejects with an abort", async () => {
    const controller = new AbortController();
    const transport = new LocalOpenAiTransport({
      id: "cancelled-midstream",
      endpoint: new URL("http://127.0.0.1:1234"),
      fetch: vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode(`data: ${openAi({ content: "partial" })}\n\n`));
            queueMicrotask(() => {
              controller.abort(new DOMException("User cancelled.", "AbortError"));
              stream.error(new DOMException("User cancelled.", "AbortError"));
            });
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )) as typeof fetch,
    });
    await expect(collect(transport, controller.signal)).rejects.toThrow("User cancelled");
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
