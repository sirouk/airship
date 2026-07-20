import { describe, expect, it } from "vitest";
import { mapRequestFailure, mapUnknownRequestFailure, observationState } from "./request-state";

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
  });

  it("explains the exact protected authorization boundary", () => {
    expect(mapUnknownRequestFailure({ code: "HTTP_ERROR", status: 403, operation: "instance-discovery" }, true)).toEqual({
      kind: "credential",
      message: "Endpoint discovery denied. Reconnect with chutes:invoke or an API key.",
    });
    expect(mapUnknownRequestFailure({ code: "HTTP_ERROR", status: 401, operation: "invoke" }, true)).toEqual({
      kind: "credential",
      message: "Encrypted inference denied. Reconnect, then check account and model access.",
    });
  });

  it("does not misreport attestation and nonce failures as credentials", () => {
    expect(mapUnknownRequestFailure({ code: "ATTESTATION_FAILED", status: 403 }, true).kind).toBe("provider");
    expect(mapUnknownRequestFailure({ code: "NONCE_REJECTED", status: 403 }, true).kind).toBe("provider");
  });

  it("does not infer provider authentication from prose in a local invariant error", () => {
    expect(mapUnknownRequestFailure(new Error("The transport posture and credential metadata do not form one connection."), true)).toEqual({
      kind: "unknown",
      message: "Request failed. Local state was kept; no remote success is assumed.",
    });
  });

  it("maps stalled and truncated streams to actionable bounded failures", () => {
    expect(mapUnknownRequestFailure({ code: "STREAM_STALLED" }, true)).toEqual({
      kind: "unreachable",
      message: "Chutes stopped streaming. The partial response was kept; retry the turn.",
    });
    expect(mapUnknownRequestFailure({ code: "STREAM_TRUNCATED" }, true)).toEqual({
      kind: "provider",
      message: "Chutes returned an incomplete response. The partial response was kept; retry the turn.",
    });
  });

  it("marks old observations stale", () => {
    const now = Date.parse("2026-07-18T12:00:00Z");
    expect(observationState("2026-07-18T11:59:00Z", 120_000, now).stale).toBe(false);
    expect(observationState("2026-07-17T11:59:00Z", 120_000, now).stale).toBe(true);
  });
});
