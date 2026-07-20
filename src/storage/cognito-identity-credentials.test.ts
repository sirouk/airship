import { describe, expect, it, vi } from "vitest";
import {
  CognitoIdentityCredentialProvider,
  CognitoIdentityError,
} from "./cognito-identity-credentials";

const region = "us-east-1";
const pool = "us-east-1:11111111-2222-3333-4444-555555555555";
const identityId = "us-east-1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const startedAt = Date.parse("2026-07-18T00:00:00.000Z");

describe("CognitoIdentityCredentialProvider", () => {
  it("coalesces the enhanced browser flow and caches only temporary credentials in memory", async () => {
    const requests: Array<{ target: string; body: Record<string, unknown>; init: RequestInit }> = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const target = headers.get("x-amz-target")!;
      requests.push({ target, body: JSON.parse(String(init?.body)) as Record<string, unknown>, init: init! });
      return jsonResponse(
        target.endsWith(".GetId")
          ? { IdentityId: identityId }
          : {
              IdentityId: identityId,
              Credentials: {
                AccessKeyId: "temporary-access",
                SecretKey: "temporary-secret",
                SessionToken: "temporary-token",
                Expiration: (startedAt + 60 * 60_000) / 1_000,
              },
            },
      );
    });
    const getIdToken = vi.fn(async () => "header.payload.signature");
    const provider = makeProvider(fetchImplementation, getIdToken, () => new Date(startedAt));

    const [left, right] = await Promise.all([provider.getCredentials(), provider.getCredentials()]);
    const cached = await provider.getCredentials();

    expect(left).toEqual(right);
    expect(cached).toMatchObject({
      accessKeyId: "temporary-access",
      secretAccessKey: "temporary-secret",
      sessionToken: "temporary-token",
      expiration: "2026-07-18T01:00:00.000Z",
    });
    expect(provider.identityId).toBe(identityId);
    expect(getIdToken).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => request.target)).toEqual([
      "AWSCognitoIdentityService.GetId",
      "AWSCognitoIdentityService.GetCredentialsForIdentity",
    ]);
    expect(requests[0]!.body).toEqual({
      IdentityPoolId: pool,
      Logins: { "issuer.example/oidc": "header.payload.signature" },
    });
    expect(requests[1]!.body).toEqual({
      IdentityId: identityId,
      Logins: { "issuer.example/oidc": "header.payload.signature" },
    });
    expect(requests[0]!.init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBeNull();
  });

  it("reuses the identity ID across refreshes and resets it on account change", async () => {
    let now = startedAt;
    let credentialGeneration = 0;
    const targets: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const target = new Headers(init?.headers).get("x-amz-target")!;
      targets.push(target);
      if (target.endsWith(".GetId")) return jsonResponse({ IdentityId: identityId });
      credentialGeneration += 1;
      return jsonResponse({
        Credentials: {
          AccessKeyId: `access-${credentialGeneration}`,
          SecretKey: `secret-${credentialGeneration}`,
          SessionToken: `token-${credentialGeneration}`,
          Expiration: new Date(now + 60 * 60_000).toISOString(),
        },
      });
    });
    const provider = makeProvider(fetchImplementation, async () => "fresh.id.token", () => new Date(now));

    await provider.getCredentials();
    now += 56 * 60_000;
    await expect(provider.getCredentials()).resolves.toMatchObject({ accessKeyId: "access-2" });
    expect(targets.filter((target) => target.endsWith(".GetId"))).toHaveLength(1);

    provider.reset();
    await provider.getCredentials();
    expect(targets.filter((target) => target.endsWith(".GetId"))).toHaveLength(2);
  });

  it("retries throttling encoded as HTTP 400 and reports typed terminal errors", async () => {
    let calls = 0;
    const retrying = makeProvider(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          { __type: "com.amazonaws.cognito#TooManyRequestsException" },
          400,
          { "Retry-After": "0" },
        );
      }
      if (calls === 2) return jsonResponse({ IdentityId: identityId });
      return jsonResponse({
        Credentials: {
          AccessKeyId: "access",
          SecretKey: "secret",
          SessionToken: "token",
          Expiration: (startedAt + 60 * 60_000) / 1_000,
        },
      });
    }, async () => "id.token", () => new Date(startedAt));

    await expect(retrying.getCredentials()).resolves.toMatchObject({ accessKeyId: "access" });
    expect(calls).toBe(3);

    const denied = makeProvider(
      async () => jsonResponse({ __type: "NotAuthorizedException" }, 400, { "x-amzn-requestid": "request-1" }),
      async () => "id.token",
      () => new Date(startedAt),
    );
    const error = await denied.getCredentials().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CognitoIdentityError);
    expect(error).toMatchObject({ code: "NotAuthorizedException", retryable: false, requestId: "request-1" });
  });

  it("rejects cross-region identity material and permanent/guest-style configuration", async () => {
    const crossRegion = makeProvider(
      async () => jsonResponse({ IdentityId: "eu-west-1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
      async () => "id.token",
      () => new Date(startedAt),
    );
    await expect(crossRegion.getCredentials()).rejects.toThrow("unexpected region");

    expect(() => new CognitoIdentityCredentialProvider({
      region,
      identityPoolId: pool,
      loginProvider: "",
      getIdToken: async () => "id.token",
    })).toThrow("login provider");
  });

  it("invalidates an in-flight refresh on logout instead of restoring the prior account", async () => {
    let releaseToken!: (value: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    const fetchImplementation = vi.fn<typeof fetch>(async () => jsonResponse({ IdentityId: identityId }));
    const provider = makeProvider(fetchImplementation, async () => token, () => new Date(startedAt));

    const pending = provider.getCredentials();
    provider.reset();
    releaseToken("old.account.token");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.identityId).toBeUndefined();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

function makeProvider(
  fetchImplementation: typeof fetch,
  getIdToken: () => Promise<string>,
  now: () => Date,
): CognitoIdentityCredentialProvider {
  return new CognitoIdentityCredentialProvider({
    region,
    identityPoolId: pool,
    loginProvider: "issuer.example/oidc",
    getIdToken,
    fetchImplementation,
    now,
  });
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/x-amz-json-1.1", ...headers },
  });
}
