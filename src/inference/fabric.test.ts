import { describe, expect, it } from "vitest";
import type {
  InferenceRequest,
  InferenceTransport,
} from "../core/contracts";
import {
  BrowserInferenceFabric,
  type BrowserCloudCatalogTransport,
} from "./fabric";
import type {
  BrowserLocalModelProvider,
  LocalModelDiscovery,
  LocalModelProviderKind,
  LocalProviderHealth,
  LocalProviderOptions,
} from "./local";
import {
  MAX_MODEL_OUTPUT_TOKENS,
  type BrowserCloudTransportOptions,
  type InferenceModelDescriptor,
  type OpenAiCompatibleProviderInput,
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

  it("snapshots every connectCloud accessor once before discovery and promotion", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const firstSignal = new AbortController();
    const replacementSignal = new AbortController();
    const reads = {
      providerId: 0,
      provider: 0,
      connectionId: 0,
      label: 0,
      apiKey: 0,
      acknowledge: 0,
      signal: 0,
    };
    const providers: InferenceModelDescriptor["providerId"][] = [];
    const providerObjects: object[] = [];
    const discoveredKeys: string[] = [];
    const discoverySignals: AbortSignal[] = [];
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      cloudTransportFactory: (provider, options) => {
        providers.push(provider.id);
        providerObjects.push(provider);
        return new PausingCloudTransport(
          provider.id,
          options,
          entered,
          release,
          discoveredKeys,
          discoverySignals,
        );
      },
    });
    const args = Object.defineProperties({}, {
      providerId: {
        enumerable: true,
        get: () => (++reads.providerId === 1 ? "openai" : "xai"),
      },
      provider: {
        enumerable: true,
        get: () => {
          reads.provider += 1;
          return undefined;
        },
      },
      connectionId: {
        enumerable: true,
        get: () => (++reads.connectionId === 1 ? "snapshot-cloud" : "poisoned-id"),
      },
      label: {
        enumerable: true,
        get: () => (++reads.label === 1 ? "Snapshot account" : "Poisoned account"),
      },
      apiKey: {
        enumerable: true,
        get: () => (++reads.apiKey === 1 ? "snapshot-cloud-key" : "poisoned-cloud-key"),
      },
      acknowledgeDirectBrowserCredentialRisk: {
        enumerable: true,
        get: () => (++reads.acknowledge === 1),
      },
      signal: {
        enumerable: true,
        get: () => (++reads.signal === 1 ? firstSignal.signal : replacementSignal.signal),
      },
    }) as Parameters<BrowserInferenceFabric["connectCloud"]>[0];

    const pending = fabric.connectCloud(args);
    await entered.promise;
    replacementSignal.abort(new Error("A later signal must not replace the staged signal."));
    release.resolve();
    const connected = await pending;
    const committedKey = await readApiKey(
      fabric,
      connected.connection.id,
      connected.connection.generation,
    );

    expect(reads).toEqual({
      providerId: 1,
      provider: 1,
      connectionId: 1,
      label: 1,
      apiKey: 1,
      acknowledge: 1,
      signal: 1,
    });
    expect(providers).toEqual(["openai", "openai"]);
    expect(providerObjects[0]).toBe(providerObjects[1]);
    expect(discoveredKeys).toEqual(["snapshot-cloud-key"]);
    expect(committedKey).toBe("snapshot-cloud-key");
    expect(discoverySignals).toEqual([firstSignal.signal]);
    expect(connected.connection).toMatchObject({
      id: "snapshot-cloud",
      providerId: "openai",
      label: "Snapshot account",
    });
  });

  it("snapshots custom connection and nested provider accessors before SHA-256 yields", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const firstSignal = new AbortController();
    const replacementSignal = new AbortController();
    const outerReads = {
      provider: 0,
      connectionId: 0,
      connectionLabel: 0,
      apiKey: 0,
      acknowledge: 0,
      signal: 0,
    };
    const providerReads = {
      label: 0,
      baseUrl: 0,
      modelsUrl: 0,
      apiKeyHeader: 0,
      apiKeyScheme: 0,
    };
    let providerLabel = "Snapshot gateway";
    let baseUrl = "https://snapshot.example.test/v1";
    let modelsUrl = "https://snapshot-catalog.example.test/models";
    let apiKeyHeader = "x-api-key";
    let apiKeyScheme: "raw" | "bearer" = "raw";
    let connectionId = "snapshot-custom";
    let connectionLabel = "Snapshot custom account";
    let apiKey = "snapshot-custom-key";
    let acknowledged = true;
    let signal = firstSignal.signal;
    const providerInput = Object.defineProperties({}, {
      label: {
        enumerable: true,
        get: () => {
          providerReads.label += 1;
          return providerLabel;
        },
      },
      baseUrl: {
        enumerable: true,
        get: () => {
          providerReads.baseUrl += 1;
          return baseUrl;
        },
      },
      modelsUrl: {
        enumerable: true,
        get: () => {
          providerReads.modelsUrl += 1;
          return modelsUrl;
        },
      },
      apiKeyHeader: {
        enumerable: true,
        get: () => {
          providerReads.apiKeyHeader += 1;
          return apiKeyHeader;
        },
      },
      apiKeyScheme: {
        enumerable: true,
        get: () => {
          providerReads.apiKeyScheme += 1;
          return apiKeyScheme;
        },
      },
    }) as OpenAiCompatibleProviderInput;
    const args = Object.defineProperties({}, {
      provider: {
        enumerable: true,
        get: () => {
          outerReads.provider += 1;
          return providerInput;
        },
      },
      connectionId: {
        enumerable: true,
        get: () => {
          outerReads.connectionId += 1;
          return connectionId;
        },
      },
      connectionLabel: {
        enumerable: true,
        get: () => {
          outerReads.connectionLabel += 1;
          return connectionLabel;
        },
      },
      apiKey: {
        enumerable: true,
        get: () => {
          outerReads.apiKey += 1;
          return apiKey;
        },
      },
      acknowledgeDirectBrowserCredentialRisk: {
        enumerable: true,
        get: () => {
          outerReads.acknowledge += 1;
          return acknowledged;
        },
      },
      signal: {
        enumerable: true,
        get: () => {
          outerReads.signal += 1;
          return signal;
        },
      },
    }) as Parameters<BrowserInferenceFabric["connectOpenAiCompatible"]>[0];
    const providers: object[] = [];
    const discoveredKeys: string[] = [];
    const discoverySignals: AbortSignal[] = [];
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      cloudTransportFactory: (provider, options) => {
        providers.push(provider);
        return new PausingCloudTransport(
          provider.id,
          options,
          entered,
          release,
          discoveredKeys,
          discoverySignals,
        );
      },
    });

    const pending = fabric.connectOpenAiCompatible(args);
    // SHA-256 is the first asynchronous boundary. Mutate every backing value
    // before its promise settles; none may be consulted afterward.
    providerLabel = "Poisoned gateway";
    baseUrl = "https://poisoned.example.test/v1/";
    modelsUrl = "https://poisoned-catalog.example.test/models";
    apiKeyHeader = "Authorization";
    apiKeyScheme = "bearer";
    connectionId = "poisoned-custom";
    connectionLabel = "Poisoned custom account";
    apiKey = "poisoned-custom-key";
    acknowledged = false;
    signal = replacementSignal.signal;
    replacementSignal.abort(new Error("A later signal must not replace the staged signal."));

    await entered.promise;
    release.resolve();
    const connected = await pending;
    const committedKey = await readApiKey(
      fabric,
      connected.connection.id,
      connected.connection.generation,
    );

    expect(outerReads).toEqual({
      provider: 1,
      connectionId: 1,
      connectionLabel: 1,
      apiKey: 1,
      acknowledge: 1,
      signal: 1,
    });
    expect(providerReads).toEqual({
      label: 1,
      baseUrl: 1,
      modelsUrl: 1,
      apiKeyHeader: 1,
      apiKeyScheme: 1,
    });
    expect(providers).toHaveLength(2);
    expect(providers[0]).toBe(providers[1]);
    expect(discoveredKeys).toEqual(["snapshot-custom-key"]);
    expect(committedKey).toBe("snapshot-custom-key");
    expect(discoverySignals).toEqual([firstSignal.signal]);
    expect(connected.connection).toMatchObject({
      id: "snapshot-custom",
      label: "Snapshot custom account",
    });
    expect(connected.provider).toMatchObject({
      label: "Snapshot gateway",
      baseUrl: "https://snapshot.example.test/v1/",
      modelsUrl: "https://snapshot-catalog.example.test/models",
      authMethods: [expect.objectContaining({
        header: { name: "x-api-key", scheme: "raw" },
      })],
    });
    expect(connected.provider.id).not.toContain("snapshot.example.test");
    expect(connected.provider.id).not.toContain("poisoned.example.test");
  });

  it("connects any registered HTTPS OpenAI-compatible provider through the cloud seam", async () => {
    const fabric = testFabric();
    fabric.providers.register(customOpenAiCompatibleProvider());

    const connected = await fabric.connectCloud(cloudInput("custom-openai", "sk-custom-memory-only"));

    expect(connected.connection.providerId).toBe("custom-openai");
    expect(connected.connection.authMethodId).toBe("custom-openai-api-key");
    expect(connected.models[0]).toMatchObject({
      providerId: "custom-openai",
      id: "custom-openai-model",
    });
  });

  it("stages and connects a user-owned OpenAI-compatible endpoint without a vendor branch", async () => {
    const fabric = testFabric(["custom-connection"]);
    const beforeProviders = fabric.providers.snapshot().providers.map((entry) => entry.provider.id);

    const connected = await fabric.connectOpenAiCompatible({
      provider: {
        label: "My gateway",
        baseUrl: "https://gateway.example.test/api/v1/",
        modelsUrl: "https://catalog.example.test/models",
        apiKeyHeader: "x-api-key",
        apiKeyScheme: "raw",
      },
      apiKey: "custom-memory-only",
      acknowledgeDirectBrowserCredentialRisk: true,
    });

    expect(connected.connection).toMatchObject({
      id: expect.stringMatching(/^openai-compatible-[a-f0-9]{64}-custom-connection$/u),
      providerId: expect.stringMatching(/^openai-compatible-[a-f0-9]{64}$/u),
      authKind: "api-key",
    });
    expect(connected.provider).toMatchObject({
      label: "My gateway",
      protocol: "openai-compatible",
      baseUrl: "https://gateway.example.test/api/v1/",
      modelsUrl: "https://catalog.example.test/models",
    });
    expect(connected.provider.id).not.toContain("gateway.example.test");
    expect(connected.models[0]?.providerId).toBe(connected.provider.id);
    expect(fabric.providers.snapshot().providers.map((entry) => entry.provider.id))
      .toEqual([...beforeProviders, connected.provider.id].sort());
    expect(JSON.stringify(fabric.list())).not.toContain("custom-memory-only");
  });

  it("does not register a custom endpoint when its catalog transaction fails", async () => {
    const fabric = testFabric(["custom-rejected"]);
    const before = fabric.providers.snapshot();

    await expect(fabric.connectOpenAiCompatible({
      provider: { label: "Rejected gateway", baseUrl: "https://rejected.example.test/v1/" },
      apiKey: "reject-custom-memory-only",
      acknowledgeDirectBrowserCredentialRisk: true,
    })).rejects.toThrow("rejected test credential");

    expect(fabric.providers.snapshot()).toEqual(before);
    expect(fabric.list()).toEqual([]);
  });

  it("removes a newly staged descriptor when promotion fails after discovery", async () => {
    let transports = 0;
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      connectionIdFactory: () => "custom-promotion-failure",
      cloudTransportFactory: (provider, options) => {
        transports += 1;
        if (transports === 2) throw new Error("committed transport construction failed");
        return new FakeCloudTransport(provider.id, options);
      },
    });
    const before = fabric.providers.snapshot();

    await expect(fabric.connectOpenAiCompatible({
      provider: { label: "Failed promotion", baseUrl: "https://promotion.example.test/v1/" },
      apiKey: "promotion-memory-only",
      acknowledgeDirectBrowserCredentialRisk: true,
    })).rejects.toThrow("committed transport construction failed");

    expect(fabric.providers.snapshot()).toEqual(before);
    expect(fabric.connections.snapshot().connections).toEqual([]);
    expect(fabric.list()).toEqual([]);
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
      cloudTransportFactory: (_provider, options) =>
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

  it("uses model discovery as local readiness without a redundant health request", async () => {
    let healthRequests = 0;
    const provider = fakeLocalProvider("ready");
    const fabric = testFabric([], () => ({
      ...provider,
      async probeHealth(signal): Promise<LocalProviderHealth> {
        healthRequests += 1;
        return provider.probeHealth(signal);
      },
    }));

    const connected = await fabric.connectLocal({ kind: "ollama" });

    expect(connected.models).toHaveLength(1);
    expect(connected.connection.health).toEqual({ state: "ready", checkedAt: OBSERVED_AT });
    expect(healthRequests).toBe(0);
  });

  it("snapshots every connectLocal accessor and nested option exactly once", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const firstSignal = new AbortController();
    const replacementSignal = new AbortController();
    const outerReads = {
      kind: 0,
      connectionId: 0,
      label: 0,
      options: 0,
      signal: 0,
    };
    const optionReads = {
      pageUrl: 0,
      endpoint: 0,
      credential: 0,
      fetch: 0,
      timeoutMs: 0,
      maxResponseBytes: 0,
      maxModels: 0,
    };
    const firstFetch = globalThis.fetch;
    const replacementFetch = globalThis.fetch.bind(globalThis) as typeof fetch;
    const rawOptions = Object.defineProperties({}, {
      pageUrl: {
        enumerable: true,
        get: () => (++optionReads.pageUrl === 1
          ? "http://localhost:4173/chat"
          : "https://poisoned.example.test/chat"),
      },
      endpoint: {
        enumerable: true,
        get: () => (++optionReads.endpoint === 1
          ? "http://127.0.0.1:11434"
          : "http://127.0.0.1:1234"),
      },
      credential: {
        enumerable: true,
        get: () => (++optionReads.credential === 1
          ? undefined
          : () => "poisoned-local-secret"),
      },
      fetch: {
        enumerable: true,
        get: () => (++optionReads.fetch === 1 ? firstFetch : replacementFetch),
      },
      timeoutMs: {
        enumerable: true,
        get: () => (++optionReads.timeoutMs === 1 ? 1_111 : 9_999),
      },
      maxResponseBytes: {
        enumerable: true,
        get: () => (++optionReads.maxResponseBytes === 1 ? 12_345 : 98_765),
      },
      maxModels: {
        enumerable: true,
        get: () => (++optionReads.maxModels === 1 ? 7 : 70),
      },
    }) as LocalProviderOptions;
    const args = Object.defineProperties({}, {
      kind: {
        enumerable: true,
        get: () => (++outerReads.kind === 1 ? "ollama" : "lm-studio"),
      },
      connectionId: {
        enumerable: true,
        get: () => (++outerReads.connectionId === 1
          ? "snapshot-local"
          : "poisoned-local"),
      },
      label: {
        enumerable: true,
        get: () => (++outerReads.label === 1
          ? "Snapshot local"
          : "Poisoned local"),
      },
      options: {
        enumerable: true,
        get: () => {
          outerReads.options += 1;
          return rawOptions;
        },
      },
      signal: {
        enumerable: true,
        get: () => (++outerReads.signal === 1
          ? firstSignal.signal
          : replacementSignal.signal),
      },
    }) as Parameters<BrowserInferenceFabric["connectLocal"]>[0];
    const factoryKinds: LocalModelProviderKind[] = [];
    const discoverySignals: Array<AbortSignal | undefined> = [];
    let factoryOptions: LocalProviderOptions | undefined;
    let providerEndpointReads = 0;
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      localProviderFactory: (kind, options) => {
        factoryKinds.push(kind);
        factoryOptions = options;
        const provider = pausingLocalProvider(
          kind,
          new URL(options?.endpoint ?? "http://127.0.0.1:11434"),
          entered,
          release,
          discoverySignals,
        );
        return Object.defineProperty(provider, "endpoint", {
          enumerable: true,
          get: () => (++providerEndpointReads === 1
            ? new URL("http://127.0.0.1:11434")
            : new URL("http://127.0.0.1:1234")),
        });
      },
    });

    const pending = fabric.connectLocal(args);
    // Async functions run through their first await before returning. All
    // caller accessors must already be exhausted when discovery pauses.
    expect(outerReads).toEqual({
      kind: 1,
      connectionId: 1,
      label: 1,
      options: 1,
      signal: 1,
    });
    expect(optionReads).toEqual({
      pageUrl: 1,
      endpoint: 1,
      credential: 1,
      fetch: 1,
      timeoutMs: 1,
      maxResponseBytes: 1,
      maxModels: 1,
    });
    expect(providerEndpointReads).toBe(1);
    await entered.promise;
    replacementSignal.abort(new Error("A later signal must not replace the snapshot."));
    release.resolve();
    const connected = await pending;

    expect(outerReads).toEqual({
      kind: 1,
      connectionId: 1,
      label: 1,
      options: 1,
      signal: 1,
    });
    expect(optionReads).toEqual({
      pageUrl: 1,
      endpoint: 1,
      credential: 1,
      fetch: 1,
      timeoutMs: 1,
      maxResponseBytes: 1,
      maxModels: 1,
    });
    expect(factoryKinds).toEqual(["ollama"]);
    expect(providerEndpointReads).toBe(1);
    expect(factoryOptions).not.toBe(rawOptions);
    expect(Object.isFrozen(factoryOptions)).toBe(true);
    expect(factoryOptions).toEqual({
      pageUrl: "http://localhost:4173/chat",
      endpoint: "http://127.0.0.1:11434",
      fetch: firstFetch,
      timeoutMs: 1_111,
      maxResponseBytes: 12_345,
      maxModels: 7,
    });
    expect(discoverySignals).toEqual([firstSignal.signal]);
    expect(connected.connection).toMatchObject({
      id: "snapshot-local",
      providerId: "ollama",
      authMethodId: "ollama-loopback",
      label: "Snapshot local",
    });
    expect(connected.provider).toMatchObject({
      id: "ollama",
      label: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1/",
      modelsUrl: "http://127.0.0.1:11434/api/tags",
    });
    expect(connected.models[0]).toMatchObject({
      providerId: "ollama",
      id: "ollama-paused-model",
    });
  });

  it("keeps the immutable local snapshot after caller mutation during discovery", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const firstSignal = new AbortController();
    const replacementSignal = new AbortController();
    const mutableOptions = {
      endpoint: "http://127.0.0.1:11434",
      pageUrl: "http://localhost:4173/chat",
      timeoutMs: 2_222,
      maxResponseBytes: 22_222,
      maxModels: 4,
    };
    const mutableArgs: {
      kind: LocalModelProviderKind;
      connectionId: string;
      label: string;
      options: LocalProviderOptions;
      signal: AbortSignal;
    } = {
      kind: "ollama",
      connectionId: "mutable-local",
      label: "Mutable snapshot",
      options: mutableOptions,
      signal: firstSignal.signal,
    };
    const discoverySignals: Array<AbortSignal | undefined> = [];
    let factoryOptions: LocalProviderOptions | undefined;
    let observedAfterRelease: Readonly<{
      endpoint: string | undefined;
      maxModels: number | undefined;
    }> | undefined;
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      localProviderFactory: (kind, options) => {
        factoryOptions = options;
        return pausingLocalProvider(
          kind,
          new URL(options?.endpoint ?? "http://127.0.0.1:11434"),
          entered,
          release,
          discoverySignals,
          () => {
            observedAfterRelease = Object.freeze({
              endpoint: options?.endpoint,
              maxModels: options?.maxModels,
            });
          },
        );
      },
    });

    const pending = fabric.connectLocal(mutableArgs);
    await entered.promise;
    mutableArgs.kind = "lm-studio";
    mutableArgs.connectionId = "poisoned-local";
    mutableArgs.label = "Poisoned local";
    mutableArgs.signal = replacementSignal.signal;
    mutableOptions.endpoint = "http://127.0.0.1:1234";
    mutableOptions.pageUrl = "https://poisoned.example.test/chat";
    mutableOptions.timeoutMs = 9_999;
    mutableOptions.maxResponseBytes = 99_999;
    mutableOptions.maxModels = 40;
    release.resolve();
    const connected = await pending;

    expect(factoryOptions).not.toBe(mutableOptions);
    expect(Object.isFrozen(factoryOptions)).toBe(true);
    expect(observedAfterRelease).toEqual({
      endpoint: "http://127.0.0.1:11434",
      maxModels: 4,
    });
    expect(discoverySignals).toEqual([firstSignal.signal]);
    expect(connected.connection).toMatchObject({
      id: "mutable-local",
      providerId: "ollama",
      authMethodId: "ollama-loopback",
      label: "Mutable snapshot",
    });
    expect(connected.provider).toMatchObject({ id: "ollama", label: "Ollama" });
    expect(connected.models[0]?.providerId).toBe("ollama");
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

    expect(fabric.connections.require(connected.connection.id).capabilities.invoke)
      .toEqual({ state: "available", source: "provider-declared" });

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

  it("never revives a selected route after its exact credential generation is replaced", async () => {
    const fabric = testFabric();
    const first = await fabric.connectCloud({
      ...cloudInput("openai", "sk-first"),
      connectionId: "openai-main",
    });
    const firstRoute = await fabric.activate(first.connection.id, first.models[0]!.id);

    expect(fabric.disconnect(first.connection.id)).toBe(true);
    const replacement = await fabric.connectCloud({
      ...cloudInput("openai", "sk-replacement"),
      connectionId: "openai-main",
    });
    expect(replacement.connection).toMatchObject({ id: "openai-main", generation: 2 });
    expect(fabric.resolve(firstRoute.pin)).toMatchObject({ state: "connection-replaced" });
    await expect(collect(firstRoute.transport.stream(
      inferenceRequest(first.models[0]!.id),
      new AbortController().signal,
    ))).rejects.toThrow("exact connection authority is no longer active");

    await expect(fabric.activate("openai-main", replacement.models[0]!.id)).resolves.toMatchObject({
      pin: { connection: { id: "openai-main", generation: 2 } },
    });
    expect(fabric.connections.require("openai-main").capabilities.invoke)
      .toEqual({ state: "available", source: "provider-declared" });
  });

  it("carries an operator-declared model window into the catalog, the agent snapshot, and the request ceiling", async () => {
    let outputCeilingFor: ((modelId: string) => number | undefined) | undefined;
    const fabric = new BrowserInferenceFabric({
      now: () => NOW,
      connectionIdFactory: () => "declared-1",
      cloudTransportFactory: (provider, options) => {
        if (options.maxOutputTokensForModel) outputCeilingFor = options.maxOutputTokensForModel;
        return new FakeCloudTransport(provider.id, options);
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
      cloudTransportFactory: (provider, options) => {
        if (options.maxOutputTokensForModel) outputCeilingFor = options.maxOutputTokensForModel;
        return new FakeCloudTransport(provider.id, options);
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
    cloudTransportFactory: (provider, options) =>
      new FakeCloudTransport(provider.id, options),
    ...(localProviderFactory
      ? { localProviderFactory: () => localProviderFactory() }
      : {}),
  });
}

function customOpenAiCompatibleProvider() {
  return {
    version: 1 as const,
    id: "custom-openai",
    label: "Custom OpenAI-compatible",
    protocol: "openai-compatible" as const,
    transportBoundary: "provider-tls" as const,
    baseUrl: "https://custom.example.test/v1/",
    modelsUrl: "https://custom.example.test/v1/models",
    oauth: {
      state: "not-documented" as const,
      detail: "This provider uses a bearer API key on its OpenAI-compatible endpoint.",
    },
    authMethods: [{
      id: "custom-openai-api-key",
      kind: "api-key" as const,
      label: "Custom API key",
      header: { name: "Authorization", scheme: "bearer" as const },
      browserUse: "direct-contract-unpublished" as const,
      warning: "This custom endpoint is user-configured and uses a page-memory bearer key.",
    }],
    capabilities: ["invoke", "models:list"] as const,
    documentationUrl: "https://custom.example.test/docs",
  };
}

function cloudInput(
  providerId: string,
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
    private readonly providerId: string,
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

class PausingCloudTransport implements BrowserCloudCatalogTransport {
  readonly id: string;
  readonly posture = "plaintext-remote" as const;

  constructor(
    private readonly providerId: string,
    private readonly options: BrowserCloudTransportOptions,
    private readonly entered: Deferred<void>,
    private readonly release: Deferred<void>,
    private readonly observedKeys: string[],
    private readonly observedSignals: AbortSignal[],
  ) {
    this.id = `${providerId}-pausing`;
  }

  async listModels(
    signal = new AbortController().signal,
  ): Promise<readonly InferenceModelDescriptor[]> {
    this.observedSignals.push(signal);
    signal.throwIfAborted();
    this.entered.resolve();
    await this.release.promise;
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
        this.observedKeys.push(lease.value);
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

async function readApiKey(
  fabric: BrowserInferenceFabric,
  connectionId: string,
  generation: number,
): Promise<string> {
  return fabric.connections.useCredential(
    connectionId,
    { expectedGeneration: generation },
    (lease) => {
      if (lease.kind !== "api-key") throw new Error("test connection has no API key");
      return lease.value;
    },
  );
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

function pausingLocalProvider(
  kind: LocalModelProviderKind,
  endpoint: URL,
  entered: Deferred<void>,
  release: Deferred<void>,
  observedSignals: Array<AbortSignal | undefined>,
  afterRelease: () => void = () => undefined,
): BrowserLocalModelProvider {
  const transport: InferenceTransport = {
    id: `${kind}-pausing-local`,
    posture: "local",
    async *stream(_request, signal) {
      signal.throwIfAborted();
      yield { type: "completed", finishReason: "stop" };
    },
  };
  return {
    kind,
    endpoint,
    async probeHealth(): Promise<LocalProviderHealth> {
      return {
        provider: kind,
        endpoint: endpoint.origin,
        state: "ready",
        checkedAt: OBSERVED_AT,
        cors: "confirmed",
      };
    },
    async discoverModels(signal): Promise<LocalModelDiscovery> {
      observedSignals.push(signal);
      signal?.throwIfAborted();
      entered.resolve();
      await release.promise;
      signal?.throwIfAborted();
      afterRelease();
      return {
        provider: kind,
        endpoint: endpoint.origin,
        fetchedAt: OBSERVED_AT,
        models: [{
          id: `${kind}-paused-model`,
          provider: kind,
          state: "loaded",
          capabilities: [{
            capability: "text-generation",
            state: "supported",
            source: "adversarial-test",
          }],
        }],
        diagnostics: [],
        complete: true,
      };
    },
    createTransport: () => transport,
  };
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
      if (mode === "fail") throw new Error("local endpoint is unavailable");
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
            source: "/api/tags:capabilities",
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
  return {
    ...base,
    createTransport: () => ({
      id: "ollama-revocation-test",
      posture: "local",
      async *stream(_request, signal) {
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
