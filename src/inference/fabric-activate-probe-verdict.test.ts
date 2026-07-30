import { describe, expect, it } from "vitest";
import type { InferenceRequest } from "../core/contracts";
import { BrowserInferenceFabric, type BrowserCloudCatalogTransport } from "./fabric";
import { ProviderTransportError, type BrowserCloudTransportOptions } from "./providers/browser-cloud";
import type { InferenceModelDescriptor } from "./providers/contracts";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const OBSERVED_AT = "2026-07-29T12:00:00.000Z";

/*
 * OpenAI's model directory lists models that can never answer the Responses
 * endpoint (embeddings, images, moderation). Each press on one used to burn a
 * live probe that 400s forever and taught the catalog nothing. The fabric now
 * writes that verdict onto the row, in the availability vocabulary activate
 * already uses on success, so the failed model reads as observed unavailable.
 */
describe("activation probe verdicts on catalog availability", () => {
  it("records an HTTP 400 refusal as unavailable / live-probe on the exact row", async () => {
    const fabric = testFabric([
      new ProviderTransportError("http", "OpenAI rejected the request with HTTP 400.", 400),
    ]);
    const connected = await fabric.connectCloud(input);
    const modelId = connected.models[0]!.id;

    await expect(fabric.activate(connected.connection.id, modelId)).rejects.toThrow("HTTP 400");

    expect(fabric.models.require(connected.connection.id, connected.connection.generation, modelId).availability)
      .toEqual({ state: "unavailable", source: "live-probe", observedAt: OBSERVED_AT });
    // The snapshot the picker renders carries the same verdict, projected
    // down to the state it disables rows on.
    expect(fabric.availability().connections[0]?.models[0]).toMatchObject({
      id: modelId,
      availability: "unavailable",
    });
    // A failed probe must not promote the connection's invoke capability.
    expect(fabric.connections.require(connected.connection.id).capabilities.invoke.state).toBe("unknown");
    // The row's source still describes the directory listing, not the refusal.
    expect(fabric.models.require(connected.connection.id, connected.connection.generation, modelId).source.kind)
      .toBe("provider-directory");
  });

  it("leaves a 5xx retryable: the row keeps directory availability and a later probe succeeds", async () => {
    const fabric = testFabric([
      new ProviderTransportError("http", "OpenAI rejected the request with HTTP 502.", 502),
    ]);
    const connected = await fabric.connectCloud(input);
    const modelId = connected.models[0]!.id;

    await expect(fabric.activate(connected.connection.id, modelId)).rejects.toThrow("HTTP 502");

    const row = fabric.models.require(connected.connection.id, connected.connection.generation, modelId);
    expect(row.availability.state).toBe("unknown");
    expect(row.availability.source).toBe("provider-directory");

    const activated = await fabric.activate(connected.connection.id, modelId);
    expect(activated.pin.connection.id).toBe(connected.connection.id);
    expect(fabric.models.require(connected.connection.id, connected.connection.generation, modelId).availability)
      .toEqual({ state: "available", source: "live-probe", observedAt: OBSERVED_AT });
  });

  it("leaves a transport-layer failure untouched as well", async () => {
    const fabric = testFabric([
      new ProviderTransportError("network-or-cors", "The provider could not be reached."),
    ]);
    const connected = await fabric.connectCloud(input);

    await expect(fabric.activate(connected.connection.id, connected.models[0]!.id))
      .rejects.toThrow("could not be reached");
    expect(fabric.models.require(
      connected.connection.id,
      connected.connection.generation,
      connected.models[0]!.id,
    ).availability.state).toBe("unknown");
  });
});

const input = {
  providerId: "openai",
  apiKey: "sk-openai-memory-only",
  acknowledgeDirectBrowserCredentialRisk: true,
} as const;

function testFabric(streamFailures: ProviderTransportError[]): BrowserInferenceFabric {
  return new BrowserInferenceFabric({
    now: () => NOW,
    cloudTransportFactory: (_providerId, options) => new FailingProbeTransport(options, streamFailures),
  });
}

class FailingProbeTransport implements BrowserCloudCatalogTransport {
  readonly id = "openai-failing-probe-fake";
  readonly posture = "plaintext-remote" as const;

  constructor(
    private readonly options: BrowserCloudTransportOptions,
    private readonly failures: ProviderTransportError[],
  ) {}

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
        providerId: "openai" as const,
        id: "text-embedding-3-large",
        label: "text-embedding-3-large",
        capabilities: Object.freeze({}),
        availability: Object.freeze({
          state: "unknown" as const,
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
    const failure = this.failures.shift();
    if (failure) throw failure;
    yield { type: "completed" as const, finishReason: "stop" as const };
  }
}
