import { describe, expect, it } from "vitest";
import {
  mapRequestFailure,
  mapUnknownRequestFailure,
  observationState,
  TEE_EVIDENCE_FAILURE,
} from "./request-state";
import { claimLanguage } from "./trust-language";

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

  /*
   * This is the text rendered under a failed turn in Chat. It read "TEE
   * evidence failed. Open Proof." — three letters the build expands nowhere:
   * grepping all of src for "trusted execution", "confidential comput" and
   * "end-to-end encrypt" returns one hit, a label on a route this reader has
   * not opened. `claimLanguage` already models the answer for this exact claim,
   * a plain primary beside a technical secondary, and it is asserted here as
   * the reference so rewording the legend fails this test rather than leaving
   * the failure text speaking a vocabulary the product abandoned.
   */
  it("expands the acronym a turn dies on, in the product's own plain register", () => {
    const plain = "Protected";
    expect(claimLanguage("cpuTee").primary).toContain(plain);
    expect(claimLanguage("gpuTee").primary).toContain(plain);
    expect(TEE_EVIDENCE_FAILURE).toContain(`${plain}-runtime (TEE)`);
    expect(TEE_EVIDENCE_FAILURE.indexOf(plain)).toBeLessThan(TEE_EVIDENCE_FAILURE.indexOf("TEE"));
    expect(TEE_EVIDENCE_FAILURE).toContain("Open Proof.");
    expect(mapUnknownRequestFailure({ code: "ATTESTATION_FAILED", status: 403 }, true).message)
      .toBe(TEE_EVIDENCE_FAILURE);
  });

  it("does not misreport attestation and nonce failures as credentials", () => {
    expect(mapUnknownRequestFailure({ code: "ATTESTATION_FAILED", status: 403 }, true).kind).toBe("provider");
    expect(mapUnknownRequestFailure({ code: "NONCE_REJECTED", status: 403 }, true).kind).toBe("provider");
  });

  /*
   * The two limits a person actually reaches had no branch at all: a 429 and a
   * spent balance both landed on "Request failed. Local state was kept", which
   * names neither cause nor remedy. The remedies are asserted, not just the
   * kinds, because the remedy is the whole reason these two are worth telling
   * apart — and the billing sentence must not send a working credential back to
   * the reconnect flow.
   */
  it("names the rate limit and the empty balance, with the remedy each one has", () => {
    const rateLimited = mapUnknownRequestFailure({ code: "HTTP_ERROR", status: 429, operation: "invoke" }, true);
    expect(rateLimited.kind).toBe("rate-limit");
    expect(rateLimited.message).toContain("Rate limit");
    expect(rateLimited.message).toContain("retry");

    const billing = mapUnknownRequestFailure({ code: "HTTP_ERROR", status: 402, operation: "invoke" }, true);
    expect(billing.kind).toBe("billing");
    expect(billing.message).toContain("credit");
    expect(billing.message).toContain("Account");
    expect(billing.message).not.toMatch(/reconnect|api key|sign in/iu);
  });

  /* A provider that answers an exhausted balance or a throttle with 403 was told to switch API keys. */
  it("does not blame the credential for a limit the credential is not part of", () => {
    expect(mapRequestFailure({ online: true, status: 403, code: "INSUFFICIENT_BALANCE" }).kind).toBe("billing");
    expect(mapRequestFailure({ online: true, status: 403, code: "RATE_LIMITED" }).kind).toBe("rate-limit");
    expect(mapRequestFailure({ online: true, status: 403, code: "HTTP_ERROR" }).kind).toBe("credential");
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
