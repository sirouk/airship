import { describe, expect, it } from "vitest";
import { ANTHROPIC_OAUTH, XAI_OAUTH } from "../../auth/provider-oauth/registrations";
import {
  ANTHROPIC_OAUTH_INFERENCE_HEADERS,
  BRIDGE_DESTINATIONS,
  BRIDGE_HEADER_ALLOWLIST,
  bridgeReplyId,
  bridgeRequestHeaders,
  isBridgeDestination,
  parseBridgeReply,
} from "./protocol";

describe("bridge envelope parsing", () => {
  const valid = {
    airshipBridge: 1,
    from: "extension",
    id: "3f2a9c1e-0000-4000-8000-abcdefabcdef",
    kind: "hello",
    version: "0.4.1",
    providers: ["anthropic", "xai"],
  };

  it("accepts a well-formed hello reply", () => {
    expect(parseBridgeReply(valid)).toMatchObject({ kind: "hello", version: "0.4.1" });
  });

  it("refuses any protocol version but the exact one", () => {
    expect(bridgeReplyId({ ...valid, airshipBridge: 2 })).toBeUndefined();
    expect(bridgeReplyId({ ...valid, airshipBridge: "1" })).toBeUndefined();
  });

  it("refuses a message that is not marked as coming from the extension", () => {
    expect(bridgeReplyId({ ...valid, from: "page" })).toBeUndefined();
    expect(bridgeReplyId({ ...valid, from: undefined })).toBeUndefined();
  });

  it("refuses a provider list containing anything unrecognized", () => {
    expect(parseBridgeReply({ ...valid, providers: ["anthropic", "openai"] })).toBeUndefined();
    expect(parseBridgeReply({ ...valid, providers: "anthropic" })).toBeUndefined();
  });

  it("refuses a head with an impossible status or an unparseable header", () => {
    const head = { airshipBridge: 1, from: "extension", id: valid.id, kind: "head", headers: {} };
    expect(parseBridgeReply({ ...head, status: 200 })).toMatchObject({ status: 200 });
    expect(parseBridgeReply({ ...head, status: 99 })).toBeUndefined();
    expect(parseBridgeReply({ ...head, status: 600 })).toBeUndefined();
    expect(parseBridgeReply({ ...head, status: 200, headers: { "x-a": 7 } })).toBeUndefined();
    expect(parseBridgeReply({
      ...head,
      status: 200,
      headers: { "content-type": "text/event-stream\r\nx-injected: 1" },
    })).toBeUndefined();
  });

  it("refuses a chunk whose payload is not base64 or whose sequence is not positive", () => {
    const base = { airshipBridge: 1, from: "extension", id: valid.id, kind: "chunk" };
    expect(parseBridgeReply({ ...base, seq: 1, data: "aGk=" })).toMatchObject({ seq: 1 });
    expect(parseBridgeReply({ ...base, seq: 1, data: "not base64!" })).toBeUndefined();
    expect(parseBridgeReply({ ...base, seq: 0, data: "aGk=" })).toBeUndefined();
    expect(parseBridgeReply({ ...base, seq: 1.5, data: "aGk=" })).toBeUndefined();
  });
});

describe("bridge destination allowlist", () => {
  it("carries exactly the contract's origins and prefixes", () => {
    expect(isBridgeDestination("xai", "https://auth.x.ai/oauth2/device/code")).toBe(true);
    expect(isBridgeDestination("xai", "https://api.x.ai/v1/responses")).toBe(true);
    expect(isBridgeDestination("anthropic", "https://api.anthropic.com/v1/messages")).toBe(true);
    expect(isBridgeDestination("anthropic", "https://platform.claude.com/v1/oauth/token")).toBe(true);
  });

  it("refuses a lookalike host, another provider's host, and a non-https scheme", () => {
    expect(isBridgeDestination("anthropic", "https://api.anthropic.com.evil.test/v1/messages")).toBe(false);
    expect(isBridgeDestination("anthropic", "https://api.x.ai/v1/responses")).toBe(false);
    expect(isBridgeDestination("xai", "https://api.anthropic.com/v1/messages")).toBe(false);
    expect(isBridgeDestination("xai", "http://api.x.ai/v1/responses")).toBe(false);
  });

  it("carries the reviewed OAuth endpoints the registrations declare bridge-only", () => {
    // The registrations are the OAuth package's authority; this asserts the two
    // allowlists agree rather than restating either.
    expect(isBridgeDestination("xai", XAI_OAUTH.deviceAuthorizationEndpoint)).toBe(true);
    expect(isBridgeDestination("xai", XAI_OAUTH.tokenEndpoints[0]!)).toBe(true);
    expect(isBridgeDestination("anthropic", ANTHROPIC_OAUTH.tokenEndpoints[0]!)).toBe(true);
  });

  it("does not carry Anthropic's console.anthropic.com host at all", () => {
    // docs/EXTENSION_BRIDGE.md allowlists platform.claude.com but not
    // console.anthropic.com. ANTHROPIC_OAUTH used to list the console host as a
    // second token endpoint, which could therefore never be reached; the
    // registration dropped it rather than the allowlist growing to match.
    expect(ANTHROPIC_OAUTH.tokenEndpoints).toEqual(["https://platform.claude.com/v1/oauth/token"]);
    expect(isBridgeDestination("anthropic", "https://console.anthropic.com/v1/oauth/token"))
      .toBe(false);
  });

  it("matches a normalized URL, so a path prefix cannot be walked out of", () => {
    /*
     * A raw `startsWith` accepts every line below: each one sits textually
     * inside an allowlisted prefix and then resolves somewhere else. The page
     * has to refuse them on its own — the extension normalizes too, but a page
     * that relied on that would be trusting the component it treats as
     * untrusted input.
     */
    expect(isBridgeDestination("anthropic", "https://api.anthropic.com/v1/../../evil"))
      .toBe(false);
    expect(isBridgeDestination("xai", "https://api.x.ai/v1/../oauth2/token")).toBe(false);
    // A backslash normalizes into a separator before the prefix comparison, so
    // it cannot be used to leave the prefix either.
    expect(isBridgeDestination("anthropic", "https://api.anthropic.com/v1/..\\evil.test"))
      .toBe(false);
    // Escapes the URL parser leaves alone but an origin's router may decode.
    // Refused positively: the path may hold unreserved characters and `/` only.
    expect(isBridgeDestination("anthropic", "https://api.anthropic.com/v1/..%2f..%2fevil"))
      .toBe(false);
    expect(isBridgeDestination("anthropic", "https://api.anthropic.com/v1/%252e%252e/evil"))
      .toBe(false);
    expect(isBridgeDestination("anthropic", "https://api.anthropic.com/v1/messages;x=1"))
      .toBe(false);
    // Embedded credentials and a fragment are refused outright.
    expect(isBridgeDestination("anthropic", "https://user:pass@api.anthropic.com/v1/messages"))
      .toBe(false);
    expect(isBridgeDestination("anthropic", "https://api.anthropic.com/v1/messages#x")).toBe(false);
    // A `.` run that normalizes back inside the prefix is still legitimate, and
    // the query is deliberately unrestricted — it cannot move the request off
    // the path prefix, and an OAuth `redirect_uri` carries `%2F` by design.
    expect(isBridgeDestination("anthropic", "https://api.anthropic.com/v1/./messages")).toBe(true);
    expect(isBridgeDestination("anthropic", "https://api.anthropic.com/v1/models?after_id=a%2Fb"))
      .toBe(true);
  });

  it("agrees with the extension on every destination the page will send", () => {
    /*
     * The page's promise is that it never sends a request the extension has to
     * refuse. That only holds while the two rules are the same rule, so the
     * shapes above are the ones extension/src/policy.ts refuses too; if that
     * file's `DESTINATION_PATH` is widened or narrowed, this list is what has
     * to be revisited.
     */
    for (const prefix of BRIDGE_DESTINATIONS.anthropic) {
      expect(isBridgeDestination("anthropic", prefix)).toBe(true);
      expect(isBridgeDestination("xai", prefix)).toBe(false);
    }
    for (const prefix of BRIDGE_DESTINATIONS.xai) {
      expect(isBridgeDestination("xai", prefix)).toBe(true);
      expect(isBridgeDestination("anthropic", prefix)).toBe(false);
    }
  });
});

describe("bridge header allowlist", () => {
  it("normalizes case and passes the headers the protocols require", () => {
    expect(bridgeRequestHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }))
      .toEqual({ "content-type": "application/json", accept: "text/event-stream" });
  });

  it("refuses an unlisted header instead of dropping it silently", () => {
    expect(() => bridgeRequestHeaders({ "x-api-key": "sk-live" }))
      .toThrow(/does not carry the x-api-key header/u);
    expect(() => bridgeRequestHeaders({ cookie: "session=1" })).toThrow(/does not carry/u);
  });

  it("refuses a header value that could split the request", () => {
    expect(() => bridgeRequestHeaders({ authorization: "Bearer a\r\nx-injected: 1" }))
      .toThrow(/not a valid bridged header/u);
  });

  it("carries the user-agent the Anthropic token exchange was measured to need", () => {
    // The value itself lives once, in the OAuth registration. What the bridge
    // owes it is the ability to carry the header at all, which page script
    // cannot set.
    for (const name of Object.keys(ANTHROPIC_OAUTH.tokenRequestHeaders)) {
      expect(BRIDGE_HEADER_ALLOWLIST).toContain(name);
    }
    expect(ANTHROPIC_OAUTH.tokenRequestHeaders["user-agent"]).toBe("axios/1.7.9");
  });

  it("carries the Claude Code inference fingerprint and never confuses it with the exchange one", () => {
    expect(ANTHROPIC_OAUTH_INFERENCE_HEADERS["user-agent"]).toMatch(/^claude-code\//u);
    expect(ANTHROPIC_OAUTH_INFERENCE_HEADERS["x-app"]).toBe("cli");
    expect(ANTHROPIC_OAUTH_INFERENCE_HEADERS["user-agent"])
      .not.toBe(ANTHROPIC_OAUTH.tokenRequestHeaders["user-agent"]);
    expect(() => bridgeRequestHeaders(ANTHROPIC_OAUTH_INFERENCE_HEADERS)).not.toThrow();
  });
});
