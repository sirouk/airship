import { describe, expect, it } from "vitest";
import { BRIDGE_LIMITS } from "./policy";
import { isBridgeReply, isTerminalReply, parseBridgeRequest } from "./protocol";

const BASE = Object.freeze({
  airshipBridge: 1,
  from: "page",
  id: "req-1",
  kind: "fetch",
  provider: "xai",
  path: "https://api.x.ai/v1/chat/completions",
});

describe("bridge envelope", () => {
  it("accepts the documented hello and fetch shapes", () => {
    expect(parseBridgeRequest({ airshipBridge: 1, from: "page", id: "h", kind: "hello" }))
      .toEqual({ ok: true, request: { kind: "hello", id: "h" } });
    expect(parseBridgeRequest({ airshipBridge: 1, from: "page", id: "h", kind: "cancel" }))
      .toEqual({ ok: true, request: { kind: "cancel", id: "h" } });
    // The prose contract has no `from`; a message without one is still a request.
    expect(parseBridgeRequest({ airshipBridge: 1, id: "h", kind: "hello" }))
      .toEqual({ ok: true, request: { kind: "hello", id: "h" } });
    // A reply is never a request, whatever else it looks like.
    expect(parseBridgeRequest({ airshipBridge: 1, from: "extension", id: "h", kind: "hello" }))
      .toMatchObject({ ok: false, code: "malformed-request" });

    expect(parseBridgeRequest({ ...BASE, method: "POST", headers: { accept: "text/event-stream" }, body: "{}", stream: true }))
      .toEqual({
        ok: true,
        request: {
          kind: "fetch",
          id: "req-1",
          provider: "xai",
          path: "https://api.x.ai/v1/chat/completions",
          method: "POST",
          headers: { accept: "text/event-stream" },
          body: "{}",
          stream: true,
        },
      });
  });

  it("defaults the optional fields conservatively", () => {
    const parsed = parseBridgeRequest(BASE);
    expect(parsed).toMatchObject({ ok: true, request: { method: "GET", stream: false, headers: {} } });
    expect(parsed.ok && "body" in parsed.request).toBe(false);
  });

  it("refuses anything that is not this protocol version", () => {
    for (const raw of [null, "hello", [], { id: "x" }, { airshipBridge: 2, id: "x", kind: "hello" }, { airshipBridge: "1", id: "x", kind: "hello" }]) {
      expect(parseBridgeRequest(raw), JSON.stringify(raw)).toMatchObject({ ok: false, code: "malformed-request" });
    }
  });

  it("refuses ids it could not correlate a reply with", () => {
    for (const id of ["", " ", "a b", "a\n", "x".repeat(BRIDGE_LIMITS.maxRequestIdLength + 1), 7]) {
      expect(parseBridgeRequest({ airshipBridge: 1, from: "page", id, kind: "hello" }), String(id))
        .toMatchObject({ ok: false, code: "malformed-request" });
    }
  });

  it("refuses unsupported kinds, providers, methods and body placements", () => {
    expect(parseBridgeRequest({ ...BASE, kind: "eval" })).toMatchObject({ ok: false });
    expect(parseBridgeRequest({ ...BASE, provider: "openai" })).toMatchObject({ ok: false });
    expect(parseBridgeRequest({ ...BASE, provider: undefined })).toMatchObject({ ok: false });
    expect(parseBridgeRequest({ ...BASE, method: "DELETE" })).toMatchObject({ ok: false });
    expect(parseBridgeRequest({ ...BASE, method: "PUT" })).toMatchObject({ ok: false });
    // A GET with a body is a request the relay would have to reinterpret.
    expect(parseBridgeRequest({ ...BASE, method: "GET", body: "{}" })).toMatchObject({ ok: false });
    expect(parseBridgeRequest({ ...BASE, path: 42 })).toMatchObject({ ok: false });
    expect(parseBridgeRequest({ ...BASE, headers: "accept" })).toMatchObject({ ok: false });
    expect(parseBridgeRequest({ ...BASE, headers: { accept: 5 } })).toMatchObject({ ok: false });
    expect(parseBridgeRequest({ ...BASE, stream: "yes" })).toMatchObject({ ok: false });
  });

  it("bounds how many headers it will walk, before walking them", () => {
    const limits = { ...BRIDGE_LIMITS, maxHeaderEntries: 4 };
    const headersOf = (count: number) => Object.fromEntries(
      Array.from({ length: count }, (_value, index) => [`x-${index}`, "1"]),
    );
    expect(parseBridgeRequest({ ...BASE, headers: headersOf(4) }, limits))
      .toMatchObject({ ok: true });
    expect(parseBridgeRequest({ ...BASE, headers: headersOf(5) }, limits))
      .toMatchObject({ ok: false, code: "malformed-request" });
    // The refusal must not depend on reaching a bad value later in the object:
    // a page can make every entry well-formed and still send a million of them.
    expect(parseBridgeRequest({ ...BASE, headers: headersOf(5_000) }, limits))
      .toMatchObject({ ok: false, code: "malformed-request" });
  });

  it("bounds the body in bytes rather than characters", () => {
    const limits = { ...BRIDGE_LIMITS, maxRequestBodyBytes: 8 };
    expect(parseBridgeRequest({ ...BASE, method: "POST", body: "12345678" }, limits))
      .toMatchObject({ ok: true });
    expect(parseBridgeRequest({ ...BASE, method: "POST", body: "123456789" }, limits))
      .toMatchObject({ ok: false, code: "request-too-large" });
    // Four two-byte characters are eight bytes; five are not.
    expect(parseBridgeRequest({ ...BASE, method: "POST", body: "ééééé" }, limits))
      .toMatchObject({ ok: false, code: "request-too-large" });
  });

  it("bounds how many fields it will walk", () => {
    const wide: Record<string, unknown> = { ...BASE };
    for (let index = 0; index < BRIDGE_LIMITS.maxEnvelopeKeys; index += 1) wide[`extra${index}`] = index;
    expect(parseBridgeRequest(wide)).toMatchObject({ ok: false, code: "malformed-request" });
  });

  it("ignores an unknown field rather than acting on it", () => {
    const parsed = parseBridgeRequest({ ...BASE, credentials: "include", redirect: "follow" });
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && Object.keys(parsed.request).sort())
      .toEqual(["headers", "id", "kind", "method", "path", "provider", "stream"]);
  });

  it("recognises only well-formed replies on the way back", () => {
    const reply = { airshipBridge: 1, from: "extension" as const, id: "a" };
    expect(isBridgeReply({ ...reply, kind: "chunk" })).toBe(true);
    expect(isBridgeReply({ ...reply, kind: "head" })).toBe(true);
    expect(isBridgeReply({ ...reply, kind: "banana" })).toBe(false);
    // A page-sent message is never relayed back to the page as a reply.
    expect(isBridgeReply({ ...reply, from: "page", kind: "hello" })).toBe(false);
    expect(isBridgeReply({ ...reply, airshipBridge: 2, kind: "end" })).toBe(false);
    expect(isBridgeReply({ airshipBridge: 1, from: "extension", kind: "end" })).toBe(false);
    expect(isBridgeReply(undefined)).toBe(false);
  });

  it("settles an exchange on hello, end and error but not on head or chunk", () => {
    const base = { airshipBridge: 1 as const, from: "extension" as const, id: "a" };
    expect(isTerminalReply({ ...base, kind: "end", seq: 0 })).toBe(true);
    expect(isTerminalReply({ ...base, kind: "error", reason: "x" })).toBe(true);
    expect(isTerminalReply({ ...base, kind: "hello", version: "1", providers: [], unavailable: [] })).toBe(true);
    expect(isTerminalReply({ ...base, kind: "head", status: 200, headers: {} })).toBe(false);
    expect(isTerminalReply({ ...base, kind: "chunk", seq: 1, data: "" })).toBe(false);
  });
});
