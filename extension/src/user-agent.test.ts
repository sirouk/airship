import { describe, expect, it } from "vitest";
import { ANTHROPIC_OAUTH_INFERENCE_USER_AGENT, ANTHROPIC_TOKEN_USER_AGENT } from "./policy";
import {
  USER_AGENT_RULE_ID_BASE,
  type DeclarativeNetRequestRule,
  applyUserAgentHeader,
  installUserAgentOverride,
  overrideDestinations,
  userAgentRules,
} from "./user-agent";

describe("user-agent rewrite rules", () => {
  it("covers exactly the destinations that measured a browser-agent refusal", () => {
    expect(overrideDestinations().map((destination) => destination.prefix)).toEqual([
      "https://claude.ai/oauth/",
      "https://platform.claude.com/v1/oauth/",
      "https://api.anthropic.com/v1/",
    ]);
    // The two Anthropic surfaces need different agents, which is why the value
    // belongs to the destination rather than to the extension.
    expect(overrideDestinations().map((destination) => destination.userAgent)).toEqual([
      ANTHROPIC_TOKEN_USER_AGENT,
      ANTHROPIC_TOKEN_USER_AGENT,
      ANTHROPIC_OAUTH_INFERENCE_USER_AGENT,
    ]);
  });

  it("anchors each rule to one destination and to this worker's own requests", () => {
    const rules = userAgentRules();
    expect(rules).toHaveLength(3);
    expect(rules[2]?.action.requestHeaders[0]?.value).toBe(ANTHROPIC_OAUTH_INFERENCE_USER_AGENT);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(3);
    expect(rules[0]).toEqual({
      id: USER_AGENT_RULE_ID_BASE,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "user-agent", operation: "set", value: ANTHROPIC_TOKEN_USER_AGENT }],
      },
      condition: {
        urlFilter: "|https://claude.ai/oauth/",
        resourceTypes: ["xmlhttprequest"],
        // -1 is "no tab": the user's own browsing keeps its real user agent.
        tabIds: [-1],
      },
    });
  });
});

describe("blocking listener body", () => {
  it("rewrites only this worker's requests to a destination that needs it", () => {
    const details = {
      url: "https://platform.claude.com/v1/oauth/token",
      tabId: -1,
      requestHeaders: [{ name: "User-Agent", value: "Mozilla/5.0" }, { name: "Accept", value: "*/*" }],
    };
    expect(applyUserAgentHeader(details)).toEqual({
      requestHeaders: [
        { name: "Accept", value: "*/*" },
        { name: "User-Agent", value: ANTHROPIC_TOKEN_USER_AGENT },
      ],
    });
  });

  it("leaves tab traffic and unrelated destinations untouched", () => {
    expect(applyUserAgentHeader({ url: "https://platform.claude.com/v1/oauth/token", tabId: 7 }))
      .toBeUndefined();
    expect(applyUserAgentHeader({ url: "https://api.x.ai/v1/chat/completions", tabId: -1 }))
      .toBeUndefined();
    expect(applyUserAgentHeader({ url: "https://api.anthropic.com/v1/messages", tabId: -1 }))
      .toEqual({ requestHeaders: [{ name: "User-Agent", value: ANTHROPIC_OAUTH_INFERENCE_USER_AGENT }] });
    expect(applyUserAgentHeader({ url: "https://evil.example/", tabId: -1 })).toBeUndefined();
  });
});

describe("override installation", () => {
  /** `reportBack: "stripped"` models a browser that stores the rule and drops the rewrite. */
  function declarativeHost(behaviour: Readonly<{
    accept: boolean;
    reportBack: boolean | "stripped";
  }>) {
    const written: DeclarativeNetRequestRule[] = [];
    return {
      written,
      host: {
        declarativeNetRequest: {
          async updateSessionRules(options: Readonly<{ addRules: readonly DeclarativeNetRequestRule[] }>) {
            if (!behaviour.accept) throw new Error("modifyHeaders is not supported.");
            written.push(...options.addRules);
          },
          async getSessionRules() {
            if (!behaviour.reportBack) return [];
            return written.map((rule) => ({
              id: rule.id,
              action: behaviour.reportBack === "stripped"
                ? { type: rule.action.type }
                : { type: rule.action.type, requestHeaders: rule.action.requestHeaders },
            }));
          },
        },
      },
    };
  }

  it("reports live only after the browser confirmed the rules it wrote", async () => {
    const accepted = declarativeHost({ accept: true, reportBack: true });
    await expect(installUserAgentOverride(accepted.host)).resolves.toBe("live");
    expect(accepted.written).toHaveLength(3);
  });

  it("reports unavailable when the rules do not read back", async () => {
    const silent = declarativeHost({ accept: true, reportBack: false });
    await expect(installUserAgentOverride(silent.host)).resolves.toBe("unavailable");
  });

  it("reports unavailable when the rule reads back without its rewrite", async () => {
    // The failure mode that would turn an honest `unavailable` into a false
    // claim of Anthropic support: a browser that accepts and stores a
    // modifyHeaders rule whose header modification it never applies.
    const stripped = declarativeHost({ accept: true, reportBack: "stripped" });
    await expect(installUserAgentOverride(stripped.host)).resolves.toBe("unavailable");
    expect(stripped.written).toHaveLength(3);
  });

  it("falls back to a blocking listener when header rules are rejected", async () => {
    const rejecting = declarativeHost({ accept: false, reportBack: false });
    const registrations: readonly string[][] = [];
    const host = {
      ...rejecting.host,
      webRequest: {
        onBeforeSendHeaders: {
          addListener(
            _listener: unknown,
            filter: Readonly<{ urls: readonly string[] }>,
            extra: readonly string[],
          ) {
            (registrations as string[][]).push([...filter.urls, ...extra]);
          },
        },
      },
    };
    await expect(installUserAgentOverride(host)).resolves.toBe("live");
    expect(registrations[0]).toEqual([
      "https://claude.ai/oauth/*",
      "https://platform.claude.com/v1/oauth/*",
      "https://api.anthropic.com/v1/*",
      "blocking",
      "requestHeaders",
    ]);
  });

  it("reports unavailable when a registered listener does not read back", async () => {
    // `addListener` returning is an assertion; `hasListener` is an observation.
    // Where the engine offers the second, the first is not enough.
    const rejecting = declarativeHost({ accept: false, reportBack: false });
    const host = {
      ...rejecting.host,
      webRequest: {
        onBeforeSendHeaders: {
          addListener() {
            return undefined;
          },
          hasListener() {
            return false;
          },
        },
      },
    };
    await expect(installUserAgentOverride(host)).resolves.toBe("unavailable");
  });

  it("reports unavailable on a browser that offers neither mechanism", async () => {
    await expect(installUserAgentOverride(undefined)).resolves.toBe("unavailable");
    await expect(installUserAgentOverride({})).resolves.toBe("unavailable");
    const throwing = {
      webRequest: {
        onBeforeSendHeaders: {
          addListener() {
            throw new Error("Blocking listeners require the webRequestBlocking permission.");
          },
        },
      },
    };
    await expect(installUserAgentOverride(throwing)).resolves.toBe("unavailable");
  });
});
