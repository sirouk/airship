import { describe, expect, it } from "vitest";
import {
  mapRequestFailure,
  mapUnknownRequestFailure,
  observationState,
} from "./request-state";

describe("request state mapper", () => {
  it("keeps offline, credential, provider, and transport failures distinct", () => {
    expect(mapRequestFailure({ online: false }).kind).toBe("offline");
    expect(mapRequestFailure({ online: true, status: 401 }).kind).toBe("credential");
    expect(mapRequestFailure({ online: true, status: 500 }).kind).toBe("provider");
    expect(mapRequestFailure({ online: true, code: "NETWORK_TIMEOUT" }).kind).toBe("unreachable");
  });

  it("extracts nested status and code without echoing raw errors", () => {
    expect(mapUnknownRequestFailure({ status: 403, message: "secret provider body" }, true)).toEqual(expect.objectContaining({ kind: "credential" }));
    expect(mapUnknownRequestFailure({ cause: { status: 503 } }, true)).toEqual(expect.objectContaining({ kind: "provider" }));
    expect(mapUnknownRequestFailure(new TypeError("Failed to fetch"), true)).toEqual(expect.objectContaining({ kind: "unreachable" }));
    expect(mapUnknownRequestFailure(new Error("anything"), false)).toEqual(expect.objectContaining({ kind: "offline" }));
    expect(mapUnknownRequestFailure({ status: 403, message: "secret provider body" }, true).message).not.toContain("secret provider body");
  });

  it("explains connection failures in provider-neutral language", () => {
    expect(mapUnknownRequestFailure({ code: "HTTP_ERROR", status: 403, operation: "instance-discovery" }, true)).toEqual({
      kind: "credential",
      message: "Provider connection cannot list endpoints. Reconnect in Providers, then retry.",
    });
    expect(mapUnknownRequestFailure({ code: "HTTP_ERROR", status: 401, operation: "invoke" }, true)).toEqual({
      kind: "credential",
      message: "Provider connection rejected this model request. Reconnect in Providers, then check model access.",
    });
    expect(mapUnknownRequestFailure({ code: "HTTP_ERROR", status: 403 }, true)).toEqual({
      kind: "credential",
      message: "Provider connection rejected the request. Reconnect in Providers or switch credentials.",
    });
  });

  it("keeps rate and provider usage limits distinct from credentials", () => {
    const rateLimited = mapUnknownRequestFailure({ code: "HTTP_ERROR", status: 429, operation: "invoke" }, true);
    expect(rateLimited.kind).toBe("rate-limit");
    expect(rateLimited.message).toContain("Rate limit");
    expect(rateLimited.message).toContain("retry");

    const quota = mapUnknownRequestFailure({ code: "HTTP_ERROR", status: 402, operation: "invoke" }, true);
    expect(quota.kind).toBe("quota");
    expect(quota.message).toContain("usage limit");
    expect(quota.message).toContain("Providers");
    expect(quota.message).not.toMatch(/reconnect|api key|sign in|account\b/iu);
  });

  it("does not blame the credential for a limit the credential is not part of", () => {
    expect(mapRequestFailure({ online: true, status: 403, code: "INSUFFICIENT_BALANCE" }).kind).toBe("quota");
    expect(mapRequestFailure({ online: true, status: 403, code: "QUOTA_EXHAUSTED" }).kind).toBe("quota");
    expect(mapRequestFailure({ online: true, status: 403, code: "RATE_LIMITED" }).kind).toBe("rate-limit");
    expect(mapRequestFailure({ online: true, status: 403, code: "HTTP_ERROR" }).kind).toBe("credential");
  });

  it("does not infer provider authentication from prose in a local invariant error", () => {
    expect(mapUnknownRequestFailure(new Error("The transport posture and credential metadata do not form one connection."), true)).toEqual({
      kind: "unknown",
      message: "Request failed. Local state was kept; no remote success is assumed.",
    });
  });

  it("maps stalled, truncated, and remote failures to bounded generic transport messages", () => {
    expect(mapUnknownRequestFailure({ code: "STREAM_STALLED" }, true)).toEqual({
      kind: "unreachable",
      message: "Provider connection stalled during streaming. The partial response was kept; retry the turn.",
    });
    expect(mapUnknownRequestFailure({ code: "STREAM_TRUNCATED" }, true)).toEqual({
      kind: "provider",
      message: "Provider returned an incomplete response. The partial response was kept; retry the turn.",
    });
    expect(mapUnknownRequestFailure({ code: "INVALID_RESPONSE" }, true)).toEqual({
      kind: "provider",
      message: "Provider returned an incomplete response. The partial response was kept; retry the turn.",
    });
    expect(mapUnknownRequestFailure({ code: "NETWORK_UNREACHABLE" }, true)).toEqual({
      kind: "unreachable",
      message: "Provider connection unreachable. Check connectivity and retry; local state was kept.",
    });
  });

  it("keeps model discovery provider-side when the catalog itself is unavailable", () => {
    expect(mapUnknownRequestFailure({ code: "HTTP_ERROR", status: 403, operation: "model-discovery" }, true)).toEqual({
      kind: "provider",
      message: "Provider model list unavailable; retry later.",
    });
  });

  it("marks old observations stale", () => {
    const now = Date.parse("2026-07-18T12:00:00Z");
    expect(observationState("2026-07-18T11:59:00Z", 120_000, now).stale).toBe(false);
    expect(observationState("2026-07-17T11:59:00Z", 120_000, now).stale).toBe(true);
  });
});
