import { describe, expect, it } from "vitest";
import {
  accessLaneForProvider,
  accessReconnectHash,
  canonicalAccessHash,
  parseAccessReconnectIntent,
  reconnectMethodTab,
  reconnectIntentsEqual,
  reconnectRouteDisposition,
  type AccessReconnectIntent,
} from "./access-intent";

const INTENT: AccessReconnectIntent = Object.freeze({
  lane: "chutes",
  method: "api-key",
  model: "zai-org/GLM-5.2-TEE",
  connectionId: "chutes-connection-1",
  connectionGeneration: 7,
  returnSessionId: "3f2c1b0a-0000-4000-8000-000000000001",
});

const COMPLETE_QUERY = "lane=chutes&method=api-key&model=m&connection=conn-1&generation=1&return=s";

describe("access reconnect intent", () => {
  it("round-trips one complete instruction through the canonical Connection route", () => {
    const hash = accessReconnectHash(INTENT);
    expect(hash.startsWith("#connection?")).toBe(true);
    expect(parseAccessReconnectIntent(hash)).toEqual(INTENT);
    expect(canonicalAccessHash(hash)).toBe(hash);
  });

  it("preserves a valid legacy Access instruction while canonicalizing its route", () => {
    const legacy = accessReconnectHash(INTENT).replace("#connection?", "#access?");
    expect(parseAccessReconnectIntent(legacy)).toEqual(INTENT);
    expect(canonicalAccessHash(legacy)).toBe(accessReconnectHash(INTENT));
  });

  it.each([
    `#connection?${COMPLETE_QUERY}&lane=codex`,
    `#connection?${COMPLETE_QUERY}&surprise=1`,
    "#connection?lane=chutes&method=password&model=m&connection=conn-1&generation=1&return=s",
    "#connection?lane=unknown&method=api-key&model=m&connection=conn-1&generation=1&return=s",
    "#connection?lane=chutes&method=api-key&model=&connection=conn-1&generation=1&return=s",
    "#connection?lane=chutes&method=api-key&model=m&connection=conn-1&generation=1&return=folder%2Fsession",
    "#connection?lane=chutes&method=api-key&model=m&connection=conn-1&return=s",
    "#connection?lane=chutes&method=api-key&model=m&generation=1&return=s",
    "#connection?lane=chutes&model=m&connection=conn-1&generation=1&return=s",
    `#connection??${COMPLETE_QUERY}`,
  ])("rejects an ambiguous or malformed instruction: %s", (hash) => {
    expect(parseAccessReconnectIntent(hash)).toBeUndefined();
    expect(canonicalAccessHash(hash)).toBe("#connection");
  });

  it("rejects unbounded and control-bearing values", () => {
    const oversized = "m".repeat(513);
    expect(parseAccessReconnectIntent(`#connection?lane=chutes&method=api-key&model=${oversized}&connection=conn-1&generation=1&return=s`)).toBeUndefined();
    expect(parseAccessReconnectIntent("#connection?lane=chutes&method=api-key&model=m%0Ahidden&connection=conn-1&generation=1&return=s")).toBeUndefined();
  });

  it.each(["0", "-1", "1.5", "01", "9007199254740992"])("rejects invalid connection generation %s", (generation) => {
    expect(parseAccessReconnectIntent(`#connection?lane=chutes&method=api-key&model=m&connection=conn-1&generation=${generation}&return=s`)).toBeUndefined();
  });

  it("distinguishes an exact held generation from a replacement and an unrelated lane", () => {
    const exact = {
      lane: INTENT.lane,
      method: INTENT.method,
      model: INTENT.model,
      connectionId: INTENT.connectionId,
      connectionGeneration: INTENT.connectionGeneration,
    } as const;
    expect(reconnectRouteDisposition(INTENT, exact)).toBe("exact");
    expect(reconnectRouteDisposition(INTENT, { ...exact, connectionGeneration: 8 })).toBe("replacement");
    expect(reconnectRouteDisposition(INTENT, { ...exact, connectionId: "chutes-replacement" })).toBe("replacement");
    expect(reconnectRouteDisposition(INTENT, { ...exact, lane: "codex" })).toBe("unrelated");
  });

  it("requires every captured return field to remain present and unchanged", () => {
    expect(reconnectIntentsEqual(INTENT, { ...INTENT })).toBe(true);
    expect(reconnectIntentsEqual(INTENT, undefined)).toBe(false);
    for (const changed of [
      { ...INTENT, lane: "codex" as const },
      { ...INTENT, method: "oauth-pkce" as const },
      { ...INTENT, model: "replacement-model" },
      { ...INTENT, connectionId: "replacement-connection" },
      { ...INTENT, connectionGeneration: 8 },
      { ...INTENT, returnSessionId: "replacement-session" },
    ]) expect(reconnectIntentsEqual(INTENT, changed)).toBe(false);
  });

  it.each([
    ["chutes", "chutes"],
    ["chutes-e2ee-v1", "chutes"],
    ["openai", "codex"],
    ["codex-cloud", "codex"],
    ["anthropic", "claude"],
    ["xai", "grok"],
    ["ollama", "local"],
    ["lm-studio", "local"],
    ["local-runtime", "local"],
  ] as const)("maps provider %s to lane %s", (provider, lane) => {
    expect(accessLaneForProvider(provider)).toBe(lane);
  });

  it("does not invent a Connection lane for an unknown provider", () => {
    expect(accessLaneForProvider("airship-demo")).toBeUndefined();
  });

  it("maps only reconnect methods represented by the Chutes tabs", () => {
    expect(reconnectMethodTab("oauth-pkce")).toBe("oauth");
    expect(reconnectMethodTab("api-key")).toBe("api-key");
    expect(reconnectMethodTab("local-none")).toBeUndefined();
  });
});
