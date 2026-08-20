import { describe, expect, it } from "vitest";
import {
  accessReconnectHash,
  canonicalAccessHash,
  parseAccessReconnectIntent,
  reconnectMethodTab,
  reconnectIntentsEqual,
  reconnectRouteDisposition,
  type AccessReconnectIntent,
} from "./access-intent";

const INTENT: AccessReconnectIntent = Object.freeze({
  providerId: "openai-compatible-gateway.example-abc123",
  method: "api-key",
  model: "org/example-model",
  connectionId: "custom-connection-1",
  connectionGeneration: 7,
  returnSessionId: "3f2c1b0a-0000-4000-8000-000000000001",
});

const COMPLETE_QUERY = [
  `providerId=${INTENT.providerId}`,
  "method=api-key",
  "model=m",
  "connectionId=conn-1",
  "connectionGeneration=1",
  "returnSessionId=s",
].join("&");

const LEGACY_QUERY = [
  "lane=chutes",
  "method=api-key",
  "model=m",
  "connection=conn-1",
  "generation=1",
  "return=s",
].join("&");

describe("access reconnect intent", () => {
  it("round-trips an arbitrary provider ID through the canonical Connection route", () => {
    const hash = accessReconnectHash(INTENT);
    expect(hash.startsWith("#connection?")).toBe(true);
    const query = new URLSearchParams(hash.split("?", 2)[1]);
    expect([...query.keys()]).toEqual([
      "providerId",
      "method",
      "model",
      "connectionId",
      "connectionGeneration",
      "returnSessionId",
    ]);
    expect(parseAccessReconnectIntent(hash)).toEqual(INTENT);
    expect(canonicalAccessHash(hash)).toBe(hash);
  });

  it("canonicalizes an unambiguous legacy vendor lane to its exact provider ID", () => {
    const legacy = `#access?${LEGACY_QUERY}`;
    expect(parseAccessReconnectIntent(legacy)).toEqual({
      providerId: "chutes",
      method: "api-key",
      model: "m",
      connectionId: "conn-1",
      connectionGeneration: 1,
      returnSessionId: "s",
    });
    expect(canonicalAccessHash(legacy)).toBe(
      "#connection?providerId=chutes&method=api-key&model=m&connectionId=conn-1&connectionGeneration=1&returnSessionId=s",
    );
  });

  it.each([
    ["codex", "openai"],
    ["claude", "anthropic"],
    ["grok", "xai"],
    ["chutes", "chutes"],
  ] as const)("maps legacy lane %s only when it identifies provider %s", (lane, providerId) => {
    const parsed = parseAccessReconnectIntent(`#connection?lane=${lane}&method=api-key&model=m&connectionId=c&connectionGeneration=1&returnSessionId=s`);
    expect(parsed?.providerId).toBe(providerId);
  });

  it("fails closed for the ambiguous legacy local lane", () => {
    expect(parseAccessReconnectIntent("#connection?lane=local&method=local-none&model=m&connectionId=c&connectionGeneration=1&returnSessionId=s"))
      .toBeUndefined();
  });

  it.each([
    `#connection?${COMPLETE_QUERY}&connectionId=conn-2`,
    `#connection?${COMPLETE_QUERY}&provider=${INTENT.providerId}`,
    `#connection?${COMPLETE_QUERY}&lane=chutes`,
    `#connection?${LEGACY_QUERY}&connectionId=conn-1`,
    `#connection?${COMPLETE_QUERY}&surprise=1`,
    "#connection?providerId=p&method=password&model=m&connectionId=conn-1&connectionGeneration=1&returnSessionId=s",
    "#connection?providerId=UPPER&method=api-key&model=m&connectionId=conn-1&connectionGeneration=1&returnSessionId=s",
    "#connection?providerId=p&method=api-key&model=&connectionId=conn-1&connectionGeneration=1&returnSessionId=s",
    "#connection?providerId=p&method=api-key&model=m&connectionId=conn-1&connectionGeneration=1&returnSessionId=folder%2Fsession",
    "#connection?providerId=p&method=api-key&model=m&returnSessionId=s",
    "#connection?providerId=p&method=api-key&model=m&connectionGeneration=1&returnSessionId=s",
    "#connection?providerId=p&model=m&connectionId=conn-1&connectionGeneration=1&returnSessionId=s",
    `#connection??${COMPLETE_QUERY}`,
  ])("rejects an ambiguous or malformed instruction: %s", (hash) => {
    expect(parseAccessReconnectIntent(hash)).toBeUndefined();
    expect(canonicalAccessHash(hash)).toBe("#connection");
  });

  it("rejects unbounded and control-bearing values", () => {
    const oversizedModel = "m".repeat(513);
    const oversizedProvider = "p".repeat(129);
    expect(parseAccessReconnectIntent(`#connection?providerId=p&method=api-key&model=${oversizedModel}&connectionId=conn-1&connectionGeneration=1&returnSessionId=s`)).toBeUndefined();
    expect(parseAccessReconnectIntent(`#connection?providerId=${oversizedProvider}&method=api-key&model=m&connectionId=conn-1&connectionGeneration=1&returnSessionId=s`)).toBeUndefined();
    expect(parseAccessReconnectIntent("#connection?providerId=p&method=api-key&model=m%0Ahidden&connectionId=conn-1&connectionGeneration=1&returnSessionId=s")).toBeUndefined();
    expect(parseAccessReconnectIntent("#connection?providerId=p&method=api-key&model=m&connectionId=Conn-1&connectionGeneration=1&returnSessionId=s")).toBeUndefined();
  });

  it.each(["0", "-1", "1.5", "01", "9007199254740992"])("rejects invalid connection generation %s", (generation) => {
    expect(parseAccessReconnectIntent(`#connection?providerId=p&method=api-key&model=m&connectionId=conn-1&connectionGeneration=${generation}&returnSessionId=s`)).toBeUndefined();
  });

  it("requires a finite positive integer generation when constructing the canonical hash", () => {
    expect(() => accessReconnectHash({ ...INTENT, connectionGeneration: 0 })).toThrow(/generation/i);
    expect(() => accessReconnectHash({ ...INTENT, connectionGeneration: Number.POSITIVE_INFINITY })).toThrow(/generation/i);
  });

  it("distinguishes an exact provider generation from a replacement and unrelated provider", () => {
    const exact = {
      providerId: INTENT.providerId,
      method: INTENT.method,
      model: INTENT.model,
      connectionId: INTENT.connectionId,
      connectionGeneration: INTENT.connectionGeneration,
    } as const;
    expect(reconnectRouteDisposition(INTENT, exact)).toBe("exact");
    expect(reconnectRouteDisposition(INTENT, { ...exact, connectionGeneration: 8 })).toBe("replacement");
    expect(reconnectRouteDisposition(INTENT, { ...exact, connectionId: "replacement" })).toBe("replacement");
    expect(reconnectRouteDisposition(INTENT, { ...exact, providerId: "another-provider" })).toBe("unrelated");
    expect(reconnectRouteDisposition(INTENT, { ...exact, providerId: undefined })).toBe("unrelated");
  });

  it("requires every captured return field to remain present and unchanged", () => {
    expect(reconnectIntentsEqual(INTENT, { ...INTENT })).toBe(true);
    expect(reconnectIntentsEqual(INTENT, undefined)).toBe(false);
    expect(reconnectIntentsEqual(undefined, INTENT)).toBe(false);
    expect(reconnectIntentsEqual(undefined, undefined)).toBe(false);
    for (const changed of [
      { ...INTENT, providerId: "another-provider" },
      { ...INTENT, method: "oauth-pkce" as const },
      { ...INTENT, model: "replacement-model" },
      { ...INTENT, connectionId: "replacement-connection" },
      { ...INTENT, connectionGeneration: 8 },
      { ...INTENT, returnSessionId: "replacement-session" },
    ]) expect(reconnectIntentsEqual(INTENT, changed)).toBe(false);
  });

  it("maps only reconnect methods represented by connection tabs", () => {
    expect(reconnectMethodTab("oauth-pkce")).toBe("oauth");
    expect(reconnectMethodTab("api-key")).toBe("api-key");
    expect(reconnectMethodTab("local-none")).toBeUndefined();
  });
});
