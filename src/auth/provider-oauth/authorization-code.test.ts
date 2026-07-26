import { describe, expect, it, vi } from "vitest";
import {
  consumeProviderAuthorizationCode,
  createProviderAuthorizationRequest,
  exchangeProviderAuthorizationCode,
  parsePastedAuthorizationCode,
} from "./authorization-code";
import { ANTHROPIC_OAUTH, OPENAI_CODEX_OAUTH } from "./registrations";
import { createDirectFetchTransport, ProviderOAuthError } from "./transport";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

/** A `fetch` stand-in that keeps the real signature, so the sent request is inspectable. */
function fetchStub(reply: () => Response): FetchMock {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => reply());
}

function requestInit(fetchMock: FetchMock): RequestInit {
  const init = fetchMock.mock.calls[0]?.[1];
  if (!init) throw new Error("fetch was never called");
  return init;
}

function requestBody(fetchMock: FetchMock): URLSearchParams {
  return new URLSearchParams(String(requestInit(fetchMock).body));
}

describe("provider authorization-code + PKCE requests", () => {
  it("builds an S256 Codex authorization URL from the approved registration", async () => {
    const request = await createProviderAuthorizationRequest({
      registration: OPENAI_CODEX_OAUTH,
      now: NOW,
    });

    expect(request.url.origin + request.url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(request.url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(request.url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(request.url.searchParams.get("response_type")).toBe("code");
    expect(request.url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(request.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(request.attempt.provider).toBe("openai");
    expect(request.attempt.createdAt).toBe(NOW);

    // The challenge must be the real SHA-256 of the verifier, not a placeholder.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(request.attempt.verifier),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    expect(request.url.searchParams.get("code_challenge")).toBe(expected);
    expect(request.attempt.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(request.attempt.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("carries the provider's own authorize parameters and never repeats a state", async () => {
    const anthropic = await createProviderAuthorizationRequest({
      registration: ANTHROPIC_OAUTH,
      now: NOW,
    });
    expect(anthropic.url.searchParams.get("code")).toBe("true");
    expect(anthropic.url.searchParams.get("redirect_uri"))
      .toBe("https://console.anthropic.com/oauth/code/callback");
    expect(anthropic.url.searchParams.get("scope"))
      .toBe("org:create_api_key user:profile user:inference");

    const first = await createProviderAuthorizationRequest({ registration: OPENAI_CODEX_OAUTH });
    const second = await createProviderAuthorizationRequest({ registration: OPENAI_CODEX_OAUTH });
    expect(first.attempt.state).not.toBe(second.attempt.state);
    expect(first.attempt.verifier).not.toBe(second.attempt.verifier);
  });

  it("fails closed when Web Crypto is unavailable", async () => {
    await expect(createProviderAuthorizationRequest({
      registration: OPENAI_CODEX_OAUTH,
      crypto: {} as Crypto,
    })).rejects.toMatchObject({ code: "configuration" });
    await expect(createProviderAuthorizationRequest({
      registration: OPENAI_CODEX_OAUTH,
      crypto: { getRandomValues: crypto.getRandomValues.bind(crypto) } as Crypto,
    })).rejects.toThrow("Web Crypto is required");
  });
});

describe("pasted authorization codes", () => {
  it("accepts every shape a user can plausibly paste back", () => {
    expect(parsePastedAuthorizationCode(
      "http://localhost:1455/auth/callback?code=ac_live-code&state=state-value",
      "openai",
    )).toEqual({
      code: "ac_live-code",
      state: "state-value",
      source: "redirect-url",
      // Recorded so `consumeProviderAuthorizationCode` can compare it with the
      // registered callback; the parser has no registration to compare against.
      callbackUri: "http://localhost:1455/auth/callback",
    });

    expect(parsePastedAuthorizationCode("  ac_live-code  ", "openai"))
      .toEqual({ code: "ac_live-code", source: "bare-code" });

    expect(parsePastedAuthorizationCode("?code=ac_live-code&state=state-value", "openai"))
      .toEqual({ code: "ac_live-code", state: "state-value", source: "query-fragment" });

    // Anthropic's console renders the code and state joined by a `#`.
    expect(parsePastedAuthorizationCode("ac_live-code#state-value", "anthropic"))
      .toEqual({ code: "ac_live-code", state: "state-value", source: "code-and-state" });

    expect(parsePastedAuthorizationCode(
      "https://console.anthropic.com/oauth/code/callback#code=ac_live-code&state=state-value",
      "anthropic",
    )).toEqual({
      code: "ac_live-code",
      state: "state-value",
      source: "redirect-url",
      callbackUri: "https://console.anthropic.com/oauth/code/callback",
    });
  });

  it("refuses unusable pastes and surfaces a provider error instead of guessing", () => {
    expect(() => parsePastedAuthorizationCode("", "openai")).toThrow(ProviderOAuthError);
    expect(() => parsePastedAuthorizationCode("   ", "openai"))
      .toThrow("no value was pasted");
    expect(() => parsePastedAuthorizationCode("http://localhost:1455/auth/callback", "openai"))
      .toThrow("contains no authorization code");
    expect(() => parsePastedAuthorizationCode("a".repeat(9_000), "openai"))
      .toThrow("too long");
    expect(() => parsePastedAuthorizationCode("code with spaces", "openai"))
      .toThrow("not in a usable format");
    try {
      parsePastedAuthorizationCode(
        "http://localhost:1455/auth/callback?error=access_denied",
        "openai",
      );
      expect.unreachable("an error redirect must not parse as a code");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderOAuthError);
      expect((error as ProviderOAuthError).code).toBe("provider-error");
      expect((error as ProviderOAuthError).providerCode).toBe("access_denied");
    }
  });

  it("never quotes the pasted value back, because it is a one-time code", () => {
    try {
      parsePastedAuthorizationCode("secret code value", "openai");
      expect.unreachable("a code with spaces must be refused");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret code value");
    }
  });
});

describe("binding a pasted code to its attempt", () => {
  const attempt = Object.freeze({
    provider: "openai" as const,
    state: "state-value-0123456789",
    verifier: "v".repeat(43),
    redirectUri: "http://localhost:1455/auth/callback",
    createdAt: NOW,
  });

  it("verifies state when one was supplied and says so when none was", () => {
    const withState = consumeProviderAuthorizationCode({
      registration: OPENAI_CODEX_OAUTH,
      attempt,
      pasted: `http://localhost:1455/auth/callback?code=ac_code&state=${attempt.state}`,
      now: NOW + 5_000,
    });
    expect(withState).toMatchObject({ code: "ac_code", stateVerified: true, verifier: attempt.verifier });

    const bare = consumeProviderAuthorizationCode({
      registration: OPENAI_CODEX_OAUTH,
      attempt,
      pasted: "ac_code",
      now: NOW + 5_000,
    });
    expect(bare.stateVerified).toBe(false);
    expect(bare.state).toBe(attempt.state);
  });

  it("fails closed on a mismatched state, a stale attempt, or the wrong provider", () => {
    expect(() => consumeProviderAuthorizationCode({
      registration: OPENAI_CODEX_OAUTH,
      attempt,
      pasted: "http://localhost:1455/auth/callback?code=ac_code&state=someone-elses-state",
      now: NOW + 5_000,
    })).toThrow("state did not match");

    expect(() => consumeProviderAuthorizationCode({
      registration: OPENAI_CODEX_OAUTH,
      attempt,
      pasted: "ac_code",
      now: NOW + 16 * 60 * 1_000,
    })).toThrow("expired");

    expect(() => consumeProviderAuthorizationCode({
      registration: ANTHROPIC_OAUTH,
      attempt,
      pasted: "ac_code",
      now: NOW + 5_000,
    })).toThrow("different provider");
  });

  it("refuses a whole address that is not the registered callback", () => {
    /*
     * PKCE and the state comparison make a foreign code useless, but only after
     * it has been sent to the token endpoint. Comparing the pasted address with
     * the registered callback stops the paste before that, which is what makes
     * a look-alike sign-in page pointless rather than merely unprofitable.
     */
    expect(() => consumeProviderAuthorizationCode({
      registration: OPENAI_CODEX_OAUTH,
      attempt,
      pasted: `https://openai-auth.evil.test/auth/callback?code=ac_code&state=${attempt.state}`,
      now: NOW + 5_000,
    })).toThrow("not the registered Codex callback");

    // Right host, wrong path is refused too: the callback is a whole address.
    expect(() => consumeProviderAuthorizationCode({
      registration: OPENAI_CODEX_OAUTH,
      attempt,
      pasted: `http://localhost:1455/other/callback?code=ac_code&state=${attempt.state}`,
      now: NOW + 5_000,
    })).toThrow("not the registered Codex callback");

    // A caller that parsed separately cannot skip the comparison.
    expect(() => consumeProviderAuthorizationCode({
      registration: OPENAI_CODEX_OAUTH,
      attempt,
      pasted: Object.freeze({ code: "ac_code", source: "redirect-url" as const }),
      now: NOW + 5_000,
    })).toThrow("not the registered Codex callback");

    // The refusal never repeats the address, because it carries the code.
    try {
      consumeProviderAuthorizationCode({
        registration: OPENAI_CODEX_OAUTH,
        attempt,
        pasted: `https://openai-auth.evil.test/auth/callback?code=ac_code&state=${attempt.state}`,
        now: NOW + 5_000,
      });
      expect.unreachable("a foreign callback must be refused");
    } catch (error) {
      expect((error as Error).message).not.toContain("ac_code");
      expect((error as Error).message).not.toContain("evil.test");
    }
  });
});

describe("OpenAI token exchange, directly from the page", () => {
  const authorization = Object.freeze({
    provider: "openai" as const,
    code: "ac_live-code",
    verifier: "v".repeat(43),
    redirectUri: "http://localhost:1455/auth/callback",
    state: "state-value-0123456789",
    stateVerified: true,
  });

  it("posts the PKCE form to auth.openai.com with plain fetch and no ambient credentials", async () => {
    const fetchMock = fetchStub(() => jsonResponse({
      access_token: "openai-access-token",
      refresh_token: "openai-refresh-token",
      id_token: "header.payload.signature",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "openid profile email offline_access",
    }));

    const tokenSet = await exchangeProviderAuthorizationCode({
      registration: OPENAI_CODEX_OAUTH,
      authorization,
      transport: createDirectFetchTransport({ fetch: fetchMock as unknown as typeof fetch }),
      now: NOW,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://auth.openai.com/oauth/token");
    const init = requestInit(fetchMock);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");

    const body = requestBody(fetchMock);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "ac_live-code",
      redirect_uri: "http://localhost:1455/auth/callback",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code_verifier: "v".repeat(43),
    });

    expect(tokenSet).toEqual({
      provider: "openai",
      accessToken: "openai-access-token",
      refreshToken: "openai-refresh-token",
      tokenType: "Bearer",
      scopes: ["openid", "profile", "email", "offline_access"],
      obtainedAt: NOW,
      expiresAt: NOW + 3_600_000,
      identityTokenPresent: true,
    });
  });

  it("reports a rejected code without leaking the code or the provider's description", async () => {
    const fetchMock = fetchStub(() => jsonResponse({
      error: "invalid_grant",
      error_description: "code ac_live-code was already redeemed",
    }, 400));

    const failure = await exchangeProviderAuthorizationCode({
      registration: OPENAI_CODEX_OAUTH,
      authorization,
      transport: createDirectFetchTransport({ fetch: fetchMock as unknown as typeof fetch }),
      now: NOW,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderOAuthError);
    const error = failure as ProviderOAuthError;
    expect(error.code).toBe("provider-error");
    expect(error.status).toBe(400);
    expect(error.providerCode).toBe("invalid_grant");
    expect(error.message).toContain("Codex");
    expect(error.message).not.toContain("ac_live-code");
    expect(error.message).not.toContain("already redeemed");
  });

  it("turns an unreachable endpoint into a named network failure, never a silent retry", async () => {
    const fetchMock = fetchStub(() => { throw new TypeError("Failed to fetch"); });
    const failure = await exchangeProviderAuthorizationCode({
      registration: OPENAI_CODEX_OAUTH,
      authorization,
      transport: createDirectFetchTransport({ fetch: fetchMock as unknown as typeof fetch }),
      now: NOW,
    }).catch((error: unknown) => error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((failure as ProviderOAuthError).code).toBe("network");
  });
});

describe("Anthropic token exchange", () => {
  const authorization = Object.freeze({
    provider: "anthropic" as const,
    code: "ac_live-code",
    verifier: "v".repeat(43),
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    state: "state-value-0123456789",
    stateVerified: true,
  });

  it("refuses to run over the direct transport and names the extension as the cause", async () => {
    const fetchMock = fetchStub(() => jsonResponse({ access_token: "never" }));
    const failure = await exchangeProviderAuthorizationCode({
      registration: ANTHROPIC_OAUTH,
      authorization,
      transport: createDirectFetchTransport({ fetch: fetchMock as unknown as typeof fetch }),
      now: NOW,
    }).catch((error: unknown) => error);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((failure as ProviderOAuthError).code).toBe("transport-unavailable");
    expect((failure as ProviderOAuthError).message).toContain("extension");
    expect((failure as ProviderOAuthError).message).toContain("User-Agent");
  });

  it("echoes state and the measured user-agent when a bridge carries it", async () => {
    const requests: unknown[] = [];
    const bridge = Object.freeze({
      id: "extension-bridge" as const,
      carries: ["anthropic" as const],
      request: async (request: unknown) => {
        requests.push(request);
        return Object.freeze({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            access_token: "anthropic-access-token",
            token_type: "Bearer",
            expires_in: 28_800,
            scope: "user:inference user:profile",
          }),
        });
      },
    });

    const tokenSet = await exchangeProviderAuthorizationCode({
      registration: ANTHROPIC_OAUTH,
      authorization,
      transport: bridge,
      now: NOW,
    });

    const sent = requests[0] as { url: string; headers: Record<string, string>; body: string };
    expect(sent.url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(sent.headers["user-agent"]).toBe("axios/1.7.9");
    expect(Object.fromEntries(new URLSearchParams(sent.body)).state).toBe("state-value-0123456789");
    expect(tokenSet.scopes).toEqual(["user:inference", "user:profile"]);
    expect(tokenSet.refreshToken).toBeUndefined();
  });
});
