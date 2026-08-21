import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_ACCOUNT_SCOPES,
  GOOGLE_DRIVE_FILE_SCOPE,
  GoogleDriveAuthorizationRequiredError,
  GoogleIdentityServicesAuthorizer,
  MemoryOnlyGoogleAccessTokenProvider,
  isDeployableGoogleOAuthClientId,
  readGoogleAccountIdentity,
} from "./google-drive-auth";

describe("deployment configuration for the Google Drive vault", () => {
  it("accepts exactly the client IDs the authorizer will construct with", () => {
    const configured = "123456789012-airship-browser-acceptance.apps.googleusercontent.com";
    expect(isDeployableGoogleOAuthClientId(configured)).toBe(true);
    expect(isDeployableGoogleOAuthClientId(` ${configured} `)).toBe(true);
    expect(() => new GoogleIdentityServicesAuthorizer(configured, new MemoryOnlyGoogleAccessTokenProvider())).not.toThrow();
  });

  it("sends the trimmed client ID it accepted, never the padded build-time value", async () => {
    const configured = "123456789012-airship-browser-acceptance.apps.googleusercontent.com";
    let sentClientId: string | undefined;
    const authorizer = new GoogleIdentityServicesAuthorizer(
      `\n ${configured}  `,
      new MemoryOnlyGoogleAccessTokenProvider(),
      async () => ({ accounts: { oauth2: { initTokenClient: (options) => {
        sentClientId = options.client_id;
        return { requestAccessToken: () => {} };
      } } } }),
    );
    await authorizer.prepare();
    const pending = authorizer.authorize();
    const rejected = expect(pending).rejects.toBeInstanceOf(GoogleDriveAuthorizationRequiredError);
    // A padded value would reach Google's token client verbatim and fail there
    // with an opaque error instead of being normalized at the accepting edge.
    expect(sentClientId).toBe(configured);
    authorizer.reset();
    await rejected;
  });

  it("agrees with the authorizer about which client IDs are constructible", () => {
    for (const value of [
      undefined,
      null,
      "",
      "   ",
      "not-a-client-id",
      "short.apps.googleusercontent.com",
      "123456789012-airship.apps.googleusercontent.com.evil.test",
      `${"a".repeat(600)}.apps.googleusercontent.com`,
    ]) {
      expect(isDeployableGoogleOAuthClientId(value)).toBe(false);
    }
    // What this pins is agreement between the two edges: a value the predicate
    // rejects is a value the authorizer refuses to construct with, and vice
    // versa, so a caller that does consult the predicate is never surprised at
    // construction. It is *not* a guarantee that a build cannot ship Drive as an
    // unreachable default — nothing forces provider selection through this
    // predicate, and a deployment that skips it fails at the authorizer instead.
    for (const value of ["not-a-client-id", "short.apps.googleusercontent.com", "   "]) {
      expect(isDeployableGoogleOAuthClientId(value)).toBe(false);
      expect(() => new GoogleIdentityServicesAuthorizer(value, new MemoryOnlyGoogleAccessTokenProvider()))
        .toThrow("Google OAuth client ID is invalid.");
    }
  });
});

describe("browser-only Google account authorization", () => {
  it("keeps a narrow, expiring grant in memory and reads bounded account context", async () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    provider.replace({ accessToken: "temporary-google-token", expiresInSeconds: 3_600, grantedScopes: GOOGLE_ACCOUNT_SCOPES });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      sub: "google-subject-123",
      email: "pilot@example.test",
      email_verified: true,
      name: "Test Pilot",
      picture: "https://example.test/avatar.png",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(readGoogleAccountIdentity(provider, undefined, fetcher)).resolves.toEqual({
      subject: "google-subject-123",
      email: "pilot@example.test",
      emailVerified: true,
      displayName: "Test Pilot",
      pictureUrl: "https://example.test/avatar.png",
    });
    expect(fetcher).toHaveBeenCalledWith("https://openidconnect.googleapis.com/v1/userinfo", expect.objectContaining({
      headers: { Authorization: "Bearer temporary-google-token" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    }));
    provider.reset();
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(GoogleDriveAuthorizationRequiredError);
  });

  it("requests identity and drive.file together from the GIS token client", async () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    let callback: ((response: Record<string, unknown>) => void) | undefined;
    let requested: { prompt?: string } | undefined;
    let configuredScope = "";
    const authorizer = new GoogleIdentityServicesAuthorizer(
      "123456789012-airship.apps.googleusercontent.com",
      provider,
      async () => ({ accounts: { oauth2: { initTokenClient: (options) => {
        configuredScope = options.scope;
        callback = options.callback as (response: Record<string, unknown>) => void;
        return { requestAccessToken: (options) => { requested = options; } };
      } } } }),
    );
    await authorizer.prepare();
    const pending = authorizer.authorize({ selectAccount: true });
    await vi.waitFor(() => expect(requested).toEqual({ prompt: "select_account" }));
    callback?.({
      access_token: "temporary-google-token",
      expires_in: 3_600,
      scope: GOOGLE_ACCOUNT_SCOPES.join(" "),
    });
    await expect(pending).resolves.toMatchObject({ grantedScopes: expect.arrayContaining([GOOGLE_DRIVE_FILE_SCOPE, "openid", "email", "profile"]) });
    expect(configuredScope.split(" ")).toEqual(GOOGLE_ACCOUNT_SCOPES);
  });

  it("ignores a prior client callback after reset so it cannot satisfy a later account request", async () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    const callbacks: Array<(response: Record<string, unknown>) => void> = [];
    const requests: number[] = [];
    const authorizer = new GoogleIdentityServicesAuthorizer(
      "123456789012-airship.apps.googleusercontent.com",
      provider,
      async () => ({ accounts: { oauth2: { initTokenClient: (options) => {
        const clientGeneration = callbacks.length;
        callbacks.push(options.callback as (response: Record<string, unknown>) => void);
        return { requestAccessToken: () => { requests.push(clientGeneration); } };
      } } } }),
    );

    await authorizer.prepare();
    const stale = authorizer.authorize();
    const staleRejected = expect(stale).rejects.toMatchObject({
      name: "GoogleDriveAuthorizationRequiredError",
      message: "Google authorization was cleared.",
    });
    authorizer.reset();
    await staleRejected;

    await authorizer.prepare();
    const current = authorizer.authorize();
    let currentSettled = false;
    void current.finally(() => { currentSettled = true; });
    callbacks[0]?.({
      access_token: "stale-account-token",
      expires_in: 3_600,
      scope: GOOGLE_ACCOUNT_SCOPES.join(" "),
    });
    await Promise.resolve();
    expect(currentSettled).toBe(false);
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(GoogleDriveAuthorizationRequiredError);

    callbacks[1]?.({
      access_token: "current-account-token",
      expires_in: 3_600,
      scope: GOOGLE_ACCOUNT_SCOPES.join(" "),
    });
    await expect(current).resolves.toMatchObject({ accessToken: "current-account-token" });
    await expect(provider.getAccessToken()).resolves.toMatchObject({ accessToken: "current-account-token" });
    expect(requests).toEqual([0, 1]);
  });

  it("does not let prepare completion from before reset reactivate authorization", async () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    let releaseLoader!: () => void;
    let clients = 0;
    const loader = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseLoader = resolve; });
      return { accounts: { oauth2: { initTokenClient: () => {
        clients += 1;
        return { requestAccessToken: () => {} };
      } } } };
    });
    const authorizer = new GoogleIdentityServicesAuthorizer(
      "123456789012-airship.apps.googleusercontent.com",
      provider,
      loader,
    );

    const stalePrepare = authorizer.prepare();
    authorizer.reset();
    releaseLoader();
    await stalePrepare;
    expect(() => authorizer.authorize()).toThrow("Prepare Google Identity Services");
    expect(clients).toBe(0);

    await authorizer.prepare();
    const pending = authorizer.authorize();
    const rejected = expect(pending).rejects.toBeInstanceOf(GoogleDriveAuthorizationRequiredError);
    expect(clients).toBe(1);
    authorizer.reset();
    await rejected;
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("replaces an expired grant in place without persisting or rebuilding the GIS authority", async () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    const callbacks: Array<(response: Record<string, unknown>) => void> = [];
    const prompts: string[] = [];
    let clients = 0;
    const authorizer = new GoogleIdentityServicesAuthorizer(
      "123456789012-airship.apps.googleusercontent.com",
      provider,
      async () => ({ accounts: { oauth2: { initTokenClient: (options) => {
        clients += 1;
        callbacks.push(options.callback as (response: Record<string, unknown>) => void);
        return { requestAccessToken: (request) => { prompts.push(request?.prompt ?? ""); } };
      } } } }),
    );
    await authorizer.prepare();
    provider.replace({
      accessToken: "expired-google-token",
      expiresInSeconds: 3_600,
      grantedScopes: GOOGLE_ACCOUNT_SCOPES,
    }, Date.now() - 3_600_000);
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(GoogleDriveAuthorizationRequiredError);

    const pending = authorizer.reauthorize();
    expect(prompts).toEqual([""]);
    callbacks[0]?.({
      access_token: "replacement-google-token",
      expires_in: 3_600,
      scope: GOOGLE_ACCOUNT_SCOPES.join(" "),
    });

    await expect(pending).resolves.toMatchObject({ accessToken: "replacement-google-token" });
    await expect(provider.getAccessToken()).resolves.toMatchObject({ accessToken: "replacement-google-token" });
    expect(clients).toBe(1);
  });

  it("clears a synchronously blocked popup attempt so an explicit retry can succeed", async () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    let callback: ((response: Record<string, unknown>) => void) | undefined;
    let attempts = 0;
    const authorizer = new GoogleIdentityServicesAuthorizer(
      "123456789012-airship.apps.googleusercontent.com",
      provider,
      async () => ({ accounts: { oauth2: { initTokenClient: (options) => {
        callback = options.callback as (response: Record<string, unknown>) => void;
        return { requestAccessToken: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("popup blocked");
        } };
      } } } }),
    );
    await authorizer.prepare();
    await expect(authorizer.authorize()).rejects.toMatchObject({
      name: "GoogleDriveAuthorizationRequiredError",
      message: "popup blocked",
    });

    const retry = authorizer.authorize();
    callback?.({
      access_token: "replacement-google-token",
      expires_in: 3_600,
      scope: GOOGLE_ACCOUNT_SCOPES.join(" "),
    });
    await expect(retry).resolves.toMatchObject({ accessToken: "replacement-google-token" });
    expect(attempts).toBe(2);
  });

  it("ignores a timed-out client callback so only the fresh retry can win", async () => {
    vi.useFakeTimers();
    try {
      const provider = new MemoryOnlyGoogleAccessTokenProvider();
      const callbacks: Array<(response: Record<string, unknown>) => void> = [];
      const requests: number[] = [];
      const authorizer = new GoogleIdentityServicesAuthorizer(
        "123456789012-airship.apps.googleusercontent.com",
        provider,
        async () => ({ accounts: { oauth2: { initTokenClient: (options) => {
          const clientGeneration = callbacks.length;
          callbacks.push(options.callback as (response: Record<string, unknown>) => void);
          return { requestAccessToken: () => { requests.push(clientGeneration); } };
        } } } }),
      );
      await authorizer.prepare();
      const stalled = authorizer.authorize();
      const rejected = expect(stalled).rejects.toMatchObject({
        name: "GoogleDriveAuthorizationRequiredError",
        message: expect.stringContaining("did not finish"),
      });
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await rejected;

      const retry = authorizer.authorize();
      let retrySettled = false;
      void retry.finally(() => { retrySettled = true; });
      callbacks[0]?.({
        access_token: "stale-timeout-token",
        expires_in: 3_600,
        scope: GOOGLE_ACCOUNT_SCOPES.join(" "),
      });
      await Promise.resolve();
      expect(retrySettled).toBe(false);
      await expect(provider.getAccessToken()).rejects.toBeInstanceOf(GoogleDriveAuthorizationRequiredError);

      callbacks[1]?.({
        access_token: "current-retry-token",
        expires_in: 3_600,
        scope: GOOGLE_ACCOUNT_SCOPES.join(" "),
      });
      await expect(retry).resolves.toMatchObject({ accessToken: "current-retry-token" });
      await expect(provider.getAccessToken()).resolves.toMatchObject({ accessToken: "current-retry-token" });
      expect(requests).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when Drive consent is missing", () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    expect(() => provider.replace({ accessToken: "temporary-google-token", expiresInSeconds: 3_600, grantedScopes: ["openid", "email", "profile"] }))
      .toThrow("Drive file scope");
  });

  it("rejects an oversized chunked account response before parsing it", async () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    provider.replace({ accessToken: "temporary-google-token", expiresInSeconds: 3_600, grantedScopes: GOOGLE_ACCOUNT_SCOPES });
    const response = JSON.stringify({
      sub: "google-subject-123",
      email: "pilot@example.test",
      ignoredPadding: "x".repeat(70 * 1024),
    });

    await expect(readGoogleAccountIdentity(
      provider,
      undefined,
      async () => new Response(response, { headers: { "content-type": "application/json" } }),
    )).rejects.toThrow("invalid JSON");
  });
});
