import { describe, expect, it } from "vitest";
import type {
  InferenceRequest,
  InferenceTransport,
} from "../core/contracts";
import {
  BrowserInferenceFabric,
  type BrowserCloudCatalogTransport,
  type BrowserCloudProviderId,
} from "./fabric";
import type {
  BrowserLocalModelProvider,
  LocalModelDiscovery,
  LocalProviderHealth,
} from "./local";
import {
  MAX_MODEL_OUTPUT_TOKENS,
  type BrowserCloudTransportOptions,
  type InferenceModelDescriptor,
} from "./providers";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");
const OBSERVED_AT = "2026-07-24T12:00:00.000Z";

describe("browser inference fabric transactions", () => {
  it("keeps simultaneous cloud providers live without exposing either credential", async () => {
    const fabric = testFabric();

    const [openai, anthropic] = await Promise.all([
      fabric.connectCloud(cloudInput("openai", "sk-openai-memory-only")),
      fabric.connectCloud(cloudInput("anthropic", "sk-anthropic-memory-only")),
    ]);

    expect(openai.connection.id).toMatch(/^openai-[a-z0-9._-]+$/u);
    expect(anthropic.connection.id).toMatch(/^anthropic-[a-z0-9._-]+$/u);
    expect(openai.connection.id).not.toBe(anthropic.connection.id);
    expect(fabric.list().map((entry) => entry.connection.providerId)).toEqual([
      "anthropic",
      "openai",
    ]);
    const publicState = JSON.stringify({
      providers: fabric.providers.snapshot(),
      connections: fabric.connections.snapshot(),
      models: fabric.models.snapshot(),
      availability: fabric.availability(),
    });
    expect(publicState).not.toContain("sk-openai-memory-only");
    expect(publicState).not.toContain("sk-anthropic-memory-only");
  });

  it("allocates a new immutable connection ID for a replacement credential", async () => {
    const fabric = testFabric(["replacement-1"]);
    const first = await fabric.connectCloud({
      ...cloudInput("openai", "sk-first"),
      connectionId: "openai-main",
    });
    const firstRoute = await fabric.activate(
      first.connection.id,
      first.models[0]!.id,
    );

    const replacement = await fabric.connectCloud({
      ...cloudInput("openai", "sk-replacement"),
      connectionId: "openai-main",
    });

    expect(replacement.connection.id).toBe("openai-main-next-replacement-1");
    expect(replacement.connection.generation).toBe(1);
    expect(first.connection).toMatchObject({ id: "openai-main", generation: 1 });
    expect(fabric.list()).toHaveLength(2);
    expect(fabric.resolve(firstRoute.pin).state).toBe("ready");
    expect(fabric.preflight(firstRoute.pin)).toMatchObject({
      pin: firstRoute.pin,
      transport: firstRoute.transport,
    });
  });

  it("does not let a fresh fabric and different credential reproduce a prior page authority", async () => {
    const firstFabric = testFabric(["page-authority-a"]);
    const first = await firstFabric.connectCloud(
      cloudInput("openai", "sk-first-page"),
    );
    const firstRoute = await firstFabric.activate(
      first.connection.id,
      first.models[0]!.id,
    );

    const secondFabric = testFabric(["page-authority-b"]);
    const second = await secondFabric.connectCloud(
      cloudInput("openai", "sk-second-page"),
    );
    await secondFabric.activate(
      second.connection.id,
      second.models[0]!.id,
    );

    expect(second.connection.id).not.toBe(first.connection.id);
    expect(secondFabric.resolve(firstRoute.pin).state).not.toBe("ready");
    expect(() => secondFabric.preflight(firstRoute.pin)).toThrow(
      "Inference route preflight failed",
    );
  });

  it("rolls back a rejected cloud candidate without touching the working route", async () => {
    const fabric = testFabric(["candidate-failed"]);
    const first = await fabric.connectCloud({
      ...cloudInput("openai", "sk-working"),
      connectionId: "openai-main",
    });
    const route = await fabric.activate(first.connection.id, first.models[0]!.id);
    const before = fabric.availability(route.pin);

    await expect(fabric.connectCloud({
      ...cloudInput("openai", "sk-reject-this"),
      connectionId: "openai-main",
    })).rejects.toThrow("rejected test credential");

    expect(fabric.list().map((entry) => entry.connection.id)).toEqual(["openai-main"]);
    expect(fabric.resolve(route.pin).state).toBe("ready");
    expect(fabric.preflight(route.pin).transport).toBe(route.transport);
    expect(fabric.availability(route.pin).activeSession).toEqual(before.activeSession);
  });

  it("fails closed when a transport tries to cross-bind another provider's roster", async () => {
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      cloudTransportFactory: (_providerId, options) =>
        new FakeCloudTransport("xai", options),
    });

    await expect(fabric.connectCloud(cloudInput("openai", "sk-openai-memory-only")))
      .rejects.toThrow("another provider's models");
    expect(fabric.list()).toEqual([]);
    expect(fabric.connections.snapshot().connections).toEqual([]);
    expect(fabric.models.snapshot().models).toEqual([]);
  });

  it("preserves provider-sourced model evidence without guessing capabilities", async () => {
    const fabric = testFabric();
    const connected = await fabric.connectCloud(cloudInput("xai", "xai-memory-only"));
    const [discovered] = connected.models;

    expect(discovered?.capabilities).toEqual({
      "text-input": {
        state: "supported",
        source: "provider-directory",
        observedAt: OBSERVED_AT,
      },
      "text-output": {
        state: "supported",
        source: "provider-directory",
        observedAt: OBSERVED_AT,
      },
    });
    expect(discovered?.capabilities["image-input"]).toBeUndefined();
    expect(discovered?.capabilities["tool-calling"]).toBeUndefined();
  });

  it("rolls back a failed local reconnect without revising or disconnecting the live provider", async () => {
    const modes: Array<"ready" | "fail"> = ["ready", "fail"];
    const fabric = testFabric(["local-candidate"], () =>
      fakeLocalProvider(modes.shift() ?? "fail")
    );
    const first = await fabric.connectLocal({
      kind: "ollama",
      connectionId: "ollama-main",
    });
    const route = await fabric.activate(first.connection.id, first.models[0]!.id);
    const providerRevision = fabric.providers.require("ollama").revision;

    await expect(fabric.connectLocal({
      kind: "ollama",
      connectionId: "ollama-main",
    })).rejects.toThrow("local endpoint is unavailable");

    expect(fabric.providers.require("ollama").revision).toBe(providerRevision);
    expect(fabric.list().map((entry) => entry.connection.id)).toEqual(["ollama-main"]);
    expect(fabric.resolve(route.pin).state).toBe("ready");
    expect(fabric.preflight(route.pin).transport).toBe(route.transport);
  });

  it("rejects credential-bearing local endpoints instead of mislabelling them local-none", async () => {
    let factoryCalled = false;
    const fabric = new BrowserInferenceFabric({
      localProviderFactory: () => {
        factoryCalled = true;
        return fakeLocalProvider("ready");
      },
    });

    await expect(fabric.connectLocal({
      kind: "lm-studio",
      options: { credential: () => "local-secret" },
    })).rejects.toThrow("dedicated page-memory authority");
    expect(factoryCalled).toBe(false);
    expect(fabric.list()).toEqual([]);
  });

  it("disconnects only the selected immutable route and makes preflight fail closed", async () => {
    const fabric = testFabric();
    const connected = await fabric.connectCloud(cloudInput("xai", "xai-memory-only"));
    const route = await fabric.activate(connected.connection.id, connected.models[0]!.id);

    expect(fabric.disconnect(connected.connection.id)).toBe(true);
    expect(fabric.resolve(route.pin)).toMatchObject({ state: "connection-missing" });
    expect(() => fabric.preflight(route.pin)).toThrow(
      "Inference route preflight failed: The pinned inference connection is disconnected.",
    );
    expect(fabric.disconnect(connected.connection.id)).toBe(false);
  });

  it("revokes a retained local transport when its connection is disconnected", async () => {
    const fabric = testFabric([], () => fakeLocalProvider("ready"));
    const connected = await fabric.connectLocal({ kind: "ollama" });
    const route = await fabric.activate(connected.connection.id, connected.models[0]!.id);

    expect(fabric.disconnect(connected.connection.id)).toBe(true);
    await expect(collect(route.transport.stream(
      inferenceRequest(connected.models[0]!.id),
      new AbortController().signal,
    ))).rejects.toThrow("exact connection authority is no longer active");
  });

  it("aborts in-flight local inference when page-memory authority is released", async () => {
    const entered = deferred<void>();
    const fabric = testFabric([], () => revocationLocalProvider(entered));
    const connected = await fabric.connectLocal({ kind: "ollama" });
    const route = await fabric.activate(connected.connection.id, connected.models[0]!.id);
    const pending = collect(route.transport.stream(
      inferenceRequest(connected.models[0]!.id),
      new AbortController().signal,
    ));
    await entered.promise;

    expect(fabric.disconnect(connected.connection.id)).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves and preflights the exact model and transport selected by activation", async () => {
    const fabric = testFabric();
    const connected = await fabric.connectCloud(cloudInput("anthropic", "sk-ant-live"));

    expect(() => fabric.preflight({
      version: 1,
      pinnedAt: OBSERVED_AT,
      provider: {
        id: "anthropic",
        revision: 1,
        label: "Anthropic",
        protocol: "anthropic-messages",
        transportBoundary: "provider-tls",
      },
      connection: {
        id: connected.connection.id,
        generation: connected.connection.generation,
        authKind: "api-key",
      },
      model: connected.models[0]!,
    })).toThrow("connection is not currently authorized and healthy");

    const activated = await fabric.activate(
      connected.connection.id,
      connected.models[0]!.id,
    );
    const resolution = fabric.resolve(activated.pin);
    expect(resolution).toMatchObject({
      state: "ready",
      connection: {
        id: connected.connection.id,
        generation: connected.connection.generation,
      },
    });
    const preflight = fabric.preflight(activated.pin);
    expect(preflight.transport).toBe(activated.transport);
    expect(preflight.models.map((model) => model.id)).toEqual([connected.models[0]!.id]);
  });

  it("revokes an in-flight probe before a replacement credential generation can be promoted", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let liveTransportCount = 0;
    let fabric!: BrowserInferenceFabric;
    fabric = new BrowserInferenceFabric({
      now: () => NOW,
      cloudTransportFactory: (providerId, options) => {
        const base = new FakeCloudTransport(providerId, options);
        if (options.connections !== fabric.connections) return base;
        liveTransportCount += 1;
        return liveTransportCount === 1
          ? new DeferredProbeCloudTransport(base, entered, release)
          : base;
      },
    });
    const first = await fabric.connectCloud({
      ...cloudInput("openai", "sk-first"),
      connectionId: "openai-main",
    });
    const staleActivation = fabric.activate(first.connection.id, first.models[0]!.id);
    await entered.promise;

    expect(fabric.disconnect(first.connection.id)).toBe(true);
    const replacement = await fabric.connectCloud({
      ...cloudInput("openai", "sk-replacement"),
      connectionId: "openai-main",
    });
    expect(replacement.connection).toMatchObject({ id: "openai-main", generation: 2 });
    release.resolve();

    await expect(staleActivation).rejects.toThrow("Inference connection was disconnected.");
    expect(fabric.connections.require("openai-main").capabilities.invoke.state).toBe("unknown");
    await expect(fabric.activate("openai-main", replacement.models[0]!.id)).resolves.toMatchObject({
      pin: { connection: { id: "openai-main", generation: 2 } },
    });
  });

  it("carries an operator-declared model window into the catalog, the agent snapshot, and the request ceiling", async () => {
    let outputCeilingFor: ((modelId: string) => number | undefined) | undefined;
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      connectionIdFactory: () => "declared-1",
      cloudTransportFactory: (providerId, options) => {
        if (options.maxOutputTokensForModel) outputCeilingFor = options.maxOutputTokensForModel;
        return new FakeCloudTransport(providerId, options);
      },
    });
    const connected = await fabric.connectCloud(
      cloudInput("anthropic", "sk-anthropic-memory-only"),
    );
    const modelId = connected.models[0]!.id;

    // Anthropic's directory publishes neither limit, so nothing may appear yet.
    expect(outputCeilingFor?.(modelId)).toBeUndefined();
    expect(fabric.availability().connections[0]?.models[0])
      .not.toHaveProperty("contextWindowTokens");

    const declared = fabric.declareModelMetadata(connected.connection.id, modelId, {
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
    });

    expect(declared).toMatchObject({
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      source: { kind: "manual", observedAt: OBSERVED_AT },
    });
    expect(outputCeilingFor?.(modelId)).toBe(64_000);
    expect(fabric.availability().connections[0]?.models[0]).toMatchObject({
      id: modelId,
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
    });
  });

  it("refuses a model declaration that is empty, unusable, or for an uncataloged model", async () => {
    const fabric = testFabric(["declared-2"]);
    const connected = await fabric.connectCloud(cloudInput("openai", "sk-openai-memory-only"));
    const modelId = connected.models[0]!.id;

    expect(() => fabric.declareModelMetadata(connected.connection.id, modelId, {}))
      .toThrow("context window or output ceiling");
    expect(() =>
      fabric.declareModelMetadata(connected.connection.id, modelId, { contextWindowTokens: 0 })
    ).toThrow("Model context window is invalid.");
    expect(() =>
      fabric.declareModelMetadata(connected.connection.id, "absent-model", {
        contextWindowTokens: 4_096,
      })
    ).toThrow("is not cataloged");
    expect(fabric.models.require(connected.connection.id, 1, modelId).source.kind)
      .toBe("provider-directory");
  });

  it("refuses an output declaration the transport would later reject at request time", async () => {
    let outputCeilingFor: ((modelId: string) => number | undefined) | undefined;
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      connectionIdFactory: () => "declared-3",
      cloudTransportFactory: (providerId, options) => {
        if (options.maxOutputTokensForModel) outputCeilingFor = options.maxOutputTokensForModel;
        return new FakeCloudTransport(providerId, options);
      },
    });
    const connected = await fabric.connectCloud(
      cloudInput("anthropic", "sk-anthropic-memory-only"),
    );
    const modelId = connected.models[0]!.id;

    /*
     * The catalog and the request path share one ceiling. A declaration one
     * token above it must be refused here rather than accepted and then
     * thrown on every subsequent turn, which would brick the model.
     */
    expect(() =>
      fabric.declareModelMetadata(connected.connection.id, modelId, {
        maxOutputTokens: MAX_MODEL_OUTPUT_TOKENS + 1,
      })
    ).toThrow("Model maximum output is invalid.");
    expect(outputCeilingFor?.(modelId)).toBeUndefined();

    expect(
      fabric.declareModelMetadata(connected.connection.id, modelId, {
        maxOutputTokens: MAX_MODEL_OUTPUT_TOKENS,
      }),
    ).toMatchObject({ maxOutputTokens: MAX_MODEL_OUTPUT_TOKENS });
    expect(outputCeilingFor?.(modelId)).toBe(MAX_MODEL_OUTPUT_TOKENS);
  });
});

function testFabric(
  connectionIds: string[] = [],
  localProviderFactory?: () => BrowserLocalModelProvider,
): BrowserInferenceFabric {
  let fallbackId = 0;
  return new BrowserInferenceFabric({
    now: () => NOW,
    connectionIdFactory: () => connectionIds.shift() ?? `candidate-${++fallbackId}`,
    cloudTransportFactory: (providerId, options) =>
      new FakeCloudTransport(providerId, options),
    ...(localProviderFactory
      ? { localProviderFactory: () => localProviderFactory() }
      : {}),
  });
}

function cloudInput(
  providerId: BrowserCloudProviderId,
  apiKey: string,
) {
  return {
    providerId,
    apiKey,
    acknowledgeDirectBrowserCredentialRisk: true,
  } as const;
}

class FakeCloudTransport implements BrowserCloudCatalogTransport {
  readonly id: string;
  readonly posture = "plaintext-remote" as const;

  constructor(
    private readonly providerId: BrowserCloudProviderId,
    private readonly options: BrowserCloudTransportOptions,
  ) {
    this.id = `${providerId}-fake`;
  }

  async listModels(
    signal = new AbortController().signal,
  ): Promise<readonly InferenceModelDescriptor[]> {
    signal.throwIfAborted();
    const connections = this.options.connections;
    if (!connections) throw new Error("test transport requires registry custody");
    return connections.useCredential(
      this.options.connectionId,
      {
        expectedGeneration: this.options.connectionGeneration,
        signal,
      },
      (lease) => {
        if (lease.kind !== "api-key") throw new Error("test transport requires an API key");
        if (lease.value.includes("reject")) throw new Error("rejected test credential");
        return Object.freeze([model({
          providerId: this.providerId,
          connectionId: this.options.connectionId,
          connectionGeneration: this.options.connectionGeneration,
          modelId: `${this.providerId}-model`,
          source: "provider-directory",
        })]);
      },
    );
  }

  async *stream(
    _request: InferenceRequest,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    yield { type: "completed" as const, finishReason: "stop" as const };
  }
}

class DeferredProbeCloudTransport implements BrowserCloudCatalogTransport {
  readonly id: string;
  readonly posture = "plaintext-remote" as const;

  constructor(
    private readonly delegate: FakeCloudTransport,
    private readonly entered: Deferred<void>,
    private readonly release: Deferred<void>,
  ) {
    this.id = delegate.id;
  }

  listModels(signal?: AbortSignal): Promise<readonly InferenceModelDescriptor[]> {
    return this.delegate.listModels(signal);
  }

  async *stream(
    _request: InferenceRequest,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.entered.resolve();
    await this.release.promise;
    signal.throwIfAborted();
    yield { type: "completed" as const, finishReason: "stop" as const };
  }
}

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return Object.freeze({ promise, resolve });
}

function fakeLocalProvider(mode: "ready" | "fail"): BrowserLocalModelProvider {
  const endpoint = new URL("http://127.0.0.1:11434");
  const transport: InferenceTransport = {
    id: "ollama-fake",
    posture: "local",
    async *stream(_request, signal) {
      signal.throwIfAborted();
      yield { type: "completed", finishReason: "stop" };
    },
  };
  return {
    kind: "ollama",
    endpoint,
    async probeHealth(): Promise<LocalProviderHealth> {
      if (mode === "fail") throw new Error("local endpoint is unavailable");
      return {
        provider: "ollama",
        endpoint: endpoint.origin,
        state: "ready",
        checkedAt: OBSERVED_AT,
        cors: "confirmed",
      };
    },
    async discoverModels(): Promise<LocalModelDiscovery> {
      return {
        provider: "ollama",
        endpoint: endpoint.origin,
        fetchedAt: OBSERVED_AT,
        models: [{
          id: "local-model",
          provider: "ollama",
          state: "loaded",
          capabilities: [{
            capability: "text-generation",
            state: "supported",
            source: "/api/show:capabilities",
          }],
        }],
        diagnostics: [],
        complete: true,
      };
    },
    createTransport: () => transport,
  };
}

function revocationLocalProvider(
  entered: Deferred<void>,
): BrowserLocalModelProvider {
  const base = fakeLocalProvider("ready");
  let invocation = 0;
  return {
    ...base,
    createTransport: () => ({
      id: "ollama-revocation-test",
      posture: "local",
      async *stream(_request, signal) {
        invocation += 1;
        if (invocation === 1) {
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(
            signal.reason ?? new DOMException("Inference cancelled.", "AbortError"),
          );
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    }),
  };
}

function inferenceRequest(modelId: string): InferenceRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    turnId: "turn-1",
    model: modelId,
    systemPrompt: "Reply briefly.",
    messages: [{ role: "user", content: "Hello." }],
    tools: [],
    idempotencyKey: "idempotency-1",
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function model(input: Readonly<{
  providerId: string;
  connectionId: string;
  connectionGeneration: number;
  modelId: string;
  source: "provider-directory" | "local-discovery";
}>): InferenceModelDescriptor {
  return {
    version: 1,
    connectionId: input.connectionId,
    connectionGeneration: input.connectionGeneration,
    providerId: input.providerId,
    id: input.modelId,
    label: input.modelId,
    capabilities: {
      "text-input": {
        state: "supported",
        source: input.source,
        observedAt: OBSERVED_AT,
      },
      "text-output": {
        state: "supported",
        source: input.source,
        observedAt: OBSERVED_AT,
      },
    },
    availability: {
      state: "unknown",
      source: input.source,
      observedAt: OBSERVED_AT,
    },
    source: {
      kind: input.source,
      observedAt: OBSERVED_AT,
    },
  };
}
