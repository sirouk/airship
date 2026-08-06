import { describe, expect, it } from "vitest";
import { fetchWithRetry, HttpResponseError } from "./http";
import { jsonResponse, stubFetch } from "./test-helpers";

/**
 * Retry/timeout/abort semantics of the provider HTTP layer. Timing-sensitive
 * cases pin delays via retry-after-ms: 1 or maxRetryDelayMs: 1 so the suite
 * stays millisecond-fast while exercising the same code paths.
 */

async function expectHttpError(promise: Promise<Response>): Promise<HttpResponseError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpResponseError) return error;
    throw error;
  }
  throw new Error("expected HttpResponseError");
}

describe("fetchWithRetry", () => {
  it("returns the response on success without retrying", async () => {
    let calls = 0;
    const stub = stubFetch(() => {
      calls += 1;
      return jsonResponse({ ok: true });
    });
    try {
      const response = await fetchWithRetry({ url: "https://example.com", headers: {}, body: {} });
      expect(response.ok).toBe(true);
      expect(calls).toBe(1);
    } finally {
      stub.restore();
    }
  });

  it("retries retryable statuses and honors retry-after-ms", async () => {
    let calls = 0;
    const stub = stubFetch(() => {
      calls += 1;
      if (calls < 3) return jsonResponse({ error: "slow" }, { status: 429, headers: { "retry-after-ms": "1" } });
      return jsonResponse({ ok: true });
    });
    try {
      const started = Date.now();
      const response = await fetchWithRetry({ url: "https://example.com", headers: {}, body: {} });
      expect(response.ok).toBe(true);
      expect(calls).toBe(3);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      stub.restore();
    }
  });

  it("caps server-requested retry-after at maxRetryDelayMs", async () => {
    let calls = 0;
    const stub = stubFetch(() => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "slow" }, { status: 429, headers: { "retry-after": "30" } });
      return jsonResponse({ ok: true });
    });
    try {
      const started = Date.now();
      const response = await fetchWithRetry({ url: "https://example.com", headers: {}, body: {}, maxRetryDelayMs: 1 });
      expect(response.ok).toBe(true);
      expect(calls).toBe(2);
      // 30s of server delay was clamped to ~1ms
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      stub.restore();
    }
  });

  it("respects x-should-retry both ways", async () => {
    let trueCalls = 0;
    const trueStub = stubFetch(() => {
      trueCalls += 1;
      if (trueCalls === 1) return jsonResponse({ error: "please retry" }, { status: 400, headers: { "x-should-retry": "true", "retry-after-ms": "1" } });
      return jsonResponse({ ok: true });
    });
    try {
      const response = await fetchWithRetry({ url: "https://example.com", headers: {}, body: {} });
      expect(response.ok).toBe(true);
      expect(trueCalls).toBe(2);
    } finally {
      trueStub.restore();
    }

    let falseCalls = 0;
    const falseStub = stubFetch(() => {
      falseCalls += 1;
      return jsonResponse({ error: "do not retry" }, { status: 503, headers: { "x-should-retry": "false" } });
    });
    try {
      await expectHttpError(fetchWithRetry({ url: "https://example.com", headers: {}, body: {}, maxRetries: 5 }));
      expect(falseCalls).toBe(1);
    } finally {
      falseStub.restore();
    }
  });

  it("throws HttpResponseError with parsed body after the budget is exhausted", async () => {
    let calls = 0;
    const stub = stubFetch(() => {
      calls += 1;
      return jsonResponse({ error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529, headers: { "retry-after-ms": "1", "request-id": "req_x" } });
    });
    try {
      const error = await expectHttpError(fetchWithRetry({ url: "https://example.com", headers: {}, body: {}, maxRetries: 2 }));
      expect(calls).toBe(3);
      expect(error.status).toBe(529);
      expect(error.requestID).toBe("req_x");
      expect(error.error).toEqual({ error: { type: "overloaded_error", message: "Overloaded" } });
    } finally {
      stub.restore();
    }
  });

  it("retries network failures within the budget", async () => {
    let calls = 0;
    const stub = stubFetch(() => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse({ ok: true });
    });
    try {
      const response = await fetchWithRetry({ url: "https://example.com", headers: {}, body: {}, maxRetryDelayMs: 1 });
      expect(response.ok).toBe(true);
      expect(calls).toBe(2);
    } finally {
      stub.restore();
    }
  });

  it("times out a hung request within timeoutMs", async () => {
    // A hung fetch that behaves like real fetch: rejects when the composed
    // (timeout) signal aborts, so the retry loop's timed-out branch runs.
    const stub = stubFetch(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        }),
    );
    try {
      const started = Date.now();
      await expect(
        fetchWithRetry({ url: "https://example.com", headers: {}, body: {}, timeoutMs: 25, maxRetries: 0 }),
      ).rejects.toThrow("Request timed out after 25ms");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      stub.restore();
    }
  });

  it("composes the caller signal: an already-aborted signal surfaces as Request was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = stubFetch(() => jsonResponse({ ok: true }));
    try {
      await expect(
        fetchWithRetry({ url: "https://example.com", headers: {}, body: {}, signal: controller.signal }),
      ).rejects.toThrow("Request was aborted");
    } finally {
      stub.restore();
    }
  });

  it("aborts a retry wait when the caller signal fires during backoff", async () => {
    const controller = new AbortController();
    const stub = stubFetch(() => jsonResponse({ error: "slow" }, { status: 429, headers: { "retry-after": "30" } }));
    try {
      const promise = fetchWithRetry({ url: "https://example.com", headers: {}, body: {}, signal: controller.signal });
      setTimeout(() => controller.abort(), 25);
      await expect(promise).rejects.toThrow("Request was aborted");
    } finally {
      stub.restore();
    }
  });
});
