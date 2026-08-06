import { describe, expect, it } from "vitest";
import {
  BRIDGE_DESTINATIONS,
  BRIDGE_LIMITS,
  FORWARDED_REQUEST_HEADERS,
  RELEASE_CALLERS,
  callerAllowlist,
  developmentCallers,
  callerMatchPatterns,
  checkCallerUrl,
  checkSender,
  describeProviderAvailability,
  destinationMatchPatterns,
  resolveDestination,
  selectRequestHeaders,
  selectResponseHeaders,
} from "./policy";

describe("destination allowlist", () => {
  it("is exactly the five contract destinations and nothing else", () => {
    expect(BRIDGE_DESTINATIONS.map((destination) => destination.prefix)).toEqual([
      "https://auth.x.ai/oauth2/",
      "https://api.x.ai/v1/",
      "https://claude.ai/oauth/",
      "https://platform.claude.com/v1/oauth/",
      "https://api.anthropic.com/v1/",
    ]);
    expect(Object.isFrozen(BRIDGE_DESTINATIONS)).toBe(true);
  });

  it("accepts an allowlisted URL with a query string", () => {
    const resolved = resolveDestination("xai", "https://auth.x.ai/oauth2/token?x=1");
    expect(resolved).toMatchObject({ ok: true, url: "https://auth.x.ai/oauth2/token?x=1" });
  });

  it("accepts a percent-encoded query value, which cannot move the path", () => {
    // An OAuth `redirect_uri` carries `%2F` by construction. A separator filter
    // run over the whole URL refuses this exchange and blames the path for it.
    const authorize = "https://auth.x.ai/oauth2/authorize"
      + "?redirect_uri=https%3A%2F%2Fsirouk.github.io%2Fairship%2F&state=a%2Bb";
    expect(resolveDestination("xai", authorize)).toMatchObject({ ok: true, url: authorize });
  });

  it("refuses every path shape a decoding router could resolve off the prefix", () => {
    const refusals = [
      // Encoded separators, which normalisation preserves and a router decodes.
      "https://api.x.ai/v1/..%2f..%2fadmin",
      "https://api.x.ai/v1/%2e%2e%2fadmin",
      "https://api.x.ai/v1/..%5cadmin",
      // Double encoding: one decode away from spelling either of the above.
      "https://api.x.ai/v1/%252e%252e/admin",
      "https://api.x.ai/v1/%252f%252fadmin",
      // A path parameter a router strips, leaving the `..` behind it.
      "https://api.x.ai/v1/..;/admin",
      "https://api.x.ai/v1/chat;jsessionid=1/completions",
    ] as const;
    for (const path of refusals) {
      const resolved = resolveDestination("xai", path);
      expect(resolved, path).toMatchObject({ ok: false });
      // The reason must name the path, not the URL: the same refusal message
      // was previously produced for a legitimate encoded query value.
      expect(resolved.ok === false && resolved.message, path).toMatch(/path/u);
    }
  });

  it("refuses everything outside the compiled-in prefixes", () => {
    const refusals = [
      ["xai", "https://evil.example/oauth2/token"],
      ["xai", "https://auth.x.ai.evil.example/oauth2/token"],
      ["xai", "https://auth.x.ai/admin"],
      ["xai", "https://auth.x.ai/oauth2x/token"],
      ["xai", "http://auth.x.ai/oauth2/token"],
      ["xai", "https://auth.x.ai:8443/oauth2/token"],
      ["xai", "https://user:pass@auth.x.ai/oauth2/token"],
      ["xai", "https://auth.x.ai/oauth2/token#fragment"],
      ["xai", "https://auth.x.ai/oauth2/../admin"],
      ["xai", "https://auth.x.ai/oauth2/%2e%2e%2fadmin"],
      ["xai", "/oauth2/token"],
      ["anthropic", "https://api.x.ai/v1/chat/completions"],
    ] as const;
    for (const [provider, path] of refusals) {
      expect(resolveDestination(provider, path), path).toMatchObject({ ok: false });
    }
  });

  it("refuses a URL longer than the compiled-in ceiling", () => {
    const long = `https://api.x.ai/v1/${"a".repeat(BRIDGE_LIMITS.maxUrlLength)}`;
    expect(resolveDestination("xai", long)).toMatchObject({ ok: false });
  });

  it("derives host match patterns from the same list the relay enforces", () => {
    expect(destinationMatchPatterns()).toEqual([
      "https://auth.x.ai/oauth2/*",
      "https://api.x.ai/v1/*",
      "https://claude.ai/oauth/*",
      "https://platform.claude.com/v1/oauth/*",
      "https://api.anthropic.com/v1/*",
    ]);
  });
});

describe("request header allowlist", () => {
  it("forwards only protocol headers and reports what it dropped", () => {
    const selection = selectRequestHeaders({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      cookie: "session=1",
      "x-airship-secret": "no",
    });
    expect(selection).toMatchObject({
      ok: true,
      forwarded: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      dropped: ["cookie", "x-airship-secret"],
    });
  });

  it("carries user-agent out separately, because fetch silently ignores it", () => {
    expect(selectRequestHeaders({ "user-agent": "Mozilla/5.0", accept: "*/*" })).toMatchObject({
      ok: true,
      forwarded: { accept: "*/*" },
      userAgent: "Mozilla/5.0",
    });
    expect(FORWARDED_REQUEST_HEADERS).toContain("user-agent");
    // Absent rather than empty, so "the caller asked for one" stays decidable.
    expect(selectRequestHeaders({ accept: "*/*" })).not.toHaveProperty("userAgent");
  });

  it("refuses malformed names, injected values, repeats and oversized sets", () => {
    expect(selectRequestHeaders({ "bad header": "1" })).toMatchObject({ ok: false });
    expect(selectRequestHeaders({ accept: "text/event-stream\r\nx: 1" })).toMatchObject({ ok: false });
    expect(selectRequestHeaders({ accept: "café" })).toMatchObject({ ok: false });
    // A space is legal inside a header value: "Bearer token" depends on it.
    expect(selectRequestHeaders({ authorization: "Bearer a b" })).toMatchObject({ ok: true });
    expect(selectRequestHeaders({ Accept: "one", accept: "two" })).toMatchObject({ ok: false });
    const many = Object.fromEntries(
      Array.from({ length: BRIDGE_LIMITS.maxHeaderEntries + 1 }, (_value, index) => [`x-${index}`, "1"]),
    );
    expect(selectRequestHeaders(many)).toMatchObject({ ok: false });
  });
});

describe("response header allowlist", () => {
  it("returns only the named headers and never a cookie", () => {
    const headers = new Headers({
      "content-type": "text/event-stream",
      "retry-after": "30",
      "set-cookie": "session=1",
      "x-secret": "leak",
    });
    expect(selectResponseHeaders(headers)).toEqual({
      "content-type": "text/event-stream",
      "retry-after": "30",
    });
  });
});

describe("caller allowlist", () => {
  it("keeps loopback development origins out of the release channel", () => {
    expect(callerAllowlist("release")).toEqual(RELEASE_CALLERS);
    expect(callerMatchPatterns(callerAllowlist("release"))).toEqual(["https://sirouk.github.io/airship/*"]);
    expect(callerAllowlist("development")).toEqual(developmentCallers());
    expect(callerMatchPatterns(callerAllowlist("development"))).toContain("http://localhost:4173/*");
    // The compose deployment's documented local port is what a developer
    // actually reaches when the Docker image runs on their machine — the
    // bridge must not leave that whole class of local work unpaired.
    expect(callerMatchPatterns(callerAllowlist("development"))).toContain("http://localhost:8080/*");
    expect(callerMatchPatterns(callerAllowlist("development"))).toContain("http://127.0.0.1:8080/*");
  });

  it("accepts the Airship page and refuses every foreign caller", () => {
    const callers = callerAllowlist("release");
    expect(checkSender({ url: "https://sirouk.github.io/airship/index.html", frameId: 0 }, callers))
      .toEqual({ ok: true, origin: "https://sirouk.github.io" });

    const refusals = [
      { url: "https://evil.example/airship/" },
      // Same origin, different application on that origin.
      { url: "https://sirouk.github.io/other-project/" },
      // Protocol downgrade on the allowlisted host.
      { url: "http://sirouk.github.io/airship/" },
      // A subframe of an Airship page is a different document.
      { url: "https://sirouk.github.io/airship/", frameId: 3 },
      // The browser's reported origin must agree with the frame URL.
      { url: "https://sirouk.github.io/airship/", frameId: 0, origin: "https://evil.example" },
      { url: "not a url", frameId: 0 },
      {},
    ];
    for (const sender of refusals) {
      expect(checkSender(sender, callers), JSON.stringify(sender)).toMatchObject({ ok: false });
    }
  });

  it("refuses a sender whose browser never said which frame is talking", () => {
    // Silence is not evidence of a top frame. Accepting it would quietly reduce
    // the worker-side check to the content script's own window.top guard.
    const callers = callerAllowlist("release");
    const url = "https://sirouk.github.io/airship/index.html";
    expect(checkSender({ url }, callers)).toMatchObject({ ok: false });
    expect(checkSender({ url, frameId: Number.NaN }, callers)).toMatchObject({ ok: false });
    expect(checkSender({ url, frameId: 0 }, callers)).toMatchObject({ ok: true });
  });

  it("gives the content script the URL-only half of the same check", () => {
    // A content script has no frame id to offer; it proves the top frame with
    // window.top === window instead. Everything else must still agree.
    const callers = callerAllowlist("release");
    expect(checkCallerUrl("https://sirouk.github.io/airship/", callers))
      .toEqual({ ok: true, origin: "https://sirouk.github.io" });
    expect(checkCallerUrl("https://sirouk.github.io/other-project/", callers))
      .toMatchObject({ ok: false });
    expect(checkCallerUrl(undefined, callers)).toMatchObject({ ok: false });
  });

  it("accepts the loopback dev server only in a development build", () => {
    const sender = { url: "http://localhost:4173/", frameId: 0 };
    expect(checkSender(sender, callerAllowlist("development"))).toMatchObject({ ok: true });
    expect(checkSender(sender, callerAllowlist("release"))).toMatchObject({ ok: false });
  });
});

describe("provider availability", () => {
  it("claims a provider only when the runtime can actually carry it", () => {
    expect(describeProviderAvailability({ userAgentOverride: "live", hostAccess: "granted" }))
      .toEqual({ providers: ["xai", "anthropic"], unavailable: [] });

    const noOverride = describeProviderAvailability({
      userAgentOverride: "unavailable",
      hostAccess: "granted",
    });
    expect(noOverride.providers).toEqual(["xai"]);
    expect(noOverride.unavailable).toHaveLength(1);
    expect(noOverride.unavailable[0]?.reason).toMatch(/User-Agent/u);

    const noHosts = describeProviderAvailability({ userAgentOverride: "live", hostAccess: "missing" });
    expect(noHosts.providers).toEqual([]);
    expect(noHosts.unavailable.map((entry) => entry.provider)).toEqual(["xai", "anthropic"]);

    // An unobservable grant is not the same as a refused one.
    expect(describeProviderAvailability({ userAgentOverride: "live", hostAccess: "unknown" }).providers)
      .toEqual(["xai", "anthropic"]);
  });
});
