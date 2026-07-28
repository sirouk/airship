import { describe, expect, it, vi } from "vitest";
import {
  isBridgeDestination,
  type BridgeProviderId,
} from "../../inference/bridge/protocol";
import {
  ANTHROPIC_OAUTH,
  OPENAI_CODEX_OAUTH,
  PROVIDER_OAUTH_REGISTRATIONS,
  XAI_OAUTH,
} from "./registrations";
import {
  normalizeProviderTokenSet,
  providerTokenExpiry,
  refreshProviderToken,
  shouldRefreshProviderToken,
  type ProviderTokenSet,
} from "./token-set";
import {
  createDirectFetchTransport,
  isDirectFetchDestination,
  ProviderOAuthError,
  type OAuthHttpRequest,
  type OAuthHttpResponse,
  type ProviderOAuthTransport,
} from "./transport";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

function tokenSet(overrides: Partial<ProviderTokenSet> = {}): ProviderTokenSet {
  return Object.freeze({
    provider: "openai" as const,
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "Bearer" as const,
    scopes: Object.freeze([]),
    obtainedAt: NOW,
    expiresAt: NOW + 3_600_000,
    identityTokenPresent: false,
    ...overrides,
  });
}

describe("token normalization", () => {
  it("keeps only what the provider actually returned", () => {
    const normalized = normalizeProviderTokenSet({
      access_token: "openai-access-token",
      token_type: "bearer",
      expires_in: 900,
      id_token: "header.payload.signature",
      scope: "openid profile  not|a|scope  email",
    }, { provider: "openai", now: NOW });

    expect(normalized).toEqual({
      provider: "openai",
      accessToken: "openai-access-token",
      tokenType: "Bearer",
      // The unparseable entry is dropped: understating a grant is safe, claiming one
      // Airship could not validate is not.
      scopes: ["openid", "profile", "email"],
      obtainedAt: NOW,
      expiresAt: NOW + 900_000,
      identityTokenPresent: true,
    });
    // The id_token itself is never retained, only the fact that one arrived.
    expect(JSON.stringify(normalized)).not.toContain("header.payload.signature");
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.scopes)).toBe(true);
  });

  it("reports an absent lifetime as unknown rather than inventing one", () => {
    const normalized = normalizeProviderTokenSet(
      { access_token: "token", token_type: "Bearer" },
      { provider: "xai", now: NOW },
    );
    expect(normalized.expiresAt).toBeUndefined();
    expect(providerTokenExpiry(normalized, NOW + 10 * 24 * 3_600_000)).toEqual({ state: "unknown" });
    expect(shouldRefreshProviderToken(normalized, NOW + 10 * 24 * 3_600_000)).toBe(false);
  });

  it("refuses malformed or unsupported token responses", () => {
    const context = { provider: "openai" as const, now: NOW };
    expect(() => normalizeProviderTokenSet({ token_type: "Bearer" }, context))
      .toThrow("access token was missing or malformed");
    expect(() => normalizeProviderTokenSet({ access_token: "a b", token_type: "Bearer" }, context))
      .toThrow("access token was missing or malformed");
    expect(() => normalizeProviderTokenSet({ access_token: "t", token_type: "mac" }, context))
      .toThrow("unsupported token type");
    expect(() => normalizeProviderTokenSet(
      { access_token: "t", token_type: "Bearer", expires_in: 60 * 60 * 24 * 400 },
      context,
    )).toThrow("invalid lifetime");
    expect(() => normalizeProviderTokenSet(
      { access_token: "t", token_type: "Bearer", expires_in: "3600" },
      context,
    )).toThrow("invalid lifetime");
  });

  it("carries a refresh token forward only when the provider omitted a new one", () => {
    const carried = normalizeProviderTokenSet(
      { access_token: "t", token_type: "Bearer" },
      { provider: "openai", now: NOW, previousRefreshToken: "old-refresh" },
    );
    expect(carried.refreshToken).toBe("old-refresh");

    const rotated = normalizeProviderTokenSet(
      { access_token: "t", token_type: "Bearer", refresh_token: "new-refresh" },
      { provider: "openai", now: NOW, previousRefreshToken: "old-refresh" },
    );
    expect(rotated.refreshToken).toBe("new-refresh");
  });
});

describe("expiry honesty and refresh skew", () => {
  it("names each state and the distance to it", () => {
    expect(providerTokenExpiry(tokenSet(), NOW)).toEqual({ state: "valid", expiresInMs: 3_600_000 });
    expect(providerTokenExpiry(tokenSet(), NOW + 3_599_000))
      .toEqual({ state: "refresh-due", expiresInMs: 1_000 });
    expect(providerTokenExpiry(tokenSet(), NOW + 3_700_000))
      .toEqual({ state: "expired", expiredForMs: 100_000 });
    expect(providerTokenExpiry(tokenSet(), NOW + 3_500_000, 200_000))
      .toEqual({ state: "refresh-due", expiresInMs: 100_000 });
  });

  it("only asks for a refresh when one is possible and due", () => {
    expect(shouldRefreshProviderToken(tokenSet(), NOW)).toBe(false);
    expect(shouldRefreshProviderToken(tokenSet(), NOW + 3_599_000)).toBe(true);
    expect(shouldRefreshProviderToken(tokenSet({ refreshToken: undefined }), NOW + 3_700_000))
      .toBe(false);
  });

  it("rotates an access token and keeps a non-rotating refresh token usable", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      access_token: "next-access-token",
      token_type: "Bearer",
      expires_in: 3_600,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const refreshed = await refreshProviderToken({
      registration: OPENAI_CODEX_OAUTH,
      refreshToken: "openai-refresh-token",
      transport: createDirectFetchTransport({ fetch: fetchMock as unknown as typeof fetch }),
      now: NOW,
    });

    const sent = fetchMock.mock.calls[0]?.[1];
    if (!sent) throw new Error("fetch was never called");
    const body = new URLSearchParams(String(sent.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "openai-refresh-token",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
    expect(refreshed.accessToken).toBe("next-access-token");
    expect(refreshed.refreshToken).toBe("openai-refresh-token");
    expect(refreshed.expiresAt).toBe(NOW + 3_600_000);
  });
});

describe("token endpoint fallback", () => {
  function recordingBridge(
    handler: (request: OAuthHttpRequest, index: number) => Promise<OAuthHttpResponse>,
  ): Readonly<{ transport: ProviderOAuthTransport; urls: string[] }> {
    const urls: string[] = [];
    return {
      urls,
      transport: Object.freeze({
        id: "extension-bridge" as const,
        carries: ["anthropic" as const],
        request: async (request: OAuthHttpRequest) => {
          urls.push(request.url);
          return await handler(request, urls.length - 1);
        },
      }),
    };
  }

  /*
   * Every endpoint a registration lists has to be reachable by the transport
   * that registration declares. This is the assertion that was missing: an
   * earlier build listed `https://console.anthropic.com/v1/oauth/token` as an
   * Anthropic fallback that the bridge allowlist does not carry, and a test
   * written against a stub transport reported it as working. A stub cannot
   * prove reachability, so the real allowlists are the ones consulted here.
   */
  it("lists only endpoints the declared transport can actually reach", () => {
    for (const registration of PROVIDER_OAUTH_REGISTRATIONS) {
      expect(registration.tokenEndpoints.length).toBeGreaterThan(0);
      const endpoints = [
        ...registration.tokenEndpoints,
        ...(registration.grant === "device-code" ? [registration.deviceAuthorizationEndpoint] : []),
      ];
      for (const endpoint of endpoints) {
        if (registration.transport.kind === "extension-bridge") {
          expect(
            isBridgeDestination(registration.provider as BridgeProviderId, endpoint),
            `${endpoint} must be a bridge destination`,
          ).toBe(true);
        } else {
          expect(
            isDirectFetchDestination(registration.provider, endpoint),
            `${endpoint} must be a direct-fetch destination`,
          ).toBe(true);
        }
      }
    }
  });

  /*
   * The multi-endpoint machinery is still real and still has to be correct, so
   * it is exercised against a registration this test constructs. Nothing that
   * ships has a second endpoint — the assertion above is what keeps that true —
   * and this one deliberately does not imply otherwise.
   */
  it("moves to a second endpoint only when the first is unreachable", async () => {
    const twoEndpoints = Object.freeze({
      ...ANTHROPIC_OAUTH,
      tokenEndpoints: Object.freeze([
        "https://platform.claude.com/v1/oauth/token",
        "https://claude.ai/oauth/token",
      ]),
    });
    const { transport, urls } = recordingBridge(async (_request, index) => {
      if (index === 0) {
        throw new ProviderOAuthError({
          code: "network",
          provider: "anthropic",
          message: "unreachable",
        });
      }
      return Object.freeze({
        status: 200,
        body: JSON.stringify({ access_token: "t", token_type: "Bearer", expires_in: 60 }),
      });
    });

    const refreshed = await refreshProviderToken({
      registration: twoEndpoints,
      refreshToken: "anthropic-refresh-token",
      transport,
      now: NOW,
    });

    expect(urls).toEqual([
      "https://platform.claude.com/v1/oauth/token",
      "https://claude.ai/oauth/token",
    ]);
    expect(refreshed.accessToken).toBe("t");
  });

  it("never replays a rejected grant against another host", async () => {
    const { transport, urls } = recordingBridge(async () => Object.freeze({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    }));

    const failure = await refreshProviderToken({
      registration: ANTHROPIC_OAUTH,
      refreshToken: "anthropic-refresh-token",
      transport,
      now: NOW,
    }).catch((error: unknown) => error);

    expect(urls).toEqual(["https://platform.claude.com/v1/oauth/token"]);
    expect((failure as ProviderOAuthError).providerCode).toBe("invalid_grant");
  });
});

describe("the direct fetch transport", () => {
  it("carries only the provider whose CORS behaviour was measured", async () => {
    const transport = createDirectFetchTransport({ fetch: (async () => new Response("{}")) as typeof fetch });
    expect(transport.carries).toEqual(["openai"]);
    await expect(refreshProviderToken({
      registration: XAI_OAUTH,
      refreshToken: "xai-refresh-token",
      transport,
    })).rejects.toMatchObject({ code: "transport-unavailable" });
  });

  it("fetches only its compiled-in destinations, never whatever URL it is handed", async () => {
    /*
     * `requireTransportFor` answers "may this transport carry OpenAI?", which is
     * not a bound on where bytes go. Without a URL bound the only thing between
     * a caller bug and an arbitrary cross-origin POST is the deployed page's
     * CSP, which is a deployment fact rather than a property of this module.
     */
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));
    const transport = createDirectFetchTransport({ fetch: fetchMock as unknown as typeof fetch });
    for (const url of [
      "https://evil.test/collect",
      "http://auth.openai.com/oauth/token",
      // Textually inside the prefix, resolves outside it.
      "https://auth.openai.com/oauth/../../evil",
      // An escape `new URL` leaves alone but the origin's router may decode.
      "https://auth.openai.com/oauth/..%2f..%2fevil",
      "https://auth.openai.com/oauth/token;x=1",
      // The right host but not the OAuth path this build reaches.
      "https://auth.openai.com/internal/whoami",
    ]) {
      await expect(transport.request({
        provider: "openai" as const,
        url,
        method: "POST",
        headers: {},
        maxResponseBytes: 1_024,
        timeoutMs: 1_000,
      })).rejects.toMatchObject({ code: "configuration", provider: "openai" });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // A provider cannot borrow another provider's endpoint either.
    expect(isDirectFetchDestination("anthropic", "https://auth.openai.com/oauth/token")).toBe(false);
    expect(isDirectFetchDestination("openai", "https://auth.openai.com/oauth/token")).toBe(true);
  });

  it("bounds a declared and an undeclared oversized response", async () => {
    const declared = createDirectFetchTransport({
      fetch: (async () => new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "99999999" },
      })) as typeof fetch,
    });
    await expect(declared.request({
      provider: "openai" as const,
      url: "https://auth.openai.com/oauth/token",
      method: "POST",
      headers: {},
      maxResponseBytes: 1_024,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "response-too-large" });

    const streamed = createDirectFetchTransport({
      fetch: (async () => new Response("x".repeat(4_096))) as typeof fetch,
    });
    await expect(streamed.request({
      provider: "openai" as const,
      url: "https://auth.openai.com/oauth/token",
      method: "POST",
      headers: {},
      maxResponseBytes: 512,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "response-too-large" });
  });

  it("reports a non-JSON answer as an invalid response, not as a token", async () => {
    const transport = createDirectFetchTransport({
      fetch: (async () => new Response("<html>gateway error</html>", { status: 502 })) as typeof fetch,
    });
    await expect(refreshProviderToken({
      registration: OPENAI_CODEX_OAUTH,
      refreshToken: "openai-refresh-token",
      transport,
      now: NOW,
    })).rejects.toMatchObject({ code: "invalid-response", status: 502 });
  });

  it("refuses an oversized request body before it is sent", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));
    const transport = createDirectFetchTransport({ fetch: fetchMock as unknown as typeof fetch });
    await expect(transport.request({
      provider: "openai" as const,
      url: "https://auth.openai.com/oauth/token",
      method: "POST",
      headers: {},
      body: "x".repeat(9_000),
      maxResponseBytes: 1_024,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "configuration" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
