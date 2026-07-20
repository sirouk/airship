import { describe, expect, it } from "vitest";
import { parseChutesInvocationTelemetry } from "./telemetry";

describe("Chutes invocation telemetry", () => {
  it("normalizes exposed quota and rate-limit headers", () => {
    const headers = new Headers({
      "X-Chutes-Quota-Total": "5000",
      "X-Chutes-Quota-Used": "125",
      "X-Chutes-Quota-Remaining": "4875",
      "X-Chutes-RL-User": "60",
      "X-Chutes-RL-Chute": "20",
      "X-Chutes-InvocationID": "inv_123",
    });
    expect(parseChutesInvocationTelemetry(headers, 1_000)).toEqual({
      capturedAt: "1970-01-01T00:00:01.000Z",
      invocationId: "inv_123",
      quota: { total: 5000, used: 125, remaining: 4875 },
      rateLimit: { user: 60, chute: 20 },
    });
  });

  it("preserves unlimited and rejects malformed values", () => {
    const headers = new Headers({
      "X-Chutes-RL-User": "inf",
      "X-Chutes-Quota-Used": "-7",
      "X-Chutes-Quota-Remaining": "NaN",
    });
    expect(parseChutesInvocationTelemetry(headers, 0)).toEqual({
      capturedAt: "1970-01-01T00:00:00.000Z",
      rateLimit: { user: "unlimited" },
    });
  });

  it("returns no snapshot when no supported header is present", () => {
    expect(parseChutesInvocationTelemetry(new Headers())).toBeUndefined();
  });
});
