import { afterEach, describe, expect, it, vi } from "vitest";
import { loadChutesAccountSnapshot } from "./client";

type PendingFetch = {
  url: URL;
  init: RequestInit | undefined;
  resolve: (response: Response) => void;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadChutesAccountSnapshot", () => {
  it("starts four browser-direct GETs in parallel and normalizes the current UTC month", async () => {
    const pending: PendingFetch[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      pending.push({ url: new URL(String(input)), init, resolve });
    })));
    const signal = new AbortController().signal;
    const promise = loadChutesAccountSnapshot({
      credential: "cak_airship_test",
      signal,
      apiBase: "https://account.example.test",
      now: () => new Date("2026-07-18T12:34:56.789Z"),
    });

    await vi.waitFor(() => expect(pending).toHaveLength(4));
    expect(pending.map(({ url }) => url.pathname).sort()).toEqual([
      "/users/me",
      "/users/me/quotas",
      "/users/me/subscription_usage",
      "/users/me/usage",
    ]);
    for (const request of pending) {
      expect(request.init?.method).toBe("GET");
      expect(request.init?.credentials).toBe("omit");
      expect(request.init?.signal).toBe(signal);
      expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer cak_airship_test");
      expect(request.url.href).not.toContain("cak_airship_test");
    }
    const usageRequest = pending.find(({ url }) => url.pathname === "/users/me/usage")!;
    expect(usageRequest.url.searchParams.get("start_date")).toBe("2026-07-01T00:00:00");
    expect(usageRequest.url.searchParams.get("end_date")).toBe("2026-07-18T12:34:56");
    expect(usageRequest.url.searchParams.get("page")).toBe("0");
    expect(usageRequest.url.searchParams.get("limit")).toBe("1000");

    respond(pending, "/users/me", {
      username: "airship-user",
      user_id: "user-123",
      balance: 42.5,
    });
    respond(pending, "/users/me/quotas", [
      { chute_id: "chute-1", quota: 100, effective_date: "2026-07-01T00:00:00" },
      { chute_id: "chute-2", quota: "unlimited" },
    ]);
    respond(pending, "/users/me/subscription_usage", {
      subscription: true,
      custom: false,
      monthly_price: 20,
      four_hour: { usage: 1.5, cap: 4, remaining: 2.5, reset_at: "2026-07-18T16:00:00" },
      monthly: { usage: 8, cap: 40, remaining: 32, reset_at: "2026-08-01T00:00:00" },
    });
    respond(pending, "/users/me/usage", {
      total: 2,
      page: 0,
      limit: 1000,
      items: [
        { bucket: "2026-07-18T12:00:00", amount: 1.25, count: 3, input_tokens: 100, output_tokens: 20 },
        { bucket: "2026-07-18T11:00:00", amount: 0.75, count: 2, input_tokens: 40, output_tokens: 10 },
      ],
    });

    const snapshot = await promise;
    expect(snapshot).toMatchObject({
      fetchedAt: "2026-07-18T12:34:56.789Z",
      account: { username: "airship-user", userId: "user-123", balance: 42.5 },
      subscription: {
        active: true,
        custom: false,
        monthlyPrice: 20,
        fourHour: { usage: 1.5, cap: 4, remaining: 2.5, resetAt: "2026-07-18T16:00:00" },
        monthly: { usage: 8, cap: 40, remaining: 32, resetAt: "2026-08-01T00:00:00" },
      },
      usage: {
        totalCost: 2,
        totalRequests: 5,
        inputTokens: 140,
        outputTokens: 30,
        rangeStart: "2026-07-01T00:00:00",
        rangeEnd: "2026-07-18T12:34:56",
      },
      quotas: { rawCount: 2, unlimited: true },
      issues: [],
      complete: true,
    });
    expect(snapshot.usage?.entries).toHaveLength(2);
  });

  it("returns usable partial data with redacted per-source issues", async () => {
    const credential = "cak_secret-never-report-this";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/me") return jsonResponse({ username: "partial-user", balance: "12.50" });
      if (path === "/users/me/quotas") {
        return new Response(JSON.stringify({ detail: credential }), {
          status: 503,
          headers: { "x-request-id": "request-safe-123" },
        });
      }
      if (path === "/users/me/subscription_usage") return new Response("not-json", { status: 200 });
      return jsonResponse({ items: [] });
    }));

    const snapshot = await loadChutesAccountSnapshot({
      credential,
      signal: new AbortController().signal,
      now: () => new Date("2026-07-02T01:02:03Z"),
    });

    expect(snapshot.account).toEqual({ username: "partial-user", userId: undefined, balance: 12.5 });
    expect(snapshot.usage?.entries).toEqual([]);
    expect(snapshot.quotas).toBeUndefined();
    expect(snapshot.subscription).toBeUndefined();
    expect(snapshot.complete).toBe(false);
    expect(snapshot.issues).toEqual([
      {
        source: "quotas",
        code: "http",
        message: "Quotas telemetry returned HTTP 503.",
        status: 503,
        requestId: "request-safe-123",
        retryable: true,
      },
      {
        source: "subscription",
        code: "invalid-json",
        message: "Subscription telemetry was not valid JSON.",
        retryable: false,
      },
    ]);
    expect(JSON.stringify(snapshot.issues)).not.toContain(credential);
  });

  it("aborts promptly even when an injected fetch ignores the signal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const controller = new AbortController();
    const promise = loadChutesAccountSnapshot({
      credential: "cak_abort_test",
      signal: controller.signal,
      now: () => new Date("2026-07-02T01:02:03Z"),
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects unsafe credentials and API bases before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    await expect(loadChutesAccountSnapshot({ credential: "bad\r\ntoken", signal })).rejects.toThrow("invalid format");
    await expect(loadChutesAccountSnapshot({
      credential: "cak_valid-token",
      signal,
      apiBase: "http://remote.example.test",
    })).rejects.toThrow("must use HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds response size without sacrificing the other sources", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/me/quotas") {
        return new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } });
      }
      if (path === "/users/me") return jsonResponse({ user_id: "bounded-user" });
      if (path === "/users/me/subscription_usage") return jsonResponse({ subscription: false });
      return jsonResponse({ items: [] });
    }));
    const snapshot = await loadChutesAccountSnapshot({
      credential: "cak_bounded_test",
      signal: new AbortController().signal,
      now: () => new Date("2026-07-02T01:02:03Z"),
    });
    expect(snapshot.account?.userId).toBe("bounded-user");
    expect(snapshot.issues).toContainEqual({
      source: "quotas",
      code: "response-too-large",
      message: "Quotas telemetry exceeded the safe response limit.",
      retryable: false,
    });
  });

  it("keeps empty quota objects neutral instead of inferring unlimited access", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/me") return jsonResponse({ username: "empty-quota-user" });
      if (path === "/users/me/quotas") return jsonResponse({});
      if (path === "/users/me/subscription_usage") return jsonResponse({ subscription: false });
      return jsonResponse({ total: 0, items: [] });
    }));

    const snapshot = await loadChutesAccountSnapshot({
      credential: "cak_empty_quota_test",
      signal: new AbortController().signal,
      now: () => new Date("2026-07-02T01:02:03Z"),
    });

    expect(snapshot.quotas).toEqual({ entries: [], rawCount: 0, unlimited: false });
    expect(snapshot.subscription).toEqual({
      active: false,
      monthlyPrice: undefined,
      custom: undefined,
      monthly: undefined,
      fourHour: undefined,
    });
  });
});

function respond(pending: PendingFetch[], path: string, value: unknown): void {
  pending.find(({ url }) => url.pathname === path)!.resolve(jsonResponse(value));
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
