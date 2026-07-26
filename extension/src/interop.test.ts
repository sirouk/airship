/**
 * The extension and the page are separate packages that must agree on a wire
 * format the prose contract only half specifies. This suite runs the real
 * relay against the page's own parser (`src/inference/bridge/protocol.ts`), so
 * a divergence fails here rather than silently in a browser.
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_OAUTH_INFERENCE_HEADERS,
  BRIDGE_HEADER_ALLOWLIST,
  BRIDGE_DESTINATIONS as PAGE_DESTINATIONS,
  parseBridgeReply,
} from "../../src/inference/bridge/protocol";
import {
  BRIDGE_DESTINATIONS,
  FORWARDED_REQUEST_HEADERS,
  type BridgeRuntimeCapabilities,
} from "./policy";
import type { BridgeReply } from "./protocol";
import { type BridgeClock, type RelayResponse, createBridgeRelay } from "./relay";

const LIVE: BridgeRuntimeCapabilities = Object.freeze({ userAgentOverride: "live", hostAccess: "granted" });

const clock: BridgeClock = Object.freeze({
  now: () => 0,
  setTimer: () => () => undefined,
});

function relayWith(fetchImpl: () => Promise<RelayResponse>) {
  const sent: BridgeReply[] = [];
  const relay = createBridgeRelay({
    fetchImpl: async () => fetchImpl(),
    clock,
    send: (message) => sent.push(message),
    resolveCapabilities: async () => LIVE,
    version: "1.0.0",
  });
  return { relay, sent };
}

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** The exact envelope `ExtensionBridgeClient` posts. */
function pageRequest(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    airshipBridge: 1,
    from: "page",
    id: "018f2f3a-1f1a-7c3a-9a1a-1f1a7c3a9a1a",
    kind: "fetch",
    provider: "anthropic",
    path: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: "{}",
    stream: true,
    ...overrides,
  };
}

describe("wire compatibility with the page bridge client", () => {
  it("agrees on the destination allowlist, provider by provider", () => {
    for (const [provider, prefixes] of Object.entries(PAGE_DESTINATIONS)) {
      expect(
        BRIDGE_DESTINATIONS
          .filter((destination) => destination.provider === provider)
          .map((destination) => destination.prefix)
          .sort(),
      ).toEqual([...prefixes].sort());
    }
  });

  it("agrees on the request header allowlist", () => {
    expect([...FORWARDED_REQUEST_HEADERS].sort()).toEqual([...BRIDGE_HEADER_ALLOWLIST].sort());
  });

  it("sends the user agent the page's Anthropic inference fingerprint asks for", () => {
    const inference = BRIDGE_DESTINATIONS.find(
      (destination) => destination.prefix === "https://api.anthropic.com/v1/",
    );
    expect(inference?.userAgent).toBe(ANTHROPIC_OAUTH_INFERENCE_HEADERS["user-agent"]);
  });

  it("emits a head, ordered chunks and an end the page parser accepts", async () => {
    const { relay, sent } = relayWith(async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: streamOf(["data: one\n\n", "data: two\n\n"]),
    }));
    await relay.handle(pageRequest({ headers: { ...ANTHROPIC_OAUTH_INFERENCE_HEADERS } }));

    const parsed = sent.map((message) => parseBridgeReply(message));
    expect(parsed.every(Boolean)).toBe(true);
    expect(parsed.map((reply) => reply?.kind)).toEqual(["head", "chunk", "chunk", "end"]);
    // The page requires seq === chunks + 1, starting at 1, and end.seq === count.
    expect(parsed.filter((reply) => reply?.kind === "chunk").map((reply) => reply?.kind === "chunk" && reply.seq))
      .toEqual([1, 2]);
    const end = parsed.at(-1);
    expect(end?.kind === "end" && end.seq).toBe(2);
  });

  it("emits a hello the page parser turns into a handshake answer", async () => {
    const { relay, sent } = relayWith(async () => {
      throw new Error("hello performs no fetch");
    });
    await relay.handle({ airshipBridge: 1, from: "page", id: "hello-1", kind: "hello" });
    const reply = parseBridgeReply(sent[0]);
    expect(reply).toMatchObject({ kind: "hello", version: "1.0.0", providers: ["xai", "anthropic"] });
  });

  it("emits an error whose reason survives the page parser", async () => {
    const { relay, sent } = relayWith(async () => {
      throw new Error("unreachable");
    });
    await relay.handle(pageRequest({ path: "https://evil.example/v1/messages" }));
    const reply = parseBridgeReply(sent[0]);
    expect(reply?.kind).toBe("error");
    expect(reply?.kind === "error" && reply.reason).toContain("destination-refused");
  });

  it("accepts the exact envelope the page client posts, including its cancel", async () => {
    const { relay, sent } = relayWith(async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      body: streamOf(["{}"]),
    }));
    await relay.handle(pageRequest());
    expect(sent.map((message) => message.kind)).toEqual(["head", "chunk", "end"]);
    // A cancel for a settled exchange is ignored rather than answered.
    await relay.handle({ airshipBridge: 1, from: "page", id: pageRequest().id, kind: "cancel" });
    expect(sent).toHaveLength(3);
  });
});
