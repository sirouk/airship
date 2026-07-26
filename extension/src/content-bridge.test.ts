import { describe, expect, it } from "vitest";
import { type ChannelPort, classifyPageMessage, createPageChannel } from "./content-bridge";
import { callerAllowlist } from "./policy";
import type { BridgeReply } from "./protocol";

const PAGE = Object.freeze({ url: "https://sirouk.github.io/airship/index.html" });
const SELF = { name: "window" };

function context(overrides: Readonly<{ url?: string; self?: unknown }> = {}) {
  return Object.freeze({
    self: overrides.self ?? SELF,
    url: overrides.url ?? PAGE.url,
    callers: callerAllowlist("release"),
  });
}

function request(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { airshipBridge: 1, from: "page", id: "req-1", kind: "hello", ...overrides };
}

function fakePort() {
  const posted: unknown[] = [];
  let onMessage: ((message: unknown) => void) | undefined;
  let onDisconnect: (() => void) | undefined;
  const port: ChannelPort = {
    postMessage: (message) => posted.push(message),
    onMessage: { addListener: (listener) => { onMessage = listener; } },
    onDisconnect: { addListener: (listener) => { onDisconnect = listener; } },
  };
  return {
    port,
    posted,
    emit: (message: unknown) => onMessage?.(message),
    drop: () => onDisconnect?.(),
  };
}

describe("page message classification", () => {
  it("relays a bridge request that came from this window on this origin", () => {
    expect(classifyPageMessage(
      { data: request(), origin: "https://sirouk.github.io", source: SELF },
      context(),
    )).toMatchObject({ action: "relay", id: "req-1", origin: "https://sirouk.github.io" });
  });

  it("ignores anything that is not this page talking to itself", () => {
    const cases: readonly Readonly<{ why: string; event: { data: unknown; origin: string; source: unknown } }>[] = [
      { why: "another frame", event: { data: request(), origin: "https://sirouk.github.io", source: { name: "iframe" } } },
      { why: "a foreign origin", event: { data: request(), origin: "https://evil.example", source: SELF } },
      { why: "a non-object", event: { data: "hello", origin: "https://sirouk.github.io", source: SELF } },
      { why: "an array", event: { data: [1], origin: "https://sirouk.github.io", source: SELF } },
      { why: "another protocol", event: { data: { airshipBridge: 2, from: "page", id: "x", kind: "hello" }, origin: "https://sirouk.github.io", source: SELF } },
      { why: "a reflected reply", event: { data: { airshipBridge: 1, from: "extension", id: "x", kind: "end" }, origin: "https://sirouk.github.io", source: SELF } },
      { why: "no kind", event: { data: { airshipBridge: 1, from: "page", id: "x" }, origin: "https://sirouk.github.io", source: SELF } },
      { why: "no id", event: { data: { airshipBridge: 1, from: "page", kind: "hello" }, origin: "https://sirouk.github.io", source: SELF } },
    ];
    for (const { why, event } of cases) {
      expect(classifyPageMessage(event, context()), why).toMatchObject({ action: "ignore" });
    }
  });

  it("ignores every message when the document itself is not an Airship page", () => {
    expect(classifyPageMessage(
      { data: request(), origin: "https://sirouk.github.io", source: SELF },
      context({ url: "https://sirouk.github.io/some-other-app/" }),
    )).toMatchObject({ action: "ignore" });
  });
});

describe("page channel", () => {
  it("forwards requests and returns replies to the exact page origin", () => {
    const connection = fakePort();
    const delivered: { message: BridgeReply; origin: string }[] = [];
    const channel = createPageChannel({
      context: context(),
      connect: () => connection.port,
      postToPage: (message, origin) => delivered.push({ message, origin }),
    });

    channel.receive({ data: request(), origin: "https://sirouk.github.io", source: SELF });
    expect(connection.posted).toEqual([request()]);
    expect(channel.outstanding()).toBe(1);

    connection.emit({ airshipBridge: 1, from: "extension", id: "req-1", kind: "chunk", seq: 1, data: "eA==" });
    expect(channel.outstanding()).toBe(1);
    connection.emit({ airshipBridge: 1, from: "extension", id: "req-1", kind: "end", seq: 1 });
    expect(channel.outstanding()).toBe(0);
    expect(delivered.map((entry) => entry.origin)).toEqual([
      "https://sirouk.github.io",
      "https://sirouk.github.io",
    ]);
    expect(delivered.every((entry) => entry.origin !== "*")).toBe(true);
  });

  it("drops a malformed reply instead of posting it to the page", () => {
    const connection = fakePort();
    const delivered: BridgeReply[] = [];
    const channel = createPageChannel({
      context: context(),
      connect: () => connection.port,
      postToPage: (message) => delivered.push(message),
    });
    channel.receive({ data: request(), origin: "https://sirouk.github.io", source: SELF });
    connection.emit({ hello: "not a bridge message" });
    expect(delivered).toEqual([]);
  });

  it("fails every outstanding request closed when the worker disappears", () => {
    const connection = fakePort();
    const delivered: BridgeReply[] = [];
    const channel = createPageChannel({
      context: context(),
      connect: () => connection.port,
      postToPage: (message) => delivered.push(message),
    });
    channel.receive({ data: request({ id: "a" }), origin: "https://sirouk.github.io", source: SELF });
    channel.receive({ data: request({ id: "b" }), origin: "https://sirouk.github.io", source: SELF });
    connection.drop();
    expect(delivered).toEqual([
      { airshipBridge: 1, from: "extension", id: "a", kind: "error", reason: expect.stringContaining("bridge-disconnected") },
      { airshipBridge: 1, from: "extension", id: "b", kind: "error", reason: expect.stringContaining("bridge-disconnected") },
    ]);
    expect(channel.outstanding()).toBe(0);
  });

  it("answers explicitly when the worker cannot be reached at all", () => {
    const delivered: BridgeReply[] = [];
    const channel = createPageChannel({
      context: context(),
      connect: () => {
        throw new Error("Extension context invalidated.");
      },
      postToPage: (message) => delivered.push(message),
    });
    channel.receive({ data: request(), origin: "https://sirouk.github.io", source: SELF });
    expect(delivered).toEqual([
      expect.objectContaining({ kind: "error", reason: expect.stringContaining("bridge-disconnected") }),
    ]);
  });

  it("bounds how many requests one page may leave outstanding", () => {
    const connection = fakePort();
    const delivered: BridgeReply[] = [];
    const channel = createPageChannel({
      context: context(),
      connect: () => connection.port,
      postToPage: (message) => delivered.push(message),
      maxOutstanding: 2,
    });
    for (const id of ["a", "b", "c"]) {
      channel.receive({ data: request({ id }), origin: "https://sirouk.github.io", source: SELF });
    }
    expect(connection.posted).toHaveLength(2);
    expect(delivered).toEqual([
      expect.objectContaining({ id: "c", reason: expect.stringContaining("too-many-requests") }),
    ]);
  });
});
