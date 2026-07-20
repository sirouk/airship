import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCatalogClient } from "./client";

type PendingRequest = {
  url: URL;
  init?: RequestInit;
  resolve: (response: Response) => void;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ModelCatalogClient", () => {
  it("loads both browser-callable authorities in parallel, anonymously, and caches normalized data", async () => {
    const pending: PendingRequest[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => pending.push({ url: new URL(String(input)), init, resolve })),
    );
    const client = new ModelCatalogClient({
      fetch: fetchMock as typeof fetch,
      modelsUrl: "https://llm.example.test/v1/models",
      apiBase: "https://api.example.test",
      now: () => Date.parse("2026-07-18T12:00:00Z"),
    });
    const promise = client.load();

    await vi.waitFor(() => expect(pending).toHaveLength(3));
    const inference = pending.find(({ url }) => url.hostname === "llm.example.test")!;
    const management = pending.find(({ url }) => url.pathname === "/chutes/")!;
    const utilization = pending.find(({ url }) => url.pathname === "/chutes/utilization")!;
    expect(inference.url.pathname).toBe("/v1/models");
    expect(management.url.pathname).toBe("/chutes/");
    expect(utilization.url.pathname).toBe("/chutes/utilization");
    expect(Object.fromEntries(management.url.searchParams)).toEqual({
      include_public: "true",
      template: "vllm",
      page: "0",
      limit: "500",
      include_schemas: "false",
    });
    for (const request of pending) {
      expect(request.init).toMatchObject({
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(new Headers(request.init?.headers).has("authorization")).toBe(false);
    }

    inference.resolve(jsonResponse(modelCatalog()));
    management.resolve(jsonResponse(managementCatalog({ hot: true, tee: true })));
    utilization.resolve(jsonResponse(utilizationCatalog()));
    const snapshot = await promise;
    expect(snapshot).toMatchObject({
      fetchedAt: "2026-07-18T12:00:00.000Z",
      cache: "network",
      inferenceRecords: 1,
      managementRecords: 1,
      managementTotal: 1,
      utilizationRecords: 1,
      sources: { inference: "fresh", management: "fresh", utilization: "fresh" },
      issues: [],
      complete: true,
    });
    expect(snapshot.models[0]).toMatchObject({
      id: "provider/agent-model",
      chuteId: "chute-1",
      availability: "hot",
      telemetry: { utilization: { oneHour: 0.25 } },
      trust: { attestation: "candidate", verification: "unverified" },
    });

    const cached = await client.load();
    expect(cached.cache).toBe("memory");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends an ephemeral bearer only to /v1/models and validates OAuth scope", async () => {
    const token = "cak_secret-model-token";
    const getBearerToken = vi.fn(() => token);
    const requests: Array<{ url: URL; authorization: string | null }> = [];
    const client = new ModelCatalogClient({
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return url.hostname.startsWith("llm")
          ? jsonResponse(modelCatalog())
          : jsonResponse(url.pathname.endsWith("/utilization") ? utilizationCatalog() : managementCatalog());
      }) as typeof fetch,
      modelsUrl: "https://llm.example.test/v1/models",
      apiBase: "https://api.example.test",
      authorization: {
        kind: "oauth",
        scopes: ["openid", "profile", "chutes:invoke"],
        getBearerToken,
      },
    });

    const snapshot = await client.load();
    expect(requests).toHaveLength(3);
    expect(requests.find(({ url }) => url.hostname === "llm.example.test")).toEqual({
      url: new URL("https://llm.example.test/v1/models"),
      authorization: `Bearer ${token}`,
    });
    expect(requests.find(({ url }) => url.hostname === "api.example.test")).toMatchObject({
      authorization: null,
    });
    expect(requests.filter(({ authorization }) => authorization !== null)).toHaveLength(1);
    expect(getBearerToken).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).not.toContain(token);
    await client.load();
    expect(getBearerToken).toHaveBeenCalledTimes(1);

    const invalid = new ModelCatalogClient({
      fetch: vi.fn() as typeof fetch,
      includeManagement: false,
      authorization: { kind: "oauth", scopes: ["profile"], getBearerToken },
    });
    const invalidSnapshot = await invalid.load();
    expect(invalidSnapshot.sources.inference).toBe("failed");
    expect(invalidSnapshot.issues).toContainEqual({
      source: "llm-models",
      code: "invalid-payload",
      message: "Chutes inference catalog returned an invalid payload.",
      retryable: false,
    });
  });

  it("returns useful inference data when management status is unavailable", async () => {
    const client = new ModelCatalogClient({
      fetch: vi.fn(async (input: RequestInfo | URL) =>
        new URL(String(input)).hostname.startsWith("llm")
          ? jsonResponse(modelCatalog())
          : new Response("unavailable", {
              status: 503,
              headers: { "content-type": "text/plain", "x-request-id": "safe-request-id" },
            }),
      ) as typeof fetch,
      modelsUrl: "https://llm.example.test/v1/models",
      apiBase: "https://api.example.test",
      includeUtilization: false,
    });
    const snapshot = await client.load();
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0]).toMatchObject({
      availability: "unknown",
      trust: {
        confidentialCompute: "asserted",
        teeDeployment: "unknown",
        consistency: "partial",
        attestation: "candidate",
        verification: "unverified",
      },
    });
    expect(snapshot).toMatchObject({
      sources: { inference: "fresh", management: "failed" },
      complete: false,
    });
    expect(snapshot.issues).toEqual([{
      source: "chutes-management",
      code: "http",
      message: "Chutes management catalog returned HTTP 503.",
      retryable: true,
      status: 503,
      requestId: "safe-request-id",
    }]);
  });

  it("bounds response bytes independently and never sacrifices the other source", async () => {
    const client = new ModelCatalogClient({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        if (new URL(String(input)).hostname.startsWith("llm")) {
          return new Response("{}", {
            headers: {
              "content-type": "application/json",
              "content-length": String(2 * 1024 * 1024 + 1),
            },
          });
        }
        return jsonResponse(managementCatalog());
      }) as typeof fetch,
      modelsUrl: "https://llm.example.test/v1/models",
      apiBase: "https://api.example.test",
    });
    const snapshot = await client.load();
    expect(snapshot.models).toEqual([]);
    expect(snapshot.managementRecords).toBe(1);
    expect(snapshot.issues).toContainEqual({
      source: "llm-models",
      code: "response-too-large",
      message: "Chutes inference catalog exceeded the safe response limit.",
      retryable: false,
    });
  });

  it("deduplicates network work and isolates one caller's abort from another caller", async () => {
    const pending: PendingRequest[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => pending.push({ url: new URL(String(input)), init, resolve })),
    );
    const client = new ModelCatalogClient({
      fetch: fetchMock as typeof fetch,
      modelsUrl: "https://llm.example.test/v1/models",
      apiBase: "https://api.example.test",
    });
    const firstController = new AbortController();
    const first = client.load({ signal: firstController.signal });
    const second = client.load();
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(pending.every(({ init }) => !init?.signal?.aborted)).toBe(true);

    pending.find(({ url }) => url.hostname.startsWith("llm"))!.resolve(jsonResponse(modelCatalog()));
    pending.find(({ url }) => url.pathname === "/chutes/")!.resolve(jsonResponse(managementCatalog()));
    pending.find(({ url }) => url.pathname.endsWith("/utilization"))!.resolve(jsonResponse(utilizationCatalog()));
    await expect(second).resolves.toMatchObject({ complete: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("tears down an abandoned shared load even when fetch ignores AbortSignal", async () => {
    const pending: PendingRequest[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => pending.push({ url: new URL(String(input)), init, resolve })),
    );
    const client = new ModelCatalogClient({
      fetch: fetchMock as typeof fetch,
      modelsUrl: "https://llm.example.test/v1/models",
      apiBase: "https://api.example.test",
    });
    const controller = new AbortController();
    const abandoned = client.load({ signal: controller.signal });
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });

    const retry = client.load();
    await vi.waitFor(() => expect(pending).toHaveLength(6));
    const retryRequests = pending.slice(3);
    retryRequests.find(({ url }) => url.hostname.startsWith("llm"))!.resolve(jsonResponse(modelCatalog()));
    retryRequests.find(({ url }) => url.pathname === "/chutes/")!.resolve(jsonResponse(managementCatalog()));
    retryRequests.find(({ url }) => url.pathname.endsWith("/utilization"))!.resolve(jsonResponse(utilizationCatalog()));
    await expect(retry).resolves.toMatchObject({ complete: true });
  });

  it("serves bounded stale metadata when an expired refresh fails", async () => {
    let now = 0;
    let fail = false;
    const client = new ModelCatalogClient({
      fetch: vi.fn(async () => fail
        ? new Response("down", { status: 503, headers: { "content-type": "text/plain" } })
        : jsonResponse(modelCatalog())) as typeof fetch,
      includeManagement: false,
      cacheTtlMs: 100,
      staleTtlMs: 1_000,
      now: () => now,
    });
    const first = await client.load();
    expect(first.cache).toBe("network");
    now = 200;
    fail = true;
    const stale = await client.load();
    expect(stale.cache).toBe("stale-memory");
    expect(stale.models.map((model) => model.id)).toEqual(["provider/agent-model"]);
    expect(stale.complete).toBe(false);
    expect(stale.issues[0]).toMatchObject({ source: "llm-models", code: "http", status: 503 });
  });

  it("downgrades cached operational telemetry when a stale refresh fails", async () => {
    let now = Date.parse("2026-07-18T12:00:00Z");
    let fail = false;
    const client = new ModelCatalogClient({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        if (fail) return new Response("down", { status: 503, headers: { "content-type": "text/plain" } });
        return new URL(String(input)).hostname.startsWith("llm")
          ? jsonResponse(modelCatalog())
          : jsonResponse(utilizationCatalog());
      }) as typeof fetch,
      includeManagement: false,
      includeUtilization: true,
      cacheTtlMs: 100,
      staleTtlMs: 1_000,
      now: () => now,
    });
    expect((await client.load()).models[0]!.telemetry?.freshness).toBe("fresh");
    now += 200;
    fail = true;
    const stale = await client.load();
    expect(stale.cache).toBe("stale-memory");
    expect(stale.models[0]!.telemetry?.freshness).toBe("stale");
  });

  it("debounces refreshes with latest-call-wins cancellation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(modelCatalog()));
    const client = new ModelCatalogClient({
      fetch: fetchMock as typeof fetch,
      includeManagement: false,
      debounceMs: 50,
    });
    const first = client.refreshDebounced();
    const firstRejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = client.refreshDebounced();
    await firstRejection;
    await vi.advanceTimersByTimeAsync(49);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toMatchObject({ sources: { inference: "fresh" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a scheduled refresh immediately when its caller aborts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(modelCatalog()));
    const client = new ModelCatalogClient({
      fetch: fetchMock as typeof fetch,
      includeManagement: false,
      debounceMs: 1_000,
    });
    const controller = new AbortController();
    const promise = client.refreshDebounced({ signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function modelCatalog() {
  return {
    object: "list",
    data: [{
      id: "provider/agent-model",
      chute_id: "chute-1",
      root: "provider/agent-model-root",
      owned_by: "vllm",
      quantization: "fp8",
      context_length: 131_072,
      max_model_len: 131_072,
      max_output_length: 32_768,
      input_modalities: ["text"],
      output_modalities: ["text"],
      supported_features: ["tools", "reasoning"],
      supported_sampling_parameters: ["temperature"],
      confidential_compute: true,
      pricing: { prompt: 0.2, completion: 0.8, input_cache_read: 0.1 },
    }],
  };
}

function managementCatalog(overrides: Record<string, unknown> = {}) {
  return {
    total: 1,
    page: 0,
    limit: 500,
    items: [{
      chute_id: "chute-1",
      name: "provider/agent-model",
      slug: "provider-agent-model",
      public: true,
      tee: true,
      hot: true,
      current_estimated_price: {
        per_million_tokens: { input: { usd: 0.2 }, output: { usd: 0.8 } },
      },
      ...overrides,
    }],
  };
}

function utilizationCatalog() {
  return [{
    chute_id: "chute-1",
    timestamp: "2026-07-18T11:59:30Z",
    utilization_current: 0.2,
    utilization_5m: 0.22,
    utilization_15m: 0.24,
    utilization_1h: 0.25,
    rate_limit_ratio_1h: 0.01,
    total_requests_1h: 400,
    active_instance_count: 3,
    total_instance_count: 4,
    target_count: 5,
    scalable: true,
    scale_allowance: 2,
  }];
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
