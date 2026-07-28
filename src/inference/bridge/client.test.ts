import { describe, expect, it } from "vitest";
import {
  ExtensionBridgeClient,
  type BridgeMessageChannel,
  type BridgeMessageEventLike,
} from "./client";
import { ExtensionBridgeError, type BridgeRequestMessage } from "./protocol";

const ORIGIN = "https://airship.test";

type Harness = Readonly<{
  channel: BridgeMessageChannel;
  posted: BridgeRequestMessage[];
  listenerCount: () => number;
  deliver: (data: unknown, from?: Readonly<{ origin?: string; source?: unknown }>) => void;
}>;

function harness(): Harness {
  const listeners = new Set<(event: BridgeMessageEventLike) => void>();
  const posted: BridgeRequestMessage[] = [];
  const pageWindow = { name: "page-window" };
  return {
    channel: Object.freeze({
      postMessage: (message: BridgeRequestMessage) => {
        posted.push(message);
      },
      addEventListener: (listener: (event: BridgeMessageEventLike) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (listener: (event: BridgeMessageEventLike) => void) => {
        listeners.delete(listener);
      },
      expectedOrigin: ORIGIN,
      expectedSource: pageWindow,
    }),
    posted,
    listenerCount: () => listeners.size,
    deliver: (data, from) => {
      for (const listener of [...listeners]) {
        listener({
          data,
          origin: from?.origin ?? ORIGIN,
          source: "source" in (from ?? {}) ? from?.source : pageWindow,
        });
      }
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function hello(id: string, providers: readonly string[] = ["anthropic", "xai"]): unknown {
  return { airshipBridge: 1, from: "extension", id, kind: "hello", version: "0.4.1", providers };
}

function head(id: string, status = 200, headers: Record<string, string> = {}): unknown {
  return { airshipBridge: 1, from: "extension", id, kind: "head", status, headers };
}

function chunk(id: string, seq: number, text: string): unknown {
  return { airshipBridge: 1, from: "extension", id, kind: "chunk", seq, data: btoa(text) };
}

function end(id: string, seq: number): unknown {
  return { airshipBridge: 1, from: "extension", id, kind: "end", seq };
}

function client(bridge: Harness, helloTimeoutMs = 20): ExtensionBridgeClient {
  return new ExtensionBridgeClient(bridge.channel, { limits: { helloTimeoutMs } });
}

function fetchRequest(signal: AbortSignal, overrides: Record<string, unknown> = {}) {
  return {
    provider: "anthropic" as const,
    url: "https://api.anthropic.com/v1/messages",
    method: "POST" as const,
    headers: { "content-type": "application/json" },
    body: "{}",
    stream: true,
    signal,
    ...overrides,
  };
}

/** Drive a fetch to the point where the extension has answered `head`. */
async function openExchange(
  bridge: Harness,
  active: ExtensionBridgeClient,
  signal: AbortSignal,
): Promise<Readonly<{ id: string; response: Promise<Response> }>> {
  const response = active.fetch(fetchRequest(signal));
  await tick();
  bridge.deliver(hello(bridge.posted[0]!.id));
  await tick();
  const fetchMessage = bridge.posted[1]!;
  bridge.deliver(head(fetchMessage.id, 200, { "content-type": "text/event-stream" }));
  return { id: fetchMessage.id, response };
}

describe("extension bridge handshake", () => {
  it("reports silence as no extension, never as presence", async () => {
    const bridge = harness();
    const result = await client(bridge).handshake();
    expect(result).toEqual({ kind: "silent", deadlineMs: 20 });
    expect(bridge.posted[0]).toMatchObject({ airshipBridge: 1, from: "page", kind: "hello" });
  });

  it("reports the version and providers the extension itself returned", async () => {
    const bridge = harness();
    const active = client(bridge);
    const pending = active.handshake();
    await tick();
    bridge.deliver(hello(bridge.posted[0]!.id, ["anthropic"]));
    const result = await pending;
    expect(result).toMatchObject({ kind: "answered", version: "0.4.1", providers: ["anthropic"] });
  });

  it("ignores a reply that carries a different protocol version", async () => {
    const bridge = harness();
    const active = client(bridge);
    const pending = active.handshake();
    await tick();
    bridge.deliver({ ...(hello(bridge.posted[0]!.id) as object), airshipBridge: 2 });
    await expect(pending).resolves.toMatchObject({ kind: "silent" });
  });

  it("ignores a reply from another origin or another window", async () => {
    const bridge = harness();
    const active = client(bridge);
    const pending = active.handshake();
    await tick();
    const id = bridge.posted[0]!.id;
    bridge.deliver(hello(id), { origin: "https://evil.test" });
    bridge.deliver(hello(id), { source: { name: "other-frame" } });
    await expect(pending).resolves.toMatchObject({ kind: "silent" });
  });

  it("does not treat the page's own outbound message as an extension reply", async () => {
    const bridge = harness();
    const active = client(bridge);
    const pending = active.handshake();
    await tick();
    // The real relay is window.postMessage, which echoes to this same page.
    bridge.deliver(bridge.posted[0]);
    await expect(pending).resolves.toMatchObject({ kind: "silent" });
  });

  it("reports a hello reply the protocol rejects as failed, not as absent", async () => {
    const bridge = harness();
    const active = client(bridge);
    const pending = active.handshake();
    await tick();
    bridge.deliver({
      airshipBridge: 1,
      from: "extension",
      id: bridge.posted[0]!.id,
      kind: "hello",
      version: "0.4.1",
      providers: ["anthropic", "gemini"],
    });
    await expect(pending).resolves.toMatchObject({ kind: "malformed" });
  });

  it("releases its message listener once nothing is pending", async () => {
    const bridge = harness();
    await client(bridge).handshake();
    expect(bridge.listenerCount()).toBe(0);
  });
});

describe("extension bridge transport", () => {
  it("streams ordered chunks into a readable response", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = client(bridge);
    const { id, response } = await openExchange(bridge, active, controller.signal);
    const opened = await response;
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-type")).toBe("text/event-stream");
    bridge.deliver(chunk(id, 1, "data: one\n\n"));
    bridge.deliver(chunk(id, 2, "data: two\n\n"));
    bridge.deliver(end(id, 2));
    await expect(opened.text()).resolves.toBe("data: one\n\ndata: two\n\n");
    expect(active.pendingCount).toBe(0);
  });

  it("fails closed on an out-of-order chunk", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = client(bridge);
    const { id, response } = await openExchange(bridge, active, controller.signal);
    const opened = await response;
    bridge.deliver(chunk(id, 2, "skipped one"));
    await expect(opened.text()).rejects.toThrow(/out-of-order/u);
  });

  it("fails closed when the terminator disagrees with the chunk count", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = client(bridge);
    const { id, response } = await openExchange(bridge, active, controller.signal);
    const opened = await response;
    bridge.deliver(chunk(id, 1, "one"));
    bridge.deliver(end(id, 2));
    await expect(opened.text()).rejects.toThrow(/mismatched chunk count/u);
  });

  it("fails closed on a malformed message addressed to a live exchange", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = client(bridge);
    const { id, response } = await openExchange(bridge, active, controller.signal);
    const opened = await response;
    bridge.deliver({ airshipBridge: 1, from: "extension", id, kind: "chunk", seq: 1, data: "!!!!" });
    await expect(opened.text()).rejects.toThrow(/malformed/u);
  });

  it("drops an unsolicited message instead of letting it settle a live exchange", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = client(bridge);
    const { id, response } = await openExchange(bridge, active, controller.signal);
    const opened = await response;
    // A hostile same-origin script that does not know the unguessable id.
    bridge.deliver(chunk("00000000-0000-4000-8000-000000000000", 1, "injected"));
    bridge.deliver({
      airshipBridge: 1,
      from: "extension",
      id: "00000000-0000-4000-8000-000000000000",
      kind: "error",
      reason: "injected failure",
    });
    bridge.deliver(chunk(id, 1, "real"));
    bridge.deliver(end(id, 1));
    await expect(opened.text()).resolves.toBe("real");
  });

  it("ignores a second terminator for an id that already settled", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = client(bridge);
    const { id, response } = await openExchange(bridge, active, controller.signal);
    const opened = await response;
    bridge.deliver(end(id, 0));
    bridge.deliver(end(id, 0));
    await expect(opened.text()).resolves.toBe("");
  });

  it("refuses a destination outside the compiled allowlist without posting it", async () => {
    const bridge = harness();
    const controller = new AbortController();
    await expect(client(bridge).fetch(fetchRequest(controller.signal, {
      url: "https://console.anthropic.com/v1/oauth/token",
    }))).rejects.toMatchObject({ code: "bridge-refused" });
    expect(bridge.posted).toHaveLength(0);
  });

  it("refuses a header the bridge does not carry", async () => {
    const bridge = harness();
    const controller = new AbortController();
    await expect(client(bridge).fetch(fetchRequest(controller.signal, {
      headers: { "x-api-key": "sk-should-never-be-bridged" },
    }))).rejects.toMatchObject({ code: "bridge-protocol" });
    expect(bridge.posted).toHaveLength(0);
  });

  it("reports an absent extension as unavailable with the cause named", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const failure = await client(bridge).fetch(fetchRequest(controller.signal)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ExtensionBridgeError);
    expect(failure).toMatchObject({ code: "bridge-unavailable" });
    expect((failure as Error).message).toMatch(/No Airship browser extension answered/u);
  });

  it("refuses a provider the installed extension did not say it carries", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const pending = client(bridge).fetch(fetchRequest(controller.signal));
    await tick();
    bridge.deliver(hello(bridge.posted[0]!.id, ["xai"]));
    await expect(pending).rejects.toMatchObject({ code: "bridge-unavailable" });
    expect(bridge.posted).toHaveLength(1);
  });

  it("repeats the extension's own reason for refusing a provider", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const pending = client(bridge).fetch(fetchRequest(controller.signal));
    await tick();
    bridge.deliver({
      ...(hello(bridge.posted[0]!.id, ["xai"]) as object),
      unavailable: [{ provider: "anthropic", reason: "host access was declined at install" }],
    });
    await expect(pending).rejects.toThrow(/host access was declined at install/u);
  });

  it("rejects a hello whose unavailability list is malformed rather than reading half of it", async () => {
    const bridge = harness();
    const active = client(bridge);
    const pending = active.handshake();
    await tick();
    bridge.deliver({
      ...(hello(bridge.posted[0]!.id, ["xai"]) as object),
      unavailable: [{ provider: "anthropic" }],
    });
    await expect(pending).resolves.toMatchObject({ kind: "malformed" });
  });

  it("propagates cancellation to the extension and to the caller", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = client(bridge);
    const { response } = await openExchange(bridge, active, controller.signal);
    const opened = await response;
    controller.abort(new Error("user stopped the turn"));
    expect(bridge.posted[2]).toMatchObject({ kind: "cancel" });
    await expect(opened.text()).rejects.toMatchObject({ code: "bridge-cancelled" });
  });

  it("does not post an exchange for a request cancelled during the handshake", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = client(bridge);
    const pending = active.fetch(fetchRequest(controller.signal));
    await tick();
    controller.abort(new Error("operator stopped"));
    bridge.deliver(hello(bridge.posted[0]!.id));
    await expect(pending).rejects.toMatchObject({ code: "bridge-cancelled" });
    expect(bridge.posted.filter((message) => message.kind === "fetch")).toHaveLength(0);
  });

  it("enforces its own response ceiling independently of the extension", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = new ExtensionBridgeClient(bridge.channel, {
      limits: { helloTimeoutMs: 20, maxResponseBytes: 8, maxChunkBytes: 8 },
    });
    const { id, response } = await openExchange(bridge, active, controller.signal);
    const opened = await response;
    bridge.deliver(chunk(id, 1, "0123456789"));
    await expect(opened.text()).rejects.toMatchObject({ code: "bridge-too-large" });
  });

  it("refuses to exceed its concurrent-request ceiling", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = new ExtensionBridgeClient(bridge.channel, {
      limits: { helloTimeoutMs: 20, maxConcurrentRequests: 1 },
    });
    const { response } = await openExchange(bridge, active, controller.signal);
    const opened = await response;
    await expect(active.fetch(fetchRequest(controller.signal)))
      .rejects.toMatchObject({ code: "bridge-busy" });
    controller.abort();
    await expect(opened.text()).rejects.toBeInstanceOf(ExtensionBridgeError);
  });

  it("holds the concurrent-request ceiling against callers entering in one tick", async () => {
    /*
     * The sequential test above passes even when the ceiling is a
     * check-then-increment straddling the presence `await`: by the time the
     * second caller runs, the first has already been counted. Ten callers that
     * all enter before any of them yields is the shape that finds it, and it is
     * the shape a streaming turn plus a burst of tool calls actually produces.
     */
    const bridge = harness();
    const controller = new AbortController();
    const active = new ExtensionBridgeClient(bridge.channel, {
      limits: { helloTimeoutMs: 20, maxConcurrentRequests: 2 },
    });
    const attempts = Array.from(
      { length: 10 },
      () => active.fetch(fetchRequest(controller.signal)).catch((error: unknown) => error),
    );
    await tick();
    bridge.deliver(hello(bridge.posted[0]!.id));
    await tick();
    expect(bridge.posted.filter((message) => message.kind === "fetch")).toHaveLength(2);
    // The two that were admitted are still open; cancelling them is what lets
    // this test finish, and it is also how their slots come back.
    controller.abort(new Error("test finished"));
    const settled = await Promise.all(attempts);
    const busy = settled.filter(
      (result) => result instanceof ExtensionBridgeError && result.code === "bridge-busy",
    );
    expect(busy).toHaveLength(8);
    expect(active.pendingCount).toBe(0);
  });

  it("fails an exchange the extension accepted but never answered", async () => {
    /*
     * `requestTimeoutMs` bounds a slow *answer*. It does not bound a silence:
     * without its own deadline, an extension that takes the `fetch` and sends
     * no `head` holds the exchange, and its concurrency slot, for the full five
     * minutes.
     */
    const bridge = harness();
    const controller = new AbortController();
    const active = new ExtensionBridgeClient(bridge.channel, {
      limits: { helloTimeoutMs: 20, headTimeoutMs: 20, requestTimeoutMs: 300_000 },
    });
    const pending = active.fetch(fetchRequest(controller.signal));
    await tick();
    bridge.deliver(hello(bridge.posted[0]!.id));
    await tick();
    expect(bridge.posted[1]).toMatchObject({ kind: "fetch" });
    await expect(pending).rejects.toMatchObject({ code: "bridge-timeout" });
    await expect(pending).rejects.toThrow(/first-byte deadline/u);
    // The slot is returned, and the extension is told to stop.
    expect(bridge.posted.some((message) => message.kind === "cancel")).toBe(true);
    expect(active.pendingCount).toBe(0);
  });

  it("re-probes after an absence instead of caching it, and memoizes only presence", async () => {
    /*
     * A memoized absence would refuse for the whole TTL on an observation that
     * is no longer being made, and would hide an extension installed mid-page.
     * A memoized presence is the bounded half: it can only admit a request,
     * which then fails live if the extension has gone.
     */
    const bridge = harness();
    const controller = new AbortController();
    const active = new ExtensionBridgeClient(bridge.channel, {
      limits: { helloTimeoutMs: 5, presenceTtlMs: 300_000 },
    });
    // Nothing answers the first handshake.
    await expect(active.fetch(fetchRequest(controller.signal)))
      .rejects.toMatchObject({ code: "bridge-unavailable" });
    // The extension arrives; the very next request must observe it.
    const second = active.fetch(fetchRequest(controller.signal));
    await tick();
    const helloMessages = bridge.posted.filter((message) => message.kind === "hello");
    expect(helloMessages).toHaveLength(2);
    bridge.deliver(hello(helloMessages[1]!.id));
    await tick();
    const fetchMessage = bridge.posted.find((message) => message.kind === "fetch");
    expect(fetchMessage).toBeDefined();
    bridge.deliver(head(fetchMessage!.id));
    bridge.deliver(end(fetchMessage!.id, 0));
    await expect((await second).text()).resolves.toBe("");
    // A third request reuses the positive observation rather than re-probing.
    const third = active.fetch(fetchRequest(controller.signal));
    await tick();
    expect(bridge.posted.filter((message) => message.kind === "hello")).toHaveLength(2);
    const thirdFetch = bridge.posted.filter((message) => message.kind === "fetch")[1];
    expect(thirdFetch).toBeDefined();
    bridge.deliver(head(thirdFetch!.id));
    bridge.deliver(end(thirdFetch!.id, 0));
    await expect((await third).text()).resolves.toBe("");
    // `handshake()` is what a capability record is built from, and it never
    // consults the memo: a live observation stays live even inside the TTL.
    const probe = active.handshake();
    await tick();
    const helloIds = bridge.posted.filter((message) => message.kind === "hello");
    expect(helloIds).toHaveLength(3);
    bridge.deliver(hello(helloIds[2]!.id));
    await expect(probe).resolves.toMatchObject({ kind: "answered" });
  });

  it("frees a concurrency slot once an exchange terminates", async () => {
    const bridge = harness();
    const controller = new AbortController();
    const active = new ExtensionBridgeClient(bridge.channel, {
      limits: { helloTimeoutMs: 20, maxConcurrentRequests: 1 },
    });
    const first = await openExchange(bridge, active, controller.signal);
    bridge.deliver(end(first.id, 0));
    await (await first.response).text();
    const second = active.fetch(fetchRequest(controller.signal));
    await tick();
    expect(bridge.posted[2]).toMatchObject({ kind: "fetch" });
    bridge.deliver(head(bridge.posted[2]!.id));
    bridge.deliver(end(bridge.posted[2]!.id, 0));
    await expect((await second).text()).resolves.toBe("");
  });
});
