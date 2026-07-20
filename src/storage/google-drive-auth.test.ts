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

  it("fails closed when Drive consent is missing", () => {
    const provider = new MemoryOnlyGoogleAccessTokenProvider();
    expect(() => provider.replace({ accessToken: "temporary-google-token", expiresInSeconds: 3_600, grantedScopes: ["openid", "email", "profile"] }))
      .toThrow("Drive file scope");
  });
});
