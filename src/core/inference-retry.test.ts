import { describe, expect, it } from "vitest";
import { LocalProviderError } from "../inference/local/endpoint-policy";
import { ProviderTransportError } from "../inference/providers/browser-cloud";
import type { InferenceEvent, InferenceRequest, InferenceTransport } from "./contracts";
import {
  decorrelatedJitterMs,
  isRetryableTransportFailure,
  namedTransportFailure,
  parseRetryAfterMs,
  retryWaitMs,
  withInferenceRetry,
  type InferenceRetryPolicy,
} from "./inference-retry";

/** Zero waits: the backoff arithmetic is measured separately, below. */
const IMMEDIATE: InferenceRetryPolicy = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };

describe("withInferenceRetry", () => {
  it("redelivers a rate-limited request until the provider answers", async () => {
    const delegate = scriptedTransport([
      httpFailure(429),
      httpFailure(429),
      [{ type: "text-delta", text: "Recovered." }, { type: "completed", finishReason: "stop" }],
    ]);

    await expect(collect(withInferenceRetry(delegate.transport, IMMEDIATE))).resolves.toEqual([
      { type: "text-delta", text: "Recovered." },
      { type: "completed", finishReason: "stop" },
    ]);
    expect(delegate.attempts()).toBe(3);
  });

  it("stops at the attempt ceiling and surfaces the provider's own refusal", async () => {
    const delegate = scriptedTransport([httpFailure(503), httpFailure(503), httpFailure(503)]);

    await expect(collect(withInferenceRetry(delegate.transport, IMMEDIATE)))
      .rejects.toThrow("HTTP 503");
    expect(delegate.attempts()).toBe(3);
  });

  it("never redelivers a refusal the request itself caused", async () => {
    const delegate = scriptedTransport([httpFailure(400)]);

    await expect(collect(withInferenceRetry(delegate.transport, IMMEDIATE)))
      .rejects.toThrow("HTTP 400");
    expect(delegate.attempts()).toBe(1);
  });

  it("never redelivers an authorization refusal, which a second attempt cannot change", async () => {
    const delegate = scriptedTransport([httpFailure(401)]);

    await expect(collect(withInferenceRetry(delegate.transport, IMMEDIATE)))
      .rejects.toThrow("HTTP 401");
    expect(delegate.attempts()).toBe(1);
  });

  it("never redelivers a stream the caller has already seen part of", async () => {
    // The failure is retryable by code. What makes it terminal is that a
    // text-delta already reached the consumer, so replaying the request would
    // duplicate it into the assistant message.
    const delegate = scriptedTransport([
      { events: [{ type: "text-delta", text: "Half an ans" }], then: httpFailure(503) },
      [{ type: "completed", finishReason: "stop" }],
    ]);

    await expect(collect(withInferenceRetry(delegate.transport, IMMEDIATE)))
      .rejects.toThrow("HTTP 503");
    expect(delegate.attempts()).toBe(1);
  });

  it("treats cancellation as the caller's verdict, not the provider's", async () => {
    const controller = new AbortController();
    const delegate = scriptedTransport([
      httpFailure(429),
      [{ type: "completed", finishReason: "stop" }],
    ]);
    const transport = withInferenceRetry(delegate.transport, {
      maxAttempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 200,
    });

    const pending = collect(transport, controller.signal);
    setTimeout(() => controller.abort(new Error("Stopped by user.")), 10);

    await expect(pending).rejects.toThrow("Stopped by user.");
    expect(delegate.attempts()).toBe(1);
  });

  it("passes a transport through untouched when retry is disabled", () => {
    const delegate = scriptedTransport([]);
    expect(withInferenceRetry(delegate.transport, { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }))
      .toBe(delegate.transport);
  });
});

describe("retry classification", () => {
  it("reads the shape the cloud transport really throws", () => {
    const failure = namedTransportFailure(
      new ProviderTransportError("http", "OpenAI rejected the request with HTTP 429.", 429, {
        retryAfter: "2",
      }),
    );

    expect(failure).toEqual({ code: "http", status: 429, retryAfter: "2" });
    expect(isRetryableTransportFailure(failure!)).toBe(true);
  });

  it("reads the shape the local transport really throws", () => {
    const failure = namedTransportFailure(new LocalProviderError({
      code: "http",
      message: "The local inference endpoint returned HTTP 503.",
      severity: "error",
      blocking: true,
      status: 503,
    }));

    expect(failure).toEqual({ code: "http", status: 503 });
    expect(isRetryableTransportFailure(failure!)).toBe(true);
  });

  it("gives no retry to a failure nobody classified", () => {
    expect(namedTransportFailure(new Error("something went wrong"))).toBeUndefined();
    expect(namedTransportFailure("not an error")).toBeUndefined();
  });

  it("retries carriage failures and refuses content verdicts", () => {
    for (const code of ["network-or-cors", "offline", "timeout", "stream-truncated", "stream-interrupted"]) {
      expect(isRetryableTransportFailure({ code })).toBe(true);
    }
    for (const code of ["invalid-response", "tool-call-invalid", "cancelled", "bridge-unavailable"]) {
      expect(isRetryableTransportFailure({ code })).toBe(false);
    }
    expect(isRetryableTransportFailure({ code: "http" })).toBe(false);
    expect(isRetryableTransportFailure({ code: "http", status: 408 })).toBe(true);
    expect(isRetryableTransportFailure({ code: "http", status: 404 })).toBe(false);
    expect(isRetryableTransportFailure({ code: "http", status: 500 })).toBe(true);
    expect(isRetryableTransportFailure({ code: "http", status: 600 })).toBe(false);
  });
});

describe("Retry-After", () => {
  it("reads delay-seconds", () => {
    expect(parseRetryAfterMs("2", 0)).toBe(2_000);
    expect(parseRetryAfterMs(" 30 ", 0)).toBe(30_000);
  });

  it("reads an RFC 7231 HTTP-date relative to now", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:27:00 GMT", now)).toBe(0);
  });

  it("refuses to read a number out of a header that is not one", () => {
    expect(parseRetryAfterMs("1e3", 0)).toBeUndefined();
    expect(parseRetryAfterMs("soon", 0)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, 0)).toBeUndefined();
    expect(parseRetryAfterMs("", 0)).toBeUndefined();
  });

  it("waits exactly as long as the provider asked", () => {
    const error = new ProviderTransportError("http", "rejected", 429, { retryAfter: "3" });
    expect(retryWaitMs(error, { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 8_000 }, 0, 0)).toBe(3_000);
  });

  it("gives up rather than sleeping less than the provider asked", () => {
    const error = new ProviderTransportError("http", "rejected", 429, { retryAfter: "600" });
    expect(retryWaitMs(error, { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 8_000 }, 0, 0)).toBeUndefined();
  });
});

describe("decorrelatedJitterMs", () => {
  const policy: InferenceRetryPolicy = { maxAttempts: 4, baseDelayMs: 400, maxDelayMs: 8_000 };

  it("stays inside the policy window and can grow past the floor", () => {
    let sawGrowth = false;
    for (let trial = 0; trial < 200; trial += 1) {
      const first = decorrelatedJitterMs(policy, 0);
      expect(first).toBe(400);
      const second = decorrelatedJitterMs(policy, first);
      expect(second).toBeGreaterThanOrEqual(400);
      expect(second).toBeLessThanOrEqual(1_200);
      if (second > first) sawGrowth = true;
      expect(decorrelatedJitterMs(policy, 100_000)).toBeLessThanOrEqual(8_000);
    }
    expect(sawGrowth).toBe(true);
  });
});

const REQUEST: InferenceRequest = {
  requestId: "request-1",
  sessionId: "session-1",
  turnId: "turn-1",
  model: "test/model",
  systemPrompt: "Be brief.",
  messages: [],
  tools: [],
  idempotencyKey: "session-1:turn-1:0",
};

function httpFailure(status: number): ProviderTransportError {
  return new ProviderTransportError("http", `Provider rejected the request with HTTP ${status}.`, status);
}

type ScriptedStep =
  | readonly InferenceEvent[]
  | Error
  | Readonly<{ events: readonly InferenceEvent[]; then: Error }>;

function scriptedTransport(steps: readonly ScriptedStep[]) {
  let attempts = 0;
  const transport: InferenceTransport = {
    id: "scripted",
    posture: "local",
    async *stream(_request: InferenceRequest, signal: AbortSignal) {
      attempts += 1;
      signal.throwIfAborted();
      const step = steps[attempts - 1];
      if (!step) throw new Error("Scripted transport exhausted.");
      if (step instanceof Error) throw step;
      if (Array.isArray(step)) {
        for (const event of step as readonly InferenceEvent[]) yield event;
        return;
      }
      const partial = step as Readonly<{ events: readonly InferenceEvent[]; then: Error }>;
      for (const event of partial.events) yield event;
      throw partial.then;
    },
  };
  return { transport, attempts: () => attempts };
}

async function collect(
  transport: InferenceTransport,
  signal: AbortSignal = new AbortController().signal,
): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of transport.stream(REQUEST, signal)) events.push(event);
  return events;
}
