import { describe, expect, it } from "vitest";
import { BRIDGE_LIMITS, type BridgeLimits, type BridgeRuntimeCapabilities } from "./policy";
import type { BridgeReply } from "./protocol";
import {
  type BridgeClock,
  DROPPED_HEADER_NOTICE,
  type RelayFetch,
  type RelayRequestInit,
  type RelayResponse,
  USER_AGENT_NOTICE,
  createBridgeRelay,
} from "./relay";

const LIVE: BridgeRuntimeCapabilities = Object.freeze({ userAgentOverride: "live", hostAccess: "granted" });

function manualClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: BridgeClock = {
    now: () => now,
    setTimer(delayMs, fn) {
      const id = (sequence += 1);
      timers.set(id, { at: now + delayMs, fn });
      return () => timers.delete(id);
    },
  };
  return {
    clock,
    pending: () => timers.size,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

/** Let an in-flight request really start before asserting on it. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function response(overrides: Partial<RelayResponse> & { status?: number }): RelayResponse {
  const status = overrides.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    body: streamOf([bytes("{}")]),
    ...overrides,
  };
}

/**
 * The page decodes each chunk with `atob` and enqueues the bytes, so the text
 * only exists once the bytes are rejoined. Modelling it the same way here is
 * what makes the multi-byte test meaningful.
 */
function decodeChunks(sent: readonly BridgeReply[]): string {
  const parts = sent
    .filter((message) => message.kind === "chunk")
    .map((chunk) => Buffer.from(chunk.kind === "chunk" ? chunk.data : "", "base64"));
  return Buffer.concat(parts).toString("utf8");
}

function code(message: BridgeReply | undefined): string {
  return message?.kind === "error" ? message.reason.split(":")[0] ?? "" : `not-an-error(${message?.kind})`;
}

type Harness = Readonly<{
  relay: ReturnType<typeof createBridgeRelay>;
  sent: BridgeReply[];
  calls: { url: string; init: RelayRequestInit }[];
  advance(ms: number): void;
  pending(): number;
}>;

function harness(options: Readonly<{
  fetchImpl?: RelayFetch;
  capabilities?: BridgeRuntimeCapabilities;
  limits?: BridgeLimits;
  /** Overrides `capabilities`, for tests that need the probe to take time. */
  resolveCapabilities?: () => Promise<BridgeRuntimeCapabilities>;
}> = {}): Harness {
  const sent: BridgeReply[] = [];
  const calls: { url: string; init: RelayRequestInit }[] = [];
  const timing = manualClock();
  const fetchImpl: RelayFetch = async (url, init) => {
    calls.push({ url, init });
    return options.fetchImpl ? await options.fetchImpl(url, init) : response({});
  };
  const relay = createBridgeRelay({
    fetchImpl,
    clock: timing.clock,
    send: (message) => sent.push(message),
    resolveCapabilities: options.resolveCapabilities ?? (async () => options.capabilities ?? LIVE),
    limits: options.limits,
    version: "1.0.0",
  });
  return Object.freeze({ relay, sent, calls, advance: timing.advance, pending: timing.pending });
}

function fetchRequest(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    airshipBridge: 1,
    from: "page",
    id: "req-1",
    kind: "fetch",
    provider: "xai",
    path: "https://api.x.ai/v1/chat/completions",
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: "{\"model\":\"grok\"}",
    ...overrides,
  };
}

describe("bridge relay: hello", () => {
  it("reports the version and only the providers the runtime observed it can carry", async () => {
    const live = harness();
    await live.relay.handle({ airshipBridge: 1, from: "page", id: "h1", kind: "hello" });
    expect(live.sent).toEqual([{
      airshipBridge: 1,
      from: "extension",
      id: "h1",
      kind: "hello",
      version: "1.0.0",
      providers: ["xai", "anthropic"],
      unavailable: [],
    }]);

    const degraded = harness({
      capabilities: { userAgentOverride: "unavailable", hostAccess: "granted" },
    });
    await degraded.relay.handle({ airshipBridge: 1, from: "page", id: "h2", kind: "hello" });
    const hello = degraded.sent[0];
    expect(hello).toMatchObject({ kind: "hello", providers: ["xai"] });
    expect(hello.kind === "hello" && hello.unavailable[0]?.provider).toBe("anthropic");
  });

  it("names a missing host grant instead of claiming a provider", async () => {
    const blocked = harness({ capabilities: { userAgentOverride: "live", hostAccess: "missing" } });
    await blocked.relay.handle({ airshipBridge: 1, from: "page", id: "h3", kind: "hello" });
    const hello = blocked.sent[0];
    expect(hello).toMatchObject({ kind: "hello", providers: [] });
    expect(hello.kind === "hello" && hello.unavailable.map((entry) => entry.provider))
      .toEqual(["xai", "anthropic"]);
  });
});

describe("bridge relay: the relayed request", () => {
  it("sends exactly the bounded, credential-free request the contract specifies", async () => {
    const test = harness({
      fetchImpl: async () => response({
        headers: new Headers({ "content-type": "application/json", "set-cookie": "session=1" }),
        body: streamOf([bytes("{\"ok\":true}")]),
      }),
    });
    await test.relay.handle(fetchRequest({
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
        cookie: "session=stolen",
        "x-forwarded-for": "10.0.0.1",
      },
    }));

    expect(test.calls).toHaveLength(1);
    const [call] = test.calls;
    expect(call.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(call.init.credentials).toBe("omit");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.cache).toBe("no-store");
    expect(call.init.referrerPolicy).toBe("no-referrer");
    expect(call.init.keepalive).toBe(false);
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe("{\"model\":\"grok\"}");
    // Only protocol headers survive; the page's cookie never leaves the page.
    expect(call.init.headers).toEqual({
      authorization: "Bearer secret-token",
      "content-type": "application/json",
    });

    expect(test.sent.map((message) => message.kind)).toEqual(["head", "chunk", "end"]);
    expect(test.sent[0]).toEqual({
      airshipBridge: 1,
      from: "extension",
      id: "req-1",
      kind: "head",
      status: 200,
      // No set-cookie, and the dropped headers are named rather than silent.
      headers: { "content-type": "application/json", [DROPPED_HEADER_NOTICE]: "cookie, x-forwarded-for" },
    });
    expect(test.sent[1]).toMatchObject({ kind: "chunk", seq: 1 });
    expect(decodeChunks(test.sent)).toBe("{\"ok\":true}");
    expect(test.sent[2]).toMatchObject({ kind: "end", seq: 1 });
  });

  it("carries a non-2xx status through as an ordinary response", async () => {
    const test = harness({
      fetchImpl: async () => response({ status: 400, body: streamOf([bytes("{\"error\":\"bad code\"}")]) }),
    });
    await test.relay.handle(fetchRequest({ stream: true }));
    expect(test.sent[0]).toMatchObject({ kind: "head", status: 400 });
    expect(decodeChunks(test.sent)).toBe("{\"error\":\"bad code\"}");
    expect(test.sent.at(-1)).toMatchObject({ kind: "end", seq: 1 });
  });

  it("sends no chunk for a status that cannot carry a body", async () => {
    for (const status of [204, 205, 304]) {
      const test = harness({ fetchImpl: async () => response({ status, body: streamOf([bytes("x")]) }) });
      await test.relay.handle(fetchRequest({ id: `s-${status}` }));
      expect(test.sent.map((message) => message.kind)).toEqual(["head", "end"]);
      expect(test.sent.at(-1)).toMatchObject({ kind: "end", seq: 0 });
    }
  });

  it("carries the destination's compiled-in user agent and says which one it used", async () => {
    const test = harness();
    await test.relay.handle(fetchRequest({
      provider: "anthropic",
      path: "https://api.anthropic.com/v1/messages",
      headers: { authorization: "Bearer t", "user-agent": "claude-code/1.0.0", "x-app": "cli" },
    }));
    // `fetch` silently ignores user-agent, so it is not in the forwarded set.
    expect(test.calls[0]?.init.headers).toEqual({ authorization: "Bearer t", "x-app": "cli" });
    expect(test.sent[0]).toMatchObject({
      kind: "head",
      headers: { [USER_AGENT_NOTICE]: "claude-code/1.0.0" },
    });
  });
});

describe("bridge relay: refusals", () => {
  it("refuses a host that is not on the allowlist, without a network call", async () => {
    const test = harness();
    await test.relay.handle(fetchRequest({ path: "https://evil.example/v1/chat/completions" }));
    expect(test.calls).toHaveLength(0);
    expect(code(test.sent[0])).toBe("destination-refused");
  });

  it("refuses a non-allowlisted path prefix under an allowlisted host", async () => {
    const test = harness();
    for (const path of [
      "https://api.x.ai/v2/chat/completions",
      "https://api.x.ai/admin",
      "https://api.x.ai/v1x/chat",
    ]) {
      await test.relay.handle(fetchRequest({ id: `p-${path.length}`, path }));
    }
    await test.relay.handle(fetchRequest({
      id: "anthropic-internal",
      provider: "anthropic",
      path: "https://api.anthropic.com/internal/v1/messages",
    }));
    expect(test.calls).toHaveLength(0);
    expect(test.sent.every((message) => code(message) === "destination-refused")).toBe(true);
  });

  it("refuses a destination that belongs to a different provider", async () => {
    const test = harness();
    await test.relay.handle(fetchRequest({ provider: "xai", path: "https://api.anthropic.com/v1/messages" }));
    expect(test.calls).toHaveLength(0);
    expect(code(test.sent[0])).toBe("destination-refused");
  });

  it("refuses encoded path separators that a server might decode back out of the prefix", async () => {
    const test = harness();
    await test.relay.handle(fetchRequest({ path: "https://api.x.ai/v1/..%2F..%2Fadmin" }));
    expect(test.calls).toHaveLength(0);
    expect(code(test.sent[0])).toBe("destination-refused");
  });

  it("refuses a header value that could inject a second header", async () => {
    const test = harness();
    await test.relay.handle(fetchRequest({
      headers: { authorization: "Bearer x\r\nx-injected: 1" },
    }));
    expect(test.calls).toHaveLength(0);
    expect(code(test.sent[0])).toBe("header-refused");
  });

  it("refuses to substitute a user agent the caller did not ask for", async () => {
    const test = harness();
    await test.relay.handle(fetchRequest({
      provider: "anthropic",
      path: "https://platform.claude.com/v1/oauth/token",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" },
    }));
    expect(test.calls).toHaveLength(0);
    expect(code(test.sent[0])).toBe("user-agent-refused");

    // The value this build actually sends is accepted.
    await test.relay.handle(fetchRequest({
      id: "req-2",
      provider: "anthropic",
      path: "https://platform.claude.com/v1/oauth/token",
      headers: { "user-agent": "axios/1.7.9" },
    }));
    expect(test.calls).toHaveLength(1);
  });

  it("refuses an over-budget request body before opening a connection", async () => {
    const limits: BridgeLimits = { ...BRIDGE_LIMITS, maxRequestBodyBytes: 16 };
    const test = harness({ limits });
    await test.relay.handle(fetchRequest({ body: "x".repeat(17) }));
    expect(test.calls).toHaveLength(0);
    expect(code(test.sent[0])).toBe("request-too-large");
  });

  it("refuses every shape of redirect, including one that would stay on the allowlist", async () => {
    const shapes: readonly Partial<RelayResponse>[] = [
      { type: "opaqueredirect", status: 0, ok: false, body: null },
      { status: 302, ok: false, headers: new Headers({ location: "https://evil.example/steal" }), body: null },
      { status: 302, ok: false, headers: new Headers({ location: "https://api.x.ai/v1/other" }), body: null },
      { status: 200, ok: true, redirected: true },
    ];
    for (const [index, shape] of shapes.entries()) {
      const test = harness({ fetchImpl: async () => response(shape) });
      await test.relay.handle(fetchRequest({ id: `redirect-${index}` }));
      expect(test.sent).toHaveLength(1);
      expect(code(test.sent[0])).toBe("redirect-refused");
    }
  });

  it("refuses a status the page could not build a response from", async () => {
    const test = harness({ fetchImpl: async () => response({ status: 0, ok: false, body: null }) });
    await test.relay.handle(fetchRequest());
    expect(code(test.sent[0])).toBe("status-refused");
  });

  it("refuses a response that exceeds the byte ceiling, buffered or streamed", async () => {
    const limits: BridgeLimits = { ...BRIDGE_LIMITS, maxResponseBytes: 8, maxStreamResponseBytes: 8 };
    const buffered = harness({
      limits,
      fetchImpl: async () => response({ body: streamOf([bytes("0123456789")]) }),
    });
    await buffered.relay.handle(fetchRequest());
    expect(code(buffered.sent.at(-1))).toBe("response-too-large");

    const streamed = harness({
      limits,
      fetchImpl: async () => response({ body: streamOf([bytes("01234"), bytes("56789")]) }),
    });
    await streamed.relay.handle(fetchRequest({ stream: true }));
    expect(code(streamed.sent.at(-1))).toBe("response-too-large");
    expect(streamed.sent.filter((message) => message.kind === "end")).toHaveLength(0);
  });

  it("refuses a response that would emit more chunks than the ceiling allows", async () => {
    const limits: BridgeLimits = { ...BRIDGE_LIMITS, maxChunkBytes: 2, maxChunks: 3 };
    const test = harness({
      limits,
      fetchImpl: async () => response({ body: streamOf([bytes("abcdefghij")]) }),
    });
    await test.relay.handle(fetchRequest({ stream: true }));
    expect(test.sent.filter((message) => message.kind === "chunk")).toHaveLength(3);
    expect(code(test.sent.at(-1))).toBe("too-many-chunks");
  });

  // These two are sequential on purpose — they pin the refusal *message* once a
  // request is established. They cannot see a check racing its own reservation;
  // "admission when requests arrive together" below is what covers that.
  it("refuses a request past the concurrency cap without disturbing the requests in flight", async () => {
    const limits: BridgeLimits = { ...BRIDGE_LIMITS, maxConcurrentRequests: 2 };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const test = harness({
      limits,
      fetchImpl: async () => {
        await gate;
        return response({});
      },
    });
    const first = test.relay.handle(fetchRequest({ id: "a" }));
    const second = test.relay.handle(fetchRequest({ id: "b" }));
    await flush();
    expect(test.relay.inflight()).toBe(2);
    await test.relay.handle(fetchRequest({ id: "c" }));
    expect(test.sent).toHaveLength(1);
    expect(code(test.sent[0])).toBe("too-many-requests");
    release?.();
    await Promise.all([first, second]);
    expect(test.sent.filter((message) => message.kind === "end")).toHaveLength(2);
  });

  it("refuses a repeated request id rather than crossing two replies", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const test = harness({
      fetchImpl: async () => {
        await gate;
        return response({});
      },
    });
    const first = test.relay.handle(fetchRequest({ id: "same" }));
    await flush();
    await test.relay.handle(fetchRequest({ id: "same" }));
    expect(code(test.sent[0])).toBe("duplicate-request-id");
    release?.();
    await first;
    expect(test.sent.at(-1)).toMatchObject({ kind: "end" });
  });

  it("refuses an Anthropic host when no User-Agent override was observed", async () => {
    const test = harness({ capabilities: { userAgentOverride: "unavailable", hostAccess: "granted" } });
    await test.relay.handle(fetchRequest({
      id: "token",
      provider: "anthropic",
      path: "https://platform.claude.com/v1/oauth/token",
      headers: {},
    }));
    expect(test.calls).toHaveLength(0);
    expect(code(test.sent[0])).toBe("user-agent-override-unavailable");

    // xAI needs no override and is unaffected.
    await test.relay.handle(fetchRequest({ id: "xai" }));
    expect(test.calls).toHaveLength(1);
  });

  it("refuses everything when the browser has not granted host access", async () => {
    const test = harness({ capabilities: { userAgentOverride: "live", hostAccess: "missing" } });
    await test.relay.handle(fetchRequest());
    expect(test.calls).toHaveLength(0);
    expect(code(test.sent[0])).toBe("host-access-missing");
  });

  it("reports a transport failure as an explicit error", async () => {
    const test = harness({
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await test.relay.handle(fetchRequest());
    expect(test.sent[0]).toMatchObject({ kind: "error", reason: "network-error: Failed to fetch" });
  });

  it("refuses a message that claims to be a reply", async () => {
    const test = harness();
    await test.relay.handle(fetchRequest({ from: "extension" }));
    expect(test.calls).toHaveLength(0);
    expect(code(test.sent[0])).toBe("malformed-request");
  });
});

/**
 * A capability probe that settles on a later macrotask, which is what the real
 * one costs: `permissions.contains()` plus a rule read-back, paid on every
 * worker wake and at each 30 s capability-TTL boundary. Any admission check
 * placed after that await is a check the page can dispatch straight past.
 */
function deferredCapabilities(): () => Promise<BridgeRuntimeCapabilities> {
  return async () => {
    await flush();
    return LIVE;
  };
}

describe("bridge relay: admission when requests arrive together", () => {
  it("holds the concurrency cap against a burst dispatched in one turn", async () => {
    const limits: BridgeLimits = { ...BRIDGE_LIMITS, maxConcurrentRequests: 4 };
    let open = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const test = harness({
      limits,
      resolveCapabilities: deferredCapabilities(),
      fetchImpl: async () => {
        open += 1;
        peak = Math.max(peak, open);
        await gate;
        open -= 1;
        return response({});
      },
    });

    // Dispatched without awaiting between them: exactly how `port.onMessage`
    // delivers messages a page already queued, and the shape no sequential
    // test can produce.
    const dispatched = Array.from({ length: 12 }, (_value, index) =>
      test.relay.handle(fetchRequest({ id: `burst-${index}` })));
    await flush();

    expect(peak).toBe(4);
    expect(test.calls).toHaveLength(4);
    expect(test.sent.filter((message) => code(message) === "too-many-requests")).toHaveLength(8);
    release?.();
    await Promise.all(dispatched);
    expect(test.sent.filter((message) => message.kind === "end")).toHaveLength(4);
    expect(test.relay.inflight()).toBe(0);
  });

  it("refuses a repeated id when both arrive before the first has started", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const test = harness({
      resolveCapabilities: deferredCapabilities(),
      fetchImpl: async () => {
        await gate;
        return response({});
      },
    });
    const both = Promise.all([
      test.relay.handle(fetchRequest({ id: "same" })),
      test.relay.handle(fetchRequest({ id: "same" })),
    ]);
    await flush();
    expect(test.calls).toHaveLength(1);
    expect(code(test.sent[0])).toBe("duplicate-request-id");
    release?.();
    await both;
    // One exchange, one head, one terminator: the newcomer never crossed it.
    expect(test.sent.filter((message) => message.kind === "head")).toHaveLength(1);
    expect(test.sent.filter((message) => message.kind === "end")).toHaveLength(1);
  });

  it("releases the slot a refused request briefly held", async () => {
    const limits: BridgeLimits = { ...BRIDGE_LIMITS, maxConcurrentRequests: 1 };
    const test = harness({ limits, resolveCapabilities: deferredCapabilities() });
    const refused = Array.from({ length: 3 }, (_value, index) =>
      test.relay.handle(fetchRequest({ id: `bad-${index}`, path: "https://evil.example/v1/x" })));
    await Promise.all(refused);
    // A refusal decided before the first await must give its reservation back
    // in the same turn, or three bad URLs would wedge a cap of one.
    expect(test.sent.filter((message) => code(message) === "destination-refused")).toHaveLength(3);
    expect(test.relay.inflight()).toBe(0);
    await test.relay.handle(fetchRequest({ id: "good" }));
    expect(test.calls).toHaveLength(1);
  });

  it("never lets requests in flight make a present bridge report itself absent", async () => {
    const limits: BridgeLimits = { ...BRIDGE_LIMITS, maxConcurrentRequests: 2 };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const test = harness({
      limits,
      resolveCapabilities: deferredCapabilities(),
      fetchImpl: async () => {
        await gate;
        return response({});
      },
    });
    const dispatched = [
      test.relay.handle(fetchRequest({ id: "a" })),
      test.relay.handle(fetchRequest({ id: "b" })),
      test.relay.handle({ airshipBridge: 1, from: "page", id: "h", kind: "hello" }),
    ];
    await flush();
    // A refused handshake is indistinguishable from an absent extension, so it
    // draws on its own budget rather than the saturated request cap.
    expect(test.sent.map((message) => message.kind)).toEqual(["hello"]);
    release?.();
    await Promise.all(dispatched);
  });

  it("caps handshakes too, so a page cannot open an unbounded number of them", async () => {
    const limits: BridgeLimits = { ...BRIDGE_LIMITS, maxConcurrentRequests: 2 };
    const test = harness({ limits, resolveCapabilities: deferredCapabilities() });
    const dispatched = Array.from({ length: 5 }, (_value, index) =>
      test.relay.handle({ airshipBridge: 1, from: "page", id: `h-${index}`, kind: "hello" }));
    await Promise.all(dispatched);
    expect(test.sent.filter((message) => message.kind === "hello")).toHaveLength(2);
    expect(test.sent.filter((message) => code(message) === "too-many-requests")).toHaveLength(3);
  });

  it("answers, and releases, when a relay path throws where nothing should", async () => {
    // The worker dispatches with `void relay.handle(...)`, so an escaped
    // exception would leave the slot taken and the page waiting for ever.
    const test = harness({
      resolveCapabilities: async () => {
        throw new TypeError("the capability probe exploded");
      },
    });
    await test.relay.handle(fetchRequest());
    expect(code(test.sent[0])).toBe("internal-error");
    expect(test.sent).toHaveLength(1);
    expect(test.relay.inflight()).toBe(0);
  });

  it("bounds the capability observation itself, so a stalled probe cannot hold a slot", async () => {
    const test = harness({
      resolveCapabilities: () => new Promise<BridgeRuntimeCapabilities>(() => undefined),
    });
    void test.relay.handle(fetchRequest());
    await flush();
    expect(test.relay.inflight()).toBe(1);
    expect(test.calls).toHaveLength(0);
    test.advance(BRIDGE_LIMITS.bufferedDeadlineMs);
    expect(code(test.sent[0])).toBe("deadline-exceeded");
    expect(test.relay.inflight()).toBe(0);
  });
});

describe("bridge relay: deadlines", () => {
  it("aborts and reports exactly one terminal message when the wall clock runs out", async () => {
    const test = harness({
      fetchImpl: (_url, init) => new Promise<RelayResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted.", "AbortError")));
      }),
    });
    const pending = test.relay.handle(fetchRequest());
    await flush();
    expect(test.sent).toHaveLength(0);
    test.advance(BRIDGE_LIMITS.bufferedDeadlineMs);
    await pending;
    expect(test.sent).toHaveLength(1);
    expect(code(test.sent[0])).toBe("deadline-exceeded");
    expect(test.relay.inflight()).toBe(0);
  });

  it("bounds an idle response separately from the total deadline", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(source) {
        controller = source;
        source.enqueue(bytes("first"));
      },
    });
    const test = harness({ fetchImpl: async () => response({ body }) });
    const pending = test.relay.handle(fetchRequest({ stream: true }));
    await flush();
    expect(test.sent.map((message) => message.kind)).toEqual(["head", "chunk"]);
    test.advance(BRIDGE_LIMITS.streamIdleDeadlineMs);
    controller?.close();
    await pending;
    expect(code(test.sent.at(-1))).toBe("deadline-exceeded");
    expect(test.sent.filter((message) => message.kind === "end")).toHaveLength(0);
  });

  it("cancels its timers once a request has finished", async () => {
    const test = harness();
    await test.relay.handle(fetchRequest());
    expect(test.pending()).toBe(0);
    expect(test.relay.inflight()).toBe(0);
  });
});

describe("bridge relay: streaming", () => {
  it("delivers ordered chunks under one id and terminates with exactly one end", async () => {
    const limits: BridgeLimits = { ...BRIDGE_LIMITS, maxChunkBytes: 4 };
    const test = harness({
      limits,
      fetchImpl: async () => response({ body: streamOf([bytes("data: one\n"), bytes("data: two\n")]) }),
    });
    await test.relay.handle(fetchRequest({ id: "stream-1", stream: true }));

    const chunks = test.sent.filter((message) => message.kind === "chunk");
    expect(chunks.map((chunk) => (chunk.kind === "chunk" ? chunk.seq : 0))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(chunks.every((chunk) => chunk.id === "stream-1")).toBe(true);
    expect(decodeChunks(test.sent)).toBe("data: one\ndata: two\n");
    const terminals = test.sent.filter((message) => message.kind === "end" || message.kind === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ kind: "end", seq: 6 });
  });

  it("keeps multi-byte characters intact across chunk boundaries", async () => {
    const limits: BridgeLimits = { ...BRIDGE_LIMITS, maxChunkBytes: 1 };
    const test = harness({ limits, fetchImpl: async () => response({ body: streamOf([bytes("héllo")]) }) });
    await test.relay.handle(fetchRequest({ stream: true }));
    // Six bytes, one per chunk, and the é still survives reassembly.
    expect(test.sent.filter((message) => message.kind === "chunk")).toHaveLength(6);
    expect(decodeChunks(test.sent)).toBe("héllo");
  });
});

describe("bridge relay: cancellation and disposal", () => {
  it("aborts a request the page cancelled, and answers nothing further", async () => {
    let aborted = false;
    const test = harness({
      fetchImpl: (_url, init) => new Promise<RelayResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted.", "AbortError"));
        });
      }),
    });
    const pending = test.relay.handle(fetchRequest({ id: "cancel-me" }));
    await flush();
    await test.relay.handle({ airshipBridge: 1, from: "page", id: "cancel-me", kind: "cancel" });
    await pending;
    expect(aborted).toBe(true);
    expect(test.sent).toEqual([]);
    expect(test.relay.inflight()).toBe(0);
  });

  it("ignores a cancel for an exchange it does not have", async () => {
    const test = harness();
    await test.relay.handle({ airshipBridge: 1, from: "page", id: "unknown", kind: "cancel" });
    expect(test.sent).toEqual([]);
  });

  it("stops answering and aborts in-flight work when the page disconnects", async () => {
    let aborted = false;
    const test = harness({
      fetchImpl: (_url, init) => new Promise<RelayResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted.", "AbortError"));
        });
      }),
    });
    const pending = test.relay.handle(fetchRequest());
    await flush();
    test.relay.dispose();
    await pending;
    expect(aborted).toBe(true);
    expect(test.sent).toHaveLength(0);
    await test.relay.handle({ airshipBridge: 1, from: "page", id: "after", kind: "hello" });
    expect(test.sent).toHaveLength(0);
  });
});
