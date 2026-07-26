import { describe, expect, it, vi } from "vitest";
import {
  CHUTES_LOCAL_REGISTRATION,
  chutesOAuthLocationState,
  consumeChutesAuthorizationCallback,
  createChutesAuthorizationRequest,
  exchangeChutesAuthorizationCode,
  requireLocalChutesOAuthBridge,
  refreshChutesOAuthToken,
  resolveChutesOAuthRegistration,
  revokeChutesToken,
} from "./chutes-oauth";

describe("Chutes OAuth PKCE preparation", () => {
  it("checks the confidential loopback bridge before leaving for authorization", async () => {
    const readyFetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(requireLocalChutesOAuthBridge(readyFetch)).resolves.toBeUndefined();
    expect(readyFetch).toHaveBeenCalledWith("/__airship/chutes/oauth/token", expect.objectContaining({ method: "GET", cache: "no-store" }));

    await expect(requireLocalChutesOAuthBridge(vi.fn(async () => new Response(
      JSON.stringify({ error: "local_bridge_unconfigured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )))).rejects.toThrow("process-held client secret");
  });

  it("builds an S256 authorization request with only the registered least-privilege scopes", async () => {
    const request = await createChutesAuthorizationRequest({ clientId: "cid_airship", now: 1_000 });
    expect(request.url.origin + request.url.pathname).toBe("https://api.chutes.ai/idp/authorize");
    expect(request.url.searchParams.get("redirect_uri")).toBe(CHUTES_LOCAL_REGISTRATION.redirectUris[0]);
    expect(request.url.searchParams.get("scope")).toBe("openid profile chutes:invoke billing:read");
    expect(CHUTES_LOCAL_REGISTRATION.registrationScopes).toEqual(["profile", "chutes:invoke", "billing:read"]);
    expect(CHUTES_LOCAL_REGISTRATION.tokenEndpointAuthMethod).toBe("client_secret_post");
    expect(CHUTES_LOCAL_REGISTRATION.public).toBe(false);
    expect(request.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(request.url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(request.attempt.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/u);
  });

  it("accepts one fresh callback and returns the verifier for the public-client exchanger", () => {
    const attempt = {
      state: "correct-state",
      verifier: "verifier",
      redirectUri: CHUTES_LOCAL_REGISTRATION.redirectUris[0],
      createdAt: 10_000,
    };
    expect(consumeChutesAuthorizationCallback({
      search: "?code=temporary-code&state=correct-state",
      attempt,
      now: 11_000,
    })).toEqual({ code: "temporary-code", verifier: "verifier", redirectUri: attempt.redirectUri });
  });

  it("fails closed for mismatched, expired, or error callbacks", () => {
    const attempt = {
      state: "correct-state",
      verifier: "verifier",
      redirectUri: CHUTES_LOCAL_REGISTRATION.redirectUris[0],
      createdAt: 10_000,
    };
    expect(() => consumeChutesAuthorizationCallback({ search: "?code=x&state=wrong", attempt, now: 11_000 }))
      .toThrow("state did not match");
    expect(() => consumeChutesAuthorizationCallback({ search: "?code=x&state=correct-state", attempt, now: 700_001 }))
      .toThrow("expired");
    expect(() => consumeChutesAuthorizationCallback({ search: "?error=access_denied", attempt, now: 11_000 }))
      .toThrow("authorization failed");
  });

  it("rejects non-HTTPS non-localhost callbacks", async () => {
    await expect(createChutesAuthorizationRequest({
      clientId: "cid_airship",
      redirectUri: "http://example.com/auth/chutes/callback",
    })).rejects.toThrow("must use HTTPS");
  });

  it("builds a secretless production registration only from an exact HTTPS origin", () => {
    const registration = resolveChutesOAuthRegistration({
      development: false,
      publicClientId: "cid_public_browser",
      publicOrigin: "https://airship.example",
    });
    expect(registration).toMatchObject({
      configured: true,
      public: true,
      tokenEndpointAuthMethod: "none",
      homepageUrl: "https://airship.example",
      redirectUris: ["https://airship.example/auth/chutes/callback"],
    });
  });

  it("keeps a production PKCE registration and location check inside its non-root deployment", () => {
    const registration = resolveChutesOAuthRegistration({
      development: false,
      publicClientId: "cid_public_browser",
      publicOrigin: "https://edge.example",
      publicBasePath: "/airship/",
    });
    expect(registration).toMatchObject({
      configured: true,
      homepageUrl: "https://edge.example/airship/",
      redirectUris: ["https://edge.example/airship/auth/chutes/callback"],
    });
    expect(chutesOAuthLocationState(registration.homepageUrl, "https://edge.example/airship/#connection"))
      .toEqual({ available: true });
    expect(chutesOAuthLocationState(registration.homepageUrl, "https://edge.example/sibling/#connection"))
      .toMatchObject({ available: false });
  });

  it("fails a static release closed when public PKCE build configuration is absent or ambiguous", () => {
    expect(resolveChutesOAuthRegistration({ development: false })).toMatchObject({
      configured: false,
      public: true,
      configurationError: expect.stringContaining("disabled"),
    });
    expect(resolveChutesOAuthRegistration({
      development: false,
      publicClientId: "cid_public_browser",
      publicOrigin: "https://airship.example/path",
    }).configured).toBe(false);
  });

  it("rejects an HTTPS callback that is not an exact registered Airship redirect", async () => {
    await expect(createChutesAuthorizationRequest({
      clientId: "cid_airship",
      redirectUri: "https://attacker.example/auth/chutes/callback",
    })).rejects.toThrow("not an exact registered Airship callback");
    await expect(createChutesAuthorizationRequest({
      clientId: "cid_airship",
      redirectUri: `${CHUTES_LOCAL_REGISTRATION.redirectUris[0]}/extra`,
    })).rejects.toThrow("not an exact registered Airship callback");
  });

  it("exchanges a public-client code with PKCE and never sends a client secret", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const tokenSet = await exchangeChutesAuthorizationCode({
      clientId: "cid_airship",
      callback: {
        code: "one-time-code",
        verifier: "v".repeat(64),
        redirectUri: CHUTES_LOCAL_REGISTRATION.redirectUris[0],
      },
      now: 10_000,
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json({
          access_token: "cak_test.access",
          refresh_token: "crt_test.refresh",
          token_type: "Bearer",
          expires_in: 3_600,
          scope: "openid profile chutes:invoke billing:read",
        });
      },
    });

    expect(requestUrl).toBe("https://api.chutes.ai/idp/token");
    expect(requestInit?.credentials).toBe("omit");
    expect(requestInit?.redirect).toBe("error");
    expect(requestInit?.referrerPolicy).toBe("no-referrer");
    const body = new URLSearchParams(String(requestInit?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("cid_airship");
    expect(body.get("code_verifier")).toBe("v".repeat(64));
    expect(body.has("client_secret")).toBe(false);
    expect(tokenSet).toEqual({
      accessToken: "cak_test.access",
      refreshToken: "crt_test.refresh",
      expiresAt: 3_610_000,
      scopes: ["openid", "profile", "chutes:invoke", "billing:read"],
    });
  });

  it("rotates a public refresh token without sending a client secret", async () => {
    let requestInit: RequestInit | undefined;
    const tokenSet = await refreshChutesOAuthToken({
      clientId: "cid_airship",
      refreshToken: "crt_old.refresh",
      now: 20_000,
      fetch: async (_input, init) => {
        requestInit = init;
        return Response.json({
          access_token: "cak_new.access",
          refresh_token: "crt_new.refresh",
          token_type: "bearer",
          expires_in: 60,
          scope: "profile chutes:invoke billing:read",
        });
      },
    });

    const body = new URLSearchParams(String(requestInit?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("crt_old.refresh");
    expect(body.has("client_secret")).toBe(false);
    expect(tokenSet.refreshToken).toBe("crt_new.refresh");
    expect(tokenSet.expiresAt).toBe(80_000);
  });

  it("bounds token responses and never reflects provider credential text", async () => {
    const callback = {
      code: "one-time-code",
      verifier: "v".repeat(64),
      redirectUri: CHUTES_LOCAL_REGISTRATION.redirectUris[0],
    };
    const leaked = "cak_provider-must-not-be-reflected";
    await expect(exchangeChutesAuthorizationCode({
      clientId: "cid_airship",
      callback,
      fetch: async () => Response.json(
        { error: "invalid_grant", error_description: leaked },
        { status: 400 },
      ),
    })).rejects.not.toThrow(leaked);

    await expect(exchangeChutesAuthorizationCode({
      clientId: "cid_airship",
      callback,
      fetch: async () => new Response("x", { headers: { "content-length": "32769" } }),
    })).rejects.toThrow("safety limit");

    await expect(exchangeChutesAuthorizationCode({
      clientId: "cid_airship",
      callback,
      fetch: async () => new Response("{}", { headers: { "content-length": "not-a-number" } }),
    })).rejects.toThrow("invalid length");
  });

  it("rejects prefix-only access and refresh token placeholders", async () => {
    const callback = {
      code: "one-time-code",
      verifier: "v".repeat(64),
      redirectUri: CHUTES_LOCAL_REGISTRATION.redirectUris[0],
    };
    await expect(exchangeChutesAuthorizationCode({
      clientId: "cid_airship",
      callback,
      fetch: async () => Response.json({
        access_token: "cak_",
        refresh_token: "crt_valid.refresh",
        token_type: "Bearer",
        expires_in: 60,
        scope: "profile chutes:invoke billing:read",
      }),
    })).rejects.toThrow("invalid access token");

    await expect(exchangeChutesAuthorizationCode({
      clientId: "cid_airship",
      callback,
      fetch: async () => Response.json({
        access_token: "cak_valid.access",
        refresh_token: "crt_",
        token_type: "Bearer",
        expires_in: 60,
        scope: "profile chutes:invoke billing:read",
      }),
    })).rejects.toThrow("invalid refresh token");
  });

  it("reports an HTML gateway failure by status instead of calling it invalid JSON", async () => {
    await expect(exchangeChutesAuthorizationCode({
      clientId: "cid_airship",
      callback: {
        code: "one-time-code",
        verifier: "v".repeat(64),
        redirectUri: CHUTES_LOCAL_REGISTRATION.redirectUris[0],
      },
      fetch: async () => new Response("<h1>502 Bad Gateway</h1>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    })).rejects.toThrow("token request failed with HTTP 502");
  });

  it("bounds a token exchange even when fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    try {
      const exchange = exchangeChutesAuthorizationCode({
        clientId: "cid_airship",
        callback: {
          code: "one-time-code",
          verifier: "v".repeat(64),
          redirectUri: CHUTES_LOCAL_REGISTRATION.redirectUris[0],
        },
        fetch: async (_input, init) => {
          requestSignal = init?.signal;
          return await new Promise<Response>(() => undefined);
        },
      });
      const rejection = expect(exchange).rejects.toThrow("token request timed out");

      await vi.advanceTimersByTimeAsync(20_000);

      await rejection;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when consent omits a required scope or refresh rotation is absent", async () => {
    const callback = {
      code: "one-time-code",
      verifier: "v".repeat(64),
      redirectUri: CHUTES_LOCAL_REGISTRATION.redirectUris[0],
    };
    await expect(exchangeChutesAuthorizationCode({
      clientId: "cid_airship",
      callback,
      fetch: async () => Response.json({
        access_token: "cak_partial.access",
        refresh_token: "crt_partial.refresh",
        token_type: "Bearer",
        expires_in: 60,
        scope: "profile chutes:invoke",
      }),
    })).rejects.toThrow("billing:read");

    await expect(refreshChutesOAuthToken({
      clientId: "cid_airship",
      refreshToken: "crt_old.refresh",
      fetch: async () => Response.json({
        access_token: "cak_new.access",
        token_type: "Bearer",
        expires_in: 60,
        scope: "profile chutes:invoke billing:read",
      }),
    })).rejects.toThrow("did not rotate");
  });
});

describe("Chutes OAuth revocation", () => {
  it("posts only the RFC 7009 fields to the published revocation endpoint", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => new Response(
      JSON.stringify({ revoked: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(revokeChutesToken({
      token: "crt_released.refresh",
      tokenTypeHint: "refresh_token",
      clientId: "cid_airship",
      fetch: fetchImpl,
    })).resolves.toEqual({ state: "accepted", status: 200 });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.chutes.ai/idp/token/revoke");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect([...new URLSearchParams(String(init?.body)).entries()].sort()).toEqual([
      ["client_id", "cid_airship"],
      ["token", "crt_released.refresh"],
      ["token_type_hint", "refresh_token"],
    ]);
  });

  it("never transmits a credential that fails the token guards", async () => {
    const fetchImpl = vi.fn();
    await expect(revokeChutesToken({
      token: "cak_wrong.class",
      tokenTypeHint: "refresh_token",
      clientId: "cid_airship",
      fetch: fetchImpl,
    })).rejects.toThrow("invalid refresh token");
    await expect(revokeChutesToken({
      token: "crt_ok.refresh",
      tokenTypeHint: "refresh_token",
      clientId: "not-a-client",
      fetch: fetchImpl,
    })).rejects.toThrow("client ID is invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a refused or unreachable provider instead of claiming the grant is gone", async () => {
    await expect(revokeChutesToken({
      token: "cak_released.access",
      tokenTypeHint: "access_token",
      clientId: "cid_airship",
      fetch: async () => new Response("no", { status: 401 }),
    })).resolves.toEqual({ state: "rejected", status: 401 });

    await expect(revokeChutesToken({
      token: "cak_released.access",
      tokenTypeHint: "access_token",
      clientId: "cid_airship",
      fetch: async () => { throw new TypeError("Failed to fetch"); },
    })).resolves.toEqual({ state: "unreachable", reason: "network" });
  });

  it("bounds a revocation that the provider never answers", async () => {
    vi.useFakeTimers();
    try {
      const revocation = revokeChutesToken({
        token: "crt_released.refresh",
        tokenTypeHint: "refresh_token",
        clientId: "cid_airship",
        fetch: async () => await new Promise<Response>(() => undefined),
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(revocation).resolves.toEqual({ state: "unreachable", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
