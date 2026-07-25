import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_ACCOUNT_SCOPES,
  GOOGLE_DRIVE_FILE_SCOPE,
  GoogleDriveAuthorizationRequiredError,
  GoogleIdentityServicesAuthorizer,
  MemoryOnlyGoogleAccessTokenProvider,
  readGoogleAccountIdentity,
} from "./google-drive-auth";

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

  it("releases a chooser that never calls back instead of wedging later authorization", async () => {
    vi.useFakeTimers();
    try {
      const provider = new MemoryOnlyGoogleAccessTokenProvider();
      let requests = 0;
      const authorizer = new GoogleIdentityServicesAuthorizer(
        "123456789012-airship.apps.googleusercontent.com",
        provider,
        async () => ({ accounts: { oauth2: { initTokenClient: () => ({
          requestAccessToken: () => { requests += 1; },
        }) } } }),
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
      expect(requests).toBe(2);
      authorizer.reset();
      await expect(retry).rejects.toMatchObject({ name: "GoogleDriveAuthorizationRequiredError" });
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
