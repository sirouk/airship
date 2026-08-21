import { describe, expect, it } from "vitest";
import type { InferenceRequest } from "../core/contracts";
import { BrowserInferenceFabric, type BrowserCloudCatalogTransport } from "./fabric";
import type { BrowserCloudTransportOptions } from "./providers/browser-cloud";
import type { InferenceModelDescriptor } from "./providers/contracts";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const OBSERVED_AT = "2026-07-29T12:00:00.000Z";

describe("local model activation", () => {
  it("pins a selected model without sending a hidden billable prompt", async () => {
    const transports: CountingTransport[] = [];
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      cloudTransportFactory: (_provider, options) => {
        const transport = new CountingTransport(options);
        transports.push(transport);
        return transport;
      },
    });
    const connected = await fabric.connectCloud(input);
    const route = await fabric.activate(connected.connection.id, connected.models[0]!.id);
    const live = transports.at(-1)!;

    expect(live.streamCalls).toBe(0);
    expect(route.pin).toMatchObject({
      provider: { id: "openai" },
      connection: { id: connected.connection.id, generation: connected.connection.generation },
      model: { id: "model-1", source: { kind: "provider-directory" } },
    });
    expect(fabric.connections.require(connected.connection.id).capabilities.invoke)
      .toEqual({ state: "available", source: "provider-declared" });

    await collect(route.transport.stream(request, new AbortController().signal));
    expect(live.streamCalls).toBe(1);
  });

  it("honors cancellation before selection without invoking the provider", async () => {
    const transports: CountingTransport[] = [];
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      cloudTransportFactory: (_provider, options) => {
        const transport = new CountingTransport(options);
        transports.push(transport);
        return transport;
      },
    });
    const connected = await fabric.connectCloud(input);
    const controller = new AbortController();
    controller.abort(new DOMException("Selection cancelled.", "AbortError"));

    await expect(fabric.activate(connected.connection.id, connected.models[0]!.id, controller.signal))
      .rejects.toThrow("Selection cancelled");
    expect(transports.at(-1)?.streamCalls).toBe(0);
  });
});

const input = {
  providerId: "openai",
  apiKey: "sk-openai-memory-only",
  acknowledgeDirectBrowserCredentialRisk: true,
} as const;

const request: InferenceRequest = {
  requestId: "request-1",
  sessionId: "session-1",
  turnId: "turn-1",
  model: "model-1",
  systemPrompt: "Be concise.",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
  idempotencyKey: "request-1",
};

class CountingTransport implements BrowserCloudCatalogTransport {
  readonly id = "counting-openai-fake";
  readonly posture = "plaintext-remote" as const;
  streamCalls = 0;

  constructor(private readonly options: BrowserCloudTransportOptions) {}

  async listModels(signal = new AbortController().signal): Promise<readonly InferenceModelDescriptor[]> {
    signal.throwIfAborted();
    const connections = this.options.connections;
    if (!connections) throw new Error("test transport requires registry custody");
    return connections.useCredential(
      this.options.connectionId,
      { expectedGeneration: this.options.connectionGeneration, signal },
      () => Object.freeze([Object.freeze({
        version: 1 as const,
        connectionId: this.options.connectionId,
        connectionGeneration: this.options.connectionGeneration,
        providerId: "openai",
        id: "model-1",
        label: "Model 1",
        capabilities: Object.freeze({}),
        availability: Object.freeze({
          state: "available" as const,
          source: "provider-directory" as const,
          observedAt: OBSERVED_AT,
        }),
        source: Object.freeze({
          kind: "provider-directory" as const,
          observedAt: OBSERVED_AT,
          sourceUrl: "https://api.openai.com/v1/models",
        }),
      })]),
    );
  }

  async *stream(_request: InferenceRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    this.streamCalls += 1;
    yield { type: "completed" as const, finishReason: "stop" as const };
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // drain
  }
}
