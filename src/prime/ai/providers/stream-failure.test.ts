import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types";
import { HttpResponseError } from "./http";
import {
  classifyStreamFailure,
  extractStreamFailureInfo,
  formatStreamFailureMessage,
  recordStreamFailure,
  StreamFailureError,
  streamFailureFromStopReason,
  streamFailureMessage,
} from "./stream-failure";

/**
 * Ported stream-failure taxonomy unit tests (SDK-free variant: the provider
 * SDK error shapes are replaced by this port's HttpResponseError, which
 * carries the same fields the classifier extracts from).
 */

describe("classifyStreamFailure", () => {
  it.each([
    ["overloaded_error", undefined, "overloaded"],
    [undefined, 529, "overloaded"],
    ["rate_limit_error", undefined, "rate_limit"],
    [undefined, 429, "rate_limit"],
    ["refusal", undefined, "refusal"],
    ["sensitive", undefined, "safety"],
    ["SAFETY", undefined, "safety"],
    ["PROHIBITED_CONTENT", undefined, "safety"],
    ["content_filter", undefined, "safety"],
    ["guardrail_intervened", undefined, "safety"],
    ["authentication_error", undefined, "auth"],
    ["invalid_request_error", undefined, "invalid_request"],
    ["api_error", undefined, "server_error"],
    [undefined, 503, "server_error"],
    ["something_else", undefined, "unknown"],
  ] as const)("classifies %s / %s as %s", (type, status, expected) => {
    expect(classifyStreamFailure(type, status)).toBe(expected);
  });
});

describe("streamFailureFromStopReason", () => {
  it("preserves the raw stop reason instead of a generic message", () => {
    const error = streamFailureFromStopReason("refusal", { requestId: "req_abc" });
    expect(error.message).toBe("Model refused to respond (refusal) [request_id: req_abc]");
    expect(error.info).toMatchObject({ kind: "refusal", providerErrorType: "refusal", requestId: "req_abc" });
  });

  it("maps safety finish reasons", () => {
    expect(streamFailureFromStopReason("SAFETY").info.kind).toBe("safety");
    expect(streamFailureFromStopReason("MALFORMED_FUNCTION_CALL").info.kind).toBe("malformed_response");
  });

  it("still explains a missing stop reason", () => {
    const error = streamFailureFromStopReason(undefined);
    expect(error.info.kind).toBe("unknown");
    expect(error.message).toContain("no stop reason");
  });
});

describe("streamFailureMessage", () => {
  it("composes kind, type, status, detail, and request id", () => {
    expect(
      streamFailureMessage({ kind: "overloaded", providerErrorType: "overloaded_error", status: 529, requestId: "r" }, "Overloaded"),
    ).toBe("Provider overloaded (overloaded_error, 529): Overloaded [request_id: r]");
    expect(streamFailureMessage({ kind: "unknown" })).toBe("Provider stream failed");
  });
});

describe("HttpResponseError extraction", () => {
  it("extracts status, nested error type/message, and request id", () => {
    const httpError = new HttpResponseError(
      {
        status: 401,
        headers: { "request-id": "req_1" },
      },
      JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
    );
    expect(extractStreamFailureInfo(httpError)).toMatchObject({
      kind: "auth",
      providerErrorType: "authentication_error",
      status: 401,
      requestId: "req_1",
    });
    expect(formatStreamFailureMessage(httpError)).toBe(
      "Provider authentication failed (authentication_error, 401): invalid x-api-key [request_id: req_1]",
    );
  });

  it("falls back to status-based classification without a body", () => {
    const httpError = new HttpResponseError({ status: 529, headers: {} }, "");
    expect(httpError.message).toBe("529 (no body)");
    expect(extractStreamFailureInfo(httpError)).toMatchObject({ kind: "overloaded", status: 529 });
    expect(formatStreamFailureMessage(httpError)).toBe("Provider overloaded (529)");
  });
});

describe("formatStreamFailureMessage", () => {
  it("passes unrecognized errors through verbatim", () => {
    expect(formatStreamFailureMessage(new Error("fetch failed"))).toBe("fetch failed");
    expect(formatStreamFailureMessage(new Error("Request was aborted"))).toBe("Request was aborted");
  });

  it("uses the StreamFailureError message as-is", () => {
    const error = streamFailureFromStopReason("refusal");
    expect(formatStreamFailureMessage(error)).toBe(error.message);
  });
});

describe("recordStreamFailure", () => {
  const model = { provider: "anthropic", id: "claude-fable-5", api: "anthropic-messages" };
  const makeOutput = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: 0,
    ...overrides,
  });

  it("appends a structured diagnostic carrying the classification", () => {
    const output = makeOutput({ errorMessage: "Provider overloaded (overloaded_error) [request_id: req_9]" });
    recordStreamFailure(model, output, new StreamFailureError("x", { kind: "overloaded", requestId: "req_9" }));

    expect(output.diagnostics).toHaveLength(1);
    expect(output.diagnostics?.[0]?.code).toBe("provider_stream_failure");
    const detail = JSON.parse(output.diagnostics?.[0]?.detail ?? "{}");
    expect(detail).toMatchObject({ kind: "overloaded", requestId: "req_9", provider: "anthropic", model: "claude-fable-5" });
  });

  it("does nothing for user aborts", () => {
    const output = makeOutput({ stopReason: "aborted" });
    recordStreamFailure(model, output, new Error("Request was aborted"));
    expect(output.diagnostics).toBeUndefined();
  });
});
